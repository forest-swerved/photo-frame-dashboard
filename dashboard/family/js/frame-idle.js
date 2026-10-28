// Only human input resets the deadline; data polling and scroll restoration do
// not. The caller owns navigation, authorization, and in-flight write guards.
export function createFrameIdleReturn({ enabled, blocked, onIdle, root = document, now = () => performance.now() }) {
  let lastActivity = now();
  const pointers = new Set(), drafts = new WeakSet();
  const activity = () => { lastActivity = now(); };
  const options = { capture: true, passive: true };
  root.addEventListener('pointerdown', event => { pointers.add(event.pointerId); activity(); }, options);
  for (const type of ['pointerup', 'pointercancel']) root.addEventListener(type, event => { pointers.delete(event.pointerId); activity(); }, options);
  root.addEventListener('pointermove', event => { if (pointers.has(event.pointerId) || event.buttons) activity(); }, options);
  for (const type of ['keydown', 'wheel']) root.addEventListener(type, activity, options);
  for (const type of ['input', 'change']) root.addEventListener(type, event => {
    activity();
    const form = event.target.closest?.('form');
    if (form && enabled()) drafts.add(form);
  }, options);
  root.addEventListener('visibilitychange', () => { if (root.hidden) pointers.clear(); });
  return {
    saved(form) { drafts.delete(form); },
    tick() {
      if (!enabled()) { pointers.clear(); activity(); return; }
      if (root.hidden) return;
      if (pointers.size || blocked() || [...root.querySelectorAll('form')].some(form => drafts.has(form) || form.dataset.reviewRequired === 'true')) {
        activity(); return;
      }
      if (now() - lastActivity < 60_000) return;
      activity();
      onIdle();
    },
  };
}
