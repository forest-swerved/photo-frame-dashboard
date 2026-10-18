import { choreUrgency, escapeHtml as h, mutationId } from './model.js';

export function scheduledItems(snapshot, timezone, now = new Date()) {
  if (!Array.isArray(snapshot?.occurrences)) return null;
  const ranks = { overdue: 0, soon: 1, later: 2, submitted: 3, completed: 4, skipped: 5 };
  return snapshot.occurrences.map((item, index) => ({ item, index,
    rank: ranks[item.status] ?? ranks[choreUrgency(item, snapshot.date, timezone, now)] }))
    .sort((a, b) => a.rank - b.rank || String(a.item.dueTime || '99:99').localeCompare(String(b.item.dueTime || '99:99')) || a.index - b.index)
    .map(({ item }) => item);
}

export function mergeOccurrence(snapshot, incoming) {
  if (!snapshot || !incoming || incoming.date !== snapshot.date || !Number.isInteger(incoming.version)) return snapshot;
  return { ...snapshot, occurrences: (snapshot.occurrences || []).map(item => item.id === incoming.id && item.version <= incoming.version ? incoming : item) };
}

export function routinePayload(form, routine = null) {
  const scheduleType = form.get('scheduleType');
  const lines = String(form.get('subtasks') || '').split('\n').map(value => value.trim()).filter(Boolean);
  if (lines.length > 20) throw new Error('Use at most 20 steps.');
  const used = new Set();
  const subtasks = lines.map(title => {
    const previous = routine?.subtasks?.find(step => step.title === title && !used.has(step.id));
    const id = previous?.id || mutationId(); used.add(id); return { id, title };
  });
  const weekdays = form.getAll('weekdays').map(Number);
  if (scheduleType === 'weekly' && !weekdays.length) throw new Error('Choose at least one repeat day.');
  if (scheduleType === 'one_off' && !form.get('scheduledDate')) throw new Error('Choose the one-off date.');
  return { title: String(form.get('title')).trim(), personId: form.get('personId') || null,
    scheduleType, scheduledDate: scheduleType === 'one_off' ? form.get('scheduledDate') : null,
    weekdays: weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6], required: form.has('required'), requiresApproval: form.has('requiresApproval'),
    instructions: String(form.get('instructions') || '').trim(), subtasks, dueTime: form.get('dueTime') || null,
    reminderMinutes: Number(form.get('reminderMinutes')), ...(routine ? { expectedVersion: routine.version } : {}) };
}

export function occurrenceDetails(item, manager, pending = false) {
  if (!item.status) return '';
  const labels = { pending: 'To do', submitted: 'Waiting for parent approval', completed: 'Completed', skipped: 'Excused' };
  const controls = manager ? `${item.status === 'submitted' ? `<button type="button" class="button button-small" data-action="occurrence-action" data-operation="approve" data-id="${h(item.id)}">Approve</button><button type="button" class="text-button" data-action="occurrence-action" data-operation="reject" data-id="${h(item.id)}">Return for changes</button>` : ''}${!['completed', 'submitted', 'skipped'].includes(item.status) ? `<button type="button" class="text-button" data-action="occurrence-action" data-operation="skip" data-id="${h(item.id)}">Excuse today</button><button type="button" class="text-button" data-action="occurrence-action" data-operation="reschedule" data-id="${h(item.id)}">Reschedule</button>` : ''}` : '';
  return `<div class="occurrence-info"><span class="badge status-${h(item.status)}">${h(labels[item.status] || item.status)}</span><span class="badge">${item.required ? 'Required' : 'Optional'}</span>${item.skipReason ? `<p>${h(item.skipReason)}</p>` : ''}${item.rescheduledFrom ? `<p>Moved from ${h(item.rescheduledFrom)}</p>` : ''}${item.instructions || item.subtasks?.length ? `<details data-key="details-${h(item.id)}"><summary>Instructions${item.subtasks?.length ? ` & ${item.subtasks.length} steps` : ''}</summary>${item.instructions ? `<p class="chore-instructions">${h(item.instructions)}</p>` : ''}${item.subtasks?.length ? `<ul class="subtask-list">${item.subtasks.map(step => `<li><button type="button" data-action="occurrence-step" data-id="${h(item.id)}" data-step-id="${h(step.id)}" aria-pressed="${step.completed}" ${pending || item.status !== 'pending' ? 'disabled' : ''}><span aria-hidden="true">${step.completed ? '☑' : '☐'}</span>${h(step.title)}</button></li>`).join('')}</ul>` : ''}</details>` : ''}${controls ? `<div class="occurrence-controls">${controls}</div>` : ''}</div>`;
}
