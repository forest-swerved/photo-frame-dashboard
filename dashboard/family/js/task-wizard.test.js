import test from 'node:test';
import assert from 'node:assert/strict';
import { taskCreationPayload, taskScheduleDraft, taskScheduleSummary } from './task-wizard.js';

function fields() {
  const form = new FormData();
  for (const [key, value] of Object.entries({ title: 'Read 30 minutes', scheduleType: 'weekly', schoolDayFilter: 'any', taskSection: 'after_school', scheduledDate: '2026-10-30', reminderMinutes: '15' })) form.set(key, value);
  form.append('personIds', 'child-a'); form.append('personIds', 'child-b'); form.append('weekdays', '5'); form.set('required', 'on'); return form;
}
test('task creation keeps both assignments, repeat days and daily school-day placement', () => {
  const draft = taskCreationPayload(fields(), 'stable-operation');
  assert.deepEqual(draft.personIds, ['child-a','child-b']); assert.deepEqual(draft.weekdays, [5]); assert.equal(draft.mutationId, 'stable-operation');
  assert.equal(draft.taskSection, 'after_school'); assert.match(taskScheduleSummary(draft), /Fri.*Tasks on days off/);
});
test('switching to one time normalizes the payload without destroying the repeating draft', () => {
  const form = fields(); form.set('scheduleType', 'one_off');
  const one = taskCreationPayload(form, 'stable-operation'); assert.equal(one.taskSection, 'tasks'); assert.equal(one.schoolDayFilter, 'any'); assert.equal(one.scheduledDate, '2026-10-30');
  form.set('scheduleType', 'weekly'); const recurring = taskCreationPayload(form, 'stable-operation'); assert.equal(recurring.taskSection, 'after_school'); assert.deepEqual(recurring.weekdays, [5]);
  form.delete('personIds'); assert.throws(() => taskCreationPayload(form, 'id'), /Choose at least one child/);
});
test('schedule review ignores hidden detail errors and normalizes days-off placement', () => {
  const form = fields(); form.set('subtasks', Array.from({ length: 21 }, () => 'Too many').join('\n'));
  assert.throws(() => taskCreationPayload(form, 'id'), /at most 20/);
  assert.equal(taskScheduleDraft(form).taskSection, 'after_school');
  form.set('schoolDayFilter', 'non_school_day'); assert.equal(taskScheduleDraft(form).taskSection, 'tasks');
  assert.match(taskScheduleSummary(taskScheduleDraft(form)), /Non-school days only · Any time/);
});
