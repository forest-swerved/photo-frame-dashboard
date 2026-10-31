import { request, setFrameMode, frameAccessStatus } from './api.js';
import { authClient, clearAuthCache } from './auth.js';
import { escapeHtml as h, color, dateInZone, dateFormatter, addDays, dateLabel, weekday, calendarRange, calendarEventsByDay, calendarDayIsKnown, timeLabel, choreUrgency, orderChores, completionBody, mergeCompletion, reconcileHousehold, mutationId } from './model.js';
import { createRenderer } from './render.js';
import { createFrameEventNotices } from './frame-events.js';
import { scheduledItems, mergeOccurrence, occurrenceDetails, schoolDayFilterLabel, schoolDayStatus, taskSectionLabel, taskSections, taskProgress } from './occurrences.js';
import { createWorkbench } from './workbench.js';
import { createInternetUI } from './internet-ui.js';
import { createAccountUI } from './account-ui.js';
import { taskOverview, taskGroups, agendaParts, completionLabel, protectDialogDraft, quietCalendarRefresh } from './presentation.js';
import { frameTaskLanes } from './frame-home.js';
import { createFrameAmbient } from './frame-ambient.js';
import { createFrameIdleReturn } from './frame-idle.js';
import { createLiveUpdates } from './live-updates.js';
import { createFrameSounds, taskCompletionCue } from './frame-sounds.js';

const app = document.querySelector('#family-app');
const dialog = document.querySelector('#family-dialog');
const notice = document.querySelector('#family-notice');
const paintApp = createRenderer(app);
const noEvents = [];
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const views = ['today', 'calendar', 'chores', 'devices', 'activity', 'setup'];
const icons = {
  today: '<path d="M3 10 12 3l9 7M5 9v12h14V9M9 21v-8h6v8"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  chores: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m7 12 3 3 7-7"/>',
  setup: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  activity: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/>',
  devices: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
};
const S = {
  booting: true, session: null, snapshot: null, calendar: null, frameCalendar: null, connection: null, devices: [], members: [],
  view: views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today',
  calendarMode: 'day', taskPerson: 'all', taskMode: 'today', taskStatus: 'active', settingsSection: new URLSearchParams(location.search).get('settings') || '', selectedDate: dateInZone(), authMode: 'sign-in',
  verificationEmail: '', verificationMethod: 'code',
  entryPair: new URLSearchParams(location.search).get('display') === 'frame',
  inviteToken: '', generatedInvite: null, pairing: null, message: '', error: '', liveIssue: '', loading: false,
  recentTasks: new Set(), pending: new Map(), conflicts: new Map(), failures: new Map(), attempts: new Map(), calendarBusy: false, calendarShowingBusy: false, setupBusy: false,
};
let generation = 0;
let noticeTimer;
let closeDraftGuard;
let pendingRender = false;
let pollBusy = false;
let queuedCalendar = null;
let calendarGeneration = 0;
let paintedView = null;
let pointerActive = false;
let pendingTaskDetails = false;
const activePointers = new Set();
const taskPointerIntents = new Map();
const taskKeyIntents = new Map();
const sounds = createFrameSounds({ enabled: () => frame(), timezone: zone });
let soundFeedbackVersion = 0, navigationSound = false;
function sound(name, options) { soundFeedbackVersion++; return sounds.play(name, options); }
const frameEvents = createFrameEventNotices(document.querySelector('#frame-event-notice'), { onShow: () => sounds.play('reminder') });
function tickFrameEvents() {
  frameEvents.update({ session: S.booting ? null : S.session, calendar: S.frameCalendar, timezone: zone(),
    visible: !document.hidden && !dialog.open });
}
const workbench = createWorkbench({ snapshot: () => S.snapshot, session: () => S.session, epoch: () => generation,
  members: () => S.members, zone, today, frame, field, button, openDialog, dialog, toast, sound, taskApproved, render, refreshTaskDetails,
  reload: async () => { await loadHousehold(); if (internet.loaded() || S.view === 'devices') await internet.load(); }, reloadSetup: loadSetup, reboot: boot });
const internet = createInternetUI({ snapshot: () => S.snapshot, session: () => S.session, epoch: () => generation,
  zone, frame, field, button, openDialog, dialog, toast, sound, render, soundTimers: (rows, fresh) => sounds.observeTimers(rows, `${generation}:${S.session?.household?.id}`, fresh), unlock: workbench.unlock });
const liveUpdates = createLiveUpdates({
  read: () => request('/api/live-status', { timeoutMs: 8000 }),
  loaders: { household:()=>loadHousehold().catch(error=>{dataFailure(error);return false;}), internet:()=>internet.load(), calendar:()=>loadCalendar() },
  scope: () => JSON.stringify([generation,S.session?.authType,S.session?.role,S.session?.personId,frameAccessStatus()]),
  visible: () => !document.hidden && !!S.session?.household && !S.booting,
  onStatus: error => {
    if(error?.status===401||error?.status===403) { dataFailure(error);return; }
    const message=error ? 'Live updates interrupted. Reconnecting…' : '';
    if(S.liveIssue!==message) { S.liveIssue=message;render(); }
  },
});
const ambient = createFrameAmbient(document.querySelector('#frame-ambient'), {
  state: () => ({ enabled: frame() && !!S.session?.household && !S.booting,
    cacheScope: `${S.session?.household?.id}:${S.session?.user?.id}`, purge: !S.booting && (!frame() || !S.session?.household),
    scope: `${generation}:${S.session?.household?.id}:${JSON.stringify(frameAccessStatus())}`,
    timezone: zone(), title: title(), calendar: S.frameCalendar, people: people(),
    tasks: S.snapshot ? scheduledChores() : [], schoolDay: S.snapshot?.schoolDay,
    stale: !!S.liveIssue || !!S.error || S.snapshot?.date !== today() }),
  media: () => request('/api/media'), readMediaURL: id => request(`/api/media/${id}/content`), onAuthFailure: dataFailure,
  onWake: () => { frameIdle.reset(); if (S.view !== 'today') location.hash = 'today'; },
});
const frameIdle = createFrameIdleReturn({
  enabled: () => frame() && !!S.session?.household && !S.booting,
  blocked: () => S.pending.size > 0 || internet.writing() || !!document.querySelector('form[data-submitting]'),
  onIdle: () => {
    if (dialog.open) {
      if (!dialog.dispatchEvent(new Event('request-close', { cancelable: true }))) return;
      dialog.close();
    }
    if (S.view !== 'today') location.hash = 'today';
    ambient.start();
  },
});

if (location.hash.startsWith('#invite=')) {
  try { S.inviteToken = decodeURIComponent(location.hash.slice(8)); } catch { /* Invalid token stays blank. */ }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  S.view = 'setup';
}

const accountUI = createAccountUI({ session: () => S.session, epoch: () => generation, members: () => S.members,
  reloadSetup: loadSetup, openDialog, field, button, dialog, reboot: boot, toast,
  deleted: async () => {
    generation++; workbench.reset(); internet.reset(); clearAuthCache(); setFrameMode(false);
    // The confirmed deletion response clears same-origin Auth cookies on the server.
    S.session = null; S.snapshot = null; S.calendar = null; S.frameCalendar = null; S.connection = null; S.devices = []; S.members = [];
    S.generatedInvite = null; S.pairing = null; S.pending.clear(); S.conflicts.clear(); S.failures.clear(); S.attempts.clear();
    S.verificationEmail = ''; S.authMode = 'sign-in'; S.error = ''; S.message = 'Your account has been deleted.'; S.booting = false; render(true);
  } });

function icon(name) { return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.today}</svg>`; }
function admin() { return S.session?.role === 'admin'; }
function choreManager() { return admin() || S.snapshot?.capabilities?.manageChores === true; }
function routines() { return S.snapshot?.routines || S.snapshot?.chores || []; }
function frame() { return S.session?.authType === 'frame'; }
function zone() { return S.snapshot?.household?.timezone || S.session?.household?.timezone || 'America/Denver'; }
function today() { return dateInZone(new Date(), zone()); }
function title() { return S.snapshot?.household?.title || S.session?.household?.title || 'Family Frame'; }
function people() { return S.snapshot?.people || []; }
function person(id) { return people().find(item => item.id === id); }
function idPath(id) { return encodeURIComponent(id); }
function errorMessage(error) { return error?.message || 'Something went wrong. Please try again.'; }
function edited() { return pointerActive || taskKeyIntents.size > 0 || dialog.open || !!document.activeElement?.closest('form') || !!document.querySelector('form[data-submitting]'); }
function toast(message) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.classList.add('visible');
  noticeTimer = setTimeout(() => notice.classList.remove('visible'), 6000);
}
function clockMarkup() { return '<span class="live-time" data-clock></span><span class="live-date" data-clock-date></span>'; }
function paintClock() {
  const now = new Date();
  const time = dateFormatter({ timeZone: zone(), hour: 'numeric', minute: '2-digit' }).format(now);
  const date = dateFormatter({ timeZone: zone(), weekday: 'long', month: 'long', day: 'numeric' }).format(now);
  document.querySelectorAll('[data-clock]').forEach(element => { if (element.textContent !== time) element.textContent = time; });
  document.querySelectorAll('[data-clock-date]').forEach(element => { if (element.textContent !== date) element.textContent = date; });
}

function field(label, name, value = '', options = {}) {
  const { type = 'text', required = true, autocomplete = 'off', max = 160, extra = '' } = options;
  return `<label class="field" data-key="field-${h(name)}"><span>${h(label)}</span><input type="${h(type)}" name="${h(name)}" value="${h(value)}" ${required ? 'required' : ''} autocomplete="${h(autocomplete)}" maxlength="${max}" ${extra}></label>`;
}
function formError() { return '<p class="form-error" data-form-error role="alert" hidden></p>'; }
function button(text, action, cls = 'button', extra = '') { return `<button type="button" class="${cls}" data-action="${h(action)}" ${extra}>${h(text)}</button>`; }
function empty(titleText, detail, action = '') { return `<div class="empty-state"><span class="empty-mark" aria-hidden="true">○</span><h3>${h(titleText)}</h3><p>${h(detail)}</p>${action}</div>`; }
function initials(name) { return (name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase(); }
function avatar(profile) { return `<span class="avatar" style="--person:${color(profile?.color)}" aria-hidden="true">${h(initials(profile?.name || 'Anyone'))}</span>`; }
function profileLabel(id) { return person(id)?.name || 'Anyone'; }
function noticeBanner() { return S.error || S.liveIssue ? `<div class="banner banner-error" data-key="data-error" role="alert"><span>${h(S.error || S.liveIssue)}</span>${button('Retry', 'refresh', 'text-button')}</div>` : ''; }
function updateStamp(value) {
  if (!value) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 1 ? 'Updated just now' : `Updated ${minutes} min ago`;
}

function shell(content) {
  const labels = { today: 'Today', calendar: 'Calendar', chores: S.session?.role === 'child' ? 'My tasks' : 'Tasks', devices: 'Devices', activity: 'Activity', setup: 'Settings' };
  const nav = view => `<a class="nav-item ${S.view === view ? 'active' : ''}" data-key="nav-${view}" href="#${view}" aria-label="${labels[view]}" ${S.view === view ? 'aria-current="page"' : ''}>${icon(view)}<span>${labels[view]}</span>${view === 'activity' && workbench.unreadCount() ? `<span class="nav-badge" aria-label="${workbench.unreadCount()} unread">${workbench.unreadCount()}</span>` : ''}</a>`;
  return `<div class="family-shell" data-key="family-shell"><aside class="sidebar"><a class="brand" href="#today" aria-label="${h(title())} home"><img class="brand-mark" src="/brand/folded-home.svg" alt="" width="40" height="40"><span class="brand-name">${h(title())}<small>A little more together.</small></span></a><nav aria-label="Main navigation">${['today','chores','calendar','devices',...(!frame() ? ['activity'] : [])].map(nav).join('')}</nav><div class="sidebar-settings">${frame() ? frameSoundButton() : ''}${nav('setup')}</div><div class="sidebar-bottom"><span class="connection-dot ${S.error ? 'warning' : ''}"></span><span>${frame() ? 'Paired family frame' : 'Your family, connected'}</span></div></aside><main id="main-content" class="main-content ${S.view === 'today' ? 'today-content' : ''} ${frame() && S.view === 'today' ? 'frame-home-content' : ''}" tabindex="-1"><header class="page-heading" data-key="page-heading"><div><p class="eyebrow">${h(title())}</p><h1>${labels[S.view]}${frame() && S.view === 'today' && S.snapshot?.schoolDay?.label ? `<span class="frame-day-type">${h(S.snapshot.schoolDay.label)}</span>` : ''}</h1></div><div class="heading-actions"><div class="header-clock">${clockMarkup()}</div><a href="#setup" class="settings-shortcut icon-button" aria-label="Settings">${icon('setup')}</a></div></header>${noticeBanner()}${content}</main></div>`;
}

function frameSoundButton() {
  const prefs = sounds.preferences(), muted = !prefs.enabled || !prefs.volume;
  return `<button type="button" class="icon-button frame-sound-button" data-action="frame-sounds" aria-label="Frame sounds${muted ? ' (muted)' : ''}" title="Frame sounds"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/>${muted ? '<path d="m16 9 5 6m0-6-5 6"/>' : '<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'}</svg></button>`;
}
function openFrameSounds() {
  const prefs = sounds.preferences();
  let saved = false;
  const check = (label, name) => `<label class="checkbox-label"><input type="checkbox" name="${name}" ${prefs[name] ? 'checked' : ''}><span>${label}</span></label>`;
  openDialog('Frame sounds', `<div class="form-stack frame-sound-settings"><p class="supporting">Gentle feedback for this display. Your phone and other frames keep their own settings.</p>${button(prefs.enabled ? 'Mute now' : 'Turn sounds on', 'toggle-frame-sounds', 'button button-secondary')}<label class="field"><span>Volume</span><input type="range" name="volume" data-sound-volume min="0" max="100" step="5" value="${Math.round(prefs.volume * 100)}" aria-label="Sound volume"><output data-sound-volume-label>${Math.round(prefs.volume * 100)}%</output></label>${check('Buttons, navigation and saved changes', 'interface')}${check('Task completions and celebrations', 'celebrations')}${check('Timer and calendar reminders', 'reminders')}${check('Quiet hours', 'quiet')}<div class="form-row">${field('Quiet from', 'quietStart', prefs.quietStart, {type:'time'})}${field('Quiet until', 'quietEnd', prefs.quietEnd, {type:'time'})}</div><p class="field-help">Quiet hours follow ${h(zone())}.${sounds.quiet() ? ' Quiet hours are active now.' : ''} Previews can play during quiet hours; mute and volume still apply.</p><div class="sound-preview-buttons">${button('Task done', 'preview-frame-sound', 'button button-secondary', 'data-cue="complete"')}${button('All done!', 'preview-frame-sound', 'button button-secondary', 'data-cue="allDone"')}${button('Timer finished', 'preview-frame-sound', 'button button-secondary', 'data-cue="timerEnd"')}</div><button type="submit" class="button">Save sound settings</button></div>`, async form => {
    sounds.update({ ...Object.fromEntries(['interface','celebrations','reminders','quiet'].map(name => [name, form.has(name)])), volume:Number(form.get('volume')) / 100, quietStart:form.get('quietStart'), quietEnd:form.get('quietEnd') });
    saved = true; dialog.close(); render(true); toast('Sound settings saved for this frame.');
  });
  dialog.addEventListener('close', () => { if (!saved && sounds.preferences().volume !== prefs.volume) sounds.update({volume:prefs.volume}); }, {once:true});
}

function calendarStatus() {
  const calendar = S.calendar;
  if (!calendar) return '<div class="status-note">Checking your calendar connection…</div>';
  if (calendar.status === 'not_configured') return `<div class="status-note">Your Apple Calendar is not connected.${admin() ? ' Connect it in Setup.' : ' Ask your family administrator to connect it.'}</div>`;
  if (calendar.status === 'loading') return '<div class="status-note">Your calendar is syncing. Events will appear after a successful sync.</div>';
  if (calendar.status === 'stale' && !quietCalendarRefresh(calendar)) {
    const heading = calendar.error || calendar.sync?.error || calendar.sync?.state === 'retrying' ? 'Calendar update delayed.' : 'Calendar may be out of date.';
    const detail = calendar.error?.message || calendar.sync?.error?.message || 'Showing the last synced events. A background update will check for changes.';
    return `<div class="status-note status-warning"><strong>${heading}</strong> ${h(updateStamp(calendar.lastSuccessfulSyncAt))}. ${h(detail)}</div>`;
  }
  if (calendar.status === 'error') return `<div class="status-note status-warning"><strong>Calendar is unavailable.</strong> ${h(calendar.error?.message || 'Please try refreshing.')}</div>`;
  if (!calendar.coverage?.complete || calendar.coverage?.truncated) return '<div class="status-note status-warning">This calendar view is incomplete. It cannot confirm availability.</div>';
  return `<div class="calendar-meta"><span class="connection-dot"></span>${h(updateStamp(calendar.lastSuccessfulSyncAt))}${S.calendarShowingBusy ? ' · Refreshing…' : ''}</div>`;
}

function selectedCalendars() { return (S.calendar?.calendars || S.connection?.calendars || []).filter(calendar => calendar.selected !== false); }
function eventMetadata(event) { return selectedCalendars().find(calendar => calendar.id === event.calendarId); }
function eventDays() {
  const range = S.view === 'calendar' ? calendarRange(S.selectedDate, S.calendarMode) : { from: today(), to: addDays(today(), 7) };
  return calendarEventsByDay(S.calendar?.events || noEvents, zone(), range.from, range.to);
}
function calendarLegend() {
  const calendars = selectedCalendars();
  return calendars.length ? `<div class="calendar-legend" data-key="calendar-legend" aria-label="Calendar colors">${calendars.map(calendar => `<span data-key="legend-${h(calendar.id)}"><i style="background:${color(calendar.color)}" aria-hidden="true"></i>${h(calendar.name)}</span>`).join('')}</div>` : '';
}

function eventCard(event, compact = false, date) {
  const metadata = eventMetadata(event);
  const eventColor = color(metadata?.color || '#00748c');
  let time = 'All day';
  if (!event.allDay) {
    const formatter = dateFormatter({ timeZone: zone(), hour: 'numeric', minute: '2-digit' });
    time = `${formatter.format(new Date(event.startAt))} – ${formatter.format(new Date(event.endAt))}`;
    if (dateInZone(new Date(event.startAt), zone()) !== dateInZone(new Date(new Date(event.endAt).getTime() - 1), zone())) {
      const datedTime = dateFormatter({ timeZone: zone(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      time = `${datedTime.format(new Date(event.startAt))} – ${datedTime.format(new Date(event.endAt))}`;
    }
  }
  const timeMarkup = `<time class="event-time" datetime="${h(event.allDay ? date || event.startDate : event.startAt)}">${h(time)}</time>`;
  const dateMarkup = compact ? `<time class="event-date" datetime="${h(date)}" aria-label="${h(dateLabel(date, { year: 'numeric' }))}"><span>${h(dateLabel(date, { weekday: 'long', month: undefined, day: undefined }))}</span><strong>${h(dateLabel(date, { weekday: undefined, month: 'short', day: 'numeric' }))}</strong></time>` : '';
  return `<article class="event-card ${compact ? 'compact' : ''}" data-key="event-${h(event.calendarId)}-${h(event.id)}" style="--event:${eventColor}" data-date="${h(date || S.selectedDate)}" aria-label="${h(event.title || 'Untitled event')}, ${h(dateLabel(date || S.selectedDate))}">${compact ? dateMarkup : timeMarkup}<div>${compact ? timeMarkup : ''}<h3>${h(event.title || 'Untitled event')}</h3>${event.location ? `<p>${h(event.location)}</p>` : ''}${metadata?.name && !compact ? `<span class="event-calendar">${h(metadata.name)}</span>` : ''}<button type="button" class="event-open" data-action="event-details" data-id="${h(event.id)}" data-calendar="${h(event.calendarId)}" data-date="${h(date || S.selectedDate)}" aria-label="Details for ${h(event.title || 'Untitled event')}">Details <span aria-hidden="true">↗</span></button></div></article>`;
}

function eventList(date, limit = Infinity) {
  const list = eventDays().get(date) || noEvents;
  if (list.length) return list.slice(0, limit).map(event => eventCard(event, limit !== Infinity, date)).join('') + (list.length > limit ? `<a href="#calendar" class="more-link">See ${list.length - limit} more</a>` : '');
  return `<p class="quiet-empty">${calendarDayIsKnown(S.calendar, date) ? 'No events on this day.' : 'Events will appear when this day has synced.'}</p>`;
}

function scheduledChores() { return scheduledItems(S.snapshot, zone()) || orderChores((S.snapshot?.chores || []).filter(chore => chore.weekdays.includes(weekday(S.snapshot.date))), S.snapshot?.date || today(), zone()); }
function done(chore) { return chore.status ? chore.status === 'completed' : chore.completion?.date === S.snapshot?.date && chore.completion.completed === true; }
function taskIntentAttributes(chore) {
  return `data-task-date="${h(S.snapshot.date)}" data-task-version="${chore.status ? chore.version : chore.completion?.version || 0}" data-task-kind="${chore.status ? 'occurrence' : 'routine'}" data-task-completed="${chore.status !== 'submitted' && !done(chore)}"`;
}
function taskIntent(element) {
  return { epoch:generation, id:element.dataset.id, date:element.dataset.taskDate,
    version:Number(element.dataset.taskVersion), kind:element.dataset.taskKind, completed:element.dataset.taskCompleted === 'true' };
}
function choreRow(chore, showPerson = true, glance = false) {
  const key = `${chore.id}:${S.snapshot.date}`, pending = S.pending.has(key), conflict = S.conflicts.has(key), failure = S.failures.get(key);
  const historical = chore.status === 'skipped' || taskGroups([chore], S.snapshot?.schoolDay).history.length > 0;
  const urgency = choreUrgency(chore, S.snapshot.date, zone());
  const deadline = !historical && !done(chore) && chore.status !== 'submitted' && chore.dueTime ? `${urgency === 'overdue' ? 'Overdue · ' : urgency === 'soon' ? 'Due soon · ' : ''}Due ${timeLabel(chore.dueTime)}` : '';
  const status = historical ? 'Earlier schedule / excused' : completionLabel(chore);
  const secondary = !glance || historical || done(chore) || chore.status === 'submitted' || chore.required === false || deadline || chore.subtasks?.length;
  return `<div class="chore-row compact-task ${done(chore) ? 'is-done' : ''} ${pending ? 'is-pending' : ''} ${chore.status === 'submitted' ? 'is-submitted' : ''} ${historical ? 'is-historical' : ''} is-${urgency}" data-key="chore-${h(key)}"><button type="button" class="chore-toggle" data-action="complete-chore" data-id="${h(chore.id)}" ${taskIntentAttributes(chore)} aria-pressed="${chore.status === 'submitted' || done(chore)}" aria-label="${chore.status === 'submitted' ? 'Withdraw submission for' : done(chore) ? 'Reopen' : chore.requiresApproval && !choreManager() ? 'Submit for approval:' : 'Complete'} ${h(chore.title)}${deadline ? `. ${h(deadline)}` : ''}" ${pending || historical ? 'aria-disabled="true"' : ''} ${pending ? 'aria-busy="true"' : ''}><span class="check-box" aria-hidden="true">${done(chore) ? '✓' : chore.status === 'submitted' ? '…' : historical ? '–' : ''}</span></button><button type="button" class="chore-open" data-action="task-details" data-id="${h(chore.id)}" aria-label="Details for ${h(chore.title)}"><strong>${h(chore.title)}</strong>${secondary ? `<small>${showPerson ? `${h(profileLabel(chore.personId))} · ` : ''}<span class="task-state">${h(status)}</span>${deadline ? ` · <span class="chore-deadline">${h(deadline)}</span>` : ''}${chore.subtasks?.length ? ` · ${chore.subtasks.filter(step => step.completed).length}/${chore.subtasks.length} steps` : ''}</small>` : ''}${pending ? '<small class="save-status">Saving…</small>' : ''}</button>${chore.status === 'submitted' && choreManager() ? button('Review', 'task-details', 'text-button', `data-id="${h(chore.id)}"`) : '<span class="row-chevron" aria-hidden="true">›</span>'}${conflict ? `<div class="write-feedback" role="alert">Changed on another device. The latest state is shown. ${button('Retry my change', 'retry-completion', 'text-button', `data-id="${h(chore.id)}"`)}</div>` : failure ? `<div class="write-feedback" role="alert">${h(failure)} ${button('Retry', 'retry-completion', 'text-button', `data-id="${h(chore.id)}"`)}</div>` : ''}</div>`;
}

function taskListMarkup(items, showPerson = true, profileId, limit = Infinity) {
  const includeEmpty = profileId !== undefined || S.snapshot?.schoolDay?.type === 'school_day';
  const sections = taskSections(items, S.snapshot?.schoolDay, { includeEmpty });
  const populated = sections.filter(section => section.items.length).length;
  const perSectionLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit / Math.max(1, populated))) : Infinity;
  return sections.map(section => {
    const displayed = section.items.slice(0, perSectionLimit), omitted = section.items.length - displayed.length;
    const scheduled = scheduledChores().filter(item => !profileId || item.personId === profileId);
    const hasScheduled = taskSections(scheduled, S.snapshot?.schoolDay).some(group=>group.id===section.id && group.items.length);
    if (!section.items.length && hasScheduled && S.taskStatus === 'active') return '';
    const filter = section.id !== 'tasks' ? 'school_day' : S.snapshot?.schoolDay?.type === 'non_school_day' ? 'non_school_day' : 'any';
    return `<section class="task-section" data-key="task-section-${section.id}"><h3 class="task-section-heading">${h(section.label)}</h3>${section.items.length ? `<div class="chore-list">${displayed.map(item => choreRow(item, showPerson)).join('')}</div>${omitted ? `<a href="#chores" class="more-link" aria-label="View ${omitted} more ${omitted === 1 ? 'task' : 'tasks'} in ${h(section.label)}">View ${omitted} more ${omitted === 1 ? 'task' : 'tasks'}</a>` : ''}` : `<div class="task-section-empty"><p>${hasScheduled ? 'No unfinished tasks here.' : 'No tasks scheduled here yet.'}</p>${choreManager() && !hasScheduled ? button('Add task', 'add-chore', 'text-button', `data-person-id="${h(profileId || '')}" data-school-filter="${filter}" data-task-section="${section.id}" aria-label="Add a task${section.id !== 'tasks' ? ` ${section.label.toLowerCase()}` : ''}${profileId ? ` for ${h(profileLabel(profileId))}` : ''}"`) : ''}</div>`}</section>`;
  }).join('');
}

function profileFilter() {
  if (S.session?.role === 'child' || people().length < 2) return '';
  if (S.taskPerson !== 'all' && !people().some(p => p.id === S.taskPerson)) S.taskPerson = 'all';
  return `<div class="profile-filter" role="group" aria-label="Filter by family profile">${[{ id: 'all', name: 'Everyone' }, ...people()].map(profile => { const progress = taskProgress(profile.id === 'all' ? scheduledChores() : scheduledChores().filter(item => item.personId === profile.id), S.snapshot?.schoolDay); return button(`${profile.name}${profile.id === 'all' ? '' : ` · ${progress.completed}/${progress.total}`}`, 'task-person', `filter-pill ${S.taskPerson === profile.id ? 'selected' : ''}`, `data-id="${h(profile.id)}" aria-pressed="${S.taskPerson === profile.id}"`); }).join('')}</div>`;
}
function approvalQueue(items, preview = false) {
  if (!items.length) return '';
  if (!choreManager()) return frame() ? `<section class="approval-queue approval-preview"><div class="section-heading"><h2>${items.length} waiting for parent approval</h2>${button('Unlock to review','unlock-frame','text-button')}</div></section>` : '';
  return `<section class="approval-queue ${preview ? 'approval-preview' : 'panel'}" data-key="approval-queue"><div class="section-heading"><h2>${items.length} ${items.length === 1 ? 'task needs' : 'tasks need'} approval</h2>${button('Review tasks', 'review-tasks', 'text-button')}</div>${preview ? '<p class="soft-label">Review submitted work before it counts toward rewards.</p>' : items.map(item => `<article class="approval-item" data-key="approval-${h(item.id)}"><button type="button" class="chore-open" data-action="task-details" data-id="${h(item.id)}"><strong>${h(item.title)}</strong><small>${h(profileLabel(item.personId))} · Waiting for parent approval</small></button>${button('Review work', 'task-details', 'button button-small', `data-id="${h(item.id)}"`)}</article>`).join('')}</section>`;
}
function todayAgenda() {
  const { allDay, upcoming, earlier } = agendaParts(eventDays().get(today()) || []);
  return `${calendarStatus()}${allDay.length ? `<div class="all-day-events"><p class="eyebrow">All day</p>${allDay.map(event => eventCard(event, false, today())).join('')}</div>` : ''}<div class="event-list">${upcoming.length ? upcoming.slice(0,3).map(event => eventCard(event, false, today())).join('') : `<p class="quiet-empty">${calendarDayIsKnown(S.calendar, today()) ? 'The rest of today is clear.' : 'Upcoming events are not confirmed yet.'}</p>`}</div>${upcoming.length > 3 ? '<a href="#calendar" class="more-link">View all upcoming events →</a>' : ''}${earlier.length ? `<details class="earlier-events" data-key="earlier-events"><summary>Earlier today · ${earlier.length}</summary>${earlier.map(event => eventCard(event, false, today())).join('')}</details>` : ''}`;
}
function taskDetailContents(chore) {
  const historical = taskGroups([chore], S.snapshot?.schoolDay).history.length > 0;
  return `<p class="supporting">${h(profileLabel(chore.personId))} · ${h(completionLabel(chore))}</p>${occurrenceDetails(chore,choreManager(),S.pending.has(`${chore.id}:${S.snapshot.date}`),S.snapshot.schoolDay)}${!historical && !(chore.status === 'submitted' && choreManager()) ? button(chore.status === 'submitted' ? 'Withdraw submission' : done(chore) ? 'Reopen task' : chore.requiresApproval && !choreManager() ? 'Submit for approval' : 'Mark task done','complete-chore','button',`data-id="${h(chore.id)}" ${taskIntentAttributes(chore)}`) : ''}${choreManager() ? button('Edit routine','edit-chore','text-button',`data-id="${h(chore.choreId || chore.id)}"`) : ''}`;
}
function refreshTaskDetails() {
  if (!dialog.open || !dialog.dataset.taskId) { pendingTaskDetails = false; return; }
  if (pointerActive || taskKeyIntents.size) { pendingTaskDetails = true; return; }
  pendingTaskDetails = false;
  const chore = scheduledChores().find(item=>item.id===dialog.dataset.taskId);
  if (!chore) return;
  const body=dialog.querySelector('.dialog-body');
  const expanded=[...body.querySelectorAll('details[open]')].map(item=>item.dataset.key);
  body.innerHTML=taskDetailContents(chore);
  for (const details of body.querySelectorAll('details')) if(expanded.includes(details.dataset.key)) details.open=true;
}
function activeTasks(items, groups) {
  return [...groups.todo, ...items.filter(item => !groups.todo.includes(item) && S.recentTasks.has(item.id))];
}
function frameHomeCalendar() {
  const dates = eventDays();
  let next;
  for (let n = 0; n < 7 && !next; n++) {
    const date = addDays(today(), n), parts = agendaParts(dates.get(date) || []);
    const event = parts.upcoming[0] || parts.allDay[0];
    if (event) next = { date, event };
  }
  const healthy = S.calendar?.status === 'ready' && S.calendar.coverage?.complete && !S.calendar.coverage.truncated;
  const notice = healthy || quietCalendarRefresh(S.calendar) ? '' : calendarStatus();
  const eventDate = next && (next.event.allDay ? next.date : dateInZone(new Date(next.event.startAt), zone()));
  const content = next ? `<button type="button" class="frame-next-event" data-action="event-details" data-id="${h(next.event.id)}" data-calendar="${h(next.event.calendarId)}" data-date="${h(next.date)}" aria-label="Details for ${h(next.event.title || 'Calendar event')}"><strong>${h(next.event.title || 'Calendar event')}</strong><span>${h(dateLabel(eventDate))} · ${next.event.allDay ? 'All day' : h(dateFormatter({ timeZone: zone(), hour: 'numeric', minute: '2-digit' }).format(new Date(next.event.startAt)))}</span></button>` : `<p class="frame-calendar-empty">${calendarDayIsKnown(S.calendar, today()) ? 'The rest of today is clear.' : 'Upcoming events are not confirmed yet.'}</p>`;
  return `<section class="frame-home-calendar" aria-label="Family calendar"><a href="#calendar" class="frame-calendar-link">Calendar ↗</a><div>${notice}${content}</div></section>`;
}
function frameHomeOverview(shared) {
  const days = eventDays(), upcoming = [], seen = new Set();
  for (let n = 0; n < 7; n++) {
    const date = addDays(today(), n), parts = agendaParts(days.get(date) || []);
    for (const event of [...parts.allDay, ...parts.upcoming]) {
      const key = `${event.calendarId}:${event.id}`;
      if (!seen.has(key)) { upcoming.push({ date, event }); seen.add(key); }
    }
  }
  const sharedTasks = [...shared.todo, ...shared.submitted];
  return `<aside class="frame-home-overview" data-key="frame-home-overview" aria-label="Family day at a glance"><section class="frame-upcoming"><div class="section-heading"><div><p class="eyebrow">The family schedule</p><h2>Coming up</h2></div><a href="#calendar" class="text-button" aria-label="Open full calendar">↗</a></div>${calendarStatus()}<div class="frame-upcoming-events">${upcoming.length ? upcoming.slice(0, 4).map(({ date, event }) => eventCard(event, true, date)).join('') : `<p class="quiet-empty">${calendarDayIsKnown(S.calendar, today()) ? 'The rest of today is clear.' : 'Upcoming events are not confirmed yet.'}</p>`}</div><a href="#calendar" class="more-link">Open calendar →</a></section>${sharedTasks.length ? `<section class="frame-shared-tasks"><div class="section-heading"><h2>For anyone</h2><a href="#chores" data-action="open-shared-tasks" class="text-button">${sharedTasks.length} tasks ↗</a></div>${sharedTasks.slice(0, 3).map(item => choreRow(item, false, true)).join('')}</section>` : ''}</aside>`;
}
function frameHomeView() {
  const tasks = scheduledChores(), lanes = frameTaskLanes(people(), tasks, S.snapshot?.schoolDay);
  const submitted = taskGroups(tasks, S.snapshot?.schoolDay).submitted;
  const shared = taskGroups(tasks.filter(item => !item.personId), S.snapshot?.schoolDay);
  return `<section class="frame-home" data-key="frame-home" aria-label="Today’s family tasks">${S.snapshot?.schoolDay?.type === 'unknown' ? schoolDayStatus(S.snapshot) : ''}
    <div class="frame-home-layout" data-key="frame-home-layout"><div class="frame-task-board" data-key="frame-task-board">${lanes.map(({ profile, overview, groups, sections, currentCount }) => `<section class="frame-person-card ${currentCount && !groups.todo.length && !groups.submitted.length ? 'all-done' : ''}" data-key="frame-person-${h(profile.id)}" data-person-id="${h(profile.id)}" aria-labelledby="frame-name-${h(profile.id)}" style="--person:${color(profile.color)}">
      <header class="frame-person-heading">${avatar(profile)}<div><h2 id="frame-name-${h(profile.id)}">${h(profile.name)}</h2><p>${groups.submitted.length ? `${groups.submitted.length} waiting for a parent` : groups.todo.length ? '' : currentCount ? 'All done today!' : 'No tasks today'}</p></div><a class="frame-person-count" href="#chores" data-action="open-person-tasks" data-id="${h(profile.id)}" aria-label="View all tasks for ${h(profile.name)}"><strong>${overview.completed}<span> / ${overview.total}</span></strong><small>required done</small></a></header>
      <div class="progress-track frame-person-progress" ${overview.total ? `role="progressbar" aria-label="${h(profile.name)}’s required tasks complete" aria-valuenow="${overview.completed}" aria-valuemin="0" aria-valuemax="${overview.total}"` : 'aria-hidden="true"'} data-key="frame-progress-${h(profile.id)}"><i style="width:${overview.total ? Math.round(overview.completed / overview.total * 100) : 0}%"></i></div>
      <div class="frame-person-tasks" data-key="frame-tasks-${h(profile.id)}" tabindex="0" role="region" aria-label="${h(profile.name)}’s task list">${sections.length ? sections.map(section => `<section class="task-section" data-key="frame-section-${h(profile.id)}-${section.id}"><h3 class="task-section-heading">${h(section.label)}</h3><div class="chore-list">${section.items.map(item => choreRow(item, false, true)).join('')}</div></section>`).join('') : `<div class="frame-person-empty"><span aria-hidden="true">${currentCount ? '✓' : '○'}</span><strong>${currentCount ? 'You’re all set!' : 'A little room to breathe.'}</strong><p>${currentCount ? 'Your tasks are done. Nice work.' : 'No tasks scheduled for today.'}</p></div>`}</div>
      ${internet.personSummary(profile.id)}
    </section>`).join('') || '<section class="panel"><h2>Your family tasks</h2><p>Add family profiles in Settings to see their task lists here.</p></section>'}</div>${frameHomeOverview(shared)}</div>
    <footer class="frame-home-bottom" data-key="frame-home-bottom">${frameHomeCalendar()}<div class="frame-home-tools">${button('Unlock controls','frame-unlock','text-button')}${submitted.length ? button(choreManager() ? 'Review tasks' : 'Unlock to review', choreManager() ? 'review-tasks' : 'unlock-frame', 'text-button') : ''}${shared.todo.length || shared.submitted.length ? `<a href="#chores" data-action="open-shared-tasks" class="text-button">Shared tasks · ${shared.todo.length + shared.submitted.length}</a>` : ''}</div></footer>
  </section>`;
}
function todayView() {
  if (frame()) return frameHomeView();
  const chores = scheduledChores(), overview = taskOverview(chores, S.snapshot?.schoolDay);
  const visible = S.taskPerson === 'all' ? chores : chores.filter(item => item.personId === S.taskPerson);
  const groups = taskGroups(visible, S.snapshot?.schoolDay), approvals = taskGroups(chores, S.snapshot?.schoolDay).submitted;
  const active = activeTasks(visible, groups);
  return `<section class="welcome-strip compact-welcome" data-key="today-summary"><div><h2>A little more together.</h2><p class="welcome-summary">${h(S.snapshot?.schoolDay?.label || 'Your family’s day')}${overview.submitted ? ` · ${overview.submitted} waiting for a parent` : ''}${overview.optional ? ` · ${overview.optionalDone}/${overview.optional} optional done` : ''}</p></div><div class="daily-progress"><strong>${overview.total ? `${overview.completed} of ${overview.total} required tasks done` : 'No required tasks today'}</strong>${overview.total ? `<div class="progress-track" role="progressbar" aria-label="Required tasks complete" aria-valuenow="${overview.completed}" aria-valuemin="0" aria-valuemax="${overview.total}"><i style="width:${Math.round(overview.completed/overview.total*100)}%"></i></div>` : ''}</div></section>${S.snapshot?.schoolDay?.type === 'unknown' ? schoolDayStatus(S.snapshot) : ''}${approvalQueue(approvals, true)}<div class="today-grid" data-key="today-grid"><section class="panel agenda-panel"><div class="section-heading"><h2>Up next</h2><a href="#calendar" class="text-button">View calendar ↗</a></div>${todayAgenda()}</section><section class="panel chores-panel"><div class="section-heading"><h2>${S.session?.role === 'child' ? 'My next tasks' : 'What needs doing'}</h2><a href="#chores" class="text-button">All tasks ↗</a></div>${profileFilter()}<div class="home-task-list">${active.length ? active.slice(0,4).map(item => choreRow(item)).join('') : `<p class="quiet-empty">${groups.submitted.length ? 'Your work is waiting for parent approval.' : 'No unfinished tasks. Nice work!'}</p>`}</div><div class="task-list-footer">${groups.completed.length ? `<span class="soft-label">${groups.completed.length} completed tasks tucked away</span>` : '<span></span>'}<a href="#chores" class="more-link">${active.length > 4 ? `View ${active.length - 4} more tasks →` : 'View all tasks →'}</a></div></section></div>${internet.summary(true)}`;
}

function calendarView() {
  const range = calendarRange(S.selectedDate, S.calendarMode);
  const dayCount = S.calendarMode === 'month' ? 42 : S.calendarMode === 'week' ? 7 : 1;
  const dates = Array.from({ length: dayCount }, (_, index) => addDays(range.from, index));
  const heading = S.calendarMode === 'month' ? dateLabel(`${S.selectedDate.slice(0, 7)}-01`, { weekday: undefined, month: 'long', day: undefined, year: 'numeric' }) : S.calendarMode === 'week' ? `${dateLabel(range.from, { weekday: undefined, month: 'short', day: 'numeric' })} – ${dateLabel(addDays(range.to, -1), { weekday: undefined, month: 'short', day: 'numeric' })}` : dateLabel(S.selectedDate);
  return `<section class="panel calendar-panel calendar-${S.calendarMode}" data-key="calendar-panel"><div class="calendar-toolbar"><div class="date-navigation">${button('‹', 'previous-date', 'icon-button', 'aria-label="Previous period"')}<h2>${h(heading)}</h2>${button('›', 'next-date', 'icon-button', 'aria-label="Next period"')}${button('Today', 'calendar-today', 'text-button')}</div><div class="segmented" role="group" aria-label="Calendar view">${['day', 'week', 'month'].map(mode => button(mode[0].toUpperCase() + mode.slice(1), 'calendar-mode', `segment ${S.calendarMode === mode ? 'selected' : ''}`, `data-mode="${mode}" aria-pressed="${S.calendarMode === mode}"`)).join('')}</div>${button(S.calendarShowingBusy ? 'Refreshing…' : 'Refresh', 'refresh-calendar', 'text-button', S.calendarShowingBusy ? 'disabled' : '')}</div>${calendarStatus()}${calendarLegend()}
    ${S.calendarMode === 'month' ? `<div class="month-grid" data-key="month-grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<div class="month-weekday" data-key="weekday-${day}">${day}</div>`).join('')}${dates.map(date => { const events = eventDays().get(date) || noEvents; return `<button type="button" class="month-day ${date === today() ? 'is-today' : ''} ${date.slice(0, 7) !== S.selectedDate.slice(0, 7) ? 'outside-month' : ''} ${date === S.selectedDate ? 'selected-date' : ''}" data-key="month-${date}" data-action="select-date" data-date="${date}" aria-label="${h(dateLabel(date))}${calendarDayIsKnown(S.calendar, date) ? `, ${events.length} events` : ', calendar not confirmed'}"><strong>${Number(date.slice(-2))}</strong><span>${events.slice(0, 2).map(event => `<span class="month-event" style="--event:${color(eventMetadata(event)?.color || '#00748c')}">${h(event.title || 'Untitled event')}</span>`).join('')}${events.length > 2 ? `<small aria-label="${events.length} events">+${events.length - 2}</small>` : ''}</span></button>`; }).join('')}</div>` : `<div class="agenda-days ${S.calendarMode === 'week' ? 'week-agenda' : ''}" data-key="${S.calendarMode}-agenda">${dates.map(date => `<section class="agenda-day ${date === today() ? 'is-today' : ''}" data-key="agenda-${date}"><header><span>${h(dateLabel(date, { weekday: 'short', month: undefined, day: undefined }))}</span><strong>${Number(date.slice(-2))}</strong></header><div class="event-list">${eventList(date)}</div></section>`).join('')}</div>`}
    ${S.calendarMode === 'month' ? `<section class="selected-day-agenda" data-key="selected-day-agenda"><h2>${h(dateLabel(S.selectedDate))}</h2><div class="event-list">${eventList(S.selectedDate)}</div></section>` : ''}<p class="footnote">Apple Calendar is read-only here. Add or edit events in your Calendar app.</p></section>`;
}

function choresView() {
  if (!S.snapshot) return '<section class="panel">Loading shared tasks…</section>';
  const selectedPerson = people().length === 1 ? people()[0].id : S.taskPerson;
  const all = scheduledChores(), selected = selectedPerson === 'all' ? all : all.filter(item => item.personId === selectedPerson);
  const groups = taskGroups(selected, S.snapshot.schoolDay), list = S.taskStatus === 'waiting' ? groups.submitted : S.taskStatus === 'completed' ? groups.completed : S.taskStatus === 'all' ? selected : activeTasks(selected, groups);
  const selectedRoutines = routines().filter(item => (S.taskPerson === 'all' || item.personId === S.taskPerson) && (!S.routineQuery || `${item.title} ${profileLabel(item.personId)}`.toLowerCase().includes(S.routineQuery.toLowerCase())) && (!S.routineSchedule || item.scheduleType === S.routineSchedule));
  return `${choreManager() ? `<div class="task-toolbar"><div class="segmented task-view-switch" role="group" aria-label="Task view">${['today','routines'].map(mode => button(mode === 'today' ? 'Today' : 'Routines', 'task-mode', `segment ${S.taskMode === mode ? 'selected' : ''}`, `data-mode="${mode}" aria-pressed="${S.taskMode === mode}"`)).join('')}</div>${button('+ Add a task', 'add-chore')}</div>` : ''}${profileFilter()}${S.taskMode === 'routines' && choreManager() ? `<section class="panel all-chores"><div class="section-heading"><h2>Task routines</h2><span class="soft-label">Changes apply to future days</span></div><div class="routine-filters"><label class="field" data-key="routine-search"><span>Find a routine</span><input type="search" data-routine-search name="routineSearch" value="${h(S.routineQuery || '')}" placeholder="Task or family profile"></label><label class="field"><span>Schedule</span><select data-routine-schedule><option value="">All schedules</option><option value="weekly" ${S.routineSchedule === 'weekly' ? 'selected' : ''}>Weekly routines</option><option value="one_off" ${S.routineSchedule === 'one_off' ? 'selected' : ''}>One-time tasks</option></select></label></div><div class="definition-list">${selectedRoutines.map(chore => `<div data-key="definition-${h(chore.id)}"><span><strong>${h(chore.title)}</strong><small>${h(profileLabel(chore.personId))} · ${chore.scheduleType === 'one_off' ? `Once on ${h(chore.scheduledDate)}` : h(chore.weekdays.map(day => days[day]).join(', '))} · ${h(schoolDayFilterLabel(chore.schoolDayFilter))} · ${chore.required === false ? 'Optional' : 'Required'}</small></span>${button('Edit', 'edit-chore', 'text-button', `data-id="${h(chore.id)}" aria-label="Edit ${h(chore.title)}"`)}</div>`).join('') || '<p class="quiet-empty">No matching routines.</p>'}</div></section>` : `${schoolDayStatus(S.snapshot)}<div class="task-status-filter" role="group" aria-label="Task status">${[['active',`To do · ${groups.todo.length}`],['waiting',`Waiting for approval · ${groups.submitted.length}`],['completed',`Done · ${groups.completed.length}`],['all','All']].map(([id,label]) => button(id === 'waiting' ? `Waiting · ${groups.submitted.length}` : label, 'task-status', `filter-pill ${S.taskStatus === id ? 'selected' : ''}`, `data-id="${id}" aria-label="${h(label)}" aria-pressed="${S.taskStatus === id}"`)).join('')}</div>${S.taskStatus === 'waiting' && choreManager() ? (approvalQueue(groups.submitted) || '<section class="panel"><p class="quiet-empty">No tasks waiting for approval.</p></section>') : `<section class="panel person-lane focused-tasks"><header><div><h2>${selectedPerson === 'all' ? 'Family tasks' : h(profileLabel(selectedPerson))}</h2><p>${taskOverview(selected,S.snapshot.schoolDay).total ? `${taskProgress(selected,S.snapshot.schoolDay).completed} of ${taskProgress(selected,S.snapshot.schoolDay).total} required tasks done` : 'No required tasks today'}</p></div></header>${list.length || S.taskStatus === 'active' ? taskListMarkup(list, selectedPerson === 'all', selectedPerson === 'all' ? '' : selectedPerson) : '<p class="quiet-empty">Nothing in this view.</p>'}</section>`}${groups.history.length && S.taskStatus !== 'all' ? `<details class="panel earlier-schedule"><summary>Earlier schedule and excused work · ${groups.history.length}</summary><p class="supporting">Saved for history; these tasks do not count toward today’s required work.</p>${groups.history.map(item=>choreRow(item)).join('')}</details>` : ''}`}<details class="task-tools"><summary>History and schedule tools</summary><div class="chore-tools">${button('Task history','chore-history','button button-secondary')}${choreManager() ? button('School calendar','school-calendar','button button-secondary')+button('Task breaks','chore-breaks','button button-secondary') : ''}</div><p class="field-help">School dates choose routines. Task breaks excuse work for a trip or time away.</p></details>`;
}

function profileCards() {
  return `<section class="panel setup-card"><div class="section-heading"><div><p class="eyebrow">Who's in your home</p><h2>Family profiles</h2></div>${button('+ Add', 'add-person', 'text-button')}</div><p class="supporting">Profiles organize task assignments. Use a child invitation to link a profile to the child's own account.</p><div class="profile-list">${people().map(profile => `<div>${avatar(profile)}<strong>${h(profile.name)}</strong>${button('Edit', 'edit-person', 'text-button', `data-id="${h(profile.id)}"`)}</div>`).join('') || '<p class="quiet-empty">Add your first family member.</p>'}</div></section>`;
}

function appleSettings() {
  const connection = S.connection;
  return `<section class="panel setup-card"><div class="section-heading"><div><p class="eyebrow">Private by design</p><h2>Apple Calendar</h2></div><span class="badge">${connection === null ? 'Checking…' : connection.connected ? 'Connected' : 'Not connected'}</span></div><p class="supporting">Connect privately with your Apple Account email and an app-specific password. Your calendars are read-only on the frame.</p>
    ${connection?.connected ? '<details class="reconnect-calendar"><summary>Reconnect Apple Calendar</summary>' : ''}<form data-form="calendar-connection" class="form-stack">${field('Apple Account email', 'username', '', { type: 'email', autocomplete: 'username' })}${field('App-specific password', 'appPassword', '', { type: 'password', autocomplete: 'new-password', max: 100 })}<p class="field-help">Create an app-specific password in your Apple Account settings. Your regular Apple Account password is not used.</p>${formError()}<button class="button" type="submit">${connection?.connected ? 'Update connection' : 'Connect Apple Calendar'}</button></form>${connection?.connected ? '</details>' : ''}
    ${connection?.connected ? `<form data-form="calendar-selection" class="form-stack calendar-selection"><h3>Calendars to show</h3>${connection.calendars.length ? connection.calendars.map(calendar => `<label class="checkbox-label"><input name="calendarIds" value="${h(calendar.id)}" type="checkbox" ${calendar.selected ? 'checked' : ''}><span class="calendar-color" style="background:${color(calendar.color)}"></span><span>${h(calendar.name)}</span></label>`).join('') : '<p class="quiet-empty">No calendars were returned by this connection.</p>'}${formError()}<button class="button button-secondary" type="submit">Save calendar selection</button></form>${button('Disconnect Apple Calendar', 'disconnect-calendar', 'text-button danger-text')}` : ''}</section>`;
}

function deviceSettings() {
  return `<section class="panel setup-card"><div class="section-heading"><div><p class="eyebrow">A place on your wall</p><h2>Pair your frame</h2></div></div><p class="supporting">Create a short-lived code here, then enter it in Setup on the frame. Paired frames can read the calendar and complete tasks.</p><form data-form="create-pair" class="form-stack">${field('Frame name', 'label', 'Family frame', { max: 80 })}${formError()}<button class="button button-secondary" type="submit">Create pairing code</button></form>${S.pairing ? `<div class="share-result"><span class="eyebrow">Enter on the frame</span><strong class="pairing-code">${h(S.pairing.code)}</strong><span>Expires ${h(new Date(S.pairing.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span></div>` : ''}<div class="device-list">${S.devices.filter(device => !device.revokedAt).map(device => `<div><span><strong>${h(device.label)}</strong><small>${device.lastSeenAt ? `Last seen ${h(updateStamp(device.lastSeenAt).replace('Updated ', ''))}` : 'Not yet seen'}</small></span>${button('Revoke', 'revoke-device', 'text-button danger-text', `data-id="${h(device.id)}" data-label="${h(device.label)}"`)}</div>`).join('')}</div></section>`;
}

function inviteSettings() {
  return `<section class="panel setup-card"><div class="section-heading"><div><p class="eyebrow">Share the little things</p><h2>Invite family</h2></div></div><h3>A child's own account</h3><p class="supporting">Choose a profile and the child's own email. They create a password, confirm that exact email, then accept your private invitation. Children can view the shared calendar and complete only their own tasks.</p><form data-form="create-child-invite" class="form-stack"><label class="field"><span>Child profile</span><select name="personId" aria-label="Child profile" required><option value="">Choose a profile</option>${people().map(profile => `<option value="${h(profile.id)}">${h(profile.name)}</option>`).join('')}</select></label>${field('Child email', 'email', '', { type: 'email', max: 254 })}${formError()}<button class="button" type="submit" ${people().length ? '' : 'disabled'}>Create child invitation</button></form><p class="supporting">For another adult, create a family-member invitation. Family members can view the shared calendar and complete family tasks.</p>${button('Create an invitation', 'create-invite', 'button button-secondary')}${S.generatedInvite ? `<div class="share-result">${S.generatedInvite.role === 'child' ? `<strong>For ${h(profileLabel(S.generatedInvite.personId))}</strong><small>${h(S.generatedInvite.email)}</small>` : ''}<label class="field"><span>Invitation link · share privately</span><input readonly data-share-value value="${h(`${location.origin}/family.html#invite=${encodeURIComponent(S.generatedInvite.token)}`)}"></label>${button('Copy invitation', 'copy-invite', 'text-button')}<small>Expires ${h(new Date(S.generatedInvite.expiresAt).toLocaleString())}</small></div>` : ''}<div class="device-list">${S.members.map(member => `<div><span><strong>${h(member.name || member.email || 'Family member')}</strong><small>${h(member.role === 'admin' ? 'Administrator' : member.role === 'child' ? `Child · ${profileLabel(member.personId)}` : 'Family member')}</small></span>${member.role === 'member' ? button('Permissions', 'member-capabilities', 'text-button', `data-id="${h(member.id)}"`) : ''}${['member','child'].includes(member.role) && member.id !== S.session.user.id ? button('Remove', 'remove-member', 'text-button danger-text', `data-id="${h(member.id)}" data-label="${h(member.name || member.email || 'This person')}"`) : ''}</div>`).join('')}</div></section>`;
}

function setupView() {
  if (frame()) return `<section class="panel frame-settings"><h2>Your frame is paired.</h2><p>Manage your family, schedules and connections from a signed-in phone.</p><p class="soft-label">Timezone: ${h(zone())}</p>${button('Remove this frame connection','unpair-local','button button-secondary danger-text')}</section>${workbench.unlockPanel()}`;
  const account = `<section class="panel setup-card"><p class="eyebrow">Your account</p><h2>${h(S.session?.user?.name || 'Family member')}</h2><p class="supporting">${h(S.session?.user?.email || '')} · ${admin() ? 'Parent administrator' : S.session?.role === 'child' ? 'Child account' : 'Family member'}</p>${button('Sign out','sign-out','button button-secondary')}${accountUI.tools()}</section>`;
  const sections = admin() ? [['family','Family','Profiles, invitations and household'],['tasks','Tasks & school','School calendar and task breaks'],['calendar','Calendar connection',S.connection?.connected ? 'Apple Calendar connected' : 'Connect Apple Calendar'],['frames','Frames',`${S.devices.filter(d=>!d.revokedAt).length} paired displays`],['notifications','Notifications & frame access','Preferences, quiet hours and unlock codes'],['account','Account','Your account and privacy']] : [['notifications','Notifications & frame access','Preferences, quiet hours and unlock codes'],['account','Account','Your account and privacy']];
  const chosen = sections.find(item=>item[0]===S.settingsSection);
  if (!chosen) return `<section class="settings-index">${admin() && (!people().length || !S.connection?.connected || !S.devices.some(d=>!d.revokedAt)) ? `<section class="panel setup-checklist"><h2>Make this space yours</h2><p class="supporting">Set up each connection once, then manage it here.</p><ol>${[[people().length>0,'family','Add family profiles'],[S.connection?.connected,'calendar','Connect your calendar'],[S.devices.some(d=>!d.revokedAt),'frames','Pair a frame']].map(([complete,id,label])=>`<li>${button(`${complete?'✓ ':''}${label}`,'settings-section','text-button',`data-id="${id}"`)}<span>${complete?'Ready':'Not set up'}</span></li>`).join('')}</ol></section>` : ''}<div class="settings-rows">${sections.map(([id,name,detail])=>`<button class="settings-row" data-action="settings-section" data-id="${id}"><span><strong>${h(name)}</strong><small>${h(detail)}</small></span><span aria-hidden="true">›</span></button>`).join('')}<a href="#devices" class="settings-row"><span><strong>Internet & devices</strong><small>Device access, rewards and limits</small></span><span aria-hidden="true">›</span></a></div></section>`;
  const content = chosen[0] === 'account' ? account : chosen[0] === 'notifications' ? workbench.unlockPanel() : chosen[0] === 'family' ? `<section class="panel setup-card"><p class="eyebrow">The basics</p><h2>Your household</h2><form data-form="settings" class="form-stack">${field('Household name', 'title', title(), { max: 80 })}${field('Timezone', 'timezone', zone(), { max: 80, extra: 'list="timezones"' })}<datalist id="timezones">${['America/Denver', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'America/Phoenix', 'Europe/London', 'UTC'].map(value => `<option value="${value}"></option>`).join('')}</datalist><p class="field-help">Calendar times and recurring task days use this timezone.</p>${formError()}<button class="button button-secondary" type="submit">Save household</button></form></section>${profileCards()}${inviteSettings()}` : chosen[0] === 'calendar' ? appleSettings() : chosen[0] === 'frames' ? deviceSettings() : `${workbench.schoolCalendarPanel()}<section class="panel"><h2>Time away</h2><p class="supporting">Change a school date to select different routines. Pause tasks for a trip to excuse work instead.</p>${button('Task breaks','chore-breaks','button button-secondary')}</section>`;
  return `<div class="settings-section-heading">${button('← All settings','settings-section','text-button','data-id=""')}<h2>${h(chosen[1])}</h2></div><div class="settings-detail">${content}</div>`;
}

function entryView() {
  let authForm;
  if (S.authMode === 'recover') {
    authForm = `<p class="eyebrow">Account recovery</p><h2>Reset your password.</h2><p class="supporting">Request a recovery email, then enter its code or paste its full recovery link here.</p><form data-form="request-password-reset" class="form-stack">${field('Account email', 'email', S.verificationEmail, { type: 'email', autocomplete: 'email' })}${formError()}<button type="submit" class="button">Send recovery email</button></form><p class="form-switch">Already have the email? ${button('Enter recovery details', 'auth-mode', 'text-button', 'data-mode="reset"')}</p><p class="form-switch">${button('Back to sign in', 'auth-mode', 'text-button', 'data-mode="sign-in"')}</p>`;
  } else if (S.authMode === 'reset') {
    authForm = `<p class="eyebrow">Account recovery</p><h2>Choose a new password.</h2><p class="supporting">Use the recovery code and account email, or paste the full recovery link. Links are verified by this app’s server.</p><form data-form="reset-password" class="form-stack">${field('Account email (for code)', 'email', S.verificationEmail, { type: 'email', autocomplete: 'email', required: false })}${field('Recovery email code', 'token', '', { required: false, max: 10, autocomplete: 'one-time-code', extra: 'inputmode="numeric" pattern="[0-9]{6,10}"' })}${field('Or full recovery link', 'recoveryLink', '', { type: 'url', required: false, max: 3000 })}${field('New password', 'password', '', { type: 'password', autocomplete: 'new-password', max: 128, extra: 'minlength="12"' })}${field('Confirm new password', 'confirmPassword', '', { type: 'password', autocomplete: 'new-password', max: 128, extra: 'minlength="12"' })}${formError()}<button type="submit" class="button">Reset password</button></form><p class="field-help">Other sign-ins will end. Sign in again after resetting.</p><p class="form-switch">${button('Back to sign in', 'auth-mode', 'text-button', 'data-mode="sign-in"')}</p>`;
  } else if (S.authMode === 'verify') {
    authForm = `<p class="eyebrow">One more step</p><h2>Confirm your email.</h2><p class="supporting">Check the confirmation email for your account. Enter its code, or paste the full confirmation link below. Your account gains family access only after you join or claim a household.</p><div class="segmented verification-tabs" role="group" aria-label="Email confirmation method">${button('Enter code', 'verification-method', `segment ${S.verificationMethod === 'code' ? 'selected' : ''}`, `data-method="code" aria-pressed="${S.verificationMethod === 'code'}"`)}${button('Paste link', 'verification-method', `segment ${S.verificationMethod === 'link' ? 'selected' : ''}`, `data-method="link" aria-pressed="${S.verificationMethod === 'link'}"`)}</div><form data-form="verify-email" class="form-stack">${field('Email', 'email', S.verificationEmail, { type: 'email', autocomplete: 'email' })}${S.verificationMethod === 'code' ? field('Email confirmation code', 'token', '', { max: 10, autocomplete: 'one-time-code', extra: 'inputmode="numeric" pattern="[0-9]{6,10}"' }) : field('Full confirmation link from the email', 'confirmationLink', '', { type: 'url', autocomplete: 'off', max: 3000 })}<p class="field-help">${S.verificationMethod === 'code' ? 'Use the code from the confirmation email. If it contains a link instead, choose Paste link.' : 'The link is checked by our server. This page does not open or follow it.'}</p>${formError()}<button class="button" type="submit">Confirm email</button>${button('Resend confirmation email', 'resend-verification', 'text-button')}</form><p class="form-switch">Already confirmed? ${button('Back to sign in', 'auth-mode', 'text-button', 'data-mode="sign-in"')}</p>`;
  } else if (S.authMode === 'sign-up') {
    authForm = `<p class="eyebrow">A place for your people</p><h2>Create your account</h2><form data-form="sign-up" class="form-stack">${field('Your name', 'name', '', { autocomplete: 'name', max: 100 })}${field('Email', 'email', S.verificationEmail, { type: 'email', autocomplete: 'email' })}${field('Password', 'password', '', { type: 'password', autocomplete: 'new-password', max: 128, extra: 'minlength="12"' })}${formError()}<button class="button" type="submit">Create account</button></form><p class="form-switch">Already have an account? ${button('Sign in', 'auth-mode', 'text-button', 'data-mode="sign-in"')}</p>`;
  } else {
    authForm = `<p class="eyebrow">Welcome home</p><h2>Your family, together.</h2><p class="supporting">A shared calendar. A little teamwork. More room for the good stuff.</p><form data-form="sign-in" class="form-stack">${field('Email', 'email', S.verificationEmail, { type: 'email', autocomplete: 'email' })}${field('Password', 'password', '', { type: 'password', autocomplete: 'current-password', max: 128 })}${formError()}<button class="button" type="submit">Sign in</button></form><p class="form-switch">${button('Forgot your password?', 'auth-mode', 'text-button', 'data-mode="recover"')}</p><p class="form-switch">New here? ${button('Create an account', 'auth-mode', 'text-button', 'data-mode="sign-up"')}</p><p class="form-switch">Waiting to confirm your email? ${button('Confirm email', 'auth-mode', 'text-button', 'data-mode="verify"')}</p>`;
  }
  const pairForm = `<p class="supporting">On an administrator's phone, open Settings → Frames and create a pairing code. Enter that code here to connect this display.</p><form data-form="redeem-pair" class="form-stack">${field('Six-digit pairing code', 'code', '', { max: 6, extra: 'inputmode="numeric" pattern="[0-9]{6}"' })}${formError()}<button class="button" type="submit">Pair this frame</button></form>`;
  const content = S.entryPair ? `<div class="auth-card"><p class="eyebrow">A place on your wall</p><h2>Bring your<br>family home.</h2>${pairForm}<p class="form-switch">Using your phone? ${button('Sign in to your account', 'show-account-entry', 'text-button')}</p></div>` : `<div class="auth-card">${authForm}</div><details class="pair-entry"><summary>Setting up your photo frame?</summary>${pairForm}</details>`;
  return `<main id="main-content" class="entry-layout"><section class="entry-story"><a class="entry-brand" href="/family.html"><img src="/brand/folded-home.svg" alt="" width="48" height="48"><div>Family Frame<span>A little more together.</span></div></a><div class="entry-clock">${clockMarkup()}</div><div class="entry-art" aria-hidden="true"><span></span><span></span><span></span></div><p class="entry-tagline">The everyday,<br><em>shared.</em></p><p class="entry-footnote">Your calendar stays private.<br>Your family stays connected.</p><a class="entry-privacy" href="/privacy.html" target="_blank" rel="noopener">Privacy policy</a></section><section class="entry-content">${S.error ? `<div class="banner banner-error" role="alert">${h(S.error)}</div>` : ''}${S.message ? `<div class="banner" role="status">${h(S.message)}</div>` : ''}${content}</section></main>`;
}

function joinView() {
  return `<main id="main-content" class="membership-layout"><header class="simple-brand"><img src="/brand/folded-home.svg" alt="" width="40" height="40">Family Frame</header><section class="membership-intro"><p class="eyebrow">Signed in as ${h(S.session.user?.email || S.session.user?.name)}</p><h1>A place for<br><em>your family.</em></h1><p>Your account is ready. Join your family's household or claim this dashboard with its private setup code.</p>${button('Sign out', 'sign-out', 'text-button')}${accountUI.tools()}</section><div class="membership-grid"><section class="panel"><h2>Join your family</h2><p class="supporting">Paste the invitation token or link shared by your administrator.</p><form data-form="join" class="form-stack">${field('Invitation', 'token', S.inviteToken, { max: 2000 })}${formError()}<button class="button" type="submit">Join household</button></form></section><section class="panel"><h2>Set up your household</h2><p class="supporting">The private setup code makes you this dashboard's first administrator.</p><form data-form="claim" class="form-stack">${field('Household name', 'title', 'Our family', { max: 80 })}${field('Private setup code', 'bootstrapCode', '', { type: 'password', autocomplete: 'off', max: 200 })}${formError()}<button class="button button-secondary" type="submit">Create household</button></form></section></div></main>`;
}

function render(force = false) {
  ambient.sync();
  tickFrameEvents();
  if (!force && edited()) { pendingRender = true; return; }
  pendingRender = false;
  const busy = S.booting ? 'true' : 'false';
  if (app.getAttribute('aria-busy') !== busy) app.setAttribute('aria-busy', busy);
  document.documentElement.classList.toggle('frame-display', frame() || S.entryPair);
  let markup;
  if (S.booting) markup = '<main id="main-content" class="initial-state"><p class="eyebrow">Family Frame</p><h1>Opening your dashboard…</h1><p>Checking your family connection.</p></main>';
  else if (!S.session) markup = entryView();
  else if (!S.session.household) markup = joinView();
  else markup = shell(({ today: todayView, calendar: calendarView, chores: choresView, devices: internet.view, activity: workbench.activityView, setup: setupView })[S.view]());
  paintApp(markup);
  if (S.session?.household && paintedView !== S.view) {
    const main = app.querySelector('.main-content');
    if (main) main.scrollTop = 0;
  }
  paintedView = S.session?.household ? S.view : null;
  paintClock();
}

async function loadHousehold() {
  const epoch = generation;
  const data = await request(`/api/household?date=${today()}`);
  if (epoch !== generation) return false;
  let snapshot = reconcileHousehold(S.snapshot, data);
  for (const item of S.snapshot?.occurrences || []) snapshot = mergeOccurrence(snapshot, item);
  if (JSON.stringify(snapshot) !== JSON.stringify(S.snapshot)) S.snapshot = snapshot;
  if (S.session) { S.session.household = data.household; S.session.role = data.role; }
  S.error = '';
  render();
  refreshTaskDetails();
  return true;
}

function invalidateCalendar() {
  calendarGeneration++;
  S.calendarBusy = false;
  S.calendarShowingBusy = false;
  queuedCalendar = null;
  S.calendar = null; S.frameCalendar = null; frameEvents.reset();
}

async function loadCalendar(explicit = false) {
  if (!S.session?.household) return false;
  if (S.calendarBusy) { queuedCalendar = { explicit: explicit || queuedCalendar?.explicit }; return false; }
  const epoch = generation;
  const calendarEpoch = calendarGeneration;
  const current = () => epoch === generation && calendarEpoch === calendarGeneration;
  const range = S.view === 'calendar' ? calendarRange(S.selectedDate, S.calendarMode) : { from: today(), to: addDays(today(), 7) };
  S.calendarBusy = true;
  S.calendarShowingBusy = explicit || !S.calendar;
  if (S.calendarShowingBusy) render();
  try {
    const data = explicit && admin() ? await request('/api/calendar/sync', { method: 'POST', body: range }) : await request(`/api/calendar?from=${range.from}&to=${range.to}`);
    if (current() && JSON.stringify(data) !== JSON.stringify(S.calendar)) {
      if (S.calendar && JSON.stringify(data.events) === JSON.stringify(S.calendar.events)) data.events = S.calendar.events;
      S.calendar = data;
    }
    if (current() && frame()) {
      const day = today();
      if (data.coverage?.startDate <= day && data.coverage?.endDateExclusive > day) S.frameCalendar = data;
      else {
        // Browsing another month must not turn off today's frame reminders.
        try {
          const currentDay = await request(`/api/calendar?from=${day}&to=${addDays(day, 7)}`);
          if (current()) S.frameCalendar = currentDay;
        } catch (error) {
          if (current()) {
            S.frameCalendar = null;
            if (error.status === 401 || error.status === 403) dataFailure(error);
          }
          return false;
        }
      }
    }
    return current();
  } catch (error) {
    if (!current()) return false;
    if (error.status === 401 || error.status === 403) { dataFailure(error); return false; }
    S.frameCalendar = null;
    S.calendar = { ...S.calendar, status: S.calendar?.events?.length ? 'stale' : 'error', events: S.calendar?.events || [], error: { message: errorMessage(error) } };
    return false;
  } finally {
    if (current()) {
      S.calendarBusy = false;
      S.calendarShowingBusy = false;
      tickFrameEvents();
      render();
      if (queuedCalendar) { const next = queuedCalendar; queuedCalendar = null; loadCalendar(next.explicit); }
    }
  }
}

async function loadSetup() {
  if (!admin() || S.setupBusy) return;
  const epoch = generation;
  S.setupBusy = true;
  const results = await Promise.allSettled([request('/api/calendar/connection'), request('/api/devices'), request('/api/members')]);
  if (epoch !== generation) return;
  S.setupBusy = false;
  if (results[0].status === 'fulfilled') S.connection = results[0].value;
  if (results[1].status === 'fulfilled') S.devices = results[1].value.devices;
  if (results[2].status === 'fulfilled') S.members = results[2].value.members;
  const failed = results.find(result => result.status === 'rejected');
  if (failed) {
    if (failed.reason.status === 401 || failed.reason.status === 403) { dataFailure(failed.reason); return; }
    S.error = errorMessage(failed.reason);
  }
  render();
}

async function boot() {
  const epoch = ++generation;
  frameEvents.reset();
  if (dialog.open) dialog.close();
  clearAuthCache();
  S.calendarBusy = false;
  S.calendarShowingBusy = false;
  S.setupBusy = false;
  queuedCalendar = null;
  S.snapshot = null; S.calendar = null; S.frameCalendar = null; S.connection = null; S.devices = []; S.members = [];
  workbench.reset();
  internet.reset();
  liveUpdates.reset(); S.liveIssue='';
  S.generatedInvite = null; S.pairing = null; S.taskPerson = 'all'; S.taskMode = 'today'; S.taskStatus = 'active';
  S.recentTasks.clear(); S.pending.clear(); S.conflicts.clear(); S.failures.clear(); S.attempts.clear();
  S.booting = true;
  render(true);
  try {
    setFrameMode(false);
    try { S.session = await request('/api/session', { authenticated: false }); }
    catch (error) { if (error.status !== 401 || S.entryPair) throw error; S.session = await request('/api/session'); }
    setFrameMode(S.session.authType === 'frame');
    S.selectedDate = today();
    if (S.session.household) {
      await loadHousehold();
      if (epoch !== generation) return;
      S.booting = false;
      render(true);
      await Promise.allSettled([loadCalendar(), !frame() ? workbench.loadActivity() : Promise.resolve(), S.view === 'setup' ? loadSetup() : Promise.resolve(), Array.isArray(S.snapshot?.occurrences) || S.view === 'devices' ? internet.load() : Promise.resolve()]);
    }
  } catch (error) {
    if (error.status === 401) {
      S.session = null;
    } else S.error = errorMessage(error);
  } finally {
    if (epoch === generation) { S.booting = false; render(true); }
  }
}

async function refresh() {
  if (!S.session?.household) return boot();
  try { await loadHousehold(); await Promise.allSettled([loadCalendar(), internet.loaded() || Array.isArray(S.snapshot?.occurrences) ? internet.load() : Promise.resolve()]); if (S.view === 'setup') await loadSetup(); }
  catch (error) { dataFailure(error); }
}

function dataFailure(error) {
  if (error.code === 'invalid_unlock' && frame()) { workbench.reset(); boot(); return; }
  if (error.status === 401 || error.status === 403) {
    generation++;
    frameEvents.reset();
    clearAuthCache();
    workbench.reset();
    internet.reset();
    S.session = null; S.snapshot = null; S.calendar = null; S.frameCalendar = null; S.connection = null; S.devices = []; S.members = [];
    S.generatedInvite = null; S.pairing = null;
    S.pending.clear(); S.conflicts.clear(); S.failures.clear(); S.attempts.clear();
    S.message = 'Your family connection is no longer active. Sign in again or pair this frame with a new code.';
    S.error = '';
    setFrameMode(false);
    if (dialog.open) dialog.close();
    render(true);
  } else { S.error = errorMessage(error); render(); }
}

function taskApproved(item, result) {
  const confirmed = result?.occurrence || result, current = S.snapshot?.occurrences?.find(task => task.id === item.id);
  if (!current || confirmed?.status !== 'completed' || confirmed.date !== S.snapshot.date || current.status === 'completed' || current.version > confirmed.version) return;
  const progress = snapshot => taskProgress(snapshot.occurrences.filter(task => task.personId === item.personId), snapshot.schoolDay);
  const cue = taskCompletionCue(progress(S.snapshot), progress(mergeOccurrence(S.snapshot, confirmed)), {completed:true, status:confirmed.status});
  const played = sound(cue, {key:cue === 'allDone' ? `all:${S.session.household.id}:${confirmed.date}:${item.personId || 'shared'}` : `task:${item.id}:${confirmed.date}:${confirmed.version}`});
  if (cue === 'allDone' && !played) sounds.play('complete');
}

async function saveCompletion(chore, desired) {
  const date = S.snapshot.date;
  const key = `${chore.id}:${date}`;
  if (S.pending.has(key)) return;
  const previous = S.attempts.get(key);
  // Reuse the original idempotency key after an uncertain network response.
  // An explicit conflict retry instead uses the newly displayed server version.
  const occurrence = !!chore.status;
  const body = S.failures.has(key) && previous?.completed === desired ? previous : occurrence
    ? { completed: desired, expectedVersion: chore.version, mutationId: mutationId() } : completionBody(chore, date, desired, mutationId());
  const epoch = generation;
  S.attempts.set(key, body);
  S.pending.set(key, desired);
  S.conflicts.delete(key);
  S.failures.delete(key);
  render(true);
  try {
    const result = await request(occurrence ? `/api/chore-occurrences/${idPath(chore.id)}/completion` : `/api/chores/${idPath(chore.id)}/completions/${date}`, { method: 'PUT', body });
    if (epoch !== generation) return;
    const beforeProgress = taskProgress(scheduledChores().filter(item => item.personId === chore.personId), S.snapshot.schoolDay);
    const beforeTask = scheduledChores().find(item => item.id === chore.id);
    if (occurrence) S.snapshot = mergeOccurrence(S.snapshot, result.occurrence || result);
    else if (S.snapshot?.date === date) S.snapshot.chores = mergeCompletion(S.snapshot.chores, result, date);
    const current = S.snapshot?.chores.find(item => item.id === chore.id)?.completion;
    toast(current?.version > result.version ? 'Your change was saved earlier. A newer update from another device is shown.' : (result.occurrence || result).status === 'submitted' ? 'Submitted. Waiting for parent approval.' : desired ? 'Task completed. Saved for the family.' : 'Task reopened. Saved for the family.');
    const afterTask = scheduledChores().find(item => item.id === chore.id);
    const confirmed = result.occurrence || result;
    const responseVersion = confirmed.version;
    const visibleVersion = occurrence ? afterTask?.version : afterTask?.completion?.version;
    if (S.snapshot.date === date && afterTask && visibleVersion === responseVersion &&
      (occurrence ? beforeTask?.status !== afterTask.status : beforeTask?.completion?.completed !== afterTask.completion?.completed)) {
      const afterProgress = taskProgress(scheduledChores().filter(item => item.personId === chore.personId), S.snapshot.schoolDay);
      const cue = taskCompletionCue(beforeProgress, afterProgress, { completed:desired, status:afterTask.status });
      const played = sound(cue, { key:cue === 'allDone' ? `all:${S.session.household.id}:${date}:${chore.personId || 'shared'}` : `task:${chore.id}:${date}:${responseVersion}` });
      if (cue === 'allDone' && !played) sounds.play('complete');
    }
    S.recentTasks.add(chore.id);
    S.attempts.delete(key);
    if (occurrence) await loadHousehold().catch(dataFailure);
    if (occurrence && epoch === generation) await internet.load();
  } catch (error) {
    if (epoch !== generation) return;
    sound('error');
    if (error.status === 401 || error.status === 403) { dataFailure(error); return; }
    if (error.status === 409 && error.details?.current) {
      if (occurrence) S.snapshot = mergeOccurrence(S.snapshot, error.details.current);
      else if (S.snapshot?.date === date) S.snapshot.chores = mergeCompletion(S.snapshot.chores, error.details.current, date);
      S.conflicts.set(key, desired);
      S.attempts.delete(key);
    } else {
      S.failures.set(key, `${errorMessage(error)} Your change has not been confirmed.`);
    }
  } finally { if (epoch === generation) { S.pending.delete(key); render(); refreshTaskDetails(); } }
}

function openDialog(titleText, contents, onSubmit) {
  closeDraftGuard?.();
  delete dialog.dataset.taskId;
  dialog.innerHTML = `<form data-dialog-form><header class="dialog-heading"><h2 id="dialog-title">${h(titleText)}</h2><button class="icon-button" type="button" data-close-dialog aria-label="Close dialog">×</button></header><div class="dialog-body">${contents}${formError()}</div><footer class="dialog-footer" hidden></footer></form>`;
  const form = dialog.querySelector('form'), footer = dialog.querySelector('.dialog-footer');
  const submit = [...form.querySelectorAll('button[type="submit"]')].pop();
  if (submit) {
    const actions = submit.closest('.dialog-actions') || submit;
    footer.hidden = false;
    footer.append(actions);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'text-button'; cancel.dataset.closeDialog = ''; cancel.textContent = 'Cancel'; footer.prepend(cancel);
    if (form.querySelector('[name="title"]')) { const scope = document.createElement('p'); scope.className = 'field-help save-scope'; scope.textContent = form.querySelector('.task-wizard') ? 'New tasks appear on their scheduled days.' : 'Routine changes apply to future days. Today’s saved work stays intact.'; footer.prepend(scope); }
  }
  form.querySelectorAll('[data-close-dialog]').forEach(button => { button.onclick = () => dialog.close(); });
  form.onsubmit = event => submitForm(event, onSubmit);
  dialog.showModal();
  sounds.play('open');
  closeDraftGuard = protectDialogDraft(dialog);
  const first = dialog.querySelector('.dialog-body input:not([type="hidden"]),.dialog-body select,.dialog-body textarea') || dialog.querySelector('[data-close-dialog]');
  first?.focus();
}

function editPerson(profile) {
  openDialog(profile ? 'Edit family profile' : 'Add family profile', `<div class="form-stack">${field('Name', 'name', profile?.name || '', { max: 80, autocomplete: 'name' })}${field('Profile color', 'color', color(profile?.color), { type: 'color' })}<div class="dialog-actions">${profile ? button('Delete profile', 'delete-person', 'text-button danger-text', `data-id="${h(profile.id)}"`) : ''}<button type="submit" class="button">${profile ? 'Save profile' : 'Add profile'}</button></div></div>`, async form => {
    await request(`/api/people${profile ? `/${idPath(profile.id)}` : ''}`, { method: profile ? 'PATCH' : 'POST', body: { name: form.get('name').trim(), color: form.get('color'), ...(profile ? { expectedVersion: profile.version } : {}) } });
    dialog.close(); toast('Family profile saved.');
    try { await loadHousehold(); } catch (error) { dataFailure(error); }
  });
}

function confirmAction(titleText, detail, label, run) {
  if (dialog.open) dialog.close();
  openDialog(titleText, `<p class="supporting">${h(detail)}</p><div class="dialog-actions"><button class="button button-danger" type="submit">${h(label)}</button></div>`, async () => { await run(); dialog.close(); render(true); });
}

async function submitForm(event, run) {
  event.preventDefault();
  const form = event.currentTarget?.tagName === 'FORM' ? event.currentTarget : event.target;
  const errorBox = form.querySelector('[data-form-error]');
  const submit = form.querySelector('button[type="submit"]');
  const oldLabel = submit?.textContent;
  if (submit?.disabled) return;
  form.dataset.submitting = 'true';
  if (submit) { submit.disabled = true; submit.textContent = 'Saving…'; }
  if (errorBox) { errorBox.hidden = true; errorBox.textContent = ''; }
  const soundVersion = soundFeedbackVersion, epoch = generation;
  try { await run(new FormData(form), form); frameIdle.saved(form); if (epoch === generation && soundVersion === soundFeedbackVersion) sound('saved'); }
  catch (error) {
    if (epoch === generation) sound('error');
    if (errorBox) { errorBox.textContent = `${errorMessage(error)}${error.status === 409 ? ' Another device changed this item. Close this form, refresh, and try again.' : ''}`; errorBox.hidden = false; }
  } finally {
    delete form.dataset.submitting;
    if (submit?.isConnected) { submit.disabled = !!form.dataset.reviewRequired; submit.textContent = form.dataset.reviewRequired ? 'Close and review before retrying' : oldLabel; }
    if (pendingRender && !edited()) render();
  }
}

const forms = {
  'request-password-reset': async form => {
    S.verificationEmail = form.get('email').trim();
    const result = await (await authClient()).requestPasswordReset({ email: S.verificationEmail });
    if (result.error) throw new Error(result.error.message);
    S.message = 'If the account can receive a recovery email, it has been requested. Check your inbox.';
    S.authMode = 'reset'; render(true);
  },
  'reset-password': async (form, element) => {
    const password = form.get('password'), confirmation = form.get('confirmPassword');
    if (password.length < 12 || password !== confirmation) throw new Error('Use matching passwords of at least 12 characters.');
    const recoveryLink = form.get('recoveryLink').trim(), token = form.get('token').trim(), email = form.get('email').trim();
    if ((!recoveryLink && (!email || !token)) || (recoveryLink && token)) throw new Error('Use either a full recovery link or the email and recovery code.');
    for (const name of ['password', 'confirmPassword', 'token', 'recoveryLink']) { element.querySelector(`[name="${name}"]`).value = ''; form.delete(name); }
    const result = await (await authClient()).resetPassword(recoveryLink ? { recoveryLink, password } : { email, token, password });
    if (result.error) throw new Error(result.error.message);
    S.authMode = 'sign-in'; S.verificationEmail = email; S.message = 'Password reset. Sign in with your new password.'; render(true);
  },
  'sign-in': async (form, element) => {
    setFrameMode(false);
    const auth = await authClient();
    S.verificationEmail = form.get('email').trim();
    const password = form.get('password');
    element.querySelector('[name="password"]').value = ''; form.delete('password');
    const result = await auth.signIn.email({ email: S.verificationEmail, password });
    if (result.error?.code === 'email_not_confirmed') { S.authMode = 'verify'; S.message = 'Confirm your email to finish signing in.'; render(true); return; }
    if (result.error) throw new Error(result.error.message || 'Could not sign in.');
    S.error = ''; S.message = ''; await boot();
  },
  'sign-up': async (form, element) => {
    setFrameMode(false);
    const auth = await authClient();
    S.verificationEmail = form.get('email').trim();
    const password = form.get('password');
    element.querySelector('[name="password"]').value = ''; form.delete('password');
    const result = await auth.signUp.email({ name: form.get('name').trim(), email: S.verificationEmail, password });
    if (result.error) throw new Error(result.error.message || 'Could not create your account.');
    if (result.data?.confirmationRequired) { S.authMode = 'verify'; S.message = 'Email confirmation is required before you can sign in. Check your inbox.'; render(true); return; }
    S.authMode = 'sign-in'; S.message = ''; await boot();
  },
  'verify-email': async (form, element) => {
    const auth = await authClient();
    S.verificationEmail = form.get('email').trim();
    const payload = S.verificationMethod === 'link' ? { confirmationLink: form.get('confirmationLink').trim() } : { email: S.verificationEmail, token: form.get('token').trim() };
    let result;
    try { result = await auth.verifyEmail(payload); }
    finally {
      const secret = element.querySelector('[name="token"], [name="confirmationLink"]');
      if (secret) secret.value = '';
      form.delete('token'); form.delete('confirmationLink');
    }
    if (result.error) throw new Error(result.error.message || 'Could not confirm your email.');
    S.message = ''; S.authMode = 'sign-in'; S.error = ''; await boot();
  },
  claim: async form => { S.session = await request('/api/claim', { method: 'POST', body: { bootstrapCode: form.get('bootstrapCode'), title: form.get('title').trim() } }); await boot(); },
  join: async form => {
    let token = form.get('token').trim();
    if (token.includes('#invite=')) { try { token = decodeURIComponent(new URL(token).hash.slice(8)); } catch { throw new Error('Paste a valid invitation link or token.'); } }
    S.session = await request('/api/join', { method: 'POST', body: { token } }); S.inviteToken = ''; await boot();
  },
  'redeem-pair': async form => { await request('/api/frame-pairs/redeem', { method: 'POST', body: { code: form.get('code').trim() }, authenticated: false }); S.message = ''; S.error = ''; await boot(); },
  settings: async form => {
    const timezone = form.get('timezone').trim();
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { throw new Error('Enter a valid timezone, such as America/Denver.'); }
    const result = await request('/api/settings', { method: 'PATCH', body: { title: form.get('title').trim(), timezone } });
    invalidateCalendar(); S.session.household = result.household; S.snapshot = null; await loadHousehold(); S.selectedDate = today(); await loadCalendar(); toast('Household settings saved.'); render(true);
  },
  'calendar-connection': async (form, element) => {
    try {
      S.connection = await request('/api/calendar/connection', { method: 'POST', body: { username: form.get('username').trim(), appPassword: form.get('appPassword') } });
      invalidateCalendar();
      element.reset(); toast('Apple Calendar connected. Choose the calendars to display.'); render(true); await loadCalendar();
    } finally {
      // Clear the app-specific password after every server response, including failures.
      element.querySelector('[name="appPassword"]').value = '';
      form.delete('appPassword');
    }
  },
  'calendar-selection': async form => { S.connection = await request('/api/calendar/selection', { method: 'PUT', body: { calendarIds: form.getAll('calendarIds') } }); invalidateCalendar(); toast('Calendar selection saved.'); await loadCalendar(true); render(true); },
  'create-pair': async form => { S.pairing = await request('/api/frame-pairs', { method: 'POST', body: { label: form.get('label').trim() } }); render(true); },
  'create-child-invite': async form => { S.generatedInvite = await request('/api/invites', { method: 'POST', body: { role: 'child', personId: form.get('personId'), email: form.get('email').trim() } }); toast('Child invitation created. Share the link privately.'); render(true); },
};

async function action(name, element, activation) {
  const id = element.dataset.id;
  if (name === 'frame-sounds' && frame()) { openFrameSounds(); return; }
  if (name === 'toggle-frame-sounds' && frame()) { sounds.update({ enabled:!sounds.preferences().enabled }); sounds.unlock(); dialog.close(); render(true); sounds.play('toggleOn'); return; }
  if (name === 'preview-frame-sound' && frame()) { sounds.unlock(); sounds.play(element.dataset.cue, {preview:true}); return; }
  if (await workbench.action(name, element)) return;
  if (await internet.action(name, element)) return;
  if (await accountUI.action(name, element)) return;

  if (name === 'task-person') { S.recentTasks.clear(); S.taskPerson = id; render(true); return; }
  if (name === 'open-person-tasks' || name === 'open-shared-tasks') {
    if (name === 'open-person-tasks' && !person(id)) return;
    S.taskPerson = name === 'open-person-tasks' ? id : 'all'; S.taskMode = 'today'; S.taskStatus = 'all';
    location.hash = 'chores'; return;
  }
  if (name === 'task-mode') { S.taskMode = element.dataset.mode; render(true); return; }
  if (name === 'task-status') { S.recentTasks.clear(); S.taskStatus = id; render(true); return; }
  if (name === 'unlock-frame') return workbench.unlock();
  if (name === 'settings-section') { S.settingsSection = id; render(true); return; }
  if (name === 'review-tasks') { S.taskMode = 'today'; S.taskStatus = 'waiting'; S.taskPerson = 'all'; if (S.view !== 'chores') location.hash = 'chores'; else render(true); return; }
  if (name === 'task-details') {
    const chore=scheduledChores().find(item=>item.id===id); if(!chore)return;
    openDialog(chore.title,taskDetailContents(chore),async()=>{}); dialog.dataset.taskId=chore.id; return;
  }
  if (name === 'event-details') {
    const event = S.calendar?.events.find(item=>item.id===id&&item.calendarId===element.dataset.calendar); if (!event) return;
    openDialog(event.title || 'Calendar event',`<p class="supporting">${h(dateLabel(element.dataset.date || S.selectedDate))}</p>${eventCard(event,false,element.dataset.date)}<p class="supporting">Times follow ${h(zone())}. Edit this event in Apple Calendar.</p>`,async()=>{});
    dialog.querySelector('.event-open')?.remove(); return;
  }
  if (name === 'refresh') return refresh();
  if (name === 'show-account-entry') { S.entryPair = false; render(true); return; }
  if (name === 'auth-mode') { const email = app.querySelector('[name="email"]'); if (email) S.verificationEmail = email.value.trim(); S.authMode = element.dataset.mode; S.error = ''; S.message = ''; return render(true); }
  if (name === 'verification-method') { const email = app.querySelector('[name="email"]'); if (email) S.verificationEmail = email.value.trim(); S.verificationMethod = element.dataset.method; render(true); return; }
  if (name === 'resend-verification') {
    const form = element.closest('form');
    const email = form.querySelector('[name="email"]');
    if (!email.reportValidity()) return;
    const errorBox = form.querySelector('[data-form-error]');
    element.disabled = true;
    try {
      const auth = await authClient();
      const result = await auth.resendVerification({ email: email.value.trim() });
      if (result.error) throw new Error(result.error.message || 'Could not resend confirmation.');
      errorBox.hidden = true;
      toast('Confirmation requested. Check your email; delivery can take a moment.');
    } catch (error) { errorBox.textContent = errorMessage(error); errorBox.hidden = false; }
    finally { if (element.isConnected) element.disabled = false; }
    return;
  }
  if (name === 'add-person') return editPerson();
  if (name === 'edit-person') return editPerson(person(id));
  if (name === 'add-chore') return workbench.editRoutine(undefined, person(element.dataset.personId || S.taskPerson)?.id || '', { schoolDayFilter: ['school_day', 'non_school_day'].includes(element.dataset.schoolFilter) ? element.dataset.schoolFilter : 'any', taskSection: ['before_school', 'after_school'].includes(element.dataset.taskSection) ? element.dataset.taskSection : 'tasks' });
  if (name === 'edit-chore') { if (dialog.open) dialog.close(); return workbench.editRoutine(routines().find(chore => chore.id === id)); }
  if (name === 'complete-chore' || name === 'retry-completion') {
    const chore = scheduledChores().find(item => item.id === id);
    if (!chore) return;
    const key = `${id}:${S.snapshot.date}`;
    const intent = name === 'complete-chore' ? activation || taskIntent(element) : null;
    // Never turn a visibly requested Complete into Reopen (or vice versa), or
    // borrow a newer version after a background read while the user is pressing.
    if (intent && (intent.epoch !== generation || intent.id !== id || intent.date !== S.snapshot.date || intent.date !== today()
      || intent.kind !== (chore.status ? 'occurrence' : 'routine')
      || intent.version !== (chore.status ? chore.version : chore.completion?.version || 0))) {
      sound('error'); toast('This task changed. Check its latest status before changing it.'); render(); refreshTaskDetails(); return;
    }
    const desired = intent ? intent.completed : (S.conflicts.has(key) ? S.conflicts.get(key) : S.attempts.get(key)?.completed);
    return saveCompletion(chore, desired);
  }
  if (name === 'delete-person') {
    const profile = person(id);
    return confirmAction('Delete this profile?', `${profile.name}'s tasks will become unassigned. This does not delete their sign-in account.`, 'Delete profile', async () => { await request(`/api/people/${idPath(id)}?expectedVersion=${profile.version}`, { method: 'DELETE' }); toast('Profile deleted. Its tasks are now unassigned.'); try { await loadHousehold(); } catch (error) { dataFailure(error); } });
  }
  if (name === 'delete-chore') {
    const chore = routines().find(item => item.id === id);
    return confirmAction('Delete this recurring task?', `“${chore.title}” will stop appearing. Past completions are retained.`, 'Delete task', async () => { await request(`/api/chores/${idPath(id)}?expectedVersion=${chore.version}`, { method: 'DELETE' }); toast('Recurring task deleted.'); try { await loadHousehold(); } catch (error) { dataFailure(error); } });
  }
  if (name === 'create-invite') { element.disabled = true; try { S.generatedInvite = await request('/api/invites', { method: 'POST', body: {} }); render(true); } finally { if (element.isConnected) element.disabled = false; } return; }
  if (name === 'copy-invite') {
    const input = document.querySelector('[data-share-value]');
    try { await navigator.clipboard.writeText(input.value); toast('Invitation copied. Share it privately.'); } catch { input.select(); toast('Select and copy the invitation link.'); }
    return;
  }
  if (name === 'revoke-device') return confirmAction('Disconnect this frame?', `${element.dataset.label} will lose access immediately. You can pair it again with a new code.`, 'Revoke frame access', async () => { await request(`/api/devices/${idPath(id)}`, { method: 'DELETE' }); await loadSetup(); });
  if (name === 'remove-member') return confirmAction('Remove this family member?', `${element.dataset.label} will lose access to this household. Their profile and task assignments are kept.`, 'Remove access', async () => { await request(`/api/members/${idPath(id)}`, { method: 'DELETE' }); await loadSetup(); });
  if (name === 'disconnect-calendar') return confirmAction('Disconnect Apple Calendar?', 'Your saved Apple connection and cached calendar events will be removed from this dashboard. Events in Apple Calendar are not changed.', 'Disconnect calendar', async () => { await request('/api/calendar/connection', { method: 'DELETE' }); invalidateCalendar(); S.connection = null; await loadSetup(); await loadCalendar(); });
  if (name === 'unpair-local') return confirmAction('Remove this frame connection?', 'This display will stop showing your family data. An administrator can pair it again with a new code.', 'Remove connection', async () => { await request('/api/frame-session', { method: 'DELETE', authenticated: false }); setFrameMode(false); S.session = null; S.snapshot = null; S.calendar = null; S.frameCalendar = null; await boot(); });
  if (name === 'sign-out') {
    generation++;
    workbench.reset();
    internet.reset();
    const auth = await authClient();
    const result = await auth.signOut();
    if (result.error) throw new Error(result.error.message || 'Could not sign out. Try again.');
    S.session = null; S.snapshot = null; S.calendar = null; S.frameCalendar = null; S.connection = null; S.devices = []; S.members = []; S.generatedInvite = null; S.pairing = null; S.verificationEmail = ''; S.authMode = 'sign-in'; S.error = ''; S.message = ''; S.pending.clear(); S.conflicts.clear(); S.failures.clear(); S.attempts.clear();
    render(true); return;
  }
  if (name === 'refresh-calendar') return loadCalendar(true);
  if (name === 'calendar-mode') S.calendarMode = element.dataset.mode;
  if (name === 'calendar-today') S.selectedDate = today();
  if (name === 'select-date') S.selectedDate = element.dataset.date;
  if (name === 'previous-date' || name === 'next-date') {
    const direction = name === 'next-date' ? 1 : -1;
    if (S.calendarMode === 'month') { const value = new Date(`${S.selectedDate.slice(0, 7)}-01T12:00:00Z`); value.setUTCMonth(value.getUTCMonth() + direction); S.selectedDate = value.toISOString().slice(0, 10); }
    else S.selectedDate = addDays(S.selectedDate, direction * (S.calendarMode === 'week' ? 7 : 1));
  }
  render(true); await loadCalendar();
}

app.addEventListener('input', event => { if (event.target.matches('[data-routine-search]')) { S.routineQuery = event.target.value; render(true); } });
app.addEventListener('change', event => { if (event.target.matches('[data-routine-schedule]')) { S.routineSchedule = event.target.value; render(true); } });
app.addEventListener('submit', event => { const run = forms[event.target.dataset.form]; if (run) submitForm(event, run); });
document.addEventListener('click', event => {
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return;
  let activation;
  if (element.dataset.action === 'complete-chore') {
    const press = taskPointerIntents.get(event.pointerId);
    taskPointerIntents.delete(event.pointerId);
    if (press && press.element !== element) return;
    activation = press?.intent || taskKeyIntents.get(element) || taskIntent(element);
    taskKeyIntents.delete(element);
  }
  const soundVersion = soundFeedbackVersion;
  action(element.dataset.action, element, activation).then(() => {
    if (soundVersion === soundFeedbackVersion && !['complete-chore','retry-completion','preview-frame-sound','toggle-frame-sounds'].includes(element.dataset.action)) sounds.play('tap');
  }).catch(error => { sound('error'); toast(errorMessage(error)); });
});
dialog.addEventListener('close', () => { if (dialog.open) return; dialog.innerHTML = ''; if (pendingRender) render(); });
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !edited()) render(); }, 150));
document.addEventListener('pointerdown', event => {
  if (!app.contains(event.target) && !dialog.contains(event.target)) return;
  activePointers.add(event.pointerId); pointerActive = true;
  const element = event.target.closest('[data-action="complete-chore"]');
  if (element) taskPointerIntents.set(event.pointerId, { element, intent:taskIntent(element) });
}, { passive: true });
for (const name of ['pointerup', 'pointercancel']) document.addEventListener(name, event => {
  activePointers.delete(event.pointerId); pointerActive = activePointers.size > 0;
  const press = taskPointerIntents.get(event.pointerId);
  if (name === 'pointercancel') taskPointerIntents.delete(event.pointerId);
  setTimeout(() => {
    if (taskPointerIntents.get(event.pointerId) === press) taskPointerIntents.delete(event.pointerId);
    if (pendingRender && !edited()) render(); if (pendingTaskDetails) refreshTaskDetails();
  }, 100);
}, { passive: true });
document.addEventListener('keydown', event => {
  const element = event.target.closest('[data-action="complete-chore"]');
  if (!element || !['Enter',' '].includes(event.key)) return;
  if (event.repeat) { event.preventDefault(); return; }
  taskKeyIntents.set(element, taskIntent(element));
});
document.addEventListener('keyup', event => {
  if (!['Enter',' '].includes(event.key)) return;
  const presses = [...taskKeyIntents];
  setTimeout(() => {
    for (const [element,intent] of presses) if (taskKeyIntents.get(element) === intent) taskKeyIntents.delete(element);
    if (pendingRender && !edited()) render(); if (pendingTaskDetails) refreshTaskDetails();
  }, 100);
});
window.addEventListener('blur', () => {
  activePointers.clear(); taskPointerIntents.clear(); taskKeyIntents.clear(); pointerActive = false;
  if (pendingRender && !edited()) render(); if (pendingTaskDetails) refreshTaskDetails();
});
window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1);
  if (!views.includes(next)) return;
  if (dialog.open) {
    if (!dialog.dispatchEvent(new Event('request-close', { cancelable: true }))) { history.replaceState(null,'',`${location.pathname}${location.search}#${S.view}`); navigationSound = false; return; }
    dialog.close();
  }
  if (navigationSound && S.view !== next) sounds.play('navigate');
  navigationSound = false;
  S.recentTasks.clear();
  S.view = next;
  render(true);
  if (S.session?.household) { if (next === 'setup') loadSetup(); else if (next === 'activity') workbench.loadActivity(); else if (next === 'devices') internet.load(); else loadCalendar(); }
});
window.addEventListener('online', () => { liveUpdates.tick(true);refresh(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { sounds.stop(); sounds.resetTimers(); } tickFrameEvents(); if (!document.hidden && S.session?.household) { liveUpdates.tick(true);refresh(); } });
setInterval(() => {
  ambient.tick();
  frameIdle.tick();
  paintClock();
  internet.tick();
  liveUpdates.tick();
  tickFrameEvents();
  if (frame() && workbench.accessExpired()) { workbench.reset(); boot(); return; }
  if (S.session?.household && S.snapshot && S.snapshot.date !== today() && !pollBusy) { pollBusy = true; refresh().finally(() => { pollBusy = false; }); }
}, 1000);
setInterval(async () => {
  if (document.hidden || !S.session?.household || pollBusy || dialog.open) return;
  pollBusy = true;
  try { await Promise.allSettled([loadHousehold().catch(dataFailure),loadCalendar(), internet.loaded() || Array.isArray(S.snapshot?.occurrences) ? internet.load() : Promise.resolve()]); if (S.view === 'activity') await workbench.loadActivity(); } catch (error) { dataFailure(error); }
  finally { pollBusy = false; }
}, 20000);
boot();

// Unlock Web Audio only from a real gesture; startup, polling and synthetic events stay silent.
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, event => { if (event.isTrusted) sounds.unlock(); }, {capture:true});
document.addEventListener('click', event => {
  const target = event.target.closest('button,a,summary,input');
  if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
  if (target.matches('a[href^="#"]')) navigationSound = target.hash !== location.hash;
  if (target.matches('[data-close-dialog],[data-dismiss-event]')) sounds.play('close');
  if (target.matches('summary')) sounds.play(target.parentElement.open ? 'close' : 'open');
}, {capture:true});
document.addEventListener('change', event => {
  if (event.target.matches('input[type="checkbox"],select')) sounds.play(event.target.type === 'checkbox' && !event.target.checked ? 'toggleOff' : 'toggleOn');
});
dialog.addEventListener('input', event => {
  if (!event.target.matches('[data-sound-volume]')) return;
  const value = Number(event.target.value); sounds.update({volume:value / 100});
  dialog.querySelector('[data-sound-volume-label]').textContent = `${value}%`;
});
