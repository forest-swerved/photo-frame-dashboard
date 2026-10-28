// Synthetic browser fixtures only; no household account, push, or provider writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base=process.env.FAMILY_UI_TEST_URL;
async function fixture({frame=true,reduced=false,blockedStorage=false}={}) {
  const origin=new URL(base); assert.ok(['localhost','127.0.0.1'].includes(origin.hostname));
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:800},timezoneId:'Asia/Tokyo',reducedMotion:reduced?'reduce':'no-preference'});
  page.setDefaultTimeout(5000); await page.clock.install({time:new Date('2026-10-27T18:00Z')});
  if(blockedStorage) await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage blocked');}}));
  const home={id:'synthetic-home',title:'Synthetic household',timezone:'America/Denver'},user={id:'fixture-user',name:'Synthetic parent'};
  const role=frame?'frame':'admin',state={events:[{id:'fixture-event',calendarId:'fixture-calendar',title:'Soccer practice',allDay:false,startAt:'2026-10-27T18:08Z',endAt:'2026-10-27T19:08Z',location:'North field'}],status:'ready',revoked:false,writes:[],errors:[]};
  page.on('pageerror',error=>state.errors.push(error.message));
  await page.route('**/api/**',async route=>{
    if(new URL(route.request().url()).pathname==='/api/live-status') { await route.fulfill({contentType:'application/json',body:JSON.stringify({data:{}})});return; }
    const request=route.request(),url=new URL(request.url()); let data;
    if(request.method()!=='GET') state.writes.push(url.pathname);
    if(state.revoked && url.pathname==='/api/household') return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:{code:'revoked',message:'Fixture revoked'}})});
    if(url.pathname==='/api/session') data={authenticated:true,authType:frame?'frame':'user',role,household:home,user};
    else if(url.pathname==='/api/auth/get-session') data={session:{expiresAt:'2099-01-01T00:00:00Z'},user};
    else if(url.pathname==='/api/auth/token') data={token:'fixture.transient.token'};
    else if(url.pathname==='/api/household') data={household:home,role,date:'2026-10-27',people:[],chores:[]};
    else if(url.pathname==='/api/calendar') {
      const from=url.searchParams.get('from'),to=url.searchParams.get('to'),coversToday=from<='2026-10-27' && to>'2026-10-27';
      data={status:state.status,events:coversToday?state.events:[],lastSuccessfulSyncAt:'2026-10-27T18:00Z',coverage:{timeZone:home.timezone,startDate:from,endDateExclusive:to,complete:true,truncated:false}};
    }
    else if(url.pathname==='/api/notifications') data={notifications:[]};
    else throw new Error(`Unexpected fixture route ${url.pathname}`);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(url.pathname.startsWith('/api/auth/')?data:{data})});
  });
  await page.goto(new URL('/family.html?display=frame#today',origin).href);
  await page.getByRole('heading',{name:frame?'Today':'Up next',exact:true}).waitFor();
  return {browser,page,state};
}
test('paired frame animates an upcoming event, dismisses it, deduplicates reloads and announces start', {skip:!base},async()=>{
  const f=await fixture(); try {
    const card=f.page.getByRole('complementary',{name:'Event reminder'}); await card.waitFor();
    assert.match(await card.innerText(),/Starts in 8 min.*12:08 PM/s); assert.match(await card.innerText(),/Soccer practice.*North field/s);
    assert.equal(await card.evaluate(el=>getComputedStyle(el).animationName),'frame-event-enter');
    const bounds=await card.boundingBox(); assert.ok(bounds.x>=0 && bounds.x+bounds.width<=1280 && bounds.y+bounds.height<=800);
    if(process.env.FAMILY_UI_SCREENSHOT_DIR) {await mkdir(process.env.FAMILY_UI_SCREENSHOT_DIR,{recursive:true}); await f.page.screenshot({path:`${process.env.FAMILY_UI_SCREENSHOT_DIR}/frame-event-reminder.png`,animations:'disabled'});}
    await f.page.getByRole('button',{name:'Dismiss event reminder'}).click(); await card.waitFor({state:'hidden'});
    await f.page.reload(); await f.page.getByRole('heading',{name:'Today',exact:true}).waitFor(); await f.page.clock.runFor(1100); assert.equal(await card.isVisible(),false);
    await f.page.clock.fastForward(8*60_000); await card.waitFor(); assert.match(await card.innerText(),/Starting now/);
    await f.page.clock.fastForward(21_000); assert.equal(await card.isVisible(),false);
    assert.deepEqual(f.state.writes,[]); assert.deepEqual(f.state.errors,[]);
  } finally {await f.browser.close();}
});
test('phone browser never shows frame animations even with display=frame', {skip:!base},async()=>{
  const f=await fixture({frame:false}); try {await f.page.clock.runFor(1100); assert.equal(await f.page.locator('#frame-event-notice').isVisible(),false); assert.deepEqual(f.state.errors,[]);} finally {await f.browser.close();}
});
test('reduced motion disables animation, blocked storage works, changed or stale events disappear', {skip:!base},async()=>{
  const f=await fixture({reduced:true,blockedStorage:true}); try {
    const card=f.page.locator('#frame-event-notice'); await card.waitFor({state:'visible'});
    assert.equal(await card.evaluate(el=>getComputedStyle(el).animationName),'none');
    f.state.events=[]; await f.page.evaluate(()=>window.dispatchEvent(new Event('online'))); await card.waitFor({state:'hidden'});
    f.state.events=[{id:'other',calendarId:'fixture-calendar',title:'Another event',allDay:false,startAt:'2026-10-27T18:07Z',endAt:'2026-10-27T19:07Z'}];
    f.state.status='stale'; await f.page.evaluate(()=>window.dispatchEvent(new Event('online'))); await f.page.clock.runFor(1100); assert.equal(await card.isVisible(),false); assert.deepEqual(f.state.errors,[]);
  } finally {await f.browser.close();}
});
test('frame reminders stay active while browsing another month and clear on revocation', {skip:!base},async()=>{
  const f=await fixture(); try {
    await f.page.locator('#frame-event-notice').waitFor({state:'visible'}); await f.page.getByRole('button',{name:'Dismiss event reminder'}).click();
    f.state.events=[{id:'new-event',calendarId:'fixture-calendar',title:'Pickup time',allDay:false,startAt:'2026-10-27T18:06Z',endAt:'2026-10-27T19:06Z'}];
    await f.page.getByRole('link',{name:'Calendar',exact:true}).click();
    await f.page.getByRole('button',{name:'Month',exact:true}).click();
    await f.page.getByRole('button',{name:'Next period',exact:true}).click();
    await f.page.getByRole('heading',{name:'Pickup time',exact:true}).waitFor();
    f.state.revoked=true; await f.page.evaluate(()=>window.dispatchEvent(new Event('online'))); await f.page.locator('#frame-event-notice').waitFor({state:'hidden'});
    assert.deepEqual(f.state.errors,[]);
  } finally {await f.browser.close();}
});
