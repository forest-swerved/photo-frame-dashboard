import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPool, transaction } from './database.js';
import { changeChore, createChore, householdSnapshot } from './household.js';
import { choreHistory, changeChoreOccurrence, createChoreException, ensureDailyOccurrences, getRequiredProgress, occurrenceDto,
  revokeChoreException, routineDetails, setOccurrenceCompletion, setRoutineCompletion } from './chore-occurrences.js';

const enabled = process.env.FAMILY_RUN_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('isolated PostgreSQL daily chore definitions, approvals and history', { skip: !enabled, timeout: 45_000 }, async t => {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Refusing chore test DDL on a remote database.');
  const pool = createPool(process.env, { migration: true, max: 10 });
  const schema = `family_chore_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  const now = new Date('2026-10-18T01:00:00Z'); // Saturday October 17 in Denver.
  const today = '2026-10-17'; const tomorrow = '2026-10-18';
  const household = { id: randomUUID(), timezone: 'America/Denver', title: 'Fixture household' };
  const parent = { authType: 'user', role: 'admin', actor: 'user:parent', user: { name: 'Test parent' }, household };
  const childA = { ...parent, authType: 'mobile', role: 'child', actor: 'mobile:child-a', user: { name: 'Test child A' }, personId: randomUUID() };
  const childB = { ...childA, actor: 'mobile:child-b', user: { name: 'Test child B' }, personId: randomUUID() };
  const frame = { ...parent, authType: 'frame', role: 'frame', actor: 'frame:test', user: null };
  const db = {
    async connect() { const client = await pool.connect(); try { await client.query(`SET search_path TO ${schema},pg_catalog`); return client; } catch (error) { client.release(); throw error; } },
    async query(sql, values) { const client = await this.connect(); try { return await client.query(sql, values); } finally { client.release(); } },
  };
  const routine = async (body = {}) => {
    const details = routineDetails(body);
    return (await db.query(`INSERT INTO family_chores(id,household_id,title,person_id,weekdays,due_time,required,instructions,subtasks,schedule_type,scheduled_date,requires_approval)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::date,$12) RETURNING *`,
    [randomUUID(), household.id, body.title || 'Fixture chore', body.personId || childA.personId, body.weekdays || [0, 1, 2, 3, 4, 5, 6], body.dueTime || '18:00',
      details.required, details.instructions, JSON.stringify(details.subtasks), details.scheduleType, details.scheduledDate, details.requiresApproval])).rows[0];
  };
  const daily = (date = today, time = now) => transaction(db, client => ensureDailyOccurrences(client, household, date, { now: time }));
  const completion = (actor, choreId, completed, expectedVersion = 0, body = {}) => setRoutineCompletion(db, actor, choreId, today,
    { completed, expectedVersion, mutationId: randomUUID(), ...body }, { now });
  const action = (actor, row, operation, body = {}) => changeChoreOccurrence(db, actor, row.id, { action: operation, expectedVersion: row.version, mutationId: randomUUID(), ...body }, { now });
  const reset = async () => {
    for (const name of ['family_notification_events', 'family_chore_events', 'family_chore_occurrences', 'family_mutations', 'family_completions', 'family_chore_exceptions', 'family_chores']) await db.query(`DELETE FROM ${name}`);
  };
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests');
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    for (const name of ['schema.sql', 'mobile-schema.sql', 'notifications-schema.sql', 'child-accounts-schema.sql', 'chore-schema.sql','school-schema.sql']) await db.query(await readFile(new URL(name, import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('chore-schema.sql', import.meta.url), 'utf8')); // Idempotent replay.
    await db.query('INSERT INTO family_households(id,title,timezone) VALUES($1,$2,$3)', [household.id, household.title, household.timezone]);
    for (const child of [childA, childB]) await db.query("INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,$3,'#00748c')", [child.personId, household.id, child.user.name]);

    await t.test('today follows household timezone and definitions survive routine edits', async () => {
      const chore = await routine({ weekdays: [6], title: 'Original title', subtasks: ['Clean bowl'], required: true });
      const first = (await daily())[0];
      assert.equal(first.date, today); assert.equal(first.person_id, childA.personId);
      await db.query("UPDATE family_chores SET title='Future title',person_id=$2,required=false,instructions='New routine',version=version+1 WHERE id=$1", [chore.id, childB.personId]);
      const second = (await daily())[0];
      assert.equal(second.id, first.id); assert.equal(second.title, 'Original title'); assert.equal(second.required, true); assert.equal(second.person_id, childA.personId);
      await assert.rejects(db.query("UPDATE family_chore_occurrences SET required=false WHERE id=$1", [first.id]), error => error.code === '23514');
      assert.equal((await daily(tomorrow, new Date('2026-10-18T18:00:00Z'))).length, 0, 'Saturday routine is absent Sunday.');
      assert.equal((await choreHistory(db, childA)).history[0].actorName, 'Daily routines');
    });

    await t.test('one-off chores appear once and future reads do not freeze routine definitions', async () => {
      await reset();
      const chore = await routine({ scheduleType: 'one_off', scheduledDate: tomorrow });
      assert.equal((await daily()).length, 0);
      assert.equal((await daily(tomorrow)).length, 0, 'Future reads return known facts without creating them.');
      const rows = await daily(tomorrow, new Date('2026-10-18T18:00:00Z'));
      assert.equal(rows.length, 1); assert.equal(rows[0].chore_id, chore.id);
      assert.equal((await daily('2026-10-19', new Date('2026-10-19T18:00:00Z'))).length, 0);
    });

    await t.test('household endpoints expose scoped frozen occurrences alongside editable routines', async () => {
      await reset();
      const created = await createChore(db, parent, { title: 'Family routine', personId: childA.personId, required: true,
        instructions: 'Use the blue bowl', subtasks: ['Clean bowl'], requiresApproval: true, dueTime: '18:00' });
      await createChore(db, parent, { title: 'Sibling work', personId: childB.personId, scheduleType: 'one_off', scheduledDate: today });
      const first = await householdSnapshot(db, childA, today, { now });
      assert.equal(first.people.length, 1); assert.equal(first.occurrences.length, 1); assert.equal(first.routines.length, 1);
      assert.equal(first.chores[0].instructions, 'Use the blue bowl');
      await changeChore(db, parent, created.id, { expectedVersion: 1, title: 'Changed for next day', required: false, requiresApproval: false });
      const second = await householdSnapshot(db, childA, today, { now });
      assert.equal(second.occurrences[0].title, 'Family routine'); assert.equal(second.occurrences[0].required, true);
      assert.equal(second.routines[0].title, 'Changed for next day'); assert.equal(second.routines[0].required, false);
      assert.equal(second.chores[0].completion.version, 0); assert.equal(second.chores[0].version, 2);
      const future = await householdSnapshot(db, childA, tomorrow, { now });
      assert.equal(future.occurrences.length, 0); assert.equal(future.routines.length, 1);
    });

    await t.test('children and frames cannot write future/history and unscheduled work is rejected', async () => {
      await reset();
      const own = await routine({ weekdays: [0] }); const sibling = await routine({ personId: childB.personId });
      const body = { completed: true, expectedVersion: 0, mutationId: randomUUID() };
      for (const actor of [childA, frame]) for (const date of ['2026-10-16', tomorrow]) {
        await assert.rejects(setRoutineCompletion(db, actor, own.id, date, { ...body, mutationId: randomUUID(), reason: 'Not authorized' }, { now }), error => error.status === 403);
      }
      await assert.rejects(completion(childA, own.id, true), error => error.status === 404);
      await assert.rejects(completion(childA, sibling.id, true), error => error.status === 404);
      assert.equal((await db.query('SELECT * FROM family_completions')).rowCount, 0);
      await assert.rejects(setRoutineCompletion(db, parent, sibling.id, '2026-10-16', body, { now }), error => error.status === 422);
      const correction = await setRoutineCompletion(db, parent, sibling.id, '2026-10-16', { ...body, reason: 'Recorded yesterday’s work' }, { now });
      assert.equal(correction.occurrence.definitionSource, 'parent_correction');
    });

    await t.test('completion CAS, replay and immutable actor history survive concurrent writes', async () => {
      await reset(); const chore = await routine();
      const body = { completed: true, expectedVersion: 0, mutationId: randomUUID() };
      const results = await Promise.all([0, 1].map(() => setRoutineCompletion(db, childA, chore.id, today, body, { now })));
      assert.deepEqual(results[0], results[1]); assert.equal(results[0].version, 1);
      await assert.rejects(setRoutineCompletion(db, { ...childA, personId: childB.personId }, chore.id, today, body, { now }), error => error.status === 404,
        'An account reassignment cannot replay a former profile’s receipt.');
      assert.equal((await db.query("SELECT * FROM family_chore_events WHERE type='completed'")).rowCount, 1);
      assert.equal((await db.query('SELECT * FROM family_notification_events')).rowCount, 1, 'Compatibility writer does not duplicate occurrence notification.');
      const races = await Promise.allSettled([0, 1].map(() => completion(childA, chore.id, false, 1)));
      assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(races.find(result => result.status === 'rejected').reason.code, 'version_conflict');
      const history = (await choreHistory(db, childA)).history;
      assert.ok(history.some(item => item.type === 'completed' && item.actorName === childA.user.name));
      assert.equal((await choreHistory(db, childB)).history.length, 0);
    });

    await t.test('approval-gated work emits submitted, earns nothing until approval, then supports rejection', async () => {
      await reset(); const chore = await routine({ requiresApproval: true });
      const submission = await completion(childA, chore.id, true);
      assert.equal(submission.occurrence.status, 'submitted');
      assert.equal((await db.query('SELECT type FROM family_notification_events')).rows[0].type, 'chore_submitted');
      let progress = await getRequiredProgress(db, household.id, childA.personId, today);
      assert.equal(progress.eligible, false); assert.equal(progress.pendingApprovalCount, 1);
      await assert.rejects(action(frame, submission.occurrence, 'approve'), error => error.status === 403);
      await assert.rejects(action(childA, submission.occurrence, 'approve'), error => error.status === 403);
      const approved = await action(parent, submission.occurrence, 'approve');
      assert.equal(approved.status, 'completed'); assert.ok(approved.approvedAt);
      progress = await getRequiredProgress(db, household.id, childA.personId, today); assert.equal(progress.eligible, true);
      assert.deepEqual((await db.query('SELECT type FROM family_notification_events ORDER BY occurred_at,id')).rows.map(row => row.type).sort(), ['chore_completed', 'chore_submitted']);
      await completion(childA, chore.id, false, approved.completion.version);
      const resubmitted = await completion(childA, chore.id, true, approved.completion.version + 1);
      const rejected = await action(parent, resubmitted.occurrence, 'reject', { reason: 'Please finish the second step' });
      assert.equal(rejected.status, 'pending'); assert.equal(rejected.completion.completed, false);
    });

    await t.test('subtask progress uses occurrence CAS and cannot mutate an approved definition', async () => {
      await reset(); const chore = await routine({ subtasks: ['Clean bowl', 'Fill bowl'] });
      const row = (await daily())[0]; const firstStep = row.subtask_definitions[0].id;
      const advanced = await action(childA, row, 'subtasks', { completedSubtaskIds: [firstStep] });
      assert.equal(advanced.subtasks[0].completed, true); assert.equal(advanced.subtasks[1].completed, false);
      await assert.rejects(action(childA, row, 'subtasks', { completedSubtaskIds: [] }), error => error.status === 409);
      const done = await setOccurrenceCompletion(db, childA, row.id, { completed: true, expectedVersion: advanced.version, mutationId: randomUUID() }, { now });
      assert.ok(done.subtasks.every(step => step.completed));
      await assert.rejects(action(childA, done, 'subtasks', { completedSubtaskIds: [] }), error => error.status === 409);
      assert.equal(done.choreId, chore.id);
    });

    await t.test('zero required work, optional work and all-skipped days cannot earn a reward', async () => {
      await reset(); await routine({ required: false }); await daily();
      let progress = await getRequiredProgress(db, household.id, childA.personId, today);
      assert.equal(progress.requiredCount, 0); assert.equal(progress.eligible, false);
      await reset(); await routine(); const rows = await daily();
      await action(parent, rows[0], 'skip', { reason: 'School holiday' });
      progress = await getRequiredProgress(db, household.id, childA.personId, today);
      assert.equal(progress.requiredCount, 0); assert.equal(progress.eligible, false);
    });

    await t.test('rescheduling retains identity and history without regenerating its original day', async () => {
      await reset(); await routine(); const row = (await daily())[0];
      const moved = await action(parent, row, 'reschedule', { toDate: tomorrow, dueTime: '20:00', reason: 'Family trip' });
      assert.equal(moved.id, row.id); assert.equal(moved.rescheduledFrom, today); assert.equal(moved.date, tomorrow);
      assert.equal((await daily()).length, 0);
      const nextDay = await daily(tomorrow, new Date('2026-10-18T18:00:00Z'));
      assert.equal(nextDay.length, 1); assert.equal(nextDay[0].id, row.id); assert.equal(nextDay[0].due_time.slice(0, 5), '20:00');
      assert.ok((await choreHistory(db, parent)).history.some(item => item.type === 'rescheduled' && item.reason === 'Family trip'));
    });

    await t.test('holiday breaks apply to pending work, preserve completed facts and revoke safely', async () => {
      await reset(); const done = await routine({ title: 'Already finished' }); const pending = await routine({ title: 'Not done' });
      await completion(childA, done.id, true);
      const exception = await createChoreException(db, parent, { fromDate: today, toDateExclusive: '2026-10-20', personId: childA.personId, reason: 'School holiday', mutationId: randomUUID() }, { now });
      assert.equal(exception.affectedCount, 1);
      const rows = await daily(); assert.equal(rows.find(row => row.chore_id === done.id).status, 'completed');
      assert.equal(rows.find(row => row.chore_id === pending.id).status, 'skipped');
      const future = await daily(tomorrow, new Date('2026-10-18T18:00:00Z'));
      assert.ok(future.every(row => row.status === 'skipped'));
      const revoked = await revokeChoreException(db, parent, exception.id, { expectedVersion: 1, mutationId: randomUUID(), reason: 'Back to school' }, { now });
      assert.ok(revoked.revokedAt);
      assert.equal((await daily()).find(row => row.chore_id === pending.id).status, 'pending');
      assert.equal((await daily()).find(row => row.chore_id === done.id).status, 'completed');
    });

    await t.test('completion hook is inside the shared day lock and rollback keeps all changes atomic', async () => {
      await reset(); const a = await routine(); const b = await routine();
      await db.query('CREATE TABLE fixture_rewards(person_id uuid,date date,PRIMARY KEY(person_id,date))');
      const hook = async client => {
        const progress = await getRequiredProgress(client, household.id, childA.personId, today);
        if (progress.eligible) await client.query('INSERT INTO fixture_rewards(person_id,date) VALUES($1,$2::date) ON CONFLICT DO NOTHING', [childA.personId, today]);
      };
      await Promise.all([a, b].map(chore => setRoutineCompletion(db, childA, chore.id, today, { completed: true, expectedVersion: 0, mutationId: randomUUID() }, { now, onChange: hook })));
      assert.equal((await db.query('SELECT * FROM fixture_rewards')).rowCount, 1);
      const c = await routine();
      await assert.rejects(setRoutineCompletion(db, childA, c.id, today, { completed: true, expectedVersion: 0, mutationId: randomUUID() }, { now, onChange: async () => { throw new Error('Synthetic ledger failure'); } }));
      assert.equal((await db.query('SELECT * FROM family_completions WHERE chore_id=$1', [c.id])).rowCount, 0);
      assert.equal((await db.query("SELECT * FROM family_chore_events WHERE occurrence_id IN (SELECT id FROM family_chore_occurrences WHERE chore_id=$1) AND type='completed'", [c.id])).rowCount, 0);
    });
  } finally {
    if (created) { assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'family_frame_tests'); await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    await pool.end();
  }
});
