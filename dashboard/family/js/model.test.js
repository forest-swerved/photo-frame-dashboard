import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDayIsKnown, completionBody, eventsOn, mergeCompletion, reconcileHousehold } from './model.js';

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
