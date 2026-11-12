import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { managedPolicyPlan, policyContentFingerprint } from './unifi.js';
import { restrictDeviceAccess } from './internet-enforcement.js';
const device = { id: randomUUID(), deny_policy_id: randomUUID(), mac_addresses: ['02:12:34:56:78:9a'] };
const integration = { site_id: randomUUID(), source_zone_id: randomUUID(), external_zone_id: randomUUID() };
const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses, sourceZoneId: integration.source_zone_id, destinationZoneId: integration.external_zone_id });
function fixture() {
  const deny = { ...structuredClone(plan.deny), id: device.deny_policy_id, enabled: false, metadata: { origin: 'USER_DEFINED' } };
  const allowance = { ...structuredClone(deny), id: randomUUID(), enabled: true, action: { type: 'ALLOW', allowReturnTraffic: false } };
  const policies = new Map([[deny.id, deny], [allowance.id, allowance]]), writes = [];
  const provider = { policy: async (_, id) => structuredClone(policies.get(id)), replacePolicy: async (_, id, original, patch) => { writes.push({ id, patch }); policies.set(id, { ...original, ...patch }); } };
  const sessions = [{ policy_id: allowance.id, policy_fingerprint: policyContentFingerprint(allowance) }];
  return { policies, writes, allowance, provider, sessions };
}
test('restriction survives unrelated inventory drift and only narrows exact registered policies', async () => {
  const f = fixture(); let ownership = 0;
  await restrictDeviceAccess({ ...f, device, integration, assertOwnership: async () => { ownership++; } });
  assert.equal(ownership, 2);
  assert.deepEqual(f.writes, [{ id: device.deny_policy_id, patch: { enabled: true } }, { id: f.allowance.id, patch: { enabled: false } }]);
  await restrictDeviceAccess({ ...f, device, integration, assertOwnership: async () => { throw Error('No further writes expected'); } });
});
test('changed device identity, foreign allowance, lease loss and ambiguous readback never pass recovery', async () => {
  for (const scenario of ['identity', 'allowance', 'ownership', 'readback']) {
    const f = fixture();
    if (scenario === 'identity') f.policies.get(device.deny_policy_id).source = { zoneId: randomUUID() };
    if (scenario === 'allowance') f.policies.get(f.allowance.id).destination = { zoneId: randomUUID() };
    if (scenario === 'readback') f.provider.replacePolicy = async () => {};
    await assert.rejects(restrictDeviceAccess({ ...f, device, integration, assertOwnership: async () => { if (scenario === 'ownership') throw Error('Lease lost'); } }));
    if (['identity', 'ownership'].includes(scenario)) assert.equal(f.writes.length, 0);
    if (scenario === 'allowance') assert.deepEqual(f.writes, [{ id: device.deny_policy_id, patch: { enabled: true } }]);
  }
});
