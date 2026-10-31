import { escapeHtml as h, color, dateInZone, dateFormatter } from './model.js';
import { createFrameMediaCache } from './frame-media-cache.js';
import { frameTaskLanes } from './frame-home.js';

export function ambientEvents(calendar, timezone, now = Date.now()) {
  const today = dateInZone(new Date(now), timezone);
  return (calendar?.events || []).filter(event => event.status !== 'cancelled' &&
    (event.allDay ? (event.endDateExclusive || event.endDate || event.startDate) > today || event.startDate === today
      : Date.parse(event.endAt || event.startAt) > now))
    .sort((a, b) => String(a.startAt || a.startDate).localeCompare(String(b.startAt || b.startDate))).slice(0, 40);
}

export function createFrameAmbient(root, { state, media, readMediaURL, onWake, onAuthFailure = () => {}, now = () => performance.now() }) {
  let active = false, scope, started = 0, index = 0, photoIndex = 0, bank = [], fetchedAt = -Infinity, loading = false, epoch = 0, painted = '';
  let taskStarts = new Map(), taskShown = new Map(), calendarStart = 0, calendarShown = 0, calendarTotal = 0;
  let swallowUntil = 0, muted = true, mediaURL = null, mediaEpoch = 0, failedMedia = new Set(), playing = false, lastProgress = 0;
  const mediaCache = createFrameMediaCache({ readURL: readMediaURL, onAuthFailure });
  const app = document.querySelector('#family-app');
  function hide() {
    mediaEpoch++; root.querySelector('video')?.pause(); if (mediaURL) URL.revokeObjectURL(mediaURL); mediaURL = null; muted = true; playing = false;
    active = false; root.hidden = true; root.replaceChildren(); painted = '';
    app.inert = false; app.removeAttribute('aria-hidden');
  }
  function reset() { taskStarts.clear(); taskShown.clear(); calendarStart = 0; epoch++; bank = []; fetchedAt = -Infinity; loading = false; scope = undefined; hide(); }
  function sync() {
    const current = state();
    if (!current.enabled || scope !== undefined && current.scope !== scope) reset();
    if (current.enabled) mediaCache.bind(current.cacheScope);
    else if (current.purge) mediaCache.bind(null);
    return current;
  }
  function wake(event) {
    if (active && event.target.closest?.('[data-video-sound]')) return;
    if (!active && now() >= swallowUntil) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (active) { swallowUntil = event.type === 'pointerdown' ? Infinity : now() + 600; hide(); onWake(); }
    else if (['pointerup','pointercancel','touchend','keyup'].includes(event.type)) swallowUntil = now() + 600;
  }
  // Capture the entire first gesture, including its compatibility click.
  for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'wheel']) {
    document.addEventListener(name, wake, { capture: true, passive: false });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  async function refreshMedia() {
    if (loading || now() - fetchedAt < 60_000) return;
    const version = epoch; loading = true; fetchedAt = now();
    try {
      const result = await media();
      const current = sync(); if (version !== epoch || !current.enabled) return;
      bank = (result.media || []).filter(item => /^[0-9a-f-]{36}$/i.test(item.id) && ['photo','video'].includes(item.kind)).slice(0, 200);
      await mediaCache.bind(current.cacheScope); mediaCache.sync(bank);
    } catch (error) {
      if (version === epoch && [401, 403].includes(error.status)) { reset(); onAuthFailure(error); }
    } finally { if (version === epoch) loading = false; }
  }
  function paint() {
    const s = sync(); if (!active) return;
    const date = new Date(), format = options => dateFormatter({ timeZone: s.timezone, ...options }).format(date);
    const available = bank.filter(item => mediaCache.has(item.id) && !failedMedia.has(item.id));
    const photo = available[photoIndex % available.length];
    const type = photo && index % 2 ? photo.kind : ['clock', 'date', 'calendar', 'tasks'][Math.floor(index / 2) % 4];
    if (type === 'video' ? playing && now() - lastProgress > 15_000 || now() - started > 330_000 : now() - started >= 20_000) { advance(); return; }
    const key = JSON.stringify([type, photo?.id, Math.floor(index / 8), type === 'tasks' ? s.tasks : type === 'calendar' ? s.calendar : null, ['photo','video'].includes(type) ? null : s.stale]);
    if (key !== painted) {
      mediaEpoch++; root.querySelector('video')?.pause(); if (mediaURL) URL.revokeObjectURL(mediaURL); mediaURL = null; playing = false;
      painted = key; root.dataset.view = type;
      let content = '';
      if (type === 'clock') content = `<div class="ambient-clock"><p class="ambient-kicker">A little more together</p><div class="ambient-time"><span data-ambient-time></span><span class="ambient-clock-detail"><span class="ambient-seconds" data-ambient-seconds></span><span class="ambient-period" data-ambient-period></span></span></div><p class="ambient-clock-date" data-ambient-date></p><div class="ambient-orbit" aria-hidden="true"><i></i></div></div>`;
      if (type === 'date') content = `<div class="ambient-date-card"><p class="ambient-kicker" data-ambient-month></p><div class="ambient-date-number" data-ambient-day></div><h1 data-ambient-weekday></h1><p class="ambient-date-year" data-ambient-year></p></div>`;
      if (type === 'calendar') {
        const allEvents = ambientEvents(s.calendar, s.timezone); calendarTotal = allEvents.length;
        if (calendarStart >= calendarTotal) calendarStart = 0;
        const events = allEvents.slice(calendarStart, calendarStart + 5), ready = s.calendar?.status === 'ready' && s.calendar?.coverage?.complete;
        content = `<div class="ambient-content"><p class="ambient-kicker">The family schedule</p><h1>Coming up.</h1>${!ready ? '<p class="ambient-status">Calendar updates are unavailable. Showing the last available schedule.</p>' : ''}<div class="ambient-agenda" data-fit-events>${events.map(event => {
          const instant = new Date(event.startAt || `${event.startDate}T12:00:00Z`);
          const label = event.allDay ? 'All day' : dateFormatter({ timeZone: s.timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(instant);
          const day = Number.isFinite(instant.getTime()) ? dateFormatter({ timeZone: event.allDay ? 'UTC' : s.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(instant) : '';
          return `<article><div><strong>${h(label)}</strong><small>${h(day)}</small></div><section><h2>${h(event.title || 'Calendar event')}</h2>${event.location ? `<p>${h(event.location)}</p>` : ''}</section></article>`;
        }).join('') || `<p class="ambient-empty">${ready ? 'A little room to breathe.<br>No upcoming events in the loaded schedule.' : 'Your schedule will appear when the calendar reconnects.'}</p>`}</div><p class="ambient-page-note" data-event-page></p></div>`;
      }
      if (type === 'tasks') {
        taskShown.clear();
        const lanes = frameTaskLanes(s.people, s.tasks, s.schoolDay), page = Math.floor(index / 8) % Math.max(1, Math.ceil(lanes.length / 4));
        content = `<div class="ambient-content"><p class="ambient-kicker">One little win at a time</p><h1>Still to do.</h1>${s.schoolDay?.type === 'unknown' ? '<p class="ambient-status">School schedule is unconfirmed. Check Home for details.</p>' : ''}<div class="ambient-task-grid">${lanes.slice(page * 4, page * 4 + 4).map(({ profile, groups, overview }) => {
          const start = (taskStarts.get(profile.id) || 0) < groups.todo.length ? taskStarts.get(profile.id) || 0 : 0;
          taskStarts.set(profile.id, start);
          return `<article style="--person:${color(profile.color)}" data-fit-person="${h(profile.id)}" data-task-total="${groups.todo.length}"><div class="ambient-person"><span>${h(profile.name?.slice(0, 1))}</span><h2>${h(profile.name)}</h2></div><p class="ambient-task-count">${overview.completed}<small> / ${overview.total} required done</small></p><div class="ambient-progress"><i style="width:${overview.total ? overview.completed / overview.total * 100 : 0}%"></i></div><ul>${groups.todo.slice(start, start + 5).map(task => `<li>${h(task.title)}</li>`).join('')}</ul><p class="ambient-page-note" data-task-page></p>${groups.submitted.length ? `<p class="ambient-status">${groups.submitted.length} waiting for a parent</p>` : ''}${!groups.todo.length && !groups.submitted.length ? '<p class="ambient-task-done">You’re all set ✓</p>' : ''}</article>`;
        }).join('') || '<p class="ambient-empty">No family profiles yet.</p>'}</div></div>`;
      }
      if (type === 'photo' || type === 'video') content = `<div class="ambient-photo">${type === 'video' ? '<video playsinline preload="auto" muted aria-label="Family video"></video><button type="button" class="ambient-video-sound" data-video-sound aria-label="Unmute video" aria-pressed="false"></button>' : '<img alt="A photo from your family collection" decoding="async">'}<p class="ambient-photo-label">Our moments <span>${photoIndex % available.length + 1} / ${available.length}</span></p></div>`;
      root.innerHTML = `<header class="ambient-header"><span><img src="/brand/folded-home.svg" alt="">Family Frame</span><time data-ambient-small-time></time></header>${content}<footer class="ambient-footer"><span>${h(s.title)}${s.stale ? ' · Reconnecting to live updates' : ''}</span><span>Touch anywhere to return Home <b aria-hidden="true">↗</b></span></footer>`;
      fitLists();
      if (type === 'photo' || type === 'video') {
        const version = mediaEpoch, element = root.querySelector(type === 'video' ? 'video' : '.ambient-photo img');
        const skip = () => { if (version === mediaEpoch) { failedMedia.add(photo.id); advance(); } };
        element.addEventListener('error', skip, { once: true });
        if (type === 'video') {
          element.muted = muted; updateSoundButton();
          element.addEventListener('ended', () => { if (version === mediaEpoch) advance(); }, { once: true });
          element.addEventListener('timeupdate', () => { if (version === mediaEpoch) lastProgress = now(); });
          root.querySelector('[data-video-sound]').addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation(); muted = !muted; element.muted = muted; updateSoundButton();
          });
        }
        mediaCache.url(photo).then(url => {
          if (version !== mediaEpoch) { if (url) URL.revokeObjectURL(url); return; }
          if (!url) { skip(); return; }
          mediaURL = url; element.src = url; started = now();
          if (type === 'video') { playing = true; lastProgress = now(); element.play().catch(skip); }
        }).catch(skip);
      }

    }
    const write = (selector, value) => { const node = root.querySelector(selector); if (node && node.textContent !== value) node.textContent = value; };
    const clockParts = dateFormatter({ timeZone: s.timezone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(date);
    write('[data-ambient-time]', clockParts.filter(part => ['hour','minute','literal'].includes(part.type)).map(part => part.value).join('').trim());
    write('[data-ambient-period]', clockParts.find(part => part.type === 'dayPeriod')?.value || '');
    write('[data-ambient-seconds]', format({ second: '2-digit' }).padStart(2, '0'));
    write('[data-ambient-date]', format({ weekday: 'long', month: 'long', day: 'numeric' }));
    write('[data-ambient-small-time]', format({ hour: 'numeric', minute: '2-digit', hour12: true }));
    write('[data-ambient-month]', format({ month: 'long' })); write('[data-ambient-day]', format({ day: 'numeric' }));
    write('[data-ambient-weekday]', format({ weekday: 'long' })); write('[data-ambient-year]', format({ year: 'numeric' }));
  }
  function fitLists() {
    // Measure the real font/viewport. Never rely on a fixed number of rows to
    // fit: long task names and event locations need their full line height.
    const fit = container => {
      while (container.children.length > 1 && container.scrollHeight > container.clientHeight + 1) container.lastElementChild.remove();
      for (let size = parseFloat(getComputedStyle(container).fontSize); container.scrollHeight > container.clientHeight + 1 && size > 18; size--) container.style.fontSize = `${size - 1}px`;
      return container.children.length;
    };
    for (const card of root.querySelectorAll('[data-fit-person]')) {
      const list = card.querySelector('ul'), count = fit(list), id = card.dataset.fitPerson, total = Number(card.dataset.taskTotal), start = taskStarts.get(id) || 0;
      taskShown.set(id, { count, total });
      card.querySelector('[data-task-page]').textContent = total ? `${start + 1}–${start + count} of ${total} remaining · rotates automatically` : '';
    }
    const events = root.querySelector('[data-fit-events]');
    if (events && calendarTotal) {
      calendarShown = fit(events);
      root.querySelector('[data-event-page]').textContent = `${calendarStart + 1}–${calendarStart + calendarShown} of ${calendarTotal} upcoming · rotates automatically`;
    }
  }
  function updateSoundButton() {
    const button = root.querySelector('[data-video-sound]'); if (!button) return;
    button.setAttribute('aria-label', muted ? 'Unmute video' : 'Mute video'); button.setAttribute('aria-pressed', String(!muted));
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M11 4 6 8H2v8h4l5 4Z"/>${muted ? '<path d="m16 9 6 6m0-6-6 6"/>' : '<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'}</svg>`;
  }
  function advance() {
    if (root.dataset.view === 'tasks') for (const [id, { count, total }] of taskShown) taskStarts.set(id, ((taskStarts.get(id) || 0) + count) % (total || 1));
    if (root.dataset.view === 'calendar') calendarStart = (calendarStart + calendarShown) % (calendarTotal || 1);
    if (index % 2) photoIndex++; index += bank.some(item => mediaCache.has(item.id) && !failedMedia.has(item.id)) ? 1 : 2; started = now(); painted = ''; paint(); }
  return {
    active: () => active, sync,
    status: () => ({ cached: mediaCache.count(), total: bank.length }),
    start() {
      const s = sync(); if (!s.enabled || active || document.hidden) return;
      scope = s.scope; active = true; muted = true; failedMedia = new Set(); started = now(); index = 0; painted = '';
      root.hidden = false; app.inert = true; app.setAttribute('aria-hidden', 'true');
      document.activeElement?.blur(); paint(); refreshMedia();
    },
    tick() { const s = sync(); if (s.enabled) { refreshMedia(); if (active) paint(); } },
  };
}
