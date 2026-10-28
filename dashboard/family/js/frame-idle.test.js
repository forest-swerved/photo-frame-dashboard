import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameIdleReturn } from './frame-idle.js';

function fixture() {
  const root = new EventTarget(), state = { time: 0, enabled: true, blocked: false, returns: 0, forms: [] };
  root.hidden = false; root.querySelectorAll = () => state.forms;
  const idle = createFrameIdleReturn({ root, now: () => state.time, enabled: () => state.enabled, blocked: () => state.blocked, onIdle: () => state.returns++ });
  const emit = (type, values = {}) => { const event = new Event(type); Object.assign(event, values); root.dispatchEvent(event); };
  const advance = ms => { state.time += ms; idle.tick(); };
  return { root, state, idle, emit, advance };
}
test('idle returns at sixty seconds; background work and scroll restoration do not reset it', () => {
  const f = fixture(); f.advance(59_000); assert.equal(f.state.returns, 0);
  f.emit('scroll'); f.advance(1000); assert.equal(f.state.returns, 1);
});
test('touches, keyboard and wheel start a fresh minute while mouse hover does not', () => {
  for (const type of ['pointerdown', 'pointerup', 'keydown', 'wheel']) {
    const f = fixture(); f.advance(59_000); f.emit(type, { pointerId: 1 });
    if (type === 'pointerdown') f.emit('pointerup', { pointerId: 1 });
    f.advance(59_000); assert.equal(f.state.returns, 0); f.advance(1000); assert.equal(f.state.returns, 1);
  }
  const f = fixture(); f.advance(59_000); f.emit('pointermove', { pointerId: 1, buttons: 0 }); f.advance(1000); assert.equal(f.state.returns, 1);
});
test('an active drag or a write defers returning and leaves a fresh minute afterward', () => {
  const f = fixture(); f.emit('pointerdown', { pointerId: 1 }); f.advance(90_000); assert.equal(f.state.returns, 0);
  f.emit('pointercancel', { pointerId: 1 }); f.state.blocked = true; f.advance(90_000); assert.equal(f.state.returns, 0);
  f.state.blocked = false; f.advance(59_000); assert.equal(f.state.returns, 0); f.advance(1000); assert.equal(f.state.returns, 1);
});
test('unsaved and review-required forms remain until saved or closed', () => {
  const f = fixture(), form = { dataset: {} }; f.state.forms = [form];
  f.emit('input', {}); // Input from a non-form surface still counts as activity.
  const event = new Event('change'); Object.defineProperty(event, 'target', { value: { closest: () => form } }); f.root.dispatchEvent(event);
  f.advance(90_000); assert.equal(f.state.returns, 0);
  f.idle.saved(form); form.dataset.reviewRequired = 'true'; f.advance(90_000); assert.equal(f.state.returns, 0);
  f.state.forms = []; f.advance(59_000); assert.equal(f.state.returns, 0); f.advance(1000); assert.equal(f.state.returns, 1);
});
test('unpaired and ordinary clients never return; hidden elapsed time is evaluated on foreground', () => {
  const f = fixture(); f.state.enabled = false; f.advance(90_000); assert.equal(f.state.returns, 0);
  f.state.enabled = true; f.root.hidden = true; f.advance(90_000); assert.equal(f.state.returns, 0);
  f.root.hidden = false; f.idle.tick(); assert.equal(f.state.returns, 1);
});
