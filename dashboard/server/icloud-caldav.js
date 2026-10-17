import { createHash } from 'node:crypto';
import { createDAVClient } from 'tsdav';
import {
  CalendarSyncError, createCalendarWindow,
} from './calendar-normalize.js';
import { normalizeCalendarObjectsBounded } from './calendar-normalize-bounded.js';

export { CalendarSyncError } from './calendar-normalize.js';

const ICLOUD_URL = 'https://caldav.icloud.com/';
const ALLOWED_METHODS = new Set(['PROPFIND', 'REPORT', 'GET']);
const REDIRECT_CODES = new Set([301, 302, 307, 308]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_REQUESTS = 80;
const SYNC_TIMEOUT_MS = 25_000;

function providerError(code = 'CALENDAR_PROVIDER_ERROR') {
  const messages = {
    CALENDAR_AUTH_FAILED: 'iCloud did not accept this connection. Check its app-specific password.',
    CALENDAR_TIMEOUT: 'iCloud took too long to respond. Try syncing again.',
    CALENDAR_PROVIDER_ERROR: 'iCloud could not be read completely. Try syncing again.',
    CALENDAR_UNSAFE_URL: 'iCloud returned an unsupported calendar address.',
    CALENDAR_REQUEST_LIMIT: 'This iCloud account is too large to read in one sync.',
    CALENDAR_RESPONSE_LIMIT: 'An iCloud calendar response is too large to read safely.',
    CALENDAR_READ_ONLY: 'Calendar connections support reading only.',
  };
  return new CalendarSyncError(code, messages[code] ?? messages.CALENDAR_PROVIDER_ERROR);
}

/** Strict Apple CalDAV shard allowlist, not a substring or general *.icloud.com match. */
export function validateIcloudUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw providerError('CALENDAR_UNSAFE_URL'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash
      || !(host === 'caldav.icloud.com' || /^p[0-9]{1,3}-caldav\.icloud\.com$/.test(host))) {
    throw providerError('CALENDAR_UNSAFE_URL');
  }
  return url;
}

function validateCredentials(username, appPassword) {
  if (typeof username !== 'string' || !username.trim() || username.length > 254 || /[:\r\n]/.test(username)
      || typeof appPassword !== 'string' || !appPassword || appPassword.length > 256 || /[\r\n]/.test(appPassword)) {
    throw new CalendarSyncError('INVALID_CALENDAR_CREDENTIALS', 'Enter an Apple Account and its app-specific password.');
  }
}

/**
 * Every network operation, including library discovery, passes through this gate.
 * Auth is attached only AFTER URL/method validation. Native redirects are disabled.
 * The caller provides a short-lived credential pair; nothing is persisted here.
 */
export function createIcloudReadFetch({ username, appPassword, fetchImpl = globalThis.fetch } = {}) {
  validateCredentials(username, appPassword);
  if (typeof fetchImpl !== 'function') throw providerError();
  const authorization = `Basic ${Buffer.from(`${username.trim()}:${appPassword}`, 'utf8').toString('base64')}`;
  const deadline = AbortSignal.timeout(SYNC_TIMEOUT_MS);
  let requests = 0;
  let totalBytes = 0;

  return async (input, init = {}) => {
    let url = validateIcloudUrl(input instanceof Request ? input.url : String(input));
    const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!ALLOWED_METHODS.has(method)) throw providerError('CALENDAR_READ_ONLY');
    if (init.body != null && typeof init.body !== 'string') throw providerError();
    const headers = new Headers();
    const incoming = new Headers(init.headers);
    for (const name of ['content-type', 'depth', 'accept']) {
      if (incoming.has(name)) headers.set(name, incoming.get(name));
    }
    headers.set('authorization', authorization);
    const signal = init.signal ? AbortSignal.any([deadline, init.signal]) : deadline;

    try {
      for (let redirects = 0; ; redirects++) {
        if (++requests > MAX_REQUESTS) throw providerError('CALENDAR_REQUEST_LIMIT');
        const response = await fetchImpl(url.href, {
          method, headers, body: method === 'GET' ? undefined : init.body,
          redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
        });
        if (response.status >= 300 && response.status < 400) {
          if (!REDIRECT_CODES.has(response.status)) throw providerError('CALENDAR_UNSAFE_URL');
          const location = response.headers.get('location');
          if (!location || redirects >= 3) throw providerError('CALENDAR_UNSAFE_URL');
          const next = validateIcloudUrl(location, url);
          // tsdav's .well-known discovery needs the redirect Location itself.
          // Validate it now and again before the subsequent request gets auth.
          if (init.redirect === 'manual') {
            await response.body?.cancel();
            return new Response(null, { status: response.status, headers: { location: next.href } });
          }
          await response.body?.cancel();
          url = next;
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw providerError('CALENDAR_AUTH_FAILED');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw providerError();
        }
        const announced = Number(response.headers.get('content-length'));
        if (announced > MAX_RESPONSE_BYTES) {
          await response.body?.cancel();
          throw providerError('CALENDAR_RESPONSE_LIMIT');
        }
        const parts = [];
        let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              totalBytes += value.byteLength;
              if (size > MAX_RESPONSE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
                await reader.cancel();
                throw providerError('CALENDAR_RESPONSE_LIMIT');
              }
              parts.push(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        const bytes = Buffer.concat(parts);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw providerError();
        const safe = new Response(text, {
          status: response.status, statusText: response.statusText, headers: response.headers,
        });
        Object.defineProperty(safe, 'url', { value: url.href });
        return safe;
      }
    } catch (error) {
      if (error instanceof CalendarSyncError) throw error;
      if (signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw providerError('CALENDAR_TIMEOUT');
      throw providerError();
    }
  };
}

function canonicalCalendarUrl(value) {
  const url = validateIcloudUrl(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

function calendarId(url) {
  return createHash('sha256').update(url).digest('hex');
}

function calendarLabel(value, fallback) {
  return String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || fallback;
}

async function openIcloud(options) {
  const transport = createIcloudReadFetch(options);
  // Custom authentication keeps tsdav's Basic/Digest fallback and credential
  // debug handling out of this read-only transport. The gate adds Basic auth.
  const client = await createDAVClient({
    serverUrl: ICLOUD_URL, credentials: {}, authMethod: 'Custom',
    authFunction: async () => ({}), defaultAccountType: 'caldav', fetch: transport,
  });
  const discovered = await client.fetchCalendars();
  if (!Array.isArray(discovered) || discovered.length > 50) throw providerError('CALENDAR_REQUEST_LIMIT');
  const calendars = discovered
    .filter((calendar) => !calendar.components?.length || calendar.components.includes('VEVENT'))
    .map((calendar) => {
      const url = canonicalCalendarUrl(calendar.url);
      const rawColor = String(calendar.calendarColor ?? '');
      return {
        calendar: { ...calendar, url },
        public: {
          id: calendarId(url), name: calendarLabel(calendar.displayName, 'Calendar'),
          color: /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(rawColor) ? rawColor.slice(0, 7) : '#6EA8FE',
        },
      };
    });
  return { client, calendars };
}

export async function listIcloudCalendars(options) {
  try {
    const { calendars } = await openIcloud(options);
    return calendars.map((entry) => entry.public);
  } catch (error) {
    if (error instanceof CalendarSyncError) throw error;
    throw providerError();
  }
}

/**
 * Read-only private iCloud sync. Credentials are request-local; the API layer
 * owns AES-GCM storage, authentication, household scoping, and cache commits.
 *
 * options: { username, appPassword, calendarIds, timeZone,
 *            startDate, endDateExclusive, days?: 30|60, now?, fetchImpl? }
 * Explicit dates are local YYYY-MM-DD, end-exclusive, at most 60 calendar days.
 * Result: { events, coverage, lastSuccessfulSyncAt }. Events discriminate date-
 * only all-day ranges from UTC startAt/endAt plus their source timeZone.
 *
 * ANY failure, including >400 events, throws a sanitized CalendarSyncError with
 * incomplete coverage. Callers must retain the last good snapshot/timestamp and
 * mark it stale; a partial result must never be committed as a ready calendar.
 */
export async function syncIcloudCalendar(options = {}) {
  const coverage = createCalendarWindow(options);
  try {
    const { calendarIds } = options;
    if (!Array.isArray(calendarIds) || !calendarIds.length || calendarIds.length > 10
        || calendarIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))) {
      throw new CalendarSyncError('INVALID_CALENDAR_SELECTION', 'Choose between one and ten iCloud calendars.');
    }
    const selected = [...new Set(calendarIds)];
    const { client, calendars } = await openIcloud(options);
    const byId = new Map(calendars.map((entry) => [entry.public.id, entry]));
    if (selected.some((id) => !byId.has(id))) {
      throw new CalendarSyncError('CALENDAR_NOT_FOUND', 'A selected iCloud calendar is no longer available. Choose calendars again.');
    }
    const objects = [];
    for (const id of selected) {
      const { calendar } = byId.get(id);
      const collection = new URL(calendar.url);
      const fetched = await client.fetchCalendarObjects({
        calendar, expand: false,
        // DATE/floating resources can be interpreted in the collection's zone;
        // a one-day margin prevents a UTC boundary from excluding those records.
        // Normalization still enforces the exact requested <=60-day coverage.
        timeRange: {
          start: new Date(Date.parse(coverage.start) - 86_400_000).toISOString(),
          end: new Date(Date.parse(coverage.end) + 86_400_000).toISOString(),
        },
        urlFilter: (value) => {
          const url = validateIcloudUrl(value, collection);
          if (url.href === collection.href) return false;
          if (url.origin !== collection.origin || !url.pathname.startsWith(collection.pathname)) throw providerError('CALENDAR_UNSAFE_URL');
          return true; // Include extensionless DAV resources, too.
        },
      });
      if (!Array.isArray(fetched) || objects.length + fetched.length > 1000) throw providerError('CALENDAR_RESPONSE_LIMIT');
      objects.push(...fetched.map((object) => ({
        calendarId: id, data: object.data, calendarTimeZone: calendar.timezone,
      })));
    }
    const normalized = await normalizeCalendarObjectsBounded(objects, { window: coverage });
    return {
      ...normalized,
      lastSuccessfulSyncAt: new Date(options.now ?? Date.now()).toISOString(),
    };
  } catch (error) {
    const safe = error instanceof CalendarSyncError ? error : providerError();
    if (!safe.coverage) safe.coverage = { ...coverage, complete: false };
    throw safe;
  }
}
