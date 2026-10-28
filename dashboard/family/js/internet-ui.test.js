import test from 'node:test';
import assert from 'node:assert/strict';
import { canRedeem, rewardDevices, liveSession, remainingTime, remainingLabel, earnedToday } from './internet-ui.js';
const now = Date.parse('2026-11-01T06:30:00Z');
test('earned announcements require this household day and all approved required tasks; saved rewards remain redeemable', () => {
  const credit = { id:'credit', personId:'child-a', status:'available', earnedDate:'2026-10-31', expiresAt:'2026-11-08T07:00:00Z' };
  const progress = { personId:'child-a', date:'2026-10-31', eligible:true, requiredCount:9, completedCount:9, pendingApprovalCount:0, remainingCount:0 };
  const data = {serverTime:new Date(now-3_600_000).toISOString(),timezone:'America/Denver',progress:[progress]};
  assert.equal(earnedToday(data,credit),true,'The household day, not UTC date, controls the announcement.');
  for(const patch of [{completedCount:1,remainingCount:8,eligible:false},{eligible:false},{requiredCount:0,completedCount:0},{pendingApprovalCount:1},{date:'2026-11-01'}]) {
    assert.equal(earnedToday({...data,progress:[{...progress,...patch}]},credit),false);
  }
  assert.equal(earnedToday({...data,progress:[]},credit),false);
  assert.equal(earnedToday(data,{...credit,earnedDate:'2026-10-30'}),false);
  assert.equal(earnedToday(data,{...credit,expiresAt:data.serverTime}),false);
  assert.equal(canRedeem({role:'child'},credit,{personId:'child-a',authType:'user'}),true,'Carried-over time is still available to use.');
});
test('session timer respects confirmed paused time and fixed all-day deadline', () => {
  const session = { state: 'active', endsAt: '2026-11-01T06:31:01Z', remainingSeconds: 600 };
  assert.equal(remainingTime(session, now), 61);
  assert.equal(remainingTime({ ...session, state: 'paused' }, now), 600);
  assert.equal(remainingTime({ ...session, state: 'paused', allDay: true }, now), 61);
  assert.equal(remainingTime({ ...session, state: 'paused', allDay: true }, now + 62_000), 0);
  assert.equal(remainingLabel(0), '0:00 · checking cutoff');
  assert.equal(remainingLabel(61), '1:01');
  assert.equal(liveSession({ state: 'checking' }), true);
  assert.equal(liveSession({ state: 'ended' }), false);
});
test('unknown session deadline is not invented and terminal state has no timer', () => {
  assert.equal(remainingTime({ state: 'starting', endsAt: null }, now), null);
  assert.equal(remainingTime({ state: 'starting', endsAt: null, remainingSeconds: 3600 }, now), 3600);
  assert.equal(remainingTime({ state: 'resuming', endsAt: null, remainingSeconds: 1800 }, now + 60000), 1800);
  assert.equal(remainingLabel(null), 'Checking time');
  assert.equal(remainingTime({ state: 'ended', endsAt: '2026-11-01T06:31:01Z' }, now), null);
});
test('reward spending requires the matching child identity and child-scoped frame unlock', () => {
  const credit = { personId: 'child-a', status: 'available' }, child = { role: 'child' };
  assert.equal(canRedeem(child, credit, { personId: 'child-a', authType: 'user' }), true);
  assert.equal(canRedeem({ role: 'admin' }, credit, { personId: 'child-a', authType: 'user' }), false);
  assert.equal(canRedeem(child, credit, { personId: 'child-b', authType: 'user' }), false);
  assert.equal(canRedeem(child, credit, { personId: 'child-a', authType: 'frame' }), false);
  assert.equal(canRedeem(child, credit, { personId: 'child-a', authType: 'frame' }, { scope: 'parent', personId: 'child-a' }), false);
  assert.equal(canRedeem(child, credit, { personId: 'child-a', authType: 'frame' }, { scope: 'child', personId: 'child-a' }), true);
  assert.equal(canRedeem(child, { ...credit, status: 'review' }, { personId: 'child-a', authType: 'user' }), false);
});

test('earned picker contains only currently blocked pool devices, including newly added ones', () => {
  const device = { id: 'console', personIds: ['andre', 'stevie'], defaultAccess: 'blocked', rewardAvailable: true, controlState: 'ready', accessPending: false };
  const data = { integration: { state: 'ready' }, sessions: [], devices: [device, { ...device, id: 'new-ipad' }, { ...device, id: 'free-tv', defaultAccess: 'allowed' }, { ...device, id: 'busy', rewardAvailable: false }, { ...device, id: 'checking', accessPending: true }, { ...device, id: 'unverified', controlState: 'unenrolled' }] };
  for (const person of ['andre', 'stevie']) assert.deepEqual(rewardDevices(data, person).map(d => d.id), ['console', 'new-ipad']);
  assert.deepEqual(rewardDevices({ ...data, sessions: [{ personId: 'andre', deviceId: 'other', state: 'starting' }] }, 'andre'), []);
  assert.deepEqual(rewardDevices({ ...data, integration: { state: 'attention' } }, 'andre'), []);
});
