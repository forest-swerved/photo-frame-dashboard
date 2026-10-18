import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDayIsKnown, calendarEventsByDay, completionBody, eventsOn, mergeCompletion, reconcileHousehold, choreUrgency, orderChores, timeLabel } from './model.js';

test('an unconnected, failed, stale or partially covered calendar never means a free day', () => {
  const coverage = { startDate: '2026-03-01', endDateExclusive: '2026-04-01', complete: true, truncated: false };
  for (const status of ['not_configured', 'loading', 'stale', 'error']) assert.equal(calendarDayIsKnown({ status, coverage }, '2026-03-08'), false);
  assert.equal(calendarDayIsKnown({ status: 'ready', coverage: { ...coverage, complete: false } }, '2026-03-08'), false);
  assert.equal(calendarDayIsKnown({ status: 'ready', coverage: { ...coverage, truncated: true } }, '2026-03-08'), false);
  assert.equal(calendarDayIsKnown({ status: 'ready', coverage }, '2026-04-01'), false);
  assert.equal(calendarDayIsKnown({ status: 'ready', coverage }, '2026-03-08'), true);
});

test('a late completion response cannot overwrite a newer poll or another day', () => {
  const chores = [{ id: 'a', completion: { date: '2026-03-08', completed: false, version: 4 } }];
  assert.deepEqual(mergeCompletion(chores, { choreId: 'a', date: '2026-03-08', completed: true, version: 3 }, '2026-03-08'), chores);
  assert.deepEqual(mergeCompletion(chores, { choreId: 'a', date: '2026-03-07', completed: true, version: 5 }, '2026-03-08'), chores);
  assert.equal(mergeCompletion(chores, { choreId: 'a', date: '2026-03-08', completed: true, version: 5 }, '2026-03-08')[0].completion.completed, true);
});

test('an older household snapshot cannot revert an acknowledged completion', () => {
  const current = { date: '2026-03-08', chores: [{ id: 'a', completion: { date: '2026-03-08', completed: true, version: 5 } }] };
  const incoming = { date: '2026-03-08', chores: [{ id: 'a', completion: { date: '2026-03-08', completed: false, version: 4 } }] };
  assert.equal(reconcileHousehold(current, incoming).chores[0].completion.version, 5);
  assert.equal(reconcileHousehold(current, { ...incoming, date: '2026-03-09' }).date, '2026-03-09');
});

test('completion requests carry explicit desired state and current dated version', () => {
  const chore = { completion: { date: '2026-03-08', version: 7 } };
  assert.deepEqual(completionBody(chore, '2026-03-08', false, 'unique'), { completed: false, expectedVersion: 7, mutationId: 'unique' });
  assert.equal(completionBody(chore, '2026-03-09', true, 'new-day').expectedVersion, 0);
  assert.throws(() => completionBody({ completion: { date: '2026-03-08', version: undefined } }, '2026-03-08', true, 'x'));
});

test('date-only all-day events and midnight endings preserve calendar boundaries across DST', () => {
  const events = [
    { id: 'all-day', allDay: true, startDate: '2026-03-08', endDateExclusive: '2026-03-09' },
    { id: 'midnight', allDay: false, startAt: '2026-03-08T05:00:00Z', endAt: '2026-03-08T07:00:00Z' },
  ];
  assert.deepEqual(eventsOn(events, '2026-03-08', 'America/Denver').map(event => event.id), ['all-day']);
  assert.deepEqual(eventsOn(events, '2026-03-07', 'America/Denver').map(event => event.id), ['midnight']);
  assert.equal(eventsOn(events, '2026-03-09', 'America/Denver').length, 0);
});

test('calendar grouping clips long events to the requested range and retains zero-length midnight events', () => {
  const events = [
    { id: 'long', allDay: true, startDate: '2000-01-01', endDateExclusive: '2099-01-01' },
    { id: 'instant', allDay: false, startAt: '2026-03-08T07:00:00Z', endAt: '2026-03-08T07:00:00Z' },
    { id: 'overnight', allDay: false, startAt: '2026-03-08T06:00:00Z', endAt: '2026-03-08T09:00:00Z' },
  ];
  const grouped = calendarEventsByDay(events, 'America/Denver', '2026-03-07', '2026-03-10');
  assert.equal(grouped.size, 3);
  assert.deepEqual(grouped.get('2026-03-07').map(event => event.id), ['long', 'overnight']);
  assert.deepEqual(grouped.get('2026-03-08').map(event => event.id), ['long', 'overnight', 'instant']);
  assert.deepEqual(grouped.get('2026-03-09').map(event => event.id), ['long']);
  assert.equal(calendarEventsByDay(events, 'America/Denver', '2026-03-07', '2026-03-10'), grouped);
});

test('a 42-day calendar parses event dates once and reuses the formatter instead of constructing one per day and event', t => {
  const Original = Intl.DateTimeFormat;
  let constructions = 0;
  t.mock.method(Intl, 'DateTimeFormat', function (...args) { constructions++; return new Original(...args); });
  const events = Array.from({ length: 200 }, (_, index) => ({
    id: String(index), allDay: false, startAt: `2026-10-${String(index % 28 + 1).padStart(2, '0')}T12:00:00Z`, endAt: `2026-10-${String(index % 28 + 1).padStart(2, '0')}T13:00:00Z`,
  }));
  const grouped = calendarEventsByDay(events, 'Pacific/Honolulu', '2026-09-28', '2026-11-09');
  assert.equal([...grouped.values()].flat().length, 200);
  for (let day = 1; day <= 28; day++) eventsOn(events, `2026-10-${String(day).padStart(2, '0')}`, 'Pacific/Honolulu');
  assert.ok(constructions <= 1, `Constructed ${constructions} date formatters.`);
});

test('urgency uses the household clock and completed chores follow unfinished deadlines', () => {
  const date = '2026-10-17', now = new Date('2026-10-17T22:55:00Z');
  const chores = [
    { id: 'done', dueTime: '08:00', completion: { date, completed: true } },
    { id: 'later', dueTime: '18:00' },
    { id: 'soon', dueTime: '17:00', reminderMinutes: 15 },
    { id: 'overdue', dueTime: '16:30' },
  ];
  assert.equal(choreUrgency(chores[2], date, 'America/Denver', now), 'soon');
  assert.equal(choreUrgency(chores[2], date, 'America/Denver', new Date('2026-10-17T23:00:01Z')), 'overdue');
  assert.deepEqual(orderChores(chores, date, 'America/Denver', now).map(chore => chore.id), ['overdue', 'soon', 'later', 'done']);
  assert.equal(timeLabel('17:05'), '5:05 PM');
});
