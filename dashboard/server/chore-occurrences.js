import { randomUUID } from 'node:crypto';
import { ApiError, dateField, householdDate, requireValue, textField, uuidField, versionField } from './errors.js';
import { requireHousehold } from './auth.js';
import { requireChoreManager as requireAdmin } from './capabilities.js';
import { digest } from './credentials.js';
import { one, transaction } from './database.js';
import { lockSchoolCalendar, routineSchoolMatches, schoolDayFilter, schoolDayForDate } from './school-calendar.js';

const notFound = () => new ApiError(404, 'not_found', 'That task does not exist in this household.');
const plainDate = row => row?.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row?.date || '').slice(0, 10);
const dateOf = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
const instant = value => value ? new Date(value).toISOString() : null;
const completed = row => ['submitted', 'completed'].includes(row.status);
const stateForEvent = row => ({ status: row.status, date: plainDate(row), dueTime: row.due_time?.slice(0, 5) || null,
  version: row.version, completionVersion: row.completion_version, completedSubtaskIds: row.completed_subtask_ids || [], skipReason: row.skip_reason || null,
  schoolScheduleExempt: row.school_schedule_exempt || false });

export function routineDetails(body, current = {}) {
  const required = body.required === undefined ? current.required ?? true : body.required;
  const requiresApproval = body.requiresApproval === undefined ? current.requires_approval ?? false : body.requiresApproval;
  requireValue(typeof required === 'boolean' && typeof requiresApproval === 'boolean', 422, 'invalid_chore', 'Required and parent approval settings must be true or false.');
  const instructions = body.instructions === undefined ? current.instructions || '' : body.instructions;
  requireValue(typeof instructions === 'string' && instructions.length <= 3000, 422, 'invalid_chore', 'Instructions may contain at most 3000 characters.');
  let subtasks = body.subtasks === undefined ? current.subtasks || [] : body.subtasks;
  requireValue(Array.isArray(subtasks) && subtasks.length <= 20, 422, 'invalid_subtasks', 'Add at most 20 task steps.');
  subtasks = subtasks.map(item => typeof item === 'string' ? { id: randomUUID(), title: textField(item, 'Step', 160) }
    : { id: uuidField(item?.id, 'Step ID'), title: textField(item?.title, 'Step', 160) });
  requireValue(new Set(subtasks.map(item => item.id)).size === subtasks.length, 422, 'invalid_subtasks', 'Each step must have its own ID.');
  const scheduleType = body.scheduleType ?? current.schedule_type ?? 'weekly';
  requireValue(['weekly', 'one_off'].includes(scheduleType), 422, 'invalid_schedule', 'Choose weekly or one-off scheduling.');
  const scheduledDate = scheduleType === 'one_off' ? dateField(body.scheduledDate === undefined ? current.scheduled_date && dateOf(current.scheduled_date) : body.scheduledDate) : null;
  requireValue(scheduleType !== 'weekly' || body.scheduledDate === undefined || body.scheduledDate === null,
    422, 'invalid_schedule', 'A weekly task cannot have a one-off date.');
  const schoolFilter = schoolDayFilter(body.schoolDayFilter === undefined ? scheduleType === 'one_off' ? 'any' : current.school_day_filter ?? 'any' : body.schoolDayFilter);
  requireValue(scheduleType !== 'one_off' || schoolFilter === 'any', 422, 'invalid_school_filter', 'One-off tasks use their chosen date. Use a repeating routine for school-day filtering.');
  const taskSection = body.taskSection === undefined ? current.task_section ?? 'tasks' : body.taskSection;
  requireValue(['tasks', 'before_school', 'after_school'].includes(taskSection), 422, 'invalid_task_section', 'Choose Tasks, Before school, or After school.');
  return { required, requiresApproval, instructions: instructions.trim(), subtasks, scheduleType, scheduledDate, schoolDayFilter: schoolFilter,
    taskSection: scheduleType === 'weekly' && schoolFilter === 'school_day' ? taskSection : 'tasks' };
}

export function occurrenceDto(row) {
  const checked = new Set(row.completed_subtask_ids || []);
  const date = plainDate(row);
  const originalDate = dateOf(row.original_date);
  return { id: row.id, choreId: row.chore_id, date, originalDate, title: row.title, personId: row.person_id || null,
    personName: row.person_name || null, required: row.required, instructions: row.instructions || '',
    subtasks: (row.subtask_definitions || []).map(item => ({ id: item.id, title: item.title, completed: checked.has(item.id) })),
    requiresApproval: row.requires_approval, status: row.status, version: row.version,
    completion: { date, completed: completed(row), version: row.completion_version, updatedAt: instant(row.updated_at) },
    dueTime: row.due_time?.slice(0, 5) || null, reminderMinutes: row.reminder_minutes,
    skipReason: row.skip_reason || null, rescheduledFrom: date === originalDate ? null : originalDate,
    completedAt: instant(row.completed_at), approvedAt: instant(row.approved_at),
    schoolDayFilter: row.school_day_filter || 'any', schoolExcused: row.school_excused || false, schoolScheduleExempt: row.school_schedule_exempt || false,
    taskSection: row.task_section || 'tasks',
    definitionSource: row.definition_source, routineVersion: row.routine_version, createdAt: instant(row.created_at), updatedAt: instant(row.updated_at) };
}

// Caller must already be in a transaction. All work/credit mutations use this
// same household-local date lock before occurrence locks. It is intentionally
// broader than one child, preventing two completions from minting independently.
export async function lockChoreDay(client, householdId, date) {
  // Every chore/reward writer takes the calendar lock first, including writers
  // that do not materialize routines. Calendar edits take this same order.
  await lockSchoolCalendar(client, householdId);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`chores:${householdId}:${date}`]);
}

export function requireChoreWriteDate(principal, date, reason, now = new Date()) {
  const today = householdDate(principal.household.timezone, now);
  if (date !== today) {
    requireAdmin(principal);
    return textField(reason, 'Reason for correcting another day', 500);
  }
  return reason === undefined || reason === null || reason === '' ? null : textField(reason, 'Reason', 500);
}

async function appendEvent(client, principal, row, type, before = null, reason = null, now = new Date()) {
  const actorName = String(principal.user?.name || (principal.role === 'frame' ? 'Family frame' : principal.actor?.startsWith('system:') ? 'Daily routines' : 'Family member')).slice(0, 120);
  await client.query(`INSERT INTO family_chore_events(id,household_id,occurrence_id,type,actor,actor_name,reason,before_state,after_state,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
  [randomUUID(), row.household_id, row.id, type, principal.actor || 'system:daily-routines', actorName, reason, before ? JSON.stringify(stateForEvent(before)) : null, JSON.stringify(stateForEvent(row)), now]);
}

async function reconcileSchoolOccurrences(client, household, date, schoolDay, now) {
  // Reclassifying today may excuse or restore untouched work. Completed,
  // submitted, explicitly moved and parent-corrected facts remain intact.
  const rows = (await client.query(`SELECT *,date::text,original_date::text FROM family_chore_occurrences
    WHERE household_id=$1 AND date=$2::date AND original_date=date AND definition_source='routine' AND NOT school_schedule_exempt AND school_day_filter<>'any'
      AND (status='pending' OR (status='skipped' AND school_excused)) ORDER BY id FOR UPDATE`, [household.id, date])).rows;
  const exceptions = rows.length ? (await client.query(`SELECT * FROM family_chore_exceptions
    WHERE household_id=$1 AND from_date<=$2::date AND to_date>$2::date AND revoked_at IS NULL ORDER BY created_at,id`, [household.id, date])).rows : [];
  for (const row of rows) {
    const matches = routineSchoolMatches(row.school_day_filter, schoolDay);
    if (row.status === 'pending' && matches || row.school_excused && !matches) continue;
    const exception = matches ? exceptions.find(item => (!item.chore_id || item.chore_id === row.chore_id) && (!item.person_id || item.person_id === row.person_id)) : null;
    const status = matches && !exception ? 'pending' : 'skipped';
    const reason = !matches ? `School schedule: ${schoolDay.reason}` : exception?.reason || 'The school schedule now includes this task.';
    const updated = await one(client, `UPDATE family_chore_occurrences SET status=$3,school_excused=$4,skip_reason=$5,exception_id=$6,
      version=version+1,updated_at=$7 WHERE household_id=$1 AND id=$2 RETURNING *,date::text,original_date::text`,
    [household.id, row.id, status, !matches, status === 'skipped' ? reason : null, exception?.id || null, now]);
    await appendEvent(client, { household, actor: 'system:school-calendar' }, updated, 'school_schedule_changed', row, reason, now);
  }
}

export async function ensureDailyOccurrences(client, household, date, { now = new Date(), allowCorrection = false, reason = null } = {}) {
  dateField(date);
  const today = householdDate(household.timezone, now);
  if (date !== today && !allowCorrection) return (await client.query('SELECT *,date::text,original_date::text FROM family_chore_occurrences WHERE household_id=$1 AND date=$2::date ORDER BY created_at,id', [household.id, date])).rows;
  if (date !== today) textField(reason, 'Reason for correcting another day', 500);
  await lockChoreDay(client, household.id, date);
  const schoolDay = await schoolDayForDate(client, household.id, date);
  await reconcileSchoolOccurrences(client, household, date, schoolDay, now);
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const routines = (await client.query(`SELECT c.*,p.name AS person_name FROM family_chores c LEFT JOIN family_people p ON p.household_id=c.household_id AND p.id=c.person_id
    WHERE c.household_id=$1 AND c.deleted_at IS NULL AND ((c.schedule_type='weekly' AND $2::smallint=ANY(c.weekdays)) OR (c.schedule_type='one_off' AND c.scheduled_date=$3::date))
      AND (c.school_day_filter='any' OR c.school_day_filter=$4)
      AND NOT EXISTS(SELECT 1 FROM family_chore_occurrences existing WHERE existing.household_id=c.household_id AND existing.chore_id=c.id
        AND (existing.original_date=$3::date OR existing.date=$3::date))
    ORDER BY c.created_at,c.id LIMIT 501 FOR SHARE OF c`, [household.id, day, date, schoolDay.type])).rows;
  requireValue(routines.length <= 500, 503, 'chore_limit', 'Too many routines are scheduled for this day.');
  const exceptions = routines.length ? (await client.query(`SELECT * FROM family_chore_exceptions WHERE household_id=$1 AND from_date<=$2::date AND to_date>$2::date AND revoked_at IS NULL ORDER BY created_at,id`, [household.id, date])).rows : [];
  if (routines.length) {
    const definitions = routines.map(routine => {
      const exception = exceptions.find(item => (!item.chore_id || item.chore_id === routine.id) && (!item.person_id || item.person_id === routine.person_id));
      return { chore_id: routine.id, routine_version: routine.version, title: routine.title, person_id: routine.person_id,
        person_name: routine.person_name, required: routine.required, instructions: routine.instructions,
        subtask_definitions: routine.subtasks, requires_approval: routine.requires_approval, due_time: routine.due_time,
        reminder_minutes: routine.reminder_minutes, school_day_filter: routine.school_day_filter, task_section: routine.task_section,
        status: exception ? 'skipped' : 'pending', skip_reason: exception?.reason || null, exception_id: exception?.id || null };
    });
    const inserted = (await client.query(`INSERT INTO family_chore_occurrences(household_id,chore_id,original_date,date,routine_version,definition_source,title,person_id,person_name,required,instructions,
      subtask_definitions,requires_approval,original_due_time,due_time,reminder_minutes,school_day_filter,task_section,status,skip_reason,exception_id,created_at,updated_at)
      SELECT $1,x.chore_id,$2::date,$2::date,x.routine_version,$3,x.title,x.person_id,x.person_name,x.required,x.instructions,
        x.subtask_definitions,x.requires_approval,x.due_time,x.due_time,x.reminder_minutes,x.school_day_filter,x.task_section,x.status,x.skip_reason,x.exception_id,$5,$5
      FROM jsonb_to_recordset($4::jsonb) AS x(chore_id uuid,routine_version integer,title text,person_id uuid,person_name text,required boolean,instructions text,
        subtask_definitions jsonb,requires_approval boolean,due_time time,reminder_minutes smallint,school_day_filter text,task_section text,status text,skip_reason text,exception_id uuid)
      ON CONFLICT(household_id,chore_id,original_date) DO NOTHING RETURNING *,date::text,original_date::text`,
    [household.id, date, date === today ? 'routine' : 'parent_correction', JSON.stringify(definitions), now])).rows;
    if (inserted.length) await client.query(`INSERT INTO family_chore_events(id,household_id,occurrence_id,type,actor,actor_name,reason,after_state,created_at)
      SELECT x.id,$1,x.occurrence_id,'created','system:daily-routines','Daily routines',x.reason,x.after_state,$2
      FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,occurrence_id uuid,reason text,after_state jsonb)`,
    [household.id, now, JSON.stringify(inserted.map(row => ({ id: randomUUID(), occurrence_id: row.id, reason: row.skip_reason || reason, after_state: stateForEvent(row) })))]);
  }
  return (await client.query('SELECT *,date::text,original_date::text FROM family_chore_occurrences WHERE household_id=$1 AND date=$2::date ORDER BY created_at,id', [household.id, date])).rows;
}

export async function getRequiredProgress(client, householdId, personId, date) {
  uuidField(personId, 'Child profile'); dateField(date);
  const schoolDay = await schoolDayForDate(client, householdId, date);
  const rows = (await client.query("SELECT id,status,required,school_day_filter,school_schedule_exempt,school_excused,date::text,original_date::text,definition_source FROM family_chore_occurrences WHERE household_id=$1 AND person_id=$2 AND date=$3::date ORDER BY id", [householdId, personId, date])).rows;
  const required = rows.filter(row => row.required && row.status !== 'skipped' && (row.school_schedule_exempt || row.date !== row.original_date || row.definition_source === 'parent_correction' || routineSchoolMatches(row.school_day_filter, schoolDay)));
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const blocked = schoolDay.type === 'unknown' && (rows.some(row => row.required && row.school_day_filter !== 'any' && (row.status !== 'skipped' || row.school_excused) && !row.school_schedule_exempt && row.date === row.original_date && row.definition_source !== 'parent_correction')
    || Boolean(await one(client, `SELECT id FROM family_chores WHERE household_id=$1 AND person_id=$2
    AND deleted_at IS NULL AND required AND schedule_type='weekly' AND school_day_filter<>'any' AND $3::smallint=ANY(weekdays) LIMIT 1`, [householdId, personId, weekday])));
  const completedCount = required.filter(row => row.status === 'completed').length;
  const pendingApprovalCount = required.filter(row => row.status === 'submitted').length;
  return { personId, date, requiredCount: required.length, completedCount, pendingApprovalCount,
    remainingCount: required.length - completedCount, eligible: !blocked && required.length > 0 && completedCount === required.length, scheduleBlocked: blocked,
    occurrenceIds: required.map(row => row.id) };
}

async function replayMutation(client, householdId, principal, mutationId, requestHash) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mutation:${householdId}:${principal.actor}:${mutationId}`]);
  const replay = await one(client, 'SELECT request_hash,response FROM family_mutations WHERE household_id=$1 AND actor=$2 AND mutation_id=$3', [householdId, principal.actor, mutationId]);
  if (!replay) return null;
  requireValue(replay.request_hash === requestHash, 409, 'mutation_reused', 'Use a new mutation ID for a different change.');
  if (principal.role === 'child') {
    let personId = replay.response.occurrence?.personId ?? replay.response.personId;
    // Older receipts predate the occurrence DTO. Recheck current scope instead
    // of allowing a reassigned account to read a previous child's receipt.
    if (!personId && replay.response.choreId) {
      const current = await one(client, `SELECT person_id FROM family_chore_occurrences WHERE household_id=$1 AND chore_id=$2 AND date=$3::date
        UNION ALL SELECT person_id FROM family_chores WHERE household_id=$1 AND id=$2 LIMIT 1`, [householdId, replay.response.choreId, replay.response.date]);
      personId = current?.person_id;
    }
    if (personId !== principal.personId) throw notFound();
  }
  return replay.response;
}

async function rememberMutation(client, householdId, principal, mutationId, hash, response) {
  await client.query('INSERT INTO family_mutations(household_id,actor,mutation_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)', [householdId, principal.actor, mutationId, hash, JSON.stringify(response)]);
  return response;
}

async function writeLegacyCompletion(client, row, principal, now) {
  await client.query(`INSERT INTO family_completions(household_id,chore_id,date,completed,version,actor,updated_at) VALUES($1,$2,$3::date,$4,$5,$6,$7)
    ON CONFLICT(household_id,chore_id,date) DO UPDATE SET completed=EXCLUDED.completed,version=EXCLUDED.version,actor=EXCLUDED.actor,updated_at=EXCLUDED.updated_at`,
  [row.household_id, row.chore_id, plainDate(row), completed(row), row.completion_version, principal.actor, now]);
}

async function applyCompletion(client, principal, row, body, expectedKind, now, onChange) {
  if (principal.role === 'child' && row.person_id !== principal.personId) throw notFound();
  const current = occurrenceDto(row);
  requireValue((expectedKind === 'occurrence' ? row.version : row.completion_version) === body.expectedVersion,
    409, 'version_conflict', 'This task was changed on another screen.', { current: expectedKind === 'occurrence' ? current : { choreId: row.chore_id, ...current.completion } });
  requireValue(row.status !== 'skipped', 409, 'chore_skipped', 'A parent has excused this task for this day.');
  if (body.completed && row.status === 'pending' && row.school_day_filter !== 'any' && !row.school_schedule_exempt && plainDate(row) === dateOf(row.original_date) && row.definition_source === 'routine')
    requireValue(routineSchoolMatches(row.school_day_filter, await schoolDayForDate(client, row.household_id, plainDate(row))),
      409, 'school_schedule_changed', 'The school schedule changed. Refresh to see the tasks for this day.');
  const status = body.completed ? row.requires_approval && principal.role !== 'admin' && !principal.verifiedCapabilities?.manageChores ? 'submitted' : 'completed' : 'pending';
  // Retrying an already completed approval never demotes it back to submitted.
  if (body.completed === completed(row)) return row;
  const updated = await one(client, `UPDATE family_chore_occurrences SET status=$3,version=version+1,completion_version=completion_version+1,
    completed_at=$4,completed_by=$5,approved_at=$6,approved_by=$7,updated_at=$8,
    completed_subtask_ids=CASE WHEN $9 THEN $10::jsonb ELSE completed_subtask_ids END WHERE household_id=$1 AND id=$2 RETURNING *,date::text,original_date::text`,
  [row.household_id, row.id, status, body.completed ? now : null, body.completed ? principal.actor : null,
    status === 'completed' ? now : null, status === 'completed' ? principal.actor : null, now, body.completed, JSON.stringify((row.subtask_definitions || []).map(item => item.id))]);
  await writeLegacyCompletion(client, updated, principal, now);
  await appendEvent(client, principal, updated, status === 'submitted' ? 'submitted' : body.completed ? 'completed' : 'reopened', row, body.reason || null, now);
  if (onChange) await onChange(client, { householdId: row.household_id, personId: row.person_id, date: plainDate(row), occurrenceId: row.id, status, actor: principal.actor });
  return updated;
}

// Compatible completion endpoint: expectedVersion is the legacy completion CAS
// version. Occurrence endpoints below use the full occurrence version instead.
export async function setRoutineCompletion(db, principal, choreId, date, body, { now = new Date(), onChange } = {}) {
  const householdId = requireHousehold(principal);
  uuidField(choreId); dateField(date); uuidField(body.mutationId, 'Mutation ID'); versionField(body.expectedVersion);
  requireValue(typeof body.completed === 'boolean', 422, 'invalid_completion', 'Send the desired completed state.');
  const reason = requireChoreWriteDate(principal, date, body.reason, now);
  const hash = digest(JSON.stringify({ choreId, date, completed: body.completed, expectedVersion: body.expectedVersion, ...(reason ? { reason } : {}) }));
  return transaction(db, async client => {
    const replay = await replayMutation(client, householdId, principal, body.mutationId, hash);
    if (replay) return replay;
    // Resolve/authorize before materializing other work. A sibling's valid UUID
    // must not cause any completion, mutation, or daily-occurrence writes.
    const candidate = await one(client, `SELECT c.id FROM family_chores c WHERE c.id=$1 AND c.household_id=$2
      AND ($3::uuid IS NULL OR c.person_id=$3 OR EXISTS(SELECT 1 FROM family_chore_occurrences o WHERE o.household_id=c.household_id AND o.chore_id=c.id AND o.date=$4::date AND o.person_id=$3)) FOR SHARE`,
    [choreId, householdId, principal.role === 'child' ? principal.personId : null, date]);
    if (!candidate) throw notFound();
    await ensureDailyOccurrences(client, principal.household, date, { now, allowCorrection: (principal.role === 'admin' || principal.verifiedCapabilities?.manageChores) && date !== householdDate(principal.household.timezone, now), reason });
    await lockChoreDay(client, householdId, date);
    const row = await one(client, `SELECT *,date::text,original_date::text FROM family_chore_occurrences WHERE household_id=$1 AND chore_id=$2 AND date=$3::date AND status<>'skipped' FOR UPDATE`, [householdId, choreId, date]);
    if (!row) throw notFound();
    const updated = await applyCompletion(client, principal, row, { ...body, reason }, 'completion', now, onChange);
    const dto = occurrenceDto(updated);
    return rememberMutation(client, householdId, principal, body.mutationId, hash, { choreId, ...dto.completion, mutationId: body.mutationId, occurrence: dto });
  });
}

export async function setOccurrenceCompletion(db, principal, id, body, { now = new Date(), onChange } = {}) {
  const householdId = requireHousehold(principal);
  uuidField(id); uuidField(body.mutationId, 'Mutation ID'); versionField(body.expectedVersion);
  requireValue(typeof body.completed === 'boolean', 422, 'invalid_completion', 'Send the desired completed state.');
  const reason = body.reason === undefined || body.reason === null || body.reason === '' ? null : textField(body.reason, 'Reason', 500);
  const hash = digest(JSON.stringify({ operation: 'occurrence-completion', id, completed: body.completed, expectedVersion: body.expectedVersion, reason }));
  return transaction(db, async client => {
    const replay = await replayMutation(client, householdId, principal, body.mutationId, hash); if (replay) return replay;
    const candidate = await one(client, `SELECT date::text,person_id FROM family_chore_occurrences WHERE household_id=$1 AND id=$2 AND ($3::uuid IS NULL OR person_id=$3)`, [householdId, id, principal.role === 'child' ? principal.personId : null]);
    if (!candidate) throw notFound();
    requireChoreWriteDate(principal, candidate.date, reason, now);
    await lockChoreDay(client, householdId, candidate.date);
    const row = await one(client, 'SELECT *,date::text,original_date::text FROM family_chore_occurrences WHERE household_id=$1 AND id=$2 FOR UPDATE', [householdId, id]);
    requireValue(row.date === candidate.date, 409, 'version_conflict', 'This task moved. Refresh the day.');
    const updated = await applyCompletion(client, principal, row, { ...body, reason }, 'occurrence', now, onChange);
    return rememberMutation(client, householdId, principal, body.mutationId, hash, { ...occurrenceDto(updated), mutationId: body.mutationId });
  });
}

export async function changeChoreOccurrence(db, principal, id, body, { now = new Date(), onChange } = {}) {
  const householdId = requireHousehold(principal); uuidField(id); uuidField(body.mutationId, 'Mutation ID'); versionField(body.expectedVersion);
  const action = body.action;
  requireValue(['approve', 'reject', 'skip', 'reschedule', 'subtasks'].includes(action), 422, 'invalid_occurrence_action', 'Choose a supported task action.');
  if (action !== 'subtasks') requireAdmin(principal);
  const reason = ['skip', 'reschedule', 'reject'].includes(action) ? textField(body.reason, 'Reason', 500) : body.reason ? textField(body.reason, 'Reason', 500) : null;
  const toDate = action === 'reschedule' ? dateField(body.toDate) : null;
  const hash = digest(JSON.stringify({ operation: 'occurrence-action', id, action, expectedVersion: body.expectedVersion, reason,
    toDate, dueTime: body.dueTime, completedSubtaskIds: Array.isArray(body.completedSubtaskIds) ? [...new Set(body.completedSubtaskIds)].sort() : body.completedSubtaskIds }));
  return transaction(db, async client => {
    const replay = await replayMutation(client, householdId, principal, body.mutationId, hash); if (replay) return replay;
    const candidate = await one(client, `SELECT date::text FROM family_chore_occurrences WHERE household_id=$1 AND id=$2 AND ($3::uuid IS NULL OR person_id=$3)`, [householdId, id, principal.role === 'child' ? principal.personId : null]);
    if (!candidate) throw notFound();
    requireChoreWriteDate(principal, candidate.date, reason, now);
    for (const date of [...new Set([candidate.date, toDate].filter(Boolean))].sort()) await lockChoreDay(client, householdId, date);
    const row = await one(client, 'SELECT *,date::text,original_date::text FROM family_chore_occurrences WHERE household_id=$1 AND id=$2 FOR UPDATE', [householdId, id]);
    if (principal.role === 'child' && row.person_id !== principal.personId) throw notFound();
    requireValue(row.date === candidate.date && row.version === body.expectedVersion, 409, 'version_conflict', 'This task changed. Refresh and try again.', { current: occurrenceDto(row) });
    let status = row.status, dueTime = row.due_time, checked = row.completed_subtask_ids;
    if (action === 'approve') { requireValue(status === 'submitted', 409, 'approval_not_pending', 'This task is not waiting for approval.'); status = 'completed'; }
    if (action === 'reject') { requireValue(status === 'submitted', 409, 'approval_not_pending', 'This task is not waiting for approval.'); status = 'pending'; }
    if (action === 'skip') { requireValue(status === 'pending', 409, 'chore_not_pending', 'Reopen this task before excusing it.'); status = 'skipped'; }
    if (action === 'reschedule') {
      requireValue(status === 'pending', 409, 'chore_not_pending', 'Reopen this task before moving it.');
      const collision = await one(client, "SELECT id FROM family_chore_occurrences WHERE household_id=$1 AND chore_id=$2 AND date=$3::date AND status<>'skipped' AND id<>$4", [householdId, row.chore_id, toDate, id]);
      requireValue(!collision, 409, 'chore_date_occupied', 'This routine already has work on that day. Choose another day.');
      if (body.dueTime !== undefined) {
        requireValue(body.dueTime === null || typeof body.dueTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.dueTime), 422, 'invalid_due_time', 'Choose a valid due time.');
        dueTime = body.dueTime;
      }
    }
    if (action === 'subtasks') {
      requireValue(status === 'pending', 409, 'chore_not_pending', 'Reopen this task before changing its steps.');
      requireValue(Array.isArray(body.completedSubtaskIds) && body.completedSubtaskIds.length <= 20
        && body.completedSubtaskIds.every(value => (row.subtask_definitions || []).some(item => item.id === value)), 422, 'invalid_subtasks', 'Choose steps from this task.');
      checked = [...new Set(body.completedSubtaskIds)];
    }
    const updated = await one(client, `UPDATE family_chore_occurrences SET status=$3,date=$4::date,due_time=$5::time,completed_subtask_ids=$6::jsonb,version=version+1,
      completion_version=completion_version+CASE WHEN $7 THEN 1 ELSE 0 END,approved_at=$8,approved_by=$9,
      completed_at=CASE WHEN $10 THEN NULL ELSE completed_at END,completed_by=CASE WHEN $10 THEN NULL ELSE completed_by END,
      skip_reason=$11,exception_id=CASE WHEN $12 THEN NULL ELSE exception_id END,updated_at=$13,
      school_schedule_exempt=school_schedule_exempt OR $14 WHERE household_id=$1 AND id=$2 RETURNING *,date::text,original_date::text`,
    [householdId, id, status, toDate || row.date, dueTime, JSON.stringify(checked), ['approve', 'reject'].includes(action), action === 'approve' ? now : row.approved_at,
      action === 'approve' ? principal.actor : row.approved_by, action === 'reject', action === 'skip' ? reason : row.skip_reason, action === 'skip', now, action === 'reschedule']);
    if (['approve', 'reject'].includes(action)) await writeLegacyCompletion(client, updated, principal, now);
    await appendEvent(client, principal, updated, { approve: 'approved', reject: 'rejected', skip: 'skipped', reschedule: 'rescheduled', subtasks: 'subtasks_changed' }[action], row, reason, now);
    if (onChange) await onChange(client, { householdId, personId: row.person_id, date: row.date,
      affectedDates: [...new Set([row.date, updated.date])].sort(), occurrenceId: id, status, actor: principal.actor });
    return rememberMutation(client, householdId, principal, body.mutationId, hash, { ...occurrenceDto(updated), mutationId: body.mutationId });
  });
}

export async function choreHistory(db, principal, { from, to, personId, limit = 100 } = {}) {
  const householdId = requireHousehold(principal);
  if (from !== undefined) dateField(from); if (to !== undefined) dateField(to);
  const person = principal.role === 'child' ? principal.personId : personId === undefined ? null : uuidField(personId, 'Child profile');
  if (typeof limit === 'string' && /^\d{1,3}$/.test(limit)) limit = Number(limit);
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 100, 422, 'invalid_limit', 'Request at most 100 history entries.');
  const rows = (await db.query(`SELECT e.*,o.title,o.person_name,o.person_id,o.date::text FROM family_chore_events e
    JOIN family_chore_occurrences o ON o.id=e.occurrence_id AND o.household_id=e.household_id
    WHERE e.household_id=$1 AND ($2::uuid IS NULL OR o.person_id=$2) AND ($3::date IS NULL OR o.date>=$3::date) AND ($4::date IS NULL OR o.date<$4::date)
    ORDER BY e.created_at DESC,e.id DESC LIMIT $5`, [householdId, person, from || null, to || null, limit])).rows;
  return { history: rows.map(row => ({ id: row.id, occurrenceId: row.occurrence_id, title: row.title, personId: row.person_id,
    personName: row.person_name, date: row.date, type: row.type, actor: row.actor, actorName: row.actor_name, reason: row.reason,
    before: row.before_state, after: row.after_state, createdAt: instant(row.created_at) })) };
}

const exceptionDto = row => ({ id: row.id, personId: row.person_id || null, choreId: row.chore_id || null,
  fromDate: dateOf(row.from_date), toDateExclusive: dateOf(row.to_date), reason: row.reason,
  version: row.version, createdAt: instant(row.created_at), revokedAt: instant(row.revoked_at) });

export async function choreExceptions(db, principal) {
  requireAdmin(principal);
  return { exceptions: (await db.query('SELECT *,from_date::text,to_date::text FROM family_chore_exceptions WHERE household_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [principal.household.id])).rows.map(exceptionDto) };
}

export async function createChoreException(db, principal, body, { now = new Date() } = {}) {
  requireAdmin(principal);
  const householdId = principal.household.id;
  const from = dateField(body.fromDate), to = dateField(body.toDateExclusive);
  requireValue(Date.parse(to) > Date.parse(from) && Date.parse(to) - Date.parse(from) <= 366 * 86_400_000, 422, 'invalid_exception_dates', 'Choose a break lasting 1–366 days.');
  const reason = textField(body.reason, 'Reason', 500);
  const personId = body.personId === undefined || body.personId === null ? null : uuidField(body.personId, 'Child profile');
  const choreId = body.choreId === undefined || body.choreId === null ? null : uuidField(body.choreId, 'Routine ID');
  uuidField(body.mutationId, 'Mutation ID');
  const hash = digest(JSON.stringify({ operation: 'create-chore-exception', from, to, reason, personId, choreId }));
  return transaction(db, async client => {
    const replay = await replayMutation(client, householdId, principal, body.mutationId, hash); if (replay) return replay;
    if (personId) requireValue(await one(client, 'SELECT id FROM family_people WHERE household_id=$1 AND id=$2 FOR KEY SHARE', [householdId, personId]), 404, 'not_found', 'That child profile does not exist.');
    if (choreId) requireValue(await one(client, 'SELECT id FROM family_chores WHERE household_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE', [householdId, choreId]), 404, 'not_found', 'That routine does not exist.');
    const today = householdDate(principal.household.timezone, now);
    const days = (await client.query(`SELECT DISTINCT date::text FROM family_chore_occurrences WHERE household_id=$1 AND date>=$2::date AND date<$3::date
      UNION SELECT $4::date::text ORDER BY date`, [householdId, from, to, today])).rows.map(row => row.date);
    for (const date of days) await lockChoreDay(client, householdId, date);
    const exception = await one(client, `INSERT INTO family_chore_exceptions(id,household_id,person_id,chore_id,from_date,to_date,reason,created_by,created_at)
      VALUES($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9) RETURNING *,from_date::text,to_date::text`,
    [randomUUID(), householdId, personId, choreId, from, to, reason, principal.actor, now]);
    const rows = (await client.query(`SELECT *,date::text,original_date::text FROM family_chore_occurrences WHERE household_id=$1 AND date>=$2::date AND date<$3::date
      AND status='pending' AND ($4::uuid IS NULL OR person_id=$4) AND ($5::uuid IS NULL OR chore_id=$5) ORDER BY family_chore_occurrences.date,id FOR UPDATE`, [householdId, from, to, personId, choreId])).rows;
    for (const row of rows) {
      const updated = await one(client, "UPDATE family_chore_occurrences SET status='skipped',skip_reason=$3,exception_id=$4,version=version+1,updated_at=$5 WHERE household_id=$1 AND id=$2 RETURNING *,date::text,original_date::text", [householdId, row.id, reason, exception.id, now]);
      await appendEvent(client, principal, updated, 'skipped', row, reason, now);
    }
    return rememberMutation(client, householdId, principal, body.mutationId, hash, { ...exceptionDto(exception), affectedCount: rows.length, mutationId: body.mutationId });
  });
}

export async function revokeChoreException(db, principal, id, body, { now = new Date() } = {}) {
  requireAdmin(principal); uuidField(id); versionField(body.expectedVersion); uuidField(body.mutationId, 'Mutation ID');
  const reason = textField(body.reason, 'Reason', 500);
  const householdId = principal.household.id;
  const hash = digest(JSON.stringify({ operation: 'revoke-chore-exception', id, expectedVersion: body.expectedVersion, reason }));
  return transaction(db, async client => {
    const replay = await replayMutation(client, householdId, principal, body.mutationId, hash); if (replay) return replay;
    const candidate = await one(client, 'SELECT id FROM family_chore_exceptions WHERE household_id=$1 AND id=$2', [householdId, id]);
    if (!candidate) throw notFound();
    const today = householdDate(principal.household.timezone, now);
    const days = (await client.query(`SELECT DISTINCT date::text FROM family_chore_occurrences WHERE household_id=$1 AND exception_id=$2 AND date>=$3::date ORDER BY date`, [householdId, id, today])).rows.map(row => row.date);
    for (const date of days) await lockChoreDay(client, householdId, date);
    const exception = await one(client, 'SELECT *,from_date::text,to_date::text FROM family_chore_exceptions WHERE household_id=$1 AND id=$2 FOR UPDATE', [householdId, id]);
    requireValue(exception.version === body.expectedVersion && !exception.revoked_at, 409, 'version_conflict', 'This break changed. Refresh and try again.');
    const updatedException = await one(client, 'UPDATE family_chore_exceptions SET revoked_at=$3,version=version+1 WHERE household_id=$1 AND id=$2 RETURNING *,from_date::text,to_date::text', [householdId, id, now]);
    // Removing a vacation does not rewrite historical excused days. Only current
    // or future materialized work is restored, unless another break still covers it.
    const rows = (await client.query(`SELECT *,date::text,original_date::text FROM family_chore_occurrences WHERE household_id=$1 AND exception_id=$2 AND date>=$3::date AND status='skipped' ORDER BY family_chore_occurrences.date,id FOR UPDATE`, [householdId, id, today])).rows;
    for (const row of rows) {
      const other = await one(client, `SELECT id,reason FROM family_chore_exceptions WHERE household_id=$1 AND id<>$2 AND revoked_at IS NULL
        AND from_date<=$3::date AND to_date>$3::date AND (person_id IS NULL OR person_id=$4) AND (chore_id IS NULL OR chore_id=$5) ORDER BY created_at,id LIMIT 1`, [householdId, id, row.date, row.person_id, row.chore_id]);
      const updated = await one(client, `UPDATE family_chore_occurrences SET status=$3,skip_reason=$4,exception_id=$5,version=version+1,updated_at=$6
        WHERE household_id=$1 AND id=$2 RETURNING *,date::text,original_date::text`, [householdId, row.id, other ? 'skipped' : 'pending', other?.reason || null, other?.id || null, now]);
      await appendEvent(client, principal, updated, 'exception_removed', row, reason, now);
    }
    return rememberMutation(client, householdId, principal, body.mutationId, hash, { ...exceptionDto(updatedException), affectedCount: rows.length, mutationId: body.mutationId });
  });
}
