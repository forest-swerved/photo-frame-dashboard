import { isDeepStrictEqual } from 'node:util';
import { requireValue } from './errors.js';
import { checkedPolicyOrdering, managedPolicyPlan, policyContentFingerprint, policyFieldValue } from './unifi.js';

const writableFields = ['enabled', 'source', 'destination', 'action', 'ipProtocolScope', 'schedule', 'connectionStateFilter', 'ipsecFilter', 'description'];
export function sameManagedPolicy(actual, expected) {
  return actual?.metadata?.origin === 'USER_DEFINED' && writableFields.every(key =>
    isDeepStrictEqual(policyFieldValue(actual, key), policyFieldValue(expected, key)));
}
const onlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
// Ignore a rule only when its source is provably disjoint. IP, network, VPN,
// inverted, referenced and future filter shapes conservatively overlap.
export function mayMatchDevice(policy, device) {
  const source = policy.source, filter = source?.trafficFilter, mac = filter?.macAddressFilter;
  if (!onlyKeys(source, ['zoneId', 'trafficFilter']) || !onlyKeys(filter, ['type', 'macAddressFilter'])
    || filter.type !== 'MAC_ADDRESS' || !onlyKeys(mac, ['macAddresses']) || !Array.isArray(mac.macAddresses)
    || !mac.macAddresses.length || !mac.macAddresses.every(value => typeof value === 'string' && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value))) return true;
  const ours = new Set(device.mac_addresses.map(value => value.toLowerCase()));
  return mac.macAddresses.some(value => ours.has(value.toLowerCase()));
}

// Verify the device's effective policy path, not a hash of the whole console.
// System rules cannot bypass the unconditional deny before their boundary.
// Enabled overlapping custom rules are never accepted based on their names.
export function inspectDevicePolicyScope({ device, integration, policies, orderedIds, sessions = [], env,
  denyEnabled, plannedSessionId, plannedPolicy, requireAllowance = false }) {
  const order = checkedPolicyOrdering(policies, orderedIds, { sourceZoneId: integration.source_zone_id, destinationZoneId: integration.external_zone_id });
  const byId = new Map(policies.map(policy => [policy.id, policy])), before = order.beforeSystemDefined;
  const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses,
    sourceZoneId: integration.source_zone_id, destinationZoneId: integration.external_zone_id, allowApplePush: device.allow_apple_push }, env);
  const deny = byId.get(device.deny_policy_id), management = byId.get(device.management_policy_id), apple = byId.get(device.apple_push_policy_id);
  const expectedEnabled = denyEnabled ?? deny?.enabled;
  requireValue(typeof expectedEnabled === 'boolean' && sameManagedPolicy(deny, { ...plan.deny, enabled: expectedEnabled })
    && sameManagedPolicy(management, plan.management) && (!device.allow_apple_push || sameManagedPolicy(apple, plan.applePush)),
    503, 'management_policy_changed', 'This device’s registered firewall rules changed. Review its setup.');
  const own = [device.management_policy_id, ...(device.allow_apple_push ? [device.apple_push_policy_id] : []), device.deny_policy_id];
  requireValue(new Set(own).size === own.length && own.every(id => before.includes(id))
    && before.indexOf(management.id) < before.indexOf(deny.id)
    && (!device.allow_apple_push || before.indexOf(apple.id) < before.indexOf(deny.id)),
    503, 'management_policy_changed', 'This device’s exceptions and block must precede system rules.');
  const trusted = new Set(own);
  for (const session of sessions.filter(s => s.device_id === device.id)) {
    const policy = byId.get(session.policy_id);
    if (!policy || !policy.enabled) {
      requireValue(!requireAllowance || session.state !== 'active' || session.desired_state !== 'allowed',
        503, 'session_policy_missing', 'The timed allowance is not active at the router.');
      continue;
    }
    const fingerprint = policyContentFingerprint(policy), planned = session.id === plannedSessionId;
    requireValue(policy.metadata?.origin === 'USER_DEFINED' && policy.action?.type === 'ALLOW'
      && (fingerprint === session.policy_fingerprint || planned && (fingerprint === session.planned_policy_fingerprint
        || plannedPolicy && fingerprint === policyContentFingerprint(plannedPolicy))),
      503, 'session_policy_changed', 'This device’s timed allowance changed outside Family Frame.');
    requireValue(before.includes(policy.id) && before.indexOf(policy.id) < before.indexOf(deny.id),
      503, 'session_policy_changed', 'The timed allowance is outside this device’s policy path.');
    if (requireAllowance) requireValue(session.desired_state === 'allowed' && !['ended', 'failed', 'paused'].includes(session.state),
      503, 'session_policy_changed', 'A previous allowance is still enabled.');
    trusted.add(policy.id);
  }
  for (const id of [...before, ...order.afterSystemDefined]) {
    const policy = byId.get(id);
    if (trusted.has(id) || policy.enabled === false || !mayMatchDevice(policy, device)) continue;
    requireValue(false, 503, 'device_policy_conflict', 'Another firewall rule can affect this device. Review the overlapping rule.');
  }
  return { order, deny, plan };
}
