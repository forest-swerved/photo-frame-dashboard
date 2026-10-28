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
  assert.deepEqual(lanes[0].visible.map(t=>t.id),['a']); assert.equal(lanes[1].groups.submitted.length,1);
  assert.equal(frameTaskLanes(profiles,[],day).length,2,'An empty child lane must remain visible.');
});
test('completed-only lanes persist; skipped and earlier school schedules never inflate the count', () => {
  const tasks=[task('done','first','completed'),task('skip','first','skipped'),task('old','second','pending',{schoolDayFilter:'non_school_day'})];
  const lanes=frameTaskLanes(profiles,tasks,day,new Set(['done']));
  assert.equal(lanes[0].overview.completed,1);assert.equal(lanes[0].overview.total,1);assert.equal(lanes[0].visible[0].id,'done');
  assert.equal(lanes[1].overview.total,0);assert.equal(lanes[1].visible.length,0);
});
test('day-off sections flatten, and a child-scoped snapshot cannot retain another profile', () => {
  const tasks=[task('a','first'),task('b','second')];
  const lanes=frameTaskLanes(profiles,tasks,{type:'non_school_day'});
  assert.deepEqual(lanes.map(l=>l.sections.map(s=>s.id)),[['tasks'],['tasks']]);
  const scoped=frameTaskLanes([profiles[1]],[tasks[1]],day);
  assert.deepEqual(scoped.map(l=>l.profile.id),['second']);assert.deepEqual(scoped[0].visible.map(t=>t.id),['b']);
});
