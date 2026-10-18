import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarGeneration, calendarRetryMs, calendarSyncState, selectedCalendarMetadata, sharedCalendarWindow } from './calendar-sync.js';
import { calendarSnapshot } from './calendar-service.js';
import { sharedPool } from './database.js';

test('calendar generation survives JSONB order but changes on reconnect', () => {
  assert.equal(calendarGeneration({ iv: 'one', ciphertext: 'value', v: 1 }), calendarGeneration({ v: 1, ciphertext: 'value', iv: 'one' }));
  assert.notEqual(calendarGeneration({ iv: 'one', ciphertext: 'value' }), calendarGeneration({ iv: 'two', ciphertext: 'value' }));
});

test('selected calendar metadata has a bounded public allowlist and usable colors', () => {
  const result = selectedCalendarMetadata({ selected_ids: ['a', 'b'], calendars: [
    { id: 'a', name: 'Family\ncalendar', color: '#ABCDEF88', url: 'https://private.example', credentials: 'secret' },
    { id: 'b', name: '\u0000', color: 'url(private)' }, { id: 'unselected', name: 'Hidden' },
  ] });
  assert.deepEqual(result, [{ id: 'a', name: 'Familycalendar', color: '#ABCDEF' }, { id: 'b', name: 'Calendar', color: '#00748c' }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('shared rolling range covers frame and native ranges without exceeding 60 days', () => {
  const now = new Date('2026-10-18T01:00:00Z'); // October 17 in the household zone.
  assert.deepEqual(sharedCalendarWindow('2026-10-17', '2026-10-31', 'America/Denver', now), { from: '2026-10-17', to: '2026-11-16' });
  assert.deepEqual(sharedCalendarWindow('2026-09-28', '2026-11-09', 'America/Denver', now), { from: '2026-09-28', to: '2026-11-16' });
  assert.deepEqual(sharedCalendarWindow('2027-01-01', '2027-03-01', 'America/Denver', now), { from: '2027-01-01', to: '2027-03-01' });
});

test('retry backoff is bounded and job status exposes no internal lease fields', () => {
  assert.equal(calendarRetryMs(1), 60_000);
  assert.equal(calendarRetryMs(2), 120_000);
  assert.equal(calendarRetryMs(9999), 3_600_000);
  const now = new Date();
  const state = calendarSyncState({ lease_id: 'private', credential_generation: 'secret', lease_until: new Date(now.getTime() + 1), last_error_code: 'CALENDAR_TIMEOUT' }, now);
  assert.equal(state.state, 'syncing');
  assert.equal(state.error.code, 'CALENDAR_TIMEOUT');
  assert.equal(JSON.stringify(state).includes('private'), false);
  assert.equal(JSON.stringify(state).includes('secret'), false);
});

test('fresh covering cache returns before any queue or provider work', async () => {
  let calls = 0;
  const now = new Date();
  const db = { query: async sql => {
    calls++;
    assert.equal(sql.includes('family_calendar_sync_jobs'), false);
    return { rows: sql.includes('family_calendar_connections') ? [{ selected_ids: ['cal'], version: 2, calendars: [{ id: 'cal', name: 'Family' }] }]
      : [{ successful_at: now, snapshot: { events: [{ id: 'event' }], coverage: { complete: true } } }] };
  } };
  const result = await calendarSnapshot(db, { household: { id: 'household', timezone: 'America/Denver' } }, '2026-10-17', '2026-10-31', { now, sync: () => { throw Error('Must not call provider'); } });
  assert.equal(calls, 2);
  assert.equal(result.status, 'ready');
  assert.equal(result.calendars[0].name, 'Family');
});

test('warm runtime pool is reused only for the same strict TLS configuration', async () => {
  const env = { DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/family_frame_tests', SUPABASE_DB_CA_CERT: 'fixture-ca' };
  const first = sharedPool(env);
  assert.equal(sharedPool({ ...env }), first);
  assert.equal(first.options.max, 3);
  assert.equal(first.options.ssl.rejectUnauthorized, true);
  const second = sharedPool({ ...env, SUPABASE_DB_CA_CERT: 'different-ca' });
  assert.notEqual(first, second);
  await second.end();
});
