import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.FAMILY_UI_TEST_URL;
async function fixture({ off = false, extra = 0, empty = false, paired = true, manager = false } = {}) {
  const origin = new URL(base); assert.ok(['localhost','127.0.0.1'].includes(origin.hostname));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({headless:true}), page = await browser.newPage({viewport:{width:1280,height:800}});
  page.setDefaultTimeout(8000); await page.clock.install({time:new Date('2026-10-27T18:00:00Z')});
  await page.addInitScript(()=>{
    const original=window.fetch.bind(window);
    window.fetch=(input,options={})=>{
      const url=new URL(input instanceof Request?input.url:input,location.href);
      if(url.origin!==location.origin||!url.pathname.startsWith('/api/')) return original(input,options);
      const headers=new Headers(options.headers||(input instanceof Request?input.headers:undefined));
      headers.set('x-fixture-clock',new Date().toISOString());
      return original(input,{...options,headers});
    };
  });
  const people = [{id:'frame-stevie',name:'Stevie',color:'#8a00c4'},{id:'frame-andre',name:'Andre',color:'#00748c'}];
  const names = ['Get dressed','Eat breakfast','Brush teeth','Backpack ready','Put backpack away','Dirty laundry in bin','Read for 30 minutes','Homework','Load dishes','Unload dishes','Finish today’s work'];
  const tasks = empty ? [] : people.flatMap((p, n) => Array.from({length:(n ? 11 : 9) + (n ? extra : 0)}, (_,i) => ({id:`${p.id}-${i}`,choreId:`routine-${p.id}-${i}`,title:names[i] || `Extra task ${i + 1}`,personId:p.id,personName:p.name,
    date:'2026-10-27',originalDate:'2026-10-27',definitionSource:'routine',schoolDayFilter:'any',taskSection:i<4?'before_school':'after_school',required:true,status:'pending',requiresApproval:false,version:1,subtasks:[],completion:{date:'2026-10-27',completed:false,version:0}})));
  const home={id:'frame-fixture-home',title:'Synthetic family',timezone:'America/Denver'}, state={people,tasks,writes:[],errors:[],conflict:null,internet:{devices:[],sessions:[],credits:[]}};
  page.on('pageerror',e=>state.errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname; let data;
    if(path==='/api/session') data={authenticated:true,authType:paired?'frame':'user',role:paired?(manager?'caregiver':'frame'):'member',household:home,user:{id:'frame-device',name:'Synthetic frame'}};
    else if(path==='/api/auth/get-session') data={session:{expiresAt:'2099-01-01T00:00:00Z'},user:{id:'frame-user',name:'Synthetic user',email:'fixture@example.invalid'}};
    else if(path==='/api/auth/token') data={token:'fixture.transient.token'};
    else if(path==='/api/household') data={household:home,role:paired?(manager?'caregiver':'frame'):'member',date:'2026-10-27',people:state.people,routines:[],chores:[],occurrences:state.tasks.filter(t=>state.people.some(p=>p.id===t.personId)),schoolDay:{type:off?'non_school_day':'school_day',label:off?'No school':'School day'},capabilities:{manageChores:manager,manageInternet:false}};
    else if(path==='/api/calendar') data=state.calendar || {status:'ready',events:[{id:'frame-calendar-event',calendarId:'frame-cal',title:'Family dinner',allDay:false,startAt:'2026-10-27T23:30:00Z',endAt:'2026-10-28T00:30:00Z'}],calendars:[],coverage:{startDate:'2026-10-27',endDateExclusive:'2026-11-04',complete:true,truncated:false},lastSuccessfulSyncAt:'2026-10-27T18:00:00Z'};
    else if(path==='/api/internet') data={serverTime:req.headers()['x-fixture-clock'],timezone:home.timezone,role:'frame',integration:{state:'ready'},policies:[],progress:[],...state.internet};
    else if(path.startsWith('/api/chore-occurrences/')&&path.endsWith('/completion')) {
      const body=req.postDataJSON(),task=state.tasks.find(t=>path.includes(t.id));state.writes.push({id:task.id,body});
      assert.equal(body.expectedVersion,task.version);
      task.version++;
      if(state.conflict===task.id){state.conflict=null;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'version_conflict',message:'Changed on another device',details:{current:task}}})});return;}
      task.status=body.completed?'completed':'pending';task.completion={date:task.date,completed:body.completed,version:task.version};data=task;
    } else if(path==='/api/notifications') data={notifications:[]};
    else throw new Error(`Unexpected synthetic frame route ${path}`);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(path.startsWith('/api/auth/')?data:{data})});
  });
  await page.goto(new URL('/family.html?display=frame#today',origin).href);
  await page.locator(paired?'.frame-person-card':'.chores-panel').first().waitFor();
  return {browser,page,state};
}
test('frame home keeps both children, individual counts, fixed device panels and a calendar at 1280×800', {skip:!base}, async()=>{
  const f=await fixture();try{
    assert.equal(await f.page.locator('.frame-person-card').count(),2);
    const stevie=f.page.locator('[data-person-id="frame-stevie"]'),andre=f.page.locator('[data-person-id="frame-andre"]');
    assert.equal(await stevie.locator('.frame-person-count strong').innerText(),'0 / 9');assert.equal(await andre.locator('.frame-person-count strong').innerText(),'0 / 11');
    assert.equal(await stevie.locator('.chore-row').count(),9);assert.equal(await andre.locator('.chore-row').count(),11);
    assert.equal(await f.page.getByRole('group',{name:'Filter by family profile'}).count(),0);
    assert.equal((await f.page.locator('body').innerText()).includes('0 of 20'),false);
    await f.page.getByRole('button',{name:'Details for Family dinner',exact:true}).waitFor();
    await f.page.screenshot({path:'/tmp/family-frame-home-1280.png'});
    const geometry=await f.page.evaluate(()=>({width:document.documentElement.scrollWidth, main:document.querySelector('.main-content').scrollHeight,bottom:document.querySelector('.frame-home-bottom').getBoundingClientRect().bottom,lists:[...document.querySelectorAll('.frame-person-tasks')].map(e=>({height:e.clientHeight,content:e.scrollHeight,bottom:e.getBoundingClientRect().bottom})),font:getComputedStyle(document.querySelector('.frame-person-card .chore-open strong')).fontSize}));
    assert.equal(geometry.width,1280);assert.equal(geometry.main,800);assert.ok(geometry.bottom<=800,JSON.stringify(geometry));
    assert.equal(await f.page.locator('.frame-device-time').count(),2);assert.equal(geometry.font,'20px');
    assert.ok(geometry.lists.every(l=>l.height>400),JSON.stringify(geometry));
    await f.page.getByRole('button',{name:'Details for Family dinner',exact:true}).waitFor();
    await f.page.screenshot({path:'/tmp/family-frame-home-1280.png'});assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
test('each child completes independently and frame home ignores the Tasks profile filter', {skip:!base},async()=>{
  const f=await fixture();try{
    const stevie=f.page.locator('[data-person-id="frame-stevie"]'),andre=f.page.locator('[data-person-id="frame-andre"]');
    await stevie.getByRole('button',{name:'Complete Get dressed',exact:true}).click();
    await stevie.locator('.frame-person-count strong').getByText('1',{exact:false}).waitFor();
    assert.equal(await andre.locator('.frame-person-count strong').innerText(),'0 / 11');
    f.state.conflict='frame-andre-0';await andre.getByRole('button',{name:'Complete Get dressed',exact:true}).click();
    await andre.getByRole('button',{name:'Retry my change',exact:true}).click();
    await f.page.waitForFunction(()=>document.querySelector('[data-person-id="frame-andre"] .frame-person-count strong').textContent.startsWith('1'));
    assert.equal(f.state.writes[2].body.expectedVersion,2);
    await f.page.getByRole('link',{name:'View all tasks for Andre',exact:true}).click();await f.page.getByRole('heading',{name:'Tasks',level:1,exact:true}).waitFor();
    await f.page.getByRole('link',{name:'Today',exact:true}).click();await f.page.locator('.frame-person-card').first().waitFor();assert.equal(await f.page.locator('.frame-person-card').count(),2);
    assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
test('each child has a pinned device countdown and preparation rolls into full usage once', {skip:!base},async()=>{
  const f=await fixture({extra:12});try{
    const active=(id,personId,source,deviceId,end,prepEnd)=>({id,personId,source,deviceId,state:'active',version:2,desiredState:'allowed',observedState:'allowed',verifiedAt:'2026-10-27T18:00:00Z',remainingSeconds:3900,endsAt:end,preparationRemainingSeconds:prepEnd?300:0,preparationEndsAt:prepEnd});
    f.state.internet.devices=[{id:'ipad',name:'Stevie’s iPad',kind:'tablet'},{id:'ps5',name:'PS5',kind:'console'}];
    f.state.internet.sessions=[active('stevie-time','frame-stevie','reward','ipad','2026-10-27T19:05:00Z','2026-10-27T18:05:00Z'),active('andre-time','frame-andre','parent','ps5','2026-10-27T19:00:00Z',null)];
    await f.page.reload();
    const stevie=f.page.locator('[data-person-id="frame-stevie"] .frame-device-time'),andre=f.page.locator('[data-person-id="frame-andre"] .frame-device-time');
    await stevie.getByText('Stevie’s iPad',{exact:true}).waitFor();await andre.getByText('PS5',{exact:true}).waitFor();
    assert.equal(await stevie.locator('.session-timer').innerText(),'5:00');assert.equal(await andre.locator('.session-timer').innerText(),'60:00');
    const before=await andre.boundingBox();await f.page.locator('[data-person-id="frame-andre"] .frame-person-tasks').evaluate(e=>{e.scrollTop=500;});
    assert.deepEqual(await andre.boundingBox(),before);assert.ok(before.y+before.height<=800);
    await f.page.screenshot({path:'/tmp/family-frame-get-ready.png'});
    for(let elapsed=0;elapsed<300;elapsed++) await f.page.clock.runFor(1000);
    await f.page.waitForFunction(()=>document.querySelector('[data-session-clock="stevie-time"]').dataset.phase==='usage');
    assert.equal(await stevie.locator('.session-timer').innerText(),'60:00');
    assert.equal(await stevie.locator('.session-countdown.just-started').count(),1);
    await f.page.screenshot({path:'/tmp/family-frame-usage-rollover.png'});
    assert.equal(await stevie.locator('.session-timer').innerText(),'60:00');
    await f.page.clock.runFor(5000);assert.equal(await stevie.locator('.session-countdown.just-started').count(),0);
    await f.page.reload();await stevie.getByText('Stevie’s iPad',{exact:true}).waitFor();
    assert.equal(await stevie.locator('.session-countdown.just-started').count(),0,'Reload does not replay the animation.');
    const later=await f.page.evaluate(()=>Date.now());
    Object.assign(f.state.internet.sessions[0],{id:'later-time',preparationRemainingSeconds:5,preparationEndsAt:new Date(later+5000).toISOString(),endsAt:new Date(later+3605_000).toISOString()});
    await f.page.reload();await stevie.locator('[data-phase="preparation"]').waitFor();
    await f.page.getByRole('link',{name:'Calendar',exact:true}).click();await f.page.clock.runFor(11000);
    await f.page.getByRole('link',{name:'Today',exact:true}).click();await stevie.getByText('Stevie’s iPad',{exact:true}).waitFor();
    assert.equal(await stevie.locator('.session-countdown.just-started').count(),0,'Returning later never claims usage starts now.');
    assert.deepEqual(f.state.writes,[]);assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
test('completed tasks stay crossed out at the bottom after reload and reopen into their original section', {skip:!base},async()=>{
  const f=await fixture();try{
    const stevie=f.page.locator('[data-person-id="frame-stevie"]'),andre=f.page.locator('[data-person-id="frame-andre"]');
    const completed=stevie.locator('.task-section').filter({has:f.page.getByRole('heading',{name:'Completed today',exact:true})});
    await stevie.getByRole('button',{name:'Complete Get dressed',exact:true}).click();
    await completed.getByRole('button',{name:'Reopen Get dressed',exact:true}).waitFor();
    await f.page.waitForFunction(()=>!document.querySelector('[data-person-id="frame-stevie"] .is-pending'));
    assert.equal(await stevie.locator('.task-section').last().getByRole('heading').textContent(),'Completed today');
    assert.equal(await stevie.locator('.chore-row').count(),9);
    assert.equal(await completed.locator('.is-done .chore-open strong').evaluate(e=>getComputedStyle(e).textDecorationLine),'line-through');
    assert.equal(await andre.locator('.frame-person-count strong').innerText(),'0 / 11');
    await f.page.reload();await completed.getByRole('button',{name:'Reopen Get dressed',exact:true}).waitFor();
    await f.page.screenshot({path:'/tmp/family-frame-completed-tasks-1280.png'});
    assert.equal(await stevie.locator('.frame-person-count strong').innerText(),'1 / 9');
    await completed.getByRole('button',{name:'Reopen Get dressed',exact:true}).click();
    const before=stevie.locator('.task-section').filter({has:f.page.getByRole('heading',{name:'Before school',exact:true})});
    await before.getByRole('button',{name:'Complete Get dressed',exact:true}).waitFor();
    await f.page.waitForFunction(()=>!document.querySelector('[data-person-id="frame-stevie"] .is-pending'));
    assert.equal(await stevie.locator('.frame-person-count strong').innerText(),'0 / 9');
    assert.equal(await completed.count(),0);assert.equal(await andre.locator('.frame-person-count strong').innerText(),'0 / 11');
    assert.deepEqual(f.state.writes.map(w=>w.body.completed),[true,false]);assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
test('completed day-off lists remain expanded while submitted tasks still wait for approval', {skip:!base},async()=>{
  const f=await fixture({off:true});try{
    f.state.tasks.filter(t=>t.personId==='frame-stevie').forEach(t=>{t.status='completed';t.completion.completed=true;});
    const waiting=f.state.tasks.find(t=>t.personId==='frame-andre');waiting.status='submitted';waiting.requiresApproval=true;
    await f.page.reload();
    const stevie=f.page.locator('[data-person-id="frame-stevie"]'),andre=f.page.locator('[data-person-id="frame-andre"]');
    await stevie.getByRole('heading',{name:'Completed today',exact:true}).waitFor();
    assert.equal(await stevie.getByRole('button',{name:/^Reopen /}).count(),9);
    assert.equal(await stevie.locator('.frame-person-count strong').innerText(),'9 / 9');
    assert.equal(await stevie.getByText('All done today!',{exact:true}).count(),1);
    assert.equal(await stevie.locator('details').count(),0);
    await andre.getByRole('button',{name:'Withdraw submission for Get dressed',exact:true}).waitFor();
    assert.equal(await andre.getByRole('heading',{name:'Completed today',exact:true}).count(),0);
    assert.equal(await andre.locator('.frame-person-count strong').innerText(),'0 / 11');
    assert.deepEqual(f.state.writes,[]);assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
test('long child lists scroll independently and scoped or empty profiles never disappear incorrectly', {skip:!base},async()=>{
  const f=await fixture({extra:12,off:true});try{
    assert.equal(await f.page.getByRole('heading',{name:'Before school',exact:true}).count(),0);
    const lists=f.page.locator('.frame-person-tasks');await lists.nth(1).evaluate(e=>{e.scrollTop=140;});
    const before=await lists.nth(1).evaluate(e=>e.scrollTop);await f.page.clock.runFor(61000);
    assert.equal(await lists.nth(1).evaluate(e=>e.scrollTop),before);assert.equal(await lists.nth(0).evaluate(e=>e.scrollTop),0);
    f.state.people=[f.state.people[0]];await f.page.reload();await f.page.locator('.frame-person-card').first().waitFor();
    assert.equal(await f.page.getByRole('heading',{name:'Andre',exact:true}).count(),0);assert.equal(await f.page.locator('.frame-person-card').count(),1);
    f.state.tasks=[];await f.page.reload();await f.page.getByText('No tasks scheduled for today.',{exact:true}).waitFor();assert.equal(await f.page.getByRole('heading',{name:'Stevie',exact:true}).count(),1);
    assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});

test('calendar background updates stay quiet on frame Home and Calendar while failures remain visible', {skip:!base},async()=>{
  const f=await fixture();try{
    const saved={status:'stale',sync:{state:'scheduled'},events:[{id:'saved-event',calendarId:'frame-cal',title:'Saved appointment',allDay:false,startAt:'2026-10-27T23:00:00Z',endAt:'2026-10-28T00:00:00Z'}],calendars:[],coverage:{startDate:'2026-10-27',endDateExclusive:'2026-10-28',complete:true,truncated:false},lastSuccessfulSyncAt:'2026-10-27T17:59:00Z'};
    for(const state of ['scheduled','syncing']){
      f.state.calendar={...saved,sync:{state}};await f.page.reload();
      await f.page.getByRole('button',{name:'Details for Saved appointment',exact:true}).waitFor();
      assert.equal(await f.page.locator('.frame-home-calendar .status-warning').count(),0);
      assert.equal(await f.page.getByText('Calendar update in progress.',{exact:false}).count(),0);
    }
    await f.page.getByRole('link',{name:'Calendar',exact:true}).click();
    await f.page.locator('.calendar-meta').waitFor();
    assert.equal(await f.page.locator('.calendar-panel .status-warning').count(),0);
    assert.equal(await f.page.getByText('No events on this day.',{exact:true}).count(),0);
    const problems=[{...saved,sync:{state:'retrying'},error:{message:'Could not update the calendar.'}},
      {...saved,coverage:{...saved.coverage,complete:false}},
      {...saved,lastSuccessfulSyncAt:'2026-10-27T17:40:00Z'}];
    for(const calendar of problems){
      f.state.calendar=calendar;await f.page.reload();
      await f.page.locator('.calendar-panel .status-warning').waitFor();
      assert.equal(await f.page.getByRole('button',{name:'Details for Saved appointment',exact:true}).count(),1);
    }
    assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});

test('paired frame returns to Today after sixty idle seconds despite polling and dismisses read-only details', {skip:!base},async()=>{
  const f=await fixture();try{
    await f.page.getByRole('link',{name:'Calendar',exact:true}).click();
    await f.page.clock.runFor(59_000);assert.ok(f.page.url().endsWith('#calendar'));
    await f.page.clock.runFor(1100);await f.page.locator('.frame-person-card').first().waitFor();assert.ok(f.page.url().endsWith('#today'));
    await f.page.getByRole('button',{name:'Details for Family dinner',exact:true}).click();
    await f.page.locator('dialog[open]').waitFor();await f.page.clock.runFor(61_000);
    assert.equal(await f.page.locator('dialog[open]').count(),0);assert.equal(await f.page.locator('.frame-person-card').count(),2);
    assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});

test('frame activity restarts the idle deadline and unfinished parent task forms remain intact', {skip:!base},async()=>{
  const f=await fixture({manager:true});try{
    await f.page.getByRole('link',{name:'Calendar',exact:true}).click();
    await f.page.clock.runFor(59_000);await f.page.keyboard.press('Shift');
    await f.page.clock.runFor(59_000);assert.ok(f.page.url().endsWith('#calendar'));
    await f.page.clock.runFor(1100);await f.page.locator('.frame-person-card').first().waitFor();
    await f.page.getByRole('link',{name:'Tasks',exact:true}).click();await f.page.getByRole('button',{name:'+ Add a task',exact:true}).click();
    await f.page.getByLabel('Task',{exact:true}).fill('Unfinished parent draft');
    await f.page.clock.runFor(91_000);assert.equal(await f.page.getByLabel('Task',{exact:true}).inputValue(),'Unfinished parent draft');
    assert.ok(f.page.url().endsWith('#chores'));assert.deepEqual(f.state.writes,[]);assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});

test('a signed-in web client using the frame display query never auto-returns', {skip:!base},async()=>{
  const f=await fixture({paired:false});try{
    await f.page.getByRole('link',{name:'Calendar',exact:true}).click();await f.page.clock.runFor(91_000);
    assert.ok(f.page.url().endsWith('#calendar'));assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
