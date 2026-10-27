import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool, transaction } from './database.js';
import { ensureDailyOccurrences, setOccurrenceCompletion, changeChoreOccurrence, getRequiredProgress } from './chore-occurrences.js';
import { changeInternetSession, internetSnapshot, saveManagedDevice, changeDeviceAccess, saveRewardPolicy, startInternetSession, syncChoreReward, resolveRewardReview } from './internet.js';
import { createFrameAccessCode, frameAuthorization, redeemFrameAccess, parentCapabilities, changeMemberCapabilities, transferOwnership, revokeFrameAccessAfterRecovery } from './capabilities.js';
import { managedPolicyPlan, requiredPilotChecks, reviewedPolicyFingerprint } from './unifi.js';
import { processInternetJobs } from './internet-worker.js';
import { verifySchema } from './verify-schema.js';

const enabled = process.env.FAMILY_RUN_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('reward reservation, frame authorization and durable provider reconciliation', { skip: !enabled, timeout: 45_000 }, async t => {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Refusing remote reward test DDL.');
  const pool = createPool(process.env, { migration: true, max: 8 }), schema = `family_internet_test_${randomUUID().replaceAll('-', '')}`;
  const now = new Date('2026-10-18T01:00:00Z'), today = '2026-10-17';
  const env = { FAMILY_UNIFI_API_KEY: 'synthetic-provider-key-not-a-secret', FAMILY_UNIFI_CONSOLE_ID: `${'a'.repeat(64)}:12345`, FAMILY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
  const household = { id: randomUUID(), title: 'Fixture family', timezone: 'America/Denver' };
  const parent = { authType: 'user', role: 'admin', actor: 'user:fixture', sessionId: randomUUID(), user: { id: randomUUID(), name: 'Fixture parent' }, household };
  const child = { ...parent, authType: 'mobile', role: 'child', actor: 'mobile:fixture', mobileSessionId: randomUUID(), providerId: randomUUID(), personId: randomUUID(), user: { id: randomUUID(), name: 'Fixture child' } };
  const sibling = { ...child, actor: 'mobile:sibling', mobileSessionId: randomUUID(), providerId: randomUUID(), personId: randomUUID(), user: { id: randomUUID(), name: 'Fixture sibling' } };
  const frame = { ...parent, authType: 'frame', role: 'frame', actor: 'frame:fixture', user: { id: randomUUID(), name: 'Fixture frame' } };
  let issuanceBarrier = null;
  // This fixture owns its provider-session substitute; it never touches the
  // shared Auth view or another suite's account/session records.
  const db = { async connect() {
    const c = await pool.connect();
    try { await c.query(`SET search_path TO ${schema},pg_catalog`); }
    catch (error) { c.release(); throw error; }
    return { async query(sql, values) {
      const result = await c.query(sql.replaceAll('family_internal.auth_sessions', `${schema}.fixture_auth_sessions`), values);
      if (issuanceBarrier && sql.startsWith('SELECT id FROM family_internal.auth_sessions')) {
        const barrier = issuanceBarrier; issuanceBarrier = null; barrier.entered(); await barrier.released;
      }
      return result;
    }, release() { c.release(); } };
  }, async query(sql, values) { const c = await this.connect(); try { return await c.query(sql, values); } finally { c.release(); } } };
  const change = (row, completed, actor = child) => setOccurrenceCompletion(db, actor, row.id, { completed, expectedVersion: row.version, mutationId: randomUUID() }, { now, onChange: (c, event) => syncChoreReward(c, event, { now }) });
  const createRoutine = async (personId = child.personId) => (await db.query(`INSERT INTO family_chores(id,household_id,title,person_id) VALUES($1,$2,'Fixture chore',$3) RETURNING *`, [randomUUID(), household.id, personId])).rows[0];
  const snapshot = actor => internetSnapshot(db, actor || child, { env, now });
  let created = false, device, credit, session;
  const sourceZone = randomUUID(), externalZone = randomUUID(), site = randomUUID();
  const foreignAfterIds = [randomUUID(), randomUUID()];
  const policies = new class extends Map { set(id, policy) { return super.set(id, { metadata: { origin: 'USER_DEFINED', configurable: true }, ...policy }); } }(), calls = { creates: 0, allows: 0, blocks: 0 };
  let ordered = [], afterOrdered = [], ambiguousCreate = false, failRead = false;
  const provider = {
    async policies() { if (failRead) throw Error('provider unreachable'); return [...policies.values()].map(row => structuredClone(row)); },
    async createPolicy(_site, policy) { calls.creates++; const row = { ...structuredClone(policy), id: randomUUID(), metadata: { origin: 'USER_DEFINED', configurable: true } }; policies.set(row.id, row); afterOrdered.push(row.id); if (ambiguousCreate) { ambiguousCreate = false; throw Error('ambiguous transport'); } return structuredClone(row); },
    async policy(_site, id) { return structuredClone(policies.get(id)); },
    async replacePolicy(_site, id, _previous, value) { const row = { ...policies.get(id), ...structuredClone(value) }; policies.set(id, row); row.enabled ? calls.allows++ : calls.blocks++; return structuredClone(row); },
    async ordering() { return { orderedFirewallPolicyIds: { beforeSystemDefined: [...ordered], afterSystemDefined: [...afterOrdered] } }; },
    async reorder(_site, _source, _external, ids) {
      if (policies.has(foreignAfterIds[0])) assert.deepEqual(ids.afterSystemDefined.filter(id => foreignAfterIds.includes(id)), foreignAfterIds,
        'Existing rules after the system boundary must retain their bucket and relative order.');
      ordered = [...ids.beforeSystemDefined]; afterOrdered = [...ids.afterSystemDefined];
    },
  };
  const worker = at => processInternetJobs(db, { env, now: at || now, provider, clock: () => at || now });
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests');
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    for (const name of ['schema.sql', 'mobile-schema.sql', 'notifications-schema.sql', 'child-accounts-schema.sql', 'calendar-sync-schema.sql', 'chore-schema.sql','school-schema.sql', 'account-notifications-schema.sql', 'internet-schema.sql','family-notifications-schema.sql', 'account-deletion-schema.sql']) await db.query(await readFile(new URL(name, import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('internet-schema.sql', import.meta.url), 'utf8'));
    assert.equal(await verifySchema(db, schema, 37), 37);
    await db.query('CREATE TABLE fixture_auth_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)');
    await db.query('INSERT INTO fixture_auth_sessions(id,user_id) VALUES($1,$2)', [parent.sessionId, parent.user.id]);
    await db.query('INSERT INTO family_households(id,title,timezone) VALUES($1,$2,$3)', [household.id, household.title, household.timezone]);
    for (const p of [child, sibling]) await db.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,$3,'#00748c')", [p.personId, household.id, p.user.name]);
    for (const p of [parent, child, sibling]) await db.query('INSERT INTO family_members(household_id,user_id,name,email,role,person_id) VALUES($1,$2,$3,$4,$5,$6)', [household.id, p.user.id, p.user.name, `${p.user.id}@example.test`, p.role, p.personId || null]);
    for (const p of [child, sibling]) {
      await db.query('INSERT INTO fixture_auth_sessions(id,user_id) VALUES($1,$2)', [p.providerId, p.user.id]);
      await db.query("INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,user_id,provider_session_id,person_id,label) VALUES($1,$2,$3,'child',$4,$5,$6,'Fixture phone')", [p.mobileSessionId, household.id, randomUUID(), p.user.id, p.providerId, p.personId]);
    }
    await db.query("INSERT INTO family_devices(id,household_id,label,token_hash) VALUES($1,$2,'Frame','fixture-token-hash')", [frame.user.id, household.id]);

    await t.test('empty required list earns no credit and child inventory hides identities', async () => {
      const state = await snapshot(); assert.equal(state.credits.length, 0); assert.equal(state.progress[0].eligible, false);
      device = await saveManagedDevice(db, parent, null, { name: 'Fixture console', kind: 'console', personIds: [child.personId], macAddresses: ['02:11:22:33:44:55'], mutationId: randomUUID() });
      assert.equal((await snapshot()).devices[0].macAddresses, undefined);
      assert.equal((await snapshot(sibling)).devices.length, 0);
      await assert.rejects(saveManagedDevice(db, child, null, { mutationId: randomUUID() }), e => e.status === 403);
      await assert.rejects(saveManagedDevice(db, parent, null, { name: 'Duplicate', personIds: [sibling.personId], macAddresses: ['02:11:22:33:44:55'], mutationId: randomUUID() }), e => e.code === 'identity_in_use');
    });
    await t.test('concurrent final chores earn one immutable daily credit; reopening holds it', async () => {
      await Promise.all([createRoutine(), createRoutine()]);
      const rows = await transaction(db, c => ensureDailyOccurrences(c, household, today, { now }));
      await Promise.all(rows.map(row => change(row, true)));
      let state = await snapshot(); assert.equal(state.credits.length, 1); credit = state.credits[0]; assert.equal(credit.minutes, 60); assert.equal(credit.status, 'available');
      const completed = (await db.query('SELECT *,date::text FROM family_chore_occurrences ORDER BY id')).rows[0];
      const reopened = await change(completed, false); assert.equal((await snapshot()).credits[0].status, 'held');
      await change({ ...completed, version: reopened.version }, true);
      state = await snapshot(); assert.equal(state.credits.length, 1); assert.equal(state.credits[0].id, credit.id); assert.equal(state.credits[0].status, 'available');
      assert.equal((await db.query("SELECT id FROM family_notification_events WHERE type='reward_earned'")).rowCount, 1);
      const policy = state.policies[0]; await saveRewardPolicy(db, parent, child.personId, { expectedVersion: policy.version, rewardMinutes: 90 });
      assert.equal((await snapshot()).credits[0].minutes, 60, 'Policy edits do not rewrite earned credits.');
    });
    await t.test('unconfigured integration and bare frame credentials cannot start Internet', async () => {
      await assert.rejects(startInternetSession(db, child, { creditId: credit.id, deviceId: device.id, mutationId: randomUUID() }, { reward: true, env, now }), e => e.code === 'network_not_ready');
      for (const actor of [frame, sibling]) await assert.rejects(startInternetSession(db, actor, { creditId: credit.id, deviceId: device.id, mutationId: randomUUID() }, { reward: true, env, now }), e => [403, 404].includes(e.status));
      await assert.rejects(startInternetSession(db, frame, { personId: child.personId, deviceId: device.id, mutationId: randomUUID() }, { env, now }), e => e.status === 403);
    });
    await t.test('one-time frame codes are profile-scoped, bound to a frame and revoked with membership', async () => {
      const code = await createFrameAccessCode(db, child, { scope: 'child', personId: child.personId }, { env, now });
      const redeemed = await redeemFrameAccess(db, frame, { code: code.code }, { env, now });
      await assert.rejects(redeemFrameAccess(db, frame, { code: code.code }, { env, now }), e => e.code === 'invalid_unlock');
      const principal = await frameAuthorization(db, frame, redeemed.token, now); assert.equal(principal.personId, child.personId); assert.equal(principal.verifiedCapabilities.manageInternet, false);
      await assert.rejects(frameAuthorization(db, { ...frame, user: { id: randomUUID() } }, redeemed.token, now), e => e.code === 'invalid_unlock');
      await assert.rejects(createFrameAccessCode(db, child, { scope: 'parent' }, { env, now }), e => e.status === 403);
      await db.query('UPDATE family_members SET revoked_at=$2 WHERE user_id=$1', [child.user.id, now]);
      await assert.rejects(frameAuthorization(db, frame, redeemed.token, now), e => e.code === 'invalid_unlock');
      await db.query('UPDATE family_members SET revoked_at=NULL WHERE user_id=$1', [child.user.id]);
    });
    await t.test('caregiver permissions and owner transfer require explicit current parent authority', async () => {
      const adult = { ...parent, sessionId: randomUUID(), role: 'member', actor: 'user:caregiver', user: { id: randomUUID(), name: 'Fixture caregiver' } };
      await db.query("INSERT INTO family_members(household_id,user_id,name,email,role) VALUES($1,$2,'Caregiver','caregiver@example.test','member')", [household.id, adult.user.id]);
      await db.query('INSERT INTO fixture_auth_sessions(id,user_id) VALUES($1,$2)', [adult.sessionId, adult.user.id]);
      assert.deepEqual(await parentCapabilities(db, adult), { manageChores: false, manageInternet: false });
      await assert.rejects(changeMemberCapabilities(db, child, adult.user.id, { manageChores: true, manageInternet: true }), e => e.status === 403);
      await changeMemberCapabilities(db, parent, adult.user.id, { manageChores: true, manageInternet: false });
      assert.deepEqual(await parentCapabilities(db, adult), { manageChores: true, manageInternet: false });
      const code = await createFrameAccessCode(db, adult, { scope: 'parent' }, { env, now });
      const access = await redeemFrameAccess(db, frame, { code: code.code }, { env, now });
      const unlocked = await frameAuthorization(db, frame, access.token, now);
      assert.deepEqual(unlocked.verifiedCapabilities, { manageChores: true, manageInternet: false });
      await assert.rejects(transferOwnership(db, parent, { userId: child.user.id }), e => e.code === 'invalid_owner');
      assert.equal((await transferOwnership(db, parent, { userId: adult.user.id })).transferred, true);
      await assert.rejects(transferOwnership(db, parent, { userId: adult.user.id }), e => e.code === 'admin_required');
      assert.equal((await transferOwnership(db, { ...adult, role: 'admin' }, { userId: parent.user.id })).transferred, true);
      await db.query('DELETE FROM family_frame_authorizations WHERE created_by=$1', [adult.user.id]);
      await db.query('DELETE FROM family_members WHERE user_id=$1', [adult.user.id]);
      await db.query('DELETE FROM fixture_auth_sessions WHERE user_id=$1', [adult.user.id]);
    });
    await t.test('issuance rechecks provider sessions, current capabilities and deletion state inside its lock', async () => {
      await db.query('DELETE FROM fixture_auth_sessions WHERE id=$1', [parent.sessionId]);
      await assert.rejects(createFrameAccessCode(db, parent, { scope: 'parent' }, { env, now }), error => error.code === 'session_required');
      await db.query("INSERT INTO fixture_auth_sessions(id,user_id,not_after) VALUES($1,$2,clock_timestamp()-interval '1 second')", [parent.sessionId, parent.user.id]);
      await assert.rejects(createFrameAccessCode(db, parent, { scope: 'parent' }, { env, now }), error => error.code === 'session_required');
      await db.query('UPDATE fixture_auth_sessions SET not_after=NULL WHERE id=$1', [parent.sessionId]);
      await db.query("UPDATE fixture_auth_sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id=$1", [child.providerId]);
      await assert.rejects(createFrameAccessCode(db, child, { scope: 'child', personId: child.personId }, { env, now }), error => error.code === 'session_required');
      await db.query('UPDATE fixture_auth_sessions SET not_after=NULL WHERE id=$1', [child.providerId]);
      await db.query('UPDATE family_mobile_sessions SET revoked_at=$2 WHERE id=$1', [child.mobileSessionId, now]);
      await assert.rejects(createFrameAccessCode(db, child, { scope: 'child', personId: child.personId }, { env, now }), error => error.code === 'session_required');
      await db.query('UPDATE family_mobile_sessions SET revoked_at=NULL WHERE id=$1', [child.mobileSessionId]);
      await db.query("INSERT INTO family_account_deletion_jobs(user_id,stage) VALUES($1,'data_deleted')", [parent.user.id]);
      await assert.rejects(createFrameAccessCode(db, parent, { scope: 'parent' }, { env, now }), error => error.code === 'parent_required');
      await db.query('DELETE FROM family_account_deletion_jobs WHERE user_id=$1', [parent.user.id]);
      await db.query("UPDATE family_members SET role='member',manage_chores=false,manage_internet=false WHERE user_id=$1", [parent.user.id]);
      await assert.rejects(createFrameAccessCode(db, parent, { scope: 'parent' }, { env, now }), error => error.code === 'parent_required');
      await db.query("UPDATE family_members SET role='admin',manage_chores=true,manage_internet=true WHERE user_id=$1", [parent.user.id]);
    });
    await t.test('recovery waits for an in-flight issuance, then revokes its newly committed code', async () => {
      let entered, release;
      const waiting = new Promise(resolve => { entered = resolve; }), released = new Promise(resolve => { release = resolve; });
      issuanceBarrier = { entered, released };
      const issuing = createFrameAccessCode(db, parent, { scope: 'parent' }, { env, now });
      await waiting;
      // Global sign-out removes the provider session after the issuer already
      // checked it; final recovery revocation must wait for that transaction.
      await db.query('DELETE FROM fixture_auth_sessions WHERE id=$1', [parent.sessionId]);
      let finished = false;
      const recovering = revokeFrameAccessAfterRecovery(db, parent.user.id).then(() => { finished = true; });
      try {
        await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false);
        release(); const code = await issuing; await recovering;
        await assert.rejects(redeemFrameAccess(db, frame, { code: code.code }, { env, now }), error => error.code === 'invalid_unlock');
      } finally { release(); await Promise.allSettled([issuing, recovering]); }
      await db.query('INSERT INTO fixture_auth_sessions(id,user_id) VALUES($1,$2)', [parent.sessionId, parent.user.id]);
    });
    await t.test('an old queued issuance cannot create a code after global sign-out', async () => {
      const blocker = await db.connect(); await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`frame-unlock:${household.id}:${parent.user.id}`]);
      const issuing = createFrameAccessCode(db, parent, { scope: 'parent' }, { env, now });
      // Attach the rejection handler before releasing the blocked operation.
      const rejected = assert.rejects(issuing, error => error.code === 'session_required');
      try { await db.query('DELETE FROM fixture_auth_sessions WHERE id=$1', [parent.sessionId]); }
      finally { await blocker.query('COMMIT'); blocker.release(); }
      await rejected;
      await revokeFrameAccessAfterRecovery(db, parent.user.id);
      await db.query('INSERT INTO fixture_auth_sessions(id,user_id) VALUES($1,$2)', [parent.sessionId, parent.user.id]);
    });
    await t.test('ordinary mobile sign-out does not revoke an already delegated frame approval', async () => {
      const code = await createFrameAccessCode(db, child, { scope: 'child', personId: child.personId }, { env, now });
      const access = await redeemFrameAccess(db, frame, { code: code.code }, { env, now });
      await db.query('UPDATE family_mobile_sessions SET revoked_at=$2 WHERE id=$1', [child.mobileSessionId, now]);
      assert.equal((await frameAuthorization(db, frame, access.token, now)).personId, child.personId);
      await db.query('UPDATE family_mobile_sessions SET revoked_at=NULL WHERE id=$1', [child.mobileSessionId]);
    });
    await t.test('ordinary web sign-out preserves an existing grant but cannot issue another', async () => {
      const code = await createFrameAccessCode(db, parent, { scope: 'parent' }, { env, now });
      const access = await redeemFrameAccess(db, frame, { code: code.code }, { env, now });
      await db.query('DELETE FROM fixture_auth_sessions WHERE id=$1', [parent.sessionId]);
      assert.equal((await frameAuthorization(db, frame, access.token, now)).verifiedCapabilities.manageInternet, true);
      await assert.rejects(createFrameAccessCode(db, parent, { scope: 'parent' }, { env, now }), error => error.code === 'session_required');
      await db.query('INSERT INTO fixture_auth_sessions(id,user_id) VALUES($1,$2)', [parent.sessionId, parent.user.id]);
      await revokeFrameAccessAfterRecovery(db, parent.user.id);
    });
    await t.test('verified readiness allows exactly one atomic reservation, and duplicate requests replay', async () => {
      const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: ['02:11:22:33:44:55'], sourceZoneId: sourceZone, destinationZoneId: externalZone });
      const management = { ...plan.management, id: randomUUID() }, deny = { ...plan.deny, id: randomUUID() };
      policies.set(management.id, management); policies.set(deny.id, deny); ordered = [management.id, deny.id];
      for (const id of foreignAfterIds) policies.set(id, { id, name: 'Existing after-system security rule', enabled: true,
        action: { type: 'BLOCK' }, source: { zoneId: sourceZone }, destination: { zoneId: externalZone } });
      afterOrdered = [...foreignAfterIds];
      await db.query(`INSERT INTO family_network_integrations(household_id,site_id,source_zone_id,external_zone_id,state,management_host,pilot_checks,management_verified_at)
        VALUES($1,$2,$3,$4,'ready','forest-family-frame.vercel.app',$5::jsonb,$6)`, [household.id, site, sourceZone, externalZone, JSON.stringify(Object.fromEntries(requiredPilotChecks.map(key => [key, true]))), now]);
      const fingerprint = reviewedPolicyFingerprint([...policies.values()], { beforeSystemDefined: ordered, afterSystemDefined: afterOrdered }, { managementId: management.id, denyId: deny.id });
      await db.query("UPDATE family_managed_devices SET control_state='ready',observed_access='blocked',access_verified_at=$2,management_verified_at=$2,management_policy_id=$3,deny_policy_id=$4,reviewed_policy_fingerprint=$5 WHERE id=$1", [device.id, now, management.id, deny.id, fingerprint]);
      const body = { creditId: credit.id, deviceId: device.id, mutationId: randomUUID() };
      const results = await Promise.all([0, 1].map(() => startInternetSession(db, child, body, { reward: true, env, now })));
      assert.deepEqual(results[0], results[1]); session = results[0]; assert.equal(session.state, 'starting');
      assert.equal(session.endsAt, null); assert.equal(session.remainingSeconds, 3600);
      assert.equal((await snapshot()).credits[0].status, 'reserved');
      await assert.rejects(startInternetSession(db, child, { ...body, mutationId: randomUUID() }, { reward: true, env, now }), e => e.code === 'reward_unavailable');
      assert.equal((await db.query('SELECT id FROM family_internet_sessions')).rowCount, 1);
    });
    await t.test('ambiguous creation reconciles without duplicate grants or premature credit spending', async () => {
      ambiguousCreate = true;
      const activation = new Date(now.getTime() + 5 * 60_000);
      assert.equal((await worker(activation)).state, 'checking'); assert.equal(calls.creates, 1); assert.equal(calls.allows, 0);
      const planned = (await db.query('SELECT activation_planned_at,ends_at FROM family_internet_sessions WHERE id=$1', [session.id])).rows[0];
      assert.equal(planned.activation_planned_at.toISOString(), activation.toISOString());
      assert.equal(planned.ends_at.toISOString(), '2026-10-18T02:05:00.000Z', 'The five-minute queue delay cannot consume earned time.');
      assert.equal((await snapshot()).credits[0].status, 'reserved');
      const result = await worker(new Date(activation.getTime() + 31_000));
      assert.equal(result.state, 'active'); assert.equal(calls.creates, 1); assert.equal(calls.allows, 1);
      const state = await snapshot(); assert.equal(state.credits[0].status, 'spent'); session = state.sessions[0]; assert.equal(session.observedState, 'allowed');
      assert.equal(session.endsAt, planned.ends_at.toISOString(), 'Ambiguous retry never extends the planned window.');
    });
    await t.test('pause retains credit, freezes after confirmed blocking, and resumes with a bounded window', async () => {
      const at = new Date(now.getTime() + 10 * 60_000);
      await assert.rejects(changeInternetSession(db, sibling, session.id, { action: 'pause', expectedVersion: session.version, mutationId: randomUUID() }, { now: at }), e => e.status === 403);
      await changeInternetSession(db, parent, session.id, { action: 'pause', expectedVersion: session.version, mutationId: randomUUID() }, { now: at });
      failRead = true; assert.equal((await worker(at)).state, 'checking'); failRead = false;
      const retryAt = new Date(at.getTime() + 31_000); assert.equal((await worker(retryAt)).state, 'paused');
      session = (await snapshot(parent)).sessions[0]; assert.equal(session.endsAt, null); assert.ok(session.remainingSeconds <= 55 * 60); assert.ok(session.remainingSeconds > 54 * 60 - 5);
      const resumed = await changeInternetSession(db, parent, session.id, { action: 'resume', expectedVersion: session.version, mutationId: randomUUID() }, { now: retryAt });
      assert.equal(resumed.endsAt, null); assert.equal(resumed.remainingSeconds, session.remainingSeconds);
      const resumeAt = new Date(retryAt.getTime() + 5 * 60_000);
      assert.equal((await worker(resumeAt)).state, 'active'); session = (await snapshot(parent)).sessions[0];
      assert.ok(Date.parse(session.endsAt) - resumeAt >= (resumed.remainingSeconds - 60) * 1000, 'Resume queue wait preserves frozen time.');
      await assert.rejects(changeInternetSession(db, parent, session.id, { action: 'adjust', deltaMinutes: 15, expectedVersion: session.version - 1, mutationId: randomUUID() }, { now: retryAt }), e => e.code === 'version_conflict');
    });
    await t.test('parent adjustments and end disable only the session; management stays permanent', async () => {
      const at = new Date(now.getTime() + 12 * 60_000);
      await changeInternetSession(db, parent, session.id, { action: 'adjust', deltaMinutes: 15, expectedVersion: session.version, mutationId: randomUUID() }, { now: at });
      assert.equal((await worker(at)).state, 'active'); session = (await snapshot(parent)).sessions[0];
      await changeInternetSession(db, parent, session.id, { action: 'end', expectedVersion: session.version, mutationId: randomUUID() }, { now: at });
      assert.equal((await worker(at)).state, 'ended');
      const current = (await snapshot(parent)).sessions[0]; assert.equal(current.observedState, 'blocked');
      const baseline = [...policies.values()].filter(row => /:(management|deny)$/.test(row.description)); assert.equal(baseline.length, 2); assert.ok(baseline.every(p => p.enabled && p.schedule === null));
      assert.equal((await snapshot()).credits[0].status, 'spent');
    });
    await t.test('a gateway-bounded window is reconciled to ended without an open app', async () => {
      const at = new Date('2026-10-18T03:00:00Z');
      const grant = await startInternetSession(db, parent, { personId: child.personId, deviceId: device.id, minutes: 1, mutationId: randomUUID() }, { env, now: at });
      assert.equal((await worker(at)).state, 'active');
      const active = (await db.query('SELECT ends_at FROM family_internet_sessions WHERE id=$1', [grant.id])).rows[0];
      const cutoff = new Date(active.ends_at.getTime() + 1000);
      const expired = await worker(cutoff); assert.equal(expired.expiredQueued, 1); assert.equal(expired.state, 'ended');
      assert.equal((await db.query('SELECT observed_state FROM family_internet_sessions WHERE id=$1', [grant.id])).rows[0].observed_state, 'blocked');
    });
    await t.test('a parent end cannot race an in-flight allow at the provider', async () => {
      const at = new Date('2026-10-18T04:00:00Z');
      const grant = await startInternetSession(db, parent, { personId: child.personId, deviceId: device.id, minutes: 60, mutationId: randomUUID() }, { env, now: at });
      let enter, finish; const entered = new Promise(resolve => { enter = resolve; }), released = new Promise(resolve => { finish = resolve; });
      const replace = provider.replacePolicy;
      provider.replacePolicy = async (...args) => { if (args[3].enabled === true) { enter(); await released; } return replace(...args); };
      try {
        const starting = worker(at); await entered;
        await changeInternetSession(db, parent, grant.id, { action: 'end', expectedVersion: grant.version, mutationId: randomUUID() }, { now: at });
        assert.equal((await worker(at)).processed, 0, 'Live lease prevents a concurrent BLOCK/ALLOW race.');
        finish(); assert.equal((await starting).state, 'superseded');
        assert.equal((await worker(at)).state, 'ended');
        const allowance = [...policies.values()].find(p => p.description?.endsWith(`session:${grant.id}`)); assert.equal(allowance.enabled, false);
      } finally { finish?.(); provider.replacePolicy = replace; }
    });
    await t.test('all-day preserves an explicit home-midnight cutoff through DST and pause', async () => {
      const at = new Date('2026-11-01T06:01:00Z');
      const grant = await startInternetSession(db, parent, { personId: child.personId, deviceId: device.id, allDay: true, mutationId: randomUUID() }, { env, now: at });
      assert.equal(grant.endsAt, '2026-11-02T07:00:00.000Z'); assert.ok(grant.remainingSeconds > 86400);
      assert.equal((await worker(new Date(at.getTime() + 5 * 60_000))).state, 'active');
      const allowance = [...policies.values()].find(p => p.description?.endsWith(`session:${grant.id}`));
      assert.deepEqual(allowance.schedule, { mode: 'ONE_TIME_ONLY', date: '2026-11-01', timeFilter: null });
      let current = (await db.query('SELECT * FROM family_internet_sessions WHERE id=$1', [grant.id])).rows[0];
      await changeInternetSession(db, parent, grant.id, { action: 'pause', expectedVersion: current.version, mutationId: randomUUID() }, { now: at });
      assert.equal((await worker(at)).state, 'paused');
      current = (await db.query('SELECT * FROM family_internet_sessions WHERE id=$1', [grant.id])).rows[0]; assert.equal(new Date(current.ends_at).toISOString(), grant.endsAt);
      assert.equal((await worker(new Date(grant.endsAt))).state, 'ended', 'Paused all-day time cannot carry into another day.');
    });
    let siblingCredit;
    await t.test('moving an unfinished earning source cannot restore a credit; a parent excuse is explicit', async () => {
      await Promise.all([createRoutine(sibling.personId), createRoutine(sibling.personId)]);
      const rows = (await transaction(db, c => ensureDailyOccurrences(c, household, today, { now }))).filter(row => row.person_id === sibling.personId);
      await Promise.all(rows.map(row => change(row, true, sibling)));
      siblingCredit = (await snapshot(sibling)).credits[0]; assert.equal(siblingCredit.status, 'available');
      let current = (await db.query('SELECT *,date::text FROM family_chore_occurrences WHERE id=$1', [rows[0].id])).rows[0];
      const reopened = await change(current, false, sibling);
      const moved = await changeChoreOccurrence(db, parent, current.id, { action: 'reschedule', toDate: '2026-10-18', expectedVersion: reopened.version, mutationId: randomUUID(), reason: 'Fixture move' }, { now, onChange: (c, event) => syncChoreReward(c, event, { now }) });
      assert.equal((await getRequiredProgress(db, household.id, sibling.personId, today)).eligible, true);
      assert.equal((await snapshot(sibling)).credits[0].status, 'held', 'Stored earning sources still include the unfinished moved chore.');
      await changeChoreOccurrence(db, parent, current.id, { action: 'skip', expectedVersion: moved.version, mutationId: randomUUID(), reason: 'Parent explicitly excused this source' }, { now });
      assert.equal((await snapshot(sibling)).credits[0].status, 'available');
    });
    await t.test('an applied but unconfirmed ALLOW ended by a parent holds the credit for explicit review', async () => {
      const siblingDevice = await saveManagedDevice(db, parent, null, { name: 'Sibling fixture', personIds: [sibling.personId], macAddresses: ['02:11:22:33:44:66'], mutationId: randomUUID() });
      const plan = managedPolicyPlan({ deviceId: siblingDevice.id, macAddresses: ['02:11:22:33:44:66'], sourceZoneId: sourceZone, destinationZoneId: externalZone });
      const management = { ...plan.management, id: randomUUID() }, deny = { ...plan.deny, id: randomUUID() };
      policies.set(management.id, management); policies.set(deny.id, deny); ordered.push(management.id, deny.id);
      const known = (await db.query('SELECT policy_id FROM family_internet_sessions WHERE policy_id IS NOT NULL')).rows.map(row => row.policy_id);
      assert.ok(known.every(id => policies.get(id).enabled === false));
      const fingerprint = reviewedPolicyFingerprint([...policies.values()], { beforeSystemDefined: ordered, afterSystemDefined: afterOrdered }, { managementId: management.id, denyId: deny.id, ignoredSessionIds: known });
      await db.query("UPDATE family_managed_devices SET control_state='ready',observed_access='blocked',access_verified_at=$2,management_verified_at=$2,management_policy_id=$3,deny_policy_id=$4,reviewed_policy_fingerprint=$5 WHERE id=$1", [siblingDevice.id, now, management.id, deny.id, fingerprint]);
      const grant = await startInternetSession(db, sibling, { creditId: siblingCredit.id, deviceId: siblingDevice.id, mutationId: randomUUID() }, { reward: true, env, now });
      const replace = provider.replacePolicy; let failed = false;
      provider.replacePolicy = async (...args) => { const result = await replace(...args); if (args[3].enabled && !failed) { failed = true; throw Error('Response lost after ALLOW'); } return result; };
      try { assert.equal((await worker()).state, 'checking'); } finally { provider.replacePolicy = replace; }
      const row = (await db.query('SELECT * FROM family_internet_sessions WHERE id=$1', [grant.id])).rows[0];
      assert.equal(row.started_at, null); assert.ok(row.allow_attempted_at);
      await changeInternetSession(db, parent, grant.id, { action: 'end', expectedVersion: row.version, mutationId: randomUUID() }, { now });
      assert.equal((await worker()).state, 'ended'); assert.equal((await snapshot(sibling)).credits[0].status, 'review');
      const body = { action: 'restore', reason: 'Parent reviewed the uncertain test window', mutationId: randomUUID() };
      await assert.rejects(resolveRewardReview(db, sibling, siblingCredit.id, body, { now }), e => e.status === 403);
      const restored = await resolveRewardReview(db, parent, siblingCredit.id, body, { now }); assert.equal(restored.status, 'available');
      assert.deepEqual(await resolveRewardReview(db, parent, siblingCredit.id, body, { now }), restored);
    });
    let freeDevice, sharedDevice;
    const deviceRow = async id => (await db.query('SELECT * FROM family_managed_devices WHERE id=$1', [id])).rows[0];
    const control = async (id, access, at = now) => changeDeviceAccess(db, parent, id, { access, expectedVersion: (await deviceRow(id)).version, mutationId: randomUUID() }, { env, now: at });
    await t.test('default access separates shared earned devices from parent-only free devices', async () => {
      freeDevice = await saveManagedDevice(db, parent, null, { name: 'Free TV', kind: 'tv', defaultAccess: 'allowed', personIds: [child.personId, sibling.personId], macAddresses: ['02:11:22:33:44:77'], mutationId: randomUUID() });
      sharedDevice = await saveManagedDevice(db, parent, null, { name: 'Shared console', kind: 'console', defaultAccess: 'blocked', personIds: [child.personId, sibling.personId], macAddresses: ['02:11:22:33:44:88'], mutationId: randomUUID() });
      assert.equal(freeDevice.defaultAccess, 'allowed'); assert.equal(freeDevice.desiredAccess, 'allowed'); assert.equal(sharedDevice.defaultAccess, 'blocked');
      for (const device of [freeDevice, sharedDevice]) {
        const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.macAddresses, sourceZoneId: sourceZone, destinationZoneId: externalZone });
        const management = { ...plan.management, id: randomUUID() }, deny = { ...plan.deny, enabled: device.defaultAccess === 'blocked', id: randomUUID() };
        policies.set(management.id, management); policies.set(deny.id, deny); ordered.push(management.id, deny.id);
        await db.query("UPDATE family_managed_devices SET control_state='ready',management_verified_at=$2,management_policy_id=$3,deny_policy_id=$4,observed_access=desired_access,access_verified_at=$2 WHERE id=$1", [device.id, now, management.id, deny.id]);
      }
      const first = await deviceRow(freeDevice.id), ignored = (await db.query('SELECT policy_id FROM family_internet_sessions WHERE policy_id IS NOT NULL')).rows.map(s => s.policy_id);
      const digest = reviewedPolicyFingerprint([...policies.values()], { beforeSystemDefined: ordered, afterSystemDefined: afterOrdered }, { managementId: first.management_policy_id, denyId: first.deny_policy_id, ignoredSessionIds: ignored });
      await db.query("UPDATE family_managed_devices SET reviewed_policy_fingerprint=$1 WHERE control_state='ready'", [digest]);
      for (const actor of [child, sibling]) {
        const data = await snapshot(actor);
        assert.equal(data.devices.find(d => d.id === freeDevice.id).rewardAvailable, false);
        assert.equal(data.devices.find(d => d.id === sharedDevice.id).rewardAvailable, true);
      }
      await assert.rejects(changeDeviceAccess(db, child, sharedDevice.id, { access: 'allowed', expectedVersion: 1, mutationId: randomUUID() }, { env, now }), e => e.status === 403);
      await assert.rejects(startInternetSession(db, sibling, { creditId: siblingCredit.id, deviceId: freeDevice.id, mutationId: randomUUID() }, { reward: true, env, now }), e => e.code === 'device_not_reward');
    });
    await t.test('a shared device reserved by the other child disappears without disclosing their session', async () => {
      const session = await startInternetSession(db, parent, { personId: sibling.personId, deviceId: sharedDevice.id, minutes: 60, mutationId: randomUUID() }, { env, now });
      const data = await snapshot(child);
      assert.equal(data.sessions.some(s => s.id === session.id), false);
      assert.equal(data.devices.find(d => d.id === sharedDevice.id).rewardAvailable, false);
      assert.equal((await worker()).state, 'active');
      const off = await control(sharedDevice.id, 'blocked'); assert.equal(off.accessPending, true); assert.equal(off.observedAccess, 'unknown');
      for (let n = 0; n < 4; n++) await worker(new Date(now.getTime() + (n + 1) * 2000));
      assert.equal((await deviceRow(sharedDevice.id)).observed_access, 'blocked');
      const ended = (await db.query('SELECT * FROM family_internet_sessions WHERE id=$1', [session.id])).rows[0]; assert.equal(ended.state, 'ended'); assert.equal(ended.observed_state, 'blocked');
      assert.equal((await snapshot(child)).devices.find(d => d.id === sharedDevice.id).rewardAvailable, true);
    });
    await t.test('parent cutoff during an applied but unconfirmed On reconciles before blocking', async () => {
      await control(freeDevice.id, 'blocked'); assert.equal((await worker()).state, 'blocked');
      assert.equal((await snapshot(sibling)).devices.find(d => d.id === freeDevice.id).rewardAvailable, false, 'A free device never enters the earned pool, even when blocked.');
      const replace = provider.replacePolicy; let dropped = false;
      provider.replacePolicy = async (...args) => { const result = await replace(...args); if (args[3].enabled === false && !dropped) { dropped = true; throw Error('On response lost'); } return result; };
      await control(freeDevice.id, 'allowed');
      try { assert.equal((await worker()).state, 'checking'); } finally { provider.replacePolicy = replace; }
      assert.equal((await deviceRow(freeDevice.id)).observed_access, 'unknown');
      const off = await control(freeDevice.id, 'blocked'); assert.equal(off.accessPending, true);
      assert.equal((await worker()).state, 'allowed', 'Reconcile the old applied On before publishing the newer cutoff.');
      assert.equal((await worker()).state, 'blocked');
      const final = await deviceRow(freeDevice.id); assert.equal(final.desired_access, 'blocked'); assert.equal(final.observed_access, 'blocked'); assert.equal(policies.get(final.deny_policy_id).enabled, true);
      const digests = (await db.query("SELECT DISTINCT reviewed_policy_fingerprint FROM family_managed_devices WHERE control_state='ready'")).rows; assert.equal(digests.length, 1, 'Only the known enabled-bit change rebases every ready device.');
    });
    await t.test('confirmed parent cutoff clears terminal network uncertainty without rewriting reward accounting', async () => {
      const id = randomUUID();
      await db.query(`INSERT INTO family_internet_sessions(id,household_id,person_id,device_id,source,state,desired_state,observed_state,requested_at,remaining_seconds,allocated_seconds,policy_snapshot,created_by)
        VALUES($1,$2,$3,$4,'parent','failed','blocked','unknown',$5,0,0,'{}','fixture')`, [id, household.id, child.personId, sharedDevice.id, new Date(now.getTime() + 60_000)]);
      assert.equal((await snapshot(child)).devices.find(d => d.id === sharedDevice.id).rewardAvailable, false);
      await control(sharedDevice.id, 'blocked'); assert.equal((await worker()).state, 'blocked');
      const failed = (await db.query('SELECT * FROM family_internet_sessions WHERE id=$1', [id])).rows[0];
      assert.equal(failed.state, 'failed'); assert.equal(failed.observed_state, 'blocked'); assert.ok(failed.verified_at);
      assert.equal((await snapshot(child)).devices.find(d => d.id === sharedDevice.id).rewardAvailable, true);
    });
    await t.test('foreign policy drift is never accepted as part of a device toggle', async () => {
      const extra = { ...policies.get((await deviceRow(freeDevice.id)).deny_policy_id), id: randomUUID(), description: 'foreign security rule' };
      policies.set(extra.id, extra); ordered.push(extra.id);
      const blocks = calls.blocks; await control(freeDevice.id, 'allowed'); assert.equal((await worker()).state, 'checking');
      assert.equal(calls.blocks, blocks); assert.equal((await deviceRow(freeDevice.id)).observed_access, 'unknown');
      policies.delete(extra.id); ordered = ordered.filter(id => id !== extra.id);
      assert.equal((await worker(new Date(now.getTime() + 31_000))).state, 'allowed');
    });
  } finally {
    if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});
