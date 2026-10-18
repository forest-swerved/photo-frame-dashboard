import { request, setFrameAccess, frameAccessStatus } from './api.js';
import { escapeHtml as h, color, dateLabel, addDays, dateFormatter, mutationId } from './model.js';
import { routinePayload } from './occurrences.js';

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const check = (label, name, checked) => `<label class="checkbox-label"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span>${h(label)}</span></label>`;
const selectPerson = (people, current = '', optional = true) => `<label class="field"><span>Family profile</span><select name="personId" aria-label="Family profile">${optional ? '<option value="">Everyone / unassigned</option>' : ''}${people.map(person => `<option value="${h(person.id)}" ${person.id === current ? 'selected' : ''}>${h(person.name)}</option>`).join('')}</select></label>`;

export function createWorkbench(ctx) {
  let state = { activity: null, activityError: '', activityBusy: false, exceptions: [], access: null };
  const person = id => ctx.snapshot()?.people.find(item => item.id === id)?.name || 'Family';
  const routines = () => ctx.snapshot()?.routines || ctx.snapshot()?.chores || [];
  const stamp = value => value ? dateFormatter({ timeZone: ctx.zone(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '';
  const epoch = () => ctx.epoch();
  function reset() { state = { activity: null, activityError: '', activityBusy: false, exceptions: [], access: null }; }
  function editRoutine(routine, personId = '') {
    ctx.openDialog(routine ? 'Edit chore routine' : 'Add a chore', `<div class="form-stack">${ctx.field('Chore', 'title', routine?.title || '', { max: 100 })}${selectPerson(ctx.snapshot()?.people || [], routine?.personId || personId)}<label class="field"><span>Schedule</span><select name="scheduleType" aria-label="Schedule" data-schedule-type><option value="weekly" ${routine?.scheduleType !== 'one_off' ? 'selected' : ''}>Weekly routine</option><option value="one_off" ${routine?.scheduleType === 'one_off' ? 'selected' : ''}>One-off chore</option></select></label><div data-one-off ${routine?.scheduleType !== 'one_off' ? 'hidden' : ''}>${ctx.field('One-off date', 'scheduledDate', routine?.scheduledDate || ctx.today(), { type: 'date', required: false })}</div><fieldset class="weekday-picker" data-weekly ${routine?.scheduleType === 'one_off' ? 'hidden' : ''}><legend>Repeats on</legend>${days.map((day, index) => `<label><input type="checkbox" name="weekdays" value="${index}" ${(routine?.weekdays || [0, 1, 2, 3, 4, 5, 6]).includes(index) ? 'checked' : ''}><span>${day}</span></label>`).join('')}</fieldset>${check('Required for daily rewards', 'required', routine?.required !== false)}${check('A parent must approve completion', 'requiresApproval', routine?.requiresApproval === true)}<label class="field"><span>Instructions</span><textarea name="instructions" maxlength="3000" rows="3">${h(routine?.instructions || '')}</textarea></label><label class="field"><span>Steps · one per line, up to 20</span><textarea name="subtasks" rows="4" maxlength="3400">${h((routine?.subtasks || []).map(step => step.title).join('\n'))}</textarea></label>${ctx.field('Due by (optional)', 'dueTime', routine?.dueTime || '', { type: 'time', required: false })}<label class="field"><span>Early reminder</span><select name="reminderMinutes" aria-label="Early reminder">${[...new Set([0, 5, 15, 30, 60, routine?.reminderMinutes ?? 15])].sort((a, b) => a - b).map(value => `<option value="${value}" ${value === (routine?.reminderMinutes ?? 15) ? 'selected' : ''}>${value ? `${value} minutes before` : 'No early reminder'}</option>`).join('')}</select></label><p class="field-help">Times use ${h(ctx.zone())}. Existing daily chores keep the instructions and assignment saved when they were created. Changes apply to future occurrences.</p><div class="dialog-actions">${routine ? ctx.button('Delete routine', 'delete-chore', 'text-button danger-text', `data-id="${h(routine.id)}"`) : ''}<button type="submit" class="button">Save chore</button></div></div>`, async (form, element) => {
      const started = epoch();
      const payload = routinePayload(form, routine);
      try { await request(`/api/chores${routine ? `/${encodeURIComponent(routine.id)}` : ''}`, { method: routine ? 'PATCH' : 'POST', body: payload }); }
      catch (error) {
        if (error.status === 0 || error.status >= 500 || error.status === 409) {
          element.dataset.reviewRequired = 'true';
          throw new Error('This save needs review before another attempt. Close this editor and refresh your chores to check the latest routine.');
        }
        throw error;
      }
      if (started !== epoch()) return;
      ctx.dialog.close(); ctx.toast('Chore routine saved.'); await ctx.reload();
    });
    const schedule = ctx.dialog.querySelector('[data-schedule-type]');
    schedule.onchange = () => {
      ctx.dialog.querySelector('[data-one-off]').hidden = schedule.value !== 'one_off';
      ctx.dialog.querySelector('[data-weekly]').hidden = schedule.value === 'one_off';
    };
  }
  function occurrence(id) { return ctx.snapshot()?.occurrences?.find(item => item.id === id); }
  function actOnOccurrence(item, action) {
    const operationId = mutationId();
    const reasons = ['reject', 'skip', 'reschedule'].includes(action);
    const labels = { approve: 'Approve chore', reject: 'Return for changes', skip: 'Excuse this chore', reschedule: 'Reschedule chore' };
    ctx.openDialog(labels[action], `<div class="form-stack"><p>${h(item.title)} · ${h(person(item.personId))}</p>${reasons ? ctx.field('Reason', 'reason', '', { max: 500 }) : ''}${action === 'reschedule' ? `${ctx.field('Move to date', 'toDate', addDays(ctx.today(), 1), { type: 'date' })}${ctx.field('Due by (optional)', 'dueTime', item.dueTime || '', { type: 'time', required: false })}` : ''}<p class="field-help">This changes this daily chore. Its routine and earlier history are kept.</p><button type="submit" class="button">${labels[action]}</button></div>`, async form => {
      const started = epoch();
      await request(`/api/chore-occurrences/${encodeURIComponent(item.id)}/actions`, { method: 'POST', body: { action, expectedVersion: item.version, mutationId: operationId,
        ...(reasons ? { reason: form.get('reason').trim() } : {}), ...(action === 'reschedule' ? { toDate: form.get('toDate'), dueTime: form.get('dueTime') || null } : {}) } });
      if (started !== epoch()) return;
      ctx.dialog.close(); ctx.toast('Daily chore updated.'); await ctx.reload();
    });
  }
  async function history() {
    const started = epoch();
    const data = await request(`/api/chore-history?from=${addDays(ctx.today(), -6)}&to=${addDays(ctx.today(), 1)}`);
    if (started !== epoch()) return;
    const results = rows => rows.length ? `<ol class="history-list">${rows.map(item => `<li><strong>${h(item.title)}</strong><span>${h(item.personName || 'Family')} · ${h(item.type.replaceAll('_', ' '))}</span><small>${h(item.actorName || 'Family member')} · ${h(stamp(item.createdAt))}</small>${item.reason ? `<p>${h(item.reason)}</p>` : ''}</li>`).join('')}</ol>` : '<p class="quiet-empty">No changes in this date range.</p>';
    ctx.openDialog('Chore history', `<div class="form-stack">${ctx.field('From date', 'from', addDays(ctx.today(), -6), { type: 'date' })}${ctx.field('Through date', 'through', ctx.today(), { type: 'date' })}${ctx.session()?.role !== 'child' ? selectPerson(ctx.snapshot()?.people || []) : ''}<button type="submit" class="button button-secondary">Filter history</button></div><div data-history-results>${results(data.history || [])}</div>`, async form => {
      const query = new URLSearchParams({ from: form.get('from'), to: addDays(form.get('through'), 1) });
      if (form.get('personId')) query.set('personId', form.get('personId'));
      const result = await request(`/api/chore-history?${query}`);
      if (started === epoch() && ctx.dialog.open) ctx.dialog.querySelector('[data-history-results]').innerHTML = results(result.history || []);
    });
  }
  async function breaks() {
    const started = epoch(), operationId = mutationId();
    const data = await request('/api/chore-exceptions');
    if (started !== epoch()) return;
    state.exceptions = data.exceptions || [];
    ctx.openDialog('School holidays & chore breaks', `<p class="supporting">Excuse unfinished chores for a date range. Completed work and its history stay intact.</p><div class="form-stack">${ctx.field('First day', 'fromDate', ctx.today(), { type: 'date' })}${ctx.field('Last day (included)', 'throughDate', ctx.today(), { type: 'date' })}${selectPerson(ctx.snapshot()?.people || [])}<label class="field"><span>Chore</span><select name="choreId" aria-label="Chore"><option value="">All chores</option>${routines().map(item => `<option value="${h(item.id)}">${h(item.title)}</option>`).join('')}</select></label>${ctx.field('Reason', 'reason', '', { max: 500 })}<button type="submit" class="button">Add chore break</button></div><div class="break-list">${state.exceptions.filter(item => !item.revokedAt).map(item => `<div><strong>${h(item.reason)}</strong><p>${h(item.fromDate)} through ${h(addDays(item.toDateExclusive, -1))} · ${h(person(item.personId))}</p>${ctx.button('End this break', 'revoke-break', 'text-button', `data-id="${h(item.id)}"`)}</div>`).join('')}</div>`, async form => {
      await request('/api/chore-exceptions', { method: 'POST', body: { fromDate: form.get('fromDate'), toDateExclusive: addDays(form.get('throughDate'), 1), personId: form.get('personId') || null, choreId: form.get('choreId') || null, reason: form.get('reason').trim(), mutationId: operationId } });
      if (started !== epoch()) return;
      ctx.dialog.close(); ctx.toast('Chore break saved.'); await ctx.reload();
    });
  }
  async function loadActivity() {
    if (ctx.frame() || state.activityBusy) return;
    const started = epoch(); state.activityBusy = true; ctx.render();
    try { const data = await request('/api/notifications'); if (started === epoch()) { state.activity = data.notifications || []; state.activityError = ''; } }
    catch (error) { if (started === epoch()) state.activityError = error.message; }
    finally { if (started === epoch()) { state.activityBusy = false; ctx.render(); } }
  }
  function activityView() {
    if (ctx.frame()) return '<section class="panel"><h2>Your private Activity</h2><p class="supporting">Open Activity in your signed-in phone app. The shared frame keeps account messages private.</p></section>';
    return `<section class="panel activity-panel" data-key="activity"><div class="section-heading"><h2>Family activity</h2>${ctx.button(state.activityBusy ? 'Refreshing…' : 'Refresh', 'activity-refresh', 'text-button')}</div>${state.activityError ? `<p class="form-error" role="alert">${h(state.activityError)}</p>` : ''}${state.activity === null ? '<p>Loading your Activity…</p>' : state.activity.length ? `<div class="activity-list">${state.activity.map(item => `<article data-key="notification-${h(item.id)}" class="activity-item ${item.readAt ? '' : 'unread'}"><div><h3>${h(item.title)}</h3><p>${h(item.body)}</p><small>${h(stamp(item.createdAt))}</small></div><div class="occurrence-controls">${ctx.button('Open', 'activity-open', 'text-button', `data-id="${h(item.id)}"`)}${!item.readAt ? ctx.button('Mark read', 'activity-read', 'text-button', `data-id="${h(item.id)}"`) : '<span class="badge">Read</span>'}</div></article>`).join('')}</div>` : '<p class="quiet-empty">You’re all caught up. Chore, calendar, and device updates will appear here.</p>'}</section>`;
  }
  async function preferences() {
    const started = epoch(), value = await request('/api/notification-preferences');
    if (started !== epoch()) return;
    const fields = { pushEnabled: 'Push notifications', choreCompleted: 'Chores completed', choreReopened: 'Chores reopened', choreDueSoon: 'Due soon', choreOverdue: 'Overdue', rewards: 'Rewards earned', internetSessions: 'Internet sessions', ...(ctx.session()?.role !== 'child' ? { calendarEvents: 'Calendar reminders', frameStatus: 'Frame connection status' } : {}) };
    ctx.openDialog('Notifications & quiet hours', `<div class="form-stack">${Object.entries(fields).map(([name, label]) => check(label, name, value[name] !== false)).join('')}${check('Enable quiet hours', 'quiet', !!value.quietStart && !!value.quietEnd)}${ctx.field('Quiet hours start', 'quietStart', value.quietStart || '21:00', { type: 'time', required: false })}${ctx.field('Quiet hours end', 'quietEnd', value.quietEnd || '07:00', { type: 'time', required: false })}<p class="field-help">Times follow ${h(value.timezone || ctx.zone())}. Your Activity remains available during quiet hours. For iPhone push delivery, also allow notifications in the native iOS app.</p><button type="submit" class="button">Save preferences</button></div>`, async form => {
      const body = Object.fromEntries(Object.keys(fields).map(key => [key, form.has(key)]));
      body.quietStart = form.has('quiet') ? form.get('quietStart') : null;
      body.quietEnd = form.has('quiet') ? form.get('quietEnd') : null;
      await request('/api/notification-preferences', { method: 'PUT', body });
      if (started === epoch()) { ctx.dialog.close(); ctx.toast('Notification preferences saved.'); }
    });
  }
  function unlockPanel() {
    if (ctx.frame()) {
      const access = frameAccessStatus();
      return `<section class="panel setup-card"><h2>${access ? `${access.scope === 'parent' ? 'Parent' : person(access.personId)} controls unlocked` : 'Unlock private controls'}</h2><p class="supporting">${access ? `This approval expires at ${h(stamp(access.expiresAt))}. Lock the frame when you finish.` : 'Create a short-lived unlock code from your signed-in phone. A family profile alone cannot spend a reward or change Internet access.'}</p>${ctx.button(access ? 'Lock controls now' : 'Enter unlock code', access ? 'frame-lock' : 'frame-unlock', 'button button-secondary')}</section>`;
    }
    return `<section class="panel setup-card"><h2>Notifications & frame access</h2><p class="supporting">Your inbox and preferences follow your family account. Frame unlock codes grant temporary, scoped access.</p><div class="form-stack">${ctx.button('Notification preferences', 'notification-preferences', 'button button-secondary')}${ctx.button('Create frame unlock code', 'create-frame-access', 'button button-secondary')}</div></section>`;
  }
  function unlock() {
    ctx.openDialog('Unlock frame controls', `<p class="supporting">On a signed-in phone, open Setup → Create frame unlock code. Enter that six-digit code here.</p><div class="form-stack">${ctx.field('Unlock code', 'code', '', { max: 6, extra: 'inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"' })}<button type="submit" class="button">Unlock controls</button></div>`, async (form, element) => {
      const started = epoch();
      let data;
      try { data = await request('/api/frame-access/redeem', { method: 'POST', body: { code: form.get('code').trim() } }); }
      finally { element.querySelector('[name="code"]').value = ''; form.delete('code'); }
      if (started !== epoch()) return;
      setFrameAccess(data); state.access = { scope: data.scope, personId: data.personId, expiresAt: data.expiresAt };
      ctx.session().personId = data.personId;
      ctx.dialog.close(); ctx.toast('Frame controls unlocked temporarily.'); await ctx.reload();
    });
  }
  function createAccess() {
    const session = ctx.session(), child = session?.role === 'child';
    ctx.openDialog('Create a frame unlock code', `<div class="form-stack">${child ? `<input type="hidden" name="scope" value="child"><input type="hidden" name="personId" value="${h(session.personId)}"><p>Unlock your own rewards on the family frame.</p>` : `<label class="field"><span>Allow</span><select name="scope" aria-label="Frame access scope"><option value="parent">My parent controls</option><option value="child">One child’s rewards</option></select></label>${selectPerson(ctx.snapshot()?.people || [], '', false)}`}<p class="field-help">Codes are private, single-use and expire after five minutes. The frame unlock lasts ten minutes. Creating a new code replaces your previous unlock.</p><button type="submit" class="button">Create code</button></div><div data-unlock-result></div>`, async form => {
      const started = epoch();
      const scope = form.get('scope');
      const data = await request('/api/frame-access-codes', { method: 'POST', body: { scope, ...(scope === 'child' ? { personId: form.get('personId') } : {}) } });
      if (started !== epoch() || !ctx.dialog.open) return;
      ctx.dialog.querySelector('[data-unlock-result]').innerHTML = `<div class="share-result"><strong class="pairing-code">${h(data.code)}</strong><span>For ${h(data.scope === 'parent' ? 'parent controls' : person(data.personId))} · expires ${h(stamp(data.expiresAt))}</span><span>Enter this code only on your paired frame.</span></div>`;
    });
  }
  async function action(name, element) {
    if (name === 'chore-history') { await history(); return true; }
    if (name === 'chore-breaks') { await breaks(); return true; }
    if (name === 'occurrence-action') { const item = occurrence(element.dataset.id); if (item) actOnOccurrence(item, element.dataset.operation); return true; }
    if (name === 'occurrence-step') {
      const item = occurrence(element.dataset.id); if (!item || item.status !== 'pending') return true;
      const started = epoch(), selected = item.subtasks.filter(step => step.id === element.dataset.stepId ? !step.completed : step.completed).map(step => step.id);
      element.disabled = true;
      try { await request(`/api/chore-occurrences/${encodeURIComponent(item.id)}/actions`, { method: 'POST', body: { action: 'subtasks', expectedVersion: item.version, mutationId: mutationId(), completedSubtaskIds: selected } }); if (started === epoch()) await ctx.reload(); }
      finally { if (element.isConnected) element.disabled = false; }
      return true;
    }
    if (name === 'revoke-break') {
      const item = state.exceptions.find(row => row.id === element.dataset.id), operationId = mutationId(); if (!item) return true;
      ctx.openDialog('End this chore break', `<div class="form-stack">${ctx.field('Reason', 'reason', '', { max: 500 })}<p class="field-help">Unfinished chores excused by this break can return today and on future dates. Earlier history stays intact.</p><button type="submit" class="button">End break</button></div>`, async form => {
        await request(`/api/chore-exceptions/${encodeURIComponent(item.id)}/revoke`, { method: 'POST', body: { expectedVersion: item.version, reason: form.get('reason').trim(), mutationId: operationId } });
        ctx.dialog.close(); await ctx.reload();
      }); return true;
    }
    if (name === 'activity-refresh') { await loadActivity(); return true; }
    if (name === 'activity-open' || name === 'activity-read') {
      const started = epoch(), item = state.activity?.find(row => row.id === element.dataset.id); if (!item) return true;
      element.disabled = true;
      try {
        if (!item.readAt) await request(`/api/notifications/${encodeURIComponent(item.id)}/read`, { method: 'POST', body: {} });
        if (started !== epoch()) return true;
        item.readAt = new Date().toISOString(); ctx.render();
        if (name === 'activity-open') location.hash = ['today', 'chores', 'devices'].includes(item.target) ? item.target : 'chores';
      } finally { if (element.isConnected) element.disabled = false; }
      return true;
    }
    if (name === 'notification-preferences') { await preferences(); return true; }
    if (name === 'frame-unlock') { unlock(); return true; }
    if (name === 'create-frame-access') { createAccess(); return true; }
    if (name === 'frame-lock') { setFrameAccess(null); state.access = null; await ctx.reboot(); return true; }
    if (name === 'member-capabilities') {
      const item = ctx.members().find(row => row.id === element.dataset.id); if (!item) return true;
      ctx.openDialog('Caregiver permissions', `<div class="form-stack"><p>${h(item.name)}</p>${check('Manage routines, approvals and chore breaks', 'manageChores', item.capabilities?.manageChores)}${check('Manage devices and Internet time', 'manageInternet', item.capabilities?.manageInternet)}<button type="submit" class="button">Save permissions</button></div>`, async form => {
        await request(`/api/members/${encodeURIComponent(item.id)}/capabilities`, { method: 'PATCH', body: { manageChores: form.has('manageChores'), manageInternet: form.has('manageInternet') } });
        ctx.dialog.close(); await ctx.reloadSetup();
      }); return true;
    }
    return false;
  }
  return { reset, editRoutine, action, loadActivity, activityView, unlockPanel, accessExpired: () => !!state.access && !frameAccessStatus() };
}
