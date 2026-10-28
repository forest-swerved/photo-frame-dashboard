import { request, setFrameAccess, frameAccessStatus } from './api.js';
import { escapeHtml as h, color, dateLabel, addDays, dateFormatter, dateInZone, mutationId } from './model.js';
import { routinePayload } from './occurrences.js';
import { createSchoolCalendarUI } from './school-calendar-ui.js';
import { openTaskWizard } from './task-wizard.js';

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const check = (label, name, checked) => `<label class="checkbox-label"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span>${h(label)}</span></label>`;
const selectPerson = (people, current = '', optional = true) => `<label class="field"><span>Family profile</span><select name="personId" aria-label="Family profile">${optional ? '<option value="">Everyone / unassigned</option>' : ''}${people.map(person => `<option value="${h(person.id)}" ${person.id === current ? 'selected' : ''}>${h(person.name)}</option>`).join('')}</select></label>`;

export function frameCodeScopes(session, capabilities = {}) {
  if (!session || session.authType === 'frame') return [];
  if (session.role === 'child') return session.personId ? ['child'] : [];
  const admin = session.role === 'admin', internet = admin || capabilities.manageInternet === true;
  return [...(admin || capabilities.manageChores === true || internet ? ['parent'] : []), ...(internet ? ['child'] : [])];
}

export function createWorkbench(ctx) {
  const schoolCalendar = createSchoolCalendarUI(ctx);
  let state = { activity: null, activityError: '', activityBusy: false, exceptions: [], access: null };
  const person = id => ctx.snapshot()?.people.find(item => item.id === id)?.name || 'Family';
  const routines = () => ctx.snapshot()?.routines || ctx.snapshot()?.chores || [];
  const stamp = value => value ? dateFormatter({ timeZone: ctx.zone(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '';
  const epoch = () => ctx.epoch();
  const activeForm = element => ctx.dialog.open && ctx.dialog.querySelector('form') === element;
  const closeForm = element => { if (activeForm(element)) ctx.dialog.close(); };
  function reset() { state = { activity: null, activityError: '', activityBusy: false, exceptions: [], access: null }; }
  function editRoutine(routine, personId = '', defaults = {}) {
    if (!routine) return openTaskWizard(ctx, { personId, ...defaults });
    const schoolFilterValue = routine?.schoolDayFilter || defaults.schoolDayFilter || 'any';
    const taskSectionValue = routine?.taskSection || (routine ? 'tasks' : defaults.taskSection || 'before_school');
    ctx.openDialog(routine ? 'Edit task routine' : 'Add a task', `<div class="form-stack">${ctx.field('Task', 'title', routine?.title || '', { max: 100 })}${selectPerson(ctx.snapshot()?.people || [], routine?.personId || personId)}<label class="field"><span>Schedule</span><select name="scheduleType" aria-label="Schedule" data-schedule-type><option value="weekly" ${routine?.scheduleType !== 'one_off' ? 'selected' : ''}>Weekly routine</option><option value="one_off" ${routine?.scheduleType === 'one_off' ? 'selected' : ''}>One-off task</option></select></label><label class="field" data-school-filter ${routine?.scheduleType === 'one_off' ? 'hidden' : ''}><span>School-day schedule</span><select name="schoolDayFilter" aria-label="School-day schedule"><option value="any" ${schoolFilterValue === 'any' ? 'selected' : ''}>Any day type</option><option value="school_day" ${schoolFilterValue === 'school_day' ? 'selected' : ''}>School days only</option><option value="non_school_day" ${schoolFilterValue === 'non_school_day' ? 'selected' : ''}>Non-school days only</option></select></label><label class="field" data-task-section ${routine?.scheduleType === 'one_off' || schoolFilterValue === 'non_school_day' ? 'hidden' : ''}><span>School-day task section</span><select name="taskSection" aria-label="School-day task section"><option value="before_school" ${taskSectionValue === 'before_school' ? 'selected' : ''}>Before school</option><option value="after_school" ${taskSectionValue === 'after_school' ? 'selected' : ''}>After school</option><option value="tasks" ${taskSectionValue === 'tasks' ? 'selected' : ''}>Any time</option></select></label><p class="field-help">School-day filters apply to weekly routines within the repeat days you select. Days off use non-school-day tasks; they do not excuse every task. One-off tasks use their own date.</p><div data-one-off ${routine?.scheduleType !== 'one_off' ? 'hidden' : ''}>${ctx.field('One-off date', 'scheduledDate', routine?.scheduledDate || ctx.today(), { type: 'date', required: false })}</div><fieldset class="weekday-picker" data-weekly ${routine?.scheduleType === 'one_off' ? 'hidden' : ''}><legend>Repeats on</legend>${days.map((day, index) => `<label><input type="checkbox" name="weekdays" value="${index}" ${(routine?.weekdays || [0, 1, 2, 3, 4, 5, 6]).includes(index) ? 'checked' : ''}><span>${day}</span></label>`).join('')}</fieldset>${check('Required for daily rewards', 'required', routine?.required !== false)}${check('A parent must approve completion', 'requiresApproval', routine?.requiresApproval === true)}<details class="advanced-fields" ${routine?.instructions || routine?.subtasks?.length ? 'open' : ''}><summary>Instructions & checklist</summary><label class="field"><span>Instructions</span><textarea name="instructions" maxlength="3000" rows="3">${h(routine?.instructions || '')}</textarea></label><label class="field"><span>Steps · one per line, up to 20</span><textarea name="subtasks" rows="4" maxlength="3400">${h((routine?.subtasks || []).map(step => step.title).join('\n'))}</textarea></label></details><details class="advanced-fields" ${routine?.dueTime ? 'open' : ''}><summary>Deadline & reminders</summary>${ctx.field('Due by (optional)', 'dueTime', routine?.dueTime || '', { type: 'time', required: false })}<label class="field"><span>Early reminder</span><select name="reminderMinutes" aria-label="Early reminder">${[...new Set([0, 5, 15, 30, 60, routine?.reminderMinutes ?? 15])].sort((a, b) => a - b).map(value => `<option value="${value}" ${value === (routine?.reminderMinutes ?? 15) ? 'selected' : ''}>${value ? `${value} minutes before` : 'No early reminder'}</option>`).join('')}</select></label></details><p class="field-help">Times use ${h(ctx.zone())}. Existing daily tasks keep the instructions and assignment saved when they were created. Changes apply to future occurrences.</p><div class="dialog-actions">${routine ? ctx.button('Delete routine', 'delete-chore', 'text-button danger-text', `data-id="${h(routine.id)}"`) : ''}<button type="submit" class="button">Save task</button></div></div>`, async (form, element) => {
      const started = epoch();
      const payload = routinePayload(form, routine);
      try { await request(`/api/chores${routine ? `/${encodeURIComponent(routine.id)}` : ''}`, { method: routine ? 'PATCH' : 'POST', body: payload }); }
      catch (error) {
        if (error.status === 0 || error.status >= 500 || error.status === 409) {
          element.dataset.reviewRequired = 'true';
          throw new Error('This save needs review before another attempt. Close this editor and refresh your tasks to check the latest routine.');
        }
        throw error;
      }
      if (started !== epoch()) return;
      closeForm(element); ctx.toast('Task routine saved.'); await ctx.reload();
    });
    const schedule = ctx.dialog.querySelector('[data-schedule-type]');
    schedule.onchange = () => {
      ctx.dialog.querySelector('[data-one-off]').hidden = schedule.value !== 'one_off';
      ctx.dialog.querySelector('[data-weekly]').hidden = schedule.value === 'one_off';
      ctx.dialog.querySelector('[data-school-filter]').hidden = schedule.value === 'one_off';
      if (schedule.value === 'one_off') ctx.dialog.querySelector('[name="schoolDayFilter"]').value = 'any';
      updateTaskSection();
    };
    const schoolFilter = ctx.dialog.querySelector('[name="schoolDayFilter"]');
    const section = ctx.dialog.querySelector('[name="taskSection"]');
    function updateTaskSection() {
      const visible = schedule.value === 'weekly' && schoolFilter.value !== 'non_school_day';
      ctx.dialog.querySelector('[data-task-section]').hidden = !visible;
      if (!visible) section.value = 'tasks';
    }
    schoolFilter.onchange = () => {
      if (!routine && schoolFilter.value === 'school_day') section.value = 'before_school';
      updateTaskSection();
    };
  }
  function occurrence(id) { return ctx.snapshot()?.occurrences?.find(item => item.id === id); }
  function actOnOccurrence(item, action) {
    const operationId = mutationId();
    const reasons = ['reject', 'skip', 'reschedule'].includes(action);
    const labels = { approve: 'Approve task', reject: 'Return for changes', skip: 'Excuse this task', reschedule: 'Reschedule task' };
    ctx.openDialog(labels[action], `<div class="form-stack"><p>${h(item.title)} · ${h(person(item.personId))}</p>${reasons ? ctx.field('Reason', 'reason', '', { max: 500 }) : ''}${action === 'reschedule' ? `${ctx.field('Move to date', 'toDate', addDays(ctx.today(), 1), { type: 'date' })}${ctx.field('Due by (optional)', 'dueTime', item.dueTime || '', { type: 'time', required: false })}` : ''}<p class="field-help">This changes this daily task. Its routine and earlier history are kept.</p><button type="submit" class="button">${labels[action]}</button></div>`, async (form, element) => {
      const started = epoch();
      await request(`/api/chore-occurrences/${encodeURIComponent(item.id)}/actions`, { method: 'POST', body: { action, expectedVersion: item.version, mutationId: operationId,
        ...(reasons ? { reason: form.get('reason').trim() } : {}), ...(action === 'reschedule' ? { toDate: form.get('toDate'), dueTime: form.get('dueTime') || null } : {}) } });
      if (started !== epoch()) return;
      closeForm(element); ctx.toast('Daily task updated.'); await ctx.reload();
    });
  }
  async function history() {
    const started = epoch();
    const data = await request(`/api/chore-history?from=${addDays(ctx.today(), -6)}&to=${addDays(ctx.today(), 1)}`);
    if (started !== epoch() || ctx.dialog.open) return;
    const results = rows => rows.length ? `<ol class="history-list">${rows.map(item => `<li><strong>${h(item.title)}</strong><span>${h(item.personName || 'Family')} · ${h(item.type.replaceAll('_', ' '))}</span><small>${h(item.actorName || 'Family member')} · ${h(stamp(item.createdAt))}</small>${item.reason ? `<p>${h(item.reason)}</p>` : ''}</li>`).join('')}</ol>` : '<p class="quiet-empty">No changes in this date range.</p>';
    ctx.openDialog('Task history', `<p class="supporting">Latest 100 changes in the selected household dates. Narrow by date or person to find older work.</p><div class="form-stack">${ctx.field('From date', 'from', addDays(ctx.today(), -6), { type: 'date' })}${ctx.field('Through date', 'through', ctx.today(), { type: 'date' })}${ctx.session()?.role !== 'child' ? selectPerson(ctx.snapshot()?.people || []) : ''}<button type="submit" class="button button-secondary">Filter history</button></div><div data-history-results>${results(data.history || [])}</div>`, async (form, element) => {
      const query = new URLSearchParams({ from: form.get('from'), to: addDays(form.get('through'), 1) });
      if (form.get('personId')) query.set('personId', form.get('personId'));
      const result = await request(`/api/chore-history?${query}`);
      if (started === epoch() && activeForm(element)) ctx.dialog.querySelector('[data-history-results]').innerHTML = results(result.history || []);
    });
  }
  async function breaks() {
    const started = epoch(), operationId = mutationId();
    const data = await request('/api/chore-exceptions');
    if (started !== epoch() || ctx.dialog.open) return;
    state.exceptions = data.exceptions || [];
    ctx.openDialog('Task breaks', `<p class="supporting">Pause tasks for a trip or time away. Excuse unfinished tasks for a date range. Use School calendar to switch between school-day and non-school-day tasks instead. Completed work and its history stay intact.</p><div class="form-stack">${ctx.field('First day', 'fromDate', ctx.today(), { type: 'date' })}${ctx.field('Last day (included)', 'throughDate', ctx.today(), { type: 'date' })}${selectPerson(ctx.snapshot()?.people || [])}<label class="field"><span>Task</span><select name="choreId" aria-label="Task"><option value="">All tasks</option>${routines().map(item => `<option value="${h(item.id)}">${h(item.title)}</option>`).join('')}</select></label>${ctx.field('Reason', 'reason', '', { max: 500 })}<button type="submit" class="button">Add task break</button></div><div class="break-list">${state.exceptions.filter(item => !item.revokedAt).map(item => `<div><strong>${h(item.reason)}</strong><p>${h(item.fromDate)} through ${h(addDays(item.toDateExclusive, -1))} · ${h(person(item.personId))}</p>${ctx.button('End this break', 'revoke-break', 'text-button', `data-id="${h(item.id)}"`)}</div>`).join('')}</div>`, async (form, element) => {
      await request('/api/chore-exceptions', { method: 'POST', body: { fromDate: form.get('fromDate'), toDateExclusive: addDays(form.get('throughDate'), 1), personId: form.get('personId') || null, choreId: form.get('choreId') || null, reason: form.get('reason').trim(), mutationId: operationId } });
      if (started !== epoch()) return;
      closeForm(element); ctx.toast('Task break saved.'); await ctx.reload();
    });
    const form = ctx.dialog.querySelector('form');
    const summary = document.createElement('p'); summary.className = 'scope-preview'; summary.setAttribute('aria-live', 'polite');
    ctx.dialog.querySelector('.dialog-footer').prepend(summary);
    function previewBreak() {
      const fields = new FormData(form), from = fields.get('fromDate'), through = fields.get('throughDate');
      const routine = routines().find(item => item.id === fields.get('choreId'));
      summary.textContent = `Pause ${routine?.title || 'unfinished tasks'} for ${fields.get('personId') ? person(fields.get('personId')) : 'everyone'} from ${from} through ${through}, inclusive. Completed and submitted work stays in history.`;
    }
    form.addEventListener('input', previewBreak); form.addEventListener('change', previewBreak); previewBreak();
  }
  async function loadActivity() {
    if (ctx.frame() || state.activityBusy) return;
    const started = epoch(); state.activityBusy = true; ctx.render();
    try { const data = await request('/api/notifications'); if (started === epoch()) { state.activity = data.notifications || []; state.activityError = ''; } }
    catch (error) { if (started === epoch()) state.activityError = error.message; }
    finally { if (started === epoch()) { state.activityBusy = false; ctx.render(); } }
  }
  function activityView() {
    if (ctx.frame()) return '<section class="panel"><h2>Your private Activity</h2><p class="supporting">Open Activity in your signed-in phone app.</p></section>';
    const groups = new Map();
    for (const item of state.activity || []) { const key = Number.isFinite(Date.parse(item.createdAt)) ? dateInZone(new Date(item.createdAt), ctx.zone()) : ''; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
    return `<section class="panel activity-panel" data-key="activity"><div class="section-heading"><h2>Family activity</h2>${ctx.button(state.activityBusy ? 'Refreshing…' : 'Refresh','activity-refresh','text-button')}</div>${state.activityError ? `<p class="form-error" role="alert">${h(state.activityError)}</p>` : ''}${state.activity === null ? '<p>Loading your Activity…</p>' : !state.activity.length ? '<p class="quiet-empty">You’re all caught up.</p>' : [...groups].map(([day,items])=>`<section class="activity-day"><h3>${h(day ? dateLabel(day, { year: 'numeric' }) : 'Earlier activity')}</h3>${items.map(item=>`<article data-key="notification-${h(item.id)}" class="activity-item ${item.readAt ? '' : 'unread'}"><button class="activity-open" data-action="activity-open" data-id="${h(item.id)}" aria-label="Open ${h(item.title)}"><h3>${h(item.title)}</h3><p>${h(item.body)}</p><small>${h(stamp(item.createdAt))}${item.readAt ? ' · Read' : ' · Unread'}</small></button>${!item.readAt ? ctx.button('Mark read','activity-read','text-button',`data-id="${h(item.id)}"`) : ''}</article>`).join('')}</section>`).join('')}</section>`;
  }

  async function preferences() {
    const started = epoch(), value = await request('/api/notification-preferences');
    if (started !== epoch() || ctx.dialog.open) return;
    const fields = { pushEnabled: 'Push notifications', choreCompleted: 'Tasks completed', choreReopened: 'Tasks reopened', choreDueSoon: 'Due soon', choreOverdue: 'Overdue', rewards: 'Rewards earned', internetSessions: 'Internet sessions', ...(ctx.session()?.role !== 'child' ? { calendarEvents: 'Calendar connection status', frameStatus: 'Frame connection status' } : {}) };
    ctx.openDialog('Notifications & quiet hours', `<div class="form-stack">${Object.entries(fields).map(([name, label]) => check(label, name, value[name] !== false)).join('')}${check('Enable quiet hours', 'quiet', !!value.quietStart && !!value.quietEnd)}${ctx.field('Quiet hours start', 'quietStart', value.quietStart || '21:00', { type: 'time', required: false })}${ctx.field('Quiet hours end', 'quietEnd', value.quietEnd || '07:00', { type: 'time', required: false })}<p class="field-help">Times follow ${h(value.timezone || ctx.zone())}. Your Activity remains available during quiet hours. For iPhone push delivery, also allow notifications in the native iOS app.</p><button type="submit" class="button">Save preferences</button></div>`, async (form, element) => {
      const body = Object.fromEntries(Object.keys(fields).map(key => [key, form.has(key)]));
      body.quietStart = form.has('quiet') ? form.get('quietStart') : null;
      body.quietEnd = form.has('quiet') ? form.get('quietEnd') : null;
      await request('/api/notification-preferences', { method: 'PUT', body });
      if (started === epoch()) { closeForm(element); ctx.toast('Notification preferences saved.'); }
    });
  }
  function unlockPanel() {
    if (ctx.frame()) {
      const access = frameAccessStatus();
      return `<section class="panel setup-card"><h2>${access ? `${access.scope === 'parent' ? 'Parent' : person(access.personId)} controls unlocked` : 'Unlock private controls'}</h2><p class="supporting">${access ? `This approval expires at ${h(stamp(access.expiresAt))}. Lock the frame when you finish.` : 'Create a short-lived unlock code from your signed-in phone. A family profile alone cannot spend a reward or change Internet access.'}</p>${ctx.button(access ? 'Lock controls now' : 'Enter unlock code', access ? 'frame-lock' : 'frame-unlock', 'button button-secondary')}</section>`;
    }
    const scopes = frameCodeScopes(ctx.session(), ctx.snapshot()?.capabilities);
    return `<section class="panel setup-card"><h2>${scopes.length ? 'Notifications & frame access' : 'Notifications'}</h2><p class="supporting">Your inbox and preferences follow your family account. Frame unlock codes grant temporary, scoped access.</p><div class="form-stack">${ctx.button('Notification preferences', 'notification-preferences', 'button button-secondary')}${scopes.length ? ctx.button('Create frame unlock code', 'create-frame-access', 'button button-secondary') : ''}</div></section>`;
  }
  function unlock() {
    ctx.openDialog('Unlock frame controls', `<p class="supporting">On a signed-in phone, open Settings → Notifications & frame access → Create frame unlock code. Enter that six-digit code here.</p><div class="form-stack">${ctx.field('Unlock code', 'code', '', { max: 6, extra: 'inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"' })}<button type="submit" class="button">Unlock controls</button></div>`, async (form, element) => {
      const started = epoch();
      let data;
      try { data = await request('/api/frame-access/redeem', { method: 'POST', body: { code: form.get('code').trim() } }); }
      finally { element.querySelector('[name="code"]').value = ''; form.delete('code'); }
      if (started !== epoch() || !activeForm(element)) return;
      setFrameAccess(data); state.access = { scope: data.scope, personId: data.personId, expiresAt: data.expiresAt };
      ctx.session().personId = data.personId;
      ctx.dialog.close(); ctx.toast('Frame controls unlocked temporarily.'); await ctx.reload();
    });
  }
  function createAccess() {
    const session = ctx.session(), child = session?.role === 'child', scopes = frameCodeScopes(session, ctx.snapshot()?.capabilities);
    if (!scopes.length) return;
    ctx.openDialog('Create a frame unlock code', `<div class="form-stack">${child ? `<input type="hidden" name="scope" value="child"><input type="hidden" name="personId" value="${h(session.personId)}"><p>Unlock your own rewards on the family frame.</p>` : `<label class="field"><span>Allow</span><select name="scope" aria-label="Frame access scope">${scopes.map(scope => `<option value="${scope}" ${scope === 'child' && !ctx.snapshot()?.people.length ? 'disabled' : ''}>${scope === 'parent' ? 'My parent controls' : 'One child’s rewards'}</option>`).join('')}</select></label><div data-child-scope hidden>${scopes.includes('child') ? selectPerson(ctx.snapshot()?.people || [], '', false) : ''}</div>`}<p class="field-help">Codes are private, single-use and expire after five minutes. The frame unlock lasts ten minutes. Creating a new code replaces your previous unlock.</p><button type="submit" class="button">Create code</button></div><div data-unlock-result></div>`, async (form, element) => {
      const started = epoch();
      const scope = form.get('scope');
      const data = await request('/api/frame-access-codes', { method: 'POST', body: { scope, ...(scope === 'child' ? { personId: form.get('personId') } : {}) } });
      if (started !== epoch() || !activeForm(element)) return;
      ctx.dialog.querySelector('[data-unlock-result]').innerHTML = `<div class="share-result"><strong class="pairing-code">${h(data.code)}</strong><span>For ${h(data.scope === 'parent' ? 'parent controls' : person(data.personId))} · expires ${h(stamp(data.expiresAt))}</span><span>Enter this code only on your paired frame.</span></div>`;
    });
    const selector = ctx.dialog.querySelector('[name="scope"][aria-label]');
    if (selector) selector.onchange = () => { ctx.dialog.querySelector('[data-child-scope]').hidden = selector.value !== 'child'; };
  }
  async function action(name, element) {
    if (name === 'school-calendar') { await schoolCalendar.open(); return true; }
    if (name === 'chore-history') { await history(); return true; }
    if (name === 'chore-breaks') { await breaks(); return true; }
    if (name === 'occurrence-action') { const item = occurrence(element.dataset.id); if (item) actOnOccurrence(item, element.dataset.operation); return true; }
    if (name === 'occurrence-step') {
      const item = occurrence(element.dataset.id); if (!item || item.status !== 'pending') return true;
      const started = epoch(), selected = item.subtasks.filter(step => step.id === element.dataset.stepId ? !step.completed : step.completed).map(step => step.id);
      element.disabled = true;
      try { await request(`/api/chore-occurrences/${encodeURIComponent(item.id)}/actions`, { method: 'POST', body: { action: 'subtasks', expectedVersion: item.version, mutationId: mutationId(), completedSubtaskIds: selected } }); if (started === epoch()) { await ctx.reload(); ctx.refreshTaskDetails?.(); } }
      finally { if (element.isConnected) element.disabled = false; }
      return true;
    }
    if (name === 'revoke-break') {
      const item = state.exceptions.find(row => row.id === element.dataset.id), operationId = mutationId(); if (!item) return true;
      ctx.openDialog('End this task break', `<div class="form-stack">${ctx.field('Reason', 'reason', '', { max: 500 })}<p class="field-help">Unfinished tasks excused by this break can return today and on future dates. Earlier history stays intact.</p><button type="submit" class="button">End break</button></div>`, async (form, element) => {
        const started = epoch();
        await request(`/api/chore-exceptions/${encodeURIComponent(item.id)}/revoke`, { method: 'POST', body: { expectedVersion: item.version, reason: form.get('reason').trim(), mutationId: operationId } });
        if (started !== epoch()) return; closeForm(element); await ctx.reload();
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
      ctx.openDialog('Caregiver permissions', `<div class="form-stack"><p>${h(item.name)}</p>${check('Manage routines, approvals and task breaks', 'manageChores', item.capabilities?.manageChores)}${check('Manage devices and Internet time', 'manageInternet', item.capabilities?.manageInternet)}<button type="submit" class="button">Save permissions</button></div>`, async (form, element) => {
        const started = epoch();
        await request(`/api/members/${encodeURIComponent(item.id)}/capabilities`, { method: 'PATCH', body: { manageChores: form.has('manageChores'), manageInternet: form.has('manageInternet') } });
        if (started !== epoch()) return; closeForm(element); await ctx.reloadSetup();
      }); return true;
    }
    return false;
  }
  return { reset, editRoutine, action, loadActivity, activityView, unreadCount: () => (state.activity || []).filter(item=>!item.readAt).length, unlockPanel, unlock, schoolCalendarPanel: schoolCalendar.panel, accessExpired: () => !!state.access && !frameAccessStatus() };
}
