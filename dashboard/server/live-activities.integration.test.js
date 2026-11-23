import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';
import { registerLiveActivity, reportLiveActivity, processLiveActivities } from './live-activities.js';
const enabled=process.env.FAMILY_RUN_DB_TESTS==='1';
test('isolated Live Activity lifecycle, session scope and concurrent starts', {skip:!enabled,timeout:120000},async t=>{
 const pool=createPool(process.env,{migration:true,max:6});
 const schema=`family_test_${randomUUID().replaceAll('-','')}`;
 const home=randomUUID(),user=randomUUID(),provider=randomUUID(),session=randomUUID();
 const now=new Date(),env={FAMILY_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64')};
 const principal={authType:'mobile',role:'admin',mobileSessionId:session,household:{id:home}};
 const db={async connect(){const c=await pool.connect();await c.query(`SET search_path TO ${schema},pg_catalog`);return c;},async query(sql,values){const c=await this.connect();try{return await c.query(sql,values);}finally{c.release();}}};
 let created=false;
 try {
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'family_frame_tests','Refusing fixtures outside the isolated test database');
  await pool.query('CREATE SCHEMA IF NOT EXISTS family_internal');
  await pool.query('CREATE TABLE IF NOT EXISTS family_internal.auth_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)');
  await pool.query('INSERT INTO family_internal.auth_sessions VALUES($1,$2,NULL)',[provider,user]);
  await pool.query(`CREATE SCHEMA ${schema}`);created=true;
  for(const file of ['schema.sql','mobile-schema.sql','notifications-schema.sql','child-accounts-schema.sql','chore-schema.sql','school-schema.sql','daily-task-sections-schema.sql','account-notifications-schema.sql','internet-schema.sql','family-notifications-schema.sql','live-activity-schema.sql'])await db.query(await readFile(new URL(file,import.meta.url),'utf8'));
  await db.query("INSERT INTO family_households(id,title,timezone) VALUES($1,'Fixture','America/Denver')",[home]);
  await db.query("INSERT INTO family_members(household_id,user_id,name,email,role) VALUES($1,$2,'Parent','test@example.invalid','admin')",[home,user]);
  await db.query("INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,user_id,provider_session_id,label) VALUES($1,$2,$3,'parent',$4,$5,'Test phone')",[session,home,'a'.repeat(64),user,provider]);
  const registration=await registerLiveActivity(db,principal,{installationId:randomUUID(),environment:'sandbox',enabled:true},{env,now});
  const request=new Request('https://example.test/api/live-activity/tokens',{method:'POST',headers:{authorization:`FamilyActivity ${registration.reportToken}`}});
  const report=body=>reportLiveActivity(request,db,body,{env,now});
  const row=async()=>(await db.query('SELECT * FROM family_live_activity_installations WHERE id=$1',[registration.registrationId])).rows[0];
  await t.test('credential is report-only, parent-only and cannot be tampered or expired',async()=>{
   await assert.rejects(registerLiveActivity(db,{...principal,role:'child'},{installationId:randomUUID(),environment:'sandbox',enabled:true},{env,now}),{status:403});
   await assert.rejects(reportLiveActivity(new Request(request,{headers:{authorization:`FamilyActivity ${registration.reportToken.slice(0,-1)}x`}}),db,{kind:'start',token:'1'.repeat(64)},{env,now}),{status:401});
   await assert.rejects(reportLiveActivity(request,db,{kind:'start',token:'1'.repeat(64)},{env,now:new Date(+now+9*86400000)}),{status:401});
   await report({kind:'start',token:'1'.repeat(64)});
   assert.equal(JSON.stringify((await row()).start_credentials).includes('1'.repeat(64)),false);
  });
  let items=[{id:'device',person:'Alex',device:'Console',status:'Time running',endsAt:new Date(+now+3600000).toISOString(),preparationEndsAt:null}];
  const readSnapshot=async()=>({checkedAt:now.toISOString(),items});
  const sent=[];
  const send=async message=>{sent.push(message);return{accepted:true,status:200};};
  const process=(at,delivery=send)=>processLiveActivities(db,{env,now:at,send:delivery,readSnapshot,registrationId:registration.registrationId});
  await t.test('two concurrent workers send one start and do not replay a start before a token arrives',async()=>{
   let release;const waiting=new Promise(r=>release=r);
   const first=process(new Date(+now+1000),async message=>{sent.push(message);await waiting;return{accepted:true,status:200};});
   for(let i=0;i<100 && sent.length===0;i++)await new Promise(r=>setTimeout(r,5));
   assert.equal(sent.length,1);
   const second=await process(new Date(+now+2000));assert.equal(second.accepted,0);release();await first;
   await process(new Date(+now+121000));assert.equal(sent.length,1);
   assert.equal(sent[0].payload.aps.event,'start');
  });
  await t.test('activity token is bound to the issued run; updates and dismissal preserve user intent',async()=>{
   await assert.rejects(report({kind:'update',runId:randomUUID(),token:'2'.repeat(64)}),{status:409});
   await report({kind:'update',runId:(await row()).run_id,token:'2'.repeat(64)});
   items=[{...items[0],status:'Internet on',endsAt:null}];await process(new Date(+now+181000));
   assert.equal(sent.at(-1).payload.aps.event,'update');
   await report({kind:'dismiss',runId:(await row()).run_id});
   const count=sent.length;await process(new Date(+now+241000));assert.equal(sent.length,count);
   items=[];await process(new Date(+now+301000));assert.equal((await row()).run_id,null);
  });
  await t.test('last condition ending sends an immediate end, and revoked sessions cannot receive new starts',async()=>{
   items=[{id:'device',person:'Alex',device:'Console',status:'Internet on',endsAt:null,preparationEndsAt:null}];
   await process(new Date(+now+361000));const run=(await row()).run_id;assert.ok(run);
   await report({kind:'update',runId:run,token:'3'.repeat(64)});
   items=[];await process(new Date(+now+421000));assert.equal(sent.at(-1).payload.aps.event,'end');assert.equal((await row()).run_id,null);
   await db.query('UPDATE family_mobile_sessions SET revoked_at=$2 WHERE id=$1',[session,now]);
   await assert.rejects(report({kind:'start',token:'1'.repeat(64)}),{status:401});
   items=[{id:'device',person:'Alex',device:'Console',status:'Internet on',endsAt:null,preparationEndsAt:null}];
   const count=sent.length;await process(new Date(+now+481000));assert.equal(sent.length,count);
  });
  const security=(await db.query(`SELECT relrowsecurity,NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(relacl,acldefault('r',relowner))) a WHERE a.grantee=0) AS private FROM pg_class WHERE oid='family_live_activity_installations'::regclass`)).rows[0];
  assert.equal(security.relrowsecurity,true);assert.equal(security.private,true);
 }finally{
  if(created)await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  if(created) await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=$1',[provider]).catch(()=>{});
  await pool.end();
 }
});
