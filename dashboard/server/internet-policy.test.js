import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { managedPolicyPlan, policyContentFingerprint, reviewedPolicyFingerprint, policyInventoryFingerprint } from './unifi.js';
import { sameManagedPolicy, scheduledSessionPolicy, sessionOrdering } from './internet-worker.js';

const buckets = (beforeSystemDefined = [], afterSystemDefined = []) => ({ beforeSystemDefined, afterSystemDefined });
const device = { id: randomUUID(), mac_addresses: ['02:12:34:56:78:9a'] };
const integration = { source_zone_id: randomUUID(), external_zone_id: randomUUID(), pilot_checks: { midnight: true, dst: true } };
const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses, sourceZoneId: integration.source_zone_id, destinationZoneId: integration.external_zone_id });
const management = { ...plan.management, id: randomUUID() }, deny = { ...plan.deny, id: randomUUID() };
const foreign = { id: randomUUID(), enabled: true, action: { type: 'BLOCK' }, source: { zoneId: integration.source_zone_id }, destination: { zoneId: integration.external_zone_id }, name: 'Existing security rule' };
for (const policy of [foreign, management, deny]) policy.metadata = { origin: 'USER_DEFINED' };
const policies = [foreign, management, deny], order = buckets(policies.map(policy => policy.id));
const options = { managementId: management.id, denyId: deny.id };

test('reviewed firewall fingerprint binds foreign rule content and order plus permanent management precedence', () => {
  const baseline = reviewedPolicyFingerprint(policies, order, options);
  const shuffledKeys = policies.map(policy => Object.fromEntries(Object.entries(policy).reverse()));
  assert.equal(reviewedPolicyFingerprint(shuffledKeys, order, options), baseline);
  assert.equal(reviewedPolicyFingerprint(policies.map(policy => ({ ...policy, index: 99, updatedAt: 'controller-metadata' })), order, options), baseline);
  assert.notEqual(reviewedPolicyFingerprint([{ ...foreign, action: { type: 'ALLOW' } }, management, deny], order, options), baseline);
  assert.notEqual(reviewedPolicyFingerprint(policies, buckets([management.id, foreign.id, deny.id]), options), baseline);
  assert.throws(() => reviewedPolicyFingerprint(policies, buckets([foreign.id, deny.id, management.id]), options), error => error.code === 'management_policy_changed');
});

test('review binds both sides of the system boundary and implicit security policies', () => {
  const after = { ...foreign, id: randomUUID(), name: 'Foreign rule after system defaults' };
  const system = { ...foreign, id: randomUUID(), name: 'Block invalid', index: 30000, connectionStateFilter: ['INVALID'], metadata: { origin: 'SYSTEM_DEFINED' } };
  const all = [...policies, after, system], both = buckets(order.beforeSystemDefined, [after.id]);
  const baseline = reviewedPolicyFingerprint(all, both, options);
  assert.notEqual(reviewedPolicyFingerprint(all, buckets([...order.beforeSystemDefined, after.id]), options), baseline);
  assert.notEqual(reviewedPolicyFingerprint(all.map(p => p.id === system.id ? { ...p, index: 30001 } : p), both, options), baseline);
  assert.notEqual(reviewedPolicyFingerprint(all.map(p => p.id === system.id ? { ...p, action: { type: 'ALLOW' } } : p), both, options), baseline);
  assert.throws(() => reviewedPolicyFingerprint(all, buckets(order.beforeSystemDefined), options), error => error.code === 'policy_review_required');
  assert.throws(() => reviewedPolicyFingerprint(all, buckets([...order.beforeSystemDefined, system.id], [after.id]), options), error => error.code === 'policy_review_required');
  assert.throws(() => reviewedPolicyFingerprint(all, buckets([foreign.id, management.id], [deny.id, after.id]), options), error => error.code === 'management_policy_changed');
  assert.throws(() => reviewedPolicyFingerprint(all.map(p => p.id === after.id ? { ...p, destination: { zoneId: randomUUID() } } : p), both, options), error => error.code === 'policy_review_required');
  assert.throws(() => policyInventoryFingerprint(all, both, { ignoredPolicyIds: [system.id] }), error => error.code === 'policy_review_required');
});

test('a session moves only its own disabled rule across the boundary, preserving foreign after rules', () => {
  const own = randomUUID(), afterA = randomUUID(), afterB = randomUUID();
  const both = buckets(order.beforeSystemDefined, [afterA, own, afterB]);
  assert.deepEqual(sessionOrdering(both, management.id, deny.id, own), buckets([foreign.id, management.id, own, deny.id], [afterA, afterB]));
});

test('untracked session-looking rules change the baseline; verified explicit session IDs preserve it', () => {
  const baseline = reviewedPolicyFingerprint(policies, order, options);
  const sessionPolicy = { ...plan.deny, id: randomUUID(), description: `family-frame:${device.id}:session:${randomUUID()}`, metadata: { origin: 'USER_DEFINED' }, action: { type: 'ALLOW' } };
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

test('controller-sorted connection-state sets compare equally without accepting invalid or omitted states', () => {
  const actual = { ...management, connectionStateFilter: ['ESTABLISHED', 'NEW', 'RELATED'] };
  assert.equal(policyContentFingerprint(actual), policyContentFingerprint(management));
  assert.equal(sameManagedPolicy(actual, management), true);
  for (const states of [null, ['NEW'], ['ESTABLISHED', 'NEW', 'RELATED', 'INVALID'], ['NEW', 'NEW', 'RELATED']]) {
    assert.notEqual(policyContentFingerprint({ ...actual, connectionStateFilter: states }), policyContentFingerprint(management));
    assert.equal(sameManagedPolicy({ ...actual, connectionStateFilter: states }, management), false);
  }
});

test('controller-reordered match sets retain every IP range, port, domain and MAC constraint', () => {
  const expected = managedPolicyPlan({ deviceId: device.id, macAddresses: [...device.mac_addresses, '02:12:34:56:78:9b'],
    sourceZoneId: integration.source_zone_id, destinationZoneId: integration.external_zone_id, allowApplePush: true }).applePush;
  const actual = { ...structuredClone(expected), metadata: { origin: 'USER_DEFINED' } };
  actual.source.trafficFilter.macAddressFilter.macAddresses.reverse();
  actual.destination.trafficFilter.ipAddressFilter.items.reverse();
  actual.destination.trafficFilter.portFilter.items.reverse();
  assert.equal(policyContentFingerprint(actual), policyContentFingerprint(expected));
  assert.equal(sameManagedPolicy(actual, expected), true);
  for (const mutate of [
    p => p.destination.trafficFilter.ipAddressFilter.items.push({ type: 'SUBNET', value: '17.0.0.0/8' }),
    p => p.destination.trafficFilter.ipAddressFilter.items.pop(),
    p => p.destination.trafficFilter.ipAddressFilter.items.push(p.destination.trafficFilter.ipAddressFilter.items[0]),
    p => p.destination.trafficFilter.portFilter.items.push({ type: 'PORT_NUMBER', value: 80 }),
    p => { p.destination.trafficFilter.ipAddressFilter.matchOpposite = true; },
    p => p.source.trafficFilter.macAddressFilter.macAddresses.pop(),
  ]) {
    const changed = structuredClone(actual); mutate(changed);
    assert.notEqual(policyContentFingerprint(changed), policyContentFingerprint(expected));
    assert.equal(sameManagedPolicy(changed, expected), false);
  }
  const domains = structuredClone(management); domains.destination.trafficFilter.domainFilter.domains.push('family.example.com');
  const reordered = structuredClone(domains); reordered.destination.trafficFilter.domainFilter.domains.reverse();
  assert.equal(policyContentFingerprint(domains), policyContentFingerprint(reordered));
  assert.notEqual(policyContentFingerprint(domains), policyContentFingerprint(management));
});

test('timed policy schedule start is stable across retries and preserves foreign security rule positions', () => {
  const session = { id: randomUUID(), ends_at: '2026-10-18T03:00:00Z', all_day: false };
  const startAt = new Date('2026-10-18T02:00:00Z');
  const first = scheduledSessionPolicy(session, device, integration, 'America/Denver', startAt, { startAt });
  const retry = scheduledSessionPolicy(session, device, integration, 'America/Denver', new Date('2026-10-18T02:05:00Z'), { startAt });
  assert.deepEqual(first, retry);
  assert.deepEqual(first.connectionStateFilter, ['NEW', 'ESTABLISHED', 'RELATED']);
  assert.deepEqual(sessionOrdering(order, management.id, deny.id, session.id), buckets([foreign.id, management.id, session.id, deny.id]));
});

test('all-day policy uses one concrete local date and handles a 25-hour DST day with verified tests', () => {
  const now = new Date('2026-11-01T06:00:00Z'); // Midnight before Denver's fall-back.
  const session = { id: randomUUID(), ends_at: '2026-11-02T07:00:00Z', all_day: true };
  const policy = scheduledSessionPolicy(session, device, integration, 'America/Denver', now);
  assert.deepEqual(policy.schedule, { mode: 'ONE_TIME_ONLY', date: '2026-11-01', timeFilter: null });
  assert.deepEqual(policy.connectionStateFilter, ['NEW', 'ESTABLISHED', 'RELATED']);
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
