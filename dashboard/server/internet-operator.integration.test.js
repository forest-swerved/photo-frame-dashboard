import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';
import { runOperator } from './internet-operator.js';

const enabled = process.env.FAMILY_RUN_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('operator readiness uses explicit recorded proofs without any provider mutation', { skip: !enabled, timeout: 30_000 }, async t => {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Refusing remote operator-test DDL.');
  const pool = createPool(process.env, { migration: true, max: 2 }), client = await pool.connect();
  const suffix = randomUUID().replaceAll('-', ''), schema = `family_operator_test_${suffix}`, owner = `family_operator_owner_${suffix}`;
  const env = { FAMILY_UNIFI_API_KEY: 'synthetic-provider-key-not-a-secret', FAMILY_UNIFI_CONSOLE_ID: `${'a'.repeat(64)}:12345` };
  const now = new Date('2026-10-18T02:00:00Z');
  const id = Object.fromEntries(['household', 'person', 'device', 'site', 'source', 'external', 'foreign', 'foreignAfter', 'management', 'deny', 'apple'].map(key => [key, randomUUID()]));
  const input = { deviceId: id.device, siteId: id.site, sourceZoneId: id.source, externalZoneId: id.external, beforePolicyId: id.foreign };
  const buckets = beforeSystemDefined => ({ beforeSystemDefined, afterSystemDefined: [id.foreignAfter] });
  const custom = fields => ({ ...fields, metadata: { origin: 'USER_DEFINED' } });
  let roleCreated = false, schemaCreated = false, order = buckets([id.foreign]);
  const policies = new Map([id.foreign, id.foreignAfter].map(policyId => [policyId, custom({ id: policyId, enabled: true,
    name: 'Synthetic foreign policy', action: { type: 'BLOCK' }, source: { zoneId: id.source }, destination: { zoneId: id.external } })]));
  let writes = 0, changeVersionDuringRead = false;
  const prohibited = () => { writes++; throw Error('Operator must not write to the provider.'); };
  const provider = { info: async () => ({ applicationVersion: '10.6.106' }), sites: async () => [{ id: id.site }], zones: async () => [{ id: id.source }, { id: id.external }],
    policies: async () => [...policies.values()].map(policy => structuredClone(policy)), ordering: async () => {
      if (changeVersionDuringRead) { changeVersionDuringRead = false; await client.query('UPDATE family_managed_devices SET version=version+1 WHERE id=$1', [id.device]); }
      return { orderedFirewallPolicyIds: structuredClone(order) };
    },
    createPolicy: prohibited, replacePolicy: prohibited, reorder: prohibited, removePolicy: prohibited };
  const db = { query: client.query.bind(client), connect: async () => ({ query: client.query.bind(client), release() {} }) };
  const options = { env, now, provider, expectedRole: owner };
  const run = (command, extra = {}) => runOperator(db, command, { ...input, ...extra }, options);
  const row = async table => (await client.query(`SELECT * FROM ${table} LIMIT 1`)).rows[0];
  const record = (check, extra = {}) => run('record-proof', { check, result: 'pass', operator: 'Synthetic fixture operator',
    summary: 'Synthetic test observation; this is not live gateway evidence.', observedAt: now.toISOString(), evidenceSha256: '1'.repeat(64), apply: true, confirmDevice: id.device, ...extra });
  try {
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests');
    await client.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`); roleCreated = true;
    await client.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${owner}`); schemaCreated = true;
    await client.query(`SET ROLE ${owner}`); await client.query(`SET search_path TO ${schema},pg_catalog`);
    for (const name of ['schema.sql', 'internet-schema.sql']) await client.query(await readFile(new URL(name, import.meta.url), 'utf8'));
    await client.query("INSERT INTO family_households(id,title) VALUES($1,'Synthetic operator household')", [id.household]);
    await client.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,'Synthetic child','#00748c')", [id.person, id.household]);
    await client.query("INSERT INTO family_managed_devices(id,household_id,name,kind,person_ids,mac_addresses,allow_apple_push) VALUES($1,$2,'Synthetic iPad','tablet',$3,$4,true)", [id.device, id.household, [id.person], ['02:12:34:56:78:9a', '02:12:34:56:78:9b']]);
    let plan;
    await t.test('unconfigured inventory and all plans are read-only; mutation confirmation is exact', async () => {
      await assert.rejects(runOperator(db, 'plan', input, { ...options, expectedRole: 'family_frame_server' }), error => error.code === 'operator_role_required');
      const inactive = await runOperator(db, 'inventory', {}, { ...options, env: {} });
      assert.equal(inactive.inactive, true); assert.equal(inactive.devices.length, 1);
      plan = await run('plan'); assert.equal(plan.activationAllowed, false);
      assert.equal((await run('begin-pilot')).dryRun, true); assert.equal(await row('family_network_integrations'), undefined);
      await assert.rejects(run('begin-pilot', { apply: true, confirmDevice: randomUUID() }), error => error.code === 'operator_confirmation_required');
      assert.equal(await row('family_network_integrations'), undefined); assert.equal(writes, 0);
    });
    await t.test('pilot gate records no invented evidence and blocks premature rollout', async () => {
      assert.equal((await run('begin-pilot', { apply: true, confirmDevice: id.device })).pilotRequired, true);
      assert.equal((await row('family_network_integrations')).state, 'pilot_required');
      await assert.rejects(run('activate', { apply: true, confirmDevice: id.device }), error => error.code === 'pilot_proofs_missing');
      const before = (await client.query('SELECT count(*) AS n FROM family_internet_events')).rows[0].n;
      assert.equal((await record('identity_stability', { apply: false })).dryRun, true);
      assert.equal((await client.query('SELECT count(*) AS n FROM family_internet_events')).rows[0].n, before);
      await assert.rejects(record('identity_stability', { observedAt: new Date(now.getTime() - 25 * 3600_000).toISOString() }), error => error.code === 'invalid_proof');
      await record('identity_stability');
      await assert.rejects(record('management_preflight'), error => error.code === 'management_unverified');
      await assert.rejects(run('pilot-plan'), error => error.code === 'preflight_required');
      assert.equal((await row('family_managed_devices')).control_state, 'unenrolled');
    });
    await t.test('management and APNs preflight precede the bounded pilot and permanent deny', async () => {
      policies.set(id.management, custom({ ...plan.policies.management, id: id.management })); policies.set(id.apple, custom({ ...plan.policies.applePush, id: id.apple }));
      input.managementPolicyId = id.management; input.applePolicyId = id.apple; order = buckets([id.management, id.apple, id.foreign]);
      await record('management_preflight');
      const pilot = await run('pilot-plan'); assert.equal(pilot.providerWrites, false); assert.equal(pilot.pilotDeny.schedule.timeFilter.stopTime, '20:05');
      policies.set(id.deny, custom({ ...pilot.pilotDeny, id: id.deny })); input.denyPolicyId = id.deny; order = buckets([id.management, id.apple, id.deny, id.foreign]);
      plan = await run('plan'); assert.equal(plan.observations.pilotDenyVerified, true);
      for (const check of plan.requiredChecks.filter(check => !['identity_stability', 'management_preflight'].includes(check))) await record(check);
      await assert.rejects(run('activate', { apply: true, confirmDevice: id.device }), error => error.code === 'permanent_policies_unverified');
      const permanent = await run('permanent-plan'); assert.equal(permanent.permanentDeny.schedule, null);
      policies.set(id.deny, custom({ ...permanent.permanentDeny, id: id.deny }));
    });
    await t.test('activation writes only verified readiness after all current named checks', async () => {
      assert.equal((await run('activate')).dryRun, true); assert.equal((await row('family_managed_devices')).control_state, 'unenrolled');
      assert.equal((await run('activate', { apply: true, confirmDevice: id.device })).ready, true);
      const device = await row('family_managed_devices'), integration = await row('family_network_integrations');
      assert.equal(device.management_policy_id, id.management); assert.equal(device.apple_push_policy_id, id.apple); assert.equal(device.control_state, 'ready');
      assert.equal(device.reviewed_policy_fingerprint, (await run('inspect')).reviewedFingerprint);
      assert.equal(integration.state, 'ready'); assert.equal(integration.pilot_checks.apple_push, true); assert.equal(writes, 0);
    });
    await t.test('beginning another pilot gates existing devices, and a latest failure cannot reuse an older pass', async () => {
      await run('begin-pilot', { apply: true, confirmDevice: id.device });
      assert.equal((await row('family_managed_devices')).control_state, 'attention');
      await record('expiry', { result: 'fail' });
      await assert.rejects(run('permanent-plan'), error => error.code === 'pilot_proofs_missing' && error.message.includes('expiry'));
      await record('expiry'); assert.equal((await run('permanent-plan')).dryRun, true);
    });
    await t.test('foreign drift invalidates evidence and active sessions prevent enrollment changes', async () => {
      policies.get(id.foreign).action = { type: 'ALLOW' };
      await assert.rejects(run('activate'), error => error.code === 'pilot_proofs_missing');
      policies.get(id.foreign).action = { type: 'BLOCK' };
      policies.get(id.foreignAfter).action = { type: 'ALLOW' };
      await assert.rejects(run('activate'), error => error.code === 'pilot_proofs_missing');
      policies.get(id.foreignAfter).action = { type: 'BLOCK' };
      changeVersionDuringRead = true;
      await assert.rejects(run('begin-pilot', { apply: true, confirmDevice: id.device }), error => error.code === 'operator_plan_changed');
      await client.query(`INSERT INTO family_internet_sessions(id,household_id,person_id,device_id,source,state,desired_state,requested_at,remaining_seconds,allocated_seconds,policy_snapshot,created_by)
        VALUES($1,$2,$3,$4,'parent','starting','allowed',$5,3600,3600,'{}','synthetic:fixture')`, [randomUUID(), id.household, id.person, id.device, now]);
      await assert.rejects(run('begin-pilot', { apply: true, confirmDevice: id.device }), error => error.code === 'internet_sessions_active');
      await assert.rejects(run('activate', { apply: true, confirmDevice: id.device }), error => error.code === 'internet_sessions_active');
      assert.equal(writes, 0);
    });
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    if (schemaCreated) await client.query(`DROP SCHEMA ${schema} CASCADE`);
    if (roleCreated) await client.query(`DROP ROLE ${owner}`);
    client.release(); await pool.end();
  }
});
