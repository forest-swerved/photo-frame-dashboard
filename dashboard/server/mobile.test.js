import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {authenticateMobile,createMobileSession,mobileAdmin} from './mobile.js';
import {dueTimeField,reminderMinutesField,setCompletion} from './household.js';
import {handleRequest} from './app.js';

const id=randomUUID(),householdId=randomUUID(),personId=randomUUID();
const principal={authType:'mobile',actor:`mobile:${id}`,mobileSessionId:id,role:'child',personId,user:{id:personId,name:'Child'},household:{id:householdId,title:'Test household',timezone:'America/Denver'}};
const token='a'.repeat(43);
const request=(authorization=`FamilyMobile ${token}`)=>new Request('https://family.example/api/mobile/session',{headers:{authorization}});
const row={id,kind:'parent',household_id:householdId,title:'Test household',timezone:'America/Denver',user_id:randomUUID(),member_name:'Parent',member_role:'admin',member_revoked_at:null,active_provider_session:randomUUID(),person_id:null};
const fakeDb=value=>({async query(sql){if(sql.startsWith('SELECT'))return {rows:value?[value]:[]};return {rows:[],rowCount:1};}});

test('malformed mobile credentials cannot reach storage',async()=>{
 for(const header of ['','Bearer '+token,'FamilyMobile short','FamilyMobile '+token+'!']){
  await assert.rejects(authenticateMobile(request(header),{query(){throw Error('Unexpected query');}}),e=>e.code==='mobile_session_required');
 }
});
test('native parents lose access when provider session or household membership is revoked',async()=>{
 for(const invalid of [{...row,active_provider_session:null},{...row,member_revoked_at:new Date()},{...row,member_role:null}]){
  await assert.rejects(authenticateMobile(request(),fakeDb(invalid)),e=>e.code==='mobile_session_revoked');
 }
 const changed=await authenticateMobile(request(),fakeDb({...row,member_role:'member'}));
 assert.equal(changed.role,'member');assert.throws(()=>mobileAdmin(changed),e=>e.status===403);
});
test('kid sessions derive their person and role from stored pairing, never request fields',async()=>{
 const kid={...row,kind:'child',person_id:personId,person_name:'Test child',member_role:'admin',user_id:null};
 const actual=await authenticateMobile(request(),fakeDb(kid));assert.equal(actual.role,'child');assert.equal(actual.personId,personId);assert.equal(actual.user.id,personId);
 assert.throws(()=>mobileAdmin(actual),e=>e.status===403);
 await assert.rejects(authenticateMobile(request(),fakeDb({...kid,person_name:null})),e=>e.code==='mobile_session_revoked');
});
test('a frame or paired child cannot exchange its credential for a parent session',async()=>{
 for(const p of [principal,{...principal,authType:'frame',role:'frame'},{...principal,authType:'user',role:'admin',sessionId:null}]){
  await assert.rejects(createMobileSession({query(){throw Error('Unexpected write');}},p,{}),e=>e.status===403);
 }
});
test('completion authorization rejects a sibling chore before completion or notification writes',async()=>{
 let completionWrites=0;
 const client={release(){},async query(sql){if(/INSERT INTO family_completions|INSERT INTO family_mutations/.test(sql))completionWrites++;return {rows:[]};}};
 const db={async connect(){return client;}};
 await assert.rejects(setCompletion(db,principal,randomUUID(),'2026-10-17',{completed:true,expectedVersion:0,mutationId:randomUUID()}),e=>e.status===404);
 assert.equal(completionWrites,0);
});
test('deadline inputs preserve midnight and reject invalid wall times and unbounded reminders',()=>{
 for(const t of ['00:00','23:59','06:30',null])assert.equal(dueTimeField(t),t);
 for(const t of ['24:00','12:60','8:00','2026-10-17',42])assert.throws(()=>dueTimeField(t),e=>e.status===422);
 for(const n of [0,15,1440])assert.equal(reminderMinutesField(n),n);
 for(const n of [-1,1441,1.5,'15'])assert.throws(()=>reminderMinutesField(n),e=>e.status===422);
});
test('job invocation rejects missing secret and wrong authorization without processing',async()=>{
 const req=new Request('https://family.example/api/mobile/jobs/notifications');
 assert.equal((await handleRequest(req,{db:{},env:{}})).status,503);
 assert.equal((await handleRequest(req,{db:{},env:{CRON_SECRET:'z'.repeat(48)}})).status,401);
});
test('mobile readiness distinguishes missing Apple setup from operational push',async()=>{
 const r=await handleRequest(new Request('https://family.example/api/mobile/status'),{db:{},env:{},authenticate:async()=>principal});
 assert.equal(r.status,200);assert.deepEqual((await r.json()).data.pushConfigured,false);
});
