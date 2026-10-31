// Original, short earcons synthesized locally. No recordings, downloads or tracking.
const note = (frequency, at = 0, duration = .16, gain = .13, type = 'sine') => ({ frequency, at, duration, gain, type });
export const FRAME_SOUND_CUES = {
  tap: { group: 'interface', notes: [note(420, 0, .075, .08, 'triangle')] },
  navigate: { group: 'interface', notes: [note(392, 0, .09, .08), note(523.25, .055, .11, .08)] },
  open: { group: 'interface', notes: [note(523.25, 0, .12, .08), note(659.25, .07, .14, .07)] },
  close: { group: 'interface', notes: [note(523.25, 0, .12, .07), note(392, .055, .12, .07)] },
  toggleOn: { group: 'interface', notes: [note(440, 0, .09, .08), note(587.33, .06, .13, .08)] },
  toggleOff: { group: 'interface', notes: [note(440, 0, .1, .08), note(329.63, .06, .13, .08)] },
  complete: { group: 'celebrations', priority: 2, notes: [note(523.25, 0, .2, .16), note(783.99, .095, .26, .12), note(1046.5, .1, .13, .025)] },
  undo: { group: 'interface', priority: 2, notes: [note(523.25, 0, .16, .11), note(392, .09, .2, .1)] },
  submitted: { group: 'celebrations', priority: 2, notes: [note(440, 0, .15, .12), note(659.25, .12, .22, .1)] },
  allDone: { group: 'celebrations', priority: 3, notes: [note(523.25, 0, .25, .14), note(659.25, .13, .25, .13), note(783.99, .26, .28, .12), note(1046.5, .42, .65, .13), note(523.25, .44, .62, .06), note(659.25, .44, .6, .055)] },
  saved: { group: 'interface', priority: 2, notes: [note(587.33, 0, .13, .11), note(783.99, .085, .2, .1)] },
  requested: { group: 'interface', priority: 2, notes: [note(440, 0, .12, .1), note(523.25, .1, .18, .09)] },
  error: { group: 'interface', priority: 4, notes: [note(349.23, 0, .14, .13), note(293.66, .16, .22, .12)] },
  unlock: { group: 'interface', priority: 2, notes: [note(392, 0, .15, .1), note(523.25, .1, .18, .1), note(659.25, .18, .23, .08)] },
  lock: { group: 'interface', priority: 2, notes: [note(392, 0, .16, .11), note(261.63, .1, .2, .1)] },
  timerStart: { group: 'reminders', priority: 2, notes: [note(392, 0, .18, .12), note(523.25, .12, .2, .11), note(659.25, .24, .3, .1)] },
  timerWarning: { group: 'reminders', priority: 2, notes: [note(659.25, 0, .2, .11), note(659.25, .3, .24, .1)] },
  timerEnd: { group: 'reminders', priority: 3, notes: [note(783.99, 0, .24, .12), note(659.25, .2, .24, .11), note(523.25, .4, .48, .12)] },
  reward: { group: 'celebrations', priority: 2, notes: [note(659.25, 0, .22, .12), note(783.99, .12, .23, .11), note(1046.5, .26, .42, .1)] },
  reminder: { group: 'reminders', priority: 2, notes: [note(523.25, 0, .22, .1), note(659.25, .22, .3, .09)] },
};

export const DEFAULT_FRAME_SOUNDS = Object.freeze({ enabled: true, volume: .45, interface: true,
  celebrations: true, reminders: true, quiet: true, quietStart: '21:00', quietEnd: '07:00' });
const storageKey = 'family-frame-sounds:v1';
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function normalizeFrameSounds(value = {}) {
  const result = { ...DEFAULT_FRAME_SOUNDS };
  for (const key of ['enabled', 'interface', 'celebrations', 'reminders', 'quiet']) if (typeof value?.[key] === 'boolean') result[key] = value[key];
  if (typeof value?.volume === 'number' && Number.isFinite(value.volume)) result.volume = Math.max(0, Math.min(1, value.volume));
  for (const key of ['quietStart', 'quietEnd']) if (timePattern.test(value?.[key])) result[key] = value[key];
  return result;
}
export function frameSoundsAreQuiet(prefs, now, timezone) {
  if (!prefs.quiet || prefs.quietStart === prefs.quietEnd) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    const clock = `${parts.find(p => p.type === 'hour').value}:${parts.find(p => p.type === 'minute').value}`;
    return prefs.quietStart < prefs.quietEnd ? clock >= prefs.quietStart && clock < prefs.quietEnd : clock >= prefs.quietStart || clock < prefs.quietEnd;
  } catch { return true; } // An unknown clock/zone should not make an unattended frame noisy.
}
export function taskCompletionCue(before, after, { completed, status } = {}) {
  if (!completed) return 'undo';
  if (status === 'submitted') return 'submitted';
  return before.remaining > 0 && after.total > 0 && after.remaining === 0 ? 'allDone' : 'complete';
}

export function createFrameSounds({ enabled = () => false, visible = () => !document.hidden,
  timezone = () => 'America/Denver', now = () => Date.now(),
  storage, contextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(), onPlay = () => {} } = {}) {
  let prefs;
  try { if (storage === undefined) storage = globalThis.localStorage; } catch { storage = null; }
  try { prefs = normalizeFrameSounds(JSON.parse(storage?.getItem(storageKey) || '{}')); } catch { prefs = normalizeFrameSounds(); }
  let context, master, armed = false, lastAt = -Infinity, busyUntil = 0, busyPriority = 0;
  let timerScope = null, timers = new Map();
  const nodes = new Set(), remembered = new Map();
  function stop() {
    for (const node of nodes) { try { node.stop(); } catch { /* Already ended. */ } }
    nodes.clear(); busyUntil = 0; busyPriority = 0;
  }
  function allowed() { return enabled() && visible() && prefs.enabled && prefs.volume > 0; }
  function unlock() {
    if (!allowed()) return;
    armed = true;
    try {
      if (!context || context.state === 'closed') {
        context = contextFactory(); master = context.createGain(); master.gain.value = prefs.volume;
        master.connect(context.destination);
      }
      if (context.state === 'suspended') context.resume().catch(() => {});
    } catch { context = null; }
  }
  function play(name, { preview = false, key } = {}) {
    const cue = FRAME_SOUND_CUES[name], time = now();
    if (!cue || !armed || !allowed() || !context || context.state !== 'running') return false;
    if (!preview && (!prefs[cue.group] || frameSoundsAreQuiet(prefs, time, timezone()))) return false;
    if (key && (remembered.get(key) || 0) > time) return false;
    const priority = cue.priority || 1;
    if (!preview && (time - lastAt < 70 && priority <= busyPriority || time < busyUntil && priority < busyPriority)) return false;
    if (preview || priority >= 2) stop();
    try {
      const start = context.currentTime + .008;
      master.gain.setValueAtTime(prefs.volume, context.currentTime);
      for (const tone of cue.notes) {
        const oscillator = context.createOscillator(), envelope = context.createGain(), at = start + tone.at;
        oscillator.type = tone.type;
        oscillator.frequency.setValueAtTime(tone.frequency, at);
        envelope.gain.setValueAtTime(.0001, at);
        envelope.gain.linearRampToValueAtTime(tone.gain, at + .008);
        envelope.gain.exponentialRampToValueAtTime(.0001, at + tone.duration);
        oscillator.connect(envelope); envelope.connect(master); nodes.add(oscillator);
        oscillator.onended = () => { nodes.delete(oscillator); oscillator.disconnect(); envelope.disconnect(); };
        oscillator.start(at); oscillator.stop(at + tone.duration + .02);
      }
      lastAt = time; busyPriority = priority;
      busyUntil = time + Math.max(...cue.notes.map(n => n.at + n.duration)) * 1000;
      if (key) {
        remembered.set(key, time + 86400_000);
        for (const [id, until] of remembered) if (until <= time || remembered.size > 200) remembered.delete(id);
      }
      onPlay(name); return true;
    } catch { stop(); return false; } // Audio must never prevent a task or settings change.
  }
  function update(value) {
    prefs = normalizeFrameSounds({ ...prefs, ...value });
    try { storage?.setItem(storageKey, JSON.stringify(prefs)); } catch { /* Session settings still work. */ }
    stop(); if (master && context?.state !== 'closed') master.gain.value = prefs.volume;
    return { ...prefs };
  }
  function observeTimers(rows, scope, fresh = true) {
    if (!enabled() || !visible() || !fresh || timerScope !== scope) { timers.clear(); timerScope = scope; }
    if (!enabled() || !visible() || !fresh) return;
    const next = new Map();
    for (const row of rows) {
      next.set(row.id, row);
      const previous = timers.get(row.id);
      if (!previous || !row.running) continue;
      const suffix = `${scope}:${row.id}:${row.deadline}`;
      if (previous.running && previous.remaining > 0 && row.remaining === 0) play('timerEnd', { key: `end:${suffix}` });
      else if ((!previous.running && previous.pending || previous.running && previous.phase === 'preparation' && row.phase === 'usage') && row.remaining > 0) play('timerStart', { key: `start:${suffix}:${row.phase}` });
      else if (previous.running && row.phase === 'usage' && previous.phase === 'usage' && row.warning > 0 && previous.remaining > row.warning && row.remaining > 0 && row.remaining <= row.warning) play('timerWarning', { key: `warn:${suffix}` });
    }
    timers = next;
  }
  return { unlock, play, stop, update, observeTimers, preferences: () => ({ ...prefs }),
    quiet: () => frameSoundsAreQuiet(prefs, now(), timezone()), resetTimers: () => { timers.clear(); timerScope = null; } };
}
