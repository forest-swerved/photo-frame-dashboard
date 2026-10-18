import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool } from './database.js';
import { encryptCredentials } from './credentials.js';
import { calendarSnapshot, removeCalendar, selectCalendars } from './calendar-service.js';
import { processCalendarSyncJobs, runCalendarSyncJob } from './calendar-sync.js';
import { CalendarSyncError } from './icloud-caldav.js';

const enabled = process.env.FAMILY_RUN_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('durable calendar sync uses isolated local TLS Postgres', { skip: !enabled, timeout: 30_000 }, async t => {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Refusing calendar DDL on a remote database.');
  const pool = createPool(process.env, { migration: true, max: 10 });
  const schema = `family_calendar_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  const householdId = randomUUID();
  const env = { FAMILY_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64') };
  const principal = { authType: 'user', actor: 'user:fixture', role: 'admin', household: { id: householdId, timezone: 'America/Denver' } };
  const db = {
    async connect() { const client = await pool.connect(); try { await client.query(`SET search_path TO ${schema},pg_catalog`); return client; } catch (error) { client.release(); throw error; } },
    async query(sql, values) { const client = await this.connect(); try { return await client.query(sql, values); } finally { client.release(); } },
  };
  const from = '2026-10-17'; const to = '2026-10-24';
  const now = new Date();
  const snapshot = id => ({ events: [{ id, calendarId: 'cal', allDay: true, startDate: from, endDateExclusive: to }],
    coverage: { complete: true, truncated: false }, lastSuccessfulSyncAt: new Date().toISOString() });
  const reset = async () => {
    await db.query('DELETE FROM family_calendar_cache');
    await db.query('DELETE FROM family_calendar_sync_jobs');
  };
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests');
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    await db.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('./calendar-sync-schema.sql', import.meta.url), 'utf8'));
    await db.query('INSERT INTO family_households(id,title,timezone) VALUES($1,$2,$3)', [householdId, 'Fixture family', principal.household.timezone]);
    await db.query('INSERT INTO family_calendar_connections(household_id,credentials,calendars,selected_ids) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb)',
      [householdId, JSON.stringify(encryptCredentials(householdId, { username: 'fixture', appPassword: 'fixture' }, env)), JSON.stringify([{ id: 'cal', name: 'Family', color: '#abcdef88' }]), JSON.stringify(['cal'])]);

    await t.test('concurrent frame and native misses make one provider call and share coverage', async () => {
      let started; const called = new Promise(resolve => { started = resolve; });
      let release; const blocked = new Promise(resolve => { release = resolve; });
      let calls = 0;
      const sync = async () => { calls++; started(); await blocked; return snapshot('one'); };
      const pending = calendarSnapshot(db, principal, from, to, { env, sync, now });
      await called;
      const second = await calendarSnapshot(db, principal, from, '2026-10-31', { env, sync, now });
      assert.equal(second.status, 'loading');
      assert.equal(calls, 1);
      release(); const ready = await pending;
      assert.equal(ready.status, 'ready');
      assert.equal(ready.calendars[0].color, '#abcdef');
      const cached = await calendarSnapshot(db, principal, from, '2026-10-31', { env, sync, now });
      assert.equal(cached.status, 'ready');
      assert.equal(calls, 1);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM family_calendar_sync_jobs')).rows[0].count, 1);
    });

    await t.test('stale snapshot returns without provider I/O and cron refreshes it independently', async () => {
      await db.query("UPDATE family_calendar_cache SET successful_at=$1::timestamptz-interval '1 hour'", [now]);
      await db.query("UPDATE family_calendar_sync_jobs SET next_attempt_at=$1,last_successful_at=$1::timestamptz-interval '1 hour'", [now]);
      const stale = await calendarSnapshot(db, principal, from, to, { env, now, sync: () => { throw Error('Foreground provider must not run'); } });
      assert.equal(stale.status, 'stale');
      assert.equal(stale.events[0].id, 'one');
      let calls = 0;
      const result = await processCalendarSyncJobs(db, { env, now, sync: async () => { calls++; return snapshot('two'); } });
      assert.deepEqual(result, { processed: 1, synced: 1, failed: 0, busy: 0 });
      assert.equal(calls, 1);
      const fresh = await calendarSnapshot(db, principal, from, to, { env, now });
      assert.equal(fresh.events[0].id, 'two');
    });

    await t.test('failure keeps last-good cache, redacts provider errors and enforces retry backoff', async () => {
      const result = await calendarSnapshot(db, principal, from, to, { env, now, force: true,
        sync: async () => { throw new CalendarSyncError('CALENDAR_TIMEOUT', 'private DAV URL and Apple account'); } });
      assert.equal(result.status, 'stale');
      assert.equal(result.events[0].id, 'two');
      assert.equal(result.error.code, 'CALENDAR_TIMEOUT');
      assert.equal(JSON.stringify(result).includes('private DAV'), false);
      const row = (await db.query('SELECT * FROM family_calendar_sync_jobs')).rows[0];
      assert.equal(row.attempts, 1);
      assert.equal(new Date(row.next_attempt_at) - now, 60_000);
      const repeated = await processCalendarSyncJobs(db, { env, now, sync: () => { throw Error('Backoff must not call provider'); } });
      assert.equal(repeated.processed, 0);
      const forced = await calendarSnapshot(db, principal, from, to, { env, now, force: true,
        sync: () => { throw Error('Immediate repeated force must honor cooldown'); } });
      assert.equal(forced.error.code, 'CALENDAR_TIMEOUT');
    });

    await t.test('incomplete or over-limit snapshots never replace the last good result', async () => {
      await db.query('UPDATE family_calendar_sync_jobs SET next_attempt_at=$1,last_error_code=NULL', [now]);
      const incomplete = await calendarSnapshot(db, principal, from, to, { env, now, force: true,
        sync: async () => ({ ...snapshot('bad'), coverage: { complete: true, truncated: false }, events: Array.from({ length: 401 }, (_, i) => ({ id: String(i) })) }) });
      assert.equal(incomplete.status, 'stale');
      assert.equal(incomplete.events[0].id, 'two');
      assert.equal((await db.query('SELECT snapshot FROM family_calendar_cache')).rows[0].snapshot.events[0].id, 'two');
    });

    await t.test('an expired crashed lease can be reclaimed and old worker cannot publish', async () => {
      await reset();
      let started; const called = new Promise(resolve => { started = resolve; });
      let release; const blocked = new Promise(resolve => { release = resolve; });
      const pending = calendarSnapshot(db, principal, from, to, { env, now, sync: async () => { started(); await blocked; return snapshot('old-worker'); } });
      await called;
      await db.query("UPDATE family_calendar_sync_jobs SET lease_until=$1::timestamptz-interval '1 second'", [now]);
      const job = (await db.query('SELECT *,start_date::text AS from_date,end_date::text AS to_date FROM family_calendar_sync_jobs')).rows[0];
      const replacement = await runCalendarSyncJob(db, job, { env, now, sync: async () => snapshot('new-worker') });
      assert.equal(replacement.outcome, 'synced');
      release(); assert.equal((await pending).status, 'loading');
      assert.equal((await db.query('SELECT snapshot FROM family_calendar_cache')).rows[0].snapshot.events[0].id, 'new-worker');
    });

    await t.test('different date ranges share a single household lease without holding a provider transaction', async () => {
      await reset();
      let started; const called = new Promise(resolve => { started = resolve; });
      let release; const blocked = new Promise(resolve => { release = resolve; });
      let calls = 0;
      const sync = async () => { calls++; started(); await blocked; return snapshot('shared-account'); };
      const pending = calendarSnapshot(db, principal, from, to, { env, now, sync });
      await called;
      const other = await calendarSnapshot(db, principal, '2027-01-01', '2027-01-08', { env, now, sync });
      assert.equal(other.status, 'loading');
      assert.equal(calls, 1);
      assert.equal((await db.query('SELECT * FROM family_calendar_sync_jobs WHERE lease_id IS NOT NULL')).rowCount, 1);
      assert.equal((await db.query('SELECT * FROM family_calendar_sync_jobs')).rowCount, 2);
      release(); await pending;
    });

    await t.test('completed historical browsing jobs stay idle instead of starving the rolling calendar', async () => {
      await reset();
      await calendarSnapshot(db, principal, '2027-01-01', '2027-01-08', { env, now, sync: async () => snapshot('future-browsing') });
      let calls = 0;
      const result = await processCalendarSyncJobs(db, { env, now, sync: async options => {
        calls++;
        assert.notEqual(options.startDate, '2027-01-01');
        return snapshot('primary');
      } });
      assert.equal(result.synced, 1);
      assert.equal(calls, 1);
      assert.equal((await db.query('SELECT * FROM family_calendar_sync_jobs WHERE next_attempt_at IS NOT NULL')).rowCount, 0);
    });

    await t.test('cron alone creates and refreshes the calendar without an open app or frame', async () => {
      await reset();
      const result = await processCalendarSyncJobs(db, { env, now, sync: async () => snapshot('scheduled-only') });
      assert.equal(result.synced, 1);
      assert.equal((await db.query('SELECT snapshot FROM family_calendar_cache')).rows[0].snapshot.events[0].id, 'scheduled-only');
      const row = (await db.query('SELECT * FROM family_calendar_sync_jobs')).rows[0];
      assert.equal(row.next_attempt_at, null);
      assert.ok(row.last_successful_at);
      const next = await processCalendarSyncJobs(db, { env, now: new Date(now.getTime() + 301_000), sync: async () => snapshot('scheduled-again') });
      assert.equal(next.synced, 1);
    });

    await t.test('selection and disconnect clear jobs as well as snapshots', async () => {
      await selectCalendars(db, principal, { calendarIds: [] });
      assert.equal((await db.query('SELECT * FROM family_calendar_sync_jobs')).rowCount, 0);
      assert.equal((await calendarSnapshot(db, principal, from, to, { env })).status, 'not_configured');
      await removeCalendar(db, principal);
      assert.equal((await db.query('SELECT * FROM family_calendar_cache')).rowCount, 0);
    });
  } finally {
    if (created) { assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests'); await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    await pool.end();
  }
});
