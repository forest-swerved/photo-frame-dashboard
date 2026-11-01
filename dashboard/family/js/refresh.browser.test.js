// Optional local-only regressions. Every API call is a synthetic fixture;
// no family data, account, provider, or network controller is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from './model.js';

const baseUrl = process.env.FAMILY_UI_TEST_URL;
const date = '2026-10-17';
const clock = '2026-10-17T18:00:00Z';

async function fixture({ frame = true, width = 1280, height = 800 } = {}) {
  const origin = new URL(baseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname), 'Fixtures are restricted to localhost.');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height }, timezoneId: 'America/Denver' });
  await page.clock.install({ time: new Date(clock) });
  const household = { id: 'fixture-household', title: 'UI fixture household', timezone: 'America/Denver' };
  const user = { id: 'fixture-user', name: 'UI fixture parent', email: 'fixture@example.invalid' };
  const people = [{ id: 'fixture-person-a', name: 'Fixture child A', color: '#00748c' }, { id: 'fixture-person-b', name: 'Fixture child B', color: '#a91675' }];
  const chores = Array.from({ length: 28 }, (_, index) => ({ id: `fixture-chore-${index}`, title: `Fixture chore ${index}`, personId: people[index % 2].id, weekdays: [0, 1, 2, 3, 4, 5, 6], dueTime: '17:00', reminderMinutes: 15, version: 1, completion: { date, completed: false, version: 0 } }));
  const calendars = [{ id: 'fixture-calendar-a', name: 'Fixture calendar A', color: '#00748c' }, { id: 'fixture-calendar-b', name: 'Fixture calendar B', color: '#a91675' }];
  const state = { household, people, chores, requests: [], changed: false, rejectHousehold: false, failNextCompletion: false, calendarStatus: 'ready', syncState: 'idle', writes: [], errors: [], external: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== origin.origin) state.external.push(request.url()); });
  await page.route('**/api/**', async route => {
    if(new URL(route.request().url()).pathname==='/api/live-status') { await route.fulfill({contentType:'application/json',body:JSON.stringify({data:{}})});return; }
    const url = new URL(route.request().url());
    state.requests.push(url.pathname);
    let data;
    const role = frame ? 'frame' : 'admin';
    if (url.pathname === '/api/session') data = { authenticated: true, authType: frame ? 'frame' : 'user', role, household, user };
    else if (url.pathname === '/api/auth/get-session') data = { session: { expiresAt: '2099-01-01T00:00:00Z' }, user };
    else if (url.pathname === '/api/auth/token') data = { token: 'fixture.transient.token' };
    else if (url.pathname === '/api/household') {
      if (state.rejectHousehold) {
        state.rejectHousehold = false;
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'fixture_revoked', message: 'Fixture session revoked.' } }) });
        return;
      }
      data = { household, role, date, people, chores };
    } else if (url.pathname === '/api/calendar' || url.pathname === '/api/calendar/sync') {
      const from = url.searchParams.get('from') || date;
      const events = Array.from({ length: 70 }, (_, index) => ({ id: `fixture-event-${index}`, calendarId: calendars[index % 2].id, title: `${state.changed && index === 0 ? 'Updated' : 'Fixture'} event ${index}`, allDay: false, startAt: `${addDays(from, index % 7)}T18:00:00Z`, endAt: `${addDays(from, index % 7)}T19:00:00Z` }));
      data = { status: state.calendarStatus, events, calendars, sync: { state: state.syncState }, coverage: { startDate: from, endDateExclusive: url.searchParams.get('to') || addDays(date, 7), complete: true, truncated: false }, lastSuccessfulSyncAt: clock };
    } else if (url.pathname === '/api/calendar/connection') data = { connected: true, calendars: calendars.map(calendar => ({ ...calendar, selected: true })) };
    else if (url.pathname === '/api/devices') data = { devices: [] };
    else if (url.pathname === '/api/members') data = { members: [] };
    else if (url.pathname.includes('/completions/')) {
      const body = route.request().postDataJSON();
      state.writes.push(body);
      if (state.failNextCompletion) { state.failNextCompletion = false; await route.abort('failed'); return; }
      if (state.holdNextCompletion) {
        state.holdNextCompletion = false;
        await new Promise(resolve => { state.releaseCompletion = resolve; });
      }
      const chore = chores.find(item => url.pathname.includes(`/${item.id}/`));
      chore.completion = { date, completed: body.completed, version: body.expectedVersion + 1 };
      data = { choreId: chore.id, ...chore.completion, mutationId: body.mutationId };
    } else if (url.pathname === '/api/locations') data = { parents: [] };
    else if (url.pathname === '/api/media') data = { media: [] };
    else if (url.pathname === '/api/notifications') data = { notifications: [] };
    else throw new Error(`Unexpected fixture path ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.pathname.startsWith('/api/auth/') ? data : { data }) });
  });
  return { browser, page, state, origin, async open(view = 'today') {
    await page.goto(new URL(`/family.html${frame ? '?display=frame' : ''}#${view}`, origin).href);
    await page.getByRole('heading', { name: view === 'setup' ? 'Settings' : view === 'chores' ? 'Tasks' : view[0].toUpperCase() + view.slice(1), exact: true, level: 1 }).waitFor();
    if (view === 'today' || view === 'calendar') await page.locator(frame && view === 'today' ? '.frame-next-event' : '.calendar-meta').waitFor();
  } };
}

test('frame polling preserves the keyed shell, scroll, focus, chosen week, and safe calendar colors', { skip: !baseUrl }, async () => {
  const f = await fixture();
  try {
    await f.open('calendar');
    await f.page.getByRole('button', { name: 'Week', exact: true }).click();
    await f.page.getByRole('button', { name: 'Next period', exact: true }).click();
    await f.page.getByText('Oct 19 – Oct 25', { exact: true }).waitFor();
    await f.page.locator('.calendar-meta').waitFor();
    const geometry = await f.page.locator('.week-agenda').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth, days: element.children.length }));
    assert.equal(geometry.days, 7);
    assert.ok(geometry.content <= geometry.width, JSON.stringify(geometry));
    assert.equal(await f.page.getByLabel('Calendar colors').getByText('Fixture calendar B').count(), 1);
    const colors = await f.page.locator('.event-card').evaluateAll(elements => [...new Set(elements.map(element => getComputedStyle(element.querySelector('div')).borderLeftColor))]);
    assert.deepEqual(colors.sort(), ['rgb(0, 116, 140)', 'rgb(169, 22, 117)'].sort());
    await f.page.evaluate(() => {
      window.fixtureMain = document.querySelector('.main-content');
      window.fixtureFocus = document.querySelector('[data-mode="day"]');
      window.fixtureMain.scrollTop = 131;
      window.fixtureFocus.focus({ preventScroll: true });
    });
    f.state.changed = true;
    await f.page.clock.runFor(20_001);
    await f.page.getByText('Updated event 0', { exact: true }).waitFor();
    const after = await f.page.evaluate(() => ({ sameMain: fixtureMain === document.querySelector('.main-content'), top: fixtureMain.scrollTop, sameFocus: fixtureFocus === document.activeElement }));
    assert.deepEqual(after, { sameMain: true, top: 131, sameFocus: true });
    assert.equal(await f.page.getByText('Oct 19 – Oct 25', { exact: true }).count(), 1);
    assert.equal(f.state.requests.includes('/api/calendar/connection'), false, 'Frame metadata must not require an admin endpoint.');
    await f.page.evaluate(() => {
      window.fixtureMutations = 0;
      new MutationObserver(records => { fixtureMutations += records.length; }).observe(document.querySelector('#family-app'), { subtree: true, childList: true, attributes: true });
    });
    const polled = f.page.waitForResponse(response => new URL(response.url()).pathname === '/api/calendar');
    await f.page.clock.runFor(20_001);
    await polled;
    await f.page.evaluate(() => new Promise(resolve => queueMicrotask(resolve)));
    assert.equal(await f.page.evaluate(() => fixtureMutations), 0, 'An unchanged poll must not repaint the app.');
    assert.deepEqual(f.state.errors, []);
    assert.deepEqual(f.state.external, []);
  } finally { await f.browser.close(); }
});

test('website shares auth refreshes, clears a revoked hint, and keeps unfinished form input through polling', { skip: !baseUrl }, async () => {
  const f = await fixture({ frame: false, width: 390, height: 844 });
  try {
    await f.open();
    await f.page.getByRole('link', { name: 'Settings', exact: true }).click();
    await f.page.locator('.settings-row[data-action="settings-section"][data-id="family"]').click();
    await f.page.getByLabel('Household name', { exact: true }).waitFor();
    assert.equal(f.state.requests.filter(path => path === '/api/auth/get-session').length, 1);
    assert.equal(f.state.requests.filter(path => path === '/api/auth/token').length, 1);
    await f.page.getByLabel('Household name', { exact: true }).fill('Unfinished fixture name');
    await f.page.getByLabel('Timezone', { exact: true }).fill('UTC');
    await f.page.getByRole('heading', { name: 'Settings', exact: true }).click();
    f.state.chores[0].title = 'A changed fixture chore';
    await f.page.clock.runFor(20_001);
    assert.equal(await f.page.getByLabel('Household name', { exact: true }).inputValue(), 'Unfinished fixture name');
    assert.equal(await f.page.getByLabel('Timezone', { exact: true }).inputValue(), 'UTC');
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), 390);
    f.state.rejectHousehold = true;
    assert.equal(await f.page.evaluate(async () => {
      const { request } = await import('/family/js/api.js');
      try { await request('/api/household'); } catch (error) { return error.status; }
    }), 401);
    await f.page.evaluate(async () => { const { request } = await import('/family/js/api.js'); await Promise.all([request('/api/household'), request('/api/calendar/connection')]); });
    assert.equal(f.state.requests.filter(path => path === '/api/auth/get-session').length, 2);
    assert.equal(f.state.requests.filter(path => path === '/api/auth/token').length, 2);
    assert.deepEqual(await f.page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('frame completion retry preserves its idempotency key and updates the existing row after confirmation', { skip: !baseUrl }, async () => {
  const f = await fixture();
  try {
    await f.open('chores');
    const selector = '[data-action="complete-chore"][data-id="fixture-chore-0"]';
    await f.page.evaluate(selector => { window.fixtureChore = document.querySelector(selector); }, selector);
    f.state.failNextCompletion = true;
    await f.page.locator(selector).click();
    await f.page.getByText('Your change has not been confirmed.', { exact: false }).waitFor();
    assert.equal(await f.page.locator(selector).getAttribute('aria-pressed'), 'false');
    await f.page.locator(selector).locator('..').getByRole('button', { name: 'Retry', exact: true }).click();
    await f.page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', selector);
    assert.equal(f.state.writes.length, 2);
    assert.deepEqual(f.state.writes[1], f.state.writes[0]);
    assert.equal(await f.page.evaluate(selector => fixtureChore === document.querySelector(selector), selector), true);
    assert.equal(await f.page.evaluate(() => fixtureChore === document.activeElement), true);
    assert.ok(await f.page.locator(selector).evaluate(element => element.getBoundingClientRect().height) >= 48);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('a saving chore keeps keyboard focus, waits for confirmation, and ignores a second activation', { skip: !baseUrl }, async () => {
  const f = await fixture();
  try {
    await f.open('chores');
    const selector = '[data-action="complete-chore"][data-id="fixture-chore-0"]';
    f.state.holdNextCompletion = true;
    await f.page.locator(selector).click();
    await f.page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-busy') === 'true', selector);
    assert.equal(await f.page.locator(selector).getAttribute('aria-pressed'), 'false');
    assert.equal(await f.page.locator(selector).evaluate(element => document.activeElement === element), true);
    await f.page.locator(selector).evaluate(element => element.click());
    assert.equal(f.state.writes.length, 1);
    f.state.releaseCompletion();
    await f.page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', selector);
    assert.equal(await f.page.locator(selector).evaluate(element => document.activeElement === element), true);
    assert.deepEqual(f.state.errors, []);
  } finally { f.state.releaseCompletion?.(); await f.browser.close(); }
});

test('a queued calendar background update retains events without reporting a provider failure', { skip: !baseUrl }, async () => {
  const f = await fixture();
  try {
    await f.open();
    f.state.calendarStatus = 'stale'; f.state.syncState = 'scheduled'; f.state.changed = true;
    await f.page.clock.runFor(20_001);
    await f.page.locator('.frame-next-event').getByText('Updated event 0', { exact: true }).waitFor();
    assert.equal(await f.page.getByText('Calendar update in progress.', { exact: true }).count(), 0);
    assert.equal(await f.page.locator('.status-warning').count(), 0);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});
