import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.FAMILY_UI_TEST_URL;
async function fixture({ off = false, extra = 0, empty = false, paired = true, manager = false, viewport = { width:1280, height:800 } } = {}) {
  const origin = new URL(base); assert.ok(['localhost','127.0.0.1'].includes(origin.hostname));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({headless:true}), page = await browser.newPage({viewport});
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
  const home={id:'frame-fixture-home',title:'Synthetic family',timezone:'America/Denver'}, state={people,tasks,writes:[],errors:[],reads:[],conflict:null,internet:{devices:[],sessions:[],credits:[]}};
  page.on('pageerror',e=>state.errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;state.reads.push(path);
    if(path==='/api/household'&&state.holdHousehold) await new Promise(resolve=>{state.releaseHousehold=resolve;});
    let data;
    if(path==='/api/session') data={authenticated:true,authType:paired?'frame':'user',role:paired?(manager?'caregiver':'frame'):'member',household:home,user:{id:'frame-device',name:'Synthetic frame'}};
    else if(path==='/api/auth/get-session') data={session:{expiresAt:'2099-01-01T00:00:00Z'},user:{id:'frame-user',name:'Synthetic user',email:'fixture@example.invalid'}};
    else if(path==='/api/auth/token') data={token:'fixture.transient.token'};
    else if(path==='/api/household') data={household:home,role:paired?(manager?'caregiver':'frame'):'member',date:'2026-10-27',people:state.people,routines:[],chores:[],occurrences:state.tasks.filter(t=>state.people.some(p=>p.id===t.personId)),schoolDay:{type:off?'non_school_day':'school_day',label:off?'No school':'School day'},capabilities:{manageChores:manager,manageInternet:false}};
    else if(path==='/api/calendar') data=state.calendar || {status:'ready',events:[{id:'frame-calendar-event',calendarId:'frame-cal',title:'Family dinner',allDay:false,startAt:'2026-10-27T23:30:00Z',endAt:'2026-10-28T00:30:00Z'}],calendars:[],coverage:{startDate:'2026-10-27',endDateExclusive:'2026-11-04',complete:true,truncated:false},lastSuccessfulSyncAt:'2026-10-27T18:00:00Z'};
    else if(path==='/api/live-status') data=state.revisions||{};
    else if(path==='/api/internet') data={serverTime:req.headers()['x-fixture-clock'],timezone:home.timezone,role:'frame',integration:{state:'ready'},policies:[],progress:[],...state.internet};
    else if(path.startsWith('/api/chore-occurrences/')&&path.endsWith('/completion')) {
      const body=req.postDataJSON(),task=state.tasks.find(t=>path.includes(t.id));state.writes.push({id:task.id,body});
      assert.equal(body.expectedVersion,task.version);
      task.version++;
      if(state.conflict===task.id){state.conflict=null;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'version_conflict',message:'Changed on another device',details:{current:task}}})});return;}
      task.status=body.completed?'completed':'pending';task.completion={date:task.date,completed:body.completed,version:task.version};data=task;
    } else if (path === '/api/media') data = { media: [] };
    else if(path==='/api/notifications') data={notifications:[]};
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
    const geometry=await f.page.evaluate(()=>({width:document.documentElement.scrollWidth, main:document.querySelector('.main-content').scrollHeight,header:document.querySelector('.sidebar').getBoundingClientRect().height,bottom:document.querySelector('.frame-home-bottom').getBoundingClientRect().bottom,lists:[...document.querySelectorAll('.frame-person-tasks')].map(e=>({height:e.clientHeight,content:e.scrollHeight,bottom:e.getBoundingClientRect().bottom})),font:getComputedStyle(document.querySelector('.frame-person-card .chore-open strong')).fontSize}));
    assert.equal(geometry.width,1280);assert.equal(geometry.main+geometry.header,800);assert.ok(geometry.bottom<=800,JSON.stringify(geometry));
    assert.equal(await f.page.locator('.frame-device-time').count(),2);assert.equal(geometry.font,'22px');
    assert.ok(geometry.lists.every(l=>l.height>350),JSON.stringify(geometry));
    await f.page.getByRole('button',{name:'Details for Family dinner',exact:true}).waitFor();
    await f.page.screenshot({path:'/tmp/family-frame-home-1280.png'});assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
for (const mode of ['pointer','keyboard','details']) test(`a completion arriving during a held Complete press cannot turn that press into Reopen (${mode})`, {skip:!base},async()=>{
  const f=await fixture();try{
    await f.page.clock.runFor(2000);
    if(mode==='details') await f.page.getByRole('button',{name:'Details for Get dressed',exact:true}).first().click();
    const target=mode==='details'?f.page.getByRole('button',{name:'Mark task done',exact:true}):f.page.getByRole('button',{name:'Complete Get dressed',exact:true}).first();
    if(mode==='keyboard') {await target.focus();await f.page.keyboard.down('Space');}
    else {const bounds=await target.boundingBox();await f.page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await f.page.mouse.down();}
    const task=f.state.tasks[0];task.status='completed';task.version++;task.completion={date:task.date,completed:true,version:1};
    f.state.revisions={household:'changed-while-pressed'};
    const read=f.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/household');
    await f.page.clock.runFor(2000);await read;await f.page.clock.runFor(50);
    if(mode==='details') assert.equal(await target.innerText(),'Mark task done');
    else assert.equal(await target.getAttribute('aria-pressed'),'false','The visible button stays Complete until activation.');
    if(mode==='keyboard') await f.page.keyboard.up('Space');else await f.page.mouse.up();
    await f.page.clock.runFor(150);
    await f.page.getByRole('button',{name:mode==='details'?'Reopen task':'Reopen Get dressed',exact:true}).waitFor();
    assert.deepEqual(f.state.writes,[],'A stale Complete press must not submit an undo or borrow the newest version.');
    assert.equal(task.status,'completed');assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});

test('a second finger keeps task rows steady when the first finger lifts', {skip:!base},async()=>{
  const f=await fixture();try{
    await f.page.clock.runFor(2000);
    const targets=f.page.getByRole('button',{name:'Complete Get dressed',exact:true});
    await targets.nth(0).dispatchEvent('pointerdown',{pointerId:11,pointerType:'touch'});
    await targets.nth(1).dispatchEvent('pointerdown',{pointerId:12,pointerType:'touch'});
    await targets.nth(0).dispatchEvent('pointerup',{pointerId:11,pointerType:'touch'});
    const task=f.state.tasks.find(t=>t.personId==='frame-andre');task.status='completed';task.version++;task.completion={date:task.date,completed:true,version:1};
    f.state.revisions={household:'changed-with-second-finger-down'};
    const read=f.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/household');
    await f.page.clock.runFor(2000);await read;await f.page.clock.runFor(150);
    assert.equal(await targets.count(),2,'A household refresh must wait until every finger has lifted.');
    await targets.nth(1).dispatchEvent('pointercancel',{pointerId:12,pointerType:'touch'});
    await f.page.clock.runFor(150);await f.page.getByRole('button',{name:'Reopen Get dressed',exact:true}).waitFor();
    assert.deepEqual(f.state.writes,[]);assert.deepEqual(f.state.errors,[]);
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
test('remote Internet confirmation and errors reach the frame within two seconds at the same device version', {skip:!base},async()=>{
  const f=await fixture();try{
    const device={id:'live-ipad',name:'Stevie’s iPad',kind:'tablet',personIds:['frame-stevie'],version:3,controlState:'ready',defaultAccess:'blocked',desiredAccess:'allowed',observedAccess:'unknown',accessPending:true};
    f.state.internet.devices=[device];f.state.revisions={household:'h1',internet:'i1',calendar:'c1'};
    await f.page.getByRole('link',{name:'Devices',exact:true}).click();
    await f.page.getByText('Changing Internet access · waiting for confirmation',{exact:true}).waitFor();
    await f.page.clock.runFor(2000);
    Object.assign(device,{observedAccess:'allowed',accessPending:false,accessVerifiedAt:'2026-10-27T18:00:08Z'});f.state.revisions.internet='i2';
    await f.page.clock.runFor(2000);await f.page.getByText('Internet on · allowed by parent',{exact:true}).waitFor();
    assert.equal(device.version,3);
    Object.assign(device,{observedAccess:'unknown',accessPending:true,accessError:'policy_review_required'});f.state.revisions.internet='i3';
    await f.page.clock.runFor(2000);await f.page.getByText('Network rules need parent review · access not confirmed',{exact:true}).waitFor();
    assert.equal(await f.page.getByText('Changing Internet access · waiting for confirmation',{exact:true}).count(),0);
    assert.deepEqual(f.state.writes,[]);assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});
test('a slow household request cannot delay remote device confirmation', {skip:!base},async()=>{
  const f=await fixture();try{
    const device={id:'slow-ipad',name:'Stevie’s iPad',kind:'tablet',personIds:['frame-stevie'],version:3,controlState:'ready',desiredAccess:'allowed',observedAccess:'unknown',accessPending:true};
    f.state.internet.devices=[device];await f.page.getByRole('link',{name:'Devices',exact:true}).click();
    await f.page.getByText('Changing Internet access · waiting for confirmation',{exact:true}).waitFor();
    f.state.holdHousehold=true;f.state.revisions={household:'h1',internet:'i1',calendar:'c1'};
    await f.page.clock.runFor(2000);
    Object.assign(device,{observedAccess:'allowed',accessPending:false});f.state.revisions.internet='i2';
    await f.page.clock.runFor(2000);await f.page.getByText('Internet on · allowed by parent',{exact:true}).waitFor();
    assert.ok(f.state.releaseHousehold,'The unrelated household read is still in flight.');
    f.state.holdHousehold=false;f.state.releaseHousehold();
    assert.deepEqual(f.state.errors,[]);
  }finally{f.state.releaseHousehold?.();await f.browser.close();}
});
test('remote task reads continue behind an open parent draft and appear when it closes', {skip:!base},async()=>{
  const f=await fixture({manager:true});try{
    f.state.revisions={household:'h1',internet:'i1',calendar:'c1'};await f.page.clock.runFor(2000);
    await f.page.getByRole('link',{name:'Tasks',exact:true}).click();await f.page.getByRole('button',{name:'+ Add a task',exact:true}).click();
    await f.page.getByLabel('Task',{exact:true}).fill('Keep this parent draft');
    Object.assign(f.state.tasks[0],{status:'completed',version:2});f.state.revisions.household='h2';
    await f.page.clock.runFor(2000);assert.equal(await f.page.getByLabel('Task',{exact:true}).inputValue(),'Keep this parent draft');
    await f.page.getByRole('button',{name:'Close dialog',exact:true}).click();await f.page.getByRole('button',{name:'Discard changes',exact:true}).click();
    await f.page.getByRole('link',{name:'Today',exact:true}).click();
    await f.page.waitForFunction(()=>document.querySelector('[data-person-id="frame-stevie"] .frame-person-count strong')?.textContent==='1 / 9');
    assert.deepEqual(f.state.writes,[]);assert.deepEqual(f.state.errors,[]);
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

test('paired frame returns to Today after 45 idle seconds despite polling and dismisses read-only details', {skip:!base},async()=>{
  const f=await fixture();try{
    await f.page.getByRole('link',{name:'Calendar',exact:true}).click();
    await f.page.clock.runFor(44_000);assert.ok(f.page.url().endsWith('#calendar'));
    await f.page.clock.runFor(1100);await f.page.locator('.frame-person-card').first().waitFor();assert.ok(f.page.url().endsWith('#today'));
    await f.page.locator('#frame-ambient').click(); await f.page.clock.runFor(700);
    await f.page.getByRole('button',{name:'Details for Family dinner',exact:true}).click();
    await f.page.locator('dialog[open]').waitFor();await f.page.clock.runFor(46_000);
    assert.equal(await f.page.locator('dialog[open]').count(),0);assert.equal(await f.page.locator('.frame-person-card').count(),2);
    assert.deepEqual(f.state.errors,[]);
  }finally{await f.browser.close();}
});

test('frame activity restarts the idle deadline and unfinished parent task forms remain intact', {skip:!base},async()=>{
  const f=await fixture({manager:true});try{
    await f.page.getByRole('link',{name:'Calendar',exact:true}).click();
    await f.page.clock.runFor(44_000);await f.page.keyboard.press('Shift');
    await f.page.clock.runFor(44_000);assert.ok(f.page.url().endsWith('#calendar'));
    await f.page.clock.runFor(1100);await f.page.locator('.frame-person-card').first().waitFor();
    await f.page.locator('#frame-ambient').click(); await f.page.clock.runFor(700);
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

for (const viewport of [{width:1807,height:1016},{width:1920,height:1080}]) {
  test(`large frame uses its extra space across all views at ${viewport.width}×${viewport.height}`, {skip:!base}, async()=>{
    const f=await fixture({viewport});try{
      const geometry=await f.page.evaluate(()=>({width:document.documentElement.scrollWidth,main:document.querySelector('.main-content').scrollHeight,nav:document.querySelector('.sidebar').getBoundingClientRect().height,
        bottom:document.querySelector('.frame-home-bottom').getBoundingClientRect().bottom,
        board:document.querySelector('.frame-task-board').getBoundingClientRect().right,agenda:document.querySelector('.frame-home-overview').getBoundingClientRect().left,
        lists:[...document.querySelectorAll('.frame-person-tasks')].map(e=>({height:e.clientHeight,bottom:e.getBoundingClientRect().bottom})),font:getComputedStyle(document.querySelector('.frame-person-card .chore-open strong')).fontSize}));
      assert.equal(geometry.width,viewport.width);assert.equal(geometry.main+geometry.nav,viewport.height,JSON.stringify(geometry));
      assert.ok(geometry.bottom<=viewport.height);assert.ok(geometry.agenda>geometry.board);assert.equal(geometry.font,'24px');
      assert.ok(geometry.lists.every(l=>l.height>500&&l.bottom<viewport.height),JSON.stringify(geometry));
      assert.equal(await f.page.locator('.frame-person-card').count(),2);assert.equal(await f.page.locator('.frame-device-time').count(),2);
      await f.page.getByRole('heading',{name:'Coming up',exact:true}).waitFor();
      await f.page.getByRole('button',{name:'Details for Family dinner',exact:true}).click();await f.page.getByRole('dialog').waitFor();await f.page.keyboard.press('Escape');
      await f.page.screenshot({path:`/tmp/frame156-today-${viewport.width}.png`});
      await f.page.getByRole('link',{name:'Tasks',exact:true}).click();await f.page.locator('.focused-tasks > .task-section').first().waitFor();
      const sections=await f.page.locator('.focused-tasks > .task-section').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y})));
      assert.ok(sections.length>=2);assert.ok(sections[1].x>sections[0].x);assert.equal(sections[1].y,sections[0].y);
      await f.page.getByRole('link',{name:'Calendar',exact:true}).click();await f.page.getByRole('button',{name:'Week',exact:true}).click();
      assert.equal(await f.page.locator('.week-agenda').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),7);
      await f.page.getByRole('button',{name:'Month',exact:true}).click();
      const month=await f.page.locator('.calendar-month').evaluate(e=>({grid:e.querySelector('.month-grid').getBoundingClientRect().right,agenda:e.querySelector('.selected-day-agenda').getBoundingClientRect().left}));
      assert.ok(month.agenda>month.grid);await f.page.screenshot({path:`/tmp/frame156-calendar-${viewport.width}.png`});
      await f.page.getByRole('link',{name:'Devices',exact:true}).click();await f.page.getByRole('heading',{name:'Devices',level:1,exact:true}).waitFor();
      await f.page.getByRole('link',{name:'Settings',exact:true}).click();await f.page.getByRole('heading',{name:'Your frame is paired.',exact:true}).waitFor();
      assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth),viewport.width);assert.deepEqual(f.state.errors,[]);assert.deepEqual(f.state.writes,[]);
      await f.page.setViewportSize({width:1280,height:800});await f.page.getByRole('link',{name:'Today',exact:true}).click();await f.page.locator('.frame-home-calendar').waitFor();
      assert.equal(await f.page.locator('.frame-home-overview').isVisible(),false);assert.equal(await f.page.locator('.frame-home-calendar').isVisible(),true);
    }finally{await f.browser.close();}
  });
}

test('large-frame agenda shows distinct upcoming events, retains sync warnings and keeps all views within the display', {skip:!base}, async()=>{
  const f=await fixture({viewport:{width:1807,height:1016}});try{
    f.state.calendar={status:'stale',error:{message:'Calendar update delayed'},events:[
      {id:'past',calendarId:'cal',title:'Earlier appointment',startAt:'2026-10-27T14:00:00Z',endAt:'2026-10-27T15:00:00Z'},
      {id:'trip',calendarId:'cal',title:'School spirit week',allDay:true,startDate:'2026-10-27',endDateExclusive:'2026-10-30'},
      {id:'dinner',calendarId:'cal',title:'Family dinner',startAt:'2026-10-27T23:30:00Z',endAt:'2026-10-28T00:30:00Z',location:'At home'},
      {id:'practice',calendarId:'cal',title:'Soccer practice',startAt:'2026-10-28T22:00:00Z',endAt:'2026-10-28T23:00:00Z',location:'Community park'},
      {id:'library',calendarId:'cal',title:'Library afternoon',startAt:'2026-10-29T22:00:00Z',endAt:'2026-10-29T23:00:00Z'},
      {id:'later',calendarId:'cal',title:'Weekend picnic',startAt:'2026-10-31T18:00:00Z',endAt:'2026-10-31T19:00:00Z'}
    ],calendars:[],coverage:{startDate:'2026-10-27',endDateExclusive:'2026-11-04',complete:true,truncated:false},lastSuccessfulSyncAt:'2026-10-27T17:00:00Z'};
    await f.page.reload();await f.page.getByRole('heading',{name:'Coming up',exact:true}).waitFor();
    const rail=f.page.locator('.frame-home-overview');
    assert.deepEqual(await rail.locator('.event-card h3').allTextContents(),['School spirit week','Family dinner','Soccer practice','Library afternoon']);
    assert.equal(await rail.locator('.status-warning').isVisible(),true);
    assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth),1807);
    await f.page.screenshot({path:'/tmp/frame156-agenda-1807.png'});
    assert.deepEqual(f.state.errors,[]);assert.deepEqual(f.state.writes,[]);
  }finally{await f.browser.close();}
});
