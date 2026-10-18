import { CalendarSyncError, listIcloudCalendars, syncIcloudCalendar } from './icloud-caldav.js';
import { createCalendarWindow } from './calendar-normalize.js';
import { CALENDAR_FRESH_MS, calendarSyncState, enqueueCalendarSync, findCalendarCache, runCalendarSyncJob, selectedCalendarMetadata, sharedCalendarWindow } from './calendar-sync.js';
export { processCalendarSyncJobs } from './calendar-sync.js';
import { ApiError, calendarWindow, requireValue, textField } from './errors.js';
import { encryptCredentials } from './credentials.js';
import { one, transaction } from './database.js';
import { requireAdmin, requireHousehold } from './auth.js';

const calendarDto = connection => ({ connected: Boolean(connection),
  calendars: (connection?.calendars || []).map(calendar => ({ ...calendar, selected: connection.selected_ids.includes(calendar.id) })),
  lastSuccessfulSyncAt: connection?.last_successful_sync_at || null });

export async function calendarConnection(db, principal) {
  requireAdmin(principal);
  const row = await one(db, `SELECT c.calendars,c.selected_ids,max(k.successful_at) AS last_successful_sync_at
    FROM family_calendar_connections c LEFT JOIN family_calendar_cache k ON k.household_id=c.household_id
    WHERE c.household_id=$1 GROUP BY c.household_id`, [principal.household.id]);
  return calendarDto(row);
}

export async function connectCalendar(db, principal, body, env = process.env, list = listIcloudCalendars) {
  requireAdmin(principal);
  const credentials = { username: textField(body.username, 'Apple account email', 254), appPassword: textField(body.appPassword, 'App-specific password', 200) };
  let calendars;
  try { calendars = await list(credentials); }
  catch (error) {
    if (error instanceof CalendarSyncError) throw new ApiError(502, 'calendar_connection_failed', 'Could not connect to iCloud. Check the Apple account and app-specific password.');
    throw error;
  }
  const safeCalendars = calendars.map(({ id, name, color }) => ({ id, name, color }));
  const encrypted = encryptCredentials(principal.household.id, credentials, env);
  return transaction(db, async client => {
    await client.query(`INSERT INTO family_calendar_connections(household_id,credentials,calendars) VALUES($1,$2::jsonb,$3::jsonb)
      ON CONFLICT(household_id) DO UPDATE SET credentials=EXCLUDED.credentials,calendars=EXCLUDED.calendars,selected_ids='[]'::jsonb,version=family_calendar_connections.version+1,updated_at=now()`,
    [principal.household.id, JSON.stringify(encrypted), JSON.stringify(safeCalendars)]);
    await client.query('DELETE FROM family_calendar_cache WHERE household_id=$1', [principal.household.id]);
    await client.query('DELETE FROM family_calendar_sync_jobs WHERE household_id=$1', [principal.household.id]);
    return calendarDto({ calendars: safeCalendars, selected_ids: [] });
  });
}

export async function selectCalendars(db, principal, body) {
  requireAdmin(principal);
  requireValue(Array.isArray(body.calendarIds) && body.calendarIds.length <= 10 && body.calendarIds.every(id => typeof id === 'string'), 422, 'invalid_calendars', 'Choose up to 10 calendars from the discovered list.');
  return transaction(db, async client => {
    const row = await one(client, 'SELECT * FROM family_calendar_connections WHERE household_id=$1 FOR UPDATE', [principal.household.id]);
    requireValue(row, 409, 'calendar_not_connected', 'Connect your calendar first.');
    const ids = [...new Set(body.calendarIds)];
    requireValue(ids.every(id => row.calendars.some(calendar => calendar.id === id)), 422, 'invalid_calendars', 'Choose calendars from the discovered list.');
    await client.query('UPDATE family_calendar_connections SET selected_ids=$2::jsonb,version=version+1,updated_at=now() WHERE household_id=$1', [principal.household.id, JSON.stringify(ids)]);
    await client.query('DELETE FROM family_calendar_cache WHERE household_id=$1', [principal.household.id]);
    await client.query('DELETE FROM family_calendar_sync_jobs WHERE household_id=$1', [principal.household.id]);
    return calendarDto({ ...row, selected_ids: ids });
  });
}

export async function removeCalendar(db, principal) {
  requireAdmin(principal);
  return transaction(db, async client => {
    await client.query('SELECT household_id FROM family_calendar_connections WHERE household_id=$1 FOR UPDATE', [principal.household.id]);
    await client.query('DELETE FROM family_calendar_cache WHERE household_id=$1', [principal.household.id]);
    await client.query('DELETE FROM family_calendar_sync_jobs WHERE household_id=$1', [principal.household.id]);
    await client.query('DELETE FROM family_calendar_connections WHERE household_id=$1', [principal.household.id]);
    return { deleted: true };
  });
}

export async function calendarSnapshot(db, principal, from, to, { env = process.env, force = false, sync = syncIcloudCalendar, now = new Date() } = {}) {
  const householdId = requireHousehold(principal);
  const window = calendarWindow(from, to);
  const connection = await one(db, 'SELECT * FROM family_calendar_connections WHERE household_id=$1', [householdId]);
  const empty = { status: 'not_configured', events: [], calendars: [], coverage: null, lastSuccessfulSyncAt: null, error: null, sync: null };
  if (!connection || !connection.selected_ids.length) return empty;
  const timezone = principal.household.timezone;
  const calendars = selectedCalendarMetadata(connection);
  const cached = await findCalendarCache(db, householdId, from, to, timezone, connection.version);
  if (!force && cached && now - new Date(cached.successful_at) < CALENDAR_FRESH_MS) return { ...cached.snapshot, calendars, status: 'ready', error: null, sync: null };
  // A stale view returns immediately after a durable enqueue. The scheduler owns
  // the provider call; no fire-and-forget promise can be lost on Vercel freeze.
  const shared = cached ? { from: cached.from_date, to: cached.to_date }
    : sharedCalendarWindow(from, to, timezone, now);
  // Test adapters and old cache records may omit SQL date fields. The caller's
  // validated bounds remain a safe fallback while the new writer records both.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shared.from)) shared.from = from;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shared.to)) shared.to = to;
  const job = await enqueueCalendarSync(db, householdId, connection, shared.from, shared.to, timezone, now, { force });
  if (!job) return { ...empty, status: 'loading' };
  const state = calendarSyncState(job, now);
  if (cached && !force) {
    const current = await one(db, 'SELECT version FROM family_calendar_connections WHERE household_id=$1 AND credentials=$2::jsonb', [householdId, JSON.stringify(connection.credentials)]);
    if (current?.version !== connection.version) return { ...empty, status: 'loading' };
    return { ...cached.snapshot, calendars, status: 'stale', error: state?.error || null, sync: state };
  }
  const result = await runCalendarSyncJob(db, job, { env, sync, now });
  if (result.outcome === 'synced') return { ...result.snapshot, sync: null };
  // Never revive a captured account snapshot after concurrent selection changes
  // or disconnect/reconnect, including a fresh connection with the same version.
  const current = await one(db, 'SELECT version FROM family_calendar_connections WHERE household_id=$1 AND credentials=$2::jsonb', [householdId, JSON.stringify(connection.credentials)]);
  if (current?.version !== connection.version || result.outcome === 'changed') return { ...empty, status: 'loading' };
  const currentJob = await one(db, `SELECT * FROM family_calendar_sync_jobs WHERE household_id=$1
    AND start_date=$2::date AND end_date=$3::date AND timezone=$4 AND connection_version=$5 AND credential_generation=$6`,
  [householdId, job.from_date, job.to_date, timezone, connection.version, job.credential_generation]);
  const currentState = calendarSyncState(currentJob, now) || state;
  const error = result.error || state?.error || null;
  if (cached) return { ...cached.snapshot, calendars, status: 'stale', error, sync: currentState };
  return { ...empty, calendars, status: result.outcome === 'failed' ? 'error' : 'loading',
    coverage: { ...createCalendarWindow({ ...window, timeZone: timezone }), complete: false }, error, sync: currentState };
}
