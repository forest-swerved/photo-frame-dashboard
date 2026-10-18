import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { occurrenceDto, requireChoreWriteDate, routineDetails } from './chore-occurrences.js';

test('routine fields support weekly and one-off work with bounded instructions and stable step IDs', () => {
  const value = routineDetails({ required: false, instructions: '  First clean the bowl. ', subtasks: ['Clean bowl', 'Fill bowl'], scheduleType: 'one_off', scheduledDate: '2026-10-19', requiresApproval: true });
  assert.equal(value.required, false); assert.equal(value.requiresApproval, true);
  assert.equal(value.instructions, 'First clean the bowl.'); assert.equal(value.scheduleType, 'one_off');
  assert.notEqual(value.subtasks[0].id, value.subtasks[1].id);
  const unchanged = routineDetails({}, { ...value, requires_approval: value.requiresApproval, schedule_type: value.scheduleType, scheduled_date: value.scheduledDate });
  assert.deepEqual(unchanged.subtasks, value.subtasks);
  assert.equal(routineDetails({ scheduleType: 'weekly' }, { schedule_type: 'one_off', scheduled_date: '2026-10-19' }).scheduledDate, null);
});

test('invalid routine requirements, dates and step data fail before any write', () => {
  for (const body of [{ required: null }, { requiresApproval: 'yes' }, { instructions: 'x'.repeat(3001) },
    { subtasks: Array.from({ length: 21 }, () => 'Step') }, { subtasks: [''] }, { subtasks: [{ id: 'invalid', title: 'Step' }] },
    { scheduleType: 'one_off', scheduledDate: '2026-02-30' }, { scheduleType: 'weekly', scheduledDate: '2026-10-17' }]) {
    assert.throws(() => routineDetails(body), error => error.status === 422);
  }
  const id = randomUUID();
  assert.throws(() => routineDetails({ subtasks: [{ id, title: 'A' }, { id, title: 'B' }] }), error => error.status === 422);
});

test('completion dates follow the household timezone and other days need an administrator reason', () => {
  const now = new Date('2026-10-18T01:00:00Z');
  const child = { authType: 'mobile', role: 'child', household: { timezone: 'America/Denver' } };
  assert.equal(requireChoreWriteDate(child, '2026-10-17', undefined, now), null);
  for (const date of ['2026-10-16', '2026-10-18']) assert.throws(() => requireChoreWriteDate(child, date, 'Pretend', now), error => error.status === 403);
  const parent = { ...child, role: 'admin' };
  assert.throws(() => requireChoreWriteDate(parent, '2026-10-16', undefined, now), error => error.status === 422);
  assert.equal(requireChoreWriteDate(parent, '2026-10-16', ' Missed yesterday ', now), 'Missed yesterday');
});

test('occurrence DTO keeps submitted approval distinct from earned completion and serializes replay identically', () => {
  const stepId = randomUUID();
  const row = { id: randomUUID(), chore_id: randomUUID(), date: '2026-10-17', original_date: '2026-10-16', title: 'Feed pets', required: true,
    subtask_definitions: [{ id: stepId, title: 'Clean bowl' }], completed_subtask_ids: [stepId], requires_approval: true,
    definition_source: 'routine', routine_version: 1, status: 'submitted', version: 2, completion_version: 1, updated_at: new Date('2026-10-17T12:00:00Z'), due_time: '12:30:00', reminder_minutes: 15 };
  const dto = occurrenceDto(row);
  assert.equal(dto.status, 'submitted'); assert.equal(dto.completion.completed, true);
  assert.equal(dto.approvedAt, null); assert.equal(dto.rescheduledFrom, '2026-10-16');
  assert.equal(dto.subtasks[0].completed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(dto)), dto);
});
