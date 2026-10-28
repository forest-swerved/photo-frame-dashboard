// Local-only school-calendar UI contracts. All data and writes are intercepted;
// no family account, school website, database, or calendar provider is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const baseUrl = process.env.FAMILY_UI_TEST_URL;
const today = '2026-10-21', clock = '2026-10-21T18:00:00Z';
async function fixture({ role = 'admin', frame = false, width = 390, unknown = false } = {}) {
  const origin = new URL(baseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname), 'School calendar fixtures may run only against localhost.');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
  page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date(clock) });
  const home = { id: 'fixture-home', title: 'Synthetic household', timezone: 'America/Denver' };
  const user = { id: 'fixture-parent', name: 'Synthetic parent', email: 'fixture@example.invalid' };
  const person = { id: 'fixture-child', name: 'Synthetic child', color: '#00748c' };
  const routine = { id: 'fixture-routine', title: 'Synthetic school morning', personId: person.id, scheduleType: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6], schoolDayFilter: 'school_day', required: true, requiresApproval: false, version: 7, dueTime: '08:00', reminderMinutes: 15, instructions: '', subtasks: [] };
  const calendar = { title: 'Synthetic 2026–2027 school calendar', sourceName: 'Synthetic district PDF', sourceUrl: 'https://school.example.invalid/calendar.pdf', sourceSha256: 'a'.repeat(64), coverageStart: '2026-07-01', coverageEndExclusive: '2027-07-01', termStart: '2026-08-20', termEndExclusive: '2027-05-29', weekdays: [1, 2, 3, 4, 5], closures: [{ fromDate: '2026-10-15', toDateExclusive: '2026-10-17', label: 'Synthetic fall break' }], overrides: [], version: 3, updatedAt: clock };
  const schoolDay = { date: today, type: unknown ? 'unknown' : 'school_day', label: unknown ? 'School schedule unknown' : 'School day', reason: unknown ? 'Outside confirmed school calendar dates.' : 'Published school calendar', calendarVersion: unknown ? null : calendar.version };
  const state = { calls: [], errors: [], external: [], routine, calendar, schoolDay, people: [person], occurrences: [], failSave: false };
  const manager = role === 'admin' || role === 'caregiver';
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== origin.origin) state.external.push(request.url()); });
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), body = req.method() === 'GET' ? null : req.postDataJSON();
    state.calls.push({ path: url.pathname, method: req.method(), body, query: url.search });
    let data;
    if (url.pathname === '/api/session') data = { authenticated: true, authType: frame ? 'frame' : 'user', role, personId: role === 'child' ? person.id : null, household: home, user };
    else if (url.pathname === '/api/auth/get-session') data = { session: { expiresAt: '2099-01-01T00:00:00Z' }, user };
    else if (url.pathname === '/api/auth/token') data = { token: 'fixture.transient.token' };
    else if (url.pathname === '/api/household') data = { household: home, role, date: today, people: state.people, chores: [], routines: [routine], occurrences: state.occurrences, schoolDay, capabilities: { manageChores: manager, manageInternet: false } };
    else if (url.pathname === '/api/calendar') data = { status: 'not_configured', events: [] };
    else if (url.pathname === '/api/calendar/connection') data = { connected: false, calendars: [] };
    else if (url.pathname === '/api/devices') data = { devices: [] };
    else if (url.pathname === '/api/members') data = { members: [] };
    else if (url.pathname === '/api/internet') data = { serverTime: clock, timezone: home.timezone, role, capabilities: { manageInternet: false }, integration: { state: 'unconfigured' }, devices: [], sessions: [], policies: [], credits: [], progress: [] };
    else if (url.pathname === '/api/school-calendar') {
      if (req.method() === 'PATCH') {
        if (state.failSave) {
          await route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":{"code":"version_conflict","message":"School calendar changed."}}' }); return;
        }
        assert.equal(body.expectedVersion, calendar.version, 'School date changes must carry the loaded calendar version.');
        calendar.version++;
        calendar.overrides = calendar.overrides.filter(item => item.date !== body.override.date);
        if (body.override.type) calendar.overrides.push(body.override);
        if (body.override.date === today) {
          schoolDay.type = body.override.type || 'school_day';
          schoolDay.label = schoolDay.type === 'school_day' ? 'School day' : 'No school';
          schoolDay.reason = body.override.type ? body.override.reason : 'Published school calendar';
          schoolDay.calendarVersion = calendar.version;
        }
      }
      const lookupDate = url.searchParams.get('date') || today;
      data = { calendar, schoolDay: lookupDate === '2026-10-15' ? { date: lookupDate, type: 'non_school_day', label: 'No school', reason: 'Synthetic fall break', calendarVersion: calendar.version } : schoolDay };
    } else if (url.pathname === '/api/chores/fixture-routine' && req.method() === 'PATCH') {
      assert.equal(body.expectedVersion, routine.version); Object.assign(routine, body, { version: routine.version + 1 }); data = routine;
    } else if (url.pathname === '/api/chores/batch' && req.method() === 'POST') data = { routines: body.personIds.map(personId => ({ ...body, personId, id: `new-${personId}`, version: 1 })) };
    else if (url.pathname === '/api/chores' && req.method() === 'POST') data = { id: 'fixture-new-routine', ...body, version: 1 };
    else if (url.pathname === '/api/notifications') data = { notifications: [] };
    else throw new Error(`Unexpected synthetic route ${req.method()} ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.pathname.startsWith('/api/auth/') ? data : { data }) });
  });
  return { browser, page, state, async open(view = 'chores') {
    await page.goto(new URL(`/family.html${frame ? '?display=frame' : ''}#${view}`, origin).href);
    await page.getByRole('heading', { name: view === 'setup' ? 'Settings' : view === 'chores' ? (role === 'child' ? 'My tasks' : 'Tasks') : view[0].toUpperCase() + view.slice(1), exact: true, level: 1 }).waitFor();
  } };
}

test('parent edits the school-day filter with routine CAS and one-off chores reset to any day type', { skip: !baseUrl }, async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.page.getByRole('button', { name: 'Routines', exact: true }).click();
    await f.page.locator('.all-chores').getByRole('button', { name: 'Edit Synthetic school morning', exact: true }).click();
    assert.equal(await f.page.getByLabel('School-day schedule', { exact: true }).inputValue(), 'school_day');
    assert.equal(await f.page.getByLabel('School-day task section', { exact: true }).inputValue(), 'tasks', 'Existing tasks keep their unspecified phase.');
    await f.page.getByLabel('School-day schedule', { exact: true }).selectOption('non_school_day');
    await f.page.getByRole('button', { name: 'Save task', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    const edit = f.state.calls.find(call => call.path === '/api/chores/fixture-routine' && call.method === 'PATCH');
    assert.equal(edit.body.expectedVersion, 7); assert.equal(edit.body.schoolDayFilter, 'non_school_day');
    assert.deepEqual(edit.body.weekdays, [0, 1, 2, 3, 4, 5, 6]);
    await f.page.locator('.all-chores').getByText(/Non-school days only/).waitFor();
    await f.page.getByRole('button', { name: '+ Add a task', exact: true }).click();
    await f.page.getByLabel('Task', { exact: true }).fill('Synthetic one-off');
    await f.page.getByLabel('Synthetic child', { exact: true }).check();
    await f.page.getByRole('button', { name: 'Continue', exact: true }).click();
    await f.page.getByLabel('Day type', { exact: true }).selectOption('school_day');
    assert.equal(await f.page.getByLabel('On school days', { exact: true }).inputValue(), 'tasks');
    await f.page.getByLabel('On school days', { exact: true }).selectOption('after_school');
    await f.page.getByLabel('Schedule', { exact: true }).selectOption('one_off');
    assert.equal(await f.page.getByLabel('Day type', { exact: true }).isVisible(), false);
    await f.page.getByLabel('One-off date', { exact: true }).fill('2026-10-25');
    await f.page.getByRole('button', { name: 'Continue', exact: true }).click();
    await f.page.getByRole('button', { name: 'Add task', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    const create = f.state.calls.find(call => call.path === '/api/chores/batch' && call.method === 'POST');
    assert.equal(create.body.schoolDayFilter, 'any'); assert.equal(create.body.scheduledDate, '2026-10-25');
    assert.equal(create.body.taskSection, 'tasks');
    assert.deepEqual(f.state.errors, []); assert.deepEqual(f.state.external, []);
  } finally { await f.browser.close(); }
});

test('empty school-day sections are visible immediately and add-task actions prefill the child and phase', { skip: !baseUrl }, async () => {
  const f = await fixture({ width: 1280 });
  try {
    await f.open('today');
    const todayPanel = f.page.locator('.chores-panel');
    assert.equal(await todayPanel.getByText('No unfinished tasks. Nice work!', { exact: true }).count(), 1);
    assert.equal(await todayPanel.getByRole('link', { name: 'View all tasks →', exact: true }).count(), 1);
    await f.page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await f.page.getByRole('heading', { name: 'Tasks', exact: true, level: 1 }).waitFor();
    await f.page.getByRole('button', { name: 'Add a task after school for Synthetic child', exact: true }).click();
    assert.equal(await f.page.getByLabel('Synthetic child', { exact: true }).isChecked(), true);
    await f.page.getByLabel('Task', { exact: true }).fill('Synthetic afternoon task');
    await f.page.getByRole('button', { name: 'Continue', exact: true }).click();
    assert.equal(await f.page.getByLabel('Day type', { exact: true }).inputValue(), 'school_day');
    assert.equal(await f.page.getByLabel('On school days', { exact: true }).inputValue(), 'after_school');
    await f.page.getByRole('button', { name: 'Continue', exact: true }).click();
    await f.page.getByRole('button', { name: 'Add task', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    const create = f.state.calls.find(call => call.path === '/api/chores/batch' && call.method === 'POST');
    assert.equal(create.body.schoolDayFilter, 'school_day'); assert.equal(create.body.taskSection, 'after_school');
    assert.deepEqual(create.body.personIds, ['fixture-child']);
    if (process.env.FAMILY_UI_SCREENSHOT_DIR) {
      await mkdir(process.env.FAMILY_UI_SCREENSHOT_DIR, { recursive: true });
      await f.page.screenshot({ path: `${process.env.FAMILY_UI_SCREENSHOT_DIR}/task-sections-empty-1280.png`, fullPage: true });
    }
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

for (const width of [1280, 390]) {
  test(`Today shows a bounded unfinished-task preview with an explicit path to every school task at ${width}px`, { skip: !baseUrl }, async () => {
    const f = await fixture({ role: 'frame', frame: true, width });
    try {
      f.state.occurrences = Array.from({ length: 8 }, (_, index) => ({
        id: `fixture-many-${index}`, choreId: `fixture-many-routine-${index}`, title: `Synthetic ${index === 7 ? 'afternoon' : 'morning'} task ${index + 1}`,
        personId: 'fixture-child', date: today, originalDate: today, definitionSource: 'routine', schoolDayFilter: 'school_day',
        taskSection: index === 7 ? 'after_school' : 'before_school', dueTime: index === 7 ? '17:00' : '08:00', status: 'pending', required: true, version: 1, subtasks: [],
        completion: { date: today, completed: false, version: 0 },
      }));
      await f.open('today');
      const panel = f.page.locator('.chores-panel');
      assert.equal(await panel.locator('.chore-row').count(), 4);
      assert.equal(await panel.getByRole('link', { name: 'View 4 more tasks →', exact: true }).count(), 1);
      await panel.getByRole('link', { name: 'View 4 more tasks →', exact: true }).click();
      await f.page.getByRole('heading', { name: 'Tasks', exact: true, level: 1 }).waitFor();
      assert.equal(await f.page.locator('.person-lane .chore-row').count(), 8);
      f.state.schoolDay.type = 'non_school_day'; f.state.schoolDay.label = 'No school';
      await f.page.getByRole('link', { name: 'Today', exact: true }).click();
      await f.page.getByRole('heading', { name: 'Today', exact: true, level: 1 }).waitFor();
      await f.page.reload();
      await f.page.locator('.welcome-summary').getByText(/No school/).waitFor();
      assert.equal(await panel.locator('.chore-row').count(), 0);
      assert.equal(await panel.getByText('No unfinished tasks. Nice work!', { exact: true }).count(), 1);
      assert.equal(await panel.getByRole('heading', { name: 'After school', exact: true }).count(), 0);
      assert.deepEqual(f.state.errors, []); assert.deepEqual(f.state.external, []);
    } finally { await f.browser.close(); }
  });

  test(`school days group each child's before/after tasks and days off collapse to Tasks at ${width}px`, { skip: !baseUrl }, async () => {
    const f = await fixture({ role: 'admin', width });
    try {
      f.state.people = [{ id: 'fixture-andre', name: 'Andre', color: '#00748c' }, { id: 'fixture-stevie', name: 'Stevie', color: '#a91675' }];
      f.state.occurrences = f.state.people.flatMap((person, personIndex) => ['before_school', 'after_school'].map((taskSection, index) => ({
        id: `fixture-occurrence-${personIndex}-${index}`, choreId: `fixture-routine-${personIndex}-${index}`, title: `${person.name} ${index ? 'afternoon' : 'morning'} fixture`, personId: person.id,
        date: today, originalDate: today, definitionSource: 'routine', schoolDayFilter: 'school_day', taskSection, status: index ? 'pending' : 'completed', required: true, version: 1,
        subtasks: [], completion: { date: today, completed: index === 0, version: 0 },
      })));
      f.state.occurrences.push({ ...f.state.occurrences[0], id: 'fixture-anytime', title: 'Andre any-time fixture', taskSection: 'tasks', status: 'pending', schoolDayFilter: 'any', completion: { date: today, completed: false, version: 0 } });
      await f.open();
      assert.equal(await f.page.locator('.person-lane .chore-row').count(), 3, 'Completed morning work is tucked away by default.');
      for (const person of f.state.people) {
        await f.page.getByRole('button', { name: new RegExp('^' + person.name + ' ·') }).click();
        const lane = f.page.locator('.person-lane');
        assert.equal(await lane.getByRole('heading', { name: 'Before school', exact: true }).count(), 0, 'Completed-only sections stay in the Done filter.');
        assert.equal(await lane.getByRole('heading', { name: 'After school', exact: true }).count(), 1);
        assert.equal(await lane.getByText(`${person.name} afternoon fixture`, { exact: true }).count(), 1);
        assert.equal(await lane.getByText(`${person.name} morning fixture`, { exact: true }).count(), 0);
        await f.page.getByRole('button', { name: /^Done ·/ }).click();
        assert.equal(await lane.getByText(`${person.name} morning fixture`, { exact: true }).count(), 1);
        await f.page.getByRole('button', { name: /^To do ·/ }).click();
      }
      await f.page.getByRole('button', { name: 'Everyone', exact: true }).click();
      if (process.env.FAMILY_UI_SCREENSHOT_DIR) {
        await mkdir(process.env.FAMILY_UI_SCREENSHOT_DIR, { recursive: true });
        await f.page.screenshot({ path: `${process.env.FAMILY_UI_SCREENSHOT_DIR}/task-sections-school-${width}.png`, fullPage: true });
      }
      await f.page.getByRole('link', { name: 'Today', exact: true }).click();
      await f.page.getByRole('heading', { name: 'Today', exact: true, level: 1 }).waitFor();
      assert.equal(await f.page.locator('.chores-panel .chore-row').count(), 3);
      assert.equal(await f.page.getByRole('progressbar', { name: "Required tasks complete", exact: true }).getAttribute('aria-valuemax'), '5');
      f.state.schoolDay.type = 'non_school_day'; f.state.schoolDay.label = 'No school';
      await f.page.reload();
      await f.page.locator('.welcome-summary').getByText(/No school/).waitFor();
      assert.equal(await f.page.getByRole('heading', { name: 'Before school', exact: true }).count(), 0);
      assert.equal(await f.page.getByRole('heading', { name: 'After school', exact: true }).count(), 0);
      assert.equal(await f.page.locator('.chores-panel .chore-row').count(), 1);
      const progress = f.page.getByRole('progressbar', { name: "Required tasks complete", exact: true });
      assert.equal(await progress.getAttribute('aria-valuemax'), '1'); assert.equal(await progress.getAttribute('aria-valuenow'), '0');
      await f.page.getByRole('link', { name: 'Tasks', exact: true }).click();
      await f.page.getByRole('heading', { name: 'Tasks', exact: true, level: 1 }).waitFor();
      await f.page.getByText('Earlier schedule and excused work · 4', { exact: true }).click();
      assert.equal(await f.page.locator('.earlier-schedule .chore-row').count(), 4);
      assert.equal(await f.page.locator('.earlier-schedule .chore-deadline').count(), 0);
      assert.equal(await f.page.locator('.person-lane .chore-row').count(), 1);
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), width);
      assert.deepEqual(f.state.errors, []); assert.deepEqual(f.state.external, []);
    } finally { await f.browser.close(); }
  });
}

test('parents review imported dates, set a day off, and restore the imported calendar separately from chore breaks', { skip: !baseUrl }, async () => {
  const f = await fixture();
  try {
    await f.open();
    if (await f.page.locator('.task-tools:not([open])').count()) await f.page.getByText('History and schedule tools', { exact: true }).click();
    await f.page.getByRole('button', { name: 'School calendar', exact: true }).click();
    await f.page.getByRole('heading', { name: f.state.calendar.title, exact: true }).waitFor();
    const source = f.page.getByRole('link', { name: 'School calendar source', exact: false });
    assert.equal(await source.getAttribute('href'), 'https://school.example.invalid/calendar.pdf');
    assert.equal(await source.getAttribute('rel'), 'noopener noreferrer');
    if (process.env.FAMILY_UI_SCREENSHOT_DIR) {
      await mkdir(process.env.FAMILY_UI_SCREENSHOT_DIR, { recursive: true });
      await f.page.screenshot({ path: `${process.env.FAMILY_UI_SCREENSHOT_DIR}/school-calendar-phone-summary.png`, fullPage: true });
    }
    await f.page.getByText('Scheduled days off (1)', { exact: true }).click();
    await f.page.getByText('Synthetic fall break', { exact: true }).waitFor();
    assert.equal(await f.page.getByText('Oct 15, 2026 – Oct 16, 2026', { exact: true }).count(), 1, 'Closure end is exclusive.');
    await f.page.getByLabel('School date', { exact: true }).fill('2026-10-15');
    await f.page.getByLabel('School date', { exact: true }).blur();
    await f.page.locator('[data-school-date-preview]').getByText('Synthetic fall break', { exact: true }).waitFor();
    await f.page.getByLabel('School date', { exact: true }).fill(today);
    await f.page.getByLabel('School date', { exact: true }).blur();
    await f.page.locator('[data-school-date-preview]').getByText('School day', { exact: true }).waitFor();
    await f.page.getByLabel('Day type', { exact: true }).selectOption('non_school_day');
    await f.page.getByLabel('Reason for date change', { exact: true }).fill('Synthetic confirmed day off');
    if (process.env.FAMILY_UI_SCREENSHOT_DIR) {
      await mkdir(process.env.FAMILY_UI_SCREENSHOT_DIR, { recursive: true });
      await f.page.screenshot({ path: `${process.env.FAMILY_UI_SCREENSHOT_DIR}/school-calendar-phone.png`, fullPage: true });
    }
    await f.page.getByRole('button', { name: 'Save school date', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    await f.page.locator('.school-day-note').getByText('No school', { exact: true }).waitFor();
    let patches = f.state.calls.filter(call => call.path === '/api/school-calendar' && call.method === 'PATCH');
    assert.deepEqual(patches[0].body, { expectedVersion: 3, override: { date: today, type: 'non_school_day', reason: 'Synthetic confirmed day off' } });
    assert.equal(f.state.calls.some(call => call.path === '/api/chore-exceptions'), false);
    if (await f.page.locator('.task-tools:not([open])').count()) await f.page.getByText('History and schedule tools', { exact: true }).click();
    await f.page.getByRole('button', { name: 'School calendar', exact: true }).click();
    await f.page.getByLabel('Day type', { exact: true }).selectOption('clear');
    await f.page.getByLabel('Reason for date change', { exact: true }).fill('Restore published schedule');
    await f.page.getByRole('button', { name: 'Save school date', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    patches = f.state.calls.filter(call => call.path === '/api/school-calendar' && call.method === 'PATCH');
    assert.equal(patches[1].body.expectedVersion, 4); assert.equal(patches[1].body.override.type, null);
    await f.page.getByRole('link', { name: 'Settings', exact: true }).click();
    await f.page.locator('.settings-row[data-id="tasks"]').click();
    await f.page.getByRole('button', { name: 'View school calendar', exact: true }).waitFor();
    assert.deepEqual(f.state.errors, []); assert.deepEqual(f.state.external, []);
  } finally { await f.browser.close(); }
});

test('a conflicting school-calendar save requires review instead of a blind retry', { skip: !baseUrl }, async () => {
  const f = await fixture();
  try {
    await f.open(); if (await f.page.locator('.task-tools:not([open])').count()) await f.page.getByText('History and schedule tools', { exact: true }).click();
    await f.page.getByRole('button', { name: 'School calendar', exact: true }).click();
    await f.page.getByLabel('Reason for date change', { exact: true }).fill('Synthetic date change');
    f.state.failSave = true;
    await f.page.getByRole('button', { name: 'Save school date', exact: true }).click();
    const retry = f.page.getByRole('button', { name: 'Close and review before retrying', exact: true });
    await retry.waitFor(); assert.equal(await retry.isDisabled(), true);
    assert.equal(f.state.calls.filter(call => call.path === '/api/school-calendar' && call.method === 'PATCH').length, 1);
    assert.equal(f.state.calendar.version, 3);
    await f.page.getByText('This calendar change needs review.', { exact: false }).waitFor();
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('a child sees the school-day status but cannot open calendar or routine management', { skip: !baseUrl }, async () => {
  const f = await fixture({ role: 'child' });
  try {
    await f.open();
    await f.page.locator('.school-day-note').getByText('School day', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'School calendar', exact: true }).count(), 0);
    assert.equal(await f.page.getByRole('button', { name: '+ Add a task', exact: true }).count(), 0);
    await f.page.evaluate(() => {
      const button = document.createElement('button'); button.dataset.action = 'school-calendar'; button.textContent = 'Synthetic injected action'; document.body.append(button); button.click(); button.remove();
    });
    assert.equal(await f.page.locator('dialog[open]').count(), 0);
    assert.equal(f.state.calls.some(call => call.path === '/api/school-calendar'), false);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('an unlocked caregiver frame can manage school dates and untrusted source schemes are never linked', { skip: !baseUrl }, async () => {
  const f = await fixture({ role: 'caregiver', frame: true, width: 1280 });
  try {
    f.state.calendar.sourceUrl = 'javascript:alert("fixture")';
    await f.open(); if (await f.page.locator('.task-tools:not([open])').count()) await f.page.getByText('History and schedule tools', { exact: true }).click();
    await f.page.getByRole('button', { name: 'School calendar', exact: true }).click();
    await f.page.getByRole('heading', { name: f.state.calendar.title, exact: true }).waitFor();
    assert.equal(await f.page.getByRole('link', { name: 'School calendar source', exact: false }).count(), 0);
    if (process.env.FAMILY_UI_SCREENSHOT_DIR) {
      await mkdir(process.env.FAMILY_UI_SCREENSHOT_DIR, { recursive: true });
      await f.page.screenshot({ path: `${process.env.FAMILY_UI_SCREENSHOT_DIR}/school-calendar-frame-summary.png`, fullPage: true });
    }
    await f.page.getByLabel('Reason for date change', { exact: true }).fill('Synthetic parent change');
    await f.page.getByRole('button', { name: 'Save school date', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    assert.equal(f.state.calls.filter(call => call.path === '/api/school-calendar' && call.method === 'PATCH').length, 1);
    assert.deepEqual(f.state.errors, []); assert.deepEqual(f.state.external, []);
  } finally { await f.browser.close(); }
});

test('frame Today and Tasks explain unknown school coverage without excusing all chores', { skip: !baseUrl }, async () => {
  const f = await fixture({ role: 'frame', frame: true, width: 1280, unknown: true });
  try {
    await f.open('today');
    await f.page.getByText('School-dependent tasks are waiting for a confirmed school calendar date.', { exact: false }).waitFor();
    assert.equal(await f.page.locator('.school-day-note').getByText('School schedule unknown', { exact: true }).count(), 1);
    assert.equal(await f.page.getByText('Any-day tasks still apply.', { exact: false }).count(), 1);
    if (process.env.FAMILY_UI_SCREENSHOT_DIR) {
      await mkdir(process.env.FAMILY_UI_SCREENSHOT_DIR, { recursive: true });
      await f.page.screenshot({ path: `${process.env.FAMILY_UI_SCREENSHOT_DIR}/school-calendar-frame-unknown.png`, fullPage: true });
    }
    await f.page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await f.page.locator('.school-day-note').getByText('School schedule unknown', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'School calendar', exact: true }).count(), 0);
    assert.deepEqual(f.state.errors, []); assert.deepEqual(f.state.external, []);
    assert.equal(f.state.calls.some(call => call.method !== 'GET'), false);
  } finally { await f.browser.close(); }
});
