import { frameCodeScopes } from './workbench.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routinePayload, mergeOccurrence, scheduledItems, schoolDayFilterLabel, schoolDayStatus, taskSections, taskProgress, taskAppliesToSchoolDay } from './occurrences.js';
import { request, setFrameMode, setFrameAccess, frameAccessStatus } from './api.js';

test('routine edits preserve existing step identities and distinguish optional one-off work', () => {
  const old = { version: 4, subtasks: [{ id: 'existing-step', title: 'Put away dishes' }] };
  const form = new FormData();
  for (const [name, value] of Object.entries({ title: 'Kitchen', personId: 'child', scheduleType: 'one_off', scheduledDate: '2026-11-01', instructions: 'Use the top cupboard.', subtasks: 'Put away dishes\nWipe the counter', dueTime: '18:00', reminderMinutes: '30', requiresApproval: 'on' })) form.set(name, value);
  const body = routinePayload(form, old);
  assert.equal(body.required, false); assert.equal(body.requiresApproval, true);
  assert.equal(body.scheduleType, 'one_off'); assert.equal(body.scheduledDate, '2026-11-01');
  assert.equal(body.subtasks[0].id, 'existing-step'); assert.notEqual(body.subtasks[1].id, 'existing-step');
  assert.equal(body.expectedVersion, 4); assert.equal(body.instructions, 'Use the top cupboard.');
  form.set('scheduleType', 'weekly'); assert.throws(() => routinePayload(form), /repeat day/);
});

test('school-day filters stay separate from weekdays and one-off dates and preserve routine CAS', () => {
  const form = new FormData();
  for (const [key, value] of Object.entries({ title: 'Morning routine', scheduleType: 'weekly', schoolDayFilter: 'school_day', weekdays: '1', reminderMinutes: '15' })) form.set(key, value);
  const weekly = routinePayload(form, { version: 7 });
  assert.equal(weekly.schoolDayFilter, 'school_day');
  assert.deepEqual(weekly.weekdays, [1]);
  assert.equal(weekly.expectedVersion, 7);
  form.set('scheduleType', 'one_off'); form.set('scheduledDate', '2026-12-25'); form.set('schoolDayFilter', 'non_school_day');
  const oneOff = routinePayload(form);
  assert.equal(oneOff.schoolDayFilter, 'any');
  assert.equal(oneOff.scheduledDate, '2026-12-25');
  assert.equal(oneOff.scheduleType, 'one_off');
  form.delete('schoolDayFilter');
  assert.equal(routinePayload(form).schoolDayFilter, 'any');
  form.set('scheduleType', 'weekly');
  assert.equal(routinePayload(form, { version: 8, schoolDayFilter: 'school_day' }).schoolDayFilter, 'school_day');
  form.set('schoolDayFilter', 'school_days_maybe');
  assert.throws(() => routinePayload(form), /valid school-day schedule/);
});

test('school calendar presentation distinguishes closure, unknown coverage, and chore breaks', () => {
  assert.equal(schoolDayFilterLabel('school_day'), 'School days only');
  assert.equal(schoolDayFilterLabel('non_school_day'), 'Non-school days only');
  assert.equal(schoolDayFilterLabel(undefined), 'Any school-day type');
  const closed = schoolDayStatus({ schoolDay: { date: '2026-10-21', type: 'non_school_day', label: 'No school', reason: '<Snow day>' } });
  assert.match(closed, /No school/); assert.match(closed, /&lt;Snow day&gt;/);
  const unknown = schoolDayStatus({ schoolDay: { date: '2027-09-01', type: 'unknown' }, routines: [{ schoolDayFilter: 'school_day' }] });
  assert.match(unknown, /School schedule unknown/);
  assert.match(unknown, /waiting for a confirmed school calendar date/);
  assert.match(unknown, /Any-day tasks still apply/);
  assert.equal(schoolDayStatus({}), '');
});

test('school-day task phases retain explicit parent choices and normalize non-school and one-off work', () => {
  const form = new FormData();
  for (const [key, value] of Object.entries({ title: 'Pack bag', scheduleType: 'weekly', schoolDayFilter: 'school_day', taskSection: 'before_school', weekdays: '1', reminderMinutes: '15' })) form.set(key, value);
  assert.equal(routinePayload(form).taskSection, 'before_school');
  form.set('taskSection', 'after_school'); assert.equal(routinePayload(form).taskSection, 'after_school');
  form.delete('taskSection');
  assert.equal(routinePayload(form, { version: 4, taskSection: 'after_school' }).taskSection, 'after_school');
  assert.equal(routinePayload(form).taskSection, 'tasks', 'Old clients do not invent a before/after assignment.');
  form.set('taskSection', 'before_school'); form.set('schoolDayFilter', 'non_school_day');
  assert.equal(routinePayload(form).taskSection, 'tasks');
  form.set('schoolDayFilter', 'school_day'); form.set('scheduleType', 'one_off'); form.set('scheduledDate', '2026-10-22');
  assert.equal(routinePayload(form).taskSection, 'tasks');
  form.set('scheduleType', 'weekly'); form.set('taskSection', 'during_school');
  assert.throws(() => routinePayload(form), /valid task section/);
});

test('only school days split populated before/after groups, and previous schedule history does not inflate progress', () => {
  const base = { date: '2026-10-21', originalDate: '2026-10-21', definitionSource: 'routine', schoolDayFilter: 'school_day' };
  const items = [
    { ...base, id: 'after', taskSection: 'after_school', status: 'pending' },
    { ...base, id: 'before', taskSection: 'before_school', status: 'completed' },
    { ...base, id: 'unassigned-phase', status: 'submitted' },
  ];
  assert.deepEqual(taskSections(items, { type: 'school_day' }).map(group => [group.label, group.items.map(item => item.id)]), [
    ['Before school', ['before']], ['After school', ['after']], ['Tasks', ['unassigned-phase']],
  ]);
  assert.deepEqual(taskSections(items, { type: 'non_school_day' }).map(group => group.label), ['Tasks']);
  assert.deepEqual(taskSections([], { type: 'school_day' }), []);
  assert.deepEqual(taskProgress(items, { type: 'school_day' }), { total: 3, completed: 1, remaining: 2 });
  assert.deepEqual(taskProgress(items, { type: 'non_school_day' }), { total: 0, completed: 0, remaining: 0 });
  const moved = { ...items[0], schoolScheduleExempt: true };
  assert.equal(taskAppliesToSchoolDay(moved, { type: 'non_school_day' }), true);
  assert.equal(taskAppliesToSchoolDay({ ...items[0], date: '2026-10-22' }, { type: 'non_school_day' }), true);
  assert.deepEqual(taskProgress([{ ...items[0], status: 'skipped' }, moved], { type: 'non_school_day' }), { total: 1, completed: 0, remaining: 1 });
});

test('occurrence acknowledgments cannot roll back a newer state or cross household dates', () => {
  const current = { date: '2026-10-17', occurrences: [{ id: 'a', date: '2026-10-17', status: 'completed', version: 5 }] };
  assert.equal(mergeOccurrence(current, { id: 'a', date: '2026-10-18', version: 6 }), current);
  assert.equal(mergeOccurrence(current, { id: 'a', date: '2026-10-17', status: 'submitted', version: 4 }).occurrences[0].status, 'completed');
  assert.equal(mergeOccurrence(current, { id: 'a', date: '2026-10-17', status: 'pending', version: 6 }).occurrences[0].status, 'pending');
});

test('pending approval and excused work stay distinct from confirmed completion', () => {
  const snapshot = { date: '2026-10-17', occurrences: [
    { id: 'excused', status: 'skipped' }, { id: 'done', status: 'completed' },
    { id: 'approval', status: 'submitted', requiresApproval: true }, { id: 'todo', status: 'pending' },
  ] };
  assert.deepEqual(scheduledItems(snapshot, 'America/Denver', new Date('2026-10-17T18:00:00Z')).map(item => item.id), ['todo', 'approval', 'done', 'excused']);
  assert.equal(scheduledItems({ chores: [] }, 'America/Denver'), null);
});

test('scoped frame credentials use only the private header and are removed at expiry and mode changes', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => { calls.push({ path, options }); return Response.json({ data: { ok: true } }); });
  setFrameMode(true);
  setFrameAccess({ token: 'fixture-private-approval', scope: 'parent', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await request('/api/household');
  assert.equal(calls[0].options.headers['X-Family-Authorization'], 'fixture-private-approval');
  assert.equal(calls[0].path.includes('fixture-private'), false);
  assert.equal(Object.hasOwn(frameAccessStatus(), 'token'), false);
  setFrameAccess({ token: 'expired-fixture', scope: 'parent', expiresAt: new Date(Date.now() - 1).toISOString() });
  await request('/api/household');
  assert.equal(calls[1].options.headers['X-Family-Authorization'], undefined);
  setFrameAccess({ token: 'fixture-private-approval', scope: 'parent', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  setFrameMode(false); setFrameMode(true);
  await request('/api/household');
  assert.equal(calls[2].options.headers['X-Family-Authorization'], undefined);
  setFrameMode(false);
});


test('frame unlock choices match caregiver capabilities and a child can only unlock their own scope', () => {
  assert.deepEqual(frameCodeScopes({ authType: 'user', role: 'member' }), []);
  assert.deepEqual(frameCodeScopes({ authType: 'user', role: 'member' }, { manageChores: true }), ['parent']);
  assert.deepEqual(frameCodeScopes({ authType: 'user', role: 'member' }, { manageInternet: true }), ['parent', 'child']);
  assert.deepEqual(frameCodeScopes({ authType: 'user', role: 'child', personId: 'child-a' }, { manageInternet: true }), ['child']);
  assert.deepEqual(frameCodeScopes({ authType: 'frame', role: 'caregiver' }, { manageInternet: true }), []);
});


test('moving the local wall clock backward cannot extend a frame unlock', t => {
  let wall = Date.parse('2026-10-17T18:00:00Z'), elapsed = 0;
  t.mock.method(Date, 'now', () => wall);
  t.mock.method(performance, 'now', () => elapsed);
  setFrameMode(true);
  setFrameAccess({ token: 'fixture-private-approval', scope: 'parent', expiresAt: new Date(wall + 60000).toISOString() });
  wall -= 3600000; elapsed = 60001;
  assert.equal(frameAccessStatus(), null);
  setFrameMode(false);
});
