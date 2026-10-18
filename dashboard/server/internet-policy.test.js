import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { managedPolicyPlan, policyContentFingerprint, reviewedPolicyFingerprint } from './unifi.js';
import { scheduledSessionPolicy, sessionOrdering } from './internet-worker.js';

const device = { id: randomUUID(), mac_addresses: ['02:12:34:56:78:9a'] };
const integration = { source_zone_id: randomUUID(), external_zone_id: randomUUID(), pilot_checks: { midnight: true, dst: true } };
const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses, sourceZoneId: integration.source_zone_id, destinationZoneId: integration.external_zone_id });
const management = { ...plan.management, id: randomUUID() }, deny = { ...plan.deny, id: randomUUID() };
const foreign = { id: randomUUID(), enabled: true, action: { type: 'BLOCK' }, source: { zoneId: integration.source_zone_id }, destination: { zoneId: integration.external_zone_id }, name: 'Existing security rule' };
const policies = [foreign, management, deny], order = policies.map(policy => policy.id);
const options = { managementId: management.id, denyId: deny.id };

test('reviewed firewall fingerprint binds foreign rule content and order plus permanent management precedence', () => {
  const baseline = reviewedPolicyFingerprint(policies, order, options);
  const shuffledKeys = policies.map(policy => Object.fromEntries(Object.entries(policy).reverse()));
  assert.equal(reviewedPolicyFingerprint(shuffledKeys, order, options), baseline);
  assert.equal(reviewedPolicyFingerprint(policies.map(policy => ({ ...policy, index: 99, updatedAt: 'controller-metadata' })), order, options), baseline);
  assert.notEqual(reviewedPolicyFingerprint([{ ...foreign, action: { type: 'ALLOW' } }, management, deny], order, options), baseline);
  assert.notEqual(reviewedPolicyFingerprint(policies, [management.id, foreign.id, deny.id], options), baseline);
  assert.throws(() => reviewedPolicyFingerprint(policies, [foreign.id, deny.id, management.id], options), error => error.code === 'management_policy_changed');
});

test('untracked session-looking rules change the baseline; verified explicit session IDs preserve it', () => {
  const baseline = reviewedPolicyFingerprint(policies, order, options);
  const sessionPolicy = { ...plan.deny, id: randomUUID(), description: `family-frame:${device.id}:session:${randomUUID()}`, action: { type: 'ALLOW' } };
  const currentOrder = sessionOrdering(order, management.id, deny.id, sessionPolicy.id);
  const currentPolicies = [...policies, sessionPolicy];
  assert.notEqual(reviewedPolicyFingerprint(currentPolicies, currentOrder, options), baseline, 'A description alone cannot grant a fingerprint exemption.');
  assert.equal(reviewedPolicyFingerprint(currentPolicies, currentOrder, { ...options, ignoredSessionIds: [sessionPolicy.id] }), baseline);
  assert.throws(() => reviewedPolicyFingerprint(currentPolicies, currentOrder, { ...options, ignoredSessionIds: [management.id] }), error => error.code === 'policy_review_required');
  assert.throws(() => reviewedPolicyFingerprint([...currentPolicies, sessionPolicy], currentOrder, options), error => error.code === 'policy_review_required');
});

test('session policy fingerprint matches planned mutable content without trusting metadata or enable changes', () => {
  const disabled = { ...plan.deny, enabled: false, description: `family-frame:${device.id}:session:${randomUUID()}` };
  const fingerprint = policyContentFingerprint(disabled);
  assert.equal(policyContentFingerprint({ ...disabled, id: randomUUID(), predefined: false, updatedAt: 'metadata', index: 4 }), fingerprint);
  assert.notEqual(policyContentFingerprint({ ...disabled, enabled: true }), fingerprint);
  assert.notEqual(policyContentFingerprint({ ...disabled, destination: { zoneId: randomUUID() } }), fingerprint);
});

test('timed policy schedule start is stable across retries and preserves foreign security rule positions', () => {
  const session = { id: randomUUID(), ends_at: '2026-10-18T03:00:00Z', all_day: false };
  const startAt = new Date('2026-10-18T02:00:00Z');
  const first = scheduledSessionPolicy(session, device, integration, 'America/Denver', startAt, { startAt });
  const retry = scheduledSessionPolicy(session, device, integration, 'America/Denver', new Date('2026-10-18T02:05:00Z'), { startAt });
  assert.deepEqual(first, retry);
  assert.deepEqual(sessionOrdering(order, management.id, deny.id, session.id), [foreign.id, management.id, session.id, deny.id]);
});

test('all-day policy uses one concrete local date and handles a 25-hour DST day with verified tests', () => {
  const now = new Date('2026-11-01T06:00:00Z'); // Midnight before Denver's fall-back.
  const session = { id: randomUUID(), ends_at: '2026-11-02T07:00:00Z', all_day: true };
  const policy = scheduledSessionPolicy(session, device, integration, 'America/Denver', now);
  assert.deepEqual(policy.schedule, { mode: 'ONE_TIME_ONLY', date: '2026-11-01', timeFilter: null });
  assert.throws(() => scheduledSessionPolicy(session, device, { ...integration, pilot_checks: { midnight: true } }, 'America/Denver', now), error => error.code === 'schedule_unverified');
  assert.throws(() => scheduledSessionPolicy({ ...session, ends_at: '2026-11-02T06:00:00Z' }, device, integration, 'America/Denver', now), error => error.code === 'window_elapsed');
  assert.throws(() => scheduledSessionPolicy({ ...session, all_day: false }, device, integration, 'America/Denver', now), error => error.code === 'window_elapsed');
});

test('timed policies reject repeated local times and UTC offset changes even when the pilot passed', () => {
  const session = { id: randomUUID(), all_day: false };
  for (const [startAt, ends_at] of [
    ['2026-11-01T06:45:00Z', '2026-11-01T07:15:00Z'], // Stop is in the first repeated 01:15.
    ['2026-11-01T08:15:00Z', '2026-11-01T09:15:00Z'], // Start is in the second repeated 01:15.
    ['2026-11-01T06:30:00Z', '2026-11-01T09:30:00Z'], // Offset changes inside the window.
    ['2026-03-08T08:30:00Z', '2026-03-08T09:30:00Z'], // Spring-forward skips a wall-clock hour.
  ]) assert.throws(() => scheduledSessionPolicy({ ...session, ends_at }, device, integration, 'America/Denver', new Date(startAt)), error => error.code === 'dst_window_unrepresentable');
});
