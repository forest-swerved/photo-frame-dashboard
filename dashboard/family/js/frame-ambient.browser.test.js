import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
const base=process.env.FAMILY_UI_TEST_URL;
async function fixture({withMedia=false}={}){
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1808,height:1017}}),errors=[];
 page.setDefaultTimeout(10000);
 page.on('pageerror',error=>errors.push(error.message));
 const photo=await sharp({create:{width:960,height:540,channels:3,background:'#8873a5'}}).jpeg().toBuffer();
 const videoPath=join(tmpdir(),'frame-ambient-browser-video.mp4');
 if(withMedia)execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x604a86:s=640x360:r=25:d=8','-f','lavfi','-i','sine=frequency=440:duration=8','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-y',videoPath]);
 const video=withMedia?await readFile(videoPath):Buffer.alloc(0);let downloads=0;
 const bank=withMedia?[{id:'11111111-1111-4111-8111-111111111111',kind:'photo',bytes:photo.length},...['22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'].map(id=>({id,kind:'video',bytes:video.length,duration:8}))]:[];
 await page.route('**/fixture-media/*',async route=>{downloads++;const isPhoto=route.request().url().endsWith(bank[0].id);await route.fulfill({contentType:isPhoto?'image/jpeg':'video/mp4',body:isPhoto?photo:video});});
 await page.route('**/ambient-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/family/ambient.css"><div id="family-app"><button id="under">Home task</button></div><section id="frame-ambient" class="frame-ambient" hidden></section><script type="module">
 import {createFrameAmbient} from '/family/js/frame-ambient.js';
 window.time=0;window.wakes=0;window.writes=0;window.state={enabled:true,purge:false,scope:'authorized:frame',cacheScope:'fixture:frame',timezone:'America/Denver',title:'Synthetic family',people:[{id:'kid',name:'Stevie',color:'#9070b5'}],tasks:[],schoolDay:{type:'school_day'},calendar:{status:'ready',coverage:{complete:true},events:[]}};
 document.querySelector('#under').onclick=()=>window.writes++;
 window.ambient=createFrameAmbient(document.querySelector('#frame-ambient'),{state:()=>window.state,media:async()=>({media:${JSON.stringify(bank)}}),readMediaURL:async id=>({url:location.origin+'/fixture-media/'+id}),onWake:()=>window.wakes++,now:()=>window.time});
 window.step=ms=>{window.time+=ms;window.ambient.tick()};window.ambient.tick();window.ready=true;
 </script>`}));
 await page.goto(new URL('/ambient-test',base).href);await page.waitForFunction(()=>window.ready);
 if(withMedia)await page.waitForFunction(()=>ambient.status().cached===3&&ambient.status().total===3);
 return{browser,page,errors,downloads:()=>downloads};
}
test('ambient clock/date/agenda/tasks fit the FRAME156 and first touch returns Home without clicking through',{skip:!base},async()=>{
 const f=await fixture();try{
  await f.page.evaluate(()=>ambient.start());
  assert.equal(await f.page.locator('#frame-ambient').getAttribute('data-view'),'clock');
  assert.match(await f.page.locator('[data-ambient-time]').textContent(),/^(?:[1-9]|1[0-2]):[0-5][0-9]$/);
  assert.match(await f.page.locator('[data-ambient-period]').textContent(),/^(AM|PM)$/);
  await f.page.screenshot({path:'/tmp/family-frame-ambient-clock.png',animations:'disabled'});
  for(const type of ['date','calendar','tasks']){await f.page.evaluate(()=>step(20000));assert.equal(await f.page.locator('#frame-ambient').getAttribute('data-view'),type);}
  await f.page.screenshot({path:'/tmp/family-frame-ambient-tasks.png',animations:'disabled'});
  await f.page.locator('#frame-ambient').click();assert.equal(await f.page.evaluate(()=>wakes),1);assert.equal(await f.page.evaluate(()=>writes),0);
  assert.equal(await f.page.locator('#family-app').getAttribute('aria-hidden'),null);assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
});
test('photos use 20 seconds, videos advance on ended, sound persists only within one ambient session, and media survives reload in device cache',{skip:!base},async()=>{
 const f=await fixture({withMedia:true});try{
  await f.page.evaluate(()=>{ambient.start();step(20000)});await f.page.waitForFunction(()=>document.querySelector('.ambient-photo img')?.complete);
  assert.equal(await f.page.locator('#frame-ambient').getAttribute('data-view'),'photo');assert.match(await f.page.locator('.ambient-photo img').getAttribute('src'),/^blob:/);
  await f.page.evaluate(()=>step(19999));assert.equal(await f.page.locator('#frame-ambient').getAttribute('data-view'),'photo');
  await f.page.evaluate(()=>step(1));assert.equal(await f.page.locator('#frame-ambient').getAttribute('data-view'),'date');
  await f.page.evaluate(()=>step(20000));await f.page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
  assert.equal(await f.page.locator('video').evaluate(v=>v.muted),true);
  await f.page.getByRole('button',{name:'Unmute video',exact:true}).click();assert.equal(await f.page.locator('video').evaluate(v=>v.muted),false);assert.equal(await f.page.evaluate(()=>wakes),0);
  await f.page.locator('video').evaluate(v=>v.dispatchEvent(new Event('ended')));assert.equal(await f.page.locator('#frame-ambient').getAttribute('data-view'),'calendar');
  await f.page.evaluate(()=>step(20000));await f.page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);assert.equal(await f.page.locator('video').evaluate(v=>v.muted),false);
  await f.page.locator('#frame-ambient').click({position:{x:900,y:200}});assert.equal(await f.page.evaluate(()=>wakes),1);
  await f.page.evaluate(()=>{step(700);ambient.start();step(20000)});await f.page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);assert.equal(await f.page.locator('video').evaluate(v=>v.muted),true);
  assert.equal(f.downloads(),3);await f.page.reload();await f.page.waitForFunction(()=>window.ready);await f.page.evaluate(()=>ambient.start());assert.equal(f.downloads(),3,'reload reuses the local bank');
  await f.page.evaluate(()=>{state.enabled=false;state.purge=true;ambient.sync()});await f.page.waitForFunction(async()=>!(await caches.keys()).some(key=>key.startsWith('family-frame-media')));
  assert.equal(await f.page.locator('#frame-ambient').isVisible(),false);assert.deepEqual(f.errors,[]);
 }finally{await f.browser.close();}
});

for (const viewport of [{width:1808,height:1017},{width:1280,height:800}]) {
 test(`long ambient lists fit and rotate every item at ${viewport.width}x${viewport.height}`,{skip:!base},async()=>{
  const f=await fixture();try {
   await f.page.setViewportSize(viewport);
   await f.page.emulateMedia({reducedMotion:'reduce'});
   await f.page.evaluate(()=>{
    state.people=Array.from({length:6},(_,i)=>({id:`kid${i}`,name:`Child ${i+1}`,color:'#9070b5'}));
    state.tasks=state.people.flatMap(p=>Array.from({length:11},(_,i)=>({id:`${p.id}-${i}`,personId:p.id,title:`${p.id} task ${i+1}: Put away the school supplies and books in their correct places before getting ready for the next school day.`,status:'pending',required:true})));
    state.calendar.events=Array.from({length:13},(_,i)=>({id:`event${i}`,title:`Event ${i+1}: School family evening with a very long descriptive event name for the complete family schedule`,location:'Community center, downstairs meeting room next to the main reception area',startAt:new Date(Date.now()+i*3600000).toISOString(),endAt:new Date(Date.now()+(i+1)*3600000).toISOString()}));
    ambient.start();
   });
   const seenTasks=new Set(),seenEvents=new Set();
   for(let i=0;i<100;i++) {
    const result=await f.page.evaluate(()=>{
     const lists=[...document.querySelectorAll('[data-fit-person] ul,[data-fit-events]')];
     return {tasks:[...document.querySelectorAll('[data-fit-person] li')].map(n=>n.textContent),events:[...document.querySelectorAll('[data-fit-events] h2')].map(n=>n.textContent),overflow:lists.filter(n=>n.scrollHeight>n.clientHeight+1).map(n=>({height:n.clientHeight,scroll:n.scrollHeight})),offscreen:[...document.querySelectorAll('[data-fit-person] li,[data-fit-events] article,.ambient-page-note')].filter(n=>n.getBoundingClientRect().bottom>document.querySelector('.ambient-footer').getBoundingClientRect().top).map(n=>n.tagName)};
    });
    assert.deepEqual(result.overflow,[]);assert.deepEqual(result.offscreen,[]);
    result.tasks.forEach(v=>seenTasks.add(v));result.events.forEach(v=>seenEvents.add(v));
    if(i===3)await f.page.screenshot({path:`/tmp/family-frame-long-tasks-${viewport.width}.png`,animations:'disabled'});
    if(i===2)await f.page.screenshot({path:`/tmp/family-frame-long-events-${viewport.width}.png`,animations:'disabled'});
    await f.page.evaluate(()=>step(20000));
   }
   assert.equal(seenTasks.size,66,'every task is eventually shown without touch');assert.equal(seenEvents.size,13,'every upcoming event is eventually shown');assert.deepEqual(f.errors,[]);
  }finally {await f.browser.close();}
 });
}
