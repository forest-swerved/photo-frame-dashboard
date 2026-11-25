import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.FAMILY_UI_TEST_URL;
// Optional: FAMILY_UI_SHOTS=<directory> saves screenshots for a visual check.
const shot = (page, name) => process.env.FAMILY_UI_SHOTS ? page.screenshot({ path: `${process.env.FAMILY_UI_SHOTS}/${name}.png` }) : null;

// A paired frame with two synthetic children. Noon household time; the alarm task was due at 11:30.
async function fixture({ credits = 9, alarm = false } = {}) {
  const origin = new URL(base); assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date('2026-10-17T18:00:00Z') });
  const home = { id: 'fixture-home', title: 'Synthetic household', timezone: 'America/Denver' };
  const people = [{ id: 'kid-a', name: 'Kid A', color: '#00748c', version: 1, pinConfigured: true }, { id: 'kid-b', name: 'Kid B', color: '#8a00c4', version: 1, pinConfigured: false }];
  const device = { id: 'fixture-device', name: 'Synthetic tablet', kind: 'tablet', personIds: ['kid-a'], version: 1, controlState: 'ready', online: true, defaultAccess: 'blocked', desiredAccess: 'blocked', observedAccess: 'blocked', accessVerifiedAt: '2026-10-17T17:00:00Z', accessPending: false, rewardAvailable: true };
  const credit = n => ({ id: `credit-${n}`, personId: 'kid-a', minutes: 60, earnedDate: `2026-10-${String(n + 1).padStart(2, '0')}`, expiresAt: `2026-11-${String(20 - n).padStart(2, '0')}T07:00:00Z`, status: 'available', policyVersion: 1, useOrLose: false });
  const task = (id, personId, extra = {}) => ({ id, choreId: `routine-${id}`, title: 'Ordinary task', personId, personName: personId, date: '2026-10-17', originalDate: '2026-10-17', definitionSource: 'routine', schoolDayFilter: 'any', taskSection: 'tasks', required: true, status: 'pending', requiresApproval: false, version: 1, subtasks: [], instructions: '', dueTime: null, reminderMinutes: 0, alarm: false, alarmSnoozedUntil: null, completion: { date: '2026-10-17', completed: false, version: 0 }, ...extra });
  const state = { calls: [], errors: [], sessions: [], credits: Array.from({ length: credits }, (_, n) => credit(n)), pinFailures: 0,
    tasks: [task('task-a', 'kid-a'), task('task-b', 'kid-b'), ...(alarm ? [task('alarm-task', 'kid-a', { title: 'Synthetic alarm task', required: false, dueTime: '11:30', alarm: true })] : [])] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method(), path = url.pathname;
    if (path === '/api/live-status') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {} }) }); return; }
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? req.postDataJSON() : null, grant = req.headers()['x-family-authorization'] || null;
    state.calls.push({ path, method, body, grant });
    const child = grant === 'kid-a-grant';
    const fail = (status, code, message) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, message } }) });
    let data;
    if (path === '/api/session') data = { authenticated: true, authType: 'frame', role: child ? 'child' : 'frame', personId: child ? 'kid-a' : null, household: home, user: { id: 'frame-device', name: 'Synthetic frame' } };
    else if (path === '/api/household') data = { household: home, role: child ? 'child' : 'frame', date: '2026-10-17', people: child ? people.slice(0, 1) : people, chores: [], routines: [], occurrences: state.tasks.filter(item => !child || item.personId === 'kid-a'), schoolDay: { type: 'non_school_day', date: '2026-10-17' }, capabilities: { manageChores: false, manageInternet: false } };
    else if (path === '/api/internet') data = { serverTime: new Date(await page.evaluate(() => Date.now())).toISOString(), timezone: home.timezone, role: child ? 'child' : 'frame', savedCapMinutes: 600, capabilities: { manageInternet: false, manageChores: false },
      integration: { state: 'ready', scheduleSupport: { overnight: true, allDay: true } }, devices: [{ ...device, rewardAvailable: !state.sessions.length }], sessions: state.sessions,
      policies: people.map(p => ({ personId: p.id, version: 1, enabled: true, rewardMinutes: 60, carryoverDays: 30, dailyLimitMinutes: 180, bedtime: null, warningMinutes: 5 })),
      credits: state.credits.filter(item => !child || item.personId === 'kid-a'), requests: [],
      progress: people.map(p => ({ personId: p.id, date: '2026-10-17', eligible: !!state.earnedToday && p.id === 'kid-a', requiredCount: 1, completedCount: state.earnedToday && p.id === 'kid-a' ? 1 : 0, remainingCount: state.earnedToday && p.id === 'kid-a' ? 0 : 1, pendingApprovalCount: 0, occurrenceIds: [] })) };
    else if (path === '/api/frame-access/child-pin') {
      assert.equal(grant, null, 'A keypad entry is never sent with an existing grant.');
      if (body.personId !== 'kid-a' || body.pin !== '4821') { state.pinFailures++; await fail(403, 'invalid_child_pin', 'That PIN is not right. Try again.'); return; }
      data = { token: 'kid-a-grant', scope: 'child', personId: 'kid-a', expiresAt: '2026-10-17T18:30:00Z' };
    }
    else if (path === '/api/internet/redeem') { data = { id: 'fixture-session', personId: 'kid-a', deviceId: device.id, creditId: body.creditId, source: 'reward', state: 'starting', version: 1, desiredState: 'allowed', observedState: 'blocked', requestedAt: '2026-10-17T18:00:00Z', verifiedAt: null, startedAt: null, endsAt: null, remainingSeconds: 3900, allDay: false }; state.sessions = [data]; state.credits = state.credits.map(item => item.id === body.creditId ? { ...item, status: 'reserved' } : item); }
    else if (path === '/api/chore-occurrences/alarm-task/alarm-snooze') { const item = state.tasks.find(t => t.id === 'alarm-task'); item.alarmSnoozedUntil = new Date(await page.evaluate(() => Date.now()) + 600_000).toISOString(); data = item; }
    else if (path === '/api/chore-occurrences/alarm-task/completion') {
      if (!child) { await fail(409, 'child_pin_required', 'Kid A confirms this alarm with their own PIN.'); return; }
      const item = state.tasks.find(t => t.id === 'alarm-task'); Object.assign(item, { status: 'completed', version: 2, completion: { date: '2026-10-17', completed: true, version: 1 } }); data = item;
    }
    else if (path === '/api/calendar') data = { status: 'not_configured', events: [] };
    else if (path === '/api/locations') data = { parents: [] };
    else if (path === '/api/media') data = { media: [] };
    else throw new Error(`Missing synthetic route ${method} ${path}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  const pin = async digits => { for (const digit of digits) await page.locator(`.parent-keypad [data-pin-key="${digit}"]`).click(); };
  return { browser, page, state, pin, credit, async open() {
    await page.goto(new URL('/family.html?display=frame#today', origin).href);
    await page.locator('.frame-person-card').first().waitFor();
    await page.locator('.time-bank-balance').first().waitFor();
  } };
}

test('a child sees saved time on the frame and spends it with their own PIN in a few taps', { skip: !base }, async () => {
  const f = await fixture();
  try {
    await f.open();
    const bank = f.page.locator('[data-person-id="kid-a"] .time-bank');
    assert.equal((await bank.locator('.time-bank-balance strong').textContent()).trim(), '9 h');
    assert.match(await bank.textContent(), /saved of 10 h/);
    assert.equal(await bank.getByRole('progressbar').getAttribute('aria-valuenow'), '540');
    // A child with nothing saved sees how to earn it, not a dead button.
    const empty = f.page.locator('[data-person-id="kid-b"] .time-bank');
    assert.match(await empty.textContent(), /0 min.*Finish today’s tasks to earn 1 h/s); assert.equal(await empty.getByRole('button').count(), 0);
    await shot(f.page, 'time-bank');
    await bank.getByRole('button', { name: 'Use time', exact: true }).click();
    const keypad = f.page.locator('.parent-keypad');
    await keypad.getByRole('heading', { name: 'Enter your PIN', exact: true }).waitFor();
    assert.match(await keypad.locator('.eyebrow').textContent(), /Kid A/);
    await shot(f.page, 'child-keypad');
    await f.pin('0000'); // The fourth digit submits by itself.
    await keypad.getByText('That PIN is not right. Try again.', { exact: true }).waitFor();
    await f.pin('4821');
    await f.page.getByRole('heading', { name: 'Choose one device · 60 minutes', exact: true }).waitFor();
    assert.equal(await f.page.locator('input[name="deviceId"]').isChecked(), true, 'The only device is already chosen.');
    await f.page.getByRole('button', { name: 'Start reward', exact: true }).click();
    await f.page.locator('[data-person-id="kid-b"]').waitFor(); // Locked again: the whole family is back.
    const redeem = f.state.calls.find(call => call.path === '/api/internet/redeem');
    assert.equal(redeem.body.creditId, 'credit-8', 'The soonest-expiring hour is spent first.'); assert.equal(redeem.grant, 'kid-a-grant');
    const after = f.state.calls.slice(f.state.calls.indexOf(redeem) + 1).filter(call => call.path === '/api/household');
    assert.ok(after.length && after.every(call => call.grant === null), 'The PIN unlock ends after the choice.');
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('a reward earned with ten hours saved says it is use it or lose it', { skip: !base }, async () => {
  const f = await fixture({ credits: 10 });
  try {
    await f.open();
    const bank = f.page.locator('[data-person-id="kid-a"] .time-bank');
    assert.match(await bank.textContent(), /10 h.*full \(10 h max\)/s);
    f.state.earnedToday = true;
    f.state.credits.push({ ...f.credit(16), id: 'today-credit', earnedDate: '2026-10-17', expiresAt: '2026-10-18T06:00:00Z', useOrLose: true });
    await f.page.clock.fastForward(21_000);
    await f.page.getByRole('heading', { name: 'Great job, Kid A!', exact: true }).waitFor();
    await shot(f.page, 'use-or-lose');
    const text = await f.page.locator('.reward-celebration').textContent();
    assert.match(text, /1 h earned/); assert.match(text, /maxed out how much time you can save \(10 h\)/); assert.match(text, /use it or lose it/);
    assert.equal(await f.page.getByRole('button', { name: 'Save for later', exact: true }).count(), 0);
    await f.page.getByRole('button', { name: 'Not now', exact: true }).click();
    await bank.getByText('+ 1 h to use today or lose', { exact: true }).waitFor();
    assert.equal((await bank.locator('.time-bank-balance strong').textContent()).trim(), '10 h');
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('a task alarm takes over the frame until the child confirms it; snooze lasts ten minutes', { skip: !base }, async () => {
  const f = await fixture({ alarm: true });
  try {
    await f.open();
    const alarm = f.page.locator('dialog.task-alarm');
    await alarm.getByRole('heading', { name: 'Synthetic alarm task', exact: true }).waitFor();
    await shot(f.page, 'alarm');
    assert.match(await alarm.locator('.eyebrow').textContent(), /Kid A · 11:30/);
    assert.deepEqual(await alarm.getByRole('button').allTextContents(), ['Done', 'Snooze 10 minutes'], 'There is no dismiss control.');
    await f.page.keyboard.press('Escape'); assert.equal(await alarm.isVisible(), true);
    await alarm.getByRole('button', { name: 'Snooze 10 minutes', exact: true }).click();
    await alarm.waitFor({ state: 'detached' });
    await f.page.clock.fastForward(9 * 60_000); assert.equal(await alarm.count(), 0);
    await f.page.clock.fastForward(61_000);
    await alarm.getByRole('heading', { name: 'Synthetic alarm task', exact: true }).waitFor();
    // Done asks for the child's own PIN, then confirms the task and locks the frame again.
    await alarm.getByRole('button', { name: 'Done', exact: true }).click();
    await f.page.locator('.parent-keypad').getByRole('heading', { name: 'Enter your PIN', exact: true }).waitFor();
    await f.pin('4821');
    await alarm.waitFor({ state: 'detached' });
    const done = f.state.calls.find(call => call.path.endsWith('/alarm-task/completion'));
    assert.equal(done.body.completed, true); assert.equal(done.grant, 'kid-a-grant');
    await f.page.locator('[data-person-id="kid-b"]').waitFor();
    await f.page.clock.fastForward(30_000); assert.equal(await alarm.count(), 0);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});
