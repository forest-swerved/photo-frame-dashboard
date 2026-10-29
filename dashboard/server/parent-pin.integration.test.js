import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createPool} from './database.js';
import {parentPinSettings,redeemParentPin,frameAuthorization,revokeFrameAccessAfterRecovery} from './capabilities.js';

test('parent PINs retain identity, household scope, committed lockout and recovery revocation',{skip:process.env.FAMILY_RUN_DB_TESTS!=='1',timeout:30000},async()=>{
  const pool=createPool(process.env,{migration:true,max:5}),schema=`family_test_${randomUUID().replaceAll('-','')}`;
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'family_frame_tests');
  const db={async connect(){const c=await pool.connect();await c.query(`SET search_path TO ${schema},pg_catalog`);return {query:(sql,args)=>c.query(sql.replaceAll('family_internal.auth_sessions',`${schema}.fixture_auth_sessions`),args),release:()=>c.release()};},async query(sql,args){const c=await this.connect();try{return await c.query(sql,args);}finally{c.release();}}};
  const household={id:randomUUID(),timezone:'America/Denver'},env={FAMILY_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')},now=new Date();
  const parent=(name,role)=>({authType:'user',role,user:{id:randomUUID(),name},sessionId:randomUUID(),household});
  const forest=parent('Test parent A','admin'),erika=parent('Test parent B','member'),frame={authType:'frame',user:{id:randomUUID()},household,actor:'frame:fixture'};
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    for(const file of ['schema.sql','mobile-schema.sql','notifications-schema.sql','child-accounts-schema.sql','calendar-sync-schema.sql','chore-schema.sql','school-schema.sql','daily-task-sections-schema.sql','account-notifications-schema.sql','internet-schema.sql','family-notifications-schema.sql','account-deletion-schema.sql','parent-pin-schema.sql']) await db.query(await readFile(new URL(file,import.meta.url),'utf8'));
    await db.query('CREATE TABLE fixture_auth_sessions(id uuid PRIMARY KEY,user_id uuid,not_after timestamptz)');
    await db.query("INSERT INTO family_households(id,title,timezone) VALUES($1,'PIN fixture','America/Denver')",[household.id]);
    for(const p of [forest,erika]) {
      await db.query('INSERT INTO family_members(household_id,user_id,name,email,role,manage_chores,manage_internet) VALUES($1,$2,$3,$4,$5,true,true)',[household.id,p.user.id,p.user.name,`${p.user.id}@example.invalid`,p.role]);
      await db.query('INSERT INTO fixture_auth_sessions(id,user_id) VALUES($1,$2)',[p.sessionId,p.user.id]);
      assert.equal((await parentPinSettings(db,p,{pin:p===forest?'2468':'1357'},{env})).configured,true);
    }
    await db.query("INSERT INTO family_devices(id,household_id,label,token_hash) VALUES($1,$2,'PIN frame','pin-frame-fixture')",[frame.user.id,household.id]);
    assert.deepEqual(Object.keys(await parentPinSettings(db,forest,undefined,{env})).sort(),['configured','updatedAt']);
    await assert.rejects(parentPinSettings(db,erika,{pin:'2468'},{env}),e=>e.code==='parent_pin_in_use');
    const hashes=(await db.query('SELECT frame_pin_hash,frame_pin_salt FROM family_members ORDER BY user_id')).rows;
    assert.notEqual(hashes[0].frame_pin_hash,hashes[1].frame_pin_hash);assert.ok(hashes.every(h=>!JSON.stringify(h).includes('2468')));
    await assert.rejects(parentPinSettings(db,{...forest,role:'child'},{pin:'2468'},{env}),e=>e.status===403);
    await assert.rejects(parentPinSettings(db,frame,{pin:'2468'},{env}),e=>e.status===403);
    await assert.rejects(parentPinSettings(db,forest,{pin:'12345'},{env}),e=>e.status===422);
    await assert.rejects(redeemParentPin(db,{...frame,household:{id:randomUUID()}},{pin:'2468'},{env,now}),e=>e.status===403);
    for(let n=1;n<=5;n++) await assert.rejects(redeemParentPin(db,frame,{pin:'0000'},{env,now}),e=>e.code===(n===5?'parent_pin_locked':'invalid_parent_pin'));
    await assert.rejects(redeemParentPin(db,frame,{pin:'2468'},{env,now}),e=>e.code==='parent_pin_locked');
    const later=new Date(+now+16*60_000),grant=await redeemParentPin(db,frame,{pin:'2468'},{env,now:later});
    const unlocked=await frameAuthorization(db,frame,grant.token,later);assert.equal(unlocked.verifiedFrameGrant.scope,'parent');assert.equal(unlocked.verifiedCapabilities.manageInternet,true);
    const row=(await db.query('SELECT created_by FROM family_frame_authorizations WHERE id=$1',[unlocked.verifiedFrameGrant.id])).rows[0];assert.equal(row.created_by,forest.user.id);
    await assert.rejects(frameAuthorization(db,{...frame,user:{id:randomUUID()}},grant.token,later),e=>e.code==='invalid_unlock');
    await parentPinSettings(db,forest,{pin:'8642'},{env});await assert.rejects(frameAuthorization(db,frame,grant.token,later),e=>e.code==='invalid_unlock');
    const other=await redeemParentPin(db,frame,{pin:'1357'},{env,now});assert.ok(other.token);
    await revokeFrameAccessAfterRecovery(db,erika.user.id);
    assert.equal((await parentPinSettings(db,erika,undefined,{env})).configured,false);
    await assert.rejects(redeemParentPin(db,frame,{pin:'1357'},{env,now}),e=>e.code==='invalid_parent_pin');
    await db.query('UPDATE fixture_auth_sessions SET not_after=clock_timestamp()-interval \'1 second\' WHERE id=$1',[forest.sessionId]);
    await assert.rejects(parentPinSettings(db,forest,{pin:'2468'},{env}),e=>e.code==='session_required');
    await db.query('UPDATE family_members SET revoked_at=now() WHERE user_id=$1',[forest.user.id]);
    await assert.rejects(redeemParentPin(db,frame,{pin:'8642'},{env,now}),e=>e.code==='invalid_parent_pin');
  } finally {await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
});
