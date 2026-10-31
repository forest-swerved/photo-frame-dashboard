import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createPool } from './database.js';
import { listMedia, mediaContent, uploadPhoto, reserveVideo, finishVideo, removeMedia, cleanupMedia } from './media.js';
import { verifySchema } from './verify-schema.js';
const enabled=process.env.FAMILY_RUN_DB_TESTS==='1';
test('private media: household isolation, idempotency, quota races and durable deletion cleanup', {skip:!enabled,timeout:120000}, async t=>{
 const pool=createPool(process.env,{migration:true,max:6}),schema=`family_media_test_${randomUUID().replaceAll('-','')}`;let created=false;
 const db={async connect(){const c=await pool.connect();await c.query(`SET search_path TO ${schema},pg_catalog`);return c;},async query(sql,values){const c=await this.connect();try{return await c.query(sql,values);}finally{c.release();}}};
 const householdId=randomUUID(), principal={authType:'mobile',role:'admin',household:{id:householdId}}, other={...principal,household:{id:randomUUID()}}, calls=[];
 const options={storage:async(op,key,data)=>{calls.push({op,key,bytes:data?.length});return op==='inspect'?{bytes:1024}:op.endsWith('url')?{url:'https://example.supabase.co/storage/v1/object/signed/test'}:{ok:true};}};
 const image=await sharp({create:{width:80,height:60,channels:3,background:'#aba0ff'}}).jpeg().toBuffer();
 const request=()=>new Request('https://test/api/media',{method:'PUT',headers:{'content-type':'image/jpeg'},body:image});
 try{
  assert.equal((await pool.query('select current_database() as name')).rows[0].name,'family_frame_tests','Refusing test DDL outside dedicated database');
  await pool.query(`CREATE SCHEMA ${schema}`);created=true;
  for(const file of ['schema.sql','mobile-schema.sql','notifications-schema.sql','child-accounts-schema.sql','calendar-sync-schema.sql','chore-schema.sql','school-schema.sql','daily-task-sections-schema.sql','account-notifications-schema.sql','internet-schema.sql','family-notifications-schema.sql','account-deletion-schema.sql','parent-pin-schema.sql','media-schema.sql'])await db.query(await readFile(new URL(file,import.meta.url),'utf8'));
  await db.query('INSERT INTO family_households(id,title) VALUES($1,\'Synthetic media family\')',[householdId]);
  await t.test('schema preserves all private server-role boundaries',async()=>assert.equal(await verifySchema(db,schema,39),39));
  const id=randomUUID();
  await t.test('confirmed photo is idempotent and another household cannot read/remove it',async()=>{
   const saved=await uploadPhoto(db,principal,id,request(),options);assert.equal(saved.media.kind,'photo');
   await uploadPhoto(db,principal,id,request(),options);assert.equal(calls.filter(c=>c.op==='upload').length,1);
   assert.equal((await listMedia(db,other)).media.length,0);await assert.rejects(mediaContent(db,other,id,options),{code:'not_found'});
   await removeMedia(db,other,id,options);assert.equal((await listMedia(db,principal)).media.length,1);
  });
  const videoID=randomUUID(),draft={bytes:1024,width:1920,height:1080,duration:2,fingerprint:'a'.repeat(64)};
  await t.test('videos stay invisible until storage confirms complete bytes; retries keep the same item',async()=>{
   await reserveVideo(db,principal,videoID,draft,options);assert.equal((await listMedia(db,principal)).media.length,1);
   await assert.rejects(finishVideo(db,principal,videoID,{storage:async()=>({bytes:99})}),{code:'video_size_mismatch'});
   await finishVideo(db,principal,videoID,options);await finishVideo(db,principal,videoID,options);assert.equal((await listMedia(db,principal)).media.length,2);
   await assert.rejects(reserveVideo(db,principal,videoID,{...draft,fingerprint:'b'.repeat(64)},options),{code:'media_conflict'});
  });
  await t.test('simultaneous uploads cannot overrun item quota',async()=>{
   await db.query(`INSERT INTO family_media(id,household_id,kind,object_key,fingerprint,bytes,width,height,ready)
    SELECT gen_random_uuid(),$1::uuid,'photo',$1::text||'/'||gen_random_uuid()||'.jpg','seed',1,1,1,true FROM generate_series(1,197)`,[householdId]);
   const results=await Promise.allSettled([0,1].map(()=>reserveVideo(db,principal,randomUUID(),draft,options)));
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'media_bank_full');
  });
  await t.test('remove hides content immediately; durable cleanup survives household deletion and retries provider outages',async()=>{
   await removeMedia(db,principal,id,{storage:async()=>{throw Error('offline')}});await assert.rejects(mediaContent(db,principal,id,options),{code:'not_found'});
   assert.equal((await db.query('SELECT * FROM family_media_cleanup')).rowCount,1);
   await db.query('DELETE FROM family_households WHERE id=$1',[householdId]);assert.equal((await db.query('SELECT * FROM family_media')).rowCount,0);
   const count=(await db.query('SELECT * FROM family_media_cleanup')).rowCount;assert.equal(count,200);
   assert.equal((await cleanupMedia(db,options)).attempted,0,'signed upload URLs must expire before final cleanup');
   await db.query("UPDATE family_media_cleanup SET not_before=now()-interval '1 second'");
   assert.equal((await cleanupMedia(db,{storage:async()=>{throw Error('offline')}})).removed,0);
   assert.equal((await db.query('SELECT * FROM family_media_cleanup WHERE attempts=1')).rowCount,30);
   await db.query("UPDATE family_media_cleanup SET not_before=now()-interval '1 second'");assert.equal((await cleanupMedia(db,options)).removed,30);
  });
 }finally{if(created)await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();}
});
