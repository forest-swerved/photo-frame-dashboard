import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';
import { authenticate } from './auth.js';
import { handleRequest } from './app.js';
import { digest, encryptCredentials } from './credentials.js';
import { claimHousehold, createChore, createFramePair, createInvite, createPerson, changePerson, joinHousehold, redeemFramePair, setCompletion } from './household.js';
import { calendarSnapshot, connectCalendar, removeCalendar, selectCalendars } from './calendar-service.js';
import { enforcePairRateLimit } from './pair-rate-limit.js';
import { verifySchema } from './verify-schema.js';

// Run explicitly: FAMILY_RUN_DB_TESTS=1 node --env-file=.env.test.local --test server/backend.integration.test.js
// This refuses all databases except the dedicated family_frame_tests database.
const enabled = Boolean(process.env.DATABASE_URL && process.env.FAMILY_RUN_DB_TESTS === '1');
const origin = 'https://family.example';
const request = (path, method = 'GET', body, headers = {}) => new Request(`${origin}/api/${path}`, {
  method, headers: { ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const user = id => ({ authType: 'user', actor: `user:${id}`, user: { id, name: id, email: `${id}@example.test` }, role: null, household: null });

test('isolated Postgres authorization and concurrency boundaries', { skip: !enabled, timeout: 180_000 }, async t => {
  const pool = createPool(process.env, { migration: true, max: 10 });
  const schema = `family_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  const ownerId = randomUUID();
  const env = { FAMILY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), FAMILY_BOOTSTRAP_HASH: digest('4826'), FAMILY_BOOTSTRAP_USER_ID: ownerId, VERCEL: '1' };
  const db = {
    async connect() {
      const client = await pool.connect();
      try { await client.query(`SET search_path TO ${schema}, pg_catalog`); return client; }
      catch (error) { client.release(); throw error; }
    },
    async query(sql, values) { const client = await this.connect(); try { return await client.query(sql, values); } finally { client.release(); } },
  };
  let admin;
  try {
    const identity = (await pool.query('SELECT current_database() AS name,current_user=session_user AS same_role')).rows[0];
    assert.equal(identity.name, 'family_frame_tests', 'Refusing test DDL outside the separate test database.');
    assert.equal(identity.same_role, true);
    assert.match(schema, /^family_test_[a-f0-9]{32}$/);
    await pool.query(`CREATE SCHEMA ${schema}`);
    created = true;
    for (const name of ['schema.sql','mobile-schema.sql','notifications-schema.sql','child-accounts-schema.sql','calendar-sync-schema.sql','chore-schema.sql','school-schema.sql','account-notifications-schema.sql','internet-schema.sql','family-notifications-schema.sql','account-deletion-schema.sql']) await db.query(await readFile(new URL(name, import.meta.url), 'utf8'));

    await t.test('all server-only tables have RLS, owner access, and no PUBLIC policies', async () => {
      assert.equal(await verifySchema(db, schema, 37), 37);
    });

    await t.test('a short setup code cannot be claimed by a different signed-in account', async () => {
      await assert.rejects(claimHousehold(db, user('owner-b'), { bootstrapCode: '4826' }, env), error => error.code === 'invalid_claim');
      assert.equal((await db.query('SELECT * FROM family_households')).rowCount, 0);
      assert.equal((await db.query('SELECT * FROM family_members')).rowCount, 0);
    });

    await t.test('two simultaneous valid short-code claims create one owner', async () => {
      const results = await Promise.allSettled([0, 1].map(() => claimHousehold(db, user(ownerId), { bootstrapCode: '4826' }, env)));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'already_claimed');
      const session = results.find(result => result.status === 'fulfilled').value;
      admin = { ...user(session.user.id), role: 'admin', household: session.household };
      assert.equal((await db.query('SELECT * FROM family_households')).rowCount, 1);
      assert.equal((await db.query("SELECT * FROM family_members WHERE role='admin'")).rowCount, 1);
    });

    await t.test('an invitation is consumed once despite concurrent joins', async () => {
      const invite = await createInvite(db, admin, {});
      const results = await Promise.allSettled([randomUUID(), randomUUID()].map(id => joinHousehold(db, user(id), { token: invite.token })));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'invalid_invite');
      assert.equal((await db.query("SELECT * FROM family_members WHERE role='member'")).rowCount, 1);
    });

    await t.test('new pairing code invalidates the old code and redemption is atomic', async () => {
      const old = await createFramePair(db, admin, {}, env);
      const current = await createFramePair(db, admin, { label: 'Kitchen' }, env);
      assert.match(current.code, /^\d{6}$/);
      await assert.rejects(redeemFramePair(db, { code: old.code }, env), error => error.code === 'invalid_pair');
      const results = await Promise.allSettled([0, 1].map(() => redeemFramePair(db, { code: current.code }, env)));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal((await db.query('SELECT * FROM family_devices')).rowCount, 1);
      const result = results.find(result => result.status === 'fulfilled').value;
      assert.equal('token' in result.data, false);
      assert.match(result.cookie, /HttpOnly; SameSite=Strict/);
      const frameRequest = request('session', 'GET', undefined, { cookie: result.cookie.split(';')[0] });
      assert.equal((await authenticate(frameRequest, db)).role, 'frame');
      await db.query('UPDATE family_devices SET revoked_at=now() WHERE id=$1', [result.data.device.id]);
      await assert.rejects(authenticate(frameRequest, db), error => error.code === 'device_revoked');
    });

    await t.test('durable per-IP limits count invalid and valid attempts concurrently', async () => {
      await db.query('DELETE FROM family_rate_limits');
      const seconds = Number((await db.query('SELECT extract(second FROM now()) AS seconds')).rows[0].seconds);
      if (seconds > 50) await new Promise(resolve => setTimeout(resolve, Math.ceil(61 - seconds) * 1000));
      const pair = await createFramePair(db, admin, {}, env);
      // Five valid / four invalid means every possible first-five scheduling
      // contains a valid request, without relying on network arrival order.
      const results = await Promise.all(Array.from({ length: 9 }, (_, index) => handleRequest(request('frame-pairs/redeem', 'POST', { code: index % 2 ? 'invalid' : pair.code }, { 'x-vercel-forwarded-for': '192.0.2.44' }), { db, env })));
      assert.equal(results.filter(result => result.status !== 429).length, 5);
      assert.equal(results.filter(result => result.status === 200).length, 1);
      assert.equal((await db.query("SELECT attempts FROM family_rate_limits WHERE bucket_key='pair:global'")).rows[0].attempts, 9);
    });

    await t.test('a global durable limit applies across different client IPs', async () => {
      await db.query('DELETE FROM family_rate_limits');
      // Keep the fixed-minute window from rolling during the concurrent test.
      const seconds = Number((await db.query('SELECT extract(second FROM now()) AS seconds')).rows[0].seconds);
      if (seconds > 43) await new Promise(resolve => setTimeout(resolve, Math.ceil(61 - seconds) * 1000));
      const results = await Promise.allSettled(Array.from({ length: 35 }, (_, index) => enforcePairRateLimit(db, request('frame-pairs/redeem', 'POST', {}, { 'x-vercel-forwarded-for': `192.0.2.${index + 1}` }), env)));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 30);
      assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'pair_rate_limited'));
      assert.equal((await db.query("SELECT attempts FROM family_rate_limits WHERE bucket_key='pair:global'")).rows[0].attempts, 35);
    });

    await t.test('completion retries replay exactly and concurrent stale writes conflict', async () => {
      const chore = await createChore(db, admin, { title: 'Feed pets' });
      const mutation = { completed: true, expectedVersion: 0, mutationId: randomUUID(), reason: 'Synthetic historical fixture' };
      const results = await Promise.all([0, 1].map(() => setCompletion(db, admin, chore.id, '2026-10-15', mutation)));
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0].version, 1);
      assert.equal((await db.query('SELECT * FROM family_completions')).rowCount, 1);
      assert.equal((await db.query('SELECT * FROM family_mutations')).rowCount, 1);
      await assert.rejects(setCompletion(db, admin, chore.id, '2026-10-15', { ...mutation, completed: false }), error => error.code === 'mutation_reused');
      const unchanged = await setCompletion(db, admin, chore.id, '2026-10-15', { completed: true, expectedVersion: 1, mutationId: randomUUID(), reason: 'Synthetic historical fixture' });
      assert.equal(unchanged.version, 1);
      const simultaneous = await Promise.allSettled([0, 1].map(() => setCompletion(db, admin, chore.id, '2026-10-15', { completed: false, expectedVersion: 1, mutationId: randomUUID(), reason: 'Synthetic historical fixture' })));
      assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(simultaneous.find(result => result.status === 'rejected').reason.code, 'version_conflict');
      assert.equal((await db.query('SELECT version FROM family_completions')).rows[0].version, 2);
    });

    await t.test('foreign household IDs cannot edit or complete existing objects', async () => {
      const person = await createPerson(db, admin, { name: 'Child' });
      const chore = await createChore(db, admin, { title: 'Clean room', personId: person.id });
      const outsider = { ...admin, household: { ...admin.household, id: randomUUID() } };
      await assert.rejects(changePerson(db, outsider, person.id, { name: 'Changed', expectedVersion: 1 }), error => error.status === 404);
      await assert.rejects(createChore(db, outsider, { title: 'Foreign', personId: person.id }), error => error.status === 404);
      await assert.rejects(setCompletion(db, outsider, chore.id, '2026-10-15', { completed: true, expectedVersion: 0, mutationId: randomUUID(), reason: 'Synthetic historical fixture' }), error => error.status === 404);
      assert.equal((await db.query('SELECT name FROM family_people WHERE id=$1', [person.id])).rows[0].name, 'Child');
    });

    await t.test('an in-flight old calendar selection cannot republish its snapshot', async () => {
      await db.query('INSERT INTO family_calendar_connections(household_id,credentials,calendars,selected_ids) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb)', [admin.household.id,
        JSON.stringify(encryptCredentials(admin.household.id, { username: 'fixture', appPassword: 'fixture' }, env)), JSON.stringify([{ id: 'old' }, { id: 'new' }]), JSON.stringify(['old'])]);
      let unblock;
      const blocked = new Promise(resolve => { unblock = resolve; });
      let started;
      const called = new Promise(resolve => { started = resolve; });
      const pending = calendarSnapshot(db, admin, '2026-10-01', '2026-11-01', { env, sync: async () => {
        started(); await blocked;
        return { events: [{ id: 'old-event' }], coverage: { complete: true, truncated: false }, lastSuccessfulSyncAt: new Date().toISOString() };
      } });
      await called;
      await selectCalendars(db, admin, { calendarIds: ['new'] });
      unblock();
      assert.equal((await pending).status, 'loading');
      assert.equal((await db.query('SELECT * FROM family_calendar_cache')).rowCount, 0);
    });

    await t.test('disconnect and reconnect cannot publish old account events when version resets', async () => {
      await removeCalendar(db, admin);
      await connectCalendar(db, admin, { username: 'old@example.test', appPassword: 'fixture-old' }, env, async () => [{ id: 'old' }]);
      await selectCalendars(db, admin, { calendarIds: ['old'] });
      let unblock;
      const blocked = new Promise(resolve => { unblock = resolve; });
      let started;
      const called = new Promise(resolve => { started = resolve; });
      const pending = calendarSnapshot(db, admin, '2026-10-01', '2026-11-01', { env, sync: async () => {
        started(); await blocked;
        return { events: [{ id: 'private-old-account-event' }], coverage: { complete: true, truncated: false }, lastSuccessfulSyncAt: new Date().toISOString() };
      } });
      await called;
      await removeCalendar(db, admin);
      await connectCalendar(db, admin, { username: 'new@example.test', appPassword: 'fixture-new' }, env, async () => [{ id: 'new' }]);
      await selectCalendars(db, admin, { calendarIds: ['new'] });
      unblock();
      const result = await pending;
      assert.equal(result.status, 'loading');
      assert.deepEqual(result.events, []);
      assert.equal((await db.query('SELECT * FROM family_calendar_cache')).rowCount, 0);
    });

    await t.test('a failed in-flight sync cannot revive a cache cleared by calendar selection', async () => {
      await removeCalendar(db, admin);
      await connectCalendar(db, admin, { username: 'fixture@example.test', appPassword: 'fixture' }, env, async () => [{ id: 'old' }, { id: 'new' }]);
      await selectCalendars(db, admin, { calendarIds: ['old'] });
      await calendarSnapshot(db, admin, '2026-10-01', '2026-11-01', { env, sync: async () => ({ events: [{ id: 'previous-old-event' }], coverage: { complete: true, truncated: false }, lastSuccessfulSyncAt: new Date().toISOString() }) });
      let unblock;
      const blocked = new Promise(resolve => { unblock = resolve; });
      let started;
      const called = new Promise(resolve => { started = resolve; });
      const pending = calendarSnapshot(db, admin, '2026-10-01', '2026-11-01', { env, force: true, sync: async () => {
        started(); await blocked; throw new Error('private provider failure');
      } });
      await called;
      await selectCalendars(db, admin, { calendarIds: ['new'] });
      unblock();
      const result = await pending;
      assert.equal(result.status, 'loading');
      assert.deepEqual(result.events, []);
      assert.equal((await db.query('SELECT * FROM family_calendar_cache')).rowCount, 0);
    });
    await t.test('home timezone changes preserve current settings and cannot invalidate enrolled network schedules', async () => {
      const patch = body => handleRequest(request('settings', 'PATCH', body), { db, env, authenticate: async () => admin });
      await db.query(`INSERT INTO family_network_integrations(household_id,site_id,source_zone_id,external_zone_id,state,management_host,pilot_checks)
        VALUES($1,$2,$3,$4,'ready','forest-family-frame.vercel.app','{"midnight":true}')`, [admin.household.id, randomUUID(), randomUUID(), randomUUID()]);
      assert.equal((await patch({ timezone: 'America/New_York' })).status, 200);
      const current = await patch({ title: 'Updated fixture family' });
      assert.equal((await current.json()).data.household.timezone, 'America/New_York', 'A stale authenticated household snapshot cannot restore its old timezone.');
      const integration = (await db.query('SELECT state,pilot_checks FROM family_network_integrations WHERE household_id=$1', [admin.household.id])).rows[0];
      assert.equal(integration.state, 'pilot_required'); assert.deepEqual(integration.pilot_checks, {});
      const person = await createPerson(db, admin, { name: 'Timezone fixture' }), deviceId = randomUUID();
      await db.query(`INSERT INTO family_managed_devices(id,household_id,name,person_ids,mac_addresses,control_state,management_policy_id)
        VALUES($1,$2,'Timezone fixture',ARRAY[$3::uuid],ARRAY['02:12:34:56:78:90'],'ready',$4)`, [deviceId, admin.household.id, person.id, randomUUID()]);
      const denied = await patch({ timezone: 'America/Denver' }); assert.equal(denied.status, 409); assert.equal((await denied.json()).error.code, 'network_timezone_locked');
      await db.query("UPDATE family_managed_devices SET control_state='unenrolled',management_policy_id=NULL WHERE id=$1", [deviceId]);
      const sessionId = randomUUID();
      await db.query(`INSERT INTO family_internet_sessions(id,household_id,person_id,device_id,source,state,desired_state,requested_at,remaining_seconds,allocated_seconds,policy_snapshot,created_by)
        VALUES($1,$2,$3,$4,'parent','paused','blocked',now(),60,60,'{}','user:fixture')`, [sessionId, admin.household.id, person.id, deviceId]);
      assert.equal((await patch({ timezone: 'America/Denver' })).status, 409, 'Paused time is still a nonterminal home-timezone commitment.');
      await db.query("UPDATE family_internet_sessions SET state='ended' WHERE id=$1", [sessionId]);
      assert.equal((await patch({ timezone: 'America/Denver' })).status, 200);
    });
  } finally {
    if (created) {
      assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests');
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
    await pool.end();
  }
});
