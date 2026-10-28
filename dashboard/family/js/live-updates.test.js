import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveUpdates } from './live-updates.js';
const settle=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('status checks do not repeat unchanged domain reads and a slow household never delays Internet',async()=>{
  let now=0,tokens={household:'h1',internet:'i1',calendar:'c1'};
  const household=deferred(),counts={household:0,internet:0,calendar:0};
  const poll=createLiveUpdates({read:async()=>tokens,scope:()=>1,visible:()=>true,clock:()=>now,loaders:{
    household:()=>{counts.household++;return household.promise;},internet:async()=>{counts.internet++;},calendar:async()=>{counts.calendar++;}}});
  await poll.tick();await settle();assert.deepEqual(counts,{household:1,internet:1,calendar:1});
  now=2000;await poll.tick();await settle();assert.equal(counts.internet,1);
  tokens={...tokens,internet:'i2'};now=4000;await poll.tick();await settle();assert.equal(counts.internet,2);assert.equal(counts.household,1);
  household.resolve();await settle();
});
test('a domain read coalesces newer tokens and retries a failed read',async()=>{
  let now=0,token='one',calls=0;const first=deferred();
  const poll=createLiveUpdates({read:async()=>({internet:token}),scope:()=>1,visible:()=>true,clock:()=>now,
    loaders:{internet:()=>{calls++;return calls===1?first.promise:calls===2?Promise.resolve(false):Promise.resolve(true);}}});
  await poll.tick();await settle();token='two';now=2000;await poll.tick();await settle();assert.equal(calls,1);
  first.resolve(true);await settle();assert.equal(calls,2);
  now=4000;await poll.tick();await settle();assert.equal(calls,3);
  now=6000;await poll.tick();await settle();assert.equal(calls,3);
});
test('old login reads are discarded and hidden pages pause with immediate foreground catch-up',async()=>{
  let current='first',visible=true,now=0,reads=0,loads=0;const pending=deferred();
  const poll=createLiveUpdates({read:()=>++reads===1?pending.promise:Promise.resolve({internet:current}),scope:()=>current,visible:()=>visible,clock:()=>now,loaders:{internet:async()=>{loads++;}}});
  const old=poll.tick();current='second';pending.resolve({internet:'old'});await old;await settle();assert.equal(loads,0);
  await poll.tick();await settle();assert.equal(loads,1);
  visible=false;now=5000;await poll.tick();assert.equal(reads,2);
  visible=true;current='third';await poll.tick(true);await settle();assert.equal(loads,2);
});
test('connection failures back off and show a reconnecting state until recovery',async()=>{
  let now=0,reads=0;const statuses=[];
  const poll=createLiveUpdates({read:async()=>{if(++reads===1)throw Error('offline');return{};},scope:()=>1,visible:()=>true,clock:()=>now,loaders:{},onStatus:e=>statuses.push(e?.message||'ready')});
  await poll.tick();now=2000;await poll.tick();assert.equal(reads,1);
  now=4000;await poll.tick();assert.deepEqual(statuses,['offline','ready']);
});
