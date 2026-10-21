import { dateField, householdDate, requireValue, textField, versionField } from './errors.js';
import { requireHousehold } from './auth.js';
import { requireChoreManager } from './capabilities.js';
import { one, transaction } from './database.js';
import { ensureDailyOccurrences } from './chore-occurrences.js';

const types = ['school_day', 'non_school_day'];
const nextDate = date => new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const dayCount = (from, to) => (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000;

export function schoolDayFilter(value = 'any') {
  requireValue(['any', ...types].includes(value), 422, 'invalid_school_filter', 'Choose every day, school days, or non-school days.');
  return value;
}

export function validateSchoolCalendar(value) {
  requireValue(object(value), 422, 'invalid_school_calendar', 'Supply a school-year calendar.');
  const title = textField(value.title, 'Calendar title', 160);
  const sourceName = textField(value.sourceName, 'Calendar source', 240);
  const sourceUrl = value.sourceUrl ?? null;
  let validSource = sourceUrl === null;
  if (typeof sourceUrl === 'string' && sourceUrl.length <= 1000) {
    try { const url = new URL(sourceUrl); validSource = url.protocol === 'https:' && !url.username && !url.password; } catch { /* Rejected below. */ }
  }
  requireValue(validSource, 422, 'invalid_school_calendar', 'Use an HTTPS school calendar source link.');
  const sourceSha256 = value.sourceSha256 ?? null;
  requireValue(sourceSha256 === null || typeof sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(sourceSha256), 422, 'invalid_school_calendar', 'Use a valid source document checksum.');
  const coverageStart = dateField(value.coverageStart), coverageEndExclusive = dateField(value.coverageEndExclusive);
  const termStart = dateField(value.termStart), termEndExclusive = dateField(value.termEndExclusive);
  requireValue(dayCount(coverageStart, coverageEndExclusive) > 0 && dayCount(coverageStart, coverageEndExclusive) <= 370
    && coverageStart <= termStart && termStart < termEndExclusive && termEndExclusive <= coverageEndExclusive,
  422, 'invalid_school_calendar', 'The school term must fit inside one school-year coverage period.');
  const weekdays = value.weekdays;
  requireValue(Array.isArray(weekdays) && weekdays.length > 0 && weekdays.length <= 7
    && weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6) && new Set(weekdays).size === weekdays.length,
  422, 'invalid_school_calendar', 'Choose the school weekdays.');
  requireValue(Array.isArray(value.closures) && value.closures.length <= 100, 422, 'invalid_school_calendar', 'Use at most 100 school closure ranges.');
  const closures = value.closures.map(item => {
    requireValue(object(item), 422, 'invalid_school_calendar', 'Use valid school closure ranges.');
    const fromDate = dateField(item.fromDate), toDateExclusive = dateField(item.toDateExclusive);
    requireValue(fromDate >= coverageStart && toDateExclusive <= coverageEndExclusive && fromDate < toDateExclusive,
      422, 'invalid_school_calendar', 'School closures must fall inside the calendar coverage.');
    return { fromDate, toDateExclusive, label: textField(item.label, 'School closure label', 160) };
  }).sort((a, b) => a.fromDate.localeCompare(b.fromDate) || a.toDateExclusive.localeCompare(b.toDateExclusive));
  for (let i = 1; i < closures.length; i++) requireValue(closures[i].fromDate >= closures[i - 1].toDateExclusive,
    422, 'invalid_school_calendar', 'School closure ranges must not overlap.');
  const suppliedOverrides = value.overrides ?? [];
  requireValue(Array.isArray(suppliedOverrides) && suppliedOverrides.length <= 370, 422, 'invalid_school_calendar', 'Use at most one school override per covered date.');
  const overrides = suppliedOverrides.map(item => {
    requireValue(object(item) && types.includes(item.type), 422, 'invalid_school_calendar', 'Choose a school-day or non-school-day override.');
    const date = dateField(item.date);
    requireValue(date >= coverageStart && date < coverageEndExclusive, 422, 'invalid_school_calendar', 'Overrides must fall inside the school-year coverage.');
    return { date, type: item.type, reason: textField(item.reason, 'Override reason', 500) };
  }).sort((a, b) => a.date.localeCompare(b.date));
  requireValue(new Set(overrides.map(item => item.date)).size === overrides.length, 422, 'invalid_school_calendar', 'Each school date can have only one override.');
  return { title, sourceName, sourceUrl, sourceSha256, coverageStart, coverageEndExclusive, termStart, termEndExclusive, weekdays: [...weekdays].sort(), closures, overrides };
}

export function classifySchoolDay(calendar, date) {
  dateField(date);
  const calendarVersion = calendar?.version ?? null;
  const result = (type, label, reason) => ({ date, type, label, reason, calendarVersion });
  if (!calendar || date < calendar.coverageStart || date >= calendar.coverageEndExclusive)
    return result('unknown', 'School schedule needed', calendar ? 'This date is outside the imported school-year calendar.' : 'Import a school calendar to schedule school-day and non-school-day tasks.');
  const override = calendar.overrides.find(item => item.date === date);
  if (override) return result(override.type, override.type === 'school_day' ? 'School day' : 'No school', override.reason);
  const closure = calendar.closures.find(item => date >= item.fromDate && date < item.toDateExclusive);
  if (closure) return result('non_school_day', 'No school', closure.label);
  if (date < calendar.termStart || date >= calendar.termEndExclusive) return result('non_school_day', 'No school', 'Summer break / outside the student term.');
  if (!calendar.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return result('non_school_day', 'No school', 'Weekend / regular day off.');
  return result('school_day', 'School day', 'Regular school day.');
}

const dto = row => row ? { ...row.document, version: row.version, updatedAt: new Date(row.created_at).toISOString() } : null;
export async function lockSchoolCalendar(client, householdId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`school:${householdId}`]);
}
export async function schoolDayForDate(db, householdId, date) {
  return classifySchoolDay(dto(await calendarRowForDate(db, householdId, date)), date);
}
async function calendarRowForDate(db, householdId, date) {
  return one(db, `SELECT document,version,created_at,max(version) OVER() AS latest_version FROM family_school_calendars WHERE household_id=$1
    ORDER BY coalesce(document->>'coverageStart'<=$2 AND document->>'coverageEndExclusive'>$2,false) DESC,version DESC LIMIT 1`, [householdId, date]);
}
export async function schoolCalendarSnapshot(db, principal, requestedDate, { now = new Date() } = {}) {
  const householdId = requireHousehold(principal), date = dateField(requestedDate || householdDate(principal.household.timezone, now));
  const row = await calendarRowForDate(db, householdId, date), calendar = dto(row);
  return { calendar, schoolDay: classifySchoolDay(calendar, date), latestVersion: row?.latest_version ?? 0 };
}

export async function saveSchoolCalendar(db, principal, body, { override = false, now = new Date(), onChange } = {}) {
  requireChoreManager(principal);
  const householdId = principal.household.id;
  requireValue(object(body) && Number.isInteger(body.expectedVersion) && body.expectedVersion >= 0, 422, 'invalid_version', 'Refresh the school calendar before changing it.');
  if (body.expectedVersion > 0) versionField(body.expectedVersion);
  return transaction(db, async client => {
    await lockSchoolCalendar(client, householdId);
    const overrideDate = override ? dateField(body.override?.date) : null;
    requireValue(!overrideDate || overrideDate >= householdDate(principal.household.timezone, now), 422, 'past_school_override',
      'Past task history is preserved. Choose today or a future date for a school-day override.');
    const row = await calendarRowForDate(client, householdId, overrideDate), current = dto(row);
    requireValue((current?.version ?? 0) === body.expectedVersion, 409, 'version_conflict', 'The school calendar changed. Refresh before editing.', { current });
    let calendar;
    if (override) {
      requireValue(current && object(body.override), 422, 'school_calendar_required', 'Import the school-year calendar first.');
      const change = body.override, date = dateField(change.date);
      requireValue(change.type === null || types.includes(change.type), 422, 'invalid_school_calendar', 'Choose school day, non-school day, or remove the override.');
      requireValue(date >= current.coverageStart && date < current.coverageEndExclusive, 422, 'invalid_school_calendar', 'This date is outside the imported school year.');
      textField(change.reason, 'Override reason', 500);
      calendar = validateSchoolCalendar({ ...current, overrides: [...current.overrides.filter(item => item.date !== date), ...(change.type === null ? [] : [{ date, type: change.type, reason: change.reason }])] });
    } else calendar = validateSchoolCalendar(body.calendar);
    const version = (row?.latest_version ?? 0) + 1;
    await client.query('INSERT INTO family_school_calendars(household_id,version,document,created_by,created_at) VALUES($1,$2,$3::jsonb,$4,$5)',
      [householdId, version, JSON.stringify(calendar), principal.actor || 'parent', now]);
    const today = householdDate(principal.household.timezone, now);
    const rows = await ensureDailyOccurrences(client, principal.household, today, { now });
    if (onChange) for (const personId of [...new Set(rows.map(row => row.person_id).filter(Boolean))])
      await onChange(client, { householdId, personId, date: today, affectedDates: [today], actor: principal.actor });
    return schoolCalendarSnapshot(client, principal, overrideDate || today, { now });
  });
}

export function routineSchoolMatches(filter, schoolDay) { return filter === 'any' || filter === schoolDay.type; }
export { nextDate as nextSchoolDate };
