import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';
import { verifyAccountDeletionBoundary } from './verify-account-deletion.js';

const enabled = process.env.FAMILY_RUN_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('isolated owner cleanup removes private account data while preserving shared family records', { skip: !enabled, timeout: 45_000 }, async t => {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Refusing remote deletion-test DDL.');
  const pool = createPool(process.env, { migration: true, max: 3 });
  const suffix = randomUUID().replaceAll('-', ''), schema = `family_delete_test_${suffix}`, callerRole = `family_delete_caller_${suffix}`, ownerRole = `family_delete_owner_${suffix}`;
  const db = await pool.connect();
  let created = false, roleCreated = false, ownerCreated = false;
  const providerIds = [], providerForUser = new Map();
  const providerSession = async userId => {
    const id = randomUUID();
    await pool.query('INSERT INTO family_internal.auth_sessions(id,user_id) VALUES($1,$2)', [id, userId]);
    providerIds.push(id); providerForUser.set(userId, id); return id;
  };
  const allTables = async () => (await db.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [schema])).rows.map(row => row.tablename);
  const count = async table => Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const rpc = async (id, action = 'prepare', email = null, provider = providerForUser.get(id)) => (await db.query('SELECT family_delete_account_data($1,$2,$3,$4) AS result', [id, action, email, provider || null])).rows[0].result;
  let fixture;
  async function reset() {
    const tables = await allTables();
    await db.query(`TRUNCATE ${tables.map(table => `"${schema}"."${table}"`).join(',')} CASCADE`);
    fixture = Object.fromEntries(['hh', 'parent', 'child', 'person', 'routine', 'occurrence', 'mobile', 'parentMobile', 'event', 'inbox', 'installation', 'device', 'session', 'exception', 'grant', 'credit'].map(key => [key, randomUUID()]));
    const f = fixture;
    f.parentProvider = await providerSession(f.parent); f.childProvider = await providerSession(f.child);
    await db.query("INSERT INTO family_households(id,title) VALUES($1,'Fixture family')", [f.hh]);
    await db.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,'Shared child profile','#00a2cf')", [f.person, f.hh]);
    await db.query(`INSERT INTO family_members(household_id,user_id,name,email,role,person_id) VALUES
      ($1,$2,'Parent login name','parent@example.test','admin',NULL),($1,$3,'Private child login name','child@example.test','child',$4)`, [f.hh, f.parent, f.child, f.person]);
    await db.query("INSERT INTO family_chores(id,household_id,title,person_id) VALUES($1,$2,'Shared chore',$3)", [f.routine, f.hh, f.person]);
    await db.query(`INSERT INTO family_chore_occurrences(id,household_id,chore_id,original_date,date,routine_version,title,person_id,person_name,required,requires_approval,reminder_minutes,status,completed_by,approved_by)
      VALUES($1,$2,$3,'2026-10-17','2026-10-17',1,'Shared chore',$4,'Shared child profile',true,false,15,'completed',$5,$6)`, [f.occurrence, f.hh, f.routine, f.person, `mobile:${f.mobile}`, `user:${f.parent}`]);
    await db.query("INSERT INTO family_completions(household_id,chore_id,date,completed,version,actor) VALUES($1,$2,'2026-10-17',true,1,$3)", [f.hh, f.routine, `mobile:${f.mobile}`]);
    await db.query(`INSERT INTO family_chore_events(id,household_id,occurrence_id,type,actor,actor_name,after_state)
      VALUES($1,$2,$3,'completed',$4,'Private child login name','{"status":"completed"}')`, [randomUUID(), f.hh, f.occurrence, `mobile:${f.mobile}`]);
    await db.query(`INSERT INTO family_chore_exceptions(id,household_id,from_date,to_date,reason,created_by)
      VALUES($1,$2,'2026-12-20','2026-12-27','Family holiday',$3)`, [f.exception, f.hh, `mobile:${f.mobile}`]);
    await db.query(`INSERT INTO family_school_calendars(household_id,version,document,created_by) VALUES($1,1,'{"title":"Shared school calendar"}',$2)`, [f.hh, `mobile:${f.mobile}`]);
    await db.query(`INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,user_id,provider_session_id,person_id,label) VALUES
      ($1,$2,'fixture-child-mobile','child',$3,$4,$5,'Private child phone'),($6,$2,'fixture-parent-mobile','parent',$7,$8,NULL,'Parent phone')`, [f.mobile, f.hh, f.child, randomUUID(), f.person, f.parentMobile, f.parent, randomUUID()]);
    await db.query(`INSERT INTO family_account_notification_preferences(household_id,user_id) VALUES($1,$2),($1,$3)`, [f.hh, f.child, f.parent]);
    await db.query("INSERT INTO family_notification_preferences(mobile_session_id,household_id) VALUES($1,$2)", [f.mobile, f.hh]);
    await db.query(`INSERT INTO family_notification_events(id,household_id,event_key,type,person_id,payload)
      VALUES($1,$2,'fixture-completion','chore_completed',$3,'{"title":"Shared chore"}')`, [f.event, f.hh, f.person]);
    await db.query('INSERT INTO family_account_notification_inbox(event_id,household_id,user_id,created_at) VALUES($1,$2,$3,now()),($1,$2,$4,now())', [f.event, f.hh, f.child, f.parent]);
    await db.query('INSERT INTO family_notification_inbox(id,event_id,household_id,mobile_session_id) VALUES($1,$2,$3,$4)', [f.inbox, f.event, f.hh, f.mobile]);
    await db.query(`INSERT INTO family_push_installations(id,installation_id,household_id,mobile_session_id,token_hash,credentials,environment)
      VALUES($1,$2,$3,$4,'fixture-encrypted-token','{"fixture":"encrypted"}','sandbox')`, [f.installation, randomUUID(), f.hh, f.mobile]);
    await db.query('INSERT INTO family_notification_deliveries(id,inbox_id,installation_id) VALUES($1,$2,$3)', [randomUUID(), f.inbox, f.installation]);
    await db.query(`INSERT INTO family_frame_authorizations(id,household_id,created_by,scope,person_id,code_hash,expires_at)
      VALUES($1,$2,$3,'child',$4,'fixture-unlock',now()+interval '5 minutes')`, [f.grant, f.hh, f.child, f.person]);
    await db.query(`INSERT INTO family_invites(id,household_id,token_hash,expires_at,created_by,role,person_id,email)
      VALUES($1,$2,'fixture-child-invite',now()+interval '1 day',$3,'child',$4,'child@example.test'),
      ($5,$2,'fixture-created-by-child',now()+interval '1 day',$6,'member',NULL,NULL)`, [randomUUID(), f.hh, f.parent, f.person, randomUUID(), f.child]);
    await db.query("INSERT INTO family_calendar_connections(household_id,credentials,calendars) VALUES($1,'{" + '"fixture":"encrypted-calendar"' + "}','[]')", [f.hh]);
    await db.query("INSERT INTO family_managed_devices(id,household_id,name,person_ids,mac_addresses) VALUES($1,$2,'Shared console',$3,$4)", [f.device, f.hh, [f.person], ['02:12:34:56:78:9a']]);
    await db.query(`INSERT INTO family_reward_credits(id,household_id,person_id,earned_date,minutes,policy_version,policy_snapshot,occurrence_ids,status,expires_at)
      VALUES($1,$2,$3,'2026-10-17',60,1,'{}',$4,'spent',now()+interval '1 day')`, [f.credit, f.hh, f.person, [f.occurrence]]);
    await db.query(`INSERT INTO family_internet_sessions(id,household_id,person_id,device_id,source,state,desired_state,observed_state,requested_at,remaining_seconds,allocated_seconds,policy_snapshot,created_by)
      VALUES($1,$2,$3,$4,'parent','ended','blocked','blocked',now(),0,3600,'{}',$5)`, [f.session, f.hh, f.person, f.device, `mobile:${f.mobile}`]);
    await db.query("INSERT INTO family_internet_events(id,household_id,person_id,session_id,type,actor) VALUES($1,$2,$3,$4,'session_ended',$5)", [randomUUID(), f.hh, f.person, f.session, `mobile:${f.mobile}`]);
    await db.query("INSERT INTO family_mutations(household_id,actor,mutation_id,request_hash,response) VALUES($1,$2,$3,'fixture-hash','{" + '"private":"receipt"' + "}')", [f.hh, `mobile:${f.mobile}`, randomUUID()]);
  }
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests');
    await pool.query('CREATE SCHEMA IF NOT EXISTS family_internal');
    await pool.query('CREATE TABLE IF NOT EXISTS family_internal.auth_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)');
    await db.query(`CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`); ownerCreated = true;
    await db.query(`GRANT USAGE ON SCHEMA family_internal TO ${ownerRole}`);
    await db.query(`GRANT SELECT ON family_internal.auth_sessions TO ${ownerRole}`);
    await db.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${ownerRole}`); created = true;
    await db.query(`SET ROLE ${ownerRole}`);
    await db.query(`SET search_path TO ${schema},pg_catalog`);
    for (const name of ['schema.sql', 'mobile-schema.sql', 'notifications-schema.sql', 'child-accounts-schema.sql', 'calendar-sync-schema.sql', 'chore-schema.sql','school-schema.sql', 'account-notifications-schema.sql', 'internet-schema.sql','family-notifications-schema.sql', 'account-deletion-schema.sql']) await db.query(await readFile(new URL(name, import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('account-deletion-schema.sql', import.meta.url), 'utf8'));
    assert.equal(await verifyAccountDeletionBoundary(db, schema, { requireServiceRole: false }), true);

    await t.test('a sole administrator cannot strand another active member', async () => {
      await reset();
      assert.equal((await rpc(fixture.parent)).code, 'ownership_transfer_required');
      assert.equal(await count('family_account_deletion_jobs'), 0);
      assert.equal(await count('family_members'), 2); assert.equal(await count('family_mobile_sessions'), 2);
    });
    await t.test('an administrator can leave when another active adult administrator owns the shared household', async () => {
      await reset(); const f = fixture;
      await db.query("INSERT INTO family_members(household_id,user_id,name,email,role) VALUES($1,$2,'Other parent','other-parent@example.test','admin')", [f.hh, randomUUID()]);
      assert.equal((await rpc(f.parent)).householdsDeleted, 0);
      assert.equal(await count('family_households'), 1); assert.equal(await count('family_members'), 2);
      assert.equal(await count('family_calendar_connections'), 1);
      assert.equal((await db.query('SELECT approved_by FROM family_chore_occurrences')).rows[0].approved_by, 'deleted:account');
    });
    await t.test('enrolled policies and active sessions block whole-household deletion without any partial cleanup', async () => {
      await reset(); const f = fixture;
      await db.query('DELETE FROM family_members WHERE user_id=$1', [f.child]);
      await db.query("UPDATE family_managed_devices SET control_state='ready',management_policy_id=$2 WHERE id=$1", [f.device, randomUUID()]);
      assert.equal((await rpc(f.parent)).code, 'managed_devices_enrolled');
      await db.query("UPDATE family_managed_devices SET control_state='unenrolled',management_policy_id=NULL WHERE id=$1", [f.device]);
      await db.query("UPDATE family_internet_sessions SET state='active',desired_state='allowed' WHERE id=$1", [f.session]);
      assert.equal((await rpc(f.parent)).code, 'internet_sessions_active');
      assert.equal(await count('family_account_deletion_jobs'), 0); assert.equal(await count('family_calendar_connections'), 1);
    });
    await t.test('child deletion removes private credentials and emails, anonymizes history, and retains the family dashboard', async () => {
      await reset(); const f = fixture;
      const result = await rpc(f.child); assert.equal(result.ok, true); assert.equal(result.householdsDeleted, 0);
      for (const table of ['family_push_installations', 'family_notification_deliveries', 'family_notification_inbox', 'family_notification_preferences', 'family_invites', 'family_mutations', 'family_frame_authorizations']) assert.equal(await count(table), 0, table);
      assert.equal(await count('family_mobile_sessions'), 1); assert.equal(await count('family_members'), 1);
      assert.equal(await count('family_account_notification_preferences'), 1); assert.equal(await count('family_account_notification_inbox'), 1);
      for (const table of ['family_households', 'family_people', 'family_chores', 'family_chore_occurrences', 'family_completions', 'family_calendar_connections', 'family_school_calendars', 'family_internet_sessions']) assert.equal(await count(table), 1, table);
      assert.equal((await db.query('SELECT created_by FROM family_school_calendars')).rows[0].created_by, 'deleted:account');
      assert.equal((await db.query('SELECT actor,actor_name FROM family_chore_events')).rows[0].actor_name, 'Deleted account');
      assert.equal((await db.query('SELECT completed_by,approved_by FROM family_chore_occurrences')).rows[0].completed_by, 'deleted:account');
      assert.equal((await db.query('SELECT completed_by,approved_by FROM family_chore_occurrences')).rows[0].approved_by, `user:${f.parent}`);
      assert.equal((await db.query('SELECT actor FROM family_internet_events')).rows[0].actor, 'deleted:account');
      assert.equal((await db.query('SELECT created_by FROM family_internet_sessions')).rows[0].created_by, 'deleted:account');
    });
    await t.test('cleanup is retryable after memberships are gone and completion is idempotent', async () => {
      await reset(); const f = fixture;
      assert.equal((await rpc(f.child)).stage, 'data_deleted');
      assert.equal((await rpc(f.child)).stage, 'data_deleted');
      assert.equal((await rpc(f.child, 'complete')).stage, 'auth_deleted');
      assert.equal((await rpc(f.child)).stage, 'auth_deleted');
      assert.equal(await count('family_account_deletion_jobs'), 1);
      assert.equal(await count('family_households'), 1);
    });
    await t.test('simultaneous account deletion retries serialize to one durable cleanup', async () => {
      await reset(); const f = fixture, peer = await pool.connect();
      try {
        await peer.query(`SET ROLE ${ownerRole}`); await peer.query(`SET search_path TO ${schema},pg_catalog`);
        const [first, second] = await Promise.all([rpc(f.child), peer.query('SELECT family_delete_account_data($1,\'prepare\',NULL,$2) AS result', [f.child, f.childProvider]).then(value => value.rows[0].result)]);
        assert.equal(first.ok && second.ok, true); assert.equal(await count('family_account_deletion_jobs'), 1);
        assert.equal(await count('family_members'), 1); assert.equal(await count('family_households'), 1);
      } finally { await peer.query('RESET ROLE'); await peer.query('RESET search_path'); peer.release(); }
    });
    await t.test('a conflicting edit rolls cleanup back completely and remains retryable', async () => {
      await reset(); const f = fixture, peer = await pool.connect();
      try {
        await peer.query(`SET search_path TO ${schema},pg_catalog`); await peer.query('BEGIN');
        await peer.query('SELECT user_id FROM family_members WHERE user_id=$1 FOR SHARE', [f.child]);
        await assert.rejects(rpc(f.child), error => error.code === '55P03');
        assert.equal(await count('family_account_deletion_jobs'), 0); assert.equal(await count('family_members'), 2);
      } finally { await peer.query('ROLLBACK'); await peer.query('RESET search_path'); peer.release(); }
      assert.equal((await rpc(f.child)).ok, true);
    });
    await t.test('a verified unclaimed account removes invitations addressed to its own email only', async () => {
      await reset(); const f = fixture, unclaimed = randomUUID();
      await providerSession(unclaimed);
      await db.query("UPDATE family_invites SET email='unclaimed@example.test' WHERE role='child'");
      assert.equal((await rpc(unclaimed, 'prepare', 'unclaimed@example.test')).ok, true);
      assert.equal(await count('family_invites'), 1); assert.equal(await count('family_members'), 2);
    });
    await t.test('a signed-out, expired, or wrong-owner provider session cannot authorize cleanup even with a fresh JWT', async () => {
      await reset(); const f = fixture;
      assert.equal((await rpc(f.child, 'prepare', null, f.parentProvider)).code, 'reauthentication_required');
      await pool.query("UPDATE family_internal.auth_sessions SET not_after=now()-interval '1 second' WHERE id=$1", [f.childProvider]);
      assert.equal((await rpc(f.child)).code, 'reauthentication_required');
      await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=$1', [f.childProvider]);
      assert.equal((await rpc(f.child)).code, 'reauthentication_required');
      assert.equal(await count('family_account_deletion_jobs'), 0); assert.equal(await count('family_members'), 2);
    });
    await t.test('a safe final household is removed in FK order and its deletion marker survives', async () => {
      await reset(); const f = fixture;
      await db.query('DELETE FROM family_members WHERE user_id=$1', [f.child]);
      assert.equal((await rpc(f.parent)).householdsDeleted, 1);
      for (const table of await allTables()) assert.equal(await count(table), table === 'family_account_deletion_jobs' ? 1 : 0, table);
      assert.equal((await rpc(f.parent)).stage, 'data_deleted');
    });
    await t.test('RPC privileges do not expose tables, and its hardened path resists caller temp-table shadowing', async () => {
      await reset();
      await db.query('RESET ROLE');
      await db.query(`CREATE ROLE ${callerRole} NOLOGIN`); roleCreated = true;
      await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${callerRole}`);
      await db.query(`SET ROLE ${callerRole}`);
      try {
        await assert.rejects(rpc(fixture.child), error => error.code === '42501');
        await assert.rejects(db.query('SELECT * FROM family_account_deletion_jobs'), error => error.code === '42501');
      } finally { await db.query('RESET ROLE'); }
      await db.query(`GRANT EXECUTE ON FUNCTION family_delete_account_data(uuid,text,text,uuid) TO ${callerRole}`);
      const meta = (await db.query("SELECT p.prosecdef,p.proconfig,r.rolname,r.rolsuper,r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='family_delete_account_data(uuid,text,text,uuid)'::regprocedure")).rows[0];
      assert.equal(meta.prosecdef, true); assert.ok(meta.proconfig[0].includes(`pg_catalog, ${schema}, pg_temp`));
      assert.equal(meta.rolname, ownerRole); assert.equal(meta.rolsuper, false); assert.equal(meta.rolbypassrls, false);
      await db.query(`SET ROLE ${callerRole}`);
      try {
        await db.query('CREATE TEMP TABLE family_members(household_id uuid,user_id text,role text)');
        await db.query('INSERT INTO pg_temp.family_members VALUES($1,$2,\'admin\')', [fixture.hh, fixture.parent]);
        assert.equal((await rpc(fixture.parent)).code, 'ownership_transfer_required');
        await assert.rejects(db.query(`SELECT * FROM ${schema}.family_account_deletion_jobs`), error => error.code === '42501');
      } finally { await db.query('RESET ROLE'); }
      await db.query('DROP TABLE pg_temp.family_members');
    });
  } finally {
    await db.query('RESET ROLE').catch(() => {});
    if (created) await db.query(`DROP SCHEMA ${schema} CASCADE`);
    if (roleCreated) await db.query(`DROP ROLE ${callerRole}`);
    if (ownerCreated) {
      await db.query(`REVOKE SELECT ON family_internal.auth_sessions FROM ${ownerRole}`);
      await db.query(`REVOKE USAGE ON SCHEMA family_internal FROM ${ownerRole}`);
      await db.query(`DROP ROLE ${ownerRole}`);
    }
    if (providerIds.length) await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=ANY($1::uuid[])', [providerIds]);
    db.release(); await pool.end();
  }
});
