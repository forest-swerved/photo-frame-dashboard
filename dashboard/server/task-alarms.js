import { Temporal } from '@js-temporal/polyfill';
import { one, transaction } from './database.js';
import { requireHousehold } from './auth.js';
import { ApiError, householdDate, requireValue, uuidField } from './errors.js';
import { occurrenceDto } from './chore-occurrences.js';

export const ALARM_SNOOZE_MINUTES = 10;
const plainDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);

// The household-local instant a task's alarm starts. A due time skipped by a
// clock change rings at the next valid wall-clock time instead of never.
export function alarmDueAt(row, timezone) {
  if (!row?.alarm || !row.due_time) return null;
  try {
    return new Date(Temporal.PlainDate.from(plainDate(row.date)).toPlainDateTime(String(row.due_time).slice(0, 5))
      .toZonedDateTime(timezone, { disambiguation: 'compatible' }).epochMilliseconds);
  } catch { return null; }
}

// An alarm rings only on its own household day, from the due time until the
// task leaves "pending". A snooze pauses it; nothing else silences it.
export function alarmState(row, timezone, now = new Date()) {
  const dueAt = alarmDueAt(row, timezone);
  const active = Boolean(dueAt) && row.status === 'pending' && plainDate(row.date) === householdDate(timezone, now) && dueAt <= now;
  const snoozedUntil = active && row.alarm_snoozed_until && new Date(row.alarm_snoozed_until) > now ? new Date(row.alarm_snoozed_until) : null;
  return { dueAt, active, snoozedUntil, ringing: active && !snoozedUntil };
}

// Snoozing is shared state: silencing the frame also silences the phone. It
// deliberately leaves the task version alone so a "done" tap never conflicts.
export async function snoozeTaskAlarm(db, principal, id, { now = new Date() } = {}) {
  const householdId = requireHousehold(principal); uuidField(id);
  return transaction(db, async client => {
    const row = await one(client, `SELECT *,date::text,original_date::text FROM family_chore_occurrences
      WHERE household_id=$1 AND id=$2 AND ($3::uuid IS NULL OR person_id=$3) FOR UPDATE`, [householdId, id, principal.role === 'child' ? principal.personId : null]);
    if (!row) throw new ApiError(404, 'not_found', 'That task does not exist in this household.');
    requireValue(alarmState(row, principal.household.timezone, now).active, 409, 'alarm_not_ringing', 'This alarm is not ringing.');
    return occurrenceDto(await one(client, `UPDATE family_chore_occurrences SET alarm_snoozed_until=$3 WHERE household_id=$1 AND id=$2
      RETURNING *,date::text,original_date::text`, [householdId, id, new Date(now.getTime() + ALARM_SNOOZE_MINUTES * 60_000)]));
  });
}

// A paired frame is shared by the whole family. When the child has their own
// PIN, only that child (or an unlocked parent) can confirm an alarm task there.
export async function requireAlarmConfirmer(client, principal, row) {
  if (!row.alarm || principal.authType !== 'frame' || principal.verifiedFrameGrant || !row.person_id) return;
  const person = await one(client, 'SELECT name,frame_pin_hash IS NOT NULL AS pin FROM family_people WHERE household_id=$1 AND id=$2', [row.household_id, row.person_id]);
  requireValue(!person?.pin, 409, 'child_pin_required', `${person?.name || 'This child'} confirms this alarm with their own PIN.`, { personId: row.person_id });
}

// Called by the minute notification scan. One short-lived event per minute
// re-alerts the child's phone for as long as the alarm keeps ringing.
export async function ringingAlarmEvents(client, household, now) {
  const date = householdDate(household.timezone, now);
  const rows = (await client.query(`SELECT *,date::text FROM family_chore_occurrences WHERE household_id=$1 AND date=$2::date
    AND alarm AND status='pending' AND due_time IS NOT NULL AND person_id IS NOT NULL`, [household.id, date])).rows;
  return rows.filter(row => alarmState(row, household.timezone, now).ringing).map(row => ({
    householdId: household.id, key: `chore_alarm:${row.id}:${Math.floor(now.getTime() / 60_000)}`, type: 'chore_alarm',
    personId: row.person_id, choreId: row.chore_id, date, at: now, expiresAt: new Date(now.getTime() + 90_000),
    payload: { title: row.title, occurrenceId: row.id, choreVersion: row.routine_version, dueTime: row.due_time, audience: 'children' } }));
}
