import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CalendarSyncError, createCalendarWindow, normalizeCalendarObjects,
} from './calendar-normalize.js';

const denver = [
  'BEGIN:VTIMEZONE', 'TZID:America/Denver',
  'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0700', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0600', 'END:DAYLIGHT', 'END:VTIMEZONE',
];
const event = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const calendar = (...items) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...items.flat(), 'END:VCALENDAR', ''].join('\r\n');
const window = { startDate: '2026-10-30', endDateExclusive: '2026-11-06', timeZone: 'America/Denver' };
const normalize = (data, options = window) => normalizeCalendarObjects([{ calendarId: 'family', data }], options);

test('window follows local midnight through DST and enforces sixty calendar days', () => {
  const result = createCalendarWindow({ startDate: '2026-10-01', endDateExclusive: '2026-11-30', timeZone: 'America/Denver' });
  assert.equal(result.start, '2026-10-01T06:00:00.000Z');
  assert.equal(result.end, '2026-11-30T07:00:00.000Z');
  assert.throws(() => createCalendarWindow({ ...window, endDateExclusive: '2027-01-01' }), { code: 'INVALID_CALENDAR_WINDOW' });
  assert.throws(() => createCalendarWindow({ ...window, startDate: '2026-02-30' }), { code: 'INVALID_CALENDAR_WINDOW' });
  assert.throws(() => createCalendarWindow({ timeZone: 'Not/AZone' }), { code: 'INVALID_CALENDAR_WINDOW' });
});

test('all-day events preserve date-only exclusive ends, including multi-day overlap', () => {
  const { events } = normalize(calendar(
    event('UID:trip', 'DTSTART;VALUE=DATE:20261029', 'DTEND;VALUE=DATE:20261102', 'SUMMARY:Trip'),
    event('UID:one-day', 'DTSTART;VALUE=DATE:20261104'),
  ));
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(({ startDate, endDateExclusive }) => [startDate, endDateExclusive]), [
    ['2026-10-29', '2026-11-02'], ['2026-11-04', '2026-11-05'],
  ]);
  assert.equal(events[0].allDay, true);
  assert.ok(!('startAt' in events[0]));
});

test('RRULE, RDATE and EXDATE retain local time across fall DST', () => {
  const { events } = normalize(calendar(denver, event(
    'UID:school', 'DTSTART;TZID=America/Denver:20261030T090000',
    'DTEND;TZID=America/Denver:20261030T100000', 'RRULE:FREQ=DAILY;COUNT=5',
    'EXDATE;TZID=America/Denver:20261031T090000', 'RDATE;TZID=America/Denver:20261105T090000',
    'SUMMARY:School',
  )));
  assert.deepEqual(events.map((item) => item.startAt), [
    '2026-10-30T15:00:00.000Z', '2026-11-01T16:00:00.000Z',
    '2026-11-02T16:00:00.000Z', '2026-11-03T16:00:00.000Z', '2026-11-05T16:00:00.000Z',
  ]);
});

test('RDATE-only sets include DTSTART, while EXDATE can exclude DTSTART', () => {
  const { events } = normalize(calendar(
    event('UID:rdate-only', 'DTSTART:20261101T150000Z', 'RDATE:20261103T150000Z', 'SUMMARY:Included'),
    event('UID:rdate-excluded', 'DTSTART:20261101T150000Z', 'RDATE:20261103T150000Z', 'EXDATE:20261101T150000Z', 'SUMMARY:Excluded'),
  ));
  assert.deepEqual(events.filter((item) => item.title === 'Included').map((item) => item.startAt), ['2026-11-01T15:00:00.000Z', '2026-11-03T15:00:00.000Z']);
  assert.deepEqual(events.filter((item) => item.title === 'Excluded').map((item) => item.startAt), ['2026-11-03T15:00:00.000Z']);
});

test('weekly BYDAY and monthly ordinal rules expand into the requested window', () => {
  const { events } = normalize(calendar(
    event('UID:weekdays', 'DTSTART;TZID=America/Denver:20261026T090000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=7', 'SUMMARY:Weekdays'),
    event('UID:first-monday', 'DTSTART;TZID=America/Denver:20260907T110000', 'RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=4', 'SUMMARY:First Monday'),
  ), { ...window, endDateExclusive: '2026-11-06' });
  assert.deepEqual(events.filter((item) => item.title === 'Weekdays').map((item) => item.startAt), [
    '2026-10-30T15:00:00.000Z', '2026-11-02T16:00:00.000Z', '2026-11-04T16:00:00.000Z',
  ]);
  assert.equal(events.find((item) => item.title === 'First Monday').startAt, '2026-11-02T18:00:00.000Z');
});

test('valid IANA TZID without VTIMEZONE uses IANA rules on a UTC server', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    const { events } = normalize(calendar(event(
      'UID:iana', 'DTSTART;TZID=America/Denver:20261031T090000',
      'DTEND;TZID=America/Denver:20261031T100000', 'RRULE:FREQ=DAILY;UNTIL=20261102T160000Z',
    )));
    assert.deepEqual(events.map((item) => item.startAt), [
      '2026-10-31T15:00:00.000Z', '2026-11-01T16:00:00.000Z', '2026-11-02T16:00:00.000Z',
    ]);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('floating values use the household zone and DST gaps follow RFC-compatible resolution', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    const springWindow = { startDate: '2026-03-07', endDateExclusive: '2026-03-10', timeZone: 'America/Denver' };
    const { events } = normalize(calendar(
      event('UID:floating', 'DTSTART:20260307T090000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Floating'),
      event('UID:gap', 'DTSTART;TZID=America/Denver:20260308T023000', 'DURATION:PT1H'),
    ), springWindow);
    assert.deepEqual(events.filter((item) => item.title === 'Floating').map((item) => item.startAt), [
      '2026-03-07T16:00:00.000Z', '2026-03-08T15:00:00.000Z', '2026-03-09T15:00:00.000Z',
    ]);
    assert.ok(events.some((item) => item.startAt === '2026-03-08T09:30:00.000Z'));
    assert.ok(events.some((item) => item.startAt === '2026-03-08T15:00:00.000Z'));
    assert.ok(events.some((item) => item.startAt === '2026-03-09T15:00:00.000Z'));
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('moved, moved-in and cancelled recurrence overrides replace their original slots', () => {
  const { events } = normalize(calendar(
    event('UID:practice', 'DTSTART:20261001T150000Z', 'DTEND:20261001T160000Z', 'RRULE:FREQ=DAILY;COUNT=40', 'SUMMARY:Practice'),
    event('UID:practice', 'RECURRENCE-ID:20261101T150000Z', 'DTSTART:20261101T180000Z', 'DTEND:20261101T190000Z', 'SUMMARY:Moved'),
    event('UID:practice', 'RECURRENCE-ID:20261102T150000Z', 'STATUS:CANCELLED'),
    event('UID:practice', 'RECURRENCE-ID:20261001T150000Z', 'DTSTART:20261103T200000Z', 'DTEND:20261103T210000Z', 'SUMMARY:Moved into window'),
  ));
  assert.ok(!events.some((item) => item.startAt === '2026-11-01T15:00:00.000Z'));
  assert.ok(!events.some((item) => item.startAt === '2026-11-02T15:00:00.000Z'));
  assert.equal(events.filter((item) => item.title === 'Moved').length, 1);
  assert.equal(events.filter((item) => item.title === 'Moved into window').length, 1);
  assert.equal(new Set(events.map((item) => item.id)).size, events.length);
});

test('exceptions stay within their UID and equivalent UTC recurrence IDs match zoned series', () => {
  const { events } = normalize(calendar(denver,
    event('UID:first', 'DTSTART;TZID=America/Denver:20261101T090000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=2', 'SUMMARY:First'),
    event('UID:first', 'RECURRENCE-ID:20261101T160000Z', 'DTSTART:20261101T190000Z', 'DURATION:PT1H', 'SUMMARY:Override'),
    event('UID:second', 'DTSTART:20261101T160000Z', 'DURATION:PT1H', 'SUMMARY:Second'),
  ));
  assert.equal(events.length, 3);
  assert.equal(events.filter((item) => item.startAt === '2026-11-01T16:00:00.000Z').length, 1);
  assert.equal(events.find((item) => item.startAt === '2026-11-01T16:00:00.000Z').title, 'Second');
});

test('RANGE THISANDFUTURE moves following occurrences and cancellation suppresses the future', () => {
  const { events } = normalize(calendar(
    event('UID:range', 'DTSTART:20261030T150000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=7'),
    event('UID:range', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261031T150000Z', 'DTSTART:20261031T170000Z', 'DURATION:PT1H'),
    event('UID:range', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261103T150000Z', 'STATUS:CANCELLED'),
  ));
  assert.equal(events.length, 4);
  assert.equal(events.find((item) => item.startAt.startsWith('2026-11-02')).startAt, '2026-11-02T17:00:00.000Z');
  assert.ok(!events.some((item) => item.startAt.startsWith('2026-11-03')));
});

test('exact recurring DTEND duration and DURATION day/hour semantics survive DST', () => {
  const { events } = normalize(calendar(denver,
    event('UID:exact', 'DTSTART;TZID=America/Denver:20261030T210000', 'DTEND;TZID=America/Denver:20261031T090000', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Exact'),
    event('UID:day', 'DTSTART;TZID=America/Denver:20261031T090000', 'DURATION:P1D', 'SUMMARY:Calendar day'),
    event('UID:hours', 'DTSTART;TZID=America/Denver:20261031T090000', 'DURATION:PT24H', 'SUMMARY:24 hours'),
  ));
  for (const item of events.filter((item) => item.title === 'Exact')) assert.equal(Date.parse(item.endAt) - Date.parse(item.startAt), 12 * 3600_000);
  const day = events.find((item) => item.title === 'Calendar day');
  const hours = events.find((item) => item.title === '24 hours');
  assert.equal(Date.parse(day.endAt) - Date.parse(day.startAt), 25 * 3600_000);
  assert.equal(Date.parse(hours.endAt) - Date.parse(hours.startAt), 24 * 3600_000);
});

test('a document VTIMEZONE takes precedence over IANA and cannot contaminate another document', () => {
  const fixed = ['BEGIN:VTIMEZONE', 'TZID:America/Denver', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0400', 'END:STANDARD', 'END:VTIMEZONE'];
  const custom = calendar(fixed, event('UID:custom', 'DTSTART;TZID=America/Denver:20261101T090000'));
  const iana = calendar(event('UID:iana', 'DTSTART;TZID=America/Denver:20261101T090000'));
  const { events } = normalizeCalendarObjects([{ calendarId: 'a', data: custom }, { calendarId: 'b', data: iana }], window);
  assert.deepEqual(events.map((item) => item.startAt).sort(), ['2026-11-01T13:00:00.000Z', '2026-11-01T16:00:00.000Z']);
});

test('a custom TZID can use its DAV collection timezone definition', () => {
  const definition = calendar([
    'BEGIN:VTIMEZONE', 'TZID:Custom/Family', 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
    'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0400', 'END:STANDARD', 'END:VTIMEZONE',
  ]);
  const data = calendar(event('UID:collection-zone', 'DTSTART;TZID=Custom/Family:20261101T090000'));
  const { events } = normalizeCalendarObjects([{ calendarId: 'family', data, calendarTimeZone: definition }], window);
  assert.equal(events[0].startAt, '2026-11-01T13:00:00.000Z');
});

test('unknown zones and malformed data fail with incomplete coverage and no private text', () => {
  const privateValue = 'private calendar content';
  const bad = calendar(event('UID:bad', 'DTSTART;TZID=Private/Unknown:20261101T090000', `SUMMARY:${privateValue}`));
  assert.throws(() => normalize(bad), (error) => error instanceof CalendarSyncError
    && error.code === 'UNSUPPORTED_CALENDAR_TIME_ZONE' && error.coverage.complete === false
    && !error.message.includes(privateValue));
  assert.throws(() => normalize('not an iCalendar'), { code: 'INVALID_CALENDAR_DATA' });
  assert.throws(() => normalize(calendar(event('UID:bad-date', 'DTSTART:20260230T090000Z'))), { code: 'INVALID_CALENDAR_DATA' });
  assert.throws(() => normalize(calendar(['BEGIN:VTIMEZONE', 'TZID:Custom/Empty', 'END:VTIMEZONE'],
    event('UID:bad-zone', 'DTSTART;TZID=Custom/Empty:20261101T090000'))), { code: 'INVALID_CALENDAR_DATA' });
});

test('over 400 events or excessive recurrence work fail instead of publishing partial ready data', () => {
  assert.throws(() => normalize(calendar(event('UID:dense', 'DTSTART:20261030T150000Z', 'RRULE:FREQ=MINUTELY;COUNT=401'))),
    (error) => error.code === 'CALENDAR_EVENT_LIMIT' && error.coverage.complete === false && error.coverage.truncated === true);
  assert.throws(() => normalize(calendar(event('UID:old-dense', 'DTSTART:20000101T000000Z', 'RRULE:FREQ=MINUTELY'))),
    (error) => error.code === 'CALENDAR_WORK_LIMIT' && error.coverage.complete === false);
});

test('zero events is a complete result; cancelled series and exclusive boundaries disappear', () => {
  const { events, coverage } = normalize(calendar(
    event('UID:cancelled', 'STATUS:CANCELLED', 'DTSTART:20261101T090000Z', 'RRULE:FREQ=DAILY;COUNT=5'),
    event('UID:boundary', 'DTSTART;VALUE=DATE:20261029', 'DTEND;VALUE=DATE:20261030'),
  ));
  assert.deepEqual(events, []);
  assert.equal(coverage.complete, true);
});
