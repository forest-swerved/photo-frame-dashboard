import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool, transaction } from './database.js';
import { requestDeviceAccess, decideDeviceAccess, startInternetSession, changeDeviceAccess, internetSnapshot, syncChoreReward, internetNotification } from './internet.js';
import { processNotifications, notificationInbox, notificationPreferences, registerPush } from './notifications.js';
import { ensureDailyOccurrences, setOccurrenceCompletion } from './chore-occurrences.js';
import { schoolCalendarFixture } from './school-calendar-fixture.js';
import { requiredPilotChecks } from './unifi.js';

const enabled = process.env.FAMILY_RUN_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('family reminder, approval and recipient workflows against isolated PostgreSQL', { skip: !enabled, timeout: 60_000 }, async t => {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname), 'Refusing remote fixture writes.');
  const pool = createPool(process.env, { migration: true, max: 6 });
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests');
  const schema = `family_notifications_test_${randomUUID().replaceAll('-','')}`;
  const db = { async connect() {
    const c = await pool.connect();
    await c.query(`SET search_path TO ${schema},pg_catalog`);
    return { query: (sql, values) => c.query(sql.replaceAll('family_internal.auth_sessions', `${schema}.fixture_auth_sessions`), values), release: () => c.release() };
  }, async query(sql, values) { const c = await this.connect(); try { return await c.query(sql,values); } finally { c.release(); } } };
  const household = { id: randomUUID(), title: 'Fixture family', timezone: 'America/Denver' };
  const accounts = Object.fromEntries(['dad','mom','child','sibling'].map((name,i) => [name, {
    household, user: { id: randomUUID(), name: ['Forest','Mom','Andre','Sibling'][i] }, actor: `fixture:${name}`, authType: 'mobile', role: i===0 ? 'admin' : i===1 ? 'member' : 'child',
    mobileSessionId: randomUUID(), provider: randomUUID(), personId: i>1 ? randomUUID() : null,
  }]));
  const env = { FAMILY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'), FAMILY_UNIFI_API_KEY: 'synthetic-provider-key-not-a-secret', FAMILY_UNIFI_CONSOLE_ID: `${'a'.repeat(64)}:12345` };
  const morning = new Date('2026-10-26T13:00Z');
  const send = [], run = now => processNotifications(db, { env, now: new Date(now), send: async msg => { send.push(msg); return { accepted: true, status: 200 }; } });
  const inbox = async who => (await notificationInbox(db, accounts[who])).notifications;
  const clear = async () => { send.length=0; await db.query('TRUNCATE family_notification_events CASCADE'); await db.query('DELETE FROM family_notification_scan_state'); await db.query('DELETE FROM family_account_notification_preferences'); };
  const deviceId = randomUUID(); let request;
  await pool.query(`CREATE SCHEMA ${schema}`);
  try {
    for (const file of ['schema.sql','mobile-schema.sql','notifications-schema.sql','child-accounts-schema.sql','chore-schema.sql','school-schema.sql', 'daily-task-sections-schema.sql','account-notifications-schema.sql','internet-schema.sql','family-notifications-schema.sql']) await db.query(await readFile(new URL(file,import.meta.url),'utf8'));
    await db.query('CREATE TABLE fixture_auth_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)');
    await db.query('INSERT INTO family_households(id,title,timezone) VALUES($1,$2,$3)', [household.id,household.title,household.timezone]);
    for (const [index, p] of Object.values(accounts).entries()) {
      if (p.personId) await db.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,$3,'#00748c')", [p.personId,household.id,p.user.name]);
      await db.query("INSERT INTO family_members(household_id,user_id,name,email,role,person_id,manage_internet,joined_at) VALUES($1,$2,$3,$4,$5,$6,true,'2026-01-01')", [household.id,p.user.id,p.user.name,`${index}@example.invalid`,p.role,p.personId]);
      await db.query('INSERT INTO fixture_auth_sessions(id,user_id) VALUES($1,$2)',[p.provider,p.user.id]);
      await db.query("INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,user_id,provider_session_id,person_id,label,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Fixture phone','2026-01-01','2028-01-01')", [p.mobileSessionId,household.id,randomUUID(),p.personId ? 'child' : 'parent',p.user.id,p.provider,p.personId]);
      await registerPush(db,p,{ installationId: randomUUID(), token: String(index+1).repeat(64), environment: 'sandbox' },env);
    }
    await db.query("INSERT INTO family_managed_devices(id,household_id,name,kind,person_ids,mac_addresses,control_state) VALUES($1,$2,'PS5','console',$3,$4,'unenrolled')",[deviceId,household.id,[accounts.child.personId],['02:00:00:00:00:01']]);
    await db.query("INSERT INTO family_school_calendars(household_id,version,document,created_by) VALUES($1,1,$2::jsonb,'fixture')",[household.id,JSON.stringify(schoolCalendarFixture())]);
    const choreId = randomUUID();
    await db.query("INSERT INTO family_chores(id,household_id,title,person_id,created_at) VALUES($1,$2,'Dishes',$3,'2026-01-01')",[choreId,household.id,accounts.child.personId]);

    await t.test('school-day morning and afternoon reminders target only the assigned child and deduplicate', async () => {
      await run('2026-10-26T12:59Z'); await run(morning); await run(morning);
      assert.equal(send.length,1); assert.equal(send[0].token[0],'3');
      assert.equal((await inbox('dad')).length,0); assert.equal((await inbox('sibling')).length,0);
      await run('2026-10-26T22:00Z'); assert.equal(send.length,2);
      assert.deepEqual((await inbox('child')).map(x=>x.kind),['daily_tasks_reminder','daily_tasks_reminder']);
    });
    await t.test('non-school days use only 11 AM; unknown coverage never assumes a school schedule', async () => {
      await clear(); await run('2026-10-25T12:59Z'); await run('2026-10-25T13:00Z'); assert.equal(send.length,0);
      await run('2026-10-25T17:00Z'); assert.equal(send.length,1); assert.equal(send[0].token[0],'3');
      await run('2026-10-25T22:00Z'); assert.equal(send.length,1);
      await clear(); await run('2027-07-02T12:59Z'); await run('2027-07-02T13:00Z'); assert.equal(send.length,0);
    });
    await t.test('queued reminders are suppressed after completion and completion summaries do not depend on rewards', async () => {
      await clear(); await run('2026-10-26T12:59Z');
      await processNotifications(db, { env, now: morning }); // Enqueue while no APNs keys exist.
      const row=(await db.query("SELECT * FROM family_chore_occurrences WHERE date='2026-10-26' AND chore_id=$1",[choreId])).rows[0];
      await db.query('INSERT INTO family_reward_policies(household_id,person_id,enabled) VALUES($1,$2,false)',[household.id,accounts.child.personId]);
      const at = new Date('2026-10-26T13:01Z');
      await setOccurrenceCompletion(db, accounts.child,row.id,{ completed:true,expectedVersion:row.version,mutationId:randomUUID() },{now:at,onChange:(c,event)=>syncChoreReward(c,event,{now:at})});
      await run(at);
      assert.ok(send.every(s=>s.payload.aps.category!=='FAMILY_TASK' || !s.payload.aps.alert.title.includes('tasks left')));
      for (const who of ['dad','mom']) {
        const entries=await inbox(who); assert.equal(entries.filter(x=>x.kind==='daily_tasks_completed').length,1);
        assert.ok(entries.some(x=>x.title==='Andre finished a task' && /Dishes.*Marked done/.test(x.body)));
      }
      assert.equal((await inbox('child')).filter(x=>x.kind==='daily_tasks_completed').length,0);
      await internetSnapshot(db,accounts.child,{env,now:at}); await run('2026-10-26T22:00Z');
      assert.equal((await inbox('dad')).filter(x=>x.kind==='daily_tasks_completed').length,1);
      assert.equal((await db.query('SELECT id FROM family_reward_credits')).rowCount,0);
    });
    await t.test('child requests are scoped, bounded, idempotent, visible to both parents and expire', async () => {
      await clear(); const body={deviceId,minutes:60,reason:'Play with friends',mutationId:randomUUID()};
      [request] = await Promise.all([requestDeviceAccess(db,accounts.child,body,{now:morning}),requestDeviceAccess(db,accounts.child,body,{now:morning})]);
      assert.equal((await db.query('SELECT id FROM family_access_requests')).rowCount,1);
      await assert.rejects(requestDeviceAccess(db,accounts.child,{...body,mutationId:randomUUID()},{now:morning}),e=>e.code==='request_pending');
      await assert.rejects(requestDeviceAccess(db,accounts.sibling,{...body,mutationId:randomUUID()},{now:morning}),e=>e.status===404);
      await assert.rejects(requestDeviceAccess(db,accounts.dad,body,{now:morning}),e=>e.status===403);
      await assert.rejects(requestDeviceAccess(db,accounts.child,{...body,minutes:0},{now:morning}),e=>e.code==='invalid_duration');
      await run('2026-10-26T13:01Z');
      for (const who of ['dad','mom']) assert.ok((await inbox(who)).some(x=>x.title==='Andre requested device time' && /PS5.*1 hour.*Play with friends/.test(x.body)));
      assert.equal((await inbox('child')).length,0); assert.equal((await inbox('sibling')).length,0);
      assert.equal((await internetSnapshot(db,accounts.sibling,{env,now:morning})).requests.length,0);
      await assert.rejects(decideDeviceAccess(db,accounts.dad,request.id,{action:'approve',expectedVersion:1,mutationId:randomUUID()},{env,now:morning}),e=>e.code==='network_not_ready');
      assert.equal((await db.query('SELECT status FROM family_access_requests WHERE id=$1',[request.id])).rows[0].status,'pending');
    });
    await t.test('simultaneous parent approvals reserve one session, notify the other parent and requesting child', async () => {
      await db.query("INSERT INTO family_network_integrations(household_id,state,management_host,management_verified_at,pilot_checks) VALUES($1,'ready','forest-family-frame.vercel.app',$2,$3::jsonb)",[household.id,morning,JSON.stringify(Object.fromEntries(requiredPilotChecks.map(k=>[k,true])))]);
      await db.query("UPDATE family_managed_devices SET control_state='ready',management_verified_at=$2,management_policy_id=$3,deny_policy_id=$4,reviewed_policy_fingerprint=$5,observed_access='blocked',access_verified_at=$2 WHERE id=$1",[deviceId,morning,randomUUID(),randomUUID(),'a'.repeat(64)]);
      const body={action:'approve',expectedVersion:1,mutationId:randomUUID()};
      const results=await Promise.allSettled(['dad','mom'].map(who=>decideDeviceAccess(db,accounts[who],request.id,body,{env,now:morning})));
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
      const winner=results[0].status==='fulfilled'?'dad':'mom', other=winner==='dad'?'mom':'dad';
      const decision=results.find(x=>x.status==='fulfilled').value;
      assert.equal(decision.status,'approved'); assert.ok(decision.sessionId);
      assert.equal((await db.query('SELECT id FROM family_internet_sessions')).rowCount,1);
      assert.equal((await db.query('SELECT id FROM family_internet_commands')).rowCount,1);
      assert.deepEqual(await decideDeviceAccess(db,accounts[winner],request.id,body,{env,now:morning}),decision);
      await run('2026-10-26T13:02Z');
      assert.equal((await inbox(winner)).filter(x=>x.kind==='access_approved').length,0);
      for(const who of [other,'child']) assert.equal((await inbox(who)).filter(x=>x.kind==='access_approved').length,1);
      assert.equal((await inbox('sibling')).length,0);
      const session=(await db.query('SELECT * FROM family_internet_sessions')).rows[0];
      assert.equal(session.state,'starting'); assert.equal(session.started_at,null); assert.equal(session.ends_at,null);
      await assert.rejects(decideDeviceAccess(db,accounts.child,request.id,body,{env,now:morning}),e=>e.status===403);
    });
    await t.test('declines and expired requests do not create sessions', async () => {
      const at=new Date('2026-10-27T13:00Z');
      const next=await requestDeviceAccess(db,accounts.child,{deviceId,minutes:30,mutationId:randomUUID()},{now:at});
      const declined=await decideDeviceAccess(db,accounts.mom,next.id,{action:'decline',expectedVersion:1,mutationId:randomUUID()},{env,now:at});
      assert.equal(declined.status,'declined'); assert.equal(declined.sessionId,null);
      const expired=await requestDeviceAccess(db,accounts.child,{deviceId,minutes:15,mutationId:randomUUID()},{now:at});
      await assert.rejects(decideDeviceAccess(db,accounts.dad,expired.id,{action:'approve',expectedVersion:1,mutationId:randomUUID()},{env,now:new Date('2026-10-29T13:00Z')}),e=>e.code==='request_changed');
      assert.equal((await db.query('SELECT id FROM family_internet_sessions')).rowCount,1);
    });
    await t.test('grants name the approving parent and device; private preferences redact push but retain Activity', async () => {
      await clear();
      await notificationPreferences(db,accounts.mom,{showDetails:false});
      await internetNotification(db,{householdId:household.id,personId:accounts.child.personId,deviceId,type:'access_granted',key:'fixture-grant',actorName:'Forest',excludeUserId:accounts.dad.user.id,payload:{minutes:60},now:morning});
      await run(morning);
      assert.equal(send.length,2);
      assert.equal(send.find(x=>x.token[0]==='2').payload.aps.alert.title,'Family Frame');
      assert.match(send.find(x=>x.token[0]==='3').payload.aps.alert.body,/Forest granted Andre 1 hour access to PS5/);
      assert.equal((await inbox('dad')).length,0); assert.match((await inbox('mom'))[0].body,/Forest granted Andre/);
    });
    await t.test('parent timed and indefinite grants emit named notifications without entering the earned-time pool', async () => {
      await clear();
      await db.query("UPDATE family_internet_sessions SET state='ended',observed_state='blocked',verified_at=$1",[morning]);
      await db.query("UPDATE family_internet_commands SET state='done'");
      const session=await startInternetSession(db,accounts.dad,{personId:accounts.child.personId,deviceId,minutes:60,reason:'Family game',mutationId:randomUUID()},{env,now:morning});
      assert.equal(session.source,'parent'); assert.equal(session.state,'starting');
      await run(morning);
      assert.match((await inbox('mom'))[0].body,/Forest granted Andre 1 hour access to PS5/);
      assert.equal((await inbox('dad')).length,0);
      await db.query("UPDATE family_internet_sessions SET state='ended',observed_state='blocked',verified_at=$1",[morning]);
      await db.query("UPDATE family_internet_commands SET state='done'");
      await db.query("UPDATE family_managed_devices SET default_access='allowed' WHERE id=$1",[deviceId]);
      const device=(await db.query('SELECT version FROM family_managed_devices WHERE id=$1',[deviceId])).rows[0];
      await changeDeviceAccess(db,accounts.mom,deviceId,{access:'allowed',expectedVersion:device.version,mutationId:randomUUID()},{env,now:morning});
      await run(morning);
      assert.ok((await inbox('dad')).some(x=>x.body.includes('Mom granted Andre Internet access to PS5')));
      const state=await internetSnapshot(db,accounts.child,{env,now:morning});
      assert.equal(state.devices[0].defaultAccess,'allowed'); assert.equal(state.devices[0].rewardAvailable,false);
    });
    await t.test('the additive schema can replay with every new event kind already present', async () => {
      for (const file of ['chore-schema.sql','account-notifications-schema.sql','family-notifications-schema.sql']) await db.query(await readFile(new URL(file,import.meta.url),'utf8'));
      const boundary=(await db.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='family_access_requests'::regclass")).rows[0];
      assert.deepEqual(boundary,{relrowsecurity:true,relforcerowsecurity:false});
    });
  } finally { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); }
});
