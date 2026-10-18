export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function color(value) {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#356653';
}

const formatters = new Map();
export function dateFormatter(options) {
  const key = JSON.stringify(options);
  if (!formatters.has(key)) {
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value);
    formatters.set(key, new Intl.DateTimeFormat('en-US', options));
  }
  return formatters.get(key);
}

export function dateInZone(date = new Date(), timezone = 'America/Denver') {
  const parts = dateFormatter({ timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDays(date, count) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

export function dateLabel(date, options = {}) {
  return dateFormatter({ weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`));
}

export function weekday(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function calendarRange(date, mode) {
  if (mode === 'month') {
    const first = `${date.slice(0, 7)}-01`;
    const from = addDays(first, -((weekday(first) + 6) % 7));
    return { from, to: addDays(from, 42) };
  }
  const from = mode === 'week' ? addDays(date, -((weekday(date) + 6) % 7)) : date;
  return { from, to: addDays(from, mode === 'week' ? 7 : 1) };
}

const eventIndexes = new WeakMap();
export function calendarEventsByDay(events, timezone, from, to) {
  let indexes = eventIndexes.get(events);
  if (!indexes) { indexes = new Map(); eventIndexes.set(events, indexes); }
  let index = indexes.get(timezone);
  if (!index) {
    if (indexes.size >= 4) indexes.delete(indexes.keys().next().value);
    const prepared = events.map(event => {
      if (event.allDay) return { event, start: event.startDate, end: event.endDateExclusive };
      const start = new Date(event.startAt).getTime();
      const end = new Date(event.endAt).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return { event, start: dateInZone(new Date(start), timezone),
        // Midnight endings exclude the following day. Zero-duration events still occupy their start day.
        end: addDays(dateInZone(new Date(Math.max(start, end - 1)), timezone), 1) };
    }).filter(Boolean).sort((a, b) => Number(b.event.allDay) - Number(a.event.allDay)
      || String(a.event.startAt || a.event.startDate).localeCompare(String(b.event.startAt || b.event.startDate)));
    index = { prepared, ranges: new Map() };
    indexes.set(timezone, index);
  }
  const key = `${from}:${to}`;
  if (!index.ranges.has(key)) {
    if (index.ranges.size >= 4) index.ranges.delete(index.ranges.keys().next().value);
    const grouped = new Map();
    // Only materialize the displayed range, even for a years-long all-day event.
    for (const { event, start, end } of index.prepared) {
      for (let date = start > from ? start : from; date < end && date < to; date = addDays(date, 1)) {
        if (!grouped.has(date)) grouped.set(date, []);
        grouped.get(date).push(event);
      }
    }
    index.ranges.set(key, grouped);
  }
  return index.ranges.get(key);
}

export function eventsOn(events, date, timezone) {
  return calendarEventsByDay(events, timezone, date, addDays(date, 1)).get(date) || [];
}

export function timeLabel(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '')) return '';
  return dateFormatter({ timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(new Date(`2000-01-01T${value}:00Z`));
}

export function choreUrgency(chore, date, timezone, now = new Date()) {
  if (chore.completion?.date === date && chore.completion.completed) return 'done';
  if (!chore.dueTime) return 'later';
  const localDate = dateInZone(now, timezone);
  if (date < localDate) return 'overdue';
  if (date > localDate) return 'later';
  const parts = dateFormatter({ timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const minute = Number(values.hour) * 60 + Number(values.minute) + Number(values.second) / 60;
  const [hours, minutes] = chore.dueTime.split(':').map(Number);
  const remaining = hours * 60 + minutes - minute;
  return remaining < 0 ? 'overdue' : remaining <= (chore.reminderMinutes ?? 15) ? 'soon' : 'later';
}

export function orderChores(chores, date, timezone, now = new Date()) {
  const priority = { overdue: 0, soon: 1, later: 2, done: 3 };
  return chores.map((chore, index) => ({ chore, index, urgency: choreUrgency(chore, date, timezone, now) }))
    .sort((a, b) => priority[a.urgency] - priority[b.urgency]
      || String(a.chore.dueTime || '99:99').localeCompare(String(b.chore.dueTime || '99:99')) || a.index - b.index)
    .map(item => item.chore);
}

export function calendarDayIsKnown(calendar, date) {
  const coverage = calendar?.coverage;
  if (calendar?.status !== 'ready' || !coverage?.complete || coverage.truncated) return false;
  const from = coverage.startDate || (coverage.start || '').slice(0, 10);
  const to = coverage.endDateExclusive || (coverage.end || '').slice(0, 10);
  return !!from && !!to && from <= date && date < to;
}

function version(value) {
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

export function completionBody(chore, date, completed, mutationId) {
  if (typeof completed !== 'boolean' || !mutationId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid completion request.');
  const expectedVersion = chore.completion?.date === date ? version(chore.completion.version) : 0;
  if (expectedVersion < 0) throw new Error('Refresh this chore before saving.');
  return { completed, expectedVersion, mutationId };
}

// A slow write or polling response must never roll back a newer completion.
// Dates are part of the identity: yesterday's response cannot change today's row.
export function mergeCompletion(chores, incoming, date) {
  if (!incoming || incoming.date !== date || version(incoming.version) < 0) return chores;
  return chores.map(chore => {
    if (chore.id !== incoming.choreId) return chore;
    const current = chore.completion;
    if (current?.date === date && version(current.version) > incoming.version) return chore;
    return { ...chore, completion: { date, completed: incoming.completed === true, version: incoming.version, updatedAt: incoming.updatedAt || null } };
  });
}

export function reconcileHousehold(current, incoming) {
  if (!current || current.date !== incoming.date) return incoming;
  let chores = incoming.chores;
  for (const chore of current.chores || []) {
    if (chore.completion?.date !== incoming.date) continue;
    chores = mergeCompletion(chores, { choreId: chore.id, ...chore.completion }, incoming.date);
  }
  return { ...incoming, chores };
}

export function mutationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
