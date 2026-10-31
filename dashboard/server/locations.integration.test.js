import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';
import { digest } from './credentials.js';
import { locations, changeLocationSharing, reportLocation, locationMap, cleanupLocations } from './locations.js';
import { handleRequest } from './app.js';
import { verifySchema } from './verify-schema.js';
test('adult location consent, limited credentials, household isolation, expiry and revocation',{skip:process.env.FAMILY_RUN_DB_TESTS!=='1',timeout:60000},async t=>{
 const pool=createPool(process.env,{migration:true}),schema=`family_location_test_${randomUUID().replaceAll('-','')}`;
 const db={async connect(){const c=await pool.connect();await c.query(`SET search_path TO ${schema},pg_catalog`);return c;},async query(sql,p){const c=await this.connect();try{return await c.query(sql,p)}finally{c.release()}}};
 const household=randomUUID(),user=randomUUID(),session=randomUUID(),provider=randomUUID();let created=false;
 const p={authType:'mobile',role:'admin',user:{id:user},household:{id:household},mobileSessionId:session};
 const request=(token,method='POST',path='location-reports',body)=>new Request(`https://family.example/api/${path}`,{method,headers:{authorization:`FamilyLocation ${token}`,origin:'https://family.example','content-type':'application/json'},...(!['GET','HEAD'].includes(method)?{body:JSON.stringify(body||{})}:{})});
 const point={latitude:39.74,longitude:-104.99,accuracy:50,place:'Denver',recordedAt:new Date().toISOString()};
 try {
  assert.equal((await pool.query('select current_database() as name')).rows[0].name,'family_frame_tests');
  await pool.query('CREATE SCHEMA IF NOT EXISTS family_internal');await pool.query('CREATE TABLE IF NOT EXISTS family_internal.auth_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)');
  await pool.query('INSERT INTO family_internal.auth_sessions(id,user_id) VALUES($1,$2)',[provider,user]);
  await pool.query(`CREATE SCHEMA ${schema}`);created=true;
  for(const name of ['schema.sql','mobile-schema.sql','notifications-schema.sql','child-accounts-schema.sql','calendar-sync-schema.sql','chore-schema.sql','school-schema.sql','daily-task-sections-schema.sql','account-notifications-schema.sql','internet-schema.sql','family-notifications-schema.sql','account-deletion-schema.sql','parent-pin-schema.sql','media-schema.sql','locations-schema.sql'])await db.query(await readFile(new URL(name,import.meta.url),'utf8'));
  await db.query("INSERT INTO family_households(id,title) VALUES($1,'Location fixture')",[household]);
  await db.query("INSERT INTO family_members(household_id,user_id,name,email,role) VALUES($1,$2,'Parent','parent@example.invalid','admin')",[household,user]);
  await db.query("INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,user_id,provider_session_id,label) VALUES($1,$2,$3,'parent',$4,$5,'Test phone')",[session,household,digest('m'.repeat(43)),user,provider]);
  let enabled;
  await t.test('40 private tables; sharing starts off and only the adult phone can grant it',async()=>{
   assert.equal(await verifySchema(db,schema,40),40);assert.deepEqual((await locations(db,p)).parents,[]);
   for(const denied of [{...p,role:'child'},{...p,authType:'frame'},{...p,authType:'user'}])await assert.rejects(changeLocationSharing(db,denied,{enabled:true,label:'Dad',expectedVersion:0}),{code:'parent_phone_required'});
   enabled=await changeLocationSharing(db,p,{enabled:true,label:'Dad',expectedVersion:0});assert.equal(enabled.reportToken.length,43);
   const row=(await db.query('SELECT * FROM family_parent_locations')).rows[0];assert.notEqual(row.report_token_hash,enabled.reportToken);assert.equal(row.latitude,null);
  });
  await t.test('report can only write its own latest point, cannot read data or grant consent',async()=>{
   const response=await handleRequest(request(enabled.reportToken,'POST','location-reports',point),{db});assert.equal(response.status,200);
   const rows=(await locations(db,p)).parents;assert.equal(rows[0].place,'Denver');
   assert.deepEqual((await locations(db,{...p,household:{id:randomUUID()}})).parents,[]);
   for(const path of ['locations','household','media'])assert.equal((await handleRequest(request(enabled.reportToken,'GET',path),{db})).status,401);
   assert.equal((await handleRequest(request(enabled.reportToken,'PUT','locations/sharing',{enabled:true,label:'Mom',expectedVersion:1}),{db})).status,401);
   assert.equal((await reportLocation(db,request(enabled.reportToken),{...point,recordedAt:new Date(Date.now()-60000).toISOString()})).accepted,false);
   await assert.rejects(reportLocation(db,request(enabled.reportToken),{...point,latitude:91}),{code:'invalid_location'});
   await assert.rejects(reportLocation(db,request(enabled.reportToken),{...point,recordedAt:'2000-01-01'}),{code:'invalid_location_time'});
   const map=await locationMap(db,p,{env:{FAMILY_GOOGLE_MAPS_KEY:'synthetic-key-for-testing-only'}});assert.match(map.url,/maps.googleapis.com/);assert.match(new URL(map.url).searchParams.get('markers'),/39.74,-104.99/);
  });
  await t.test('stopping clears the point and stale token cannot restore it; conflicts cannot overwrite consent',async()=>{
   await reportLocation(db,request(enabled.reportToken,'DELETE'),{});assert.deepEqual((await locations(db,p)).parents,[]);
   const row=(await db.query('SELECT * FROM family_parent_locations')).rows[0];assert.equal(row.latitude,null);assert.equal(row.report_token_hash,null);
   await assert.rejects(reportLocation(db,request(enabled.reportToken),point),{code:'location_revoked'});
   await assert.rejects(changeLocationSharing(db,p,{enabled:true,label:'Dad',expectedVersion:1}),{code:'location_changed'});
   enabled=await changeLocationSharing(db,p,{enabled:true,label:'Dad',expectedVersion:2});
   await reportLocation(db,request(enabled.reportToken),point);
  });
  await t.test('24-hour expiry hides and clears coordinates; provider sign-out immediately hides sharing',async()=>{
   await db.query("UPDATE family_parent_locations SET recorded_at=now()-interval '25 hours'");assert.equal((await locations(db,p)).parents[0].latitude,null);
   await cleanupLocations(db);assert.equal((await db.query('SELECT latitude FROM family_parent_locations')).rows[0].latitude,null);
   await reportLocation(db,request(enabled.reportToken),point);
   await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=$1',[provider]);assert.deepEqual((await locations(db,p)).parents,[]);
   await assert.rejects(reportLocation(db,request(enabled.reportToken),point),{code:'location_revoked'});
   await cleanupLocations(db);assert.equal((await db.query('SELECT latitude FROM family_parent_locations')).rows[0].latitude,null);
   await db.query('DELETE FROM family_members WHERE household_id=$1',[household]);assert.equal((await db.query('SELECT * FROM family_parent_locations')).rowCount,0);
  });
 }finally{if(created)await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.query('DELETE FROM family_internal.auth_sessions WHERE id=$1',[provider]);await pool.end();}
});
