import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createPool} from './database.js';
import {childPinSettings,redeemChildPin,redeemParentPin,parentPinSettings,frameAuthorization} from './capabilities.js';
import {createChore,householdSnapshot} from './household.js';
import {setOccurrenceCompletion} from './chore-occurrences.js';
import {syncChoreReward,internetSnapshot,SAVED_TIME_CAP_MINUTES} from './internet.js';
import {snoozeTaskAlarm,requireAlarmConfirmer,alarmState} from './task-alarms.js';

test('child PINs, the saved-time cap and task alarms',{skip:process.env.FAMILY_RUN_DB_TESTS!=='1',timeout:60000},async()=>{
  const pool=createPool(process.env,{migration:true,max:5}),schema=`family_test_${randomUUID().replaceAll('-','')}`;
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'family_frame_tests');
  const db={async connect(){const c=await pool.connect();await c.query(`SET search_path TO ${schema},pg_catalog`);return {query:(sql,args)=>c.query(sql.replaceAll('family_internal.auth_sessions',`${schema}.fixture_auth_sessions`),args),release:()=>c.release()};},async query(sql,args){const c=await this.connect();try{return await c.query(sql,args);}finally{c.release();}}};
  const household={id:randomUUID(),timezone:'America/Denver'},env={FAMILY_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')};
  // 2:00 PM household time on a Wednesday in standard time.
  const now=new Date('2026-12-02T21:00:00Z'),today='2026-12-02';
  const parent={authType:'user',role:'admin',actor:'user:parent',user:{id:randomUUID(),name:'Test parent'},sessionId:randomUUID(),household};
  const frame={authType:'frame',role:'frame',user:{id:randomUUID()},household,actor:'frame:fixture'};
  const kid=randomUUID(),sibling=randomUUID();
  const options={now,onChange:(client,change)=>syncChoreReward(client,change,{now}),alarmGuard:requireAlarmConfirmer};
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    for(const file of ['schema.sql','mobile-schema.sql','notifications-schema.sql','child-accounts-schema.sql','calendar-sync-schema.sql','chore-schema.sql','school-schema.sql','daily-task-sections-schema.sql','account-notifications-schema.sql','internet-schema.sql','family-notifications-schema.sql','account-deletion-schema.sql','parent-pin-schema.sql']) await db.query(await readFile(new URL(file,import.meta.url),'utf8'));
    // Replaying the owner schema keeps the new columns and constraints.
    for(const file of ['chore-schema.sql','parent-pin-schema.sql']) await db.query(await readFile(new URL(file,import.meta.url),'utf8'));
    await db.query('CREATE TABLE fixture_auth_sessions(id uuid PRIMARY KEY,user_id uuid,not_after timestamptz)');
    await db.query("INSERT INTO family_households(id,title,timezone) VALUES($1,'Alarm fixture','America/Denver')",[household.id]);
    await db.query("INSERT INTO family_members(household_id,user_id,name,email,role,manage_chores,manage_internet) VALUES($1,$2,'Test parent','p@example.invalid','admin',true,true)",[household.id,parent.user.id]);
    await db.query('INSERT INTO fixture_auth_sessions(id,user_id) VALUES($1,$2)',[parent.sessionId,parent.user.id]);
    await db.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$3,'Kid A','#112233'),($2,$3,'Kid B','#332211')",[kid,sibling,household.id]);
    await db.query("INSERT INTO family_devices(id,household_id,label,token_hash) VALUES($1,$2,'Frame','alarm-frame-fixture')",[frame.user.id,household.id]);

    // Child PINs: set by a parent, checked per profile, never stored in the clear.
    await assert.rejects(childPinSettings(db,frame,kid,{pin:'4821'},{env}),e=>e.status===403);
    await assert.rejects(childPinSettings(db,{...parent,role:'child'},kid,{pin:'4821'},{env}),e=>e.status===403);
    await assert.rejects(childPinSettings(db,parent,kid,{pin:'48211'},{env}),e=>e.status===422);
    await assert.rejects(childPinSettings(db,parent,randomUUID(),{pin:'4821'},{env}),e=>e.status===404);
    assert.equal((await childPinSettings(db,parent,kid,{pin:'4821'},{env})).configured,true);
    assert.equal((await childPinSettings(db,parent,sibling,{pin:'4821'},{env})).configured,true); // Same digits are fine across profiles.
    const stored=(await db.query('SELECT frame_pin_hash,frame_pin_salt FROM family_people ORDER BY id')).rows;
    assert.notEqual(stored[0].frame_pin_hash,stored[1].frame_pin_hash);assert.ok(!JSON.stringify(stored).includes('4821'));
    const people=(await householdSnapshot(db,frame,today,{now})).people;
    assert.deepEqual(people.map(p=>p.pinConfigured),[true,true]);assert.ok(people.every(p=>!('frame_pin_hash' in p)));
    await assert.rejects(redeemChildPin(db,frame,{personId:kid,pin:'0000'},{env,now}),e=>e.code==='invalid_child_pin'&&e.status===403);
    await assert.rejects(redeemChildPin(db,{...frame,household:{id:randomUUID()}},{personId:kid,pin:'4821'},{env,now}),e=>e.status===403);
    const grant=await redeemChildPin(db,frame,{personId:kid,pin:'4821'},{env,now});
    assert.equal(grant.scope,'child');assert.equal(grant.personId,kid);
    const asKid=await frameAuthorization(db,frame,grant.token,now);
    assert.equal(asKid.role,'child');assert.equal(asKid.personId,kid);assert.equal(asKid.verifiedCapabilities.manageInternet,false);
    await assert.rejects(redeemChildPin(db,asKid,{personId:kid,pin:'4821'},{env,now}),e=>e.code==='frame_required');
    // Changing the PIN ends the unlock the old one opened.
    await childPinSettings(db,parent,kid,{pin:'9173'},{env});
    await assert.rejects(frameAuthorization(db,frame,grant.token,now),e=>e.code==='invalid_unlock');
    // Wrong child PINs share the frame's parent-PIN lockout.
    await parentPinSettings(db,parent,{pin:'2468'},{env});
    for(let n=1;n<=5;n++) await assert.rejects(redeemChildPin(db,frame,{personId:kid,pin:'0000'},{env,now}),e=>e.code===(n===5?'pin_locked':'invalid_child_pin'));
    await assert.rejects(redeemChildPin(db,frame,{personId:kid,pin:'9173'},{env,now}),e=>e.code==='pin_locked'&&e.status===429);
    await assert.rejects(redeemParentPin(db,frame,{pin:'2468'},{env,now}),e=>e.code==='parent_pin_locked');
    const later=new Date(+now+16*60_000);
    assert.ok((await redeemChildPin(db,frame,{personId:kid,pin:'9173'},{env,now:later})).token);
    await childPinSettings(db,parent,sibling,{remove:true},{env});
    await assert.rejects(redeemChildPin(db,frame,{personId:sibling,pin:'4821'},{env,now:later}),e=>e.code==='invalid_child_pin');
    await db.query('UPDATE family_devices SET parent_pin_failures=0,parent_pin_locked_until=NULL');

    // Alarm tasks need a time and one child.
    await assert.rejects(createChore(db,parent,{title:'No time',personId:kid,weekdays:[3],alarm:true}),e=>e.code==='invalid_alarm');
    await assert.rejects(createChore(db,parent,{title:'No child',weekdays:[3],dueTime:'16:30',alarm:true}),e=>e.code==='invalid_alarm');
    const routine=await createChore(db,parent,{title:'Alarm task',personId:kid,weekdays:[0,1,2,3,4,5,6],dueTime:'16:30',reminderMinutes:0,required:false,alarm:true});
    assert.equal(routine.alarm,true);
    const plain=await createChore(db,parent,{title:'Required task',personId:kid,weekdays:[3]});
    let snapshot=await householdSnapshot(db,frame,today,{now});
    const alarmTask=snapshot.occurrences.find(o=>o.choreId===routine.id),requiredTask=snapshot.occurrences.find(o=>o.choreId===plain.id);
    assert.equal(alarmTask.alarm,true);assert.equal(alarmTask.alarmSnoozedUntil,null);assert.equal(requiredTask.alarm,false);
    assert.equal(snapshot.chores.find(c=>c.occurrenceId===alarmTask.id).alarm,true);

    // Before 4:30 PM nothing rings and there is nothing to snooze.
    const ringing=async at=>(await db.query('SELECT *,date::text FROM family_chore_occurrences WHERE household_id=$1 AND alarm',[household.id])).rows.filter(row=>alarmState(row,household.timezone,at).ringing).map(row=>row.id);
    assert.deepEqual(await ringing(now),[]);
    await assert.rejects(snoozeTaskAlarm(db,frame,alarmTask.id,{now}),e=>e.code==='alarm_not_ringing');
    const ringAt=new Date('2026-12-02T23:31:00Z'); // 4:31 PM household time.
    assert.deepEqual(await ringing(ringAt),[alarmTask.id]);
    // Snooze silences for ten minutes without touching the task version, then it rings again.
    const snoozed=await snoozeTaskAlarm(db,frame,alarmTask.id,{now:ringAt});
    assert.equal(snoozed.alarmSnoozedUntil,new Date(+ringAt+10*60_000).toISOString());assert.equal(snoozed.version,alarmTask.version);
    assert.deepEqual(await ringing(new Date(+ringAt+9*60_000)),[]);
    assert.deepEqual(await ringing(new Date(+ringAt+10*60_000)),[alarmTask.id]);
    await assert.rejects(snoozeTaskAlarm(db,{...asKid,personId:sibling},alarmTask.id,{now:ringAt}),e=>e.status===404);

    // On the shared frame only the child (their PIN) or an unlocked parent can confirm it.
    const done=version=>({completed:true,expectedVersion:version,mutationId:randomUUID()});
    await assert.rejects(setOccurrenceCompletion(db,frame,alarmTask.id,done(alarmTask.version),{...options,now:ringAt}),e=>e.code==='child_pin_required'&&e.details.personId===kid);
    const siblingGrant=await childPinSettings(db,parent,sibling,{pin:'5555'},{env}).then(()=>redeemChildPin(db,frame,{personId:sibling,pin:'5555'},{env,now:ringAt}));
    await assert.rejects(setOccurrenceCompletion(db,await frameAuthorization(db,frame,siblingGrant.token,ringAt),alarmTask.id,done(alarmTask.version),{...options,now:ringAt}),e=>e.status===404);
    const kidGrant=await redeemChildPin(db,frame,{personId:kid,pin:'9173'},{env,now:ringAt});
    const confirmed=await setOccurrenceCompletion(db,await frameAuthorization(db,frame,kidGrant.token,ringAt),alarmTask.id,done(alarmTask.version),{...options,now:ringAt});
    assert.equal(confirmed.status,'completed');
    assert.deepEqual(await ringing(new Date(+ringAt+11*60_000)),[]);
    await assert.rejects(snoozeTaskAlarm(db,frame,alarmTask.id,{now:new Date(+ringAt+11*60_000)}),e=>e.code==='alarm_not_ringing');
    // Ordinary tasks stay one tap on the frame.
    // With nine hours saved, today's hour still fits under the ten-hour cap.
    const credit=(minutes,n)=>db.query(`INSERT INTO family_reward_credits(id,household_id,person_id,earned_date,minutes,policy_version,policy_snapshot,occurrence_ids,status,expires_at)
      VALUES($1,$2,$3,$4::date,$5,1,'{}'::jsonb,ARRAY[$1]::uuid[],'available',$6)`,[randomUUID(),household.id,kid,`2026-11-${10+n}`,minutes,new Date(+now+30*86400_000)]);
    assert.equal(SAVED_TIME_CAP_MINUTES,600);
    for(let n=0;n<9;n++) await credit(60,n);
    await db.query('INSERT INTO family_reward_policies(household_id,person_id,carryover_days) VALUES($1,$2,30)',[household.id,kid]);
    const finished=await setOccurrenceCompletion(db,frame,requiredTask.id,done(requiredTask.version),options);
    assert.equal(finished.status,'completed');
    let internet=await internetSnapshot(db,parent,{env,now});
    assert.equal(internet.savedCapMinutes,600);
    let earned=internet.credits.find(c=>c.personId===kid&&c.earnedDate===today);
    assert.equal(earned.useOrLose,false);assert.equal(earned.expiresAt,'2027-01-02T07:00:00.000Z'); // 30 days of carryover.
    // At the cap, the next reward is use it or lose it: it expires at household midnight.
    await db.query('DELETE FROM family_reward_credits WHERE id=$1',[earned.id]);
    await credit(60,9);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM family_notification_events WHERE type NOT IN ('reward_earned','daily_tasks_completed','chore_completed')")).rows[0].n,0,'An alarm never creates a phone notification.');
    await db.query('DELETE FROM family_notification_events');
    const client=await db.connect();
    try { await client.query('BEGIN'); await syncChoreReward(client,{householdId:household.id,personId:kid,date:today},{now}); await client.query('COMMIT'); } finally { client.release(); }
    internet=await internetSnapshot(db,parent,{env,now});
    earned=internet.credits.find(c=>c.personId===kid&&c.earnedDate===today);
    assert.equal(earned.useOrLose,true);assert.equal(earned.minutes,60);assert.equal(earned.expiresAt,'2026-12-03T07:00:00.000Z');
    const event=(await db.query("SELECT payload FROM family_notification_events WHERE type='reward_earned'")).rows[0];
    assert.equal(event.payload.useOrLose,true);assert.equal(event.payload.savedCapMinutes,600);
    assert.equal(internet.credits.filter(c=>c.personId===kid&&['available','held'].includes(c.status)&&!c.useOrLose).reduce((sum,c)=>sum+c.minutes,0),600);
  } finally {await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
});
