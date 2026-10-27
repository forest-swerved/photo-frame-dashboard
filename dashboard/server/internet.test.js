import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRewardPolicy, deviceFields, sessionDeadline, validateRewardPolicy } from './internet.js';
import { sameManagedPolicy, scheduledSessionPolicy, sessionOrdering } from './internet-worker.js';
import { managedPolicyPlan } from './unifi.js';
const buckets = (beforeSystemDefined = [], afterSystemDefined = []) => ({ beforeSystemDefined, afterSystemDefined });
const ids = Array.from({ length: 6 }, (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`);
test('parent reward policy validates limits and preserves defaults', () => {
  assert.equal(defaultRewardPolicy(ids[0]).rewardMinutes, 60);
  assert.equal(validateRewardPolicy({ rewardMinutes: 90, bedtime: '20:30' }, defaultRewardPolicy(ids[0])).rewardMinutes, 90);
  for (const body of [{ rewardMinutes: 0 }, { rewardMinutes: 1440 }, { carryoverDays: -1 }, { dailyLimitMinutes: 1441 }, { warningMinutes: 61 }, { enabled: 'false' }, { bedtime: '25:00' }]) assert.throws(() => validateRewardPolicy(body, defaultRewardPolicy(ids[0])));
});
test('all-day ends at home midnight across DST and travel, deadlines never round up', () => {
  assert.equal(sessionDeadline(new Date('2026-11-01T07:30:15Z'), 'America/Denver', 0, { allDay: true }).toISOString(), '2026-11-02T07:00:00.000Z');
  assert.equal(sessionDeadline(new Date('2026-10-18T01:00:59Z'), 'America/Denver', 3600).toISOString(), '2026-10-18T02:00:00.000Z');
  assert.throws(() => sessionDeadline(new Date('2026-10-18T01:00:00Z'), 'America/Denver', 3600, { bedtime: '19:30' }), e => e.code === 'bedtime_limit');
  assert.throws(() => sessionDeadline(new Date('2026-10-18T01:00:30Z'), 'America/Denver', 86400), e => e.code === 'dst_window_unrepresentable');
});
test('device identities normalize and reject empty or invalid profile assignments', () => {
  const value = deviceFields({ name: ' Console ', personIds: [ids[0], ids[0]], macAddresses: ['02:AA:BB:CC:DD:EE'] });
  assert.equal(value.name, 'Console'); assert.deepEqual(value.personIds, [ids[0]]); assert.equal(value.macAddresses[0], '02:aa:bb:cc:dd:ee');
  assert.throws(() => deviceFields({ name: 'Device', personIds: [], macAddresses: ['02:aa:bb:cc:dd:ee'] }));
});
test('session insertion preserves foreign firewall rules and requires permanent management ordering', () => {
  assert.deepEqual(sessionOrdering(buckets([ids[4], ids[0], ids[3], ids[1], ids[5]]), ids[0], ids[1], ids[2]), buckets([ids[4], ids[0], ids[3], ids[2], ids[1], ids[5]]));
  assert.throws(() => sessionOrdering(buckets([ids[1], ids[0]]), ids[0], ids[1], ids[2]));
});
test('scheduled allowance retains exact identities, deadline and both IP versions', () => {
  const device = { id: ids[0], mac_addresses: ['02:11:22:33:44:55'] };
  const integration = { source_zone_id: ids[1], external_zone_id: ids[2], pilot_checks: { midnight: true } };
  const p = scheduledSessionPolicy({ id: ids[3], ends_at: '2026-10-18T02:00:00Z' }, device, integration, 'America/Denver', new Date('2026-10-18T01:00:00Z'));
  assert.deepEqual(p.schedule, { mode: 'ONE_TIME_ONLY', date: '2026-10-17', timeFilter: { startTime: '19:00', stopTime: '20:00' } });
  assert.equal(p.ipProtocolScope.ipVersion, 'IPV4_AND_IPV6'); assert.equal(p.schedule.mode, 'ONE_TIME_ONLY');
  const baseline = managedPolicyPlan({ deviceId: ids[0], macAddresses: device.mac_addresses, sourceZoneId: ids[1], destinationZoneId: ids[2] });
  assert.ok(sameManagedPolicy({ id: ids[4], ...baseline.management, metadata: { origin: 'USER_DEFINED' } }, baseline.management));
  assert.equal(sameManagedPolicy({ ...baseline.management, schedule: p.schedule }, baseline.management), false);
  assert.throws(() => scheduledSessionPolicy({ id: ids[3], ends_at: '2026-10-19T06:00:00Z' }, device, { ...integration, pilot_checks: {} }, 'America/Denver', new Date('2026-10-19T05:30:00Z')), e => e.code === 'schedule_unverified');
});
