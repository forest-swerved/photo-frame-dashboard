import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';
import { digest } from './credentials.js';
import { householdDate } from './errors.js';
import { createChore, householdSnapshot, setCompletion } from './household.js';
import { changeChoreOccurrence, createChoreException } from './chore-occurrences.js';
import { authenticateMobile, createMobileSession } from './mobile.js';
import { markNotificationRead, notificationInbox, notificationPreferences, occurrenceInstant, processNotifications, registerPush } from './notifications.js';

const enabled = process.env.FAMILY_RUN_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('account-owned Activity and preferences across devices, scope changes and sign-out', { skip: !enabled, timeout: 45_000 }, async t => {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Refusing account Activity test DDL on a remote database.');
  const pool = createPool(process.env, { migration: true, max: 10 });
  const schema = `family_account_test_${randomUUID().replaceAll('-', '')}`;
  const household = { id: randomUUID(), title: 'Fixture family', timezone: 'America/Denver' };
  const workDate = householdDate(household.timezone);
  const accounts = { parent: { id: randomUUID(), provider: randomUUID(), role: 'admin', personId: null },
    a: { id: randomUUID(), provider: randomUUID(), role: 'child', personId: randomUUID() },
    b: { id: randomUUID(), provider: randomUUID(), role: 'child', personId: randomUUID() } };
  const otherProfile = randomUUID();
  const env = { FAMILY_ENCRYPTION_KEY: Buffer.alloc(32, 33).toString('base64') };
  const db = { async connect() { const client = await pool.connect(); try { await client.query(`SET search_path TO ${schema},pg_catalog`); return client; } catch (error) { client.release(); throw error; } },
    async query(sql, values) { const client = await this.connect(); try { return await client.query(sql, values); } finally { client.release(); } } };
  const web = account => ({ authType: 'user', role: account.role, personId: account.personId, sessionId: account.provider,
    actor: `user:${account.id}`, user: { id: account.id, name: 'Test account' }, household });
  const parent = web(accounts.parent), child = web(accounts.a);
  const sessions = {};
  const providerIds = Object.values(accounts).map(account => account.provider);
  let created = false;
  const complete = async (chore, actor = child, desired = true) => {
    const current = (await db.query('SELECT version FROM family_completions WHERE household_id=$1 AND chore_id=$2 AND date=$3::date', [household.id, chore.id, workDate])).rows[0];
    return setCompletion(db, actor, chore.id, workDate, { completed: desired, expectedVersion: current?.version || 0, mutationId: randomUUID() });
  };
  const run = async () => {
    const sends = [];
    const counts = await processNotifications(db, { env, now: new Date(Date.now() + 1000), send: async message => { sends.push(message); return { accepted: true, status: 200 }; } });
    return { sends, counts };
  };
  const reset = async () => {
    await db.query('TRUNCATE family_notification_events CASCADE');
    await db.query('DELETE FROM family_account_notification_preferences');
  };
  const insertNetwork = async (type, personId = accounts.a.personId, payload = {}) => {
    await db.query(`INSERT INTO family_notification_events(household_id,event_key,type,person_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)`, [household.id, randomUUID(), type, personId, JSON.stringify(payload)]);
  };
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests');
    await pool.query('CREATE SCHEMA IF NOT EXISTS family_internal');
    await pool.query('CREATE TABLE IF NOT EXISTS family_internal.auth_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)');
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    for (const name of ['schema.sql', 'mobile-schema.sql', 'notifications-schema.sql', 'child-accounts-schema.sql', 'calendar-sync-schema.sql', 'chore-schema.sql','school-schema.sql', 'account-notifications-schema.sql']) await db.query(await readFile(new URL(name, import.meta.url), 'utf8'));
    await db.query('INSERT INTO family_households(id,title,timezone) VALUES($1,$2,$3)', [household.id, household.title, household.timezone]);
    for (const account of Object.values(accounts)) {
      await pool.query('INSERT INTO family_internal.auth_sessions(id,user_id) VALUES($1,$2)', [account.provider, account.id]);
      if (account.personId) await db.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,'Test child','#00748c')", [account.personId, household.id]);
      await db.query("INSERT INTO family_members(household_id,user_id,name,email,role,person_id,joined_at) VALUES($1,$2,'Test account',$3,$4,$5,'2026-01-01')", [household.id, account.id, `${account.id}@example.invalid`, account.role, account.personId]);
    }
    await db.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,'Another profile','#00748c')", [otherProfile, household.id]);
    for (const [label, account, token] of [['parent1', accounts.parent, 'a'], ['parent2', accounts.parent, 'b'], ['childA', accounts.a, 'c'], ['childB', accounts.b, 'd']]) {
      const id = randomUUID();
      await db.query(`INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,user_id,provider_session_id,person_id,label,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2026-01-01','2028-01-01')`, [id, household.id, digest(randomUUID()), account.personId ? 'child' : 'parent', account.id, account.provider, account.personId, label]);
      const principal = { ...web(account), authType: 'mobile', mobileSessionId: id, actor: `mobile:${id}` };
      sessions[label] = principal;
      await registerPush(db, principal, { installationId: randomUUID(), token: token.repeat(64), environment: 'sandbox' }, env);
    }

    await t.test('legacy preferences/read state migrate deterministically once without duplicating account rows', async () => {
      const chore = await createChore(db, parent, { title: 'Legacy fixture', personId: accounts.a.personId });
      await complete(chore);
      const event = (await db.query('SELECT id FROM family_notification_events')).rows[0];
      for (const [label, push, saved, read] of [['parent1', false, '2026-10-17T12:00Z', '2026-10-17T12:30Z'], ['parent2', true, '2026-10-17T11:00Z', null]]) {
        await db.query('INSERT INTO family_notification_preferences(mobile_session_id,household_id,push_enabled,updated_at) VALUES($1,$2,$3,$4)', [sessions[label].mobileSessionId, household.id, push, saved]);
        await db.query('INSERT INTO family_notification_inbox(id,event_id,household_id,mobile_session_id,read_at) VALUES($1,$2,$3,$4,$5)', [randomUUID(), event.id, household.id, sessions[label].mobileSessionId, read]);
      }
      const migration = await readFile(new URL('account-notifications-schema.sql', import.meta.url), 'utf8');
      await db.query(migration); await db.query(migration);
      assert.equal((await db.query('SELECT * FROM family_account_notification_inbox')).rowCount, 1);
      assert.equal((await notificationPreferences(db, parent)).pushEnabled, false);
      assert.ok((await notificationInbox(db, parent)).notifications[0].readAt);
      await notificationPreferences(db, parent, { pushEnabled: true });
      await db.query(migration);
      assert.equal((await notificationPreferences(db, sessions.parent2)).pushEnabled, true, 'Migration cannot revert a saved account preference.');
      await reset();
    });

    await t.test('two phones and the website share one Activity ID and read state while push fans out per installation', async () => {
      const chore = await createChore(db, parent, { title: 'Private task title', personId: accounts.a.personId });
      await complete(chore);
      const { counts, sends } = await run();
      assert.equal(counts.accepted, 3);
      const first = (await notificationInbox(db, sessions.parent1)).notifications;
      const second = (await notificationInbox(db, sessions.parent2)).notifications;
      assert.equal(first.length, 1); assert.deepEqual(first, second);
      assert.deepEqual((await notificationInbox(db, parent)).notifications, first);
      assert.equal((await notificationInbox(db, sessions.childB)).notifications.length, 0);
      const parentPushes = sends.filter(message => ['a'.repeat(64), 'b'.repeat(64)].includes(message.token));
      assert.ok(parentPushes.every(message => message.payload.notificationId === first[0].id));
      assert.ok(sends.every(message => !JSON.stringify(message.payload).includes('Private task title')));
      await markNotificationRead(db, sessions.parent2, first[0].id);
      assert.ok((await notificationInbox(db, sessions.parent1)).notifications[0].readAt);
      assert.ok((await notificationInbox(db, parent)).notifications[0].readAt);
      await assert.rejects(markNotificationRead(db, sessions.childA, first[0].id), error => error.status === 404);
      await reset();
    });

    await t.test('routine edits do not rewrite immutable child ownership or queued completion delivery', async () => {
      const chore = await createChore(db, parent, { title: 'Frozen assignment', personId: accounts.a.personId });
      await householdSnapshot(db, child, workDate);
      await db.query('UPDATE family_chores SET person_id=$2,version=version+1 WHERE id=$1', [chore.id, accounts.b.personId]);
      await complete(chore);
      assert.equal((await run()).counts.accepted, 3);
      assert.equal((await notificationInbox(db, sessions.childA)).notifications.length, 1);
      assert.equal((await notificationInbox(db, sessions.childB)).notifications.length, 0);
      await db.query('UPDATE family_members SET person_id=$2 WHERE user_id=$1', [accounts.a.id, otherProfile]);
      await assert.rejects(notificationInbox(db, sessions.childA), error => error.status === 401);
      await assert.rejects(notificationInbox(db, child), error => error.status === 401);
      const reassigned = { ...child, personId: otherProfile };
      assert.equal((await notificationInbox(db, reassigned)).notifications.length, 0, 'The new profile cannot inherit the previous profile’s Activity.');
      await db.query('UPDATE family_members SET person_id=$2 WHERE user_id=$1', [accounts.a.id, accounts.a.personId]);
      await reset();
    });

    await t.test('submitted chores notify only parents; approval creates completion for the assigned child', async () => {
      const chore = await createChore(db, parent, { title: 'Needs review', personId: accounts.a.personId, requiresApproval: true });
      const result = await complete(chore);
      assert.equal((await run()).counts.accepted, 2);
      assert.equal((await notificationInbox(db, sessions.childA)).notifications.length, 0);
      assert.equal((await notificationInbox(db, parent)).notifications[0].kind, 'chore_submitted');
      await changeChoreOccurrence(db, parent, result.occurrence.id, { action: 'approve', expectedVersion: result.occurrence.version, mutationId: randomUUID() });
      assert.equal((await run()).counts.accepted, 3);
      assert.equal((await notificationInbox(db, sessions.childA)).notifications[0].kind, 'chore_completed');
      await reset();
    });

    await t.test('reward/session deep links stay scoped and account preferences apply to every parent phone', async () => {
      const sessionId = randomUUID(), creditId = randomUUID();
      await insertNetwork('reward_earned', accounts.a.personId, { creditId });
      await insertNetwork('session_started', accounts.a.personId, { sessionId, deviceName: 'Private console' });
      await insertNetwork('enforcement_failed', accounts.a.personId, { sessionId });
      assert.equal((await run()).counts.accepted, 8);
      const own = (await notificationInbox(db, sessions.childA)).notifications;
      assert.equal(own.length, 2); assert.ok(own.every(item => item.target === 'devices'));
      assert.ok(own.some(item => item.sessionId === sessionId)); assert.ok(own.some(item => item.creditId === creditId));
      assert.equal((await notificationInbox(db, sessions.childB)).notifications.length, 0);
      await reset();
      await notificationPreferences(db, parent, { internetSessions: false, rewards: false });
      assert.equal((await notificationPreferences(db, sessions.parent2)).internetSessions, false);
      await insertNetwork('session_warning', accounts.a.personId, { sessionId: 'invalid', creditId: 'private arbitrary text' });
      const result = await run(); assert.equal(result.counts.accepted, 1); assert.equal(result.counts.suppressed, 2);
      const link = (await notificationInbox(db, parent)).notifications[0];
      assert.equal(link.sessionId, null); assert.equal(link.creditId, null);
      await reset();
    });

    await t.test('account Activity and preferences reject paired frames and stale provider/membership authority', async () => {
      const frame = { ...parent, authType: 'frame', role: 'frame' };
      for (const operation of [() => notificationInbox(db, frame), () => notificationPreferences(db, frame)]) await assert.rejects(operation(), error => error.status === 403);
      await db.query('UPDATE family_members SET revoked_at=now() WHERE user_id=$1', [accounts.a.id]);
      await assert.rejects(notificationInbox(db, child), error => error.status === 401);
      await assert.rejects(notificationPreferences(db, sessions.childA), error => error.status === 401);
      await db.query('UPDATE family_members SET revoked_at=NULL WHERE user_id=$1', [accounts.a.id]);
    });

    await t.test('deadline worker honors one-off dates, holiday skips, submissions and reschedules without inventing historical work', async () => {
      const nextDay = new Date(Date.parse(workDate) + 86_400_000).toISOString().slice(0, 10);
      const previousDay = new Date(Date.parse(workDate) - 86_400_000).toISOString().slice(0, 10);
      const routineBody = { personId: accounts.a.personId, scheduleType: 'one_off', scheduledDate: workDate, dueTime: '12:00', reminderMinutes: 15 };
      const pending = await createChore(db, parent, { ...routineBody, title: 'Actual pending work' });
      const submitted = await createChore(db, parent, { ...routineBody, title: 'Waiting for review', requiresApproval: true });
      const excused = await createChore(db, parent, { ...routineBody, title: 'School holiday work' });
      const moved = await createChore(db, parent, { ...routineBody, title: 'Moved to tomorrow' });
      const snapshot = await householdSnapshot(db, parent, workDate);
      await complete(submitted);
      await createChoreException(db, parent, { choreId: excused.id, fromDate: workDate, toDateExclusive: nextDay, reason: 'School holiday', mutationId: randomUUID() });
      const moving = snapshot.occurrences.find(item => item.choreId === moved.id);
      const changes = [];
      await changeChoreOccurrence(db, parent, moving.id, { action: 'reschedule', toDate: nextDay, reason: 'Family trip', expectedVersion: moving.version, mutationId: randomUUID() },
        { onChange: async (_client, change) => { changes.push(change); } });
      assert.deepEqual(changes[0].affectedDates, [workDate, nextDay]);
      await reset();
      await db.query("UPDATE family_chore_occurrences SET created_at='2026-01-01' WHERE chore_id=ANY($1::uuid[])", [[pending.id, submitted.id, excused.id, moved.id]]);
      await db.query('DELETE FROM family_notification_scan_state');
      const due = occurrenceInstant(workDate, '12:00', household.timezone);
      const baseline = new Date(due.getTime() - 16 * 60_000);
      const send = async () => ({ accepted: true, status: 200 });
      assert.equal((await processNotifications(db, { env, now: baseline, send })).eventsCreated, 0);
      const lead = await processNotifications(db, { env, now: new Date(due.getTime() - 14 * 60_000), send });
      assert.equal(lead.eventsCreated, 1); assert.equal(lead.accepted, 3);
      assert.equal((await notificationInbox(db, sessions.childA)).notifications[0].choreId, pending.id);
      await db.query('UPDATE family_notification_scan_state SET scanned_at=$1', [occurrenceInstant(previousDay, '12:00', household.timezone)]);
      const overdue = await processNotifications(db, { env, now: new Date(due.getTime() + 60_000), send });
      assert.equal(overdue.eventsCreated, 1);
      assert.equal((await db.query('SELECT * FROM family_chore_occurrences WHERE date=$1::date', [previousDay])).rowCount, 0);
      await reset();
      await db.query('DELETE FROM family_notification_scan_state');
    });

    await t.test('sign-out preserves account Activity/preferences and a fresh sign-in restores the same IDs', async () => {
      const chore = await createChore(db, parent, { title: 'Before sign-out', personId: accounts.a.personId });
      await complete(chore); await run();
      const before = (await notificationInbox(db, parent)).notifications[0];
      await markNotificationRead(db, parent, before.id);
      await notificationPreferences(db, parent, { choreCompleted: false });
      await db.query('UPDATE family_mobile_sessions SET revoked_at=now() WHERE user_id=$1', [accounts.parent.id]);
      await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=$1', [accounts.parent.provider]);
      await assert.rejects(notificationInbox(db, parent), error => error.status === 401);
      await assert.rejects(notificationInbox(db, sessions.parent1), error => error.status === 401);
      await insertNetwork('reward_earned');
      await run(); // Activity is retained even without a live parent phone.
      const provider = randomUUID(); providerIds.push(provider);
      await pool.query('INSERT INTO family_internal.auth_sessions(id,user_id) VALUES($1,$2)', [provider, accounts.parent.id]);
      const signedIn = { ...parent, sessionId: provider };
      const minted = await createMobileSession(db, signedIn, { label: 'Signed in again' });
      const request = new Request('https://family.example/api/mobile/session', { headers: { authorization: `FamilyMobile ${minted.token}` } });
      const restored = await authenticateMobile(request, db);
      const inbox = (await notificationInbox(db, restored)).notifications;
      assert.ok(inbox.some(item => item.id === before.id && item.readAt));
      assert.ok(inbox.some(item => item.kind === 'reward_earned'));
      assert.equal((await notificationPreferences(db, restored)).choreCompleted, false);
    });
  } finally {
    if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=ANY($1::uuid[])', [providerIds]).catch(() => {});
    await pool.end();
  }
});
