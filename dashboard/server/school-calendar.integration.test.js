import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool, transaction } from './database.js';
import { createChore, changeChore, householdSnapshot } from './household.js';
import { changeChoreOccurrence, createChoreException, ensureDailyOccurrences, getRequiredProgress, setOccurrenceCompletion } from './chore-occurrences.js';
import { saveSchoolCalendar, schoolCalendarSnapshot } from './school-calendar.js';
import { schoolCalendarFixture } from './school-calendar-fixture.js';
import { syncChoreReward } from './internet.js';

const enabled = process.env.FAMILY_RUN_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('isolated TLS PostgreSQL school scheduling, overrides and earned-credit safety', { skip: !enabled, timeout: 60_000 }, async t => {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Refusing school scheduling test DDL on a remote database.');
  const pool = createPool(process.env, { migration: true, max: 8 }), schema = `family_school_test_${randomUUID().replaceAll('-', '')}`;
  const now = new Date('2026-10-20T18:00:00Z'), today = '2026-10-20';
  const household = { id: randomUUID(), timezone: 'America/Denver', title: 'Fixture household' };
  const personId = randomUUID(), siblingId = randomUUID();
  const parent = { authType: 'user', role: 'admin', actor: 'user:fixture-parent', household, user: { name: 'Fixture parent' } };
  const child = { ...parent, authType: 'mobile', role: 'child', personId, actor: 'mobile:fixture-child' };
  const caregiver = { ...parent, role: 'member', verifiedCapabilities: { manageChores: true } };
  const db = {
    async connect() { const c = await pool.connect(); try { await c.query(`SET search_path TO ${schema},pg_catalog`); return c; } catch (error) { c.release(); throw error; } },
    async query(sql, values) { const c = await this.connect(); try { return await c.query(sql, values); } finally { c.release(); } },
  };
  const snapshot = () => householdSnapshot(db, parent, today, { now });
  const progress = () => transaction(db, c => getRequiredProgress(c, household.id, personId, today));
  const onChange = (client, change) => syncChoreReward(client, change, { now });
  const chore = (filter = 'any', extra = {}) => createChore(db, parent, { title: `${filter} fixture`, personId, schoolDayFilter: filter, ...extra });
  const complete = row => setOccurrenceCompletion(db, child, row.id, { completed: true, expectedVersion: row.version, mutationId: randomUUID() }, { now, onChange });
  const override = async (type, date = today) => {
    const current = await schoolCalendarSnapshot(db, parent, today, { now });
    return saveSchoolCalendar(db, parent, { expectedVersion: current.calendar.version, override: { date, type, reason: type === null ? 'Return to district calendar' : type === 'school_day' ? 'Confirmed makeup school day' : 'Snow closure' } }, { override: true, now, onChange });
  };
  const reset = async ({ calendar = true } = {}) => {
    await db.query(`TRUNCATE family_school_calendars,family_chores,family_reward_credits,family_internet_events CASCADE`);
    if (calendar) await saveSchoolCalendar(db, parent, { expectedVersion: 0, calendar: schoolCalendarFixture() }, { now, onChange });
  };
  let created = false;
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests');
    assert.equal((await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl, true);
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    for (const name of ['schema.sql', 'mobile-schema.sql', 'notifications-schema.sql', 'child-accounts-schema.sql', 'chore-schema.sql', 'school-schema.sql', 'account-notifications-schema.sql', 'internet-schema.sql','family-notifications-schema.sql'])
      await db.query(await readFile(new URL(name, import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('school-schema.sql', import.meta.url), 'utf8'));
    await db.query('INSERT INTO family_households(id,title,timezone) VALUES($1,$2,$3)', [household.id, household.title, household.timezone]);
    for (const id of [personId, siblingId]) await db.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,'Fixture child','#00748c')", [id, household.id]);

    await t.test('weekly filters share the district classification while one-off dates and child scope remain explicit', async () => {
      await reset();
      const everyday = await chore(), school = await chore('school_day'), nonSchool = await chore('non_school_day');
      const once = await chore('any', { scheduleType: 'one_off', scheduledDate: today });
      await chore('school_day', { personId: siblingId });
      const state = await householdSnapshot(db, child, today, { now });
      assert.equal(state.schoolDay.type, 'school_day');
      assert.deepEqual(state.occurrences.map(o => o.choreId).sort(), [everyday.id, school.id, once.id].sort());
      assert.equal(state.routines.find(r => r.id === nonSchool.id).schoolDayFilter, 'non_school_day');
      assert.equal(state.people.length, 1);
      const future = await householdSnapshot(db, parent, '2026-10-24', { now });
      assert.equal(future.schoolDay.type, 'non_school_day'); assert.equal(future.occurrences.length, 0);
      const late = await householdSnapshot(db, parent, undefined, { now: new Date('2026-10-21T05:59:00Z') });
      assert.equal(late.date, today); assert.equal(late.schoolDay.date, today);
    });

    await t.test('unknown dates withhold school-specific work and cannot mint a false all-done credit', async () => {
      await reset({ calendar: false });
      const any = await chore(), specific = await chore('school_day');
      const state = await snapshot();
      assert.equal(state.schoolDay.type, 'unknown'); assert.equal(state.occurrences.length, 1);
      await complete(state.occurrences.find(o => o.choreId === any.id));
      assert.equal((await progress()).scheduleBlocked, true); assert.equal((await progress()).eligible, false);
      assert.equal((await db.query('SELECT * FROM family_reward_credits')).rowCount, 0);
      await saveSchoolCalendar(db, parent, { expectedVersion: 0, calendar: schoolCalendarFixture() }, { now, onChange });
      const imported = await snapshot();
      await complete(imported.occurrences.find(o => o.choreId === specific.id));
      assert.equal((await progress()).eligible, true); assert.equal((await db.query('SELECT * FROM family_reward_credits')).rowCount, 1);
    });

    await t.test('same-day overrides exchange pending sets and restore stable occurrence IDs without duplicate history', async () => {
      await reset();
      const school = await chore('school_day'), off = await chore('non_school_day');
      const first = (await snapshot()).occurrences.find(o => o.choreId === school.id);
      await override('non_school_day');
      let state = await snapshot();
      const excused = state.occurrences.find(o => o.choreId === school.id);
      assert.equal(excused.status, 'skipped'); assert.equal(excused.schoolExcused, true);
      assert.equal(state.occurrences.find(o => o.choreId === off.id).status, 'pending');
      await assert.rejects(complete(excused), error => error.status === 409);
      const historyCount = (await db.query('SELECT * FROM family_chore_events')).rowCount;
      await snapshot(); assert.equal((await db.query('SELECT * FROM family_chore_events')).rowCount, historyCount);
      await override(null);
      state = await snapshot();
      const restored = state.occurrences.find(o => o.choreId === school.id);
      assert.equal(restored.id, first.id); assert.equal(restored.status, 'pending'); assert.equal(restored.schoolExcused, false);
      assert.equal(state.occurrences.find(o => o.choreId === off.id).status, 'skipped');
      assert.equal((await db.query('SELECT * FROM family_school_calendars')).rowCount, 3);
    });

    await t.test('completed and submitted facts survive; wrong-set work cannot complete the new set or keep a credit available', async () => {
      await reset();
      const doneRoutine = await chore('school_day'), approvalRoutine = await chore('school_day', { requiresApproval: true }), offRoutine = await chore('non_school_day');
      let state = await snapshot();
      await complete(state.occurrences.find(o => o.choreId === doneRoutine.id));
      const submitted = await complete(state.occurrences.find(o => o.choreId === approvalRoutine.id));
      await changeChoreOccurrence(db, parent, submitted.id, { action: 'approve', expectedVersion: submitted.version, mutationId: randomUUID() }, { now, onChange });
      assert.equal((await db.query('SELECT status FROM family_reward_credits')).rows[0].status, 'available');
      const extraSubmitted = await chore('school_day', { requiresApproval: true });
      state = await snapshot(); await complete(state.occurrences.find(o => o.choreId === extraSubmitted.id));
      await override('non_school_day');
      state = await snapshot();
      assert.equal(state.occurrences.find(o => o.choreId === doneRoutine.id).status, 'completed');
      assert.equal(state.occurrences.find(o => o.choreId === extraSubmitted.id).status, 'submitted');
      assert.equal((await progress()).requiredCount, 1); assert.equal((await progress()).eligible, false);
      assert.equal((await db.query('SELECT status FROM family_reward_credits')).rows[0].status, 'held');
      await complete(state.occurrences.find(o => o.choreId === offRoutine.id));
      assert.equal((await progress()).eligible, true); assert.equal((await db.query('SELECT status FROM family_reward_credits')).rows[0].status, 'available');
    });

    await t.test('calendar changes respect chore breaks and explicit moves, while routine edits keep today frozen', async () => {
      await reset(); const school = await chore('school_day');
      let state = await snapshot(); const original = state.occurrences[0];
      await changeChore(db, parent, school.id, { expectedVersion: 1, schoolDayFilter: 'any' });
      assert.equal((await snapshot()).occurrences[0].schoolDayFilter, 'school_day');
      await override('non_school_day');
      await createChoreException(db, parent, { fromDate: today, toDateExclusive: '2026-10-21', reason: 'Family trip', mutationId: randomUUID() }, { now });
      await override(null);
      state = await snapshot(); assert.equal(state.occurrences[0].status, 'skipped'); assert.equal(state.occurrences[0].skipReason, 'Family trip');
      await reset(); await chore('school_day'); state = await snapshot();
      await changeChoreOccurrence(db, parent, state.occurrences[0].id, { action: 'reschedule', toDate: '2026-10-24', reason: 'Parent chose Saturday', expectedVersion: 1, mutationId: randomUUID() }, { now });
      const saturday = await householdSnapshot(db, parent, '2026-10-24', { now: new Date('2026-10-24T18:00:00Z') });
      assert.equal(saturday.schoolDay.type, 'non_school_day'); assert.equal(saturday.occurrences[0].status, 'pending');
      assert.equal((await transaction(db, c => getRequiredProgress(c, household.id, personId, '2026-10-24'))).requiredCount, 1);
      await assert.rejects(db.query("UPDATE family_chore_occurrences SET school_day_filter='any' WHERE id=$1", [saturday.occurrences[0].id]), error => error.code === '23514');
      assert.ok(original.id);
    });

    await t.test('before/after school sections are immutable daily facts and other schedules normalize to Tasks', async () => {
      await reset();
      const before = await chore('school_day', { taskSection: 'before_school' });
      const after = await chore('school_day', { taskSection: 'after_school' });
      const generic = await chore('any', { taskSection: 'after_school' });
      assert.equal(generic.taskSection, 'tasks');
      let state = await snapshot();
      assert.equal(state.occurrences.find(o => o.choreId === before.id).taskSection, 'before_school');
      assert.equal(state.chores.find(o => o.id === after.id).taskSection, 'after_school');
      await changeChore(db, parent, before.id, { expectedVersion: 1, taskSection: 'after_school' });
      state = await snapshot();
      assert.equal(state.occurrences.find(o => o.choreId === before.id).taskSection, 'before_school');
      assert.equal(state.routines.find(o => o.id === before.id).taskSection, 'after_school');
      await assert.rejects(db.query("UPDATE family_chore_occurrences SET task_section='tasks' WHERE id=$1", [state.occurrences.find(o => o.choreId === before.id).id]), error => error.code === '23514');
      const next = await householdSnapshot(db, parent, '2026-10-21', { now: new Date('2026-10-21T18:00:00Z') });
      assert.equal(next.occurrences.find(o => o.choreId === before.id).taskSection, 'after_school');
    });

    await t.test('an explicit same-day deadline edit and a move back to the original date stay exempt from automatic day filtering', async () => {
      await reset(); await chore('school_day');
      let item = (await snapshot()).occurrences[0];
      item = await changeChoreOccurrence(db, parent, item.id, { action: 'reschedule', toDate: today, dueTime: '20:00', reason: 'Parent explicitly wants this today', expectedVersion: item.version, mutationId: randomUUID() }, { now });
      assert.equal(item.schoolScheduleExempt, true);
      await override('non_school_day');
      item = (await snapshot()).occurrences[0];
      assert.equal(item.status, 'pending'); assert.equal((await progress()).requiredCount, 1);
      await complete(item); assert.equal((await progress()).eligible, true);

      await reset(); await chore('school_day'); item = (await snapshot()).occurrences[0];
      item = await changeChoreOccurrence(db, parent, item.id, { action: 'reschedule', toDate: '2026-10-24', reason: 'Move to Saturday', expectedVersion: item.version, mutationId: randomUUID() }, { now });
      item = await changeChoreOccurrence(db, parent, item.id, { action: 'reschedule', toDate: today, reason: 'Bring back to today', expectedVersion: item.version, mutationId: randomUUID() }, { now });
      await override('non_school_day');
      const returned = (await snapshot()).occurrences[0];
      assert.equal(returned.schoolScheduleExempt, true); assert.equal(returned.status, 'pending');
    });

    await t.test('importing next year early does not change this year’s viewer, overrides or automatic classification', async () => {
      await reset();
      const nextYear = { ...schoolCalendarFixture(), title: 'Next school year', coverageStart: '2027-07-01', coverageEndExclusive: '2028-07-01', termStart: '2027-08-19', termEndExclusive: '2028-05-27', closures: [] };
      await saveSchoolCalendar(db, parent, { expectedVersion: 1, calendar: nextYear }, { now });
      let current = await schoolCalendarSnapshot(db, parent, today, { now });
      assert.equal(current.calendar.coverageStart, '2026-07-01'); assert.equal(current.calendar.version, 1); assert.equal(current.latestVersion, 2);
      const updated = await saveSchoolCalendar(db, parent, { expectedVersion: 1, override: { date: today, type: 'non_school_day', reason: 'This year snow day' } }, { override: true, now });
      assert.equal(updated.calendar.version, 3); assert.equal(updated.schoolDay.type, 'non_school_day');
      const future = await schoolCalendarSnapshot(db, parent, '2027-10-20', { now });
      assert.equal(future.calendar.version, 2); assert.equal(future.schoolDay.type, 'school_day');
      const futureUpdated = await saveSchoolCalendar(db, parent, { expectedVersion: 2, override: { date: '2027-10-20', type: 'non_school_day', reason: 'Next year day off' } }, { override: true, now });
      assert.equal(futureUpdated.calendar.version, 4); assert.equal(futureUpdated.calendar.coverageStart, '2027-07-01'); assert.equal(futureUpdated.schoolDay.date, '2027-10-20');
      current = await schoolCalendarSnapshot(db, parent, today, { now });
      assert.equal(current.calendar.version, 3); assert.equal(current.schoolDay.reason, 'This year snow day');
      await assert.rejects(saveSchoolCalendar(db, parent, { expectedVersion: 1, override: { date: today, type: null, reason: 'Stale editor' } }, { override: true, now }), error => error.status === 409);
    });

    await t.test('CAS, permissions, migrations and school/day lock ordering hold under concurrent reads and edits', async () => {
      await reset(); await chore('school_day'); await chore('non_school_day');
      const current = await schoolCalendarSnapshot(db, parent, today, { now });
      await assert.rejects(saveSchoolCalendar(db, child, { expectedVersion: current.calendar.version, calendar: schoolCalendarFixture() }, { now }), error => error.status === 403);
      await assert.rejects(saveSchoolCalendar(db, { ...parent, role: 'member' }, { expectedVersion: current.calendar.version, calendar: schoolCalendarFixture() }, { now }), error => error.status === 403);
      await saveSchoolCalendar(db, caregiver, { expectedVersion: current.calendar.version, override: { date: '2027-02-12', type: 'non_school_day', reason: 'Possible day remains no school' } }, { override: true, now });
      await assert.rejects(saveSchoolCalendar(db, parent, { expectedVersion: current.calendar.version, calendar: schoolCalendarFixture() }, { now }), error => error.status === 409);
      const beforePastAttempt = await schoolCalendarSnapshot(db, parent, today, { now });
      await assert.rejects(saveSchoolCalendar(db, parent, { expectedVersion: beforePastAttempt.calendar.version,
        override: { date: '2026-10-19', type: 'non_school_day', reason: 'Do not change yesterday' } }, { override: true, now }),
      error => error.status === 422 && error.code === 'past_school_override');
      assert.equal((await schoolCalendarSnapshot(db, parent, today, { now })).calendar.version, beforePastAttempt.calendar.version);
      for (let i = 0; i < 3; i++) await Promise.all([snapshot(), override(i % 2 ? 'school_day' : 'non_school_day'), transaction(db, async c => {
        const { lockChoreDay } = await import('./chore-occurrences.js');
        await lockChoreDay(c, household.id, today); return ensureDailyOccurrences(c, household, today, { now });
      })]);
      const privileges = (await db.query(`SELECT relrowsecurity,NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(relacl,acldefault('r',relowner))) a WHERE a.grantee=0) AS public_revoked FROM pg_class WHERE oid='family_school_calendars'::regclass`)).rows[0];
      assert.equal(privileges.relrowsecurity, true); assert.equal(privileges.public_revoked, true);
    });
  } finally {
    if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  }
});
