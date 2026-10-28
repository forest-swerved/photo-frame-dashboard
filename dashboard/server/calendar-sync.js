import { randomUUID } from 'node:crypto';
import { CalendarSyncError, syncIcloudCalendar } from './icloud-caldav.js';
import { createCalendarWindow } from './calendar-normalize.js';
import { decryptCredentials, digest } from './credentials.js';
import { one, transaction } from './database.js';
import { householdDate, requireValue } from './errors.js';

export const CALENDAR_FRESH_MS = 60_000;
const LEASE_MS = 60_000;
const KNOWN_ERRORS = new Set(['CALENDAR_AUTH_FAILED', 'CALENDAR_TIMEOUT', 'CALENDAR_PROVIDER_ERROR',
  'CALENDAR_UNSAFE_URL', 'CALENDAR_REQUEST_LIMIT', 'CALENDAR_RESPONSE_LIMIT', 'CALENDAR_EVENT_LIMIT',
  'CALENDAR_NOT_FOUND', 'INVALID_CALENDAR_DATA', 'INVALID_CALENDAR_SELECTION']);

// Stable across JSONB key ordering, but different after reconnect, including
// when a deleted/recreated connection happens to reuse its integer version.
export function calendarGeneration(credentials) {
  return digest(JSON.stringify(Object.keys(credentials || {}).sort().map(key => [key, credentials[key]])));
}

export function selectedCalendarMetadata(connection) {
  const selected = new Set(connection?.selected_ids || []);
  return (Array.isArray(connection?.calendars) ? connection.calendars : []).filter(item => selected.has(item?.id))
    .slice(0, 10).map(item => ({ id: String(item.id).slice(0, 128),
      name: String(item.name || 'Calendar').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'Calendar',
      color: /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(item.color || '') ? item.color.slice(0, 7) : '#00748c' }));
}

export function calendarRetryMs(attempts) {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.min(6, Math.max(0, attempts - 1)));
}

export function calendarSyncState(job, now = new Date()) {
  if (!job) return null;
  return { state: job.lease_until && new Date(job.lease_until) > now ? 'syncing' : job.last_error_code ? 'retrying' : job.next_attempt_at ? 'scheduled' : 'idle',
    lastAttemptAt: job.last_attempt_at || null, nextAttemptAt: job.next_attempt_at || null,
    error: job.last_error_code ? { code: job.last_error_code, message: 'Calendar sync will retry automatically. Check Setup if this continues.' } : null };
}

export function sharedCalendarWindow(from, to, timezone, now = new Date()) {
  const today = householdDate(timezone, now);
  const defaultEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  const start = from < today ? from : today;
  const end = to > defaultEnd ? to : defaultEnd;
  return Date.parse(end) - Date.parse(start) <= 60 * 86_400_000
    ? { from: start, to: end } : { from, to };
}

export async function findCalendarCache(db, householdId, from, to, timezone, version) {
  return one(db, `SELECT *,start_date::text AS from_date,end_date::text AS to_date FROM family_calendar_cache WHERE household_id=$1
    AND start_date<=$2::date AND end_date>=$3::date AND timezone=$4 AND connection_version=$5
    ORDER BY successful_at DESC,end_date-start_date ASC LIMIT 1`, [householdId, from, to, timezone, version]);
}

export async function enqueueCalendarSync(db, householdId, connection, from, to, timezone, now = new Date(), { force = false } = {}) {
  const generation = calendarGeneration(connection.credentials);
  // Reuse an existing covering job so the frame's week and iOS's fortnight do
  // not both call iCloud. The whole complete snapshot remains the cache unit.
  const covering = await one(db, `SELECT *,start_date::text AS from_date,end_date::text AS to_date FROM family_calendar_sync_jobs
    WHERE household_id=$1 AND start_date<=$2::date AND end_date>=$3::date AND timezone=$4
      AND connection_version=$5 AND credential_generation=$6 ORDER BY end_date-start_date ASC LIMIT 1`,
  [householdId, from, to, timezone, connection.version, generation]);
  const start = covering?.from_date || from;
  const end = covering?.to_date || to;
  // Measure cadence from the attempt start: timing from its later success can
  // otherwise make a minute scheduler skip every second healthy refresh.
  return one(db, `INSERT INTO family_calendar_sync_jobs(household_id,start_date,end_date,timezone,connection_version,credential_generation,requested_at,next_attempt_at)
    SELECT $1,$2::date,$3::date,$4,$5,$6,$7,$7 FROM family_calendar_connections
    WHERE household_id=$1 AND version=$5 AND credentials=$8::jsonb
    ON CONFLICT(household_id,start_date,end_date,timezone) DO UPDATE SET requested_at=EXCLUDED.requested_at,
      connection_version=EXCLUDED.connection_version,credential_generation=EXCLUDED.credential_generation,
      next_attempt_at=CASE
        WHEN family_calendar_sync_jobs.connection_version<>EXCLUDED.connection_version OR family_calendar_sync_jobs.credential_generation<>EXCLUDED.credential_generation THEN EXCLUDED.next_attempt_at
        WHEN family_calendar_sync_jobs.last_error_code IS NULL AND family_calendar_sync_jobs.lease_id IS NULL
          AND family_calendar_sync_jobs.last_attempt_at <= $7::timestamptz-($10::integer * interval '1 millisecond') THEN EXCLUDED.next_attempt_at
        WHEN $9 AND family_calendar_sync_jobs.lease_id IS NULL
          AND (family_calendar_sync_jobs.last_error_code IS NULL OR family_calendar_sync_jobs.last_attempt_at IS NULL OR family_calendar_sync_jobs.last_attempt_at < $7::timestamptz-interval '30 seconds') THEN EXCLUDED.next_attempt_at
        ELSE family_calendar_sync_jobs.next_attempt_at END,
      lease_id=CASE WHEN family_calendar_sync_jobs.credential_generation<>EXCLUDED.credential_generation OR family_calendar_sync_jobs.connection_version<>EXCLUDED.connection_version THEN NULL ELSE family_calendar_sync_jobs.lease_id END,
      lease_until=CASE WHEN family_calendar_sync_jobs.credential_generation<>EXCLUDED.credential_generation OR family_calendar_sync_jobs.connection_version<>EXCLUDED.connection_version THEN NULL ELSE family_calendar_sync_jobs.lease_until END,
      attempts=CASE WHEN family_calendar_sync_jobs.credential_generation<>EXCLUDED.credential_generation OR family_calendar_sync_jobs.connection_version<>EXCLUDED.connection_version THEN 0 ELSE family_calendar_sync_jobs.attempts END,
      last_error_code=CASE WHEN family_calendar_sync_jobs.credential_generation<>EXCLUDED.credential_generation OR family_calendar_sync_jobs.connection_version<>EXCLUDED.connection_version THEN NULL ELSE family_calendar_sync_jobs.last_error_code END
    RETURNING *,start_date::text AS from_date,end_date::text AS to_date`,
  [householdId, start, end, timezone, connection.version, generation, now, JSON.stringify(connection.credentials), force, CALENDAR_FRESH_MS]);
}

export async function runCalendarSyncJob(db, job, { env = process.env, sync = syncIcloudCalendar, now = new Date() } = {}) {
  if (!job) return { outcome: 'changed' };
  const leaseId = randomUUID();
  const lease = await transaction(db, async client => {
    // Different requested date ranges still share one provider account. Hold a
    // household connection lock only while claiming its single active lease.
    const exists = await one(client, 'SELECT household_id FROM family_calendar_connections WHERE household_id=$1 FOR UPDATE', [job.household_id]);
    if (!exists) return null;
    return one(client, `UPDATE family_calendar_sync_jobs SET lease_id=$7,lease_until=$8,last_attempt_at=$9,attempts=least(attempts+1,1000000)
      WHERE household_id=$1 AND start_date=$2::date AND end_date=$3::date AND timezone=$4
        AND connection_version=$5 AND credential_generation=$6 AND next_attempt_at<=$9
        AND (lease_id IS NULL OR lease_until<=$9)
        AND NOT EXISTS(SELECT 1 FROM family_calendar_sync_jobs active WHERE active.household_id=$1 AND active.lease_until>$9)
      RETURNING *,start_date::text AS from_date,end_date::text AS to_date`,
    [job.household_id, job.from_date, job.to_date, job.timezone, job.connection_version, job.credential_generation, leaseId, new Date(now.getTime() + LEASE_MS), now]);
  });
  if (!lease) return { outcome: 'busy' };
  const key = [lease.household_id, lease.from_date, lease.to_date, lease.timezone, leaseId];
  const connection = await one(db, 'SELECT * FROM family_calendar_connections WHERE household_id=$1', [lease.household_id]);
  if (!connection || connection.version !== lease.connection_version || calendarGeneration(connection.credentials) !== lease.credential_generation) {
    await db.query('DELETE FROM family_calendar_sync_jobs WHERE household_id=$1 AND start_date=$2::date AND end_date=$3::date AND timezone=$4 AND lease_id=$5', key);
    return { outcome: 'changed' };
  }
  try {
    const credentials = decryptCredentials(lease.household_id, connection.credentials, env);
    // The adapter has a global 25-second network deadline and bounded parsing.
    // No database transaction/connection is held during provider I/O.
    const snapshot = await sync({ ...credentials, calendarIds: connection.selected_ids, timeZone: lease.timezone,
      startDate: lease.from_date, endDateExclusive: lease.to_date });
    requireValue(snapshot.coverage?.complete === true && !snapshot.coverage.truncated && Array.isArray(snapshot.events)
      && snapshot.events.length <= 400 && Number.isFinite(Date.parse(snapshot.lastSuccessfulSyncAt)), 502, 'calendar_incomplete', 'Calendar results were incomplete.');
    const result = { status: 'ready', events: snapshot.events, calendars: selectedCalendarMetadata(connection),
      // Use the requested, validated bounds rather than trusting the provider's
      // coverage strings. Completeness and event limits above still fail closed.
      coverage: createCalendarWindow({ startDate: lease.from_date, endDateExclusive: lease.to_date, timeZone: lease.timezone }),
      lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt, error: null };
    const committed = await transaction(db, async client => {
      const current = await one(client, 'SELECT version FROM family_calendar_connections WHERE household_id=$1 AND credentials=$2::jsonb FOR SHARE', [lease.household_id, JSON.stringify(connection.credentials)]);
      if (current?.version !== connection.version) return false;
      const owned = await one(client, `UPDATE family_calendar_sync_jobs SET lease_id=NULL,lease_until=NULL,attempts=0,last_error_code=NULL,last_successful_at=$6,next_attempt_at=NULL
        WHERE household_id=$1 AND start_date=$2::date AND end_date=$3::date AND timezone=$4 AND lease_id=$5 AND lease_until>clock_timestamp() RETURNING household_id`,
      [...key, snapshot.lastSuccessfulSyncAt]);
      if (!owned) return false;
      await client.query(`INSERT INTO family_calendar_cache(household_id,start_date,end_date,timezone,snapshot,successful_at,connection_version)
        VALUES($1,$2::date,$3::date,$4,$5::jsonb,$6,$7) ON CONFLICT(household_id,start_date,end_date,timezone)
        DO UPDATE SET snapshot=EXCLUDED.snapshot,successful_at=EXCLUDED.successful_at,connection_version=EXCLUDED.connection_version`,
      [lease.household_id, lease.from_date, lease.to_date, lease.timezone, JSON.stringify(result), snapshot.lastSuccessfulSyncAt, connection.version]);
      return true;
    });
    return committed ? { outcome: 'synced', snapshot: result } : { outcome: 'changed' };
  } catch (error) {
    const code = error instanceof CalendarSyncError && KNOWN_ERRORS.has(error.code) ? error.code : 'CALENDAR_SYNC_FAILED';
    await db.query(`UPDATE family_calendar_sync_jobs SET lease_id=NULL,lease_until=NULL,last_error_code=$6,next_attempt_at=$7
      WHERE household_id=$1 AND start_date=$2::date AND end_date=$3::date AND timezone=$4 AND lease_id=$5`,
    [...key, code, new Date(now.getTime() + calendarRetryMs(lease.attempts))]);
    return { outcome: 'failed', error: { code, message: 'Calendar sync failed. It will retry automatically. Check Setup if this continues.' } };
  }
}

// Await this from an authenticated scheduled function. At most one provider
// operation per invocation keeps its 25-second deadline below a 60-second job.
export async function processCalendarSyncJobs(db, { env = process.env, sync = syncIcloudCalendar, now = new Date() } = {}) {
  const connections = (await db.query(`SELECT c.*,h.timezone FROM family_calendar_connections c
    JOIN family_households h ON h.id=c.household_id WHERE jsonb_array_length(c.selected_ids)>0 ORDER BY c.household_id LIMIT 20`)).rows;
  for (const connection of connections) {
    const from = householdDate(connection.timezone, now);
    const window = sharedCalendarWindow(from, new Date(Date.parse(`${from}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10), connection.timezone, now);
    await enqueueCalendarSync(db, connection.household_id, connection, window.from, window.to, connection.timezone, now);
  }
  // Old browsing ranges do not refresh forever; active/default windows keep
  // their requested_at alive. A crashed lease becomes eligible after one minute.
  await db.query("DELETE FROM family_calendar_sync_jobs WHERE requested_at<$1::timestamptz-interval '7 days' AND (lease_id IS NULL OR lease_until<$1)", [now]);
  const job = await one(db, `SELECT *,start_date::text AS from_date,end_date::text AS to_date FROM family_calendar_sync_jobs
    WHERE next_attempt_at<=$1 AND (lease_id IS NULL OR lease_until<=$1) ORDER BY next_attempt_at,requested_at LIMIT 1`, [now]);
  if (!job) return { processed: 0, synced: 0, failed: 0, busy: 0 };
  const result = await runCalendarSyncJob(db, job, { env, sync, now });
  return { processed: 1, synced: Number(result.outcome === 'synced'), failed: Number(result.outcome === 'failed'), busy: Number(result.outcome === 'busy') };
}
