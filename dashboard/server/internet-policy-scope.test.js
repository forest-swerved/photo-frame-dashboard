import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { managedPolicyPlan, policyContentFingerprint } from './unifi.js';
import { inspectDevicePolicyScope, mayMatchDevice } from './internet-policy-scope.js';
function fixture() {
  const device = { id: randomUUID(), mac_addresses: ['02:12:34:56:78:9a'], management_policy_id: randomUUID(), deny_policy_id: randomUUID() };
  const integration = { source_zone_id: randomUUID(), external_zone_id: randomUUID() };
  const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses, sourceZoneId: integration.source_zone_id, destinationZoneId: integration.external_zone_id });
  const management = { ...plan.management, id: device.management_policy_id, metadata: { origin: 'USER_DEFINED' } }, deny = { ...plan.deny, id: device.deny_policy_id, metadata: { origin: 'USER_DEFINED' } };
  return { device, integration, policies: [management, deny], orderedIds: { beforeSystemDefined: [management.id, deny.id], afterSystemDefined: [] }, denyEnabled: true };
}
test('unrelated rules, names, counters and system metadata do not invalidate a device', () => {
  const f = fixture(), other = { ...structuredClone(f.policies[1]), id: randomUUID(), source: { zoneId: f.integration.source_zone_id, trafficFilter: { type: 'MAC_ADDRESS', macAddressFilter: { macAddresses: ['02:00:00:00:00:02'] } } } };
  f.policies.push(other); f.orderedIds.beforeSystemDefined.unshift(other.id);
  inspectDevicePolicyScope(f);
  Object.assign(other, { enabled: false, name: 'Changed device', statistics: { packets: 100 }, action: { type: 'ALLOW' } });
  inspectDevicePolicyScope(f);
  f.policies.push({ id: randomUUID(), metadata: { origin: 'SYSTEM_DEFINED' }, index: 999, action: { type: 'ALLOW' } });
  inspectDevicePolicyScope(f);
});
test('broad, overlapping, inverted and unrecognized source filters require attention', () => {
  for (const filter of [undefined, { type: 'NETWORK' }, { type: 'MAC_ADDRESS', macAddressFilter: { macAddresses: ['02:12:34:56:78:9a'] } },
    { type: 'MAC_ADDRESS', macAddressFilter: { macAddresses: ['02:00:00:00:00:02'], matchOpposite: true } },
    { type: 'MAC_ADDRESS', macAddressFilter: { macAddresses: [] } }]) {
    const f = fixture(), foreign = { ...structuredClone(f.policies[0]), id: randomUUID(), source: { zoneId: f.integration.source_zone_id, trafficFilter: filter } };
    f.policies.push(foreign); f.orderedIds.beforeSystemDefined.unshift(foreign.id);
    assert.equal(mayMatchDevice(foreign, f.device), true);
    assert.throws(() => inspectDevicePolicyScope(f), e => e.code === 'device_policy_conflict');
    foreign.enabled = false; assert.doesNotThrow(() => inspectDevicePolicyScope(f));
  }
});
test('wrong identities, broad exceptions and moving a deny after system rules never confirm Off', () => {
  for (const mutate of [f => { f.policies[1].enabled = false; }, f => { f.policies[1].source = { zoneId: f.integration.source_zone_id }; },
    f => { f.policies[0].destination.trafficFilter.domainFilter.domains.push('example.com'); },
    f => { f.orderedIds.beforeSystemDefined.pop(); f.orderedIds.afterSystemDefined.push(f.device.deny_policy_id); }]) {
    const f = fixture(); mutate(f); assert.throws(() => inspectDevicePolicyScope(f));
  }
});
test('only exact registered timed rules are trusted; missing active or enabled terminal rules fail audit', () => {
  const f = fixture(), id = randomUUID(), policy = { ...structuredClone(f.policies[1]), id: randomUUID(), action: { type: 'ALLOW', allowReturnTraffic: false } };
  f.policies.push(policy); f.orderedIds.beforeSystemDefined.splice(1, 0, policy.id);
  const session = { id, device_id: f.device.id, state: 'active', desired_state: 'allowed', policy_id: policy.id, policy_fingerprint: policyContentFingerprint(policy) };
  f.sessions = [session]; f.requireAllowance = true; inspectDevicePolicyScope(f);
  policy.enabled = false; assert.throws(() => inspectDevicePolicyScope(f), e => e.code === 'session_policy_missing');
  policy.enabled = true; session.state = 'ended'; assert.throws(() => inspectDevicePolicyScope(f), e => e.code === 'session_policy_changed');
  session.state = 'active'; policy.schedule = { mode: 'ALWAYS' }; assert.throws(() => inspectDevicePolicyScope(f), e => e.code === 'session_policy_changed');
});
