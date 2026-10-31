import test from 'node:test';
import {sessionSoundState} from './internet-ui.js';
import assert from 'node:assert/strict';
import {createFrameSounds, DEFAULT_FRAME_SOUNDS, normalizeFrameSounds, frameSoundsAreQuiet, taskCompletionCue} from './frame-sounds.js';
function fixture() {
  let time=Date.parse('2026-10-31T18:00:00Z'),frame=true,visible=true,created=0,stopped=0;
  const played=[],stored=new Map(),param={setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}};
  const context={state:'suspended',currentTime:0,destination:{},resume(){this.state='running';return Promise.resolve();},createGain:()=>({gain:{...param,value:0},connect(){},disconnect(){}}),createOscillator:()=>({frequency:param,connect(){},disconnect(){},start(){},stop(){stopped++;}})};
  const sound=createFrameSounds({enabled:()=>frame,visible:()=>visible,now:()=>time,timezone:()=> 'America/Denver',storage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)},contextFactory:()=>{created++;return context;},onPlay:name=>played.push(name)});
  return {sound,played,stored,context,advance:(ms=1200)=>{time+=ms;},frame:value=>{frame=value;},visible:value=>{visible=value;},created:()=>created,stopped:()=>stopped};
}
test('frame-only, gesture-gated audio reuses one context and stops on mute',()=>{
  const f=fixture();assert.equal(f.sound.play('complete'),false);assert.equal(f.created(),0);f.frame(false);f.sound.unlock();assert.equal(f.created(),0);
  f.frame(true);f.sound.unlock();f.sound.unlock();assert.equal(f.created(),1);assert.equal(f.sound.play('complete'),true);
  f.advance();f.visible(false);assert.equal(f.sound.play('complete'),false);f.visible(true);
  f.sound.update({enabled:false});assert.ok(f.stopped()>0);assert.equal(f.sound.play('allDone',{preview:true}),false);
  f.sound.update({enabled:true,volume:0});assert.equal(f.sound.play('allDone',{preview:true}),false);assert.equal(JSON.parse([...f.stored.values()][0]).volume,0);
});
test('quiet hours follow household time, including midnight; previews respect mute',()=>{
  assert.equal(frameSoundsAreQuiet(DEFAULT_FRAME_SOUNDS,Date.parse('2026-11-01T03:00:00Z'),'America/Denver'),true);
  assert.equal(frameSoundsAreQuiet(DEFAULT_FRAME_SOUNDS,Date.parse('2026-11-01T14:00:00Z'),'America/Denver'),false);
  assert.equal(frameSoundsAreQuiet(DEFAULT_FRAME_SOUNDS,Date.now(),'invalid'),true);assert.equal(normalizeFrameSounds({volume:9,enabled:'yes',quietStart:'99:00'}).quietStart,'21:00');
  const f=fixture();f.sound.unlock();f.sound.update({quietStart:'00:00',quietEnd:'23:59',celebrations:false});assert.equal(f.sound.play('allDone'),false);assert.equal(f.sound.play('allDone',{preview:true}),true);
});
test('semantic outcomes supersede taps; celebrations suppress duplicate and lower-priority noise',()=>{
  const f=fixture();f.sound.unlock();f.sound.play('open');assert.equal(f.sound.play('complete'),true);f.advance();assert.equal(f.sound.play('allDone',{key:'child-day'}),true);
  f.advance(100);assert.equal(f.sound.play('reward'),false);assert.equal(f.sound.play('tap'),false);f.advance();assert.equal(f.sound.play('allDone',{key:'child-day'}),false);assert.equal(f.sound.play('error'),true);assert.deepEqual(f.played,['open','complete','allDone','error']);
});
test('submitted work and optional-only days cannot trigger the required-task milestone',()=>{
  assert.equal(taskCompletionCue({remaining:1},{total:1,remaining:0},{completed:true,status:'completed'}),'allDone');
  assert.equal(taskCompletionCue({remaining:1},{total:1,remaining:1},{completed:true,status:'submitted'}),'submitted');
  assert.equal(taskCompletionCue({remaining:0},{total:0,remaining:0},{completed:true}),'complete');
  assert.equal(taskCompletionCue({remaining:0},{total:1,remaining:1},{completed:false}),'undo');
});
test('timer cues track transitions once, silence initial/stale/paused snapshots and reset scopes',()=>{
  const f=fixture();f.sound.unlock();const row={id:'timer',running:true,phase:'preparation',remaining:5,deadline:'end',warning:60};const observe=(change={},scope='home',fresh=true)=>f.sound.observeTimers([{...row,...change}],scope,fresh);
  observe();assert.deepEqual(f.played,[]);observe({phase:'usage',remaining:120});assert.deepEqual(f.played,['timerStart']);f.advance();observe({phase:'usage',remaining:60});assert.deepEqual(f.played,['timerStart','timerWarning']);f.advance();
  observe({phase:'usage',remaining:0});observe({phase:'usage',remaining:0});assert.equal(f.played.at(-1),'timerEnd');assert.equal(f.played.length,3);f.advance();observe({phase:'usage',remaining:1},'home',false);observe({phase:'usage',remaining:0});assert.equal(f.played.length,3);
  observe({phase:'usage',remaining:5,running:false});observe({phase:'usage',remaining:0,running:false});assert.equal(f.played.length,3);observe({phase:'usage',remaining:0},'other');assert.equal(f.played.length,3);
  f.advance();observe({id:'new',running:false,pending:true,remaining:300},'other');observe({id:'new',remaining:300},'other');assert.equal(f.played.at(-1),'timerStart');
});
test('unavailable storage and audio cannot prevent the rest of the app from working',()=>{
  const sounds=createFrameSounds({enabled:()=>true,visible:()=>true,storage:{getItem(){throw Error();},setItem(){throw Error();}},contextFactory(){throw Error();}});
  assert.doesNotThrow(()=>{sounds.unlock();sounds.update({enabled:false});});assert.equal(sounds.play('complete'),false);
});

test('timer expiry sounds survive an ended response but not a manual early stop or unconfirmed access',()=>{
  const time=Date.parse('2026-10-31T18:00:00Z'),session={id:'test',endsAt:new Date(time).toISOString(),state:'ended'};
  assert.equal(sessionSoundState(session,5,time).running,true);assert.equal(sessionSoundState(session,5,time).remaining,0);
  assert.equal(sessionSoundState(session,5,time-1000).running,false);
  assert.equal(sessionSoundState({...session,state:'active',observedState:'unknown'},5,time).running,false);
});
