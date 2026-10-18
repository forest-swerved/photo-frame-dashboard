import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspectPolicyInventory } from './internet-operator.js';
import { managedPolicyPlan } from './unifi.js';

const now = new Date('2026-10-18T02:00:00Z');
function fixture(apple = false) {
  const device = { id: randomUUID(), household_id: randomUUID(), name: 'Synthetic console', kind: apple ? 'tablet' : 'console', person_ids: [randomUUID()], mac_addresses: ['02:12:34:56:78:9a', '02:12:34:56:78:9b'], allow_apple_push: apple, timezone: 'America/Denver' };
  const config = { siteId: randomUUID(), sourceZoneId: randomUUID(), externalZoneId: randomUUID() };
  const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses, sourceZoneId: config.sourceZoneId, destinationZoneId: config.externalZoneId, allowApplePush: apple });
  const management = { ...plan.management, id: randomUUID() }, deny = { ...plan.deny, id: randomUUID() }, applePush = apple ? { ...plan.applePush, id: randomUUID() } : null;
  const foreign = { id: randomUUID(), enabled: true, name: 'Synthetic existing rule', source: { zoneId: config.sourceZoneId }, destination: { zoneId: config.externalZoneId }, action: { type: 'BLOCK' } };
  const policies = [management, ...(applePush ? [applePush] : []), deny, foreign];
  const input = { beforePolicyId: foreign.id, managementPolicyId: management.id, denyPolicyId: deny.id, ...(applePush ? { applePolicyId: applePush.id } : {}) };
  return { device, config, macs: device.mac_addresses, policies, orderedIds: policies.map(policy => policy.id), input, consoleId: `${'a'.repeat(64)}:12345`, applicationVersion: '10.6.106', now };
}
test('operator plan binds grouped fixed identities, exact exceptions, foreign content and placement', () => {
  const f = fixture(), plan = inspectPolicyInventory(f);
  assert.equal(plan.observations.managementVerified, true); assert.equal(plan.observations.permanentDenyVerified, true); assert.equal(plan.observations.placementVerified, true);
  assert.equal(plan.reviewedFingerprint.length, 64); assert.equal(plan.providerWrites, false);
  assert.deepEqual(plan.policies.management.source.trafficFilter.macAddressFilter.macAddresses, f.device.mac_addresses);
  assert.throws(() => inspectPolicyInventory({ ...f, input: { ...f.input, beforePolicyId: 'none' } }), error => error.code === 'policy_anchor_required');
  const moved = inspectPolicyInventory({ ...f, orderedIds: [f.orderedIds[2], ...f.orderedIds.slice(0, 2)] });
  assert.equal(moved.observations.placementVerified, false); assert.equal(moved.reviewedFingerprint, null);
  const changed = inspectPolicyInventory({ ...f, policies: f.policies.map((policy, i) => i === 2 ? { ...policy, action: { type: 'ALLOW' } } : policy) });
  assert.notEqual(changed.binding, plan.binding);
  assert.notEqual(inspectPolicyInventory({ ...f, applicationVersion: '10.6.107' }).binding, plan.binding);
});
test('Apple readiness requires a permanent exact notification transport and its own proof', () => {
  const f = fixture(true), plan = inspectPolicyInventory(f);
  assert.ok(plan.requiredChecks.includes('apple_push')); assert.equal(plan.observations.appleVerified, true);
  const broken = inspectPolicyInventory({ ...f, policies: f.policies.map(policy => policy.id === f.input.applePolicyId ? { ...policy, enabled: false } : policy) });
  assert.equal(broken.observations.appleVerified, false); assert.equal(broken.reviewedFingerprint, null);
});
test('preflight bindings survive adding only the planned bounded pilot and changing it to permanent deny', () => {
  const f = fixture(), denyId = f.input.denyPolicyId;
  const withoutDeny = inspectPolicyInventory({ ...f, input: { ...f.input, denyPolicyId: null }, policies: f.policies.filter(policy => policy.id !== denyId), orderedIds: f.orderedIds.filter(id => id !== denyId) });
  const pilot = inspectPolicyInventory({ ...f, policies: f.policies.map(policy => policy.id === denyId ? { ...policy, schedule: { mode: 'ONE_TIME_ONLY', date: '2026-10-17', timeFilter: { startTime: '20:00', stopTime: '20:05' } } } : policy) });
  const permanent = inspectPolicyInventory(f);
  assert.equal(pilot.observations.pilotDenyVerified, true); assert.equal(pilot.observations.permanentDenyVerified, false); assert.equal(pilot.reviewedFingerprint, null);
  assert.equal(withoutDeny.managementBinding, pilot.managementBinding); assert.equal(pilot.managementBinding, permanent.managementBinding);
  assert.equal(pilot.binding, permanent.binding);
  assert.notEqual(withoutDeny.binding, permanent.binding);
  const broad = inspectPolicyInventory({ ...f, policies: f.policies.map(policy => policy.id === denyId ? { ...policy, schedule: { mode: 'ONE_TIME_ONLY', date: '2026-10-17', timeFilter: { startTime: '20:00', stopTime: '22:00' } } } : policy) });
  assert.equal(broad.observations.pilotDenyVerified, false);
});
test('a session-looking description cannot hide an untracked or altered allowance from operator review', () => {
  const f = fixture(), baseline = inspectPolicyInventory(f);
  const session = { ...f.policies[0], id: randomUUID(), description: `family-frame:${f.device.id}:session:${randomUUID()}` };
  const changed = { ...f, policies: [...f.policies, session], orderedIds: [...f.orderedIds.slice(0, 1), session.id, ...f.orderedIds.slice(1)] };
  assert.notEqual(inspectPolicyInventory(changed).binding, baseline.binding);
  assert.throws(() => inspectPolicyInventory({ ...changed, knownSessions: [{ policy_id: session.id, state: 'checking', observed_state: 'unknown' }] }), error => error.code === 'session_policy_unverified');
});
