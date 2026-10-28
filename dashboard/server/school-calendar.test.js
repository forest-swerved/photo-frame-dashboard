import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySchoolDay, nextSchoolDate, routineSchoolMatches, schoolDayFilter, validateSchoolCalendar } from './school-calendar.js';
import { routineDetails } from './chore-occurrences.js';
import { schoolCalendarFixture } from './school-calendar-fixture.js';

test('school calendar reproduces 174 student days; weekends, summer, breaks and possible makeup dates remain off', () => {
  const calendar = { ...validateSchoolCalendar(schoolCalendarFixture()), version: 1 };
  let count = 0;
  for (let date = calendar.coverageStart; date < calendar.coverageEndExclusive; date = nextSchoolDate(date)) if (classifySchoolDay(calendar, date).type === 'school_day') count++;
  assert.equal(count, 174);
  for (const date of ['2026-08-19', '2026-09-07', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2027-01-04', '2027-02-12', '2027-04-09', '2027-05-29', '2027-06-30'])
    assert.equal(classifySchoolDay(calendar, date).type, 'non_school_day', date);
  for (const date of ['2026-08-20', '2026-10-13', '2026-10-19', '2027-01-06', '2027-03-23', '2027-05-28']) assert.equal(classifySchoolDay(calendar, date).type, 'school_day', date);
  assert.equal(classifySchoolDay(calendar, '2027-07-01').type, 'unknown');
  assert.equal(classifySchoolDay(null, '2026-10-20').type, 'unknown');
});

test('parent snow and makeup day overrides precede closures and weekdays', () => {
  const calendar = { ...validateSchoolCalendar({ ...schoolCalendarFixture(), overrides: [
    { date: '2026-10-20', type: 'non_school_day', reason: 'Snow closure' },
    { date: '2027-02-12', type: 'school_day', reason: 'Confirmed weather makeup day' },
    { date: '2026-10-24', type: 'school_day', reason: 'Saturday makeup' },
  ] }), version: 7 };
  assert.deepEqual(classifySchoolDay(calendar, '2026-10-20'), { date: '2026-10-20', type: 'non_school_day', label: 'No school', reason: 'Snow closure', calendarVersion: 7 });
  assert.equal(classifySchoolDay(calendar, '2027-02-12').type, 'school_day');
  assert.equal(classifySchoolDay(calendar, '2026-10-24').type, 'school_day');
});

test('calendar and routine validation reject ambiguous ranges, duplicate dates and school-filtered one-off work', () => {
  const base = schoolCalendarFixture();
  for (const change of [{ coverageEndExclusive: '2026-07-01' }, { termStart: '2026-06-30' }, { weekdays: [1, 1] }, { weekdays: [] },
    { closures: [{ fromDate: '2026-02-30', toDateExclusive: '2026-03-01', label: 'Invalid' }] },
    { closures: [base.closures[0], base.closures[0]] }, { sourceUrl: 'javascript:alert(1)' }, { sourceSha256: 'invalid' },
    { overrides: [{ date: '2027-07-01', type: 'school_day', reason: 'Out of coverage' }] },
    { overrides: [1, 2].map(() => ({ date: '2026-10-20', type: 'school_day', reason: 'Duplicate' })) }])
    assert.throws(() => validateSchoolCalendar({ ...base, ...change }), error => error.status === 422);
  assert.throws(() => schoolDayFilter('weekday'), error => error.status === 422);
  assert.throws(() => routineDetails({ schoolDayFilter: null }), error => error.status === 422);
  assert.throws(() => routineDetails({ scheduleType: 'one_off', scheduledDate: '2026-10-20', schoolDayFilter: 'school_day' }), error => error.status === 422);
  assert.equal(routineDetails({ schoolDayFilter: 'school_day' }).schoolDayFilter, 'school_day');
  assert.equal(routineDetails({}, { school_day_filter: 'non_school_day' }).schoolDayFilter, 'non_school_day');
  assert.equal(routineDetails({ scheduleType: 'one_off', scheduledDate: '2026-10-20' }, { school_day_filter: 'school_day' }).schoolDayFilter, 'any');
  assert.equal(routineSchoolMatches('any', { type: 'unknown' }), true);
  assert.equal(routineSchoolMatches('school_day', { type: 'unknown' }), false);
});

test('school-day task sections remain independent of weekdays and normalize for other schedules', () => {
  const before = routineDetails({ schoolDayFilter: 'school_day', taskSection: 'before_school' });
  assert.equal(before.taskSection, 'before_school');
  assert.equal(routineDetails({ schoolDayFilter: 'school_day', taskSection: 'after_school' }).taskSection, 'after_school');
  assert.equal(routineDetails({ schoolDayFilter: 'school_day' }).taskSection, 'tasks', 'Older clients keep an unclassified task section.');
  assert.equal(routineDetails({ schoolDayFilter: 'non_school_day', taskSection: 'before_school' }).taskSection, 'tasks');
  assert.equal(routineDetails({ schoolDayFilter: 'any' }, { task_section: 'after_school' }).taskSection, 'after_school');
  assert.equal(routineDetails({ scheduleType: 'one_off', scheduledDate: '2026-10-20', taskSection: 'after_school' }).taskSection, 'tasks');
  assert.throws(() => routineDetails({ taskSection: 'lunch' }), error => error.status === 422);
  assert.throws(() => routineDetails({ taskSection: null }), error => error.status === 422);
});
