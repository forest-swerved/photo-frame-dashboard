import test from 'node:test';
import assert from 'node:assert/strict';
import { taskOverview, taskGroups, agendaParts, completionLabel } from './presentation.js';

test('required progress excludes optional, excused and earlier-schedule work; submission is not completion', () => {
  const base = { date:'2026-10-26', originalDate:'2026-10-26', required:true };
  const items = [{...base,id:'done',status:'completed'}, {...base,id:'waiting',status:'submitted'},
    {...base,id:'next',status:'pending'}, {...base,id:'optional',required:false,status:'completed'},
    {...base,id:'excused',status:'skipped'}, {...base,id:'earlier',status:'completed',schoolDayFilter:'non_school_day'}];
  assert.deepEqual(taskOverview(items,{type:'school_day'}),{total:3,completed:1,remaining:2,submitted:1,todo:1,optional:1,optionalDone:1});
  const groups=taskGroups(items,{type:'school_day'});
  assert.deepEqual(groups.todo.map(item=>item.id),['next']);
  assert.deepEqual(groups.submitted.map(item=>item.id),['waiting']);
  assert.deepEqual(groups.history.map(item=>item.id),['excused','earlier']);
  assert.equal(completionLabel(items[1]),'Waiting for parent approval');
});
test('optional work cannot displace required work in a limited preview; input order remains unchanged', () => {
  const items=[{id:'optional',required:false,status:'pending'},{id:'required',required:true,status:'pending'}];
  assert.deepEqual(taskGroups(items).todo.map(item=>item.id),['required','optional']);
  assert.deepEqual(items.map(item=>item.id),['optional','required']);
  assert.deepEqual(taskOverview([],null),{total:0,completed:0,remaining:0,submitted:0,todo:0,optional:0,optionalDone:0});
});
test('agenda keeps all-day and overnight live events while separating elapsed events', () => {
  const allDay={id:'holiday',allDay:true};
  const earlier={id:'earlier',startAt:'2026-10-26T15:00:00Z',endAt:'2026-10-26T16:00:00Z'};
  const overnight={id:'overnight',startAt:'2026-10-25T23:00:00Z',endAt:'2026-10-26T20:00:00Z'};
  const upcoming={id:'upcoming',startAt:'2026-10-26T21:00:00Z',endAt:'2026-10-26T22:00:00Z'};
  assert.deepEqual(agendaParts([allDay,earlier,overnight,upcoming],Date.parse('2026-10-26T18:00:00Z')),
    {allDay:[allDay],upcoming:[overnight,upcoming],earlier:[earlier]});
});

test('optional submissions appear in the approval count without reducing remaining required work', () => {
  assert.deepEqual(taskOverview([{ required:true, status:'pending' },{ required:false, status:'submitted' }]),
    { total:1, completed:0, remaining:1, submitted:1, todo:1, optional:1, optionalDone:0 });
});
