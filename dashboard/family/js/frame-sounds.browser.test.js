import test from 'node:test';
import assert from 'node:assert/strict';
const base=process.env.FAMILY_UI_TEST_URL;
async function fixture({paired=true,approval=false,manager=false}={}) {
  assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname));
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1808,height:1017}});
  page.setDefaultTimeout(8000);await page.clock.install({time:new Date('2026-10-27T18:00:00Z')});
  await page.addInitScript(()=>{
    window.audioTones=[];window.audioContexts=0;
    const gain=()=>({value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}});
    window.AudioContext=class {
      constructor(){window.audioContexts++;this.state='suspended';this.currentTime=0;this.destination={};}
      resume(){this.state='running';return Promise.resolve();}
      createGain(){return {gain:gain(),connect(){},disconnect(){}};}
      createOscillator(){let frequency;return {frequency:{setValueAtTime(value){frequency=value;}},connect(){},disconnect(){},start(){window.audioTones.push(frequency);},stop(){}};}
    };
  });
  const home={id:'sound-home',title:'Synthetic family',timezone:'America/Denver'},people=[{id:'a',name:'First',color:'#8a00c4'},{id:'b',name:'Second',color:'#00748c'}];
  const tasks=people.flatMap(p=>[0,1].map(i=>({id:`${p.id}-${i}`,choreId:`r-${p.id}-${i}`,personId:p.id,title:`${p.name} task ${i+1}`,date:'2026-10-27',originalDate:'2026-10-27',schoolDayFilter:'any',taskSection:'tasks',required:true,requiresApproval:approval,status:manager?'submitted':'pending',version:1,subtasks:[],completion:{date:'2026-10-27',completed:false,version:0}})));
  const state={tasks,errors:[],writes:[],hold:false,reject:false,revision:0};page.on('pageerror',e=>state.errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;let data;
    if(path==='/api/session')data={authenticated:true,authType:paired?'frame':'user',role:paired?(manager?'caregiver':'frame'):'member',household:home,user:{id:'sound-user',name:'Test'}};
    else if(path==='/api/auth/get-session')data={session:{expiresAt:'2099-01-01T00:00:00Z'},user:{id:'sound-user',email:'sound@example.invalid'}};
    else if(path==='/api/auth/token')data={token:'synthetic.token'};
    else if(path==='/api/household')data={household:home,date:'2026-10-27',people,routines:[],chores:[],occurrences:tasks,schoolDay:{type:'non_school_day'},capabilities:{manageChores:manager}};
    else if(path==='/api/calendar')data={status:'ready',events:[],calendars:[],coverage:{startDate:'2026-10-27',endDateExclusive:'2026-11-04',complete:true,timeZone:home.timezone},lastSuccessfulSyncAt:'2026-10-27T18:00:00Z'};
    else if(path==='/api/internet')data={serverTime:'2026-10-27T18:00:00Z',timezone:home.timezone,role:'frame',integration:{state:'ready'},devices:[],sessions:[],credits:[],policies:[],progress:[]};
    else if(path==='/api/live-status')data={household:String(state.revision)};
    else if(path==='/api/notifications')data={notifications:[]};
    else if(path.endsWith('/actions')){
      const task=tasks.find(t=>path.includes(t.id));task.status='completed';task.version++;data={occurrence:task};
    }
    else if(path.endsWith('/completion')){
      const body=req.postDataJSON(),task=tasks.find(t=>path.includes(t.id));state.writes.push(body);
      if(state.hold)await new Promise(resolve=>state.release=resolve);
      if(state.reject){await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'version_conflict',message:'Task changed',details:{current:task}}})});return;}
      task.version++;task.status=body.completed?(approval?'submitted':'completed'):'pending';task.completion={date:task.date,completed:task.status==='completed',version:task.version};data=task;
    }else throw Error(`Unexpected route ${path}`);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(path.startsWith('/api/auth/')?data:{data})});
  });
  await page.goto(new URL('/family.html?display=frame#today',base).href);await page.locator('.chore-row').first().waitFor();
  return {browser,page,state,tones:()=>page.evaluate(()=>audioTones),clear:async()=>{await page.clock.runFor(1500);await page.evaluate(()=>{audioTones=[];});}};
}
test('confirmed completion and per-child all-done are distinct; loading and network waits stay silent',{skip:!base},async()=>{
  const f=await fixture();try{
    assert.deepEqual(await f.tones(),[]);assert.equal(await f.page.evaluate(()=>audioContexts),0);
    f.state.hold=true;await f.page.getByRole('button',{name:'Complete First task 1',exact:true}).click();assert.deepEqual(await f.tones(),[]);
    while(!f.state.release)await new Promise(r=>setTimeout(r,10));f.state.hold=false;f.state.release();
    await f.page.getByRole('button',{name:'Reopen First task 1',exact:true}).waitFor();assert.deepEqual(await f.tones(),[523.25,783.99,1046.5]);
    await f.clear();await f.page.getByRole('button',{name:'Complete First task 2',exact:true}).click();await f.page.getByRole('button',{name:'Reopen First task 2',exact:true}).waitFor();
    assert.deepEqual(await f.tones(),[523.25,659.25,783.99,1046.5,523.25,659.25]);
    assert.equal(await f.page.locator('[data-person-id="b"] .frame-person-count strong').innerText(),'0 / 2');
    await f.clear();await f.page.getByRole('button',{name:'Reopen First task 2',exact:true}).click();await f.page.getByRole('button',{name:'Complete First task 2',exact:true}).waitFor();assert.deepEqual(await f.tones(),[523.25,392]);
    await f.clear();await f.page.getByRole('button',{name:'Complete First task 2',exact:true}).click();await f.page.getByRole('button',{name:'Reopen First task 2',exact:true}).waitFor();assert.deepEqual(await f.tones(),[523.25,783.99,1046.5]);assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
for(const approval of [false,true])test(approval?'approval submission has its own sound':'rejected task write never celebrates',{skip:!base},async()=>{
  const f=await fixture({approval});try{
    f.state.reject=!approval;await f.page.getByRole('button',{name:approval?'Submit for approval: First task 1':'Complete First task 1',exact:true}).click();
    await f.page.waitForFunction(()=>audioTones.length>0);assert.deepEqual(await f.tones(),approval?[440,659.25]:[349.23,293.66]);assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
test('frame sound settings preview, persist mute, and fit the native display',{skip:!base},async()=>{
  const f=await fixture();try{
    await f.page.getByRole('button',{name:'Frame sounds',exact:true}).click();await f.clear();
    await f.page.getByRole('button',{name:'All done!',exact:true}).click();assert.equal((await f.tones()).length,6);
    await f.page.screenshot({path:'/tmp/family-frame-sound-settings.png'});
    assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth),1808);
    await f.clear();await f.page.getByRole('button',{name:'Mute now',exact:true}).click();assert.deepEqual(await f.tones(),[]);
    await f.page.reload();await f.page.getByRole('button',{name:'Frame sounds (muted)',exact:true}).waitFor();await f.page.getByRole('button',{name:'Complete First task 1',exact:true}).click();await f.page.getByRole('button',{name:'Reopen First task 1',exact:true}).waitFor();assert.deepEqual(await f.tones(),[]);assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
test('signed-in phone views stay silent even with the display query parameter',{skip:!base},async()=>{
  const f=await fixture({paired:false});try{
    assert.equal(await f.page.getByRole('button',{name:'Frame sounds',exact:true}).count(),0);await f.page.getByRole('button',{name:'Complete First task 1',exact:true}).click();await f.page.getByRole('button',{name:'Reopen First task 1',exact:true}).waitFor();assert.deepEqual(await f.tones(),[]);assert.equal(await f.page.evaluate(()=>audioContexts),0);
  }finally{await f.browser.close();}
});

test('parent approval celebrates the final required task for that child',{skip:!base},async()=>{
  const f=await fixture({manager:true});try{
    for(const number of [1,2]){
      await f.page.getByRole('button',{name:`Details for First task ${number}`,exact:true}).click();
      await f.page.getByRole('button',{name:'Approve',exact:true}).click();await f.clear();
      await f.page.getByRole('button',{name:'Approve task',exact:true}).click();
      await f.page.getByRole('button',{name:`Reopen First task ${number}`,exact:true}).waitFor();
      assert.equal((await f.tones()).length,number===1?3:6);await f.clear();
    }
    assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
