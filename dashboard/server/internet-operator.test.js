import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspectPolicyInventory, runOperator } from './internet-operator.js';
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
test('free-to-use enrollment retains the same blocking pilot but verifies its disabled default deny', () => {
  const f = fixture(); f.device.default_access = 'allowed';
  assert.equal(inspectPolicyInventory(f).observations.permanentDenyVerified, false);
  const ready = inspectPolicyInventory({ ...f, policies: f.policies.map(p => p.id === f.input.denyPolicyId ? { ...p, enabled: false } : p) });
  assert.equal(ready.observations.permanentDenyVerified, true); assert.ok(ready.reviewedFingerprint);
  assert.equal(ready.policies.deny.enabled, true, 'Timed sessions and pilots keep an enabled deny template.');
  assert.ok(ready.requiredChecks.includes('management_access')); assert.ok(ready.requiredChecks.includes('unrelated_internet_blocked'));
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
test('household timezone changes invalidate every schedule and preflight proof binding', () => {
  const f = fixture(), before = inspectPolicyInventory(f);
  const changed = inspectPolicyInventory({ ...f, device: { ...f.device, timezone: 'America/New_York' } });
  assert.equal(before.timezone, 'America/Denver'); assert.equal(changed.timezone, 'America/New_York');
  for (const key of ['identityBinding', 'managementBinding', 'binding']) assert.notEqual(changed[key], before[key], key);
  // Policy bytes are deliberately unchanged; schedule evidence, not the default
  // rule content, must become stale when the household clock changes.
  assert.equal(changed.reviewedFingerprint, before.reviewedFingerprint);
});

function simulatedOperatorStore({ transactionTimezone = 'America/Denver' } = {}) {
  const f = fixture(), device = { ...f.device, version: 1 };
  const integration = { household_id: device.household_id, site_id: f.config.siteId, source_zone_id: f.config.sourceZoneId,
    external_zone_id: f.config.externalZoneId, state: 'pilot_required', version: 1 };
  const statements = [], mutations = [];
  const rows = value => ({ rows: value, rowCount: value.length });
  const query = async sql => {
    statements.push(sql);
    if (sql.startsWith('SELECT current_user AS name')) return rows([{ name: 'family_frame_server', rolsuper: false,
      rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, no_memberships: true }]);
    if (sql.startsWith('SELECT c.relname FROM pg_class')) return rows([{}, {}, {}]);
    if (sql.startsWith('SELECT d.*,h.timezone FROM family_managed_devices')) return rows([{ ...device }]);
    if (sql.startsWith('SELECT * FROM family_network_integrations')) return rows([{ ...integration }]);
    if (sql.startsWith('SELECT id FROM family_managed_devices WHERE household_id=')) return rows([]);
    if (sql.startsWith('SELECT * FROM family_internet_sessions WHERE household_id=')) return rows([]);
    if (sql.startsWith('SELECT details,created_at,id FROM family_internet_events')) return rows([]);
    if (sql.startsWith('SELECT timezone FROM family_households')) return rows([{ timezone: transactionTimezone }]);
    if (sql.startsWith('SELECT * FROM family_managed_devices WHERE id=')) return rows([{ ...device }]);
    if (sql.startsWith('SELECT id FROM family_internet_sessions WHERE household_id=') || sql.startsWith('SELECT id FROM family_internet_commands WHERE household_id=')) return rows([]);
    if (sql.startsWith('SELECT pg_advisory_xact_lock') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SET LOCAL')) return rows([]);
    if (/^(UPDATE|INSERT)/.test(sql)) { mutations.push(sql); return { rows: [], rowCount: 1 }; }
    throw Error(`Unexpected simulated operator query: ${sql}`);
  };
  const db = { query, connect: async () => ({ query, release() {} }) };
  const provider = { info: async () => ({ applicationVersion: f.applicationVersion }), sites: async () => [{ id: f.config.siteId }],
    zones: async () => [{ id: f.config.sourceZoneId }, { id: f.config.externalZoneId }], policies: async () => f.policies,
    ordering: async () => ({ orderedFirewallPolicyIds: f.orderedIds }) };
  const input = { ...f.input, ...f.config, deviceId: device.id, apply: true, confirmDevice: device.id };
  const options = { provider, now, env: { FAMILY_UNIFI_API_KEY: 'synthetic-not-a-real-provider-key', FAMILY_UNIFI_CONSOLE_ID: f.consoleId } };
  return { db, input, options, statements, mutations };
}
test('timezone changed after provider inspection rejects the owner write before any readiness mutation', async () => {
  const f = simulatedOperatorStore({ transactionTimezone: 'America/New_York' });
  await assert.rejects(runOperator(f.db, 'begin-pilot', f.input, f.options), error => error.code === 'operator_plan_changed');
  assert.equal(f.mutations.length, 0); assert.ok(f.statements.includes('ROLLBACK'));
  const lock = f.statements.findIndex(sql => sql.startsWith('SELECT pg_advisory_xact_lock'));
  const household = f.statements.findIndex(sql => sql.startsWith('SELECT timezone FROM family_households'));
  assert.ok(lock >= 0 && household > lock); assert.match(f.statements[household], /FOR SHARE$/);
});
test('unchanged household timezone permits the explicitly confirmed simulated pilot gate', async () => {
  const f = simulatedOperatorStore();
  assert.deepEqual(await runOperator(f.db, 'begin-pilot', f.input, f.options), { pilotRequired: true, providerWrites: false });
  assert.ok(f.mutations.length > 0); assert.ok(f.statements.includes('COMMIT'));
});
