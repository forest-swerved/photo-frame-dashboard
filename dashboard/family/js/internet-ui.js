import { request, frameAccessStatus } from './api.js';
import { deviceArtworkImage } from './device-art.js';
import { escapeHtml as h, mutationId, dateFormatter, dateInZone, addDays, dateLabel } from './model.js';

export const liveSession = session => !['ended', 'failed'].includes(session.state);
export function deviceAccessProblem(device) {
  if(!device.accessError) return '';
  return ['policy_review_required','management_policy_changed','session_policy_changed','network_scope_changed'].includes(device.accessError)
    ? 'Network rules need parent review · access not confirmed' : 'Internet change could not be confirmed · retrying';
}
export function remainingTime(session, now) {
  if (!liveSession(session)) return null;
  const end = Date.parse(session.endsAt);
  if (session.state === 'paused' && !session.allDay) return Math.max(0, session.remainingSeconds || 0);
  if (!Number.isFinite(end)) return ['starting', 'resuming', 'paused'].includes(session.state) && Number.isFinite(session.remainingSeconds) ? Math.max(0, session.remainingSeconds) : null;
  const remaining = Math.max(0, Math.ceil((end - now) / 1000));
  return session.state === 'paused' ? Math.min(session.remainingSeconds || 0, remaining) : remaining;
}
export function sessionCountdown(session, now) {
  const total = remainingTime(session, now);
  const frozen = Math.max(0, session.preparationRemainingSeconds || 0), end = Date.parse(session.preparationEndsAt);
  const preparation = session.allDay || !liveSession(session) ? 0 : session.state === 'paused' || !session.endsAt
    ? frozen : Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : 0;
  const pending = !session.endsAt && ['starting','resuming','checking'].includes(session.state);
  return { phase: preparation > 0 ? 'preparation' : 'usage', preparation,
    remaining: preparation > 0 ? preparation : total,
    usage: total === null ? null : Math.max(0, total - preparation),
    label: session.state === 'paused' ? preparation > 0 ? 'Get ready · paused' : 'Usage time · paused'
      : pending ? 'Waiting for network' : preparation > 0 ? 'Get ready' : session.allDay ? 'All-day access' : 'Time remaining',
    progress: frozen > 0 ? Math.min(1, preparation / frozen) : 0 };
}
export function sessionSoundState(session, warningMinutes, now) {
  const countdown = sessionCountdown(session, now), deadline = Date.parse(session.endsAt);
  // Expiry can be observed just before or after the server marks the session ended.
  // A timer cue means its clock elapsed, never that network blocking is confirmed.
  const expired = ['ending','ended'].includes(session.state) && Number.isFinite(deadline) && deadline <= now;
  return { id:session.id, phase:countdown.phase, remaining:expired ? 0 : countdown.remaining, deadline:session.endsAt,
    running:expired || session.state === 'active' && session.observedState === 'allowed' && !session.lastError,
    pending:['starting','resuming'].includes(session.state), warning:(warningMinutes || 0) * 60 };
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

export function earnedToday(data, credit) {
  const time = Date.parse(data?.serverTime);
  if (!Number.isFinite(time) || !data?.timezone || credit?.status !== 'available' || !(Date.parse(credit.expiresAt) > time)) return false;
  const date = dateInZone(new Date(time), data.timezone);
  const progress = data.progress?.find(item => item.personId === credit.personId && item.date === date);
  return credit.earnedDate === date && progress?.eligible === true && progress.requiredCount > 0
    && progress.completedCount === progress.requiredCount && progress.pendingApprovalCount === 0 && progress.remainingCount === 0;
}

const states = { starting: 'Starting · awaiting network confirmation', active: 'Session active', pausing: 'Pausing · checking block', paused: 'Paused', resuming: 'Resuming · awaiting network confirmation', adjusting: 'Updating access window', ending: 'Ending · checking block', ended: 'Session ended', failed: 'Could not start', checking: 'Checking network state' };
const kinds = { console: 'Game console', tablet: 'Tablet', phone: 'Phone', computer: 'Computer', tv: 'TV', other: 'Other device' };
const check = (label, name, enabled) => `<label class="checkbox-label"><input type="checkbox" name="${name}" ${enabled ? 'checked' : ''}><span>${h(label)}</span></label>`;

export function createInternetUI(ctx) {
  const freshState = () => ({ data: null, busy: false, error: '', serverMs: null, monoMs: 0, receivedAt: null, pendingCreditId: null, knownCredits: new Set(), newRewards: new Set(), rewardDialog: null, writing: new Set(), revision: 0, reloadRequested: false, phases: new Map(), rolloverUntil: new Map() });
  let state = freshState();
  const allDayAvailable = () => state.data?.integration.scheduleSupport?.allDay !== false;
  const epoch = () => ctx.epoch();
  const people = () => ctx.snapshot()?.people || [];
  const personName = id => people().find(item => item.id === id)?.name || 'Family profile';
  const deviceName = id => state.data?.devices.find(item => item.id === id)?.name || 'Device';
  const manager = () => state.data?.capabilities?.manageInternet === true;
  const showControls = () => manager() || ctx.frame();
  const ready = () => state.data?.integration.state === 'ready' && !state.error;
  const now = () => state.serverMs === null ? Date.now() : state.serverMs + performance.now() - state.monoMs;
  const readScope = () => {
    const session = ctx.session(), access = frameAccessStatus();
    return JSON.stringify([session?.authType, session?.role, session?.personId, access?.scope, access?.personId, access?.expiresAt]);
  };
  const stamp = value => value ? dateFormatter({ timeZone: state.data?.timezone || ctx.zone(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Not confirmed';
  const midnight = () => `Midnight at the start of ${dateLabel(addDays(dateInZone(new Date(now()), state.data?.timezone || ctx.zone()), 1))} · ${state.data?.timezone || ctx.zone()}`;
  function reset() { state = freshState(); }
  async function load() {
    if (state.busy) { state.reloadRequested = true; return false; }
    const started = epoch(), revision = state.revision, scope = readScope(); state.busy = true;
    try {
      const data = await request('/api/internet');
      if (started !== epoch()) return false;
      if (scope !== readScope()) { state.reloadRequested = true; return false; }
      if (revision !== state.revision) { state.reloadRequested = true; return false; }
      // The first read establishes saved rewards. Later accepted reads may
      // announce only genuinely new credits, never replay an old carryover.
      for (const credit of data.credits) {
        if (state.data && !state.knownCredits.has(credit.id) && earnedToday(data, credit)) state.newRewards.add(credit.id);
        state.knownCredits.add(credit.id);
      }
      for (const id of state.newRewards) if (!data.credits.some(credit => credit.id === id && earnedToday(data, credit))) state.newRewards.delete(id);
      state.data = data; state.serverMs = Date.parse(data.serverTime); state.monoMs = performance.now(); state.receivedAt = new Date().toISOString(); state.error = '';
      if (!Number.isFinite(state.serverMs)) state.serverMs = null;
      if (state.rewardDialog) {
        const shown = state.rewardDialog;
        if (!ctx.dialog.open || ctx.dialog.querySelector('form') !== shown.form) state.rewardDialog = null;
        else if (!data.credits.some(credit => credit.id === shown.id && earnedToday(data, credit))) { ctx.dialog.close(); state.rewardDialog = null; }
      }
      ctx.render();
      const pending = data.credits.find(credit => credit.id === state.pendingCreditId);
      if (pending && canRedeem(data, pending, ctx.session(), frameAccessStatus()) && !ctx.dialog.open) { state.pendingCreditId = null; picker(pending); }
      else {
        const access = frameAccessStatus(), childId = access?.scope === 'child' ? access.personId : ctx.session()?.role === 'child' ? ctx.session().personId : null;
        const credit = data.credits.find(item => state.newRewards.has(item.id) && (!childId || item.personId === childId));
        if (credit && !ctx.dialog.open && (data.role === 'child' || ctx.frame())) { state.newRewards.delete(credit.id); celebrate(credit); }
        else if (credit && manager()) { state.newRewards.delete(credit.id); ctx.toast(`${personName(credit.personId)} earned ${credit.minutes} minutes. Their reward is saved in Devices.`); }
      }
      return true;
    } catch (error) { if (started === epoch()) { state.error = error.message; ctx.render(); } return false; }
    finally {
      if (started === epoch()) {
        state.busy = false; tick();
        if (state.reloadRequested) { state.reloadRequested = false; await load(); }
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
      ctx.sound?.(/\/(?:redeem|grants)$|\/sessions\/.*\/actions$|\/devices\/.*\/access$/.test(path) ? 'requested' : 'saved');
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
    const copy = { unconfigured: 'UniFi is not connected. Devices and rewards can be prepared, but this app is not controlling Internet access yet.', pilot_required: 'A parent must finish the UniFi pilot and device blocking checks before Internet time can start.', attention: 'Network control needs attention. Treat device access as unconfirmed until the latest checks pass.', ready: integration?.enrollmentBasis === 'parent_accepted' ? 'Parent accepted setup · UniFi access controls are configured. Each session shows its last confirmed network state.' : 'UniFi access controls are configured. Each session still shows its last confirmed network state.' };
    if (integration?.state === 'ready' && !state.error && !integration.error) return '';
    return `<section class="panel network-status" data-key="integration"><h2>${integration?.state === 'ready' ? 'Home Internet controls' : 'Internet controls await setup'}</h2><p class="supporting">${h(copy[integration?.state] || 'Checking the home network integration…')}</p>${integration?.error ? `<p class="form-error">${h(integration.error)}</p>` : ''}${integration?.lastCheckedAt ? `<p class="field-help">Integration checked ${h(stamp(integration.lastCheckedAt))}</p>` : ''}${state.error ? `<p class="form-error" role="alert">${h(state.error)} ${ctx.button('Refresh status', 'internet-refresh', 'text-button')}</p>` : ''}<p class="field-help">These controls apply to enrolled devices on your home network. Family Frame management access stays available outside an Internet window.</p></section>`;
  }
  function controls(session) {
    if (!showControls() || !liveSession(session) || state.error) return '';
    const actionButton = (text, action) => ctx.button(text,'session-control','text-button',`data-id="${h(session.id)}" data-operation="${action}" ${state.writing.has(session.id) ? 'disabled' : ''}`);
    return `<div class="occurrence-controls session-controls">${session.state === 'active' ? actionButton('Pause','pause') : session.state === 'paused' ? actionButton('Resume','resume') : ''}${['active','paused'].includes(session.state) ? actionButton('+15 min','add') : ''}<details class="session-more" data-key="session-more-${h(session.id)}"><summary>More controls</summary><div class="occurrence-controls">${['active','paused'].includes(session.state) ? actionButton('−15 min','remove')+actionButton('Custom time','adjust')+(allDayAvailable() ? actionButton('All day','all_day') : '') : ''}${actionButton('End now','end')}</div></details></div>`;
  }

  function clock(session) {
    const value = sessionCountdown(session, now());
    return `<div class="session-clock session-countdown" data-session-clock="${h(session.id)}" data-phase="${value.phase}"><svg class="preparation-ring" viewBox="0 0 64 64" aria-hidden="true"><circle class="ring-track" cx="32" cy="32" r="28"/><circle class="ring-progress" cx="32" cy="32" r="28" pathLength="1" style="stroke-dashoffset:${1-value.progress}"/></svg><div><small data-session-phase="${h(session.id)}">${h(value.label)}</small><strong class="session-timer" data-session-remaining="${h(session.id)}">${h(remainingLabel(value.remaining))}</strong><small class="session-rollover-message">Let’s go! Your time starts now.</small></div></div>`;
  }

  function personSummary(personId) {
    const session = state.data?.sessions.find(item => liveSession(item) && item.personId === personId);
    const credits = state.data?.credits.filter(item=>item.personId===personId && item.status==='available') || [];
    const saved = credits.reduce((sum,item)=>sum+item.minutes,0);
    const status = state.error ? 'Last known status · refresh needed' : !state.data ? 'Checking device time…' : 'No device time running';
    const device = session && state.data.devices.find(item=>item.id===session.deviceId);
    const confirmed = session?.state==='active' && session.observedState==='allowed' && !!session.verifiedAt && !session.lastError && !state.error;
    return `<section class="frame-device-time ${session ? 'has-session' : ''}" data-key="frame-device-${h(personId)}" aria-label="${h(personName(personId))}’s device time">${session ? `${device ? deviceArtworkImage(device) : ''}<div class="frame-device-name"><strong>${h(deviceName(session.deviceId))}</strong><span>${h(state.error ? 'Last known status · refresh needed' : states[session.state] || 'Checking session')}</span>${confirmed ? '<span class="access-confirmed">Access on</span>' : ''}${saved ? `<small>${saved} minutes saved</small>` : ''}</div>${clock(session)}` : `<div class="frame-device-name"><strong>Device time</strong><span>${h(status)}</span>${saved ? `<small>${saved} minutes saved</small>` : ''}</div><a href="#devices" class="text-button">${saved ? 'Use saved time' : 'View devices'} ↗</a>`}</section>`;
  }

  function sessionCard(session, compact = false) {
    const observed = session.observedState === 'allowed' ? 'Internet last confirmed allowed' : session.observedState === 'blocked' ? 'Internet last confirmed blocked' : 'Internet access not confirmed';
    return `<article class="panel session-card" data-key="session-${h(session.id)}"><div class="section-heading"><div><p class="eyebrow">${h(personName(session.personId))} · ${session.source === 'reward' ? 'Earned reward' : 'Parent grant'}</p><h3>${h(deviceName(session.deviceId))}</h3></div>${liveSession(session) ? clock(session) : ''}</div><p class="session-state">${h(states[session.state] || 'Checking session')}${session.allDay ? ' · All day' : ''}</p><p class="supporting">${h(observed)}${session.verifiedAt ? ` · ${h(stamp(session.verifiedAt))}` : ''}</p>${!compact ? `<dl class="session-facts"><div><dt>Started</dt><dd>${h(stamp(session.startedAt))}</dd></div><div><dt>${session.state === 'paused' && !session.allDay ? 'Scheduled end' : 'Ends'}</dt><dd>${session.state === 'paused' && !session.allDay ? 'Recalculated when resumed' : h(stamp(session.endsAt))}</dd></div></dl>${session.lastError ? `<p class="form-error">${h(session.lastError)}</p>` : ''}${session.reason ? `<p class="field-help">${h(session.reason)}</p>` : ''}` : ''}${controls(session)}</article>`;
  }

  function rewardAvailability(credit) {
    if (state.error) return 'Refresh to confirm current availability.';
    if (!ready()) return 'A parent needs to finish network setup.';
    const live = state.data.sessions.find(item=>liveSession(item)&&item.personId===credit.personId);
    if (live) return live.endsAt ? `Internet time in use until ${stamp(live.endsAt)}. Your reward stays saved.` : 'Another session is being checked. Your reward stays saved.';
    return rewardDevices(state.data,credit.personId).length ? '' : 'No earned-time device is currently available. Your reward stays saved.';
  }
  function rewardAction(credit, compact = false) {
    const redeem = canRedeem(state.data,credit,ctx.session(),frameAccessStatus());
    if (!redeem && !ctx.frame()) return compact ? '<a class="text-button" href="#devices">View rewards ↗</a>' : '';
    const unavailable = redeem ? rewardAvailability(credit) : '';
    return `${ctx.button('Use reward','reward-use','text-button',`data-id="${h(credit.id)}" ${unavailable ? 'disabled' : ''}`)}${unavailable ? `<small class="reward-availability">${h(unavailable)}</small>` : ''}`;
  }
  function summary(compact = false) {
    if (!state.data) return '';
    const sessions = state.data.sessions.filter(liveSession), credits = state.data.credits.filter(credit=>credit.status==='available');
    if (!sessions.length && !credits.length) return '';
    if (compact) {
      const session = sessions[0];
      return `<section class="home-internet-strip" data-key="internet-summary" aria-label="Family Internet time">${session ? `<div class="home-session"><div><strong>${h(deviceName(session.deviceId))} · Internet time</strong><p>${h(states[session.state] || 'Checking session')} · ${state.error ? 'Last known status' : session.observedState === 'allowed' ? 'Internet last confirmed allowed' : session.observedState === 'blocked' ? 'Internet last confirmed blocked' : 'Access unconfirmed'}${sessions.length>1 ? ` · ${sessions.length} current sessions` : ''}</p></div>${clock(session)}</div>` : `<div class="home-session"><div><strong>${credits.reduce((sum,c)=>sum+c.minutes,0)} minutes saved</strong><p>Earned rewards · choose a device when you are ready</p></div></div>`}${state.data.role==='child' && credits.length && !session ? rewardAction(credits[0],true) : '<a class="text-button" href="#devices">View devices ↗</a>'}</section>`;
    }
    return `<section class="internet-summary" data-key="internet-summary"><div class="section-heading"><h2>Family Internet time</h2><a class="text-button" href="#devices">View devices ↗</a></div><div class="session-grid">${sessions.map(session=>sessionCard(session,true)).join('')}</div>${credits.length ? `<div class="available-rewards">${credits.map(credit=>`<div data-key="summary-credit-${h(credit.id)}"><strong>${h(personName(credit.personId))}: ${credit.minutes} minutes saved</strong>${rewardAction(credit,true)}</div>`).join('')}</div>` : ''}</section>`;
  }
  function deviceCard(device) {
    const sessions = state.data.sessions.filter(session=>liveSession(session)&&session.deviceId===device.id);
    const on = device.desiredAccess === 'allowed' || device.observedAccess === 'allowed' || sessions.some(session=>session.desiredState==='allowed');
    const status = device.controlState==='unenrolled' ? 'Not enrolled · Internet blocking not configured' : device.controlState==='attention' ? 'Needs attention · access unconfirmed' : deviceAccessProblem(device) ? deviceAccessProblem(device) : device.accessPending ? 'Changing Internet access · waiting for confirmation' : device.observedAccess==='unknown' ? 'Internet access unconfirmed' : device.observedAccess==='allowed' ? 'Internet on · allowed by parent' : sessions.some(session=>session.desiredState==='allowed') ? 'Internet time in progress' : 'Internet off · blocking confirmed';
    return `<article class="panel managed-device" data-key="managed-device-${h(device.id)}"><div class="device-card-heading">${deviceArtworkImage(device)}<div class="device-card-labels"><p class="eyebrow">${h(kinds[device.kind] || 'Device')}</p><h3>${h(device.name)}</h3><span class="soft-label">${h(device.personIds.map(personName).join(', '))}</span></div></div><p class="device-status">${h(status)}</p><p class="field-help">${device.online===true ? 'Connected to the home network' : device.online===false ? 'Not currently seen on the home network' : 'Connection state unknown'}</p><div class="device-session">${sessions.map(session=>sessionCard(session)).join('')}</div>${showControls() ? `<div class="occurrence-controls">${ctx.button(on?'Turn Internet off':'Turn Internet on','device-access','button button-small',`data-id="${h(device.id)}" ${!ready()||device.controlState!=='ready'||device.accessPending&&device.desiredAccess!=='allowed'||state.writing.has(device.id)?'disabled':''}`)}${ctx.button('Grant Internet time','device-grant','text-button',`data-id="${h(device.id)}" ${!ready()||device.controlState!=='ready'||device.observedAccess!=='blocked'||device.accessPending||sessions.length?'disabled':''}`)}${device.controlState==='unenrolled'?ctx.button('Edit device','device-edit','text-button',`data-id="${h(device.id)}"`):''}</div><p class="field-help">The on/off switch stays set until you change it. A timed allowance ends automatically.</p>` : ''}<details class="device-explanation"><summary>Device details & access rules</summary><p>${device.defaultAccess==='allowed'?'Free to use · Parent control only':'Blocked by default · Earned-time pool'}</p>${device.lastSeenAt?`<p>Last seen ${h(stamp(device.lastSeenAt))}</p>`:''}${device.allowApplePush?'<p>Apple push transport stays available.</p>':''}${device.controlState!=='unenrolled'&&manager()?'<p>Enrollment must be reviewed before identity or assignment changes.</p>':''}</details></article>`;
  }
  function view() {
    const data=state.data;
    if (!data) return `${integrationPanel()}<p class="quiet-empty">${state.error ? h(state.error) : 'Loading family devices…'}</p>${ctx.button('Refresh status','internet-refresh','text-button')}`;
    const credits=data.credits.filter(item=>!['spent','expired'].includes(item.status));
    const orphans=data.sessions.filter(item=>liveSession(item)&&!data.devices.some(device=>device.id===item.deviceId));
    return `${integrationPanel()}<div class="section-heading devices-heading"><h2>Family devices</h2><div class="occurrence-controls">${ctx.button('Refresh status','internet-refresh','text-button')}${showControls()?ctx.button('+ Add a device','device-add','button'):''}</div></div><div class="device-grid">${data.devices.map(deviceCard).join('')||'<section class="panel"><p class="quiet-empty">No devices added yet. A parent can add the children’s named devices and stable network identities.</p></section>'}</div>${orphans.length?`<section><h2>Other current sessions</h2><div class="session-grid">${orphans.map(item=>sessionCard(item)).join('')}</div></section>`:''}<section class="panel reward-panel"><div class="section-heading"><h2>Saved rewards</h2>${showControls()?ctx.button('Reward settings','reward-policies','text-button'):''}</div>${credits.map(credit=>`<div class="reward-row" data-key="credit-${h(credit.id)}"><div><strong>${h(personName(credit.personId))} · ${credit.minutes} minutes</strong><small>${h(credit.status==='available'?'Available':credit.status==='review'?'Needs parent review':'Reserved')} · earned ${h(credit.earnedDate)} · expires ${h(stamp(credit.expiresAt))}</small></div>${credit.status==='available'?rewardAction(credit):credit.status==='review'&&showControls()?ctx.button('Review allowance','reward-review','text-button',`data-id="${h(credit.id)}"`):''}</div>`).join('')||'<p class="quiet-empty">Complete approved required tasks to earn time. Days with no required tasks do not create a reward.</p>'}<details class="device-explanation"><summary>Required-task progress & reward rules</summary><div class="progress-list">${data.progress.map(item=>`<p><strong>${h(personName(item.personId))}</strong>: ${item.completedCount} of ${item.requiredCount} required tasks approved${item.pendingApprovalCount?` · ${item.pendingApprovalCount} waiting for a parent`:''}</p>`).join('')}</div></details></section><div class="chore-tools">${ctx.button('Internet history','internet-history','button button-secondary')}</div>`;
  }

  function celebrate(credit) {
    ctx.sound?.('reward', {key:`reward:${credit.id}`});
    ctx.openDialog(`Great job, ${personName(credit.personId)}!`, `<div class="reward-celebration"><strong>${credit.minutes} minutes earned</strong><p>Your approved tasks are complete. Use this reward now, or save it until ${h(stamp(credit.expiresAt))}.</p><div class="dialog-actions">${ctx.button('Save for later', 'reward-later', 'button button-secondary')}${ctx.button('Use now', 'reward-use', 'button', `data-id="${h(credit.id)}"`)}</div></div>`, async () => {});
    state.rewardDialog = { id: credit.id, form: ctx.dialog.querySelector('form') };
  }
  function picker(credit) {
    if (!canRedeem(state.data, credit, ctx.session(), frameAccessStatus())) {
      if (ctx.frame()) { state.pendingCreditId = credit.id; if (ctx.dialog.open) ctx.dialog.close(); ctx.unlock(); }
      else ctx.toast('Use the child’s own account to spend their reward. Parents can grant separate time.');
      return;
    }
    const devices = rewardDevices(state.data, credit.personId);
    const operationId = mutationId();
    ctx.openDialog(`Choose one device · ${credit.minutes} minutes`, `<p class="supporting">Your ${credit.minutes} minutes stay reserved while access is scheduled. Internet turns on with a free five-minute get-ready countdown, then your full usage time begins. Time continues while the device is asleep.</p>${!ready() ? '<p class="status-note status-warning">Internet controls are not ready. Your reward stays saved until the parent completes setup.</p>' : ''}<div class="device-picker">${devices.map(device => {
      const busy = state.data.sessions.some(session => liveSession(session) && (session.deviceId === device.id || session.personId === credit.personId));
      return `<label class="device-option"><input type="radio" name="deviceId" value="${h(device.id)}" required ${!ready() || device.controlState !== 'ready' || busy ? 'disabled' : ''}>${deviceArtworkImage(device)}<span><strong>${h(device.name)}</strong><small>${busy ? 'Session already reserved' : device.controlState !== 'ready' ? 'Awaiting enrollment' : device.online === false ? 'Offline · access time still elapses' : 'Available'}</small></span></label>`;
    }).join('') || '<p>No earned-time devices are currently blocked and available. Your reward stays saved; try again when a device is free.</p>'}</div><div class="dialog-actions">${ctx.button('Save for later', 'reward-later', 'text-button')}<button class="button" type="submit" ${!ready() || !devices.some(device => device.controlState === 'ready' && !state.data.sessions.some(session => liveSession(session) && (session.deviceId === device.id || session.personId === credit.personId))) ? 'disabled' : ''}>Start reward</button></div>`, async (form, element) => {
      const result = await write('/api/internet/redeem', { method: 'POST', body: { creditId: credit.id, deviceId: form.get('deviceId'), mutationId: operationId } }, element);
      if (!result) return; ctx.dialog.close(); ctx.toast(`${credit.minutes} minutes redeemed. Your free get-ready countdown starts when Internet access is confirmed.`); location.hash = ctx.frame() ? 'today' : 'devices'; await load();
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
    ctx.openDialog(`Grant time · ${device.name}`, `<div class="form-stack"><label class="field"><span>Child</span><select name="personId" aria-label="Child">${choices.map(person => `<option value="${h(person.id)}">${h(person.name)}</option>`).join('')}</select></label>${ctx.field('Minutes', 'minutes', '60', { type: 'number', extra: 'min="1" max="1439" step="1"' })}${allDayAvailable() ? check('All day', 'allDay', false)+`<p class="field-help">All day ends at ${h(midnight())}. This is separate from earned rewards.</p>` : '<p class="field-help">Choose minutes. All-day access is not available yet.</p>'}<p class="field-help">Timed sessions include a free five-minute get-ready buffer before usage time. Adding time to an existing session extends its countdown.</p>${ctx.field('Reason (optional)', 'reason', '', { required: false, max: 500 })}<button class="button" type="submit">Request access window</button></div>`, async (form, element) => {
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
      ctx.openDialog(operation === 'adjust' ? 'Adjust session time' : operation === 'all_day' ? 'Allow until household midnight' : 'End this session', `<div class="form-stack"><p>${h(personName(session.personId))} · ${h(deviceName(session.deviceId))}</p>${operation === 'adjust' ? ctx.field('Add or remove minutes', 'deltaMinutes', '15', { type: 'number', extra: 'min="-1440" max="1440" step="1"' }) : operation === 'all_day' ? `<p>Ends at ${h(midnight())}, including while paused.</p>` : '<p>Access stays unconfirmed until blocking is verified.</p>'}${ctx.field('Reason (optional)', 'reason', '', { required: false, max: 500 })}<button type="submit" class="button ${operation === 'end' ? 'button-danger' : ''}">${operation === 'end' ? 'End now' : 'Apply change'}</button></div>`, async (form, formElement) => {
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
      const historyRows = rows => `<ol class="history-list">${rows.map(item => `<li><strong>${h(item.type.replaceAll('_', ' '))}</strong><span>${h(item.personId ? personName(item.personId) : 'Family')} · ${h(item.deviceId ? deviceName(item.deviceId) : '')}</span><small>${h(stamp(item.createdAt))}</small>${item.reason ? `<p>${h(item.reason)}</p>` : ''}</li>`).join('') || '<li>No Internet time changes in this selection.</li>'}</ol>`;
      ctx.openDialog('Internet time history', `<p class="supporting">Filters apply to the latest 100 recorded events. Requested changes and confirmed network results are separate.</p><div class="form-stack">${ctx.field('From date (optional)', 'from', '', {type:'date',required:false})}${ctx.field('Through date (optional)', 'through', '', {type:'date',required:false})}${state.data.role !== 'child' ? `<label class="field"><span>Family profile</span><select name="personId"><option value="">Everyone</option>${people().map(person=>`<option value="${h(person.id)}">${h(person.name)}</option>`).join('')}</select></label>` : ''}<button type="submit" class="button button-secondary">Filter history</button></div><div data-internet-history>${historyRows(result.history)}</div>`, async form => {
        const from = form.get('from'), through = form.get('through'), person = form.get('personId');
        const rows = result.history.filter(item => {
          const date = Number.isFinite(Date.parse(item.createdAt)) ? dateInZone(new Date(item.createdAt), ctx.zone()) : '';
          return (!person || item.personId === person) && (!from || date >= from) && (!through || date <= through);
        });
        ctx.dialog.querySelector('[data-internet-history]').innerHTML = historyRows(rows);
      }); return true;
    }
    return false;
  }
  function actionVersion(name, id) {
    const list = name.startsWith('device-') ? state.data?.devices : name === 'session-control' ? state.data?.sessions : name.startsWith('reward-') ? state.data?.credits : [];
    const item = list?.find(row=>row.id===id);
    return item ? JSON.stringify([item.id,item.version,item.status,item.state,item.desiredAccess,item.observedAccess]) : null;
  }
  function tick() {
    const time = now();
    ctx.soundTimers?.((state.data?.sessions || []).map(session => sessionSoundState(session, state.data.policies.find(policy => policy.personId === session.personId)?.warningMinutes, time)),
      !!state.data && !state.error && state.serverMs !== null && performance.now() - state.monoMs < 45000);
    for (const element of document.querySelectorAll('[data-session-remaining]')) {
      const session = state.data?.sessions.find(item => item.id === element.dataset.sessionRemaining);
      if (!session) continue;
      const value = remainingLabel(sessionCountdown(session, now()).remaining);
      if (element.textContent !== value) element.textContent = value;
    }
    for (const element of document.querySelectorAll('[data-session-clock]')) {
      const session = state.data?.sessions.find(item => item.id === element.dataset.sessionClock);
      if (!session) continue;
      const value = sessionCountdown(session, now()), previous = state.phases.get(session.id);
      const sincePreparation = now() - Date.parse(session.preparationEndsAt);
      if (previous === 'preparation' && value.phase === 'usage' && session.state === 'active' && !state.error && value.remaining > 0 && sincePreparation >= 0 && sincePreparation < 4500)
        state.rolloverUntil.set(session.id, performance.now() + 4500);
      state.phases.set(session.id, value.phase);
      element.dataset.phase = value.phase;
      element.classList.toggle('just-started', (state.rolloverUntil.get(session.id) || 0) > performance.now());
      const label = element.querySelector('[data-session-phase]');
      if (label && label.textContent !== value.label) label.textContent = value.label;
      element.querySelector('.ring-progress')?.style.setProperty('stroke-dashoffset', String(1-value.progress));
    }
  }
  return { actionVersion, load, view, action, summary, personSummary, tick, reset, loaded: () => !!state.data, writing: () => state.writing.size > 0 };
}
