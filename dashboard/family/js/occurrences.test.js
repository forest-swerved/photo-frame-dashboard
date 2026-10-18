import { frameCodeScopes } from './workbench.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routinePayload, mergeOccurrence, scheduledItems } from './occurrences.js';
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
