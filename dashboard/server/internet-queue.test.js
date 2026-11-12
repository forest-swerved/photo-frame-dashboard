import test from 'node:test';
import assert from 'node:assert/strict';
import { drainInternetQueue, reconcileInternetQueue, startsInternetWork } from './internet-queue.js';
test('only committed network mutation routes are eligible for a background kick',()=>{
  for(const route of ['internet/redeem','internet/grants','internet/devices/id/access','internet/sessions/id/actions','internet/requests/id/decision'])assert.equal(startsInternetWork(route,'POST'),true);
  for(const [route,method] of [['internet','GET'],['internet/jobs/process','GET'],['internet/requests','POST'],['household','GET']])assert.equal(startsInternetWork(route,method),false);
});
test('bounded drain handles dependent session end and device block without waiting for cron',async()=>{
  let now=0;const states=['waiting_for_sessions','ended','blocked'],seen=[];
  await drainInternetQueue({}, {clock:()=>new Date(now),sleep:async ms=>{now+=ms;},runJob:async()=>{seen.push(now);const state=states.shift();return state?{processed:1,state}:{processed:0};}});
  assert.equal(seen.length,4);assert.equal(seen[1],1100);
});
test('a deferred failure does not stall another device, while occupied leases stop the bounded drain',async()=>{
  const states=['checking','blocked'], calls=[];
  const result=await drainInternetQueue({}, {runJob:async()=>{calls.push(1);const state=states.shift();return state?{processed:1,state}:{processed:0};}});
  assert.equal(calls.length,3);assert.equal(result.processed,2);assert.equal(result.state,'blocked');
  let occupied=0;await drainInternetQueue({}, {runJob:async()=>{occupied++;return{processed:0};}});assert.equal(occupied,1);
  let count=0;await drainInternetQueue({}, {maxCommands:3,runJob:async()=>{count++;return{processed:1,state:'checking'};}});assert.equal(count,3);
});
test('cron audits once and drains multiple device commands within its budget',async()=>{
  const audits=[];let now=0;
  const result=await reconcileInternetQueue({}, {clock:()=>new Date(now),maxMs:100,runJob:async(_db,options)=>{audits.push(options.audit);now+=60;return{processed:1,expiredQueued:options.audit?2:0,state:'blocked'};}});
  assert.deepEqual(audits,[true,false]);assert.equal(result.processed,2);assert.equal(result.expiredQueued,2);
});

test('provider-wide outages and rate limits stop the batch without exhausting every device’s retries',async()=>{
  for(const error of ['unifi_rate_limited','unifi_credentials_rejected','unifi_unavailable','unifi_deadline','network_unavailable']){
    let calls=0;const result=await drainInternetQueue({}, {runJob:async()=>{calls++;return{processed:1,state:'checking',error};}});
    assert.equal(calls,1);assert.equal(result.error,error);
  }
});
