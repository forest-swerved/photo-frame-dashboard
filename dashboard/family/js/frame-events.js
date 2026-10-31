import { dateInZone, dateFormatter, escapeHtml as h } from './model.js';

const minute = 60_000;
const keyFor = (event, phase) => JSON.stringify([event.calendarId, event.id, event.startAt, phase]);

// Absolute instants avoid DST/browser-zone guesses. Only a current, complete
// household calendar can produce a reminder; cached/stale events stay read-only.
export function frameEventCandidates(calendar, timezone, now = Date.now()) {
  const coverage = calendar?.coverage, synced = Date.parse(calendar?.lastSuccessfulSyncAt);
  const date = dateInZone(new Date(now), timezone);
  if (calendar?.status !== 'ready' || !coverage?.complete || coverage.truncated || coverage.timeZone !== timezone
    || !(coverage.startDate <= date && coverage.endDateExclusive > date) || !Number.isFinite(synced)
    || now - synced > 15 * minute || synced - now > minute) return [];
  return (calendar.events || []).flatMap(event => {
    const start = Date.parse(event.startAt), end = Date.parse(event.endAt);
    if (event.allDay || event.status === 'cancelled' || !event.id || !event.calendarId || !Number.isFinite(start)
      || start - now > 10 * minute || now - start >= minute || Number.isFinite(end) && end <= now) return [];
    const phase = now < start ? 'soon' : 'starting';
    return [{ ...event, phase, start, key: keyFor(event, phase), expires: phase === 'soon' ? start : start + minute }];
  }).sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}

export function createFrameEventNotices(root, { onShow = () => {} } = {}) {
  let household = null, seen = new Map(), current = null, hideAt = 0, timer;
  const hide = () => { clearTimeout(timer); current = null; hideAt = 0; root.hidden = true; root.replaceChildren(); };
  const storageKey = () => `family-frame-event-notices:${household}`;
  const remember = (key, expires, now) => {
    seen.set(key, expires + 86400_000);
    seen = new Map([...seen].filter(([, until]) => until > now).slice(-200));
    // Only scoped event identifiers/expiry times are retained, never titles,
    // locations or a credential. Private-mode storage can be unavailable.
    try { localStorage.setItem(storageKey(), JSON.stringify([...seen])); } catch { /* Session-only deduplication remains. */ }
  };
  root.addEventListener('click', event => { if (event.target.closest('[data-dismiss-event]')) hide(); });
  return {
    reset() { hide(); household = null; seen = new Map(); },
    update({ session, calendar, timezone, visible = true, now = Date.now() }) {
      if (session?.authType !== 'frame' || !session.household?.id) { this.reset(); return; }
      if (household !== session.household.id) {
        hide(); household = session.household.id; seen = new Map();
        try {
          const entries = JSON.parse(localStorage.getItem(storageKey()) || '[]');
          if (Array.isArray(entries)) for (const item of entries.slice(-200)) {
            if (Array.isArray(item) && typeof item[0] === 'string' && Number.isFinite(item[1]) && item[1] > now) seen.set(item[0], item[1]);
          }
        } catch { /* No durable browser storage is required. */ }
      }
      const candidates = frameEventCandidates(calendar, timezone, now);
      if (!visible) { hide(); return; }
      if (current && (!candidates.some(item => item.key === current.key && item.title === current.title && item.location === current.location) || now >= hideAt)) hide();
      if (current) return;
      const next = candidates.find(item => !seen.has(item.key));
      if (!next) return;
      current = next; hideAt = Math.min(now + 20_000, next.expires);
      remember(next.key, next.expires, now);
      const time = dateFormatter({ timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(next.start));
      const heading = next.phase === 'starting' ? 'Starting now' : `Starts in ${Math.ceil((next.start - now) / minute)} min`;
      root.innerHTML = `<div class="frame-event-orbit" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div><div class="frame-event-copy" role="status" aria-live="polite" aria-atomic="true"><p class="frame-event-heading">${h(heading)} · ${h(time)}</p><h2>${h(String(next.title || 'Calendar event').slice(0, 160))}</h2>${next.location ? `<p class="frame-event-location">${h(String(next.location).slice(0, 160))}</p>` : ''}</div><button type="button" data-dismiss-event aria-label="Dismiss event reminder">×</button>`;
      root.hidden = false;
      onShow(next);
      timer = setTimeout(hide, Math.max(0, hideAt - now));
    },
  };
}
