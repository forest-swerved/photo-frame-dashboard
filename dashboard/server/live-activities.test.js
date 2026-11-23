import test from 'node:test';
import assert from 'node:assert/strict';
import { liveActivityContent, liveActivityPayload } from './live-activities.js';
const now=new Date('2026-11-22T22:00:00Z');
const item={id:'device',person:'Alex',device:'Console',status:'Time running',endsAt:new Date(+now+60000).toISOString(),preparationEndsAt:null};
test('only confirmed running time or an on override can start an activity; paused/off do not',()=>{
 for(const status of ['Time running','Internet on'])assert.equal(liveActivityContent({checkedAt:now,items:[{...item,status}]}).confirmed,true);
 for(const status of ['Paused','Internet off','Checking access','Confirming block'])assert.equal(liveActivityContent({checkedAt:now,items:[{...item,status}]}).confirmed,false);
 assert.equal(liveActivityContent({checkedAt:now,items:[{...item,status:'Paused'}]}).content.totalCount,0);
});
test('ActivityKit wire format uses bounded Codable state, distinct start/update/end and immediate dismissal',()=>{
 const state=liveActivityContent({checkedAt:now,items:Array.from({length:12},(_,i)=>({...item,id:String(i)}))},false).content;
 assert.equal(state.items.length,4);assert.equal(state.totalCount,12);assert.equal(state.items[0].person,'');assert.equal(state.items[0].device,'Device');
 assert.equal(state.items[0].endsAt,+now/1000+60);
 const start=liveActivityPayload('start',state,'registration','run',now);
 assert.equal(start.aps['attributes-type'],'DeviceAccessActivityAttributes');assert.equal(start.aps['input-push-token'],1);assert.ok(start.aps.alert);
 assert.equal(liveActivityPayload('update',state,'registration','run',now).aps.alert,undefined);
 assert.ok(liveActivityPayload('end',state,'registration','run',now).aps['dismissal-date']<+now/1000);
 assert.ok(Buffer.byteLength(JSON.stringify(start))<4096);
});
