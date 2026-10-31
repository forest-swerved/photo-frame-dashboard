// Synthetic layout and navigation contracts; never contacts a family account or controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.FAMILY_UI_TEST_URL;
for (const [role,width,height] of [['frame',1280,800],['admin',390,844],['child',320,740]]) {
  test(`${role} dashboard fits ${width}×${height} with approvals, profiles and a live timer`, { skip:!base }, async () => {
    const origin = new URL(base); assert.ok(['localhost','127.0.0.1'].includes(origin.hostname));
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const browser = await chromium.launch({headless:true});
    try {
      const page = await browser.newPage({viewport:{width,height}}); page.setDefaultTimeout(8000);
      await page.clock.install({time:new Date('2026-10-26T18:00:00Z')});
      const home={id:'layout-home',title:'Synthetic family',timezone:'America/Denver'};
      const people=['Alex','Jamie','Sam','Morgan'].map((name,i)=>({id:`layout-person-${i}`,name,color:'#00536e'}));
      const occurrences=people.flatMap((person,i)=>['completed','completed','pending','pending','submitted'].map((status,j)=>({
        id:`layout-task-${i}-${j}`,choreId:`layout-routine-${i}-${j}`,title:j===2?'Finish homework and reading log':j===3?'Optional extra task':'Synthetic daily task',
        personId:person.id,personName:person.name,date:'2026-10-26',originalDate:'2026-10-26',definitionSource:'routine',schoolDayFilter:'any',
        taskSection:'tasks',required:j!==3,status,requiresApproval:true,version:1,subtasks:[],completion:{date:'2026-10-26',completed:status==='completed',version:0},
      }))).filter(item=>role!=='child'||item.personId===people[0].id);
      const session={id:'layout-session',personId:people[0].id,deviceId:'layout-device',source:'parent',state:'active',version:1,desiredState:'allowed',observedState:'allowed',startedAt:'2026-10-26T18:00:00Z',endsAt:'2026-10-26T18:35:00Z',remainingSeconds:2100};
      const errors=[],writes=[]; page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/api/**',async route=>{
    if(new URL(route.request().url()).pathname==='/api/live-status') { await route.fulfill({contentType:'application/json',body:JSON.stringify({data:{}})});return; }
        const request=route.request(),path=new URL(request.url()).pathname;
        if(request.method()!=='GET') writes.push(path);
        let data;
        if(path==='/api/session') data={authenticated:true,authType:role==='frame'?'frame':'user',role,personId:role==='child'?people[0].id:null,household:home,user:{id:'layout-user',name:'Synthetic account'}};
        else if(path==='/api/auth/get-session') data={session:{expiresAt:'2099-01-01T00:00:00Z'}};
        else if(path==='/api/auth/token') data={token:'synthetic.transient.token'};
        else if(path==='/api/household') data={household:home,role,date:'2026-10-26',people:role==='child'?[people[0]]:people,chores:[],routines:[],occurrences,schoolDay:{date:'2026-10-26',type:'school_day',label:'School day'},capabilities:{manageChores:role==='admin',manageInternet:role==='admin'}};
        else if(path==='/api/calendar') data={status:'ready',events:[],calendars:[],coverage:{startDate:'2026-10-26',endDateExclusive:'2026-11-02',complete:true,truncated:false},lastSuccessfulSyncAt:'2026-10-26T18:00:00Z'};
        else if(path==='/api/internet') data={serverTime:'2026-10-26T18:00:00Z',timezone:home.timezone,role,capabilities:{manageInternet:role==='admin'},integration:{state:'ready'},devices:[{id:'layout-device',name:'Synthetic iPad',personIds:[people[0].id],defaultAccess:'blocked',controlState:'ready',version:1,observedAccess:'allowed',desiredAccess:'allowed'}],sessions:[session],credits:[],policies:[],progress:[]};
        else if (path === '/api/media') data = { media: [] };
    else if(path==='/api/notifications') data={notifications:[]};
        else if(path==='/api/calendar/connection') data={connected:false,calendars:[]};
        else if(path==='/api/devices') data={devices:[]};
        else if(path==='/api/members') data={members:[]};
        else throw new Error(`Unexpected synthetic route ${path}`);
        await route.fulfill({contentType:'application/json',body:JSON.stringify(path.startsWith('/api/auth/')?data:{data})});
      });
      await page.goto(new URL(`/family.html${role==='frame'?'?display=frame':''}#today`,origin).href);
      await page.locator(role==='frame'?'.frame-device-time':'.home-internet-strip').first().waitFor();
      const layout=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,mainHeight:document.querySelector('.main-content').scrollHeight,headerHeight:document.querySelector('.sidebar').getBoundingClientRect().height,
        stripBottom:document.querySelector('.frame-device-time,.home-internet-strip').getBoundingClientRect().bottom,
        primary:getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
        list:document.querySelector('.frame-person-tasks,.home-task-list').getBoundingClientRect().top}));
      assert.equal(layout.document,width,JSON.stringify(layout)); assert.equal(layout.primary,'#b026ff');
      assert.equal(await page.locator('nav .nav-item').count(),role==='frame'?4:5);
      if(role==='frame') {
        assert.equal(layout.mainHeight+layout.headerHeight,height,JSON.stringify(layout)); assert.ok(layout.stripBottom<=height,JSON.stringify(layout));
        assert.equal(await page.getByRole('button',{name:'Unlock to review',exact:true}).count(),1);
        assert.equal(await page.getByLabel('Filter by family profile').count(),0);
        assert.equal(await page.locator('.frame-person-card').count(),4);
        assert.equal(await page.locator('.frame-person-tasks').getByText('Optional extra task',{exact:true}).count(),4,'Every child keeps their own complete task list.');
      } else { assert.ok(layout.list<height,JSON.stringify(layout)); }
      if(process.env.FAMILY_UI_SCREENSHOT_DIR) {
        await mkdir(process.env.FAMILY_UI_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:`${process.env.FAMILY_UI_SCREENSHOT_DIR}/implemented-${role}-${width}.png`});
      }
      await page.getByRole('link',{name:role==='child'?'My tasks':'Tasks',exact:true}).click();
      await page.getByRole('heading',{name:role==='child'?'My tasks':'Tasks',level:1,exact:true}).waitFor();
      const firstTask=await page.locator('.focused-tasks .chore-row').first().boundingBox();
      if(role!=='frame') assert.ok(firstTask.y<height,'Task controls should leave the first task visible.');
      if(role==='admin') {
        await page.getByRole('button',{name:'Routines',exact:true}).click();
        await page.getByLabel('Find a routine',{exact:true}).pressSequentially('No match');
        assert.equal(await page.getByLabel('Find a routine',{exact:true}).inputValue(),'No match');
      }
      assert.deepEqual(writes,[]); assert.deepEqual(errors,[]);
    } finally {await browser.close();}
  });
}
