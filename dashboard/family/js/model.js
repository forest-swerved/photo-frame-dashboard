export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function color(value) {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#356653';
}

export function dateInZone(date = new Date(), timezone = 'America/Denver') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDays(date, count) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

export function dateLabel(date, options = {}) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`));
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

export function eventsOn(events, date, timezone) {
  return events.filter(event => {
    if (event.allDay) return event.startDate <= date && date < event.endDateExclusive;
    const start = dateInZone(new Date(event.startAt), timezone);
    // An event ending exactly at midnight does not occupy the next calendar day.
    const end = dateInZone(new Date(new Date(event.endAt).getTime() - 1), timezone);
    return start <= date && date <= end;
  }).sort((a, b) => Number(b.allDay) - Number(a.allDay) || String(a.startAt || a.startDate).localeCompare(String(b.startAt || b.startDate)));
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
