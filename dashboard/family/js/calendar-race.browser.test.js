// Optional UI contract regression. All API responses are intercepted test data;
// this never creates an account or connects to an Apple account or database.
// Run against a local app with FAMILY_UI_TEST_URL=http://localhost:3000 and a
// resolvable Playwright package (or PLAYWRIGHT_MODULE=/absolute/path/index.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dateInZone, addDays } from './model.js';

const baseUrl = process.env.FAMILY_UI_TEST_URL;

test('the pinned SDK retrieves a JWT after its getSession cache is populated', { skip: !baseUrl }, async () => {
  const origin = new URL(baseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname), 'UI fixtures may run only against localhost.');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let tokenRequests = 0;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/session') {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'test_signed_out', message: 'Test session only.' } }) });
        return;
      }
      const data = path === '/api/auth/get-session' ? { session: { id: 'test-session', token: 'opaque-test-session', expiresAt: new Date(Date.now() + 3600000).toISOString() }, user: { id: 'test-user', name: 'UI TEST USER', email: 'test@example.invalid' } } : { token: 'test.fixture.only' };
      if (path === '/api/auth/token') tokenRequests++;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto(new URL('/family.html', origin).href);
    await page.getByRole('heading', { name: 'Your family, together.', exact: true }).waitFor({ timeout: 5000 });
    const result = await page.evaluate(async () => {
      const { authClient, tokenForClient } = await import('/family/js/auth.js');
      const auth = await authClient();
      await auth.getSession();
      const ordinary = await auth.token();
      return { ordinaryToken: ordinary.data?.token || null, jwt: await tokenForClient(auth) };
    });
    assert.equal(result.ordinaryToken, null, 'Reproduce the pinned SDK session/token cache collision.');
    assert.equal(result.jwt, 'test.fixture.only');
    assert.ok(tokenRequests >= 1, 'The helper must actually request the JWT endpoint.');
  } finally { await browser.close(); }
});

for (const obsoleteResponse of ['success', 'unauthorized']) {
  test(`disconnect ignores an older calendar ${obsoleteResponse} response`, { skip: !baseUrl }, async () => {
    const origin = new URL(baseUrl);
    assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname), 'UI fixtures may run only against localhost.');
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const browser = await chromium.launch({ headless: true });
    let releaseOldCalendar;
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const date = dateInZone();
      const household = { id: 'test-household', title: 'UI TEST HOUSEHOLD', timezone: 'America/Denver' };
      const user = { id: 'test-user', name: 'UI TEST USER', email: 'test@example.invalid' };
      let connected = true;
      let firstCalendar = true;
      const errors = [];
      const apiRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        apiRequests.push(url.pathname);
        let data;
        if (url.pathname === '/api/auth/get-session') data = { session: { id: 'test-session', token: 'opaque-test-session', expiresAt: new Date(Date.now() + 3600000).toISOString() }, user };
        else if (url.pathname === '/api/auth/token') data = { token: 'test.fixture.only' };
        else if (url.pathname === '/api/session') data = { authenticated: true, authType: 'user', role: 'admin', user, household };
        else if (url.pathname === '/api/household') data = { household, role: 'admin', date, people: [], chores: [] };
        else if (url.pathname === '/api/devices') data = { devices: [] };
        else if (url.pathname === '/api/members') data = { members: [] };
        else if (url.pathname === '/api/calendar/connection') {
          if (route.request().method() === 'DELETE') connected = false;
          data = { connected, calendars: connected ? [{ id: 'test-calendar', name: 'TEST calendar', color: '#356653', selected: true }] : [], lastSuccessfulSyncAt: null };
        } else if (url.pathname === '/api/calendar') {
          if (firstCalendar) {
            firstCalendar = false;
            await new Promise(resolve => { releaseOldCalendar = resolve; });
            if (obsoleteResponse === 'unauthorized') {
              await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'obsolete_test_error', message: 'Obsolete response must not sign out the current session.' } }) });
              return;
            }
            data = { status: 'ready', events: [{ id: 'obsolete-event', calendarId: 'test-calendar', title: 'OBSOLETE TEST EVENT', location: '', allDay: true, startDate: date, endDateExclusive: addDays(date, 1) }], coverage: { startDate: date, endDateExclusive: addDays(date, 7), complete: true, truncated: false }, lastSuccessfulSyncAt: new Date().toISOString(), error: null };
          } else data = { status: 'not_configured', events: [], coverage: null, lastSuccessfulSyncAt: null, error: null };
        } else {
          await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'test_route_missing', message: 'Test route missing.' } }) });
          return;
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.pathname.startsWith('/api/auth/') ? data : { data }) });
      });
      await page.goto(new URL('/family.html', origin).href);
      try { await page.getByRole('heading', { name: 'Today', exact: true }).waitFor({ timeout: 5000 }); }
      catch { throw new Error(`UI fixture startup failed. Routes: ${apiRequests.join(', ')}. Screen: ${(await page.locator('body').innerText()).slice(0, 600)}`); }
      await page.waitForFunction(() => document.querySelector('.status-note')?.textContent.includes('Checking'));
      await page.getByRole('link', { name: 'Setup', exact: true }).click();
      await page.getByRole('button', { name: 'Disconnect Apple Calendar', exact: true }).click();
      await page.getByRole('button', { name: 'Disconnect calendar', exact: true }).click();
      await page.getByRole('button', { name: 'Connect Apple Calendar', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Today', exact: true }).click();
      await page.getByText('Your Apple Calendar is not connected.', { exact: false }).waitFor();
      const obsolete = page.waitForResponse(response => new URL(response.url()).pathname === '/api/calendar' && (obsoleteResponse === 'success' ? response.status() === 200 : response.status() === 401));
      assert.ok(releaseOldCalendar, 'The older calendar request must still be pending.');
      releaseOldCalendar();
      await obsolete;
      // Let the response body and the app's catch/finally handlers finish.
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 80)));
      assert.equal(await page.getByRole('heading', { name: 'Today', exact: true }).count(), 1);
      assert.equal(await page.getByText('Your Apple Calendar is not connected.', { exact: false }).count(), 1);
      assert.equal(await page.getByText('OBSOLETE TEST EVENT', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      releaseOldCalendar?.();
      await browser.close();
    }
  });
}
