import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';
import { authenticate } from './auth.js';
import { digest } from './credentials.js';
import { handleRequest } from './app.js';
import { changePerson, createChore, createInvite, householdSnapshot, joinHousehold, revokeHouseholdMember, setCompletion } from './household.js';
import { authenticateMobile, createMobileSession } from './mobile.js';
import { notificationInbox, processNotifications, registerPush } from './notifications.js';

const enabled = Boolean(process.env.FAMILY_RUN_DB_TESTS === '1' && process.env.DATABASE_URL);
test('verified child account onboarding, concurrency, and live scope boundaries', { skip: !enabled, timeout: 180_000 }, async t => {
  const pool = createPool(process.env, { migration: true, max: 10 });
  const schema = `family_test_${randomUUID().replaceAll('-', '')}`;
  const household = { id: randomUUID(), title: 'Account test household', timezone: 'America/Denver' };
  const profiles = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
  const accounts = { parent: { id: randomUUID(), sessionId: randomUUID(), email: 'parent@example.invalid' }, a: { id: randomUUID(), sessionId: randomUUID(), email: 'child-a@example.invalid' }, b: { id: randomUUID(), sessionId: randomUUID(), email: 'child-b@example.invalid' } };
  const user = account => ({ authType: 'user', actor: `user:${account.id}`, user: { id: account.id, email: account.email, name: 'Untrusted account name' }, sessionId: account.sessionId, household: null, role: null });
  const parent = { ...user(accounts.parent), household, role: 'admin' };
  const env = { FAMILY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  const db = {
    async connect() { const client = await pool.connect(); try { await client.query(`SET search_path TO ${schema},pg_catalog`); return client; } catch (error) { client.release(); throw error; } },
    async query(sql, params) { const client = await this.connect(); try { return await client.query(sql, params); } finally { client.release(); } },
  };
  const mobileRequest = token => new Request('https://family.example/api/mobile/session', { headers: { authorization: `FamilyMobile ${token}` } });
  const claims = account => ({ sub: account.id, session_id: account.sessionId, email: account.email, user_metadata: { role: 'admin', personId: profiles.b } });
  const web = account => authenticate(new Request('https://family.example/api/session', { headers: { authorization: 'Bearer fixture' } }), db, { verifyJwt: async () => claims(account) });
  const accepted = async (account, invitation) => joinHousehold(db, user(account), { token: invitation.token }, { getVerifiedEmail: async () => account.email });
  const joinRequest = (principal, token, providerUser) => handleRequest(new Request('https://family.example/api/join', { method: 'POST', headers: { origin: 'https://family.example', authorization: 'Bearer fixture-access', 'content-type': 'application/json' }, body: JSON.stringify({ token }) }),
    { db, authenticate: async () => principal, createAuthContext: () => ({ client: { auth: { getUser: async () => ({ data: { user: providerUser }, error: null }) } } }) });
  let created = false, childA, mobileA, mobileParent;
  try {
    const identity = (await pool.query('SELECT current_database() AS name,current_user=session_user AS same_role')).rows[0];
    assert.equal(identity.name, 'family_frame_tests', 'Refusing test DDL outside the separate test database.');
    assert.equal(identity.same_role, true); assert.match(schema, /^family_test_[a-f0-9]{32}$/);
    await pool.query('CREATE SCHEMA IF NOT EXISTS family_internal');
    await pool.query('CREATE TABLE IF NOT EXISTS family_internal.auth_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)');
    for (const account of Object.values(accounts)) await pool.query('INSERT INTO family_internal.auth_sessions(id,user_id) VALUES($1,$2)', [account.sessionId, account.id]);
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    for (const name of ['schema.sql','mobile-schema.sql','notifications-schema.sql']) await db.query(await readFile(new URL(name, import.meta.url), 'utf8'));
    await db.query('INSERT INTO family_households(id,title,timezone) VALUES($1,$2,$3)', [household.id, household.title, household.timezone]);
    await db.query("INSERT INTO family_members(household_id,user_id,name,email,role) VALUES($1,$2,'Parent',$3,'admin')", [household.id, accounts.parent.id, accounts.parent.email]);
    for (const [key, id] of Object.entries(profiles)) await db.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,$3,'#00aabb')", [id, household.id, `Test profile ${key}`]);
    const legacyId = randomUUID();
    await db.query("INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,person_id,label) VALUES($1,$2,$3,'child',$4,'Legacy anonymous child')", [legacyId, household.id, digest('l'.repeat(43)), profiles.a]);
    await db.query("INSERT INTO family_mobile_pairs(id,household_id,person_id,code_hash,label,expires_at) VALUES($1,$2,$3,$4,'Legacy pair',now()+interval '1 hour')", [randomUUID(), household.id, profiles.a, digest(randomUUID())]);
    const migration = await readFile(new URL('child-accounts-schema.sql', import.meta.url), 'utf8');
    await db.query(migration); await db.query(migration);

    await t.test('repeated migration retires anonymous credentials and rejects new anonymous active sessions', async () => {
      assert.ok((await db.query('SELECT revoked_at FROM family_mobile_sessions WHERE id=$1', [legacyId])).rows[0].revoked_at);
      assert.ok((await db.query('SELECT redeemed_at FROM family_mobile_pairs')).rows[0].redeemed_at);
      await assert.rejects(authenticateMobile(mobileRequest('l'.repeat(43)), db), error => error.status === 401);
      await assert.rejects(db.query("INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,person_id,label) VALUES($1,$2,$3,'child',$4,'Forbidden')", [randomUUID(), household.id, digest(randomUUID()), profiles.a]), error => error.code === '23514');
    });

    await t.test('unconfirmed and wrong-email accounts cannot consume an invitation; one verified concurrent redemption succeeds', async () => {
      const invite = await createInvite(db, parent, { role: 'child', personId: profiles.a, email: '  CHILD-A@example.invalid ' });
      assert.equal(invite.email, accounts.a.email);
      const unconfirmed = await joinRequest(user(accounts.a), invite.token, { id: accounts.a.id, email: accounts.a.email, confirmed_at: new Date().toISOString(), email_confirmed_at: null });
      assert.equal(unconfirmed.status, 403); assert.equal((await unconfirmed.json()).error.code, 'email_not_confirmed');
      await assert.rejects(joinHousehold(db, user(accounts.a), { token: invite.token }, { getVerifiedEmail: async () => 'other@example.invalid' }), error => error.code === 'invited_email_required');
      assert.equal((await db.query('SELECT redeemed_at FROM family_invites WHERE id=$1', [invite.id])).rows[0].redeemed_at, null);
      const results = await Promise.allSettled([0,1].map(() => accepted(accounts.a, invite)));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'invalid_invite');
      childA = await web(accounts.a);
      assert.equal(childA.role, 'child'); assert.equal(childA.personId, profiles.a); assert.equal(childA.user.id, accounts.a.id); assert.equal(childA.user.name, 'Test profile a');
      await accepted(accounts.b, await createInvite(db, parent, { role: 'child', personId: profiles.b, email: accounts.b.email }));
    });

    await t.test('known children cannot race or use a stale JWT email to claim a general member invitation', async () => {
      const pending = { id: randomUUID(), sessionId: randomUUID(), email: 'pending-child@example.invalid' };
      const targeted = await createInvite(db, parent, { role: 'child', personId: profiles.c, email: pending.email });
      const general = await createInvite(db, parent, {});
      const stale = { ...user(pending), user: { ...user(pending).user, email: 'previous-email@example.invalid' } };
      const response = await joinRequest(stale, general.token, { id: pending.id, email: pending.email, email_confirmed_at: new Date().toISOString() });
      assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'child_profile_locked');
      const races = await Promise.allSettled([accepted(pending, targeted), accepted(pending, general)]);
      assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal((await db.query('SELECT role,person_id FROM family_members WHERE user_id=$1', [pending.id])).rows[0].role, 'child');
      await db.query('DELETE FROM family_members WHERE user_id=$1', [pending.id]); // Synthetic account no longer needed.
      await assert.rejects(accepted(accounts.a, general), error => error.code === 'child_profile_locked');
      await assert.rejects(createInvite(db, parent, { role: 'child', personId: profiles.b, email: accounts.a.email }), error => error.code === 'child_profile_locked');
    });

    const choreA = await createChore(db, parent, { title: 'Only child A', personId: profiles.a });
    const choreB = await createChore(db, parent, { title: 'Only child B', personId: profiles.b });
    const complete = async value => {
      const row = (await db.query("SELECT version FROM family_completions WHERE household_id=$1 AND chore_id=$2 AND date='2026-10-18'", [household.id, choreA.id])).rows[0];
      return setCompletion(db, childA, choreA.id, '2026-10-18', { completed: value, expectedVersion: row?.version || 0, mutationId: randomUUID() });
    };
    await t.test('web bearer and native exchange derive child scope from membership rather than metadata or requested role', async () => {
      const snapshot = await householdSnapshot(db, childA, '2026-10-18');
      assert.deepEqual(snapshot.people.map(person => person.id), [profiles.a]); assert.deepEqual(snapshot.chores.map(chore => chore.id), [choreA.id]);
      await assert.rejects(setCompletion(db, childA, choreB.id, '2026-10-18', { completed: true, expectedVersion: 0, mutationId: randomUUID() }), error => error.status === 404);
      await assert.rejects(createChore(db, childA, { title: 'Forbidden' }), error => error.status === 403);
      await assert.rejects(createInvite(db, childA, {}), error => error.status === 403);
      const unjoined = user({ id: randomUUID(), sessionId: randomUUID(), email: 'unjoined@example.invalid' });
      await assert.rejects(createMobileSession(db, unjoined, {}), error => error.code === 'membership_required');
      mobileA = await createMobileSession(db, childA, { role: 'admin', personId: profiles.b });
      assert.equal(mobileA.session.role, 'child'); assert.equal(mobileA.session.personId, profiles.a); assert.equal(mobileA.session.user.id, accounts.a.id);
      mobileParent = await createMobileSession(db, parent, {});
      await registerPush(db, await authenticateMobile(mobileRequest(mobileA.token), db), { installationId: randomUUID(), token: 'b'.repeat(64), environment: 'sandbox' }, env);
      await registerPush(db, await authenticateMobile(mobileRequest(mobileParent.token), db), { installationId: randomUUID(), token: 'a'.repeat(64), environment: 'sandbox' }, env);
    });

    await t.test('own-person notifications and queued pushes cannot broaden after membership role/person changes', async () => {
      await complete(false); await db.query('TRUNCATE family_notification_events CASCADE'); await complete(true);
      const sent = [];
      assert.equal((await processNotifications(db, { env, now: new Date(Date.now()+1000), send: async message => { sent.push(message.token); return { accepted: true, status: 200 }; } })).accepted, 2);
      const mobile = await authenticateMobile(mobileRequest(mobileA.token), db);
      assert.equal((await notificationInbox(db, mobile)).notifications.length, 1);
      await complete(false); await db.query('TRUNCATE family_notification_events CASCADE'); await complete(true);
      await db.query("UPDATE family_members SET role='child',person_id=$2 WHERE user_id=$1", [accounts.parent.id, profiles.c]);
      await db.query('UPDATE family_members SET person_id=$2 WHERE user_id=$1', [accounts.a.id, profiles.c]).then(() => assert.fail('Active child profile uniqueness must reject duplicate binding.'), error => assert.equal(error.code, '23505'));
      await assert.rejects(authenticateMobile(mobileRequest(mobileParent.token), db), error => error.status === 401);
      const scoped = [];
      assert.equal((await processNotifications(db, { env, now: new Date(Date.now()+1000), send: async message => { scoped.push(message.token); return { accepted: true, status: 200 }; } })).accepted, 1);
      assert.deepEqual(scoped, ['b'.repeat(64)]);
      await db.query("UPDATE family_members SET role='admin',person_id=NULL WHERE user_id=$1", [accounts.parent.id]);
      await db.query('UPDATE family_members SET person_id=$2 WHERE user_id=$1', [accounts.a.id, profiles.c]);
      await assert.rejects(authenticateMobile(mobileRequest(mobileA.token), db), error => error.status === 401);
      await db.query('UPDATE family_members SET person_id=$2 WHERE user_id=$1', [accounts.a.id, profiles.a]);
    });

    await t.test('provider revocation ends child web, native, inbox and delivery authority', async () => {
      await complete(false); await db.query('TRUNCATE family_notification_events CASCADE'); await complete(true);
      await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=$1', [accounts.a.sessionId]);
      await assert.rejects(web(accounts.a), error => error.status === 401);
      await assert.rejects(authenticateMobile(mobileRequest(mobileA.token), db), error => error.status === 401);
      await assert.rejects(notificationInbox(db, { ...childA, authType: 'mobile', mobileSessionId: (await db.query('SELECT id FROM family_mobile_sessions WHERE token_hash=$1', [digest(mobileA.token)])).rows[0].id }), error => error.status === 401);
      const sent = [];
      await processNotifications(db, { env, now: new Date(Date.now()+1000), send: async message => { sent.push(message.token); return { accepted: true, status: 200 }; } });
      assert.deepEqual(sent, ['a'.repeat(64)]);
      await pool.query('INSERT INTO family_internal.auth_sessions(id,user_id) VALUES($1,$2)', [accounts.a.sessionId, accounts.a.id]);
    });

    await t.test('parent removal revokes every mobile session and outstanding child invitation; explicit re-invite retains profile', async () => {
      const old = await createInvite(db, parent, { role: 'child', personId: profiles.a, email: accounts.a.email });
      await revokeHouseholdMember(db, parent, accounts.a.id);
      assert.equal((await web(accounts.a)).household, null);
      await assert.rejects(authenticateMobile(mobileRequest(mobileA.token), db), error => error.status === 401);
      await assert.rejects(accepted(accounts.a, old), error => error.code === 'invalid_invite');
      await assert.rejects(accepted(accounts.a, await createInvite(db, parent, {})), error => error.code === 'child_profile_locked');
      const restored = await accepted(accounts.a, await createInvite(db, parent, { role: 'child', personId: profiles.a, email: accounts.a.email }));
      assert.equal(restored.role, 'child'); assert.equal(restored.personId, profiles.a);
      childA = await web(accounts.a);
    });

    await t.test('concurrent account mint and profile deletion completes without deadlock or orphan access', async () => {
      const invitation = await createInvite(db, parent, { role: 'child', personId: profiles.a, email: accounts.a.email });
      const results = await Promise.allSettled([createMobileSession(db, childA, {}), changePerson(db, parent, profiles.a, { expectedVersion: 1 }, true)]);
      assert.equal(results[1].status, 'fulfilled');
      if (results[0].status === 'fulfilled') await assert.rejects(authenticateMobile(mobileRequest(results[0].value.token), db), error => error.status === 401);
      else assert.ok(['membership_required','membership_changed'].includes(results[0].reason.code));
      const member = (await db.query('SELECT role,person_id,revoked_at FROM family_members WHERE user_id=$1', [accounts.a.id])).rows[0];
      assert.equal(member.role, 'child'); assert.equal(member.person_id, null); assert.ok(member.revoked_at);
      await assert.rejects(accepted(accounts.a, invitation), error => error.code === 'invalid_invite');
      await assert.rejects(accepted(accounts.a, await createInvite(db, parent, {})), error => error.code === 'child_profile_locked');
      assert.equal((await db.query('SELECT person_id FROM family_chores WHERE id=$1', [choreA.id])).rows[0].person_id, null);
    });
  } finally {
    if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    for (const account of Object.values(accounts)) await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=$1 AND user_id=$2', [account.sessionId, account.id]).catch(() => {});
    await pool.end();
  }
});
