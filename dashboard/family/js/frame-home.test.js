import test from 'node:test';
import assert from 'node:assert/strict';
import { frameTaskLanes } from './frame-home.js';

const profiles = [{ id:'first',name:'First child' },{ id:'second',name:'Second child' }];
const day = {type:'school_day'};
const task = (id,personId,status='pending',extra={}) => ({id,personId,status,required:true,taskSection:'before_school',...extra});
test('frame home always projects separate child lanes and individual required counts', () => {
  const tasks=[task('a','first'),task('b','first','completed'),task('c','second'),task('d','second','submitted'),task('e','second','pending',{required:false})];
  const lanes=frameTaskLanes(profiles,tasks,day);
  assert.deepEqual(lanes.map(l=>[l.profile.id,l.overview.completed,l.overview.total]),[['first',1,2],['second',0,2]]);
  assert.deepEqual(lanes[0].visible.map(t=>t.id),['a','b']); assert.equal(lanes[1].groups.submitted.length,1);
  assert.equal(frameTaskLanes(profiles,[],day).length,2,'An empty child lane must remain visible.');
});
test('completed-only lanes persist; skipped and earlier school schedules never inflate the count', () => {
  const tasks=[task('done','first','completed'),task('skip','first','skipped'),task('old','second','pending',{schoolDayFilter:'non_school_day'})];
  const lanes=frameTaskLanes(profiles,tasks,day);
  assert.equal(lanes[0].overview.completed,1);assert.equal(lanes[0].overview.total,1);assert.equal(lanes[0].visible[0].id,'done');
  assert.deepEqual(lanes[0].sections.map(s=>s.id),['completed']);
  assert.equal(lanes[1].overview.total,0);assert.equal(lanes[1].visible.length,0);
});
test('all completed tasks follow every unfinished school section, including waiting approvals', () => {
  const tasks=[task('morning-done','first','completed'),task('afternoon','first','pending',{taskSection:'after_school'}),
    task('approval','first','submitted'),task('optional-done','first','completed',{required:false,taskSection:'after_school'})];
  const lane=frameTaskLanes(profiles,tasks,day)[0];
  assert.deepEqual(lane.sections.map(s=>[s.id,s.items.map(t=>t.id)]),[
    ['before_school',['approval']],['after_school',['afternoon']],['completed',['morning-done','optional-done']]]);
  assert.equal(lane.sections.at(-1).label,'Completed today');
  assert.deepEqual([lane.overview.completed,lane.overview.total],[1,3]);
  const off=frameTaskLanes(profiles,tasks,{type:'non_school_day'})[0];
  assert.deepEqual(off.sections.map(s=>s.id),['tasks','completed']);
});
test('day-off sections flatten, and a child-scoped snapshot cannot retain another profile', () => {
  const tasks=[task('a','first'),task('b','second')];
  const lanes=frameTaskLanes(profiles,tasks,{type:'non_school_day'});
  assert.deepEqual(lanes.map(l=>l.sections.map(s=>s.id)),[['tasks'],['tasks']]);
  const scoped=frameTaskLanes([profiles[1]],[tasks[1]],day);
  assert.deepEqual(scoped.map(l=>l.profile.id),['second']);assert.deepEqual(scoped[0].visible.map(t=>t.id),['b']);
});
