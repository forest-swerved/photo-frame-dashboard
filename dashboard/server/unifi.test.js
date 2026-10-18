import test from 'node:test';
import assert from 'node:assert/strict';
import { createUniFiClient, managedOrdering, managedPolicyPlan, managementHost, normalizedMac, unifiConfiguration } from './unifi.js';

const ids = Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const env = { FAMILY_UNIFI_API_KEY: 'synthetic-provider-key-not-a-secret', FAMILY_UNIFI_CONSOLE_ID: `${'a'.repeat(64)}:1234567890` };
const plan = () => managedPolicyPlan({ deviceId: ids[0], sourceZoneId: ids[1], destinationZoneId: ids[2], macAddresses: ['02:11:22:33:44:55'] });

test('UniFi management exception is permanent, exact-host, HTTPS-only and covers IPv4/IPv6', () => {
  const { management, deny, requiredChecks } = plan();
  assert.deepEqual(management.destination.trafficFilter.domainFilter, { type: 'DOMAINS', domains: ['forest-family-frame.vercel.app'] });
  assert.deepEqual(management.destination.trafficFilter.portFilter, { type: 'PORTS', matchOpposite: false, items: [{ type: 'PORT_NUMBER', value: 443 }] });
  assert.equal(management.schedule, null);
  assert.equal(management.ipProtocolScope.ipVersion, 'IPV4_AND_IPV6');
  assert.deepEqual(management.action, { type: 'ALLOW', allowReturnTraffic: false });
  assert.equal(deny.action.type, 'BLOCK');
  assert.equal(deny.destination.trafficFilter, undefined);
  assert.equal(deny.schedule, null);
  assert.ok(requiredChecks.includes('management_access') && requiredChecks.includes('shared_cdn_isolation'));
  management.source.trafficFilter.macAddressFilter.macAddresses.push('02:00:00:00:00:01');
  assert.equal(deny.source.trafficFilter.macAddressFilter.macAddresses.length, 1);
});

test('UniFi enrollment rejects multicast/broadcast/empty identities and broad management hosts', () => {
  assert.equal(normalizedMac(' 02:AA:BB:CC:DD:EE '), '02:aa:bb:cc:dd:ee');
  for (const value of ['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '01:00:00:00:00:01', 'localhost', 'aa-bb-cc-dd-ee-ff']) assert.throws(() => normalizedMac(value), e => e.code === 'invalid_mac');
  for (const value of ['*.vercel.app', 'vercel.app', 'https://family.example', 'family.example/path', '127.0.0.1', 'family.example:443']) assert.throws(() => managementHost({ FAMILY_MANAGEMENT_HOST: value }));
  assert.throws(() => unifiConfiguration({ ...env, FAMILY_UNIFI_CONSOLE_ID: 'https://attacker.invalid' }));
  assert.throws(() => managedPolicyPlan({ deviceId: ids[0], sourceZoneId: ids[1], destinationZoneId: ids[1], macAddresses: ['02:11:22:33:44:55'] }));
});
test('Apple devices retain a narrow permanent APNs transport on both IP versions', () => {
  const { applePush, requiredChecks } = managedPolicyPlan({ deviceId: ids[0], sourceZoneId: ids[1], destinationZoneId: ids[2], macAddresses: ['02:11:22:33:44:55'], allowApplePush: true });
  assert.equal(applePush.schedule, null); assert.equal(applePush.ipProtocolScope.protocolFilter.protocol.name, 'tcp');
  assert.deepEqual(applePush.destination.trafficFilter.portFilter.items.map(item => item.value), [5223, 443]);
  const ranges = applePush.destination.trafficFilter.ipAddressFilter.items.map(item => item.value);
  assert.ok(ranges.includes('2620:149:a44::/48')); assert.ok(!ranges.includes('17.0.0.0/8')); assert.ok(requiredChecks.includes('apple_push'));
});

test('managed policy order always retains management above sessions and deny, preserving other relative order', () => {
  assert.deepEqual(managedOrdering([ids[5], ids[3], ids[6]], { managementIds: [ids[0]], sessionIds: [ids[3]], denyIds: [ids[4]], insertBeforeId: ids[6] }), [ids[5], ids[0], ids[3], ids[4], ids[6]]);
  assert.throws(() => managedOrdering([ids[5]], { managementIds: [ids[0]], denyIds: [ids[4]] }), e => e.code === 'policy_anchor_required');
  assert.throws(() => managedOrdering([], { managementIds: [], denyIds: [ids[4]] }), e => e.code === 'management_required');
  assert.throws(() => managedOrdering([], { managementIds: [ids[0]], denyIds: [ids[0]] }), e => e.code === 'management_required');
});

test('official Cloud Connector is fixed-host and uses the documented ordering parameter names', async () => {
  const calls = [];
  const client = createUniFiClient({ env, fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return Response.json({ orderedFirewallPolicyIds: ids.slice(0, 3) }); } });
  await client.ordering(ids[0], ids[1], ids[2]);
  await client.reorder(ids[0], ids[1], ids[2], ids.slice(0, 3));
  assert.equal(calls[0].url.origin, 'https://api.ui.com');
  assert.equal(calls[0].url.searchParams.get('sourceFirewallZoneId'), ids[1]);
  assert.equal(calls[0].url.searchParams.get('destinationFirewallZoneId'), ids[2]);
  assert.equal(calls[0].init.headers['X-API-KEY'], env.FAMILY_UNIFI_API_KEY);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.deepEqual(JSON.parse(calls[1].init.body), { orderedFirewallPolicyIds: ids.slice(0, 3) });
});

test('full PUT preserves policy fields; foreign policies cannot be edited or deleted', async () => {
  const calls = [];
  let readPolicy = { id: ids[4], ...plan().management };
  const client = createUniFiClient({ env, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(readPolicy); } });
  await client.replacePolicy(ids[0], ids[4], readPolicy, { enabled: false });
  const written = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(written.enabled, false);
  assert.deepEqual(written.source, readPolicy.source);
  assert.deepEqual(written.destination, readPolicy.destination);
  assert.equal(written.id, undefined);
  assert.throws(() => client.replacePolicy(ids[0], ids[4], { ...readPolicy, description: 'unrelated user rule' }, { enabled: false }), e => e.code === 'unmanaged_policy');
  readPolicy = { ...readPolicy, description: 'unrelated user rule' };
  await assert.rejects(client.removePolicy(ids[0], ids[4]), e => e.code === 'unmanaged_policy');
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 0);
});

test('ambiguous UniFi writes are sanitized and marked for reconciliation; provider authentication cannot sign out the app', async () => {
  const client = createUniFiClient({ env, fetchImpl: async () => { throw new Error('sensitive provider details must not escape'); } });
  await assert.rejects(client.createPolicy(ids[0], plan().management), e => e.code === 'unifi_unavailable' && e.details.mayHaveApplied && !e.message.includes('sensitive'));
  const denied = createUniFiClient({ env, fetchImpl: async () => new Response('private provider data', { status: 401 }) });
  await assert.rejects(denied.info(), e => e.status === 503 && e.code === 'unifi_credentials_rejected');
  const malformed = createUniFiClient({ env, fetchImpl: async () => new Response('invalid-json', { status: 200 }) });
  await assert.rejects(malformed.createPolicy(ids[0], plan().management), e => e.code === 'unifi_response_invalid' && e.details.mayHaveApplied);
});

test('inventory pagination is bounded and incomplete inventories fail closed', async () => {
  const offsets = [];
  const client = createUniFiClient({ env, fetchImpl: async url => {
    const offset = Number(new URL(url).searchParams.get('offset')); offsets.push(offset);
    return Response.json({ totalCount: 101, data: Array.from({ length: offset ? 1 : 100 }, (_, i) => ({ id: `${offset + i}` })) });
  } });
  assert.equal((await client.clients(ids[0])).length, 101);
  assert.deepEqual(offsets, [0, 100]);
  const broken = createUniFiClient({ env, fetchImpl: async () => Response.json({ totalCount: 2, data: [] }) });
  await assert.rejects(broken.sites(), e => e.code === 'unifi_response_invalid');
});
