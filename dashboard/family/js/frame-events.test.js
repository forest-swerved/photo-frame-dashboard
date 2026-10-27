import test from 'node:test';
import assert from 'node:assert/strict';
import { frameEventCandidates } from './frame-events.js';
const now = Date.parse('2026-10-27T18:00Z'), zone = 'America/Denver';
const event = { id:'event-a', calendarId:'calendar-a', title:'Practice', allDay:false, startAt:'2026-10-27T18:10Z', endAt:'2026-10-27T19:10Z' };
const calendar = (events=[event]) => ({status:'ready',lastSuccessfulSyncAt:'2026-10-27T17:59Z',events,coverage:{timeZone:zone,startDate:'2026-10-27',endDateExclusive:'2026-10-28',complete:true,truncated:false}});
test('frame reminders open ten minutes before a timed event, then once at its start', () => {
  assert.deepEqual(frameEventCandidates(calendar(),zone,now-1),[]);
  const soon=frameEventCandidates(calendar(),zone,now)[0]; assert.equal(soon.phase,'soon');
  const starting=frameEventCandidates(calendar(),zone,now+10*60_000)[0]; assert.equal(starting.phase,'starting'); assert.notEqual(soon.key,starting.key);
  assert.deepEqual(frameEventCandidates(calendar(),zone,now+11*60_000),[]);
});
test('missing, stale, partial, wrong-zone and uncovered snapshots cannot announce events', () => {
  const good=calendar();
  for (const snapshot of [null, ...['stale','loading','error','not_configured'].map(status=>({...good,status})),
    {...good,lastSuccessfulSyncAt:null},{...good,lastSuccessfulSyncAt:'2026-10-27T17:44Z'},
    {...good,coverage:{...good.coverage,complete:false}},{...good,coverage:{...good.coverage,truncated:true}},
    {...good,coverage:{...good.coverage,timeZone:'UTC'}},{...good,coverage:{...good.coverage,endDateExclusive:'2026-10-27'}}]) assert.deepEqual(frameEventCandidates(snapshot,zone,now),[]);
});
test('all-day, cancelled, invalid and ended events never interrupt the frame', () => {
  assert.deepEqual(frameEventCandidates(calendar([{...event,allDay:true},{...event,status:'cancelled'},{...event,startAt:'invalid'},{...event,endAt:'2026-10-27T17:59Z'}]),zone,now),[]);
});
test('occurrences distinguish recurrence starts and calendar identity across DST', () => {
  const events=[event,{...event,calendarId:'calendar-b'},{...event,id:'event-b',startAt:'2026-10-27T18:05Z'}];
  const results=frameEventCandidates(calendar(events),zone,now); assert.equal(new Set(results.map(x=>x.key)).size,3); assert.equal(results[0].id,'event-b');
  const autumn={...event,startAt:'2026-11-01T08:30Z',endAt:'2026-11-01T09:30Z'};
  const snapshot={...calendar([autumn]),lastSuccessfulSyncAt:'2026-11-01T08:19Z',coverage:{...calendar().coverage,startDate:'2026-11-01',endDateExclusive:'2026-11-02'}};
  assert.equal(frameEventCandidates(snapshot,zone,Date.parse('2026-11-01T08:20Z'))[0].phase,'soon');
});
