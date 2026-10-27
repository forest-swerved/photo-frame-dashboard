import test from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.FAMILY_UI_TEST_URL;
async function fixture({ role = 'admin', frame = false, ready = true, width = 390, unclaimed = false } = {}) {
  const origin = new URL(base); assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
  page.setDefaultTimeout(8000);
  await page.clock.install({ time: new Date('2026-10-17T18:00:00Z') });
  const home = { id: 'fixture-home', title: 'Synthetic household', timezone: 'America/Denver' };
  const person = { id: 'fixture-child', name: 'Synthetic child', color: '#00748c' };
  const device = { id: 'fixture-device', name: 'Synthetic console', kind: 'console', personIds: [person.id], version: 4, controlState: ready ? 'ready' : 'unenrolled', online: true, macAddresses: ['02:00:00:00:00:01'], allowApplePush: false, defaultAccess: 'blocked', desiredAccess: 'blocked', observedAccess: ready ? 'blocked' : 'unknown', accessVerifiedAt: ready ? '2026-10-17T18:00:00Z' : null, accessPending: false, rewardAvailable: ready };
  const credit = { id: 'fixture-credit', personId: person.id, minutes: 60, earnedDate: '2026-10-17', expiresAt: '2026-10-25T06:00:00Z', status: 'available', policyVersion: 1 };
  const state = { devices: [device], calls: [], errors: [], grant: null, sessions: [], credits: [credit], deleted: false, deleteGuard: false, complete: false, failRedeem: false };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? req.postDataJSON() : null;
    state.calls.push({ path: url.pathname, method, body, headers: req.headers() });
    let data, status = 200;
    const activeRole = frame ? state.grant && req.headers()['x-family-authorization'] === 'fixture-child-grant' ? 'child' : 'frame' : role;
    const childIdentity = activeRole === 'child' ? person.id : null;
    const occurrence = { id: 'fixture-occurrence', choreId: 'fixture-routine', title: 'Synthetic last chore', personId: person.id, date: '2026-10-17', originalDate: '2026-10-17', status: state.complete ? 'completed' : 'pending', required: true, version: state.complete ? 2 : 1, subtasks: [], completion: { date: '2026-10-17', completed: state.complete, version: 0 } };
    if (url.pathname === '/api/session') data = { authType: frame ? 'frame' : 'user', role: activeRole, personId: childIdentity, household: unclaimed || state.deleted ? null : home, user: { id: 'fixture-user', name: 'Synthetic account', email: 'fixture@example.invalid' } };
    else if (url.pathname === '/api/auth/get-session') data = { session: { expiresAt: '2099-01-01T00:00:00Z' } };
    else if (url.pathname === '/api/auth/token') data = { token: 'fixture.transient.token' };
    else if (url.pathname === '/api/household') data = { household: home, role: activeRole, date: occurrence.date, people: [person], chores: [], routines: [], occurrences: [occurrence], capabilities: { manageChores: activeRole === 'admin', manageInternet: activeRole === 'admin' } };
    else if (url.pathname === '/api/calendar') data = { status: 'not_configured', events: [] };
    else if (url.pathname === '/api/calendar/connection') data = { connected: false, calendars: [] };
    else if (url.pathname === '/api/devices') data = { devices: [] };
    else if (url.pathname === '/api/members') data = { members: [{ id: 'fixture-adult', role: 'member', name: 'Synthetic adult' }] };
    else if (url.pathname === '/api/internet') data = { serverTime: '2026-10-17T18:00:00Z', timezone: home.timezone, role: activeRole, capabilities: { manageInternet: activeRole === 'admin' }, integration: { state: ready ? 'ready' : 'pilot_required' }, devices: state.devices.map(item => ({ ...item, ...(activeRole === 'admin' ? {} : { macAddresses: undefined }) })), sessions: state.sessions, policies: [{ personId: person.id, version: 1, enabled: true, rewardMinutes: 60, carryoverDays: 7, dailyLimitMinutes: 180, warningMinutes: 5, bedtime: '21:00' }], credits: state.credits, progress: [{ personId: person.id, requiredCount: 1, completedCount: state.complete ? 1 : 0, pendingApprovalCount: 0 }] };
    else if (url.pathname.endsWith('/completion')) { state.complete = true; data = { ...occurrence, status: 'completed', version: 2 }; }
    else if (url.pathname === '/api/internet/redeem' || url.pathname === '/api/internet/grants') {
      if (state.failRedeem) { await route.abort('failed'); return; }
      data = { id: 'fixture-session', personId: body.personId || person.id, deviceId: device.id, creditId: body.creditId || null, source: body.creditId ? 'reward' : 'parent', state: 'starting', version: 1, desiredState: 'allowed', observedState: 'blocked', requestedAt: '2026-10-17T18:00:00Z', verifiedAt: '2026-10-17T17:59:00Z', startedAt: null, endsAt: body.allDay ? '2026-10-18T06:00:00Z' : null, remainingSeconds: body.allDay ? 43200 : 3600, allDay: body.allDay || false }; state.sessions = [data]; if (body.creditId) credit.status = 'reserved'; status = 202;
    } else if (url.pathname.endsWith('/actions')) { const item = state.sessions[0]; data = { ...item, state: body.action === 'pause' ? 'pausing' : body.action === 'resume' ? 'resuming' : body.action === 'end' ? 'ending' : 'adjusting', version: item.version + 1 }; state.sessions = [data]; }
    else if (url.pathname === '/api/internet/history') data = { history: [{ id: 'fixture-history', personId: person.id, deviceId: device.id, type: 'session_requested', reason: 'Synthetic weekend', createdAt: '2026-10-17T18:00:00Z' }] };
    else if (url.pathname.includes('/api/internet/policies/')) data = { personId: person.id, version: 2, ...body };
    else if (url.pathname.endsWith('/access')) { Object.assign(device, { version: device.version + 1, desiredAccess: body.access, observedAccess: 'unknown', accessPending: true, rewardAvailable: false }); data = device; status = 202; }
    else if (url.pathname.endsWith('/resolve')) { credit.status = body.action === 'restore' ? 'available' : 'spent'; data = credit; }
    else if (url.pathname === '/api/internet/devices') data = { ...body, id: 'fixture-new-device', version: 1, controlState: 'unenrolled' };
    else if (url.pathname === '/api/frame-access/redeem') { state.grant = true; data = { token: 'fixture-child-grant', scope: 'child', personId: person.id, expiresAt: '2026-10-17T18:10:00Z' }; }
    else if (url.pathname === '/api/account/delete') {
      if (state.deleteGuard) { await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ownership_transfer_required', message: 'Transfer ownership first.' } }) }); return; }
      state.deleted = true; data = { deleted: true };
    } else if (url.pathname === '/api/account/transfer-ownership') data = { transferred: true, userId: body.userId };
    else if (url.pathname.startsWith('/api/auth/')) data = { success: true };
    else if (url.pathname === '/api/notifications') data = { notifications: [] };
    else throw new Error(`Missing synthetic route ${method} ${url.pathname}`);
    const payload = JSON.stringify(url.pathname.startsWith('/api/auth/') ? data : { data });
    if (url.pathname === '/api/internet' && state.deferNextRead) { state.deferNextRead = false; await new Promise(resolve => { state.releaseRead = resolve; }); }
    if (url.pathname === '/api/internet/devices' && method === 'POST' && state.deferDeviceSave) { state.deferDeviceSave = false; await new Promise(resolve => { state.releaseDeviceSave = resolve; }); }
    await route.fulfill({ status, contentType: 'application/json', body: payload });
  });
  return { browser, page, state, device, credit, async open(view = 'devices') {
    await page.goto(new URL(`/family.html${frame ? '?display=frame' : ''}#${view}`, origin).href);
    await page.getByRole('heading', { name: unclaimed ? 'A place for your family.' : view === 'setup' ? 'Settings' : view === 'chores' ? (role === 'child' ? 'My tasks' : 'Tasks') : view[0].toUpperCase() + view.slice(1), exact: true, level: 1 }).waitFor();
  } };
}

test('inactive controls remain honest, inventory is editable, and Apple push exception is explicit', { skip: !base }, async () => {
  const f = await fixture({ ready: false });
  try {
    await f.open(); await f.page.getByText('Not enrolled · Internet blocking not configured', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Grant Internet time', exact: true }).isDisabled(), true);
    if (process.env.FAMILY_UI_SCREENSHOT_DIR) await f.page.screenshot({ path: `${process.env.FAMILY_UI_SCREENSHOT_DIR}/devices-phone.png`, fullPage: true });
    await f.page.getByRole('button', { name: '+ Add a device', exact: true }).click();
    await f.page.getByLabel('Device name').fill('Synthetic tablet'); await f.page.getByLabel('Device type', { exact: true }).selectOption('tablet');
    await f.page.getByLabel('Synthetic child', { exact: true }).check();
    await f.page.getByLabel('Stable MAC addresses · one per line').fill('02:00:00:00:00:02');
    assert.equal(await f.page.getByLabel('Keep Apple notifications available').isChecked(), true);
    await f.page.getByRole('button', { name: 'Save device', exact: true }).click(); await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    const body = f.state.calls.find(call => call.path === '/api/internet/devices' && call.method === 'POST').body;
    assert.equal(body.allowApplePush, true); assert.ok(body.mutationId); assert.deepEqual(body.personIds, ['fixture-child']);
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), 390); assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('child completes last chore, saves credit, then selects one device for a confirmed request', { skip: !base }, async () => {
  const f = await fixture({ role: 'child' });
  try {
    f.state.credits.length = 0;
    await f.open('chores'); f.state.credits.push(f.credit);
    await f.page.getByRole('button', { name: 'Complete Synthetic last chore', exact: true }).click();
    await f.page.getByRole('heading', { name: 'Great job, Synthetic child!', exact: true }).waitFor();
    await f.page.getByRole('button', { name: 'Save for later', exact: true }).click();
    assert.equal(f.state.calls.filter(call => call.path === '/api/internet/redeem').length, 0);
    await f.page.getByRole('link', { name: 'Devices', exact: true }).click();
    await f.page.getByRole('button', { name: 'Use reward', exact: true }).click();
    await f.page.getByRole('radio', { name: /Synthetic console/ }).check();
    await f.page.getByRole('button', { name: 'Start reward', exact: true }).click();
    await f.page.getByText('Starting · awaiting network confirmation', { exact: true }).waitFor();
    await f.page.getByText(/Internet last confirmed blocked/).waitFor();
    const calls = f.state.calls.filter(call => call.path === '/api/internet/redeem'); assert.equal(calls.length, 1); assert.equal(calls[0].body.deviceId, 'fixture-device'); assert.ok(calls[0].body.mutationId);
    assert.equal(await f.page.getByRole('button', { name: /Grant Internet time|End now|Reward settings/ }).count(), 0); assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('bare frame needs a child-scoped code before reward spending; private grant stays in memory', { skip: !base }, async () => {
  const f = await fixture({ frame: true, width: 1280 });
  try {
    await f.open(); await f.page.getByRole('button', { name: 'Unlock to use', exact: true }).click();
    await f.page.getByLabel('Unlock code', { exact: true }).fill('123456');
    assert.equal(f.state.calls.filter(call => call.path === '/api/internet/redeem').length, 0);
    await f.page.getByRole('button', { name: 'Unlock controls', exact: true }).click();
    await f.page.getByRole('heading', { name: 'Choose one device · 60 minutes', exact: true }).waitFor();
    await f.page.getByRole('radio', { name: /Synthetic console/ }).check(); await f.page.getByRole('button', { name: 'Start reward', exact: true }).click();
    await f.page.getByText('Starting · awaiting network confirmation', { exact: true }).waitFor();
    if (process.env.FAMILY_UI_SCREENSHOT_DIR) { await f.page.evaluate(() => { document.querySelector('.main-content').scrollTop = 0; }); await f.page.screenshot({ path: `${process.env.FAMILY_UI_SCREENSHOT_DIR}/devices-frame.png`, fullPage: true }); }
    assert.equal(f.state.calls.find(call => call.path === '/api/internet/redeem').headers['x-family-authorization'], 'fixture-child-grant');
    assert.deepEqual(await f.page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
    assert.equal(await f.page.getByRole('button', { name: '+ Add a device', exact: true }).count(), 0); assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), 1280); assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('parents grant all-day time, inspect local countdown, and issue CAS pause without inventing a block', { skip: !base }, async () => {
  const f = await fixture({ width: 1280 });
  try {
    await f.open(); await f.page.getByRole('button', { name: 'Grant Internet time', exact: true }).click();
    await f.page.getByLabel('All day', { exact: true }).check(); await f.page.getByRole('button', { name: 'Request access window', exact: true }).click();
    await f.page.getByText('Starting · awaiting network confirmation · All day', { exact: true }).waitFor();
    const grant = f.state.calls.find(call => call.path === '/api/internet/grants').body; assert.equal(grant.allDay, true); assert.equal(Object.hasOwn(grant, 'minutes'), false);
    f.state.sessions[0] = { ...f.state.sessions[0], state: 'active', version: 2, observedState: 'allowed', startedAt: '2026-10-17T18:00:00Z', endsAt: '2026-10-17T18:02:00Z' };
    await f.page.getByRole('button', { name: 'Refresh status', exact: true }).click(); await f.page.getByText('2:00', { exact: true }).waitFor();
    if (process.env.FAMILY_UI_SCREENSHOT_DIR) await f.page.screenshot({ path: `${process.env.FAMILY_UI_SCREENSHOT_DIR}/devices-desktop.png`, fullPage: true });
    const reads = f.state.calls.filter(call => call.path === '/api/internet').length;
    await f.page.clock.runFor(2000); assert.match(await f.page.locator('[data-session-remaining]').innerText(), /^1:5[89]$/); assert.equal(f.state.calls.filter(call => call.path === '/api/internet').length, reads);
    await f.page.getByRole('button', { name: 'Pause', exact: true }).click(); await f.page.getByText('Pausing · checking block · All day', { exact: true }).waitFor();
    await f.page.getByText(/Internet last confirmed allowed/).waitFor(); assert.equal(await f.page.getByRole('button', { name: 'Resume', exact: true }).count(), 0);
    const action = f.state.calls.find(call => call.path.endsWith('/actions')).body; assert.equal(action.expectedVersion, 2); assert.equal(action.action, 'pause'); assert.ok(action.mutationId); assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('uncertain reward response disables repeat submission until reviewed', { skip: !base }, async () => {
  const f = await fixture({ role: 'child' });
  try {
    await f.open(); f.state.failRedeem = true; await f.page.getByRole('button', { name: 'Use reward', exact: true }).click();
    await f.page.getByRole('radio', { name: /Synthetic console/ }).check(); await f.page.getByRole('button', { name: 'Start reward', exact: true }).click();
    await f.page.getByRole('dialog').getByText('Cannot reach the dashboard. Check your connection and try again.', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Close and review before retrying', exact: true }).isDisabled(), true); assert.equal(f.state.calls.filter(call => call.path === '/api/internet/redeem').length, 1);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('account deletion requires typed confirmation, clears secrets and local state on synthetic success', { skip: !base }, async () => {
  const f = await fixture();
  try {
    await f.open('setup');
    await f.page.locator('[data-action="settings-section"][data-id="account"]').click(); await f.page.getByRole('button', { name: 'Delete my account', exact: true }).click();
    await f.page.getByLabel('Current password', { exact: true }).fill('fixture-long-password'); await f.page.getByLabel('Type DELETE MY ACCOUNT to confirm').fill('DELETE MY ACCOUNT');
    await f.page.getByRole('button', { name: 'Permanently delete my account', exact: true }).click(); await f.page.getByText('Your account has been deleted.', { exact: true }).waitFor();
    const body = f.state.calls.find(call => call.path === '/api/account/delete').body; assert.deepEqual(body, { password: 'fixture-long-password', confirmation: 'DELETE MY ACCOUNT' });
    assert.equal(await f.page.getByLabel('Current password', { exact: true }).count(), 0); assert.equal(await f.page.getByRole('link', { name: 'Devices', exact: true }).count(), 0); assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('unclaimed signed-in account can retry deletion and parent ownership transfer selects an existing adult', { skip: !base }, async () => {
  const f = await fixture({ unclaimed: true });
  try { await f.open(); await f.page.getByRole('button', { name: 'Delete my account', exact: true }).click(); await f.page.getByLabel('Current password', { exact: true }).waitFor(); assert.deepEqual(f.state.errors, []); }
  finally { await f.browser.close(); }
  const parent = await fixture();
  try {
    await parent.open('setup'); await parent.page.locator('[data-action="settings-section"][data-id="account"]').click(); await parent.page.getByRole('button', { name: 'Transfer household ownership', exact: true }).click();
    await parent.page.getByLabel('New administrator', { exact: true }).selectOption('fixture-adult'); await parent.page.getByLabel('Type TRANSFER to confirm').fill('TRANSFER'); await parent.page.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
    await parent.page.waitForFunction(() => !document.querySelector('dialog').open); assert.deepEqual(parent.state.calls.find(call => call.path === '/api/account/transfer-ownership').body, { userId: 'fixture-adult' }); assert.deepEqual(parent.state.errors, []);
  } finally { await parent.browser.close(); }
});


test('parents edit future reward policy, review uncertain credit with a reason, and inspect history', { skip: !base }, async () => {
  const f = await fixture();
  try {
    f.credit.status = 'review'; await f.open();
    await f.page.getByRole('button', { name: 'Reward settings', exact: true }).click();
    await f.page.getByRole('button', { name: 'Synthetic child · 60 minutes', exact: true }).click();
    await f.page.getByLabel('Reward minutes', { exact: true }).fill('90');
    await f.page.getByLabel('Bedtime cutoff (optional)', { exact: true }).fill('20:30');
    await f.page.getByRole('button', { name: 'Save reward settings', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    const policy = f.state.calls.find(call => call.path.includes('/api/internet/policies/')).body;
    assert.equal(policy.expectedVersion, 1); assert.equal(policy.rewardMinutes, 90); assert.equal(policy.bedtime, '20:30');
    assert.equal(Object.hasOwn(policy, 'mutationId'), false);
    await f.page.getByRole('button', { name: 'Review allowance', exact: true }).click();
    await f.page.getByLabel('Reason', { exact: true }).fill('Checked synthetic session evidence');
    await f.page.getByRole('button', { name: 'Record resolution', exact: true }).click();
    await f.page.waitForFunction(() => !document.querySelector('dialog').open);
    const resolution = f.state.calls.find(call => call.path.endsWith('/resolve')).body;
    assert.equal(resolution.action, 'restore'); assert.ok(resolution.mutationId); assert.equal(f.credit.status, 'available');
    await f.page.getByRole('button', { name: 'Internet history', exact: true }).click();
    await f.page.getByRole('heading', { name: 'Internet time history', exact: true }).waitFor();
    await f.page.getByText('Synthetic weekend', { exact: true }).waitFor();
    await f.page.getByLabel('From date (optional)', { exact:true }).fill('2026-10-18');
    await f.page.getByRole('button', { name:'Filter history', exact:true }).click();
    await f.page.getByText('No Internet time changes in this selection.', { exact:true }).waitFor();
    await f.page.getByLabel('From date (optional)', { exact:true }).fill('2026-10-17');
    await f.page.getByRole('button', { name:'Filter history', exact:true }).click();
    await f.page.getByText('Synthetic weekend', { exact:true }).waitFor();
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('ownership guard keeps account signed in and directs a parent to transfer ownership', { skip: !base }, async () => {
  const f = await fixture();
  try {
    f.state.deleteGuard = true; await f.open('setup');
    await f.page.locator('[data-action="settings-section"][data-id="account"]').click(); await f.page.getByRole('button', { name: 'Delete my account', exact: true }).click();
    await f.page.getByLabel('Current password', { exact: true }).fill('fixture-long-password'); await f.page.getByLabel('Type DELETE MY ACCOUNT to confirm').fill('DELETE MY ACCOUNT');
    await f.page.getByRole('button', { name: 'Permanently delete my account', exact: true }).click();
    await f.page.getByText('Transfer ownership to another adult from Setup, then delete your account.', { exact: true }).waitFor();
    assert.equal(await f.page.getByLabel('Current password', { exact: true }).inputValue(), '');
    assert.equal(f.state.deleted, false); assert.equal(f.state.calls.some(call => call.path === '/api/auth/sign-out'), false);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});


test('an earlier Internet read cannot undo an acknowledged pause and a trailing read reconciles state', { skip: !base }, async () => {
  const f = await fixture({ width: 1280 });
  try {
    f.state.sessions = [{ id: 'fixture-session', personId: 'fixture-child', deviceId: 'fixture-device', state: 'active', version: 5, source: 'parent', observedState: 'allowed', startedAt: '2026-10-17T18:00:00Z', endsAt: '2026-10-17T19:00:00Z', remainingSeconds: 3600 }];
    await f.open(); await f.page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    f.state.deferNextRead = true; await f.page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    while (!f.state.releaseRead) await new Promise(resolve => setTimeout(resolve, 5));
    await f.page.getByRole('button', { name: 'Pause', exact: true }).click();
    await f.page.getByText('Pausing · checking block', { exact: true }).waitFor();
    const reads = f.state.calls.filter(call => call.path === '/api/internet').length;
    f.state.releaseRead();
    while (f.state.calls.filter(call => call.path === '/api/internet').length === reads) await new Promise(resolve => setTimeout(resolve, 5));
    await f.page.getByText('Pausing · checking block', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Pause', exact: true }).count(), 0);
    assert.deepEqual(f.state.errors, []);
  } finally { f.state.releaseRead?.(); await f.browser.close(); }
});


test('late device save cannot close a newer editor or discard its typed fields', { skip: !base }, async () => {
  const f = await fixture({ ready: false });
  try {
    await f.open(); f.state.deferDeviceSave = true;
    await f.page.getByRole('button', { name: '+ Add a device', exact: true }).click();
    await f.page.getByLabel('Device name').fill('First synthetic device'); await f.page.getByLabel('Synthetic child', { exact: true }).check(); await f.page.getByLabel('Stable MAC addresses · one per line').fill('02:00:00:00:00:03');
    await f.page.getByRole('button', { name: 'Save device', exact: true }).click();
    while (!f.state.releaseDeviceSave) await new Promise(resolve => setTimeout(resolve, 5));
    await f.page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await f.page.getByRole('button', { name: '+ Add a device', exact: true }).click(); await f.page.getByLabel('Device name').fill('Unsaved second device');
    f.state.releaseDeviceSave();
    while (f.state.calls.filter(call => call.path === '/api/internet').length < 2) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(await f.page.getByLabel('Device name').inputValue(), 'Unsaved second device'); assert.equal(await f.page.getByRole('dialog').isVisible(), true); assert.deepEqual(f.state.errors, []);
  } finally { f.state.releaseDeviceSave?.(); await f.browser.close(); }
});

test('acknowledged pause stays interruptible even while the following status read is delayed', { skip: !base }, async () => {
  const f = await fixture({ width: 1280 });
  try {
    f.state.sessions = [{ id: 'fixture-session', personId: 'fixture-child', deviceId: 'fixture-device', state: 'active', version: 5, source: 'parent', observedState: 'allowed', endsAt: '2026-10-17T19:00:00Z', remainingSeconds: 3600 }];
    await f.open(); f.state.deferNextRead = true;
    await f.page.getByRole('button', { name: 'Pause', exact: true }).click();
    await f.page.getByText('Pausing · checking block', { exact: true }).waitFor();
    while (!f.state.releaseRead) await new Promise(resolve => setTimeout(resolve, 5));
    await f.page.getByText('More controls', { exact: true }).click();
    assert.equal(await f.page.getByRole('button', { name: 'End now', exact: true }).isEnabled(), true);
    await f.page.getByRole('button', { name: 'End now', exact: true }).click(); await f.page.getByRole('dialog').getByRole('button', { name: 'End now', exact: true }).click();
    await f.page.getByText('Ending · checking block', { exact: true }).waitFor();
    const actions = f.state.calls.filter(call => call.path.endsWith('/actions')); assert.equal(actions.length, 2); assert.equal(actions[1].body.action, 'end'); assert.equal(actions[1].body.expectedVersion, 6);
    f.state.releaseRead(); assert.deepEqual(f.state.errors, []);
  } finally { f.state.releaseRead?.(); await f.browser.close(); }
});


test('local wall-clock changes do not add or remove elapsed session time', { skip: !base }, async () => {
  const f = await fixture({ width: 1280 });
  try {
    f.state.sessions = [{ id: 'fixture-session', personId: 'fixture-child', deviceId: 'fixture-device', state: 'active', version: 5, source: 'parent', observedState: 'allowed', endsAt: '2026-10-17T18:02:00Z', remainingSeconds: 120 }];
    await f.open(); await f.page.getByText('2:00', { exact: true }).waitFor();
    await f.page.clock.setSystemTime(new Date('2026-10-17T19:00:00Z')); await f.page.clock.runFor(2000);
    assert.match(await f.page.locator('[data-session-remaining]').innerText(), /^1:5[89]$/);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});


test('parent device control stays pending and an uncertain On can be cut off with one tap', { skip: !base }, async () => {
  const f = await fixture();
  try {
    await f.open(); await f.page.getByRole('button', { name: 'Turn Internet on', exact: true }).click();
    await f.page.getByText('Changing Internet access · waiting for confirmation', { exact: true }).waitFor();
    await f.page.getByRole('button', { name: 'Turn Internet off', exact: true }).click();
    const calls = f.state.calls.filter(c => c.path.endsWith('/access'));
    assert.deepEqual(calls.map(c => [c.body.access, c.body.expectedVersion]), [['allowed', 4], ['blocked', 5]]);
    await f.page.getByRole('button', { name: 'Turn Internet on', exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Turn Internet on', exact: true }).isDisabled(), true);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});
test('child picker hides free devices and reservations instead of listing disabled choices', { skip: !base }, async () => {
  const f = await fixture({ role: 'child' });
  try {
    f.state.devices.push({ ...f.device, id: 'new-console', name: 'New console' }, { ...f.device, id: 'free-tv', name: 'Free TV', defaultAccess: 'allowed' }, { ...f.device, id: 'busy-ipad', name: 'Busy iPad', rewardAvailable: false });
    await f.open(); await f.page.getByRole('button', { name: 'Use reward', exact: true }).click();
    assert.equal(await f.page.getByRole('dialog').getByRole('radio').count(), 2);
    assert.equal(await f.page.getByRole('dialog').getByText('Free TV', { exact: true }).count(), 0);
    assert.equal(await f.page.getByRole('dialog').getByText('Busy iPad', { exact: true }).count(), 0);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.browser.close(); }
});

test('unavailable rewards explain device eligibility before opening a picker', { skip: !base }, async () => {
  const f = await fixture({ role:'child' });
  try {
    f.device.rewardAvailable = false;
    await f.open();
    await f.page.getByText('No earned-time device is currently available. Your reward stays saved.', { exact:true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name:'Use reward', exact:true }).isDisabled(), true);
    assert.equal(await f.page.getByRole('dialog').count(), 0);
    assert.equal(f.state.calls.filter(call => call.path === '/api/internet/redeem').length, 0);
  } finally { await f.browser.close(); }
});
