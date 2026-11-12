import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceAccessState } from './internet-state.js';
const now = new Date('2026-11-12T14:00:00Z');
const device = { id: 'device', desired_access: 'blocked', observed_access: 'blocked', access_verified_at: now };
test('device status distinguishes a requested cutoff from a still-confirmed timed allowance', () => {
  const session = { id: 'session', device_id: device.id, state: 'ending', desired_state: 'blocked', observed_state: 'allowed', ends_at: new Date(+now + 60000), verified_at: now };
  const status = deviceAccessState(device, [session], [{ session_id: 'session', state: 'pending' }], now);
  assert.equal(status.desiredMode, 'off'); assert.equal(status.confirmedMode, 'timed'); assert.equal(status.phase, 'pending');
  assert.equal(deviceAccessState(device, [], [], now).phase, 'confirmed');
});
test('stale, failed, expired and attention states never claim confirmed timed access', () => {
  assert.equal(deviceAccessState(device, [], [], new Date(+now + 180001)).phase, 'stale');
  assert.equal(deviceAccessState({ ...device, access_error: 'device_policy_conflict' }, [], [], now).confirmedMode, 'unknown');
  const session = { id: 'session', device_id: device.id, state: 'active', desired_state: 'allowed', observed_state: 'allowed', ends_at: now, verified_at: now };
  assert.equal(deviceAccessState(device, [session], [], now).confirmedMode, 'unknown');
  const status = deviceAccessState(device, [], [{ device_id: device.id, state: 'attention', last_error: 'unifi_unavailable' }], now);
  assert.equal(status.phase, 'attention'); assert.equal(status.retryable, true);
  assert.equal(deviceAccessState(device, [], [{ device_id: 'other', state: 'attention' }], now).phase, 'confirmed');
});
