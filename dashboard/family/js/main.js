import { request, setFrameMode } from './api.js';
import { authClient, clearAuthCache } from './auth.js';
import { escapeHtml as h, color, dateInZone, dateFormatter, addDays, dateLabel, weekday, calendarRange, calendarEventsByDay, calendarDayIsKnown, timeLabel, choreUrgency, orderChores, completionBody, mergeCompletion, reconcileHousehold, mutationId } from './model.js';
import { createRenderer } from './render.js';
import { scheduledItems, mergeOccurrence, occurrenceDetails } from './occurrences.js';
import { createWorkbench } from './workbench.js';

const app = document.querySelector('#family-app');
const dialog = document.querySelector('#family-dialog');
const notice = document.querySelector('#family-notice');
const paintApp = createRenderer(app);
const noEvents = [];
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const views = ['today', 'calendar', 'chores', 'activity', 'setup'];
const icons = {
  today: '<path d="M3 10 12 3l9 7M5 9v12h14V9M9 21v-8h6v8"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  chores: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m7 12 3 3 7-7"/>',
  setup: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  activity: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/>',
};
const S = {
  booting: true, session: null, snapshot: null, calendar: null, connection: null, devices: [], members: [],
  view: views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today',
  calendarMode: 'week', selectedDate: dateInZone(), authMode: 'sign-in',
  verificationEmail: '', verificationMethod: 'code',
  entryPair: new URLSearchParams(location.search).get('display') === 'frame',
  inviteToken: '', generatedInvite: null, pairing: null, message: '', error: '', loading: false,
  pending: new Map(), conflicts: new Map(), failures: new Map(), attempts: new Map(), calendarBusy: false, calendarShowingBusy: false, setupBusy: false,
};
let generation = 0;
let noticeTimer;
let pendingRender = false;
let pollBusy = false;
let queuedCalendar = null;
let calendarGeneration = 0;
let paintedView = null;
let pointerActive = false;
const workbench = createWorkbench({ snapshot: () => S.snapshot, session: () => S.session, epoch: () => generation,
  members: () => S.members, zone, today, frame, field, button, openDialog, dialog, toast, render,
  reload: loadHousehold, reloadSetup: loadSetup, reboot: boot });

if (location.hash.startsWith('#invite=')) {
  try { S.inviteToken = decodeURIComponent(location.hash.slice(8)); } catch { /* Invalid token stays blank. */ }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  S.view = 'setup';
}

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
function edited() { return pointerActive || dialog.open || !!document.activeElement?.closest('form') || !!document.querySelector('form[data-submitting]'); }
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
function noticeBanner() { return S.error ? `<div class="banner banner-error" data-key="data-error" role="alert"><span>${h(S.error)}</span>${button('Retry', 'refresh', 'text-button')}</div>` : ''; }
function updateStamp(value) {
  if (!value) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 1 ? 'Updated just now' : `Updated ${minutes} min ago`;
}

function shell(content) {
  const labels = { today: 'Today', calendar: 'Calendar', chores: 'Chores', activity: 'Activity', setup: 'Setup' };
  return `<div class="family-shell" data-key="family-shell">
    <aside class="sidebar"><a class="brand" href="#today" aria-label="${h(title())} home"><span class="brand-mark">f<span>f</span></span><span class="brand-name">${h(title())}<small>A little more together.</small></span></a>
      <nav aria-label="Main navigation">${views.map(view => `<a class="nav-item ${S.view === view ? 'active' : ''}" data-key="nav-${view}" href="#${view}" ${S.view === view ? 'aria-current="page"' : ''}>${icon(view)}<span>${labels[view]}</span></a>`).join('')}</nav>
      <div class="sidebar-bottom"><span class="connection-dot ${S.error ? 'warning' : ''}"></span><span>${frame() ? 'Paired family frame' : 'Your family, connected'}</span></div>
    </aside>
    <main id="main-content" class="main-content" tabindex="-1"><header class="page-heading" data-key="page-heading"><div><p class="eyebrow">${h(title())}</p><h1>${labels[S.view]}</h1></div><div class="header-clock">${clockMarkup()}</div></header>${noticeBanner()}${content}</main>
  </div>`;
}

function calendarStatus() {
  const calendar = S.calendar;
  if (!calendar) return '<div class="status-note">Checking your calendar connection…</div>';
  if (calendar.status === 'not_configured') return `<div class="status-note">Your Apple Calendar is not connected.${admin() ? ' Connect it in Setup.' : ' Ask your family administrator to connect it.'}</div>`;
  if (calendar.status === 'loading') return '<div class="status-note">Your calendar is syncing. Events will appear after a successful sync.</div>';
  if (calendar.status === 'stale') {
    const updating = ['scheduled', 'syncing'].includes(calendar.sync?.state);
    const heading = updating ? 'Calendar update in progress.' : calendar.sync?.state === 'retrying' ? 'Calendar update delayed.' : 'Calendar may be out of date.';
    const detail = updating ? 'Showing saved events while the background sync runs.' : calendar.error?.message || 'Showing the last synced events. A background update will check for changes.';
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

function eventCard(event, compact = false) {
  const metadata = eventMetadata(event);
  const eventColor = color(metadata?.color || '#00748c');
  let time = 'All day';
  if (!event.allDay) {
    const formatter = dateFormatter({ timeZone: zone(), hour: 'numeric', minute: '2-digit' });
    time = `${formatter.format(new Date(event.startAt))} – ${formatter.format(new Date(event.endAt))}`;
  }
  return `<article class="event-card ${compact ? 'compact' : ''}" data-key="event-${h(event.calendarId)}-${h(event.id)}" style="--event:${eventColor}"><span class="event-time">${h(time)}</span><div><h3>${h(event.title || 'Untitled event')}</h3>${event.location ? `<p>${h(event.location)}</p>` : ''}${metadata?.name && !compact ? `<span class="event-calendar">${h(metadata.name)}</span>` : ''}</div></article>`;
}

function eventList(date, limit = Infinity) {
  const list = eventDays().get(date) || noEvents;
  if (list.length) return list.slice(0, limit).map(event => eventCard(event, limit !== Infinity)).join('') + (list.length > limit ? `<a href="#calendar" class="more-link">See ${list.length - limit} more</a>` : '');
  return `<p class="quiet-empty">${calendarDayIsKnown(S.calendar, date) ? 'No events on this day.' : 'Events will appear when this day has synced.'}</p>`;
}

function scheduledChores() { return scheduledItems(S.snapshot, zone()) || orderChores((S.snapshot?.chores || []).filter(chore => chore.weekdays.includes(weekday(S.snapshot.date))), S.snapshot?.date || today(), zone()); }
function done(chore) { return chore.status ? chore.status === 'completed' : chore.completion?.date === S.snapshot?.date && chore.completion.completed === true; }
function choreRow(chore, showPerson = true) {
  const key = `${chore.id}:${S.snapshot.date}`;
  const pending = S.pending.has(key);
  const conflict = S.conflicts.has(key);
  const failure = S.failures.get(key);
  const urgency = choreUrgency(chore, S.snapshot.date, zone());
  const deadline = chore.dueTime ? `${urgency === 'overdue' ? 'Overdue · ' : urgency === 'soon' ? 'Due soon · ' : ''}Due ${timeLabel(chore.dueTime)}` : '';
  return `<div class="chore-row ${done(chore) ? 'is-done' : ''} ${pending ? 'is-pending' : ''} is-${urgency}" data-key="chore-${h(key)}">
    <button type="button" class="chore-toggle" data-action="complete-chore" data-id="${h(chore.id)}" aria-pressed="${chore.status === 'submitted' || done(chore)}" aria-label="${chore.status === 'submitted' ? 'Withdraw submission for' : done(chore) ? 'Reopen' : chore.requiresApproval && !choreManager() ? 'Submit for approval:' : 'Complete'} ${h(chore.title)}${deadline ? `. ${h(deadline)}` : ''}" ${pending || chore.status === 'skipped' ? 'aria-disabled="true"' : ''} ${pending ? 'aria-busy="true"' : ''}><span class="check-box" aria-hidden="true">${done(chore) ? '✓' : chore.status === 'submitted' ? '…' : chore.status === 'skipped' ? '–' : ''}</span><span><strong>${h(chore.title)}</strong>${showPerson ? `<small>${h(profileLabel(chore.personId))}</small>` : ''}${deadline ? `<small class="chore-deadline">${h(deadline)}</small>` : ''}${pending ? '<small class="save-status">Saving…</small>' : ''}</span></button>
    ${choreManager() ? button('Edit routine', 'edit-chore', 'text-button', `data-id="${h(chore.choreId || chore.id)}" aria-label="Edit ${h(chore.title)}"`) : ''}
    ${occurrenceDetails(chore, choreManager(), pending)}
    ${conflict ? `<div class="write-feedback" role="alert">Changed on another device. The latest state is shown. ${button('Retry my change', 'retry-completion', 'text-button', `data-id="${h(chore.id)}"`)}</div>` : failure ? `<div class="write-feedback" role="alert">${h(failure)} ${button('Retry', 'retry-completion', 'text-button', `data-id="${h(chore.id)}"`)}</div>` : ''}
  </div>`;
}

function todayView() {
  const chores = scheduledChores();
  const completed = chores.filter(done).length;
  return `<section class="welcome-strip" data-key="today-summary"><div><p class="eyebrow">${h(dateLabel(today(), { weekday: 'long', month: 'long', day: 'numeric' }))}</p><h2>Today, together.</h2><p class="welcome-summary">${chores.length ? `${chores.length - completed} ${chores.length - completed === 1 ? 'chore' : 'chores'} remaining · ${completed} complete` : 'Your family’s day, in one place.'}</p></div><div class="family-portraits">${people().slice(0, 6).map(profile => `<span title="${h(profile.name)}" data-key="portrait-${h(profile.id)}">${avatar(profile)}</span>`).join('')}</div></section>
    <div class="today-grid" data-key="today-grid"><section class="panel agenda-panel"><div class="section-heading"><div><p class="eyebrow">The day ahead</p><h2>On your calendar</h2></div><a href="#calendar" class="text-button">View calendar <span aria-hidden="true">↗</span></a></div>${calendarStatus()}${calendarLegend()}<div class="event-list">${eventList(today(), 4)}</div></section>
    <section class="panel chores-panel"><div class="section-heading"><div><p class="eyebrow">A shared little effort</p><h2>Today's chores</h2></div><span class="count-pill">${completed}<span> / ${chores.length}</span></span></div>${S.snapshot ? (chores.length ? `<div class="progress-track" role="progressbar" aria-label="Today's chores complete" aria-valuenow="${completed}" aria-valuemin="0" aria-valuemax="${chores.length}"><i style="width:${Math.round(completed / chores.length * 100)}%"></i></div><div class="chore-list">${chores.slice(0, 6).map(chore => choreRow(chore)).join('')}</div>${chores.length > 6 ? '<a href="#chores" class="more-link">View all chores</a>' : ''}` : empty('A fresh start', 'No chores are scheduled for today.', admin() ? button('Add a chore', 'add-chore', 'button button-small') : '')) : '<p class="quiet-empty">Loading shared chores…</p>'}</section></div>`;
}

function calendarView() {
  const range = calendarRange(S.selectedDate, S.calendarMode);
  const dayCount = S.calendarMode === 'month' ? 42 : S.calendarMode === 'week' ? 7 : 1;
  const dates = Array.from({ length: dayCount }, (_, index) => addDays(range.from, index));
  const heading = S.calendarMode === 'month' ? dateLabel(`${S.selectedDate.slice(0, 7)}-01`, { weekday: undefined, month: 'long', day: undefined, year: 'numeric' }) : S.calendarMode === 'week' ? `${dateLabel(range.from, { weekday: undefined, month: 'short', day: 'numeric' })} – ${dateLabel(addDays(range.to, -1), { weekday: undefined, month: 'short', day: 'numeric' })}` : dateLabel(S.selectedDate);
  return `<section class="panel calendar-panel" data-key="calendar-panel"><div class="calendar-toolbar"><div class="date-navigation">${button('‹', 'previous-date', 'icon-button', 'aria-label="Previous period"')}<h2>${h(heading)}</h2>${button('›', 'next-date', 'icon-button', 'aria-label="Next period"')}${button('Today', 'calendar-today', 'text-button')}</div><div class="segmented" role="group" aria-label="Calendar view">${['day', 'week', 'month'].map(mode => button(mode[0].toUpperCase() + mode.slice(1), 'calendar-mode', `segment ${S.calendarMode === mode ? 'selected' : ''}`, `data-mode="${mode}" aria-pressed="${S.calendarMode === mode}"`)).join('')}</div>${button(S.calendarShowingBusy ? 'Refreshing…' : 'Refresh', 'refresh-calendar', 'text-button', S.calendarShowingBusy ? 'disabled' : '')}</div>${calendarStatus()}${calendarLegend()}
    ${S.calendarMode === 'month' ? `<div class="month-grid" data-key="month-grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<div class="month-weekday" data-key="weekday-${day}">${day}</div>`).join('')}${dates.map(date => { const events = eventDays().get(date) || noEvents; return `<button type="button" class="month-day ${date === today() ? 'is-today' : ''} ${date.slice(0, 7) !== S.selectedDate.slice(0, 7) ? 'outside-month' : ''}" data-key="month-${date}" data-action="select-date" data-date="${date}" aria-label="${h(dateLabel(date))}${calendarDayIsKnown(S.calendar, date) ? `, ${events.length} events` : ', calendar not confirmed'}"><strong>${Number(date.slice(-2))}</strong><span>${events.slice(0, 2).map(event => `<span class="month-event" style="--event:${color(eventMetadata(event)?.color || '#00748c')}">${h(event.title || 'Untitled event')}</span>`).join('')}${events.length > 2 ? `<small>+${events.length - 2} more</small>` : ''}</span></button>`; }).join('')}</div>` : `<div class="agenda-days ${S.calendarMode === 'week' ? 'week-agenda' : ''}" data-key="${S.calendarMode}-agenda">${dates.map(date => `<section class="agenda-day ${date === today() ? 'is-today' : ''}" data-key="agenda-${date}"><header><span>${h(dateLabel(date, { weekday: 'short', month: undefined, day: undefined }))}</span><strong>${Number(date.slice(-2))}</strong></header><div class="event-list">${eventList(date)}</div></section>`).join('')}</div>`}
    <p class="footnote">Apple Calendar is read-only here. Add or edit events in your Calendar app.</p></section>`;
}

function choresView() {
  if (!S.snapshot) return '<section class="panel">Loading shared chores…</section>';
  const chores = scheduledChores();
  const lanes = [...people(), ...(chores.some(chore => !chore.personId) ? [{ id: null, name: 'Anyone', color: '#8c7859' }] : [])];
  return `<div class="section-heading chores-heading" data-key="chores-heading"><div><p class="eyebrow">${h(dateLabel(S.snapshot.date))}</p><h2>Everyone has a part.</h2></div>${choreManager() ? button('+ Add a chore', 'add-chore') : '<span class="soft-label">Tap a chore to complete it</span>'}</div>
    ${lanes.length ? `<div class="person-lanes" data-key="person-lanes">${lanes.map(profile => { const list = chores.filter(chore => chore.personId === profile.id || (!chore.personId && profile.id === null)); return `<section class="panel person-lane" data-key="person-${h(profile.id || 'anyone')}"><header>${avatar(profile)}<div><h2>${h(profile.name)}</h2><p>${list.length ? `${list.filter(done).length} of ${list.length} complete` : 'No chores today'}</p></div></header>${list.length ? `<div class="chore-list">${list.map(chore => choreRow(chore, false)).join('')}</div>` : `<p class="quiet-empty">No chores are scheduled for today.</p>${choreManager() ? button('Add a chore', 'add-chore', 'button button-small', `data-person-id="${h(profile.id)}" aria-label="Add a chore for ${h(profile.name)}"`) : ''}`}</section>`; }).join('')}</div>` : `<section class="panel">${empty('Nothing assigned today', admin() ? 'Add a recurring chore and choose the days it should appear.' : 'Your family administrator can add recurring chores.', admin() ? button('Add a chore', 'add-chore') : '')}</section>`}
    <div class="chore-tools">${button('Chore history', 'chore-history', 'button button-secondary')}${choreManager() ? button('Holidays & chore breaks', 'chore-breaks', 'button button-secondary') : ''}</div>
    ${choreManager() && routines().length ? `<section class="panel all-chores" data-key="all-chores"><div class="section-heading"><div><p class="eyebrow">Your routines</p><h2>All chore routines</h2></div></div><div class="definition-list">${routines().map(chore => `<div data-key="definition-${h(chore.id)}"><span><strong>${h(chore.title)}</strong><small>${h(profileLabel(chore.personId))} · ${chore.scheduleType === 'one_off' ? `Once on ${h(chore.scheduledDate)}` : chore.weekdays.length === 7 ? 'Every day' : h(chore.weekdays.map(day => days[day]).join(', '))} · ${chore.required === false ? 'Optional' : 'Required'}</small></span>${button('Edit', 'edit-chore', 'text-button', `data-id="${h(chore.id)}"`)}</div>`).join('')}</div></section>` : ''}`;
}

function profileCards() {
  return `<section class="panel setup-card"><div class="section-heading"><div><p class="eyebrow">Who's in your home</p><h2>Family profiles</h2></div>${button('+ Add', 'add-person', 'text-button')}</div><p class="supporting">Profiles organize chore assignments. Use a child invitation to link a profile to the child's own account.</p><div class="profile-list">${people().map(profile => `<div>${avatar(profile)}<strong>${h(profile.name)}</strong>${button('Edit', 'edit-person', 'text-button', `data-id="${h(profile.id)}"`)}</div>`).join('') || '<p class="quiet-empty">Add your first family member.</p>'}</div></section>`;
}

function appleSettings() {
  const connection = S.connection;
  return `<section class="panel setup-card"><div class="section-heading"><div><p class="eyebrow">Private by design</p><h2>Apple Calendar</h2></div><span class="badge">${connection === null ? 'Checking…' : connection.connected ? 'Connected' : 'Not connected'}</span></div><p class="supporting">Connect privately with your Apple Account email and an app-specific password. Your calendars are read-only on the frame.</p>
    <form data-form="calendar-connection" class="form-stack">${field('Apple Account email', 'username', '', { type: 'email', autocomplete: 'username' })}${field('App-specific password', 'appPassword', '', { type: 'password', autocomplete: 'new-password', max: 100 })}<p class="field-help">Create an app-specific password in your Apple Account settings. Your regular Apple Account password is not used.</p>${formError()}<button class="button" type="submit">${connection?.connected ? 'Update connection' : 'Connect Apple Calendar'}</button></form>
    ${connection?.connected ? `<form data-form="calendar-selection" class="form-stack calendar-selection"><h3>Calendars to show</h3>${connection.calendars.length ? connection.calendars.map(calendar => `<label class="checkbox-label"><input name="calendarIds" value="${h(calendar.id)}" type="checkbox" ${calendar.selected ? 'checked' : ''}><span class="calendar-color" style="background:${color(calendar.color)}"></span><span>${h(calendar.name)}</span></label>`).join('') : '<p class="quiet-empty">No calendars were returned by this connection.</p>'}${formError()}<button class="button button-secondary" type="submit">Save calendar selection</button></form>${button('Disconnect Apple Calendar', 'disconnect-calendar', 'text-button danger-text')}` : ''}</section>`;
}

function deviceSettings() {
  return `<section class="panel setup-card"><div class="section-heading"><div><p class="eyebrow">A place on your wall</p><h2>Pair your frame</h2></div></div><p class="supporting">Create a short-lived code here, then enter it in Setup on the frame. Paired frames can read the calendar and complete chores.</p><form data-form="create-pair" class="form-stack">${field('Frame name', 'label', 'Family frame', { max: 80 })}${formError()}<button class="button button-secondary" type="submit">Create pairing code</button></form>${S.pairing ? `<div class="share-result"><span class="eyebrow">Enter on the frame</span><strong class="pairing-code">${h(S.pairing.code)}</strong><span>Expires ${h(new Date(S.pairing.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span></div>` : ''}<div class="device-list">${S.devices.filter(device => !device.revokedAt).map(device => `<div><span><strong>${h(device.label)}</strong><small>${device.lastSeenAt ? `Last seen ${h(updateStamp(device.lastSeenAt).replace('Updated ', ''))}` : 'Not yet seen'}</small></span>${button('Revoke', 'revoke-device', 'text-button danger-text', `data-id="${h(device.id)}" data-label="${h(device.label)}"`)}</div>`).join('')}</div></section>`;
}

function inviteSettings() {
  return `<section class="panel setup-card"><div class="section-heading"><div><p class="eyebrow">Share the little things</p><h2>Invite family</h2></div></div><h3>A child's own account</h3><p class="supporting">Choose a profile and the child's own email. They create a password, confirm that exact email, then accept your private invitation. Children can view the shared calendar and complete only their own chores.</p><form data-form="create-child-invite" class="form-stack"><label class="field"><span>Child profile</span><select name="personId" aria-label="Child profile" required><option value="">Choose a profile</option>${people().map(profile => `<option value="${h(profile.id)}">${h(profile.name)}</option>`).join('')}</select></label>${field('Child email', 'email', '', { type: 'email', max: 254 })}${formError()}<button class="button" type="submit" ${people().length ? '' : 'disabled'}>Create child invitation</button></form><p class="supporting">For another adult, create a family-member invitation. Family members can view the shared calendar and complete family chores.</p>${button('Create an invitation', 'create-invite', 'button button-secondary')}${S.generatedInvite ? `<div class="share-result">${S.generatedInvite.role === 'child' ? `<strong>For ${h(profileLabel(S.generatedInvite.personId))}</strong><small>${h(S.generatedInvite.email)}</small>` : ''}<label class="field"><span>Invitation link · share privately</span><input readonly data-share-value value="${h(`${location.origin}/family.html#invite=${encodeURIComponent(S.generatedInvite.token)}`)}"></label>${button('Copy invitation', 'copy-invite', 'text-button')}<small>Expires ${h(new Date(S.generatedInvite.expiresAt).toLocaleString())}</small></div>` : ''}<div class="device-list">${S.members.map(member => `<div><span><strong>${h(member.name || member.email || 'Family member')}</strong><small>${h(member.role === 'admin' ? 'Administrator' : member.role === 'child' ? `Child · ${profileLabel(member.personId)}` : 'Family member')}</small></span>${member.role === 'member' ? button('Permissions', 'member-capabilities', 'text-button', `data-id="${h(member.id)}"`) : ''}${['member','child'].includes(member.role) && member.id !== S.session.user.id ? button('Remove', 'remove-member', 'text-button danger-text', `data-id="${h(member.id)}" data-label="${h(member.name || member.email || 'This person')}"`) : ''}</div>`).join('')}</div></section>`;
}

function setupView() {
  if (frame()) return `<section class="panel frame-settings"><p class="eyebrow">Connected to ${h(title())}</p><h2>Your frame is paired.</h2><p>This display can view your calendar and complete family chores. Manage people, recurring chores and your Apple connection from an administrator's phone.</p><p class="soft-label">Timezone: ${h(zone())}</p>${button('Remove this frame connection', 'unpair-local', 'button button-secondary danger-text')}</section>${workbench.unlockPanel()}`;
  const account = `<section class="panel setup-card"><p class="eyebrow">Your account</p><h2>${h(S.session?.user?.name || 'Family member')}</h2><p class="supporting">${h(S.session?.user?.email || '')} · ${admin() ? 'Administrator' : S.session?.role === 'child' ? 'Child account' : 'Family member'}</p>${button('Sign out', 'sign-out', 'button button-secondary')}</section>`;
  if (!admin()) return `<div class="setup-grid">${account}${workbench.unlockPanel()}<section class="panel setup-card"><h2>You're part of the family.</h2><p class="supporting">You can view the shared calendar and complete chores. Your administrator manages assignments, profiles and connections.</p></section></div>`;
  return `<div class="setup-grid"><section class="panel setup-card"><p class="eyebrow">The basics</p><h2>Your household</h2><form data-form="settings" class="form-stack">${field('Household name', 'title', title(), { max: 80 })}${field('Timezone', 'timezone', zone(), { max: 80, extra: 'list="timezones"' })}<datalist id="timezones">${['America/Denver', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'America/Phoenix', 'Europe/London', 'UTC'].map(value => `<option value="${value}"></option>`).join('')}</datalist><p class="field-help">Calendar times and recurring chore days use this timezone.</p>${formError()}<button class="button button-secondary" type="submit">Save household</button></form></section>${profileCards()}${appleSettings()}${deviceSettings()}${inviteSettings()}${workbench.unlockPanel()}${account}</div>`;
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
  const pairForm = `<p class="supporting">On an administrator's phone, open Setup and create a pairing code. Enter that code here to connect this display.</p><form data-form="redeem-pair" class="form-stack">${field('Six-digit pairing code', 'code', '', { max: 6, extra: 'inputmode="numeric" pattern="[0-9]{6}"' })}${formError()}<button class="button" type="submit">Pair this frame</button></form>`;
  const content = S.entryPair ? `<div class="auth-card"><p class="eyebrow">A place on your wall</p><h2>Bring your<br>family home.</h2>${pairForm}<p class="form-switch">Using your phone? ${button('Sign in to your account', 'show-account-entry', 'text-button')}</p></div>` : `<div class="auth-card">${authForm}</div><details class="pair-entry"><summary>Setting up your photo frame?</summary>${pairForm}</details>`;
  return `<main id="main-content" class="entry-layout"><section class="entry-story"><a class="entry-brand" href="/family.html">Family Frame<span>A little more together.</span></a><div class="entry-clock">${clockMarkup()}</div><div class="entry-art" aria-hidden="true"><span></span><span></span><span></span></div><p class="entry-tagline">The everyday,<br><em>shared.</em></p><p class="entry-footnote">Your calendar stays private.<br>Your family stays connected.</p></section><section class="entry-content">${S.error ? `<div class="banner banner-error" role="alert">${h(S.error)}</div>` : ''}${S.message ? `<div class="banner" role="status">${h(S.message)}</div>` : ''}${content}</section></main>`;
}

function joinView() {
  return `<main id="main-content" class="membership-layout"><header class="simple-brand">Family Frame</header><section class="membership-intro"><p class="eyebrow">Signed in as ${h(S.session.user?.email || S.session.user?.name)}</p><h1>A place for<br><em>your family.</em></h1><p>Your account is ready. Join your family's household or claim this dashboard with its private setup code.</p>${button('Sign out', 'sign-out', 'text-button')}</section><div class="membership-grid"><section class="panel"><h2>Join your family</h2><p class="supporting">Paste the invitation token or link shared by your administrator.</p><form data-form="join" class="form-stack">${field('Invitation', 'token', S.inviteToken, { max: 2000 })}${formError()}<button class="button" type="submit">Join household</button></form></section><section class="panel"><h2>Set up your household</h2><p class="supporting">The private setup code makes you this dashboard's first administrator.</p><form data-form="claim" class="form-stack">${field('Household name', 'title', 'Our family', { max: 80 })}${field('Private setup code', 'bootstrapCode', '', { type: 'password', autocomplete: 'off', max: 200 })}${formError()}<button class="button button-secondary" type="submit">Create household</button></form></section></div></main>`;
}

function render(force = false) {
  if (!force && edited()) { pendingRender = true; return; }
  pendingRender = false;
  const busy = S.booting ? 'true' : 'false';
  if (app.getAttribute('aria-busy') !== busy) app.setAttribute('aria-busy', busy);
  document.documentElement.classList.toggle('frame-display', frame() || S.entryPair);
  let markup;
  if (S.booting) markup = '<main id="main-content" class="initial-state"><p class="eyebrow">Family Frame</p><h1>Opening your dashboard…</h1><p>Checking your family connection.</p></main>';
  else if (!S.session) markup = entryView();
  else if (!S.session.household) markup = joinView();
  else markup = shell(({ today: todayView, calendar: calendarView, chores: choresView, activity: workbench.activityView, setup: setupView })[S.view]());
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
  if (epoch !== generation) return;
  let snapshot = reconcileHousehold(S.snapshot, data);
  for (const item of S.snapshot?.occurrences || []) snapshot = mergeOccurrence(snapshot, item);
  if (JSON.stringify(snapshot) !== JSON.stringify(S.snapshot)) S.snapshot = snapshot;
  if (S.session) { S.session.household = data.household; S.session.role = data.role; }
  S.error = '';
  render();
}

function invalidateCalendar() {
  calendarGeneration++;
  S.calendarBusy = false;
  S.calendarShowingBusy = false;
  queuedCalendar = null;
  S.calendar = null;
}

async function loadCalendar(explicit = false) {
  if (!S.session?.household) return;
  if (S.calendarBusy) { queuedCalendar = { explicit: explicit || queuedCalendar?.explicit }; return; }
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
  } catch (error) {
    if (!current()) return;
    if (error.status === 401 || error.status === 403) { dataFailure(error); return; }
    S.calendar = { ...S.calendar, status: S.calendar?.events?.length ? 'stale' : 'error', events: S.calendar?.events || [], error: { message: errorMessage(error) } };
  } finally {
    if (current()) {
      S.calendarBusy = false;
      S.calendarShowingBusy = false;
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
  clearAuthCache();
  S.calendarBusy = false;
  S.calendarShowingBusy = false;
  S.setupBusy = false;
  queuedCalendar = null;
  S.snapshot = null; S.calendar = null; S.connection = null; S.devices = []; S.members = [];
  workbench.reset();
  S.generatedInvite = null; S.pairing = null;
  S.pending.clear(); S.conflicts.clear(); S.failures.clear(); S.attempts.clear();
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
      await Promise.allSettled([loadCalendar(), S.view === 'setup' ? loadSetup() : S.view === 'activity' ? workbench.loadActivity() : Promise.resolve()]);
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
  try { await loadHousehold(); await loadCalendar(); if (S.view === 'setup') await loadSetup(); }
  catch (error) { dataFailure(error); }
}

function dataFailure(error) {
  if (error.code === 'invalid_unlock' && frame()) { workbench.reset(); boot(); return; }
  if (error.status === 401 || error.status === 403) {
    generation++;
    clearAuthCache();
    workbench.reset();
    S.session = null; S.snapshot = null; S.calendar = null; S.connection = null; S.devices = []; S.members = [];
    S.generatedInvite = null; S.pairing = null;
    S.pending.clear(); S.conflicts.clear(); S.failures.clear(); S.attempts.clear();
    S.message = 'Your family connection is no longer active. Sign in again or pair this frame with a new code.';
    S.error = '';
    setFrameMode(false);
    if (dialog.open) dialog.close();
    render(true);
  } else { S.error = errorMessage(error); render(); }
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
    if (occurrence) S.snapshot = mergeOccurrence(S.snapshot, result.occurrence || result);
    else if (S.snapshot?.date === date) S.snapshot.chores = mergeCompletion(S.snapshot.chores, result, date);
    const current = S.snapshot?.chores.find(item => item.id === chore.id)?.completion;
    toast(current?.version > result.version ? 'Your change was saved earlier. A newer update from another device is shown.' : (result.occurrence || result).status === 'submitted' ? 'Submitted. Waiting for parent approval.' : desired ? 'Chore completed. Saved for the family.' : 'Chore reopened. Saved for the family.');
    S.attempts.delete(key);
    if (occurrence) await loadHousehold().catch(dataFailure);
  } catch (error) {
    if (epoch !== generation) return;
    if (error.status === 401 || error.status === 403) { dataFailure(error); return; }
    if (error.status === 409 && error.details?.current) {
      if (occurrence) S.snapshot = mergeOccurrence(S.snapshot, error.details.current);
      else if (S.snapshot?.date === date) S.snapshot.chores = mergeCompletion(S.snapshot.chores, error.details.current, date);
      S.conflicts.set(key, desired);
      S.attempts.delete(key);
    } else {
      S.failures.set(key, `${errorMessage(error)} Your change has not been confirmed.`);
    }
  } finally { if (epoch === generation) { S.pending.delete(key); render(); } }
}

function openDialog(titleText, contents, onSubmit) {
  dialog.innerHTML = `<form data-dialog-form><header class="dialog-heading"><h2 id="dialog-title">${h(titleText)}</h2><button class="icon-button" type="button" data-close-dialog aria-label="Close dialog">×</button></header>${contents}${formError()}</form>`;
  dialog.querySelector('[data-close-dialog]').onclick = () => dialog.close();
  dialog.querySelector('form').onsubmit = event => submitForm(event, onSubmit);
  dialog.showModal();
  const first = dialog.querySelector('input:not([type="hidden"]),select,button');
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
  try { await run(new FormData(form), form); }
  catch (error) {
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

async function action(name, element) {
  const id = element.dataset.id;
  if (await workbench.action(name, element)) return;
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
  if (name === 'add-chore') return workbench.editRoutine(undefined, person(element.dataset.personId)?.id || '');
  if (name === 'edit-chore') return workbench.editRoutine(routines().find(chore => chore.id === id));
  if (name === 'complete-chore' || name === 'retry-completion') {
    const chore = scheduledChores().find(item => item.id === id);
    if (!chore) return;
    const key = `${id}:${S.snapshot.date}`;
    const desired = name === 'retry-completion' ? (S.conflicts.has(key) ? S.conflicts.get(key) : S.attempts.get(key)?.completed) : chore.status === 'submitted' ? false : !done(chore);
    return saveCompletion(chore, desired);
  }
  if (name === 'delete-person') {
    const profile = person(id);
    return confirmAction('Delete this profile?', `${profile.name}'s chores will become unassigned. This does not delete their sign-in account.`, 'Delete profile', async () => { await request(`/api/people/${idPath(id)}?expectedVersion=${profile.version}`, { method: 'DELETE' }); toast('Profile deleted. Its chores are now unassigned.'); try { await loadHousehold(); } catch (error) { dataFailure(error); } });
  }
  if (name === 'delete-chore') {
    const chore = routines().find(item => item.id === id);
    return confirmAction('Delete this recurring chore?', `“${chore.title}” will stop appearing. Past completions are retained.`, 'Delete chore', async () => { await request(`/api/chores/${idPath(id)}?expectedVersion=${chore.version}`, { method: 'DELETE' }); toast('Recurring chore deleted.'); try { await loadHousehold(); } catch (error) { dataFailure(error); } });
  }
  if (name === 'create-invite') { element.disabled = true; try { S.generatedInvite = await request('/api/invites', { method: 'POST', body: {} }); render(true); } finally { if (element.isConnected) element.disabled = false; } return; }
  if (name === 'copy-invite') {
    const input = document.querySelector('[data-share-value]');
    try { await navigator.clipboard.writeText(input.value); toast('Invitation copied. Share it privately.'); } catch { input.select(); toast('Select and copy the invitation link.'); }
    return;
  }
  if (name === 'revoke-device') return confirmAction('Disconnect this frame?', `${element.dataset.label} will lose access immediately. You can pair it again with a new code.`, 'Revoke frame access', async () => { await request(`/api/devices/${idPath(id)}`, { method: 'DELETE' }); await loadSetup(); });
  if (name === 'remove-member') return confirmAction('Remove this family member?', `${element.dataset.label} will lose access to this household. Their profile and chore assignments are kept.`, 'Remove access', async () => { await request(`/api/members/${idPath(id)}`, { method: 'DELETE' }); await loadSetup(); });
  if (name === 'disconnect-calendar') return confirmAction('Disconnect Apple Calendar?', 'Your saved Apple connection and cached calendar events will be removed from this dashboard. Events in Apple Calendar are not changed.', 'Disconnect calendar', async () => { await request('/api/calendar/connection', { method: 'DELETE' }); invalidateCalendar(); S.connection = null; await loadSetup(); await loadCalendar(); });
  if (name === 'unpair-local') return confirmAction('Remove this frame connection?', 'This display will stop showing your family data. An administrator can pair it again with a new code.', 'Remove connection', async () => { await request('/api/frame-session', { method: 'DELETE', authenticated: false }); setFrameMode(false); S.session = null; S.snapshot = null; S.calendar = null; await boot(); });
  if (name === 'sign-out') {
    generation++;
    workbench.reset();
    const auth = await authClient();
    const result = await auth.signOut();
    if (result.error) throw new Error(result.error.message || 'Could not sign out. Try again.');
    S.session = null; S.snapshot = null; S.calendar = null; S.connection = null; S.devices = []; S.members = []; S.generatedInvite = null; S.pairing = null; S.verificationEmail = ''; S.authMode = 'sign-in'; S.error = ''; S.message = ''; S.pending.clear(); S.conflicts.clear(); S.failures.clear(); S.attempts.clear();
    render(true); return;
  }
  if (name === 'refresh-calendar') return loadCalendar(true);
  if (name === 'calendar-mode') S.calendarMode = element.dataset.mode;
  if (name === 'calendar-today') S.selectedDate = today();
  if (name === 'select-date') { S.selectedDate = element.dataset.date; S.calendarMode = 'day'; }
  if (name === 'previous-date' || name === 'next-date') {
    const direction = name === 'next-date' ? 1 : -1;
    if (S.calendarMode === 'month') { const value = new Date(`${S.selectedDate.slice(0, 7)}-01T12:00:00Z`); value.setUTCMonth(value.getUTCMonth() + direction); S.selectedDate = value.toISOString().slice(0, 10); }
    else S.selectedDate = addDays(S.selectedDate, direction * (S.calendarMode === 'week' ? 7 : 1));
  }
  render(true); await loadCalendar();
}

app.addEventListener('submit', event => { const run = forms[event.target.dataset.form]; if (run) submitForm(event, run); });
document.addEventListener('click', event => {
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return;
  action(element.dataset.action, element).catch(error => toast(errorMessage(error)));
});
dialog.addEventListener('close', () => { if (dialog.open) return; dialog.innerHTML = ''; if (pendingRender) render(); });
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !edited()) render(); }, 150));
document.addEventListener('pointerdown', event => { if (app.contains(event.target)) pointerActive = true; }, { passive: true });
for (const name of ['pointerup', 'pointercancel']) document.addEventListener(name, () => {
  pointerActive = false;
  setTimeout(() => { if (pendingRender && !edited()) render(); }, 100);
}, { passive: true });
window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1);
  if (!views.includes(next)) return;
  if (dialog.open) dialog.close();
  S.view = next;
  render(true);
  if (S.session?.household) { if (next === 'setup') loadSetup(); else if (next === 'activity') workbench.loadActivity(); else loadCalendar(); }
});
window.addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.session?.household) refresh(); });
setInterval(() => {
  paintClock();
  if (frame() && workbench.accessExpired()) { workbench.reset(); boot(); return; }
  if (S.session?.household && S.snapshot && S.snapshot.date !== today() && !pollBusy) { pollBusy = true; refresh().finally(() => { pollBusy = false; }); }
}, 1000);
setInterval(async () => {
  if (document.hidden || !S.session?.household || pollBusy || dialog.open) return;
  pollBusy = true;
  try { await loadHousehold(); await loadCalendar(); if (S.view === 'activity') await workbench.loadActivity(); } catch (error) { dataFailure(error); }
  finally { pollBusy = false; }
}, 20000);
boot();
