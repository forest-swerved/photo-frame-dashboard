import { ApiError, requireValue, uuidField } from './errors.js';
import { createHash } from 'node:crypto';

// Public Network 10.6.106 API only. No legacy cookie sessions, arbitrary hosts,
// controller port forwarding, or client-supplied provider URLs.
const CLOUD = 'https://api.ui.com';
const MAX_BYTES = 1024 * 1024;
export const requiredPilotChecks = ['management_access', 'unrelated_internet_blocked', 'shared_cdn_isolation', 'expiry', 'existing_connections', 'ipv6', 'controller_outage', 'gateway_restart', 'midnight', 'dst'];
const ownFields = ['action', 'connectionStateFilter', 'description', 'destination', 'enabled', 'ipProtocolScope', 'ipsecFilter', 'loggingEnabled', 'name', 'schedule', 'source'];
const isManaged = policy => /^family-frame:[0-9a-f-]{36}:(?:management|apple-push|deny|session:[0-9a-f-]{36})$/.test(policy?.description || '');

export function normalizedMac(value) {
  requireValue(typeof value === 'string' && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value.trim()), 422, 'invalid_mac', 'Use a device MAC address in AA:BB:CC:DD:EE:FF format.');
  const mac = value.trim().toLowerCase();
  requireValue(mac !== '00:00:00:00:00:00' && mac !== 'ff:ff:ff:ff:ff:ff' && !(parseInt(mac.slice(0, 2), 16) & 1),
    422, 'invalid_mac', 'Use an individual device MAC address.');
  return mac;
}

export function unifiConfiguration(env = process.env) {
  const apiKey = env.FAMILY_UNIFI_API_KEY;
  const consoleId = env.FAMILY_UNIFI_CONSOLE_ID;
  requireValue(typeof apiKey === 'string' && apiKey.length >= 20 && apiKey.length <= 2048 && !/\s/.test(apiKey)
    && typeof consoleId === 'string' && /^[A-Fa-f0-9]{32,128}:\d{1,20}$/.test(consoleId),
  503, 'unifi_not_configured', 'Connect UniFi before enabling managed Internet access.');
  return { apiKey, consoleId };
}

export function managementHost(env = process.env) {
  const host = env.FAMILY_MANAGEMENT_HOST || 'forest-family-frame.vercel.app';
  requireValue(typeof host === 'string' && host === host.toLowerCase() && host.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host)
    && !['vercel.app', 'supabase.co', 'ui.com', 'apple.com'].includes(host),
  503, 'management_not_configured', 'The exact Family Frame management hostname must be configured.');
  return host;
}

async function boundedJson(response) {
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('limit'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new ApiError(502, 'unifi_response_invalid', 'UniFi returned an incomplete response. Check its connection.'); }
  finally { reader.releaseLock(); }
}

export function createUniFiClient({ env = process.env, fetchImpl = fetch, budgetMs = 120_000 } = {}) {
  const config = unifiConfiguration(env);
  const deadline = Date.now() + Math.min(120_000, Math.max(1000, budgetMs));
  const base = `${CLOUD}/v1/connector/consoles/${encodeURIComponent(config.consoleId)}/proxy/network/integration`;
  const sitePath = siteId => `/v1/sites/${uuidField(siteId, 'UniFi site')}`;
  async function request(path, method = 'GET', body) {
    const mutation = method !== 'GET';
    requireValue(Date.now() < deadline, 503, 'unifi_deadline', 'Network verification reached its time limit and will resume.');
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))),
        headers: { accept: 'application/json', 'X-API-KEY': config.apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new ApiError(503, 'unifi_unavailable', 'UniFi could not be reached. The operation must be checked before trying again.', { mayHaveApplied: mutation });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if ([401, 403].includes(response.status)) throw new ApiError(503, 'unifi_credentials_rejected', 'UniFi rejected its server connection. A parent must reconnect it.');
      throw new ApiError(response.status === 429 ? 503 : 502, response.status === 429 ? 'unifi_rate_limited' : 'unifi_request_failed',
        'UniFi did not confirm the operation. Its current state must be checked.', { mayHaveApplied: mutation && response.status >= 500 });
    }
    if (response.status === 204) return null;
    try { return await boundedJson(response); }
    catch { throw new ApiError(502, 'unifi_response_invalid', 'UniFi did not return a complete confirmation.', { mayHaveApplied: mutation }); }
  }
  async function list(path) {
    const all = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const result = await request(`${path}?limit=100&offset=${offset}`);
      requireValue(result && Array.isArray(result.data) && result.data.length <= 100 && Number.isInteger(result.totalCount)
        && result.totalCount >= 0 && result.totalCount <= 1000, 502, 'unifi_response_invalid', 'UniFi inventory was incomplete or too large.');
      all.push(...result.data);
      if (all.length >= result.totalCount) return all;
      requireValue(result.data.length > 0, 502, 'unifi_response_invalid', 'UniFi inventory was incomplete.');
    }
    throw new ApiError(502, 'unifi_response_invalid', 'UniFi inventory exceeded the safe limit.');
  }
  const policies = siteId => `${sitePath(siteId)}/firewall/policies`;
  return Object.freeze({
    info: () => request('/v1/info'),
    sites: () => list('/v1/sites'),
    clients: siteId => list(`${sitePath(siteId)}/clients`),
    zones: siteId => list(`${sitePath(siteId)}/firewall/zones`),
    policies: siteId => list(policies(siteId)),
    policy: (siteId, policyId) => request(`${policies(siteId)}/${uuidField(policyId, 'UniFi policy')}`),
    createPolicy: (siteId, policy) => {
      requireValue(isManaged(policy), 422, 'unmanaged_policy', 'Only Family Frame policies can be created by this connection.');
      return request(policies(siteId), 'POST', policy);
    },
    replacePolicy: (siteId, policyId, previous, changes) => {
      requireValue(isManaged(previous) && previous.id === policyId && (!changes.description || changes.description === previous.description),
        409, 'unmanaged_policy', 'This firewall policy is not managed by Family Frame.');
      return request(`${policies(siteId)}/${uuidField(policyId, 'UniFi policy')}`, 'PUT',
        Object.fromEntries(ownFields.filter(key => previous[key] !== undefined || Object.hasOwn(changes, key)).map(key => [key, Object.hasOwn(changes, key) ? changes[key] : previous[key]])));
    },
    removePolicy: async (siteId, policyId) => {
      const path = `${policies(siteId)}/${uuidField(policyId, 'UniFi policy')}`;
      const previous = await request(path);
      requireValue(isManaged(previous), 409, 'unmanaged_policy', 'This firewall policy is not managed by Family Frame.');
      return request(path, 'DELETE');
    },
    ordering: (siteId, sourceZoneId, destinationZoneId) => request(`${policies(siteId)}/ordering?sourceFirewallZoneId=${uuidField(sourceZoneId)}&destinationFirewallZoneId=${uuidField(destinationZoneId)}`),
    reorder: (siteId, sourceZoneId, destinationZoneId, orderedFirewallPolicyIds) => {
      requireValue(Array.isArray(orderedFirewallPolicyIds) && orderedFirewallPolicyIds.length <= 1000 && new Set(orderedFirewallPolicyIds).size === orderedFirewallPolicyIds.length,
        422, 'invalid_policy_order', 'Use a unique, complete firewall policy order.');
      orderedFirewallPolicyIds.forEach(id => uuidField(id));
      return request(`${policies(siteId)}/ordering?sourceFirewallZoneId=${uuidField(sourceZoneId)}&destinationFirewallZoneId=${uuidField(destinationZoneId)}`, 'PUT', { orderedFirewallPolicyIds });
    },
  });
}

export function managedPolicyPlan({ deviceId, macAddresses, sourceZoneId, destinationZoneId, allowApplePush = false }, env = process.env) {
  uuidField(deviceId); uuidField(sourceZoneId); uuidField(destinationZoneId);
  requireValue(sourceZoneId !== destinationZoneId && Array.isArray(macAddresses) && macAddresses.length >= 1 && macAddresses.length <= 8,
    422, 'invalid_managed_device', 'Choose an enrolled device and its Internet firewall zones.');
  const macs = [...new Set(macAddresses.map(normalizedMac))];
  const host = managementHost(env);
  const base = { enabled: true, loggingEnabled: false, ipProtocolScope: { ipVersion: 'IPV4_AND_IPV6' },
    source: { zoneId: sourceZoneId, trafficFilter: { type: 'MAC_ADDRESS', macAddressFilter: { macAddresses: macs } } },
    destination: { zoneId: destinationZoneId }, connectionStateFilter: null, ipsecFilter: null, schedule: null };
  // Management precedes BOTH the baseline deny and any timed allowance. It has
  // no session expiry and is never removed by pause/end. Pilot tests must prove
  // exact-domain isolation on the installed gateway (a shared CDN IP is not proof).
  const management = { ...structuredClone(base), name: `Family Frame management ${deviceId}`, description: `family-frame:${deviceId}:management`, action: { type: 'ALLOW', allowReturnTraffic: false },
    destination: { zoneId: destinationZoneId, trafficFilter: { type: 'DOMAIN', domainFilter: { type: 'DOMAINS', domains: [host] },
      portFilter: { type: 'PORTS', matchOpposite: false, items: [{ type: 'PORT_NUMBER', value: 443 }] } } } };
  const deny = { ...structuredClone(base), name: `Family Frame Internet deny ${deviceId}`, description: `family-frame:${deviceId}:deny`, action: { type: 'BLOCK' } };
  // Apple publishes these narrower APNs ranges for networks that cannot allow
  // its whole /8. APNs multiplexes notifications for all installed apps; this
  // exception permits that transport, not general Apple web access.
  // https://support.apple.com/en-us/102266 (verified October 2026)
  const applePush = allowApplePush ? { ...structuredClone(base), name: `Family Frame Apple push ${deviceId}`, description: `family-frame:${deviceId}:apple-push`,
    action: { type: 'ALLOW', allowReturnTraffic: false },
    ipProtocolScope: { ipVersion: 'IPV4_AND_IPV6', protocolFilter: { type: 'NAMED_PROTOCOL', matchOpposite: false, protocol: { name: 'tcp' } } },
    destination: { zoneId: destinationZoneId, trafficFilter: { type: 'IP_ADDRESS',
      ipAddressFilter: { type: 'IP_ADDRESSES', matchOpposite: false, items: ['17.249.0.0/16', '17.252.0.0/16', '17.57.144.0/22', '17.188.128.0/18', '17.188.20.0/23',
        '2620:149:a44::/48', '2403:300:a42::/48', '2403:300:a51::/48', '2a01:b740:a42::/48'].map(value => ({ type: 'SUBNET', value })) },
      portFilter: { type: 'PORTS', matchOpposite: false, items: [5223, 443].map(value => ({ type: 'PORT_NUMBER', value })) } } } } : null;
  return { management, deny, applePush, managementHost: host, requiredChecks: [...requiredPilotChecks, ...(allowApplePush ? ['apple_push'] : [])] };
}

export function managedOrdering(existingIds, { managementIds, sessionIds = [], denyIds, insertBeforeId }) {
  for (const ids of [existingIds, managementIds, sessionIds, denyIds]) {
    requireValue(Array.isArray(ids), 422, 'invalid_policy_order', 'Firewall policy order is invalid.');
    ids.forEach(id => uuidField(id));
  }
  const ours = [...managementIds, ...sessionIds, ...denyIds];
  requireValue(managementIds.length > 0 && denyIds.length > 0 && new Set(ours).size === ours.length,
    422, 'management_required', 'Permanent Family Frame access must be present before Internet blocking.');
  const foreign = existingIds.filter(id => !ours.includes(id));
  // Choosing an insertion point is part of the reviewed enrollment plan.
  // Never move Family Frame ALLOW rules above existing security rules merely
  // because their relative order would otherwise remain unchanged.
  requireValue(insertBeforeId && foreign.includes(insertBeforeId) || foreign.length === 0,
    409, 'policy_anchor_required', 'Review an explicit firewall insertion point before enrolling a device.');
  const at = insertBeforeId ? foreign.indexOf(insertBeforeId) : 0;
  return [...foreign.slice(0, at), ...ours, ...foreign.slice(at)];
}

const volatilePolicyFields = new Set(['id', 'index', 'position', 'order', 'ordering', 'createdAt', 'updatedAt', 'version', 'statistics', 'counters']);
const canonicalPolicyValue = value => Array.isArray(value) ? value.map(canonicalPolicyValue) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalPolicyValue(value[key])])) : value;
const stablePolicy = policy => Object.fromEntries(Object.entries(policy).filter(([key]) => !volatilePolicyFields.has(key)));
export function policyContentFingerprint(policy) {
  requireValue(policy && typeof policy === 'object' && !Array.isArray(policy), 503, 'policy_review_required', 'The reviewed firewall policy is unavailable.');
  // Mutable fields normalize absent nullable values. Read-only API metadata is
  // not present in a planned POST, but every traffic-affecting field is owned.
  return createHash('sha256').update(JSON.stringify(canonicalPolicyValue(Object.fromEntries(ownFields.map(key => [key, policy[key] ?? null]))))).digest('hex');
}

// Callers may exempt only identified session rules whose content was verified
// against their stored/explicitly-planned policy. Descriptions never confer an
// exemption. Keeping foreign rule identities/content and permanent rule placement
// in the same digest detects order drift as well as newly introduced broad ALLOWs.
export function reviewedPolicyFingerprint(policies, orderedIds, { managementId, denyId, ignoredSessionIds = [] } = {}) {
  uuidField(managementId); uuidField(denyId);
  requireValue(Array.isArray(policies) && policies.length <= 1000 && Array.isArray(orderedIds)
    && orderedIds.length <= 1000 && new Set(orderedIds).size === orderedIds.length
    && Array.isArray(ignoredSessionIds) && !ignoredSessionIds.includes(managementId) && !ignoredSessionIds.includes(denyId),
  503, 'policy_review_required', 'The reviewed firewall policy order is unavailable.');
  const byId = new Map();
  for (const policy of policies) {
    uuidField(policy?.id, 'Policy identity');
    requireValue(!byId.has(policy.id), 503, 'policy_review_required', 'UniFi returned duplicate policy identities.');
    byId.set(policy.id, policy);
  }
  for (const id of orderedIds) {
    uuidField(id, 'Policy order');
    requireValue(byId.has(id), 503, 'policy_review_required', 'The firewall policy inventory is incomplete.');
  }
  requireValue(managementId !== denyId && orderedIds.includes(managementId) && orderedIds.includes(denyId)
    && orderedIds.indexOf(managementId) < orderedIds.indexOf(denyId),
  503, 'management_policy_changed', 'Permanent Family Frame access must precede Internet blocking.');
  const ignored = new Set(ignoredSessionIds);
  const order = orderedIds.filter(id => !ignored.has(id));
  return createHash('sha256').update(JSON.stringify(canonicalPolicyValue({ order,
    policies: order.map(id => ({ id, content: stablePolicy(byId.get(id)) })) }))).digest('hex');
}
