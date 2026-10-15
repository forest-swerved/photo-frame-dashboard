import { CalendarSyncError, listIcloudCalendars, syncIcloudCalendar } from './icloud-caldav.js';
import { createCalendarWindow } from './calendar-normalize.js';
import { ApiError, calendarWindow, requireValue, textField } from './errors.js';
import { decryptCredentials, encryptCredentials } from './credentials.js';
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
    return calendarDto({ ...row, selected_ids: ids });
  });
}

export async function removeCalendar(db, principal) {
  requireAdmin(principal);
  return transaction(db, async client => {
    await client.query('SELECT household_id FROM family_calendar_connections WHERE household_id=$1 FOR UPDATE', [principal.household.id]);
    await client.query('DELETE FROM family_calendar_cache WHERE household_id=$1', [principal.household.id]);
    await client.query('DELETE FROM family_calendar_connections WHERE household_id=$1', [principal.household.id]);
    return { deleted: true };
  });
}

export async function calendarSnapshot(db, principal, from, to, { env = process.env, force = false, sync = syncIcloudCalendar } = {}) {
  const householdId = requireHousehold(principal);
  const window = calendarWindow(from, to);
  const connection = await one(db, 'SELECT * FROM family_calendar_connections WHERE household_id=$1', [householdId]);
  const empty = { status: 'not_configured', events: [], coverage: null, lastSuccessfulSyncAt: null, error: null };
  if (!connection || !connection.selected_ids.length) return empty;
  const values = [householdId, from, to, principal.household.timezone];
  const cached = await one(db, 'SELECT * FROM family_calendar_cache WHERE household_id=$1 AND start_date=$2::date AND end_date=$3::date AND timezone=$4 AND connection_version=$5', [...values, connection.version]);
  if (!force && cached && Date.now() - new Date(cached.successful_at).getTime() < 300_000) return { ...cached.snapshot, status: 'ready', error: null };
  try {
    const credentials = decryptCredentials(householdId, connection.credentials, env);
    const snapshot = await sync({ ...credentials, calendarIds: connection.selected_ids, timeZone: principal.household.timezone, ...window });
    requireValue(snapshot.coverage?.complete === true && !snapshot.coverage.truncated && snapshot.events.length <= 400, 502, 'calendar_incomplete', 'Calendar results were incomplete.');
    const result = { status: 'ready', events: snapshot.events, coverage: snapshot.coverage, lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt, error: null };
    await transaction(db, async client => {
      // The randomized credential envelope also identifies this connection. A
      // disconnect/reconnect may reset version to 1, but never reuses the IV.
      const current = await one(client, 'SELECT version FROM family_calendar_connections WHERE household_id=$1 AND credentials=$2::jsonb FOR SHARE', [householdId, JSON.stringify(connection.credentials)]);
      requireValue(current?.version === connection.version, 409, 'calendar_changed', 'Calendar selection changed. Refresh the view.');
      await client.query(`INSERT INTO family_calendar_cache(household_id,start_date,end_date,timezone,snapshot,successful_at,connection_version)
        VALUES($1,$2::date,$3::date,$4,$5::jsonb,$6::timestamptz,$7)
        ON CONFLICT(household_id,start_date,end_date,timezone) DO UPDATE SET snapshot=EXCLUDED.snapshot,successful_at=EXCLUDED.successful_at,connection_version=EXCLUDED.connection_version`,
      [...values, JSON.stringify(result), snapshot.lastSuccessfulSyncAt, connection.version]);
    });
    return result;
  } catch (error) {
    if (error?.code === 'calendar_changed') return { ...empty, status: 'loading' };
    // A failed request must not revive a captured cache after Setup replaced or
    // disconnected its connection while the provider request was in flight.
    const current = await one(db, 'SELECT version FROM family_calendar_connections WHERE household_id=$1 AND credentials=$2::jsonb', [householdId, JSON.stringify(connection.credentials)]);
    if (current?.version !== connection.version) return { ...empty, status: 'loading' };
    // No provider error body, credentials, account email, or DAV URL crosses this boundary.
    const code = error instanceof CalendarSyncError ? error.code : 'CALENDAR_SYNC_FAILED';
    const safeError = { code, message: 'Calendar sync failed. Check Setup or try again.' };
    if (cached) return { ...cached.snapshot, status: 'stale', error: safeError };
    return { ...empty, status: 'error', coverage: { ...createCalendarWindow({ ...window, timeZone: principal.household.timezone }), complete: false }, error: safeError };
  }
}
