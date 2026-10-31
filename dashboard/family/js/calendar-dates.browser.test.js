// Local-only UI fixture: synthetic calendar responses, with no family account,
// database, Apple Calendar, or external network controller access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const baseUrl = process.env.FAMILY_UI_TEST_URL;
const date = '2026-10-21';
// Wednesday in the household, Thursday in UTC and in the browser's timezone.
const clock = '2026-10-22T01:00:00Z';

for (const { frame, width, height } of [
  { frame: true, width: 1280, height: 800 },
  { frame: false, width: 390, height: 844 },
  { frame: false, width: 320, height: 740 },
]) {
  test(`Today calendar dates use the household day and fit ${frame ? 'frame' : 'phone'} ${width}px`, { skip: !baseUrl }, async () => {
    const origin = new URL(baseUrl);
    assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname), 'Calendar fixtures may run only against localhost.');
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height }, timezoneId: 'Asia/Tokyo' });
      page.setDefaultTimeout(8000);
      await page.clock.install({ time: new Date(clock) });
      const household = { id: 'fixture-home', title: 'Synthetic household', timezone: 'America/Denver' };
      const user = { id: 'fixture-user', name: 'Synthetic parent', email: 'fixture@example.invalid' };
      const calendars = [{ id: 'fixture-calendar', name: 'Synthetic calendar', color: '#00748c', selected: true }];
      const events = [
        { id: 'fixture-multiday', title: 'Synthetic school break', allDay: true, startDate: '2026-10-20', endDateExclusive: '2026-10-23' },
        { id: 'fixture-overnight', title: 'Synthetic overnight event', allDay: false, startAt: '2026-10-21T05:00:00Z', endAt: '2026-10-21T08:00:00Z' },
        { id: 'fixture-timed', title: 'Synthetic afternoon appointment', allDay: false, startAt: '2026-10-21T21:00:00Z', endAt: '2026-10-21T22:00:00Z', location: 'Synthetic location' },
        { id: 'fixture-midnight', title: 'Synthetic event ending at midnight', allDay: false, startAt: '2026-10-21T04:00:00Z', endAt: '2026-10-21T06:00:00Z' },
      ].map(event => ({ calendarId: calendars[0].id, ...event }));
      const errors = [], external = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (new URL(request.url()).origin !== origin.origin) external.push(request.url()); });
      await page.route('**/api/**', async route => {
    if(new URL(route.request().url()).pathname==='/api/live-status') { await route.fulfill({contentType:'application/json',body:JSON.stringify({data:{}})});return; }
        const req = route.request(), url = new URL(req.url());
        if (req.method() !== 'GET') writes.push({ method: req.method(), path: url.pathname });
        const role = frame ? 'frame' : 'admin';
        let data;
        if (url.pathname === '/api/session') data = { authenticated: true, authType: frame ? 'frame' : 'user', role, household, user };
        else if (url.pathname === '/api/auth/get-session') data = { session: { expiresAt: '2099-01-01T00:00:00Z' }, user };
        else if (url.pathname === '/api/auth/token') data = { token: 'fixture.transient.token' };
        else if (url.pathname === '/api/household') data = { household, role, date, people: [], chores: [] };
        else if (url.pathname === '/api/calendar') data = { status: 'ready', events, calendars, coverage: { startDate: '2026-10-19', endDateExclusive: '2026-10-27', complete: true, truncated: false }, lastSuccessfulSyncAt: clock };
        else if (url.pathname === '/api/media') data = { media: [] };
    else if (url.pathname === '/api/notifications') data = { notifications: [] };
    else throw new Error(`Unexpected synthetic route ${req.method()} ${url.pathname}`);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.pathname.startsWith('/api/auth/') ? data : { data }) });
      });
      await page.goto(new URL(`/family.html${frame ? '?display=frame' : ''}#today`, origin).href);
      await page.locator(frame ? '.frame-home-calendar' : '.agenda-panel').waitFor();
      const browserDate = await page.evaluate(() => ({ local: new Date().getDate(), utc: new Date().getUTCDate() }));
      assert.deepEqual(browserDate, { local: 22, utc: 22 }, 'The test must cross the browser/UTC date boundary.');
      if (frame) {
        const next = page.locator('.frame-next-event');
        assert.match(await next.innerText(), /Synthetic school break.*Wednesday, October 21.*All day/s);
        await page.clock.setSystemTime(new Date('2026-10-21T07:00:00Z'));
        await page.reload();
        await page.getByRole('button', { name: 'Details for Synthetic overnight event', exact: true }).waitFor();
        assert.match(await next.innerText(), /Tuesday, October 20.*11:00 PM/s, 'An ongoing overnight event keeps its real start day and takes priority over an all-day event.');
      } else {
      await page.getByText('Earlier today · 2', { exact: true }).click();
      const cards = page.locator('.agenda-panel .event-card');
      assert.equal(await cards.count(), 3);
      assert.deepEqual(await cards.locator('h3').allTextContents(), ['Synthetic school break', 'Synthetic overnight event', 'Synthetic afternoon appointment']);
      for (const card of await cards.all()) {
        assert.equal(await card.getAttribute('data-date'), date);
        assert.match(await card.getAttribute('aria-label'), /Wednesday, October 21/);
        assert.ok(await card.locator('time.event-time').getAttribute('datetime'));
      }
      assert.equal(await cards.nth(0).locator('.event-time').innerText(), 'All day');
      await cards.nth(1).locator('.event-time').waitFor({ state: 'visible' });
      const overnightTime = await cards.nth(1).locator('.event-time').innerText();
      assert.match(overnightTime, /Tue, Oct 20.*11:00 PM/);
      assert.match(overnightTime, /Wed, Oct 21.*2:00 AM/);
      assert.equal(await cards.nth(2).locator('.event-time').innerText(), '3:00 PM – 4:00 PM');
      }
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        cards: [...document.querySelectorAll('.agenda-panel .event-card')].map(element => {
          const bounds = element.getBoundingClientRect();
          return { width: element.clientWidth, content: element.scrollWidth, left: bounds.left, right: bounds.right };
        }),
      }));
      assert.ok(layout.document <= layout.viewport, JSON.stringify(layout));
      assert.ok(layout.cards.every(card => card.content <= card.width && card.left >= 0 && card.right <= width), JSON.stringify(layout));
      if (process.env.FAMILY_UI_SCREENSHOT_DIR) {
        await mkdir(process.env.FAMILY_UI_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.FAMILY_UI_SCREENSHOT_DIR}/calendar-dates-${frame ? 'frame' : 'phone'}-${width}.png`, fullPage: true });
      }
      await (frame ? page.locator('.frame-calendar-link') : page.getByRole('link', { name: 'View calendar', exact: false })).click();
      await page.getByRole('heading', { name: 'Calendar', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Day', exact: true }).click();
      await page.getByRole('heading', { name: 'Wednesday, October 21', exact: true }).waitFor();
      const agenda = page.locator('.agenda-day[data-key="agenda-2026-10-21"]');
      assert.equal(await agenda.locator('.event-card').count(), 3);
      assert.equal(await agenda.locator('time.event-date').count(), 0, 'Calendar already identifies its days in the agenda header.');
      assert.equal(await agenda.getByText('Synthetic event ending at midnight', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      assert.deepEqual(writes, []);
    } finally { await browser.close(); }
  });
}
