import { taskAppliesToSchoolDay, taskProgress } from './occurrences.js';

// Presentation only: the server remains authoritative for completion and access.
export function taskOverview(items, schoolDay) {
  const current = items.filter(item => item.status !== 'skipped' && taskAppliesToSchoolDay(item, schoolDay));
  const submitted = current.filter(item => item.status === 'submitted').length;
  const requiredSubmitted = current.filter(item => item.required !== false && item.status === 'submitted').length;
  const optional = current.filter(item => item.required === false);
  const progress = taskProgress(items, schoolDay);
  return { ...progress, submitted, todo: progress.remaining - requiredSubmitted,
    optional: optional.length, optionalDone: optional.filter(taskDone).length };
}
export function taskDone(item) { return item.status ? item.status === 'completed' : item.completion?.completed === true; }
export function taskGroups(items, schoolDay) {
  const current = items.filter(item => item.status !== 'skipped' && taskAppliesToSchoolDay(item, schoolDay));
  return {
    todo: current.filter(item => !taskDone(item) && item.status !== 'submitted')
      .sort((a, b) => Number(b.required !== false) - Number(a.required !== false)),
    submitted: current.filter(item => item.status === 'submitted'),
    completed: current.filter(taskDone),
    history: items.filter(item => item.status === 'skipped' || !taskAppliesToSchoolDay(item, schoolDay)),
  };
}
export function agendaParts(events, now = Date.now()) {
  const allDay = events.filter(event => event.allDay);
  const timed = events.filter(event => !event.allDay);
  const upcoming = timed.filter(event => Math.max(Date.parse(event.endAt) || 0, Date.parse(event.startAt) || 0) >= now);
  return { allDay, upcoming, earlier: timed.filter(event => !upcoming.includes(event)) };
}
// A routine background read should not interrupt the family dashboard. This is
// presentation only: saved events remain stale for availability and reminders.
export function quietCalendarRefresh(calendar, now = Date.now()) {
  const age = now - Date.parse(calendar?.lastSuccessfulSyncAt);
  return calendar?.status === 'stale' && ['scheduled', 'syncing'].includes(calendar.sync?.state)
    && !calendar.error && !calendar.sync?.error && calendar.coverage?.complete === true && !calendar.coverage.truncated
    && Number.isFinite(age) && age >= 0 && age < 10 * 60_000;
}
export function completionLabel(item) {
  if (item.status === 'submitted') return 'Waiting for parent approval';
  if (item.status === 'skipped') return 'Excused';
  return taskDone(item) ? item.requiresApproval ? 'Approved' : 'Done' : item.required === false ? 'Optional' : 'Required';
}
export function sameFormData(a, b) { return JSON.stringify([...a]) === JSON.stringify([...b]); }

// Drafts stay in the current form, never in browser storage.
export function protectDialogDraft(dialog) {
  const form = dialog.querySelector('form');
  if (!form || !form.querySelector('[name="title"], [name="name"], [name="instructions"], [name="macAddresses"], [name="quietStart"], [name="schoolDate"], [name="rewardMinutes"], [name="fromDate"]')) return;
  const initial = new FormData(form);
  const dirty = () => !form.hasAttribute('data-submitting') && form.dataset.reviewRequired !== 'true' && !sameFormData(initial, new FormData(form));
  function requestClose(event) {
    if (!dirty()) { if (event?.type === 'click') dialog.close(); return; }
    event?.preventDefault();
    if (form.querySelector('[data-discard-prompt]')) return;
    const prompt = document.createElement('div');
    prompt.className = 'draft-prompt'; prompt.dataset.discardPrompt = ''; prompt.setAttribute('role', 'alert');
    const message = document.createElement('p'); message.textContent = 'Discard your unsaved changes?';
    const keep = document.createElement('button'); keep.type = 'button'; keep.className = 'button button-secondary'; keep.textContent = 'Keep editing'; keep.onclick = () => { prompt.remove(); form.querySelector('input,select,textarea')?.focus(); };
    const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'button button-danger'; discard.textContent = 'Discard changes'; discard.onclick = () => dialog.close();
    prompt.append(message, keep, discard); form.prepend(prompt); keep.focus();
  }
  form.querySelectorAll('[data-close-dialog]').forEach(close => { close.onclick = requestClose; });
  dialog.addEventListener('cancel', requestClose);
  dialog.addEventListener('request-close', requestClose);
  const unload = event => { if (dialog.open && dirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);
  const cleanup = () => {
    dialog.removeEventListener('cancel', requestClose);
    dialog.removeEventListener('request-close', requestClose);
    dialog.removeEventListener('close', cleanup);
    window.removeEventListener('beforeunload', unload);
  };
  dialog.addEventListener('close', cleanup, { once: true });
  return cleanup;
}
