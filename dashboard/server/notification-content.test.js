import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationContent, notificationThread, notificationCategory, notificationPreviewPayload } from './notification-content.js';
import { lockScreenPayload } from './notifications.js';
const event = (type,payload={}) => ({type,household_id:'home-fixture',person_id:'stevie-fixture',date:'2026-10-28',occurred_at:'2026-10-28T22:41:00Z',timezone:'America/Denver',payload:{personName:'Stevie',...payload}});

test('task alerts put the child first, separate the task, and use the household time',()=>{
  assert.deepEqual(notificationContent(event('chore_completed',{title:'Read for 30 Minutes'})),{
    title:'Stevie finished a task',subtitle:'Read for 30 Minutes',body:"Marked done at 4:41 PM MDT. Open Tasks to see today's progress."
  });
  assert.match(notificationContent(event('chore_due_soon',{title:'Backpack ready',dueTime:'07:30:00'})).body,/7:30 AM MDT/);
  assert.match(notificationContent(event('chore_submitted',{title:'Dishes'})).body,/approve it or send it back/);
});
test('confirmed starts distinguish full usage from preparation and include the actual deadline',()=>{
  const content=notificationContent(event('session_started',{deviceName:"Stevie's iPad",minutes:120,preparationSeconds:300,endsAt:'2026-10-29T00:47:00Z'}));
  assert.equal(content.subtitle,"Stevie's iPad · 2 hours");
  assert.equal(content.body,'5 minutes to get ready, then 2 hours. This window ends at 6:47 PM MDT.');
  assert.match(notificationContent(event('session_started',{preparationSeconds:359,minutes:60})).body,/5 minutes 59 seconds to get ready/);
  const old=notificationContent(event('session_started',{deviceName:'PS5',source:'reward'}));
  assert.match(old.subtitle,/PS5.*earned/);assert.doesNotMatch(old.subtitle,/1 minute/);assert.match(old.body,/current deadline/);
});
test('the self-addressed test is an explicit preview with no invented family event or identifiers',()=>{
  const payload=notificationPreviewPayload();
  assert.equal(payload.aps.category,'FAMILY_PREVIEW');assert.equal(payload.aps['mutable-content'],1);
  assert.match(payload.aps.alert.subtitle,/preview/);assert.deepEqual(Object.keys(payload).sort(),['aps','artwork']);
  assert.ok(Buffer.byteLength(JSON.stringify(payload))<4096);
});
test('paused, resumed, ended and expiring alerts identify whose device and remaining time',()=>{
  for(const type of ['session_paused','session_adjusted','session_warning','session_ended','session_expired']) {
    const content=notificationContent(event(type,{deviceName:'Nintendo Switch 2',usageRemainingSeconds:240,endsAt:'2026-10-29T00:47Z',action:'resume'}));
    assert.match(content.title,/Stevie/);assert.equal(content.subtitle,'Nintendo Switch 2');
    if(['session_paused','session_adjusted','session_warning'].includes(type)) assert.match(content.title+content.body,/4 minutes/);
  }
  assert.match(notificationContent(event('session_adjusted',{paused:true,usageRemainingSeconds:1800})).body,/30 minutes saved.*still paused/);
});
test('queued grants never claim network access is already confirmed or invent a deadline',()=>{
  const content=notificationContent(event('access_granted',{actorName:'Forest',deviceName:'PS5',minutes:60}));
  assert.equal(content.subtitle,'PS5 · 1 hour');assert.match(content.body,/Network confirmation is pending/);assert.doesNotMatch(content.body,/is on|ends at/);
  assert.match(notificationContent(event('access_granted',{deviceName:'PS5',allDay:true})).subtitle,/All day/);
  assert.match(notificationContent(event('access_granted',{deviceName:'PS5',indefinite:true})).subtitle,/Until a parent turns it off/);
});
test('detailed device alerts use bundled artwork and foreground review categories',()=>{
  for(const [kind,name,artwork] of [['console','PS5','ps5'],['console','Nintendo Switch 2','switch'],['tablet',"Erika's iPad Pro 13",'tablet-pro'],['tablet',"Stevie's iPad",'tablet']]) {
    const payload=lockScreenPayload('opaque-fixture',event('session_started',{deviceKind:kind,deviceName:name,minutes:60}));
    assert.equal(payload.artwork,artwork);assert.equal(payload.aps['mutable-content'],1);assert.equal(payload.aps.category,'FAMILY_INTERNET');
    assert.deepEqual(Object.keys(payload).sort(),['aps','artwork','notificationId']);
  }
  assert.equal(notificationCategory('access_requested'),'FAMILY_ACCESS_REQUEST');
});
test('threads separate children, dates and sessions without putting identifiers in the payload',()=>{
  const one=event('chore_completed',{title:'Reading'}), two={...one,type:'chore_reopened'};
  assert.equal(notificationThread(one),notificationThread(two));
  for(const changed of [{person_id:'andre-fixture'},{household_id:'other-home'},{date:'2026-10-29'}]) assert.notEqual(notificationThread(one),notificationThread({...one,...changed}));
  assert.notEqual(notificationThread(event('session_started',{sessionId:'first'})),notificationThread(event('session_started',{sessionId:'second'})));
  assert.match(notificationThread(one),/^ff-[0-9a-f]{32}$/);
});
test('private alerts have no subtitle, rich metadata, family-specific grouping or category',()=>{
  const payload=lockScreenPayload('opaque-fixture');
  assert.equal(payload.aps.category,'FAMILY_UPDATE');assert.equal(payload.aps['thread-id'],'family-frame');
  assert.deepEqual(Object.keys(payload).sort(),['aps','notificationId']);
  for(const field of ['subtitle','mutable-content','artwork','personId','deviceId']) assert.equal(JSON.stringify(payload).includes(field),false);
});
test('long unicode names and reasons remain readable, single-line and below the APNs byte limit',()=>{
  const payload=lockScreenPayload('opaque-fixture',event('access_requested',{personName:'😀'.repeat(200),deviceName:'🎮'.repeat(200),reason:'\n😀 '.repeat(1000),minutes:45}));
  assert.ok(Buffer.byteLength(JSON.stringify(payload))<4096);assert.doesNotMatch(JSON.stringify(payload.aps.alert),/\\n/);
  assert.match(notificationContent(event('session_started',{minutes:Infinity})).subtitle,/Their device/);
});
