import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.FAMILY_UI_TEST_URL;
async function fixture({ role = 'admin', frame = false, signedOut = false, width = 1280 } = {}) {
  const origin = new URL(base); assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
  await page.clock.install({ time: new Date('2026-10-17T18:00:00Z') });
  const home = { id: 'fixture-home', title: 'Synthetic household', timezone: 'America/Denver' };
  const person = { id: 'fixture-child', name: 'Synthetic child', color: '#00748c' };
  const routine = { id: 'fixture-routine', title: 'Synthetic routine', personId: person.id, weekdays: [0, 1, 2, 3, 4, 5, 6], version: 2, dueTime: '18:00', reminderMinutes: 15, required: true, requiresApproval: true, scheduleType: 'weekly', instructions: 'Use clean water.', subtasks: [{ id: 'fixture-step', title: 'Prepare supplies' }] };
  const occurrence = { ...routine, id: 'fixture-occurrence', choreId: routine.id, date: '2026-10-17', originalDate: '2026-10-17', status: 'pending', version: 3, subtasks: [{ id: 'fixture-step', title: 'Prepare supplies', completed: false }], completion: { date: '2026-10-17', completed: false, version: 0 } };
  const state = { calls: [], errors: [], occurrence, routine, notificationRead: false, grant: false };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? req.postDataJSON() : null;
    state.calls.push({ path: url.pathname, method, body, headers: req.headers(), query: url.search });
    let data;
    const activeRole = frame ? state.grant && req.headers()['x-family-authorization'] === 'fixture-private-grant' ? 'caregiver' : 'frame' : role;
    if (url.pathname === '/api/session') {
      if (signedOut) { await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"message":"Signed out"}}' }); return; }
      data = { authType: frame ? 'frame' : 'user', role: activeRole, personId: role === 'child' ? person.id : null, household: home, user: { id: 'fixture-user', name: 'Synthetic account' } };
    } else if (url.pathname === '/api/auth/get-session') data = signedOut ? null : { session: { expiresAt: '2099-01-01T00:00:00Z' } };
    else if (url.pathname === '/api/auth/token') data = { token: 'fixture.transient.token' };
    else if (url.pathname === '/api/household') data = { household: home, role: activeRole, date: '2026-10-17', people: [person], chores: [{ ...routine, completion: occurrence.completion }], routines: [routine], occurrences: [occurrence], capabilities: { manageChores: activeRole === 'admin' || activeRole === 'caregiver', manageInternet: activeRole === 'admin' || activeRole === 'caregiver' } };
    else if (url.pathname === '/api/internet') data = { serverTime: '2026-10-17T18:00:00Z', timezone: home.timezone, role: activeRole, capabilities: { manageInternet: activeRole === 'admin' }, integration: { state: 'unconfigured' }, devices: [], sessions: [], policies: [], credits: [], progress: [] };
    else if (url.pathname === '/api/calendar') data = { status: 'not_configured', events: [] };
    else if (url.pathname === '/api/calendar/connection') data = { connected: false, calendars: [] };
    else if (url.pathname === '/api/devices') data = { devices: [] };
    else if (url.pathname === '/api/members') data = { members: [] };
    else if (url.pathname === '/api/chores' && method === 'POST') data = { ...body, id: 'fixture-new', version: 1 };
    else if (url.pathname.endsWith('/completion')) {
      occurrence.version++; occurrence.status = body.completed ? role === 'child' ? 'submitted' : 'completed' : 'pending';
      occurrence.completion = { date: occurrence.date, completed: body.completed, version: occurrence.completion.version + 1 }; data = occurrence;
    } else if (url.pathname.endsWith('/actions')) {
      occurrence.version++;
      if (body.action === 'approve') occurrence.status = 'completed';
      if (body.action === 'subtasks') occurrence.subtasks = occurrence.subtasks.map(item => ({ ...item, completed: body.completedSubtaskIds.includes(item.id) }));
      data = occurrence;
    } else if (url.pathname === '/api/chore-history') data = { history: [{ id: 'fixture-history', occurrenceId: occurrence.id, title: occurrence.title, personName: person.name, type: 'submitted', actorName: 'Synthetic child', reason: null, createdAt: '2026-10-17T18:00:00Z' }] };
    else if (url.pathname === '/api/chore-exceptions') data = method === 'GET' ? { exceptions: [] } : { id: 'fixture-break', ...body, version: 1 };
    else if (url.pathname === '/api/notifications') data = { notifications: [{ id: 'fixture-notification', kind: 'chore_submitted', title: 'Task ready for approval', body: 'Synthetic child submitted a chore.', target: 'chores', readAt: state.notificationRead ? '2026-10-17T18:00:00Z' : null, createdAt: '2026-10-17T18:00:00Z' }] };
    else if (url.pathname.endsWith('/read')) { state.notificationRead = true; data = { read: true }; }
    else if (url.pathname === '/api/notification-preferences') data = method === 'GET' ? { pushEnabled: true, choreCompleted: true, choreReopened: true, choreDueSoon: true, choreOverdue: true, rewards: true, internetSessions: true, calendarEvents: true, frameStatus: true, timezone: 'America/Denver', quietStart: null, quietEnd: null } : body;
    else if (url.pathname === '/api/frame-access-codes') data = { code: '123456', scope: body.scope, personId: body.personId || null, expiresAt: '2026-10-17T18:05:00Z' };
    else if (url.pathname === '/api/frame-access/redeem') { state.grant = true; data = { token: 'fixture-private-grant', scope: 'parent', personId: null, expiresAt: '2026-10-17T18:00:03Z' }; }
    else if (url.pathname.startsWith('/api/auth/')) data = { success: true };
    else throw new Error(`Missing fixture ${method} ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.pathname.startsWith('/api/auth/') ? data : { data }) });
  });
  return { browser, page, state, async open(view = 'chores') {
    await page.goto(new URL(`/family.html${frame ? '?display=frame' : ''}#${view}`, origin).href);
    if (!signedOut) await page.getByRole('heading', { name: view === 'setup' ? 'Settings' : view === 'chores' ? (role === 'child' ? 'My tasks' : 'Tasks') : view[0].toUpperCase() + view.slice(1), exact: true, level: 1 }).waitFor();
    else await page.getByRole('heading', { name: 'Your family, together.', exact: true }).waitFor();
  } };
}

test('child submits the dated occurrence with CAS, sees approval waiting, and cannot access parent actions', { skip: !base }, async () => {
  const f = await fixture({ role: 'child', width: 390 });
  try {
    await f.open();
    await f.page.getByRole('button', { name: /Submit for approval: Synthetic routine/ }).click();
    await f.page.getByText('Waiting for parent approval', { exact: true }).waitFor();
    const call = f.state.calls.find(item => item.path.endsWith('/completion'));
    assert.equal(call.body.expectedVersion, 3); assert.equal(call.body.completed, true); assert.ok(call.body.mutationId);
    assert.equal(await f.page.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
    assert.equal(await f.page.getByRole('button', { name: 'Task breaks' }).count(), 0);
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), 390);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('parent creates an advanced one-off routine, approves work, and creates an inclusive holiday range', { skip: !base }, async () => {
  const f = await fixture();
  try {
    f.state.occurrence.status = 'submitted'; f.state.occurrence.completion.completed = true;
    await f.open();
    await f.page.getByRole('button', { name: '+ Add a task', exact: true }).click();
    await f.page.getByLabel('Task', { exact: true }).fill('Fixture one-off');
    await f.page.getByLabel('Schedule', { exact: true }).selectOption('one_off');
    await f.page.getByLabel('One-off date').fill('2026-10-24');
    await f.page.getByLabel('Required for daily rewards').uncheck();
    await f.page.getByLabel('A parent must approve completion').check();
    await f.page.getByText('Instructions & checklist', { exact: true }).click();
    await f.page.getByLabel('Instructions', { exact: true }).fill('Read these fixture steps.');
    await f.page.getByLabel('Steps · one per line, up to 20').fill('First step\nSecond step');
    await f.page.getByRole('button', { name: 'Save task', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    const routine = f.state.calls.find(item => item.path === '/api/chores' && item.method === 'POST').body;
    assert.equal(routine.scheduleType, 'one_off'); assert.equal(routine.scheduledDate, '2026-10-24');
    assert.equal(routine.required, false); assert.equal(routine.requiresApproval, true); assert.equal(routine.subtasks.length, 2);
    await f.page.getByRole('button', { name: /Waiting for approval ·/ }).click();
    await f.page.getByRole('button', { name: 'Review work', exact: true }).click();
    await f.page.getByRole('button', { name: 'Approve', exact: true }).click();
    await f.page.getByRole('dialog').getByRole('button', { name: 'Approve task', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    assert.equal(f.state.occurrence.status, 'completed');
    await f.page.getByText('History and schedule tools', { exact: true }).click();
    await f.page.getByRole('button', { name: 'Task breaks', exact: true }).click();
    await f.page.getByLabel('First day').fill('2026-10-24'); await f.page.getByLabel('Last day (included)').fill('2026-10-26');
    await f.page.getByLabel('Reason', { exact: true }).fill('Synthetic school holiday');
    await f.page.getByRole('button', { name: 'Add task break', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    const holiday = f.state.calls.find(item => item.path === '/api/chore-exceptions' && item.method === 'POST').body;
    assert.equal(holiday.toDateExclusive, '2026-10-27'); assert.ok(holiday.mutationId);
    await f.page.getByRole('button', { name: 'Task history', exact: true }).click();
    await f.page.getByRole('heading', { name: 'Task history', exact: true }).waitFor();
    assert.ok(await f.page.getByText('submitted', { exact: false }).count() > 0);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('account Activity can mark read and notification settings submit account-scoped preferences', { skip: !base }, async () => {
  const f = await fixture({ width: 390 });
  try {
    await f.open('activity');
    await f.page.getByText('Task ready for approval', { exact: true }).waitFor();
    await f.page.getByRole('button', { name: 'Mark read', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('.activity-item.unread')); assert.equal(f.state.notificationRead, true);
    await f.page.getByRole('link', { name: 'Settings', exact: true }).click();
    await f.page.locator('[data-action="settings-section"][data-id="notifications"]').click();
    await f.page.getByRole('button', { name: 'Notification preferences', exact: true }).click();
    await f.page.getByLabel('Enable quiet hours').check();
    await f.page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    const body = f.state.calls.find(item => item.path === '/api/notification-preferences' && item.method === 'PUT').body;
    assert.equal(body.quietStart, '21:00'); assert.equal(body.quietEnd, '07:00'); assert.equal(body.rewards, true);
    assert.equal(Object.hasOwn(body, 'timezone'), false);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('frame approval lives only in memory and the private header, with timed locking', { skip: !base }, async () => {
  const f = await fixture({ frame: true });
  try {
    await f.open('setup');
    await f.page.getByRole('button', { name: 'Enter unlock code', exact: true }).click();
    await f.page.getByLabel('Unlock code', { exact: true }).fill('123456');
    await f.page.getByRole('button', { name: 'Unlock controls', exact: true }).click();
    await f.page.getByText('Parent controls unlocked', { exact: true }).waitFor();
    assert.ok(f.state.calls.some(call => call.path === '/api/household' && call.headers['x-family-authorization'] === 'fixture-private-grant'));
    assert.equal((await f.page.locator('body').innerText()).includes('fixture-private-grant'), false);
    assert.deepEqual(await f.page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
    await f.page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await f.page.getByRole('button', { name: '+ Add a task', exact: true }).click();
    await f.page.getByLabel('Task', { exact: true }).fill('Private unsaved routine');
    await f.page.clock.runFor(4000);
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    assert.equal(await f.page.getByLabel('Task', { exact: true }).count(), 0);
    await f.page.getByRole('link', { name: 'Settings', exact: true }).click();
    await f.page.getByRole('button', { name: 'Enter unlock code', exact: true }).waitFor();
    const households = f.state.calls.filter(call => call.path === '/api/household');
    assert.equal(households.at(-1).headers['x-family-authorization'], undefined);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('recovery uses a recovery-only proof and clears secrets without following the link', { skip: !base }, async () => {
  const f = await fixture({ signedOut: true, width: 390 });
  try {
    await f.open();
    await f.page.getByRole('button', { name: 'Forgot your password?', exact: true }).click();
    await f.page.getByLabel('Account email', { exact: true }).fill('fixture@example.invalid');
    await f.page.getByRole('button', { name: 'Send recovery email', exact: true }).click();
    await f.page.getByRole('heading', { name: 'Choose a new password.', exact: true }).waitFor();
    const link = 'https://fixture.supabase.invalid/auth/v1/verify?token=fixture-proof&type=recovery';
    await f.page.getByLabel('Or full recovery link').fill(link);
    await f.page.getByLabel('New password', { exact: true }).fill('fixture-long-password');
    await f.page.getByLabel('Confirm new password', { exact: true }).fill('fixture-long-password');
    await f.page.getByRole('button', { name: 'Reset password', exact: true }).click();
    await f.page.getByRole('heading', { name: 'Your family, together.', exact: true }).waitFor();
    const body = f.state.calls.find(call => call.path === '/api/auth/reset-password').body;
    assert.deepEqual(Object.keys(body).sort(), ['password', 'recoveryLink']); assert.equal(body.recoveryLink, link);
    assert.equal(f.page.url().includes('fixture-proof'), false);
    assert.equal(await f.page.getByLabel('Password', { exact: true }).inputValue(), '');
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('task details keep checklist state in sync with the acknowledged occurrence version', { skip: !base }, async () => {
  const f = await fixture({ role: 'child', width: 390 });
  try {
    await f.open();
    await f.page.getByRole('button', { name: 'Details for Synthetic routine', exact: true }).click();
    await f.page.getByText('Instructions & 1 steps', { exact: true }).click();
    const step = f.page.getByRole('button', { name: /Prepare supplies/ });
    await step.click();
    await f.page.waitForFunction(() => document.querySelector('[data-action="occurrence-step"]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(f.state.calls.find(call => call.body?.action === 'subtasks').body.expectedVersion, 3);
    assert.equal(await f.page.locator('.occurrence-info details').getAttribute('open'), '');
    await f.page.getByRole('button', { name: 'Submit for approval', exact: true }).click();
    await f.page.getByRole('dialog').getByText('Waiting for parent approval', { exact: true }).waitFor();
    assert.equal(f.state.calls.find(call => call.path.endsWith('/completion')).body.expectedVersion, 4);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('dirty drafts retain input on cancel and navigation, and the save bar stays visible on a phone', { skip: !base }, async () => {
  const f = await fixture({ width: 390 });
  try {
    await f.open();
    await f.page.getByRole('button', { name: '+ Add a task', exact: true }).click();
    await f.page.getByLabel('Task', { exact: true }).fill('Unsaved synthetic task');
    await f.page.getByText('Instructions & checklist', { exact: true }).click();
    await f.page.getByLabel('Instructions', { exact: true }).fill('A long synthetic instruction. '.repeat(30));
    const geometry = await f.page.locator('.dialog-footer').evaluate(element => ({ top:element.getBoundingClientRect().top,bottom:element.getBoundingClientRect().bottom,height:innerHeight }));
    assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height, JSON.stringify(geometry));
    await f.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await f.page.getByText('Discard your unsaved changes?', { exact:true }).waitFor();
    await f.page.getByRole('button', { name:'Keep editing', exact:true }).click();
    assert.equal(await f.page.getByLabel('Task', { exact:true }).inputValue(), 'Unsaved synthetic task');
    // A hash change is also possible via the browser's Back button while a dialog is open.
    await f.page.evaluate(() => { location.hash = 'calendar'; });
    await f.page.getByText('Discard your unsaved changes?', { exact:true }).waitFor();
    assert.ok(f.page.url().endsWith('#chores'));
    await f.page.getByRole('button', { name:'Discard changes', exact:true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 0);
    assert.deepEqual(await f.page.evaluate(() => [Object.keys(localStorage),Object.keys(sessionStorage)]),[[],[]]);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});
