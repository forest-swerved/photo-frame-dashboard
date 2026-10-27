import { request, frameAccessStatus } from './api.js';
import { escapeHtml as h, mutationId, dateFormatter, dateInZone, addDays, dateLabel } from './model.js';

export const liveSession = session => !['ended', 'failed'].includes(session.state);
export function remainingTime(session, now) {
  if (!liveSession(session)) return null;
  const end = Date.parse(session.endsAt);
  if (session.state === 'paused' && !session.allDay) return Math.max(0, session.remainingSeconds || 0);
  if (!Number.isFinite(end)) return ['starting', 'resuming', 'paused'].includes(session.state) && Number.isFinite(session.remainingSeconds) ? Math.max(0, session.remainingSeconds) : null;
  const remaining = Math.max(0, Math.ceil((end - now) / 1000));
  return session.state === 'paused' ? Math.min(session.remainingSeconds || 0, remaining) : remaining;
}
export function remainingLabel(seconds) {
  if (seconds === null) return 'Checking time';
  if (seconds === 0) return '0:00 · checking cutoff';
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
export function canRedeem(data, credit, session, access = null) {
  return credit.status === 'available' && data?.role === 'child' && session?.personId === credit.personId
    && (session.authType !== 'frame' || access?.scope === 'child' && access.personId === credit.personId);
}

export function rewardDevices(data, personId) {
  if (data?.integration.state !== 'ready' || data.sessions.some(session => liveSession(session) && session.personId === personId)) return [];
  return data.devices.filter(device => device.defaultAccess === 'blocked' && device.rewardAvailable === true
    && device.controlState === 'ready' && !device.accessPending && device.personIds.includes(personId));
}

const states = { starting: 'Starting · awaiting network confirmation', active: 'Session active', pausing: 'Pausing · checking block', paused: 'Paused', resuming: 'Resuming · awaiting network confirmation', adjusting: 'Updating access window', ending: 'Ending · checking block', ended: 'Session ended', failed: 'Could not start', checking: 'Checking network state' };
const kinds = { console: 'Game console', tablet: 'Tablet', phone: 'Phone', computer: 'Computer', tv: 'TV', other: 'Other device' };
const check = (label, name, enabled) => `<label class="checkbox-label"><input type="checkbox" name="${name}" ${enabled ? 'checked' : ''}><span>${h(label)}</span></label>`;

export function createInternetUI(ctx) {
  const freshState = () => ({ data: null, busy: false, error: '', serverMs: null, monoMs: 0, receivedAt: null, pendingCreditId: null, prompted: new Set(), writing: new Set(), revision: 0, reloadRequested: false, celebrateFor: null });
  let state = freshState();
  const epoch = () => ctx.epoch();
  const people = () => ctx.snapshot()?.people || [];
  const personName = id => people().find(item => item.id === id)?.name || 'Family profile';
  const deviceName = id => state.data?.devices.find(item => item.id === id)?.name || 'Device';
  const manager = () => state.data?.capabilities?.manageInternet === true;
  const ready = () => state.data?.integration.state === 'ready' && !state.error;
  const now = () => state.serverMs === null ? Date.now() : state.serverMs + performance.now() - state.monoMs;
  const stamp = value => value ? dateFormatter({ timeZone: state.data?.timezone || ctx.zone(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Not confirmed';
  const midnight = () => `Midnight at the start of ${dateLabel(addDays(dateInZone(new Date(now()), state.data?.timezone || ctx.zone()), 1))} · ${state.data?.timezone || ctx.zone()}`;
  function reset() { state = freshState(); }
  async function load({ celebrateFor = null } = {}) {
    if (state.busy) { state.reloadRequested = true; state.celebrateFor = celebrateFor || state.celebrateFor; return; }
    const started = epoch(), revision = state.revision; state.busy = true;
    try {
      const data = await request('/api/internet');
      if (started !== epoch()) return;
      if (revision !== state.revision) { state.reloadRequested = true; state.celebrateFor = celebrateFor || state.celebrateFor; return; }
      state.data = data; state.serverMs = Date.parse(data.serverTime); state.monoMs = performance.now(); state.receivedAt = new Date().toISOString(); state.error = '';
      if (!Number.isFinite(state.serverMs)) state.serverMs = null;
      ctx.render();
      const pending = data.credits.find(credit => credit.id === state.pendingCreditId);
      if (pending && canRedeem(data, pending, ctx.session(), frameAccessStatus()) && !ctx.dialog.open) { state.pendingCreditId = null; picker(pending); }
      else if (celebrateFor) {
        const credit = data.credits.find(item => item.personId === celebrateFor && item.status === 'available' && !state.prompted.has(item.id));
        if (credit && !ctx.dialog.open && (data.role === 'child' || ctx.frame())) { state.prompted.add(credit.id); celebrate(credit); }
        else if (credit && manager()) ctx.toast(`${personName(credit.personId)} earned ${credit.minutes} minutes. Their reward is saved in Devices.`);
      }
    } catch (error) { if (started === epoch()) { state.error = error.message; ctx.render(); } }
    finally {
      if (started === epoch()) {
        state.busy = false; tick();
        if (state.reloadRequested) { const pending = state.celebrateFor; state.reloadRequested = false; state.celebrateFor = null; await load({ celebrateFor: pending }); }
      }
    }
  }
  async function write(path, options, element = null) {
    const started = epoch();
    try {
      const result = await request(path, options);
      if (started !== epoch()) return null;
      state.revision++;
      if (state.data && result?.id && result.state && result.deviceId) {
        const at = state.data.sessions.findIndex(item => item.id === result.id);
        if (at < 0) state.data.sessions.unshift(result); else if (state.data.sessions[at].version <= result.version) state.data.sessions[at] = result;
        if (result.creditId) { const credit = state.data.credits.find(item => item.id === result.creditId); if (credit && credit.status === 'available') credit.status = 'reserved'; }
        ctx.render();
      }
      if (element?.tagName === 'FORM' && (!ctx.dialog.open || ctx.dialog.querySelector('form') !== element)) { await load(); return null; }
      return result;
    } catch (error) {
      if (started !== epoch()) return null;
      if (error.status === 0 || error.status >= 500 || error.status === 409) {
        state.revision++;
        state.error = 'That change needs review. Refresh Devices to check its latest state before another attempt.';
        if (element?.tagName === 'FORM') element.dataset.reviewRequired = 'true';
        ctx.render();
      }
      throw error;
    }
  }
  function integrationPanel() {
    const integration = state.data?.integration;
    const copy = { unconfigured: 'UniFi is not connected. Devices and rewards can be prepared, but this app is not controlling Internet access yet.', pilot_required: 'A parent must finish the UniFi pilot and device blocking checks before Internet time can start.', attention: 'Network control needs attention. Treat device access as unconfirmed until the latest checks pass.', ready: 'UniFi access controls are configured. Each session still shows its last confirmed network state.' };
    return `<section class="panel network-status" data-key="integration"><h2>${integration?.state === 'ready' ? 'Home Internet controls' : 'Internet controls await setup'}</h2><p class="supporting">${h(copy[integration?.state] || 'Checking the home network integration…')}</p>${integration?.error ? `<p class="form-error">${h(integration.error)}</p>` : ''}${integration?.lastCheckedAt ? `<p class="field-help">Integration checked ${h(stamp(integration.lastCheckedAt))}</p>` : ''}${state.error ? `<p class="form-error" role="alert">${h(state.error)} ${ctx.button('Refresh status', 'internet-refresh', 'text-button')}</p>` : ''}<p class="field-help">These controls apply to enrolled devices on your home network. Family Frame management access stays available outside an Internet window.</p></section>`;
  }
  function controls(session) {
    if (!manager() || !liveSession(session) || state.error) return '';
    const actionButton = (text, action) => ctx.button(text, 'session-control', 'text-button', `data-id="${h(session.id)}" data-operation="${action}" ${state.writing.has(session.id) ? 'disabled' : ''}`);
    return `<div class="occurrence-controls">${session.state === 'active' ? actionButton('Pause', 'pause') : session.state === 'paused' ? actionButton('Resume', 'resume') : ''}${['active', 'paused'].includes(session.state) ? `${actionButton('+15 min', 'add')}${actionButton('−15 min', 'remove')}${actionButton('Custom time', 'adjust')}${actionButton('All day', 'all_day')}` : ''}${actionButton('End now', 'end')}</div>`;
  }
  function sessionCard(session, compact = false) {
    const observed = session.observedState === 'allowed' ? 'Internet last confirmed allowed' : session.observedState === 'blocked' ? 'Internet last confirmed blocked' : 'Internet access not confirmed';
    return `<article class="panel session-card" data-key="session-${h(session.id)}"><div class="section-heading"><div><p class="eyebrow">${h(personName(session.personId))} · ${session.source === 'reward' ? 'Earned reward' : 'Parent grant'}</p><h3>${h(deviceName(session.deviceId))}</h3></div>${liveSession(session) ? `<div class="session-clock">${!session.endsAt && ['starting', 'resuming'].includes(session.state) ? '<small>Reserved time</small>' : ''}<strong class="session-timer" data-session-remaining="${h(session.id)}">${h(remainingLabel(remainingTime(session, now())))}</strong></div>` : ''}</div><p class="session-state">${h(states[session.state] || 'Checking session')}${session.allDay ? ' · All day' : ''}</p><p class="supporting">${h(observed)}${session.verifiedAt ? ` · ${h(stamp(session.verifiedAt))}` : ''}</p>${!compact ? `<dl class="session-facts"><div><dt>Started</dt><dd>${h(stamp(session.startedAt))}</dd></div><div><dt>${session.state === 'paused' && !session.allDay ? 'Scheduled end' : 'Ends'}</dt><dd>${session.state === 'paused' && !session.allDay ? 'Recalculated when resumed' : h(stamp(session.endsAt))}</dd></div></dl>${session.lastError ? `<p class="form-error">${h(session.lastError)}</p>` : ''}${session.reason ? `<p class="field-help">${h(session.reason)}</p>` : ''}` : ''}${controls(session)}</article>`;
  }
  function summary() {
    if (!state.data) return '';
    const sessions = state.data.sessions.filter(liveSession), credits = state.data.credits.filter(credit => credit.status === 'available');
    if (!sessions.length && !credits.length) return '';
    return `<section class="internet-summary" data-key="internet-summary"><div class="section-heading"><h2>Family Internet time</h2><a class="text-button" href="#devices">View devices ↗</a></div><div class="session-grid">${sessions.map(session => sessionCard(session, true)).join('')}</div>${credits.length ? `<div class="available-rewards">${credits.map(credit => `<div data-key="summary-credit-${h(credit.id)}"><strong>${h(personName(credit.personId))}: ${credit.minutes} minutes saved</strong>${(state.data.role === 'child' || ctx.frame() ? ctx.button(ctx.frame() && !canRedeem(state.data, credit, ctx.session(), frameAccessStatus()) ? 'Unlock to use' : 'Use reward', 'reward-use', 'text-button', `data-id="${h(credit.id)}"`) : '<a class="text-button" href="#devices">View saved reward</a>')}</div>`).join('')}</div>` : ''}</section>`;
  }
  function view() {
    if (!state.data) return `<section class="panel"><h2>Devices & Internet time</h2><p class="supporting">${h(state.error || 'Loading your family’s devices…')}</p>${ctx.button('Refresh', 'internet-refresh', 'button button-secondary')}</section>`;
    const data = state.data, sessions = data.sessions.filter(liveSession);
    return `${integrationPanel()}${ctx.frame() && !frameAccessStatus() ? `<section class="panel unlock-callout"><h3>Use an approved profile</h3><p class="supporting">A phone-generated unlock is required to use a child’s reward or change parent controls.</p>${ctx.button('Enter frame unlock code', 'frame-unlock', 'button button-secondary')}</section>` : ''}<div class="section-heading devices-heading"><h2>Current sessions</h2>${ctx.button('Refresh status', 'internet-refresh', 'text-button')}</div>${sessions.length ? `<div class="session-grid">${sessions.map(session => sessionCard(session)).join('')}</div>` : '<p class="quiet-empty">No Internet sessions are running.</p>'}<section class="panel reward-panel"><div class="section-heading"><h2>Saved rewards</h2>${manager() ? ctx.button('Reward settings', 'reward-policies', 'text-button') : ''}</div>${data.credits.filter(credit => ['available', 'held', 'reserved', 'review'].includes(credit.status)).map(credit => `<div class="reward-row" data-key="credit-${h(credit.id)}"><div><strong>${h(personName(credit.personId))} · ${credit.minutes} minutes</strong><small>${h(credit.status === 'held' ? 'Tasks need attention before this reward can be used' : credit.status === 'reserved' ? 'Reserved for a session being checked' : credit.status === 'review' ? 'A parent must review an uncertain session' : 'Available')} · earned ${h(credit.earnedDate)} · expires ${h(stamp(credit.expiresAt))}</small></div>${credit.status === 'available' && (data.role === 'child' || ctx.frame()) ? ctx.button('Use reward', 'reward-use', 'button button-small', `data-id="${h(credit.id)}"`) : credit.status === 'review' && manager() ? ctx.button('Review allowance', 'reward-review', 'text-button', `data-id="${h(credit.id)}"`) : ''}</div>`).join('') || '<p class="quiet-empty">Complete approved required tasks to earn time. Days with no required tasks do not create a reward.</p>'}<div class="progress-list">${data.progress.map(item => `<p><strong>${h(personName(item.personId))}</strong>: ${item.completedCount} of ${item.requiredCount} required tasks approved${item.pendingApprovalCount ? ` · ${item.pendingApprovalCount} waiting for a parent` : ''}</p>`).join('')}</div></section><div class="section-heading devices-heading"><h2>Family devices</h2>${manager() ? ctx.button('+ Add a device', 'device-add', 'button') : ''}</div><div class="device-grid">${data.devices.map(device => `<article class="panel managed-device" data-key="managed-device-${h(device.id)}"><p class="eyebrow">${h(kinds[device.kind] || 'Device')}</p><h3>${h(device.name)}</h3><p class="supporting">${h(device.personIds.map(personName).join(', '))}</p><p class="field-help">${device.defaultAccess === 'allowed' ? 'Free to use · Parent control only' : 'Blocked by default · Earned-time pool'}</p><p class="device-status">${device.controlState === 'unenrolled' ? 'Not enrolled · Internet blocking not configured' : device.controlState === 'attention' ? 'Needs attention · access unconfirmed' : device.accessPending ? 'Changing Internet access · waiting for confirmation' : device.accessError || device.observedAccess === 'unknown' ? 'Internet access unconfirmed' : device.observedAccess === 'allowed' ? 'Internet on · allowed by parent' : state.data.sessions.some(session => liveSession(session) && session.deviceId === device.id && session.desiredState === 'allowed') ? 'Internet time in progress' : 'Internet off · blocking confirmed'}</p><p class="field-help">${device.online === true ? 'Online' : device.online === false ? 'Offline' : 'Connection state unknown'}${device.lastSeenAt ? ` · last seen ${h(stamp(device.lastSeenAt))}` : ''}</p>${device.allowApplePush ? '<p class="field-help">Apple push transport stays available.</p>' : ''}${manager() ? `<div class="occurrence-controls">${ctx.button(device.desiredAccess === 'allowed' || device.observedAccess === 'allowed' || state.data.sessions.some(session => liveSession(session) && session.deviceId === device.id && session.desiredState === 'allowed') ? 'Turn Internet off' : 'Turn Internet on', 'device-access', 'button button-small', `data-id="${h(device.id)}" ${!ready() || device.controlState !== 'ready' || device.accessPending && device.desiredAccess !== 'allowed' || state.writing.has(device.id) ? 'disabled' : ''}`)}${ctx.button('Grant Internet time', 'device-grant', 'text-button', `data-id="${h(device.id)}" ${!ready() || device.controlState !== 'ready' || device.observedAccess !== 'blocked' || device.accessPending || state.data.sessions.some(session => liveSession(session) && session.deviceId === device.id) ? 'disabled' : ''}`)}${device.controlState === 'unenrolled' ? ctx.button('Edit device', 'device-edit', 'text-button', `data-id="${h(device.id)}"`) : '<small>Enrollment must be reviewed before identity or assignment changes.</small>'}</div>` : ''}</article>`).join('') || '<section class="panel"><p class="quiet-empty">No devices added yet. A parent can add the children’s named devices and stable network identities.</p></section>'}</div><div class="chore-tools">${ctx.button('Internet history', 'internet-history', 'button button-secondary')}</div>`;
  }
  function celebrate(credit) {
    ctx.openDialog(`Great job, ${personName(credit.personId)}!`, `<div class="reward-celebration"><strong>${credit.minutes} minutes earned</strong><p>Your approved tasks are complete. Use this reward now, or save it until ${h(stamp(credit.expiresAt))}.</p><div class="dialog-actions">${ctx.button('Save for later', 'reward-later', 'button button-secondary')}${ctx.button('Use now', 'reward-use', 'button', `data-id="${h(credit.id)}"`)}</div></div>`, async () => {});
  }
  function picker(credit) {
    if (!canRedeem(state.data, credit, ctx.session(), frameAccessStatus())) {
      if (ctx.frame()) { state.pendingCreditId = credit.id; if (ctx.dialog.open) ctx.dialog.close(); ctx.unlock(); }
      else ctx.toast('Use the child’s own account to spend their reward. Parents can grant separate time.');
      return;
    }
    const devices = rewardDevices(state.data, credit.personId);
    const operationId = mutationId();
    ctx.openDialog(`Choose one device · ${credit.minutes} minutes`, `<p class="supporting">Your full time stays reserved while access is being scheduled. Access begins only after network confirmation. Once the window starts, time elapses even while the device is asleep.</p>${!ready() ? '<p class="status-note status-warning">Internet controls are not ready. Your reward stays saved until the parent completes setup.</p>' : ''}<div class="device-picker">${devices.map(device => {
      const busy = state.data.sessions.some(session => liveSession(session) && (session.deviceId === device.id || session.personId === credit.personId));
      return `<label class="device-option"><input type="radio" name="deviceId" value="${h(device.id)}" required ${!ready() || device.controlState !== 'ready' || busy ? 'disabled' : ''}><span><strong>${h(device.name)}</strong><small>${busy ? 'Session already reserved' : device.controlState !== 'ready' ? 'Awaiting enrollment' : device.online === false ? 'Offline · access time still elapses' : 'Available'}</small></span></label>`;
    }).join('') || '<p>No earned-time devices are currently blocked and available. Your reward stays saved; try again when a device is free.</p>'}</div><div class="dialog-actions">${ctx.button('Save for later', 'reward-later', 'text-button')}<button class="button" type="submit" ${!ready() || !devices.some(device => device.controlState === 'ready' && !state.data.sessions.some(session => liveSession(session) && (session.deviceId === device.id || session.personId === credit.personId))) ? 'disabled' : ''}>Start reward</button></div>`, async (form, element) => {
      const result = await write('/api/internet/redeem', { method: 'POST', body: { creditId: credit.id, deviceId: form.get('deviceId'), mutationId: operationId } }, element);
      if (!result) return; ctx.dialog.close(); ctx.toast('Session requested. Waiting for the network to confirm access.'); location.hash = 'devices'; await load();
    });
  }
  function editDevice(device = null) {
    const operationId = mutationId();
    ctx.openDialog(device ? 'Edit family device' : 'Add a family device', `<div class="form-stack">${ctx.field('Device name', 'name', device?.name || '', { max: 80 })}<label class="field"><span>Device type</span><select name="kind" aria-label="Device type">${Object.entries(kinds).map(([key, label]) => `<option value="${key}" ${key === (device?.kind || 'console') ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field"><span>Default Internet access</span><select name="defaultAccess" aria-label="Default Internet access"><option value="blocked" ${device?.defaultAccess !== 'allowed' ? 'selected' : ''}>Blocked · kids can earn time</option><option value="allowed" ${device?.defaultAccess === 'allowed' ? 'selected' : ''}>Allowed · parents control on/off</option></select></label><p class="field-help">Only blocked-by-default devices enter the earned-time pool. Parent controls work independently of tasks.</p><fieldset class="assignment-picker"><legend>Children who may use this device</legend>${people().map(person => check(person.name, `person-${person.id}`, (device ? device.personIds.includes(person.id) : true))).join('')}</fieldset><label class="field"><span>Stable MAC addresses · one per line</span><textarea name="macAddresses" rows="3" required>${h((device?.macAddresses || []).join('\n'))}</textarea></label><p class="field-help">Use the confirmed UniFi identities. Include Wi-Fi and Ethernet when both are used. Adding inventory does not yet enroll or block a device.</p>${check('Keep Apple notifications available', 'allowApplePush', device?.allowApplePush === true)}<p class="field-help">Allows Apple’s shared push transport while normal Internet is blocked. Family Frame management access stays available. This does not enable general web browsing.</p><div class="dialog-actions">${device ? ctx.button('Remove device', 'device-remove', 'text-button danger-text', `data-id="${h(device.id)}"`) : ''}<button type="submit" class="button">Save device</button></div></div>`, async (form, element) => {
      const personIds = people().filter(person => form.has(`person-${person.id}`)).map(person => person.id);
      if (!personIds.length) throw new Error('Assign at least one child.');
      const macAddresses = String(form.get('macAddresses')).split(/[\n,]+/).map(value => value.trim()).filter(Boolean);
      const result = await write(`/api/internet/devices${device ? `/${encodeURIComponent(device.id)}` : ''}`, { method: device ? 'PATCH' : 'POST', body: { name: form.get('name').trim(), kind: form.get('kind'), defaultAccess: form.get('defaultAccess'), personIds, macAddresses, allowApplePush: form.has('allowApplePush'), mutationId: operationId, ...(device ? { expectedVersion: device.version } : {}) } }, element);
      if (!result) return; ctx.dialog.close(); await load();
    });
    if (!device) ctx.dialog.querySelector('[name="kind"]').onchange = event => { ctx.dialog.querySelector('[name="allowApplePush"]').checked = ['phone', 'tablet'].includes(event.target.value); };
  }
  function grant(device) {
    const operationId = mutationId(), choices = people().filter(person => device.personIds.includes(person.id));
    ctx.openDialog(`Grant time · ${device.name}`, `<div class="form-stack"><label class="field"><span>Child</span><select name="personId" aria-label="Child">${choices.map(person => `<option value="${h(person.id)}">${h(person.name)}</option>`).join('')}</select></label>${ctx.field('Minutes', 'minutes', '60', { type: 'number', extra: 'min="1" max="1439" step="1"' })}${check('All day', 'allDay', false)}<p class="field-help">All day ends at ${h(midnight())}. This is separate from earned rewards.</p>${ctx.field('Reason (optional)', 'reason', '', { required: false, max: 500 })}<button class="button" type="submit">Request access window</button></div>`, async (form, element) => {
      const allDay = form.has('allDay');
      const result = await write('/api/internet/grants', { method: 'POST', body: { personId: form.get('personId'), deviceId: device.id, ...(allDay ? { allDay: true } : { minutes: Number(form.get('minutes')) }), reason: form.get('reason').trim() || undefined, mutationId: operationId } }, element);
      if (!result) return; ctx.dialog.close(); ctx.toast('Access requested. Network confirmation is pending.'); await load();
    });
  }
  async function changeSession(session, action, deltaMinutes = null, element = null, reason = '') {
    if (state.writing.has(session.id)) return;
    const started = epoch(); let released = false;
    state.writing.add(session.id); if (element) element.disabled = true;
    const release = () => { if (released || started !== epoch()) return; released = true; state.writing.delete(session.id); if (element?.isConnected) element.disabled = false; ctx.render(); };
    try {
      const result = await write(`/api/internet/sessions/${encodeURIComponent(session.id)}/actions`, { method: 'POST', body: { action, expectedVersion: session.version, mutationId: mutationId(), ...(deltaMinutes !== null ? { deltaMinutes } : {}), ...(reason ? { reason } : {}) } });
      if (!result || started !== epoch()) return;
      release(); // An acknowledged transition must remain interruptible while its status read is pending.
      await load();
    } finally { release(); }
  }
  function editPolicy(policy) {
    ctx.openDialog(`Rewards · ${personName(policy.personId)}`, `<div class="form-stack">${check('Enable earned Internet rewards', 'enabled', policy.enabled)}${[['Reward minutes', 'rewardMinutes', 1, 1439], ['Days to save a reward', 'carryoverDays', 0, 365], ['Daily time limit (minutes)', 'dailyLimitMinutes', 1, 1440], ['Expiry warning (minutes)', 'warningMinutes', 0, 60]].map(([label, name, min, max]) => ctx.field(label, name, policy[name], { type: 'number', extra: `min="${min}" max="${max}" step="1"` })).join('')}${ctx.field('Bedtime cutoff (optional)', 'bedtime', policy.bedtime || '', { type: 'time', required: false })}<p class="field-help">Times use ${h(state.data.timezone)}. Reward size and expiry apply to future earned credits. Saved credits keep their earned minutes. The enabled setting, current daily limit and bedtime are checked when a reward starts. Change active sessions with their parent controls.</p><button type="submit" class="button">Save reward settings</button></div>`, async (form, element) => {
      const body = { expectedVersion: policy.version, enabled: form.has('enabled'), bedtime: form.get('bedtime') || null };
      for (const key of ['rewardMinutes', 'carryoverDays', 'dailyLimitMinutes', 'warningMinutes']) body[key] = Number(form.get(key));
      const result = await write(`/api/internet/policies/${encodeURIComponent(policy.personId)}`, { method: 'PUT', body }, element);
      if (!result) return; ctx.dialog.close(); await load();
    });
  }
  async function action(name, element) {
    if (name === 'internet-refresh') { await load(); return true; }
    if (name === 'reward-later') { ctx.dialog.close(); ctx.toast('Reward saved. Find it in Devices when you’re ready.'); return true; }
    if (name === 'reward-use') { const credit = state.data?.credits.find(item => item.id === element.dataset.id); if (credit) picker(credit); return true; }
    if (name === 'device-add') { if (manager()) editDevice(); return true; }
    if (name === 'device-edit') { const device = state.data?.devices.find(item => item.id === element.dataset.id); if (manager() && device?.controlState === 'unenrolled') editDevice(device); return true; }
    if (name === 'device-access') {
      const device = state.data?.devices.find(item => item.id === element.dataset.id);
      if (!manager() || !ready() || device?.controlState !== 'ready' || device.accessPending && device.desiredAccess !== 'allowed' || state.writing.has(device.id)) return true;
      const access = device.desiredAccess === 'allowed' || device.observedAccess === 'allowed' || state.data.sessions.some(session => liveSession(session) && session.deviceId === device.id && session.desiredState === 'allowed') ? 'blocked' : 'allowed';
      state.writing.add(device.id); element.disabled = true;
      try {
        const result = await write(`/api/internet/devices/${encodeURIComponent(device.id)}/access`, { method: 'POST', body: { access, expectedVersion: device.version, mutationId: mutationId() } });
        if (result) { ctx.toast('Device control requested. Waiting for UniFi confirmation.'); await load(); }
      } finally { state.writing.delete(device.id); ctx.render(); }
      return true;
    }
    if (name === 'device-grant') { const device = state.data?.devices.find(item => item.id === element.dataset.id); if (manager() && ready() && device?.controlState === 'ready') grant(device); return true; }
    if (name === 'device-remove') {
      const device = state.data?.devices.find(item => item.id === element.dataset.id); if (!manager() || device?.controlState !== 'unenrolled') return true;
      const result = await write(`/api/internet/devices/${encodeURIComponent(device.id)}?expectedVersion=${device.version}&mutationId=${mutationId()}`, { method: 'DELETE' });
      if (result) { if (ctx.dialog.open && element.isConnected) ctx.dialog.close(); await load(); } return true;
    }
    if (name === 'session-control') {
      const session = state.data?.sessions.find(item => item.id === element.dataset.id), operation = element.dataset.operation;
      if (!session || !manager() || state.error) return true;
      if (['pause', 'resume', 'add', 'remove'].includes(operation)) { await changeSession(session, operation === 'add' || operation === 'remove' ? 'adjust' : operation, operation === 'add' ? 15 : operation === 'remove' ? -15 : null, element); return true; }
      const operationId = mutationId();
      ctx.openDialog(operation === 'adjust' ? 'Adjust session time' : operation === 'all_day' ? 'Allow until household midnight' : 'End this session', `<div class="form-stack"><p>${h(personName(session.personId))} · ${h(deviceName(session.deviceId))}</p>${operation === 'adjust' ? ctx.field('Add or remove minutes', 'deltaMinutes', '15', { type: 'number', extra: 'min="-1440" max="1440" step="1"' }) : operation === 'all_day' ? `<p>Ends at ${h(midnight())}, including while paused.</p>` : '<p>Access stays unconfirmed until blocking is verified.</p>'}${ctx.field('Reason (optional)', 'reason', '', { required: false, max: 500 })}<button type="submit" class="button">${operation === 'end' ? 'End now' : 'Apply change'}</button></div>`, async (form, formElement) => {
        const result = await write(`/api/internet/sessions/${encodeURIComponent(session.id)}/actions`, { method: 'POST', body: { action: operation, expectedVersion: session.version, mutationId: operationId, ...(operation === 'adjust' ? { deltaMinutes: Number(form.get('deltaMinutes')) } : {}), reason: form.get('reason').trim() || undefined } }, formElement);
        if (result) { ctx.dialog.close(); await load(); }
      }); return true;
    }
    if (name === 'reward-policies') {
      if (!manager()) return true;
      ctx.openDialog('Reward settings', `<div class="form-stack">${state.data.policies.map(policy => ctx.button(`${personName(policy.personId)} · ${policy.rewardMinutes} minutes`, 'reward-policy-edit', 'button button-secondary', `data-id="${h(policy.personId)}"`)).join('')}</div>`, async () => {}); return true;
    }
    if (name === 'reward-policy-edit') { const policy = state.data?.policies.find(item => item.personId === element.dataset.id); if (manager() && policy) { ctx.dialog.close(); editPolicy(policy); } return true; }
    if (name === 'reward-review') {
      const credit = state.data?.credits.find(item => item.id === element.dataset.id), operationId = mutationId(); if (!manager() || credit?.status !== 'review') return true;
      ctx.openDialog('Review uncertain allowance', `<div class="form-stack"><p>${h(personName(credit.personId))} · ${credit.minutes} minutes. Network access could not be confirmed before the session ended.</p><label class="field"><span>Resolution</span><select name="action" aria-label="Resolution"><option value="restore">Restore the saved reward</option><option value="consume">Record reward as used</option></select></label>${ctx.field('Reason', 'reason', '', { max: 500 })}<button class="button" type="submit">Record resolution</button></div>`, async (form, formElement) => {
        const result = await write(`/api/internet/credits/${encodeURIComponent(credit.id)}/resolve`, { method: 'POST', body: { action: form.get('action'), reason: form.get('reason').trim(), mutationId: operationId } }, formElement);
        if (result) { ctx.dialog.close(); await load(); }
      }); return true;
    }
    if (name === 'internet-history') {
      const started = epoch(), result = await request('/api/internet/history'); if (started !== epoch() || ctx.dialog.open) return true;
      ctx.openDialog('Internet time history', `${state.data.sessions.some(item => !liveSession(item)) ? `<h3>Recent finished sessions</h3><div class="finished-sessions">${state.data.sessions.filter(item => !liveSession(item)).slice(0, 20).map(item => sessionCard(item)).join('')}</div>` : ''}<h3>Activity</h3><ol class="history-list">${result.history.map(item => `<li><strong>${h(item.type.replaceAll('_', ' '))}</strong><span>${h(item.personId ? personName(item.personId) : 'Family')} · ${h(item.deviceId ? deviceName(item.deviceId) : '')}</span><small>${h(stamp(item.createdAt))}</small>${item.reason ? `<p>${h(item.reason)}</p>` : ''}</li>`).join('') || '<li>No Internet time changes yet.</li>'}</ol>`, async () => {}); return true;
    }
    return false;
  }
  function tick() {
    for (const element of document.querySelectorAll('[data-session-remaining]')) {
      const session = state.data?.sessions.find(item => item.id === element.dataset.sessionRemaining);
      if (!session) continue;
      const value = remainingLabel(remainingTime(session, now()));
      if (element.textContent !== value) element.textContent = value;
    }
  }
  return { load, view, action, summary, tick, reset, loaded: () => !!state.data };
}
