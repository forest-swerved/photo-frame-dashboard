import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.FAMILY_UI_TEST_URL;
async function fixture({ off = false, extra = 0, empty = false } = {}) {
  const origin = new URL(base); assert.ok(['localhost','127.0.0.1'].includes(origin.hostname));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({headless:true}), page = await browser.newPage({viewport:{width:1280,height:800}});
  page.setDefaultTimeout(8000); await page.clock.install({time:new Date('2026-10-27T18:00:00Z')});
  const people = [{id:'frame-stevie',name:'Stevie',color:'#8a00c4'},{id:'frame-andre',name:'Andre',color:'#00748c'}];
  const names = ['Get dressed','Eat breakfast','Brush teeth','Backpack ready','Put backpack away','Dirty laundry in bin','Read for 30 minutes','Homework','Load dishes','Unload dishes','Finish today’s work'];
  const tasks = empty ? [] : people.flatMap((p, n) => Array.from({length:(n ? 11 : 9) + (n ? extra : 0)}, (_,i) => ({id:`${p.id}-${i}`,choreId:`routine-${p.id}-${i}`,title:names[i] || `Extra task ${i + 1}`,personId:p.id,personName:p.name,
    date:'2026-10-27',originalDate:'2026-10-27',definitionSource:'routine',schoolDayFilter:'any',taskSection:i<4?'before_school':'after_school',required:true,status:'pending',requiresApproval:false,version:1,subtasks:[],completion:{date:'2026-10-27',completed:false,version:0}})));
  const home={id:'frame-fixture-home',title:'Synthetic family',timezone:'America/Denver'}, state={people,tasks,writes:[],errors:[],conflict:null};
  page.on('pageerror',e=>state.errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname; let data;
    if(path==='/api/session') data={authenticated:true,authType:'frame',role:'frame',household:home,user:{id:'frame-device',name:'Synthetic frame'}};
    else if(path==='/api/household') data={household:home,role:'frame',date:'2026-10-27',people:state.people,routines:[],chores:[],occurrences:state.tasks.filter(t=>state.people.some(p=>p.id===t.personId)),schoolDay:{type:off?'non_school_day':'school_day',label:off?'No school':'School day'},capabilities:{manageChores:false,manageInternet:false}};
    else if(path==='/api/calendar') data={status:'ready',events:[{id:'frame-calendar-event',calendarId:'frame-cal',title:'Family dinner',allDay:false,startAt:'2026-10-27T23:30:00Z',endAt:'2026-10-28T00:30:00Z'}],calendars:[],coverage:{startDate:'2026-10-27',endDateExclusive:'2026-11-04',complete:true,truncated:false},lastSuccessfulSyncAt:'2026-10-27T18:00:00Z'};
    else if(path==='/api/internet') data={serverTime:'2026-10-27T18:00:00Z',timezone:home.timezone,role:'frame',integration:{state:'ready'},devices:[],sessions:[],credits:[],policies:[],progress:[]};
    else if(path.startsWith('/api/chore-occurrences/')&&path.endsWith('/completion')) {
      const body=req.postDataJSON(),task=state.tasks.find(t=>path.includes(t.id));state.writes.push({id:task.id,body});
      assert.equal(body.expectedVersion,task.version);
      task.version++;
      if(state.conflict===task.id){state.conflict=null;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'version_conflict',message:'Changed on another device',details:{current:task}}})});return;}
      task.status=body.completed?'completed':'pending';task.completion={date:task.date,completed:body.completed,version:task.version};data=task;
    } else if(path==='/api/notifications') data={notifications:[]};
    else throw new Error(`Unexpected synthetic frame route ${path}`);
    await route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
  });
  await page.goto(new URL('/family.html?display=frame#today',origin).href);
  await page.locator('.frame-person-card').first().waitFor();
  return {browser,page,state};
}
test('frame home fits both children and all 11/9 tasks with individual counts and a calendar at 1280×800', {skip:!base}, async()=>{
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
    assert.ok(geometry.lists.every(l=>l.content<=l.height+1),JSON.stringify(geometry));assert.equal(geometry.font,'20px');
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
