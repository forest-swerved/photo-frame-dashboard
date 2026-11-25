import test from 'node:test';
import assert from 'node:assert/strict';
import { alarmDueAt, alarmState } from './task-alarms.js';

const zone = 'America/Denver';
const row = extra => ({ alarm: true, due_time: '16:30:00', date: '2026-12-02', status: 'pending', alarm_snoozed_until: null, ...extra });

test('a task alarm rings from its household due time until the task leaves pending', () => {
  assert.equal(alarmDueAt(row(), zone).toISOString(), '2026-12-02T23:30:00.000Z');
  assert.equal(alarmDueAt(row({ alarm: false }), zone), null);
  assert.equal(alarmDueAt(row({ due_time: null }), zone), null);
  assert.equal(alarmState(row(), zone, new Date('2026-12-02T23:29:59Z')).ringing, false);
  assert.equal(alarmState(row(), zone, new Date('2026-12-02T23:30:00Z')).ringing, true);
  assert.equal(alarmState(row(), zone, new Date('2026-12-03T06:59:00Z')).ringing, true); // 11:59 PM, still unconfirmed.
  assert.equal(alarmState(row(), zone, new Date('2026-12-03T07:00:00Z')).ringing, false); // The household day ended.
  for (const status of ['submitted', 'completed', 'skipped']) assert.equal(alarmState(row({ status }), zone, new Date('2026-12-02T23:45:00Z')).active, false);
});

test('a snooze pauses the alarm and it resumes by itself', () => {
  const snoozed = row({ alarm_snoozed_until: new Date('2026-12-02T23:45:00Z') });
  const during = alarmState(snoozed, zone, new Date('2026-12-02T23:40:00Z'));
  assert.equal(during.active, true); assert.equal(during.ringing, false); assert.equal(during.snoozedUntil.toISOString(), '2026-12-02T23:45:00.000Z');
  assert.equal(alarmState(snoozed, zone, new Date('2026-12-02T23:45:00Z')).ringing, true);
});

test('a due time skipped by a clock change still rings', () => {
  // 2:30 AM does not exist on the spring-forward day; ring at 3:30 AM instead of never.
  assert.equal(alarmDueAt(row({ date: '2027-03-14', due_time: '02:30' }), zone).toISOString(), '2027-03-14T09:30:00.000Z');
});
