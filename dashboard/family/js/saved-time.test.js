import test from 'node:test';
import assert from 'node:assert/strict';
import { durationLabel, savedTime, earnedMessage } from './saved-time.js';

const credit = (id, minutes, expiresAt, extra = {}) => ({ id, personId: 'kid', minutes, status: 'available', expiresAt, ...extra });
const data = credits => ({ serverTime: '2026-12-02T21:00:00Z', savedCapMinutes: 600, credits });

test('durations read the way a child would say them', () => {
  assert.equal(durationLabel(0), '0 min'); assert.equal(durationLabel(45), '45 min');
  assert.equal(durationLabel(60), '1 h'); assert.equal(durationLabel(150), '2 h 30 min'); assert.equal(durationLabel(600), '10 h');
});

test('saved time totals only spendable credits and spends the soonest-expiring first', () => {
  const time = savedTime(data([credit('late', 60, '2026-12-20T07:00:00Z'), credit('soon', 60, '2026-12-04T07:00:00Z'),
    credit('gone', 60, '2026-12-01T07:00:00Z'), credit('held', 60, '2026-12-09T07:00:00Z', { status: 'held' }),
    credit('other', 60, '2026-12-09T07:00:00Z', { personId: 'sibling' })]), 'kid');
  assert.equal(time.savedMinutes, 120); assert.equal(time.next.id, 'soon'); assert.equal(time.atCap, false); assert.equal(time.fraction, .2);
});

test('a reward earned at the cap is use it or lose it and is not counted as saved', () => {
  const bank = Array.from({ length: 10 }, (_, n) => credit(`c${n}`, 60, `2026-12-${10 + n}T07:00:00Z`));
  const extra = credit('today', 60, '2026-12-03T07:00:00Z', { useOrLose: true });
  const time = savedTime(data([...bank, extra]), 'kid');
  assert.equal(time.savedMinutes, 600); assert.equal(time.todayOnlyMinutes, 60); assert.equal(time.atCap, true); assert.equal(time.next.id, 'today');
  assert.match(earnedMessage(extra, time), /maxed out how much time you can save \(10 h\).*1 h you just earned is use it or lose it/);
  assert.match(earnedMessage(bank[0], savedTime(data(bank.slice(0, 3)), 'kid')), /You have 3 h saved of 10 h/);
});
