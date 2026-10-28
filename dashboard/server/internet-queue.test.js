import test from 'node:test';
import assert from 'node:assert/strict';
import { drainInternetQueue, startsInternetWork } from './internet-queue.js';
test('only committed network mutation routes are eligible for a background kick',()=>{
  for(const route of ['internet/redeem','internet/grants','internet/devices/id/access','internet/sessions/id/actions','internet/requests/id/decision'])assert.equal(startsInternetWork(route,'POST'),true);
  for(const [route,method] of [['internet','GET'],['internet/jobs/process','GET'],['internet/requests','POST'],['household','GET']])assert.equal(startsInternetWork(route,method),false);
});
test('bounded drain handles dependent session end and device block without waiting for cron',async()=>{
  let now=0;const states=['waiting_for_sessions','ended','blocked'],seen=[];
  await drainInternetQueue({}, {clock:()=>new Date(now),sleep:async ms=>{now+=ms;},runJob:async()=>{seen.push(now);const state=states.shift();return state?{processed:1,state}:{processed:0};}});
  assert.equal(seen.length,4);assert.equal(seen[1],1100);
});
test('an uncertain command or occupied lease stops the kick; durable retry stays with the worker',async()=>{
  for(const result of [{processed:1,state:'checking'},{processed:0}]) {
    let calls=0;await drainInternetQueue({}, {runJob:async()=>{calls++;return result;}});assert.equal(calls,1);
  }
  let calls=0;await drainInternetQueue({}, {maxCommands:3,runJob:async()=>{calls++;return{processed:1,state:'active'};}});assert.equal(calls,3);
});
