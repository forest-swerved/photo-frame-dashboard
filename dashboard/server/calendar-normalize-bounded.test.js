import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCalendarObjectsBounded } from './calendar-normalize-bounded.js';

const window = { startDate: '2026-11-01', endDateExclusive: '2026-11-08', timeZone: 'America/Denver' };
const calendar = (...lines) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:worker-fixture', ...lines,
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

test('bounded worker returns only normalized events and complete coverage', async () => {
  const result = await normalizeCalendarObjectsBounded([{ calendarId: 'family', data: calendar(
    'DTSTART;TZID=America/Denver:20261101T090000', 'DURATION:PT1H', 'SUMMARY:Family breakfast',
  ), unexpectedSecret: 'must not enter worker' }], window);
  assert.equal(result.events[0].startAt, '2026-11-01T16:00:00.000Z');
  assert.equal(result.coverage.complete, true);
  assert.ok(!JSON.stringify(result).includes('BEGIN:VCALENDAR'));
  assert.ok(!JSON.stringify(result).includes('must not enter worker'));
});

test('an impossible RRULE inside iterator.next is terminated by a real deadline', async () => {
  const started = Date.now();
  await assert.rejects(normalizeCalendarObjectsBounded([{ calendarId: 'family', data: calendar(
    'DTSTART:20261101T090000Z', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
    'SUMMARY:Private content must not enter the error',
  ) }], { ...window, timeoutMs: 40 }), (error) => error.code === 'CALENDAR_WORK_LIMIT'
    && error.coverage.complete === false && !error.message.includes('Private content'));
  assert.ok(Date.now() - started < 3000);
});

test('worker parser errors are sanitized and do not expose source text', async () => {
  await assert.rejects(normalizeCalendarObjectsBounded([{ calendarId: 'family', data: 'private invalid source' }], window),
    (error) => error.code === 'INVALID_CALENDAR_DATA' && error.coverage.complete === false
      && !error.message.includes('private invalid source'));
});

test('input count/bytes and timeout options are rejected before worker allocation', async () => {
  await assert.rejects(normalizeCalendarObjectsBounded(Array.from({ length: 1001 }, () => ({ calendarId: 'a', data: '' })), window), { code: 'INVALID_CALENDAR_DATA' });
  await assert.rejects(normalizeCalendarObjectsBounded([{ calendarId: 'a', data: 'x'.repeat(1024 * 1024 + 1) }], window), { code: 'INVALID_CALENDAR_DATA' });
  await assert.rejects(normalizeCalendarObjectsBounded([], { ...window, timeoutMs: 60_000 }), { code: 'INVALID_CALENDAR_DATA' });
});
