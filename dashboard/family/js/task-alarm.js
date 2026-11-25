import { escapeHtml as h } from './model.js';

export const ALARM_SNOOZE_MINUTES = 10;

// Epoch milliseconds for a wall-clock time on a household-local date. The
// frame's own timezone setting is irrelevant; a skipped spring-forward time
// resolves to the next valid minute, matching the server.
export function zonedInstant(date, time, timezone) {
  const [year, month, day] = date.split('-').map(Number), [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  const offset = instant => {
    const part = Object.fromEntries(format.formatToParts(new Date(instant)).map(item => [item.type, Number(item.value)]));
    return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute) - instant;
  };
  let instant = wall - offset(wall);
  instant = wall - offset(instant);
  return instant;
}

// Mirrors server/task-alarms.js: an alarm is active on its own day from the due
// time until the task leaves "pending", and silent only while snoozed.
export function alarmStatus(task, { date, timezone, now }) {
  if (!task?.alarm || !task.dueTime || task.status !== 'pending' || task.date !== date) return { active: false, ringing: false, snoozedUntil: null, dueAt: null };
  const dueAt = zonedInstant(task.date, task.dueTime, timezone), active = dueAt <= now;
  const snooze = Date.parse(task.alarmSnoozedUntil || '');
  const snoozedUntil = active && Number.isFinite(snooze) && snooze > now ? snooze : null;
  return { active, ringing: active && !snoozedUntil, snoozedUntil, dueAt };
}

// A two-tone ringer synthesized locally. It is deliberately independent of the
// frame's sound preferences: mute, volume and quiet hours do not silence an alarm.
export function createAlarmRinger({ contextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)() } = {}) {
  let context = null, timer = null;
  function beep() {
    try {
      if (!context || context.state === 'closed') context = contextFactory();
      // The kiosk allows playback without a touch; elsewhere this resumes on the first gesture.
      if (context.state === 'suspended') context.resume().catch(() => {});
      const start = context.currentTime + .02;
      for (const [frequency, at] of [[880, 0], [1174.66, .18], [880, .36], [1174.66, .54]]) {
        const oscillator = context.createOscillator(), envelope = context.createGain();
        oscillator.type = 'square'; oscillator.frequency.setValueAtTime(frequency, start + at);
        envelope.gain.setValueAtTime(.0001, start + at);
        envelope.gain.linearRampToValueAtTime(.3, start + at + .01);
        envelope.gain.exponentialRampToValueAtTime(.0001, start + at + .15);
        oscillator.connect(envelope); envelope.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
        oscillator.start(start + at); oscillator.stop(start + at + .17);
      }
    } catch { /* A silent alarm still shows; sound must never break the screen. */ }
  }
  return {
    start() { if (timer) return; beep(); timer = setInterval(beep, 1200); },
    stop() { if (!timer) return; clearInterval(timer); timer = null; try { context?.suspend?.(); } catch { /* Already closed. */ } },
    ringing: () => !!timer,
  };
}

// Full-screen alarm for the frame (and a child's own browser). It stays up and
// keeps ringing until the task is confirmed; the only other control is Snooze.
export function createTaskAlarm({ enabled, tasks, date, timezone, now = () => Date.now(), personName, timeLabel, onDone, onSnooze, busy = () => false, ringer = createAlarmRinger() }) {
  let modal = null, shownId = null, working = false;
  function close() {
    ringer.stop(); shownId = null;
    if (modal) { modal.close(); modal.remove(); modal = null; }
  }
  function show(task) {
    if (!modal) {
      modal = document.createElement('dialog'); modal.className = 'task-alarm'; modal.setAttribute('aria-labelledby', 'task-alarm-title');
      modal.addEventListener('cancel', event => event.preventDefault()); // Escape cannot dismiss an alarm.
      modal.addEventListener('click', async event => {
        const action = event.target.closest('[data-alarm]')?.dataset.alarm, current = tasks().find(item => item.id === shownId);
        if (!action || !current || working) return;
        working = true; paint();
        // The handlers return a sentence when the change was not saved; it is shown here
        // because toasts and task rows sit underneath this screen.
        let note = '';
        try { note = await (action === 'done' ? onDone(current) : onSnooze(current)) || ''; }
        catch (error) { note = error?.message || 'That did not save. Try again.'; }
        finally { working = false; tick(); }
        const line = modal?.querySelector('.task-alarm-note');
        if (line) { line.textContent = note; line.hidden = !note; }
      });
      document.body.append(modal);
    }
    shownId = task.id; modal.dataset.taskId = task.id;
    modal.innerHTML = `<div class="task-alarm-bell" aria-hidden="true">⏰</div><p class="eyebrow">${h(personName(task.personId) || 'Alarm')} · ${h(timeLabel(task.dueTime))}</p><h2 id="task-alarm-title">${h(task.title)}</h2><p class="task-alarm-help">This alarm keeps ringing until ${h(personName(task.personId) || 'it')} confirms it is done.</p><p class="task-alarm-note" role="alert" hidden></p><div class="task-alarm-actions"><button type="button" class="task-alarm-done" data-alarm="done">Done</button><button type="button" class="task-alarm-snooze" data-alarm="snooze">Snooze ${ALARM_SNOOZE_MINUTES} minutes</button></div>`;
    if (!modal.open) modal.showModal();
    paint();
  }
  function paint() { modal?.querySelectorAll('button').forEach(button => { button.disabled = working; }); }
  function tick() {
    if (!enabled()) { close(); return; }
    const context = { date: date(), timezone: timezone(), now: now() };
    const ringing = tasks().filter(task => alarmStatus(task, context).ringing);
    const task = ringing.find(item => item.id === shownId) || ringing[0];
    if (!task) { close(); return; }
    if (task.id !== shownId) show(task);
    // Stay quiet while the child types a PIN or a save is in flight; the screen stays up.
    if (busy() || working) ringer.stop(); else ringer.start();
  }
  return { tick, close, showing: () => shownId };
}
