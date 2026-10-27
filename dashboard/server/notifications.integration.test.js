import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';
import { digest } from './credentials.js';
import { createChore, householdSnapshot, setCompletion } from './household.js';
import { authenticateMobile, createMobileSession, createMobilePair, redeemMobilePair } from './mobile.js';
import { markNotificationRead, notificationInbox, notificationPreferences, processNotifications, registerPush } from './notifications.js';

const enabled = Boolean(process.env.FAMILY_RUN_DB_TESTS === '1' && process.env.DATABASE_URL);
test('isolated PostgreSQL mobile notification authorization, outbox, and deadline races', { skip: !enabled, timeout: 360_000 }, async t => {
  const pool = createPool(process.env, { migration: true, max: 10 });
  const schema = `family_test_${randomUUID().replaceAll('-', '')}`;
  const providerSession = randomUUID(), parentId = randomUUID(), householdId = randomUUID(), childA = randomUUID(), childB = randomUUID();
  const childAccounts = { childA: { id: randomUUID(), providerSession: randomUUID() }, childB: { id: randomUUID(), providerSession: randomUUID() } };
  const db = {
    async connect() { const client = await pool.connect(); try { await client.query(`SET search_path TO ${schema},pg_catalog`); return client; } catch (error) { client.release(); throw error; } },
    async query(sql, params) { const client = await this.connect(); try { return await client.query(sql, params); } finally { client.release(); } },
  };
  const env = { FAMILY_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') };
  const household = { id: householdId, title: 'Test household', timezone: 'America/Denver' };
  const parent = { authType: 'user', role: 'admin', actor: `user:${parentId}`, user: { id: parentId, name: 'Test parent' }, household };
  const principals = {};
  let created = false;
  try {
    const identity = (await pool.query('SELECT current_database() AS name,current_user=session_user AS same_role')).rows[0];
    assert.equal(identity.name, 'family_frame_tests', 'Refusing test DDL outside the separate test database.');
    assert.equal(identity.same_role, true);
    assert.match(schema, /^family_test_[a-f0-9]{32}$/);
    // Test-only session fixture. Never drop a shared schema/table or touch another test's UUID rows.
    await pool.query('CREATE SCHEMA IF NOT EXISTS family_internal');
    await pool.query('CREATE TABLE IF NOT EXISTS family_internal.auth_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)');
    await pool.query('INSERT INTO family_internal.auth_sessions(id,user_id,not_after) VALUES($1,$2,NULL)', [providerSession, parentId]);
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    for (const name of ['schema.sql', 'mobile-schema.sql', 'notifications-schema.sql', 'child-accounts-schema.sql', 'chore-schema.sql','school-schema.sql', 'account-notifications-schema.sql','internet-schema.sql','family-notifications-schema.sql']) await db.query(await readFile(new URL(name, import.meta.url), 'utf8'));
    await db.query('INSERT INTO family_households(id,title,timezone) VALUES($1,$2,$3)', [householdId, household.title, household.timezone]);
    await db.query("INSERT INTO family_members(household_id,user_id,name,email,role) VALUES($1,$2,'Test parent','parent@example.invalid','admin')", [householdId, parentId]);
    for (const [id, name] of [[childA, 'Test child A'], [childB, 'Test child B']]) await db.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,$3,'#00aabb')", [id, householdId, name]);
    for (const [name, personId] of [['parent', null], ['childA', childA], ['childB', childB]]) {
      const id = randomUUID();
      const accountId = personId ? childAccounts[name].id : parentId, providerId = personId ? childAccounts[name].providerSession : providerSession;
      if (personId) {
        await pool.query('INSERT INTO family_internal.auth_sessions(id,user_id,not_after) VALUES($1,$2,NULL)', [providerId, accountId]);
        await db.query("INSERT INTO family_members(household_id,user_id,name,email,role,person_id) VALUES($1,$2,$3,$4,'child',$5)", [householdId, accountId, name, `${name}@example.invalid`, personId]);
      }
      await db.query(`INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,user_id,provider_session_id,person_id,label,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2026-01-01','2027-12-31')`, [id, householdId, digest(randomUUID()), personId ? 'child' : 'parent', accountId, providerId, personId, name]);
      principals[name] = { ...parent, user: { id: accountId, name }, authType: 'mobile', mobileSessionId: id, role: personId ? 'child' : 'admin', personId, actor: `mobile:${id}` };
      await registerPush(db, principals[name], { installationId: randomUUID(), token: ({ parent: 'a', childA: 'b', childB: 'c' }[name]).repeat(64), environment: 'sandbox' }, env);
    }
    await db.query("UPDATE family_members SET joined_at='2026-01-01'");
    const resetEvents = async () => {
      await db.query('TRUNCATE family_notification_events CASCADE');
      await db.query('DELETE FROM family_notification_scan_state');
      await db.query('DELETE FROM family_notification_preferences');
      await db.query('DELETE FROM family_account_notification_preferences');
      await db.query('UPDATE family_push_installations SET disabled_at=NULL');
    };
    const chore = await createChore(db, parent, { title: 'Test chore A', personId: childA, dueTime: '12:00', reminderMinutes: 15 });
    await db.query("UPDATE family_chores SET created_at='2026-01-01' WHERE id=$1", [chore.id]);
    const complete = async (completed, date = '2026-10-17') => {
      const current = (await db.query('SELECT version FROM family_completions WHERE household_id=$1 AND chore_id=$2 AND date=$3::date', [householdId, chore.id, date])).rows[0];
      return setCompletion(db, parent, chore.id, date, { completed, expectedVersion: current?.version || 0, mutationId: randomUUID(), reason: 'Synthetic notification fixture' });
    };
    const transition = async completed => { await complete(!completed); await resetEvents(); return complete(completed); };
    const current = () => new Date(Date.now() + 1000);

    await t.test('server-only notification tables and invoker trigger retain RLS and no API grants', async () => {
      const tables = (await db.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,NOT EXISTS
        (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
          WHERE a.grantee=0 OR r.rolname IN ('anon','authenticated','service_role')) AS revoked
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND
          (c.relname LIKE 'family_notification_%' OR c.relname='family_push_installations') AND c.relkind='r'`, [schema])).rows;
      assert.equal(tables.length, 6);
      for (const table of tables) { assert.equal(table.relrowsecurity, true); assert.equal(table.relforcerowsecurity, false); assert.equal(table.revoked, true); }
      const trigger = (await db.query('SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=$2', [schema, 'family_enqueue_completion_notification'])).rows[0];
      assert.equal(trigger.prosecdef, false);
    });

    await t.test('transition trigger and duplicate worker runs fan out once to parent and assigned child only', async () => {
      await complete(true);
      const accepted = [];
      const results = await Promise.all([0, 1].map(() => processNotifications(db, { env, now: current(), send: async message => { accepted.push(message); return { accepted: true, status: 200 }; } })));
      assert.equal(results.reduce((sum, result) => sum + result.accepted, 0), 2);
      assert.equal(accepted.length, 2);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM family_notification_events')).rows[0].n, 1);
      assert.equal((await notificationInbox(db, principals.parent)).notifications.length, 1, 'NULL provider expiry remains a live parent session.');
      assert.equal((await notificationInbox(db, principals.childA)).notifications.length, 1);
      assert.equal((await notificationInbox(db, principals.childB)).notifications.length, 0);
      assert.ok(accepted.every(message => JSON.stringify(message.payload).includes('Test chore A')));
      const entry = (await notificationInbox(db, principals.childA)).notifications[0];
      assert.equal(entry.kind, 'chore_completed');
      await markNotificationRead(db, principals.childA, entry.id);
      assert.ok((await notificationInbox(db, principals.childA)).notifications[0].readAt);
      await assert.rejects(markNotificationRead(db, principals.childB, entry.id), error => error.status === 404);
    });

    await t.test('a complete/reopen race suppresses stale completion pushes but retains actual inbox events', async () => {
      await complete(true); await resetEvents(); await complete(false); await complete(true); await complete(false);
      const result = await processNotifications(db, { env, now: current(), send: async () => ({ accepted: true, status: 200 }) });
      assert.equal(result.accepted, 2);
      assert.equal(result.suppressed, 4);
      assert.equal((await notificationInbox(db, principals.parent)).notifications.length, 3);
    });

    await t.test('provider failure retries durably; invalid token disables only its installation', async () => {
      await transition(true);
      const first = await processNotifications(db, { env, now: current(), send: async () => ({ accepted: false, status: 503, reason: 'ServiceUnavailable' }) });
      assert.equal(first.pending, 2);
      let calls = 0;
      const early = await processNotifications(db, { env, now: current(), send: async () => { calls++; return { accepted: true, status: 200 }; } });
      assert.equal(calls, 0); assert.equal(early.accepted, 0);
      const later = await processNotifications(db, { env, now: new Date(Date.now() + 16 * 60_000), send: async message => message.token[0] === 'b' ? { status: 410, reason: 'Unregistered' } : { accepted: true, status: 200 } });
      assert.equal(later.accepted, 1); assert.equal(later.failed, 1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM family_push_installations WHERE disabled_at IS NOT NULL')).rows[0].n, 1);
    });

    await t.test('quiet hours defer or explicitly suppress pushes while keeping both inbox entries', async () => {
      await transition(false);
      const now = current();
      const local = new Intl.DateTimeFormat('en-GB', { timeZone: household.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
      const [hour] = local.split(':').map(Number);
      const start = `${String((hour + 23) % 24).padStart(2, '0')}:00`, end = `${String((hour + 1) % 24).padStart(2, '0')}:00`;
      await notificationPreferences(db, principals.parent, { quietStart: start, quietEnd: end });
      await notificationPreferences(db, principals.childA, { pushEnabled: false });
      const result = await processNotifications(db, { env, now, send: async () => { assert.fail('Quiet/disabled pushes must not reach Apple.'); } });
      assert.equal(result.deferred, 1); assert.equal(result.suppressed, 1);
      assert.equal((await notificationInbox(db, principals.parent)).notifications.length, 1);
      assert.equal((await notificationInbox(db, principals.childA)).notifications.length, 1);
    });

    await t.test('first deadline scan establishes a baseline, catches due crossings once, and rechecks completion', async () => {
      await complete(false);
      await resetEvents();
      await db.query("UPDATE family_chore_occurrences SET created_at='2026-01-01' WHERE chore_id=$1", [chore.id]);
      await db.query("UPDATE family_chores SET due_time='12:00',reminder_minutes=15 WHERE id=$1", [chore.id]);
      const baseline = new Date('2026-10-17T17:44:00Z');
      const first = await processNotifications(db, { env, now: baseline, send: async () => ({ accepted: true, status: 200 }) });
      assert.equal(first.eventsCreated, 0);
      const dueSoon = await processNotifications(db, { env, now: new Date('2026-10-17T17:46:00Z'), send: async () => ({ accepted: true, status: 200 }) });
      assert.equal(dueSoon.eventsCreated, 1); assert.equal(dueSoon.accepted, 2);
      assert.equal((await processNotifications(db, { env, now: new Date('2026-10-17T17:47:00Z'), send: async () => ({ accepted: true, status: 200 }) })).eventsCreated, 0);
      await complete(true);
      const due = await processNotifications(db, { env, now: new Date('2026-10-17T18:01:00Z'), send: async () => ({ accepted: true, status: 200 }) });
      assert.equal(due.eventsCreated, 0, 'Completed chores never generate overdue events.');
      await complete(false);
      await db.query("UPDATE family_notification_scan_state SET scanned_at='2026-10-17T17:59Z'");
      // Enqueue overdue without sending (missing APNs keys), then complete it before the lease/send.
      const pending = await processNotifications(db, { env, now: new Date('2026-10-17T18:01:00Z') });
      assert.equal(pending.eventsCreated, 1); assert.equal(pending.pushConfigured, false);
      await complete(true);
      const sent = [];
      await processNotifications(db, { env, now: new Date('2026-10-17T18:02:00Z'), send: async message => { sent.push(message); return { accepted: true, status: 200 }; } });
      const overdue = (await db.query("SELECT d.state FROM family_notification_deliveries d JOIN family_notification_inbox i ON i.id=d.inbox_id JOIN family_notification_events e ON e.id=i.event_id WHERE e.type='chore_overdue'")).rows;
      assert.equal(overdue.length, 2); assert.ok(overdue.every(row => row.state === 'suppressed'));
    });

    await t.test('installation UUID alone cannot rebind another sign-in; same-token transfer suppresses old-session pushes', async () => {
      await transition(false);
      await processNotifications(db, { env, now: current() }); // Queue durable deliveries while APNs is unconfigured.
      const installation = (await db.query('SELECT installation_id FROM family_push_installations WHERE mobile_session_id=$1', [principals.parent.mobileSessionId])).rows[0];
      await assert.rejects(registerPush(db, principals.childA, { installationId: installation.installation_id, token: 'b'.repeat(64), environment: 'sandbox' }, env),
        error => error.status === 409 && error.code === 'installation_conflict');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM family_push_installations')).rows[0].n, 3, 'Rejected registration must not delete another installation.');
      try {
        await registerPush(db, principals.childB, { installationId: installation.installation_id, token: 'a'.repeat(64), environment: 'sandbox' }, env);
        const tokens = [];
        const result = await processNotifications(db, { env, now: current(), send: async message => { tokens.push(message.token); return { accepted: true, status: 200 }; } });
        assert.equal(result.accepted, 1); assert.equal(result.suppressed, 1);
        assert.ok(tokens.every(token => token[0] === 'b'), 'An installation transferred to another child cannot receive the prior parent session event.');
      } finally {
        await registerPush(db, principals.parent, { installationId: installation.installation_id, token: 'a'.repeat(64), environment: 'sandbox' }, env);
      }
    });

    await t.test('fresh cached calendar and frame-health transitions notify parents once without child disclosure', async () => {
      await resetEvents();
      const deviceId = randomUUID();
      const cache = { status: 'ready', events: [{ id: 'test-event', calendarId: 'test-calendar', title: 'Private parent calendar event', allDay: false, startAt: '2026-10-20T18:08:00Z', endAt: '2026-10-20T19:08:00Z' }],
        coverage: { startDate: '2026-10-20', endDateExclusive: '2026-10-21', complete: true, truncated: false } };
      try {
        await db.query("INSERT INTO family_calendar_connections(household_id,credentials,calendars,selected_ids,updated_at) VALUES($1,'{}','[]','[\"test-calendar\"]','2026-10-20T17:00Z')", [householdId]);
        await db.query("INSERT INTO family_calendar_cache(household_id,start_date,end_date,timezone,snapshot,successful_at,connection_version) VALUES($1,'2026-10-20','2026-10-21',$2,$3::jsonb,'2026-10-20T17:59Z',1)", [householdId, household.timezone, JSON.stringify(cache)]);
        await db.query("INSERT INTO family_devices(id,household_id,label,token_hash,last_seen_at,expires_at) VALUES($1,$2,'Test frame',$3,'2026-10-20T17:56Z','2027-12-31')", [deviceId, householdId, digest(randomUUID())]);
        const sent = [];
        const run = now => processNotifications(db, { env, now: new Date(now), send: async message => { sent.push(message); return { accepted: true, status: 200 }; } });
        assert.equal((await run('2026-10-20T18:00Z')).eventsCreated, 0);
        const reminder = await run('2026-10-20T18:01Z');
        assert.equal(reminder.eventsCreated, 1); assert.equal(reminder.accepted, 1, 'Fresh-cache recovery after the initial reminder threshold still reminds before start.');
        assert.equal((await run('2026-10-20T18:02Z')).eventsCreated, 0, 'Five-minute heartbeat write cadence and the same calendar occurrence cannot duplicate alerts.');
        await db.query("UPDATE family_devices SET last_seen_at='2026-10-20T17:44Z' WHERE id=$1", [deviceId]);
        assert.equal((await run('2026-10-20T18:03Z')).eventsCreated, 1);
        await db.query("UPDATE family_devices SET last_seen_at='2026-10-20T18:04Z' WHERE id=$1", [deviceId]);
        assert.equal((await run('2026-10-20T18:04Z')).eventsCreated, 1);
        await db.query("UPDATE family_calendar_cache SET successful_at='2026-10-20T17:00Z' WHERE household_id=$1", [householdId]);
        assert.equal((await run('2026-10-20T18:05Z')).eventsCreated, 1);
        await db.query("UPDATE family_calendar_cache SET successful_at='2026-10-20T18:06Z' WHERE household_id=$1", [householdId]);
        assert.equal((await run('2026-10-20T18:06Z')).eventsCreated, 1);
        const kinds = (await notificationInbox(db, principals.parent)).notifications.map(item => item.kind).sort();
        assert.deepEqual(kinds, ['calendar_restored', 'calendar_unavailable', 'calendar_upcoming', 'frame_offline', 'frame_online']);
        assert.equal((await notificationInbox(db, principals.childA)).notifications.length, 0);
        assert.equal((await notificationInbox(db, principals.childB)).notifications.length, 0);
        assert.equal(sent.length, 5);
        assert.ok(sent.every(message => message.token[0] === 'a'));
      } finally {
        await db.query('DELETE FROM family_calendar_cache WHERE household_id=$1', [householdId]);
        await db.query('DELETE FROM family_calendar_connections WHERE household_id=$1', [householdId]);
        await db.query('DELETE FROM family_devices WHERE id=$1', [deviceId]);
      }
    });

    await t.test('parent provider revocation prevents inbox access and queued delivery', async () => {
      await transition(false);
      await db.query('DELETE FROM family_internal.auth_sessions WHERE id=$1', [providerSession]);
      await assert.rejects(notificationInbox(db, principals.parent), error => error.status === 401);
      const delivered = [];
      const result = await processNotifications(db, { env, now: current(), send: async message => { delivered.push(message.token); return { accepted: true, status: 200 }; } });
      assert.equal(result.accepted, 1); assert.ok(delivered.every(token => token[0] === 'b'));
      await pool.query('INSERT INTO family_internal.auth_sessions(id,user_id,not_after) VALUES($1,$2,NULL)', [providerSession, parentId]);
    });

    await t.test('child account exchange replaces anonymous pairing and cannot access siblings/admin', async () => {
      await assert.rejects(createMobilePair(db, parent, { personId: childA }, env), error => error.status === 410);
      await assert.rejects(redeemMobilePair(db, { code: '123456' }, env), error => error.status === 410);
      const mobile = await createMobileSession(db, { ...principals.childA, authType: 'user', sessionId: childAccounts.childA.providerSession }, {});
      const request = new Request('https://family.example/api/mobile/session', { headers: { authorization: `FamilyMobile ${mobile.token}` } });
      const child = await authenticateMobile(request, db);
      assert.equal(child.role, 'child'); assert.equal(child.personId, childA);
      const sibling = await createChore(db, parent, { title: 'Sibling-only chore', personId: childB });
      const snapshot = await householdSnapshot(db, child, '2026-10-17');
      assert.ok(snapshot.people.every(person => person.id === childA));
      assert.ok(snapshot.chores.every(chore => chore.personId === childA));
      await assert.rejects(setCompletion(db, child, sibling.id, '2026-10-17', { completed: true, expectedVersion: 0, mutationId: randomUUID() }), error => error.status === 404 || error.status === 403);
      await assert.rejects(createChore(db, child, { title: 'Forbidden' }), error => error.status === 403);
      await assert.rejects(createMobilePair(db, child, { personId: childB }, env), error => error.status === 410);
      await db.query('DELETE FROM family_internal.auth_sessions WHERE id=$1', [providerSession]);
      const token = 'p'.repeat(43);
      await db.query('UPDATE family_mobile_sessions SET token_hash=$2 WHERE id=$1', [principals.parent.mobileSessionId, digest(token)]);
      await assert.rejects(authenticateMobile(new Request('https://family.example/api/mobile/session', { headers: { authorization: `FamilyMobile ${token}` } }), db), error => error.status === 401);
    });
  } finally {
    if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=$1 AND user_id=$2', [providerSession, parentId]).catch(() => {});
    for (const account of Object.values(childAccounts)) await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=$1 AND user_id=$2', [account.providerSession, account.id]).catch(() => {});
    await pool.end();
  }
});
