import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { ApiError, requireValue, uuidField } from './errors.js';
import { decryptCredentials, encryptCredentials, keyedDigest } from './credentials.js';
import { one, transaction } from './database.js';
import { classifyApnsResult, preflightApns, sendApns } from './apns.js';
import { activeMobileSessionSql as activeSession } from './mobile.js';
import { ensureDailyOccurrences } from './chore-occurrences.js';
import { schoolDayForDate } from './school-calendar.js';

const preferenceColumns = Object.freeze({ pushEnabled: 'push_enabled', choreCompleted: 'chore_completed', choreReopened: 'chore_reopened',
  choreDueSoon: 'chore_due_soon', choreOverdue: 'chore_overdue', calendarEvents: 'calendar_events', frameStatus: 'frame_status',
  rewards: 'rewards', internetSessions: 'internet_sessions', taskReminders: 'task_reminders', dailyCompleted: 'daily_completed', accessRequests: 'access_requests', showDetails: 'show_details' });
const preferenceForKind = { chore_completed: 'choreCompleted', chore_reopened: 'choreReopened', chore_due_soon: 'choreDueSoon',
  chore_overdue: 'choreOverdue', chore_submitted: 'choreCompleted', calendar_upcoming: 'calendarEvents', calendar_unavailable: 'calendarEvents', calendar_restored: 'calendarEvents', frame_offline: 'frameStatus', frame_online: 'frameStatus',
  reward_earned: 'rewards', session_started: 'internetSessions', session_warning: 'internetSessions', session_expired: 'internetSessions', session_paused: 'internetSessions',
  session_ended: 'internetSessions', session_adjusted: 'internetSessions', enforcement_failed: 'internetSessions', daily_tasks_reminder: 'taskReminders', daily_tasks_completed: 'dailyCompleted', access_requested: 'accessRequests', access_approved: 'accessRequests', access_declined: 'accessRequests', access_granted: 'internetSessions' };
const childChoreKinds = ['chore_completed', 'chore_reopened', 'chore_due_soon', 'chore_overdue'];
const childNetworkKinds = ['reward_earned', 'session_started', 'session_warning', 'session_expired', 'session_paused', 'session_ended', 'session_adjusted', 'access_approved', 'access_declined', 'access_granted'];
const childDailyKinds = ['daily_tasks_reminder'];
const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const uuidJson = value => typeof value === 'string' && new RegExp(uuidPattern).test(value) ? value : null;
const occurrenceIdSql = alias => `CASE WHEN ${alias}.payload->>'occurrenceId' ~ '${uuidPattern}' THEN (${alias}.payload->>'occurrenceId')::uuid END`;
const childEventScope = (alias, person) => `(${alias}.person_id=${person} AND (
  (${alias}.type IN(${[...childNetworkKinds, ...childDailyKinds].map(kind => `'${kind}'`).join(',')}) AND ${alias}.chore_id IS NULL)
  OR (${alias}.type IN(${childChoreKinds.map(kind => `'${kind}'`).join(',')}) AND EXISTS(SELECT 1 FROM family_chore_occurrences scope_occurrence
    WHERE scope_occurrence.household_id=${alias}.household_id AND scope_occurrence.chore_id=${alias}.chore_id AND scope_occurrence.person_id=${person}
      AND ((${alias}.payload ? 'occurrenceId' AND scope_occurrence.id=${occurrenceIdSql(alias)}) OR (NOT ${alias}.payload ? 'occurrenceId' AND scope_occurrence.date=${alias}.date))))))`;
const notFound = () => new ApiError(404, 'not_found', 'That notification does not exist.');
const iso = value => new Date(value).toISOString();
const localDate = (now, timezone) => Temporal.Instant.from(iso(now)).toZonedDateTimeISO(timezone).toPlainDate();

function mobilePrincipal(principal) {
  requireValue(principal?.authType === 'mobile' && principal.household?.id, 403, 'mobile_required', 'Use the signed-in Family Frame app.');
  return { sessionId: uuidField(principal.mobileSessionId), householdId: uuidField(principal.household.id) };
}

async function checkedSession(db, principal, now = new Date(), lock = '') {
  const { sessionId, householdId } = mobilePrincipal(principal);
  const session = await one(db, `SELECT s.* FROM family_mobile_sessions s WHERE s.id=$1 AND ${activeSession()} AND s.household_id=$3 ${lock}`, [sessionId, now, householdId]);
  requireValue(session && (session.kind === 'child' ? principal.role === 'child' && session.person_id === principal.personId : principal.role !== 'child'),
    401, 'mobile_session_expired', 'Sign in or pair this app again.');
  return session;
}

async function checkedAccount(db, principal, now = new Date(), lock = '') {
  requireValue(['user', 'mobile'].includes(principal?.authType) && principal.household?.id && principal.user?.id,
    403, 'account_required', 'Sign in to your own Family Frame account.');
  const householdId = uuidField(principal.household.id);
  if (principal.authType === 'mobile') {
    const session = await checkedSession(db, principal, now, lock ? 'FOR SHARE OF s' : '');
    requireValue(session.user_id === principal.user.id, 401, 'session_required', 'Sign in again.');
    return { householdId, userId: session.user_id, role: session.kind === 'child' ? 'child' : principal.role, personId: session.kind === 'child' ? session.person_id : null };
  }
  const userId = uuidField(principal.user.id), providerSessionId = uuidField(principal.sessionId, 'Sign-in session');
  const member = await one(db, `SELECT m.role,m.person_id FROM family_members m JOIN family_internal.auth_sessions a ON a.user_id::text=m.user_id
    LEFT JOIN family_people p ON p.household_id=m.household_id AND p.id=m.person_id
    WHERE m.household_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND a.id=$3 AND (a.not_after IS NULL OR a.not_after>$4)
      AND (m.role<>'child' OR p.id IS NOT NULL) ${lock ? 'FOR SHARE OF m' : ''}`, [householdId, userId, providerSessionId, now]);
  requireValue(member && member.role === principal.role && (member.role !== 'child' || member.person_id === principal.personId),
    401, 'session_required', 'Your sign-in or family profile changed. Sign in again.');
  return { householdId, userId, role: member.role, personId: member.role === 'child' ? member.person_id : null };
}

export function preferencesDto(row, timezone) {
  return { ...Object.fromEntries(Object.entries(preferenceColumns).map(([key, column]) => [key, row?.[column] ?? true])),
    quietStart: row?.quiet_start?.slice(0, 5) || null, quietEnd: row?.quiet_end?.slice(0, 5) || null, timezone };
}

export function validatePreferences(body, current) {
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 422, 'invalid_preferences', 'Send notification settings.');
  requireValue(Object.keys(body).every(key => Object.hasOwn(preferenceColumns, key) || ['quietStart', 'quietEnd'].includes(key)),
    422, 'invalid_preferences', 'That notification setting is unsupported.');
  const value = { ...current };
  for (const key of Object.keys(preferenceColumns)) if (body[key] !== undefined) {
    requireValue(typeof body[key] === 'boolean', 422, 'invalid_preferences', 'Notification switches must be true or false.');
    value[key] = body[key];
  }
  for (const key of ['quietStart', 'quietEnd']) if (body[key] !== undefined) {
    requireValue(body[key] === null || typeof body[key] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body[key]),
      422, 'invalid_preferences', 'Quiet hours use HH:mm, or null to turn them off.');
    value[key] = body[key];
  }
  requireValue(value.quietStart === null && value.quietEnd === null || value.quietStart && value.quietEnd && value.quietStart !== value.quietEnd,
    422, 'invalid_preferences', 'Set both quiet-hour times, with different start and end times.');
  return value;
}

export async function notificationPreferences(db, principal, body) {
  requireValue(['user', 'mobile'].includes(principal?.authType) && principal.household?.id && principal.user?.id,
    403, 'account_required', 'Sign in to your own Family Frame account.');
  return transaction(db, async client => {
    const account = await checkedAccount(client, principal, new Date(), true);
    await client.query('INSERT INTO family_account_notification_preferences(household_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [account.householdId, account.userId]);
    const row = await one(client, 'SELECT * FROM family_account_notification_preferences WHERE household_id=$1 AND user_id=$2 FOR UPDATE', [account.householdId, account.userId]);
    const current = preferencesDto(row, principal.household.timezone);
    if (body === undefined) return current;
    const value = validatePreferences(body, current);
    const keys = Object.entries(preferenceColumns);
    await client.query(`UPDATE family_account_notification_preferences SET ${keys.map(([, column], i) => `${column}=$${i + 3}`).join(',')},
      quiet_start=$${keys.length + 3}::time,quiet_end=$${keys.length + 4}::time,updated_at=now() WHERE household_id=$1 AND user_id=$2`,
    [account.householdId, account.userId, ...keys.map(([key]) => value[key]), value.quietStart, value.quietEnd]);
    return value;
  });
}

export async function registerPush(db, principal, body, env = process.env) {
  mobilePrincipal(principal);
  const installationId = uuidField(body.installationId, 'Installation ID');
  requireValue(typeof body.token === 'string' && /^[0-9a-f]{64,400}$/i.test(body.token) && body.token.length % 2 === 0
    && ['sandbox', 'production'].includes(body.environment), 422, 'invalid_push_device', 'Use a valid Apple push installation.');
  const token = body.token.toLowerCase();
  const tokenHash = keyedDigest('apns-device', `${body.environment}:${token}`, env);
  const credentials = encryptCredentials(principal.household.id, { purpose: 'apns-device', token }, env);
  return transaction(db, async client => {
    const session = await checkedSession(client, principal, new Date(), 'FOR SHARE OF s');
    // A token may belong to only one signed-in app session. Reinstall/login switches cannot retain a previous child's subscription.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`apns-installation:${installationId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`apns:${tokenHash}`]);
    const previous = await one(client, 'SELECT mobile_session_id,token_hash FROM family_push_installations WHERE installation_id=$1 FOR UPDATE', [installationId]);
    requireValue(!previous || previous.mobile_session_id === session.id || previous.token_hash === tokenHash,
      409, 'installation_conflict', 'This installation belongs to another sign-in. Register a new installation ID.');
    await client.query('DELETE FROM family_push_installations WHERE token_hash=$1 AND installation_id<>$2', [tokenHash, installationId]);
    await client.query(`INSERT INTO family_push_installations(id,installation_id,household_id,mobile_session_id,token_hash,credentials,environment)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(installation_id) DO UPDATE SET household_id=EXCLUDED.household_id,
      mobile_session_id=EXCLUDED.mobile_session_id,token_hash=EXCLUDED.token_hash,credentials=EXCLUDED.credentials,
      environment=EXCLUDED.environment,registered_at=now(),disabled_at=NULL`, [randomUUID(), installationId, session.household_id, session.id, tokenHash, JSON.stringify(credentials), body.environment]);
    return { registered: true };
  });
}

export async function sendTestNotification(db, principal, { env = process.env, now = new Date(), send = sendApns } = {}) {
  // A test is always addressed to this authenticated app session, never a token
  // or recipient supplied by the caller. Failed attempts also consume the limit.
  const allowed = await transaction(db, async client => {
    const session = await checkedSession(client, principal, now, 'FOR SHARE OF s');
    const limit = await one(client, `INSERT INTO family_rate_limits(bucket_key,window_start,attempts)
      VALUES($1,date_trunc('minute',$2::timestamptz),1) ON CONFLICT(bucket_key) DO UPDATE SET
      attempts=CASE WHEN family_rate_limits.window_start=EXCLUDED.window_start THEN family_rate_limits.attempts+1 ELSE 1 END,
      window_start=EXCLUDED.window_start RETURNING attempts`, [`push-test:${session.id}`, now]);
    return limit.attempts <= 3;
  });
  requireValue(allowed, 429, 'push_test_rate_limited', 'Wait a minute before sending another test notification.');
  return transaction(db, async client => {
    const session = await checkedSession(client, principal, now, 'FOR SHARE OF s');
    const installation = await one(client, `SELECT credentials,environment FROM family_push_installations
      WHERE household_id=$1 AND mobile_session_id=$2 AND disabled_at IS NULL ORDER BY registered_at DESC LIMIT 1 FOR SHARE`, [session.household_id, session.id]);
    requireValue(installation, 409, 'push_registration_required', 'This iPhone has not registered for push notifications. Enable notifications, then reopen Family Frame.');
    let credentials;
    try { credentials = decryptCredentials(session.household_id, installation.credentials, env); } catch { /* Sanitized below. */ }
    requireValue(credentials?.purpose === 'apns-device', 503, 'push_registration_unavailable', 'Push registration could not be read. Reopen Family Frame and try again.');
    let result;
    try {
      result = await send({ token: credentials.token, environment: installation.environment, notificationId: randomUUID(),
        expiresAt: new Date(now.getTime() + 300_000), payload: { aps: { alert: { title: 'Family Frame test', body: 'Your test notification arrived successfully.' }, sound: 'default' } } }, env);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'push_not_configured') throw error;
      throw new ApiError(502, 'push_test_unavailable', 'Apple could not be reached. Try again shortly.');
    }
    requireValue(result?.accepted === true && result.status === 200, 502, 'push_test_rejected', 'Apple did not accept this test. Refresh notification registration and try again.');
    return { accepted: true, acceptedAt: new Date().toISOString() };
  });
}

export function notificationText(event) {
  const task = String(event.payload?.title || 'A task').slice(0, 160);
  const person = String(event.payload?.personName || 'Your child').slice(0, 100);
  const device = String(event.payload?.deviceName || 'their device').slice(0, 100);
  const actor = String(event.payload?.actorName || 'A parent').slice(0, 100);
  const minutes = Math.max(1, Math.round(event.payload?.minutes || 1));
  const duration = event.payload?.allDay ? 'all-day access' : event.payload?.indefinite ? 'Internet access' : `${minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minute${minutes === 1 ? '' : 's'}`}${event.payload?.additional ? ' additional' : ''} access`;
  const reason = event.payload?.reason ? ` Reason: ${String(event.payload.reason).slice(0, 500)}` : '';
  const labels = {
    chore_submitted: ['Ready for parent review', `${person} submitted ${task} for approval.`],
    chore_completed: ['Task completed', `${person} completed ${task}.`], chore_reopened: ['Task reopened', `${task} was reopened.`],
    chore_due_soon: ['Task due soon', `${task} is due soon.`], chore_overdue: ['Task overdue', `${task} has not been marked done.`],
    calendar_upcoming: ['Calendar reminder', `${String(event.payload?.title || 'An event').slice(0, 160)} starts soon.`],
    calendar_unavailable: ['Calendar needs attention', 'The calendar has not synced recently. Check its connection in Setup.'],
    calendar_restored: ['Calendar restored', 'Your calendar is syncing again.'],
    reward_earned: ['Internet time earned', 'Your required tasks are complete. Use your reward now or save it for later.'],
    session_started: ['Internet session started', `${person} ${event.payload?.source === 'reward' ? 'is using earned time' : 'has access'} on ${device}.`],
    session_warning: ['Internet time ending soon', 'Your access window will end soon.'],
    session_expired: ['Internet time finished', 'Your access window has ended.'],
    session_paused: ['Internet session paused', 'Your access window is paused.'],
    session_ended: ['Internet session ended', 'A parent ended this access window.'],
    session_adjusted: ['Internet time adjusted', 'A parent changed your access window.'],
    enforcement_failed: ['Network control needs attention', 'A device access change could not be confirmed. Open Devices for its current status.'],
    daily_tasks_reminder: ['You have tasks to complete', `${event.payload?.remaining || 'Some'} ${event.payload?.remaining === 1 ? 'task is' : 'tasks are'} still waiting for you today. Open Tasks to get started.`],
    daily_tasks_completed: ["Today's tasks are complete", `${person} completed all ${event.payload?.total || ''} tasks for today.`],
    access_requested: ['Device time requested', `${person} requested ${duration} to ${device}.${reason}`],
    access_approved: ['Device time approved', `${actor} approved ${person}'s request for ${duration} to ${device}. Access is being confirmed.${reason}`],
    access_declined: ['Device time declined', `${actor} declined ${person}'s request for ${duration} to ${device}.`],
    access_granted: ['Device access granted', `${actor} granted ${person} ${duration} to ${device}. Access is being confirmed.`],
    frame_offline: ['Frame may be offline', 'Your frame has not checked in recently.'], frame_online: ['Frame connected', 'Your frame is connected again.'],
  };
  return labels[event.type] || ['Family update', 'There is a new family update.'];
}

export async function notificationInbox(db, principal) {
  const account = await checkedAccount(db, principal);
  const rows = (await db.query(`SELECT i.id,i.created_at,i.read_at,e.type,e.chore_id,e.date::text,e.payload || jsonb_build_object('personName',coalesce(e.payload->>'personName',(SELECT name FROM family_people WHERE household_id=e.household_id AND id=e.person_id))) AS payload FROM family_account_notification_inbox i
    JOIN family_notification_events e ON e.id=i.event_id
    WHERE i.household_id=$1 AND i.user_id=$2 AND ($3::uuid IS NULL OR ${childEventScope('e', '$3')})
    ORDER BY i.created_at DESC,i.id DESC LIMIT 100`, [account.householdId, account.userId, account.personId])).rows;
  return { notifications: rows.map(row => { const [title, body] = notificationText(row); return { id: row.id, kind: row.type, title, body,
    choreId: row.chore_id || null, date: row.date || null, occurrenceId: uuidJson(row.payload?.occurrenceId),
    sessionId: uuidJson(row.payload?.sessionId), creditId: uuidJson(row.payload?.creditId),
    target: childNetworkKinds.includes(row.type) || ['enforcement_failed', 'access_requested'].includes(row.type) ? 'devices' : row.chore_id || childDailyKinds.includes(row.type) ? 'chores' : 'today',
    createdAt: iso(row.created_at), readAt: row.read_at ? iso(row.read_at) : null }; }) };
}

export async function markNotificationRead(db, principal, id) {
  uuidField(id);
  return transaction(db, async client => {
    const account = await checkedAccount(client, principal, new Date(), true);
    const row = await one(client, `UPDATE family_account_notification_inbox i SET read_at=coalesce(i.read_at,now()) FROM family_notification_events e
      WHERE i.event_id=e.id AND i.household_id=$2 AND i.user_id=$3
        AND (i.id=$1 OR EXISTS(SELECT 1 FROM family_notification_inbox legacy JOIN family_mobile_sessions owner ON owner.id=legacy.mobile_session_id
          WHERE legacy.id=$1 AND legacy.event_id=i.event_id AND owner.household_id=i.household_id AND owner.user_id=i.user_id))
        AND ($4::uuid IS NULL OR ${childEventScope('e', '$4')}) RETURNING i.id,i.event_id,i.read_at`,
    [id, account.householdId, account.userId, account.personId]);
    if (!row) throw notFound();
    // Keep old installed builds' session IDs/read endpoints compatible. The
    // account row remains authoritative across all future sign-ins.
    await client.query(`UPDATE family_notification_inbox i SET read_at=coalesce(i.read_at,$4::timestamptz) FROM family_mobile_sessions s
      WHERE i.mobile_session_id=s.id AND i.household_id=$1 AND s.user_id=$2 AND i.event_id=$3`, [account.householdId, account.userId, row.event_id, row.read_at]);
    return { read: true };
  });
}

export function occurrenceInstant(date, time, timezone) {
  return new Date(Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(timezone, { disambiguation: 'compatible' }).epochMilliseconds);
}

export function quietUntil(now, timezone, start, end) {
  if (!start || !end) return null;
  const zoned = Temporal.Instant.from(iso(now)).toZonedDateTimeISO(timezone);
  const time = zoned.toPlainTime().toString().slice(0, 5);
  const overnight = start > end;
  const quiet = overnight ? time >= start || time < end : time >= start && time < end;
  if (!quiet) return null;
  const date = overnight && time >= start ? zoned.toPlainDate().add({ days: 1 }) : zoned.toPlainDate();
  const candidate = occurrenceInstant(date.toString(), end, timezone);
  // During the repeated fall-back hour the first wall-clock end may already
  // have passed. Resume at the second occurrence rather than requeueing in the past.
  if (candidate <= now) return new Date(Temporal.PlainDateTime.from(`${date}T${end}`).toZonedDateTime(timezone, { disambiguation: 'later' }).epochMilliseconds);
  return candidate;
}

export function choreOccurrences(chore, timezone, since, now) {
  if (!chore.due_time || chore.deleted_at) return [];
  const result = [];
  let date = localDate(since, timezone).subtract({ days: 1 });
  const last = localDate(now, timezone).add({ days: 1 });
  for (; Temporal.PlainDate.compare(date, last) <= 0; date = date.add({ days: 1 })) {
    if (!chore.weekdays.includes(date.dayOfWeek % 7)) continue;
    const due = occurrenceInstant(date.toString(), chore.due_time, timezone);
    for (const [type, at] of [['chore_due_soon', new Date(due.getTime() - chore.reminder_minutes * 60_000)], ['chore_overdue', due]]) {
      if (type === 'chore_due_soon' && !chore.reminder_minutes) continue;
      if (at > since && at <= now && (!chore.created_at || at >= new Date(chore.created_at))) result.push({ type, date: date.toString(), at, due });
    }
  }
  return result;
}

export function dailyOccurrenceReminders(occurrence, timezone, since, now) {
  if (occurrence.status !== 'pending' || !occurrence.due_time) return [];
  const date = typeof occurrence.date === 'string' ? occurrence.date : iso(occurrence.date).slice(0, 10);
  const due = occurrenceInstant(date, occurrence.due_time, timezone);
  const dayStart = occurrenceInstant(date, '00:00', timezone);
  const lead = Math.max(0, occurrence.reminder_minutes || 0);
  // Future definitions stay editable until the household day begins. An early
  // morning reminder is clamped to midnight rather than freezing tomorrow.
  return [['chore_due_soon', new Date(Math.max(dayStart.getTime(), due.getTime() - lead * 60_000))], ['chore_overdue', due]]
    .filter(([type, at]) => (type !== 'chore_due_soon' || lead > 0) && at > since && at <= now && (!occurrence.created_at || at >= new Date(occurrence.created_at)))
    .map(([type, at]) => ({ type, date, at, due }));
}

export function dailyTaskReminderSlots(date, schoolType, timezone, since, now) {
  const times = schoolType === 'school_day' ? ['07:00','16:00'] : schoolType === 'non_school_day' ? ['11:00'] : [];
  return times.map(time => ({ time, at: occurrenceInstant(date, time, timezone) }))
    .filter(({ at }) => at > since && at <= now && now - at < 60 * 60_000);
}

async function dailyTaskReminders(client, household, since, now) {
  const date = localDate(now, household.timezone).toString();
  const schoolDay = await schoolDayForDate(client, household.id, date);
  const slots = dailyTaskReminderSlots(date, schoolDay.type, household.timezone, since, now);
  if (!slots.length) return 0;
  const people = (await client.query(`SELECT o.person_id,count(*)::int AS remaining FROM family_chore_occurrences o
    WHERE o.household_id=$1 AND o.date=$2::date AND o.status='pending' AND o.person_id IS NOT NULL
    GROUP BY o.person_id`, [household.id, date])).rows;
  let events = 0;
  for (const person of people) for (const slot of slots) events += await insertEvent(client, {
    householdId: household.id, personId: person.person_id, key: `daily-reminder:${person.person_id}:${date}:${slot.time}`,
    type: 'daily_tasks_reminder', date, at: slot.at, expiresAt: new Date(slot.at.getTime()+3600_000),
    payload: { remaining: person.remaining, schoolType: schoolDay.type, audience: 'children' } });
  return events;
}

export function frameIsOffline(lastSeenAt, now) {
  // Authentication deliberately writes frame heartbeats at most every five
  // minutes; allow three full intervals before reporting a connectivity issue.
  return Boolean(lastSeenAt && new Date(now) - new Date(lastSeenAt) > 15 * 60_000);
}

async function insertEvent(client, event) {
  const row = await one(client, `INSERT INTO family_notification_events(id,household_id,event_key,type,person_id,chore_id,date,payload,occurred_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::date,$8::jsonb,$9,$10) ON CONFLICT(household_id,event_key) DO NOTHING RETURNING id`,
  [randomUUID(), event.householdId, event.key, event.type, event.personId || null, event.choreId || null, event.date || null,
    JSON.stringify(event.payload || {}), event.at, event.expiresAt]);
  return row ? 1 : 0;
}

async function scanHousehold(db, household, now) {
  return transaction(db, async client => {
    await ensureDailyOccurrences(client, household, localDate(now, household.timezone).toString(), { now });
    const inserted = await one(client, 'INSERT INTO family_notification_scan_state(household_id,scanned_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING household_id', [household.id, now]);
    const checkpoint = await one(client, 'SELECT * FROM family_notification_scan_state WHERE household_id=$1 FOR UPDATE', [household.id]);
    if (new Date(checkpoint.scanned_at) > now) return 0;
    const since = new Date(Math.max(new Date(checkpoint.scanned_at).getTime(), now.getTime() - 24 * 3600_000));
    let events = await dailyTaskReminders(client, household, inserted ? new Date(now.getTime()-60_000) : since, now);
    if (!inserted) {
      const chores = (await client.query(`SELECT *,date::text FROM family_chore_occurrences WHERE household_id=$1 AND status='pending' AND due_time IS NOT NULL
        AND date BETWEEN $2::date AND $3::date`, [household.id, localDate(since, household.timezone).toString(), localDate(now, household.timezone).toString()])).rows;
      for (const chore of chores) for (const reminder of dailyOccurrenceReminders(chore, household.timezone, since, now)) {
        events += await insertEvent(client, { householdId: household.id, key: `${reminder.type}:${chore.id}:${reminder.date}:${chore.due_time}`,
          type: reminder.type, personId: chore.person_id, choreId: chore.chore_id, date: reminder.date, at: reminder.at,
          expiresAt: reminder.type === 'chore_due_soon' ? reminder.due : new Date(reminder.due.getTime() + 6 * 3600_000),
          payload: { title: chore.title, choreVersion: chore.routine_version, occurrenceId: chore.id, occurrenceVersion: chore.version, occurrenceStatus: 'pending', dueTime: chore.due_time } });
      }
    }
    const connection = await one(client, "SELECT updated_at,version,selected_ids FROM family_calendar_connections WHERE household_id=$1 AND jsonb_array_length(selected_ids)>0", [household.id]);
    const cache = connection ? await one(client, `SELECT snapshot,successful_at FROM family_calendar_cache WHERE household_id=$1
      AND connection_version=$2 AND timezone=$3 AND start_date<=$4::date AND end_date>$4::date ORDER BY successful_at DESC LIMIT 1`,
    [household.id, connection.version, household.timezone, localDate(now, household.timezone).toString()]) : null;
    const healthy = Boolean(connection && cache && now - new Date(cache.successful_at) < 15 * 60_000 && cache.snapshot?.coverage?.complete && !cache.snapshot?.coverage?.truncated);
    const calendarBad = Boolean(connection && !healthy && now - new Date(connection.updated_at) >= 15 * 60_000);
    if (!inserted && checkpoint.state.calendarBad !== undefined && calendarBad !== checkpoint.state.calendarBad && connection) {
      const type = calendarBad ? 'calendar_unavailable' : 'calendar_restored';
      events += await insertEvent(client, { householdId: household.id, key: `${type}:${iso(checkpoint.scanned_at)}`, type, at: now, expiresAt: new Date(now.getTime() + 6 * 3600_000) });
    }
    // Timed event reminders belong on the paired frame. Apple Calendar owns
    // event-start alerts on phones; do not enqueue new account/APNs reminders.
    const devices = (await client.query('SELECT id,last_seen_at FROM family_devices WHERE household_id=$1 AND revoked_at IS NULL AND expires_at>$2', [household.id, now])).rows;
    const frames = Object.fromEntries(devices.filter(device => device.last_seen_at).map(device => [device.id, frameIsOffline(device.last_seen_at, now)]));
    if (!inserted) for (const [id, offline] of Object.entries(frames)) if (checkpoint.state.frames?.[id] !== undefined && checkpoint.state.frames[id] !== offline) {
      const type = offline ? 'frame_offline' : 'frame_online';
      events += await insertEvent(client, { householdId: household.id, key: `${type}:${id}:${iso(checkpoint.scanned_at)}`, type, at: now, expiresAt: new Date(now.getTime() + 6 * 3600_000) });
    }
    await client.query('UPDATE family_notification_scan_state SET scanned_at=$2,state=$3::jsonb WHERE household_id=$1', [household.id, now, JSON.stringify({ calendarBad, frames })]);
    return events;
  });
}

async function fanOut(db, now) {
  return transaction(db, async client => {
    const events = (await client.query('SELECT * FROM family_notification_events WHERE fanned_at IS NULL ORDER BY occurred_at,id LIMIT 100 FOR UPDATE SKIP LOCKED')).rows;
    if (!events.length) return 0;
    const ids = events.map(event => event.id);
    const inbox = await client.query(`INSERT INTO family_account_notification_inbox(event_id,household_id,user_id,created_at)
      SELECT e.id,e.household_id,m.user_id,e.occurred_at FROM family_notification_events e JOIN family_members m ON m.household_id=e.household_id
      WHERE e.id=ANY($1::uuid[]) AND m.revoked_at IS NULL AND m.joined_at<=e.occurred_at
        AND coalesce(e.payload->>'excludeUserId','')<>m.user_id
        AND (coalesce(e.payload->>'audience','')<>'parents' OR m.role IN ('admin','member'))
        AND (coalesce(e.payload->>'audience','')<>'children' OR m.role='child')
        AND (m.role IN ('admin','member') OR (m.role='child' AND EXISTS(SELECT 1 FROM family_people p WHERE p.household_id=m.household_id AND p.id=m.person_id)
          AND ${childEventScope('e', 'm.person_id')})) ON CONFLICT(event_id,household_id,user_id) DO NOTHING`, [ids]);
    await client.query(`INSERT INTO family_notification_inbox(id,event_id,household_id,mobile_session_id,created_at)
      SELECT gen_random_uuid(),e.id,e.household_id,s.id,e.occurred_at FROM family_notification_events e
      JOIN family_mobile_sessions s ON s.household_id=e.household_id
      JOIN family_account_notification_inbox account_inbox ON account_inbox.event_id=e.id AND account_inbox.household_id=s.household_id AND account_inbox.user_id=s.user_id
      WHERE e.id=ANY($1::uuid[]) AND ${activeSession()} AND s.created_at<=e.occurred_at
        AND (s.kind='parent' OR ${childEventScope('e', 's.person_id')})
      ON CONFLICT(event_id,mobile_session_id) DO NOTHING`, [ids, now]);
    await client.query(`INSERT INTO family_notification_deliveries(id,inbox_id,installation_id,available_at)
      SELECT gen_random_uuid(),i.id,p.id,$2 FROM family_notification_inbox i JOIN family_push_installations p
        ON p.mobile_session_id=i.mobile_session_id AND p.household_id=i.household_id
      WHERE i.event_id=ANY($1::uuid[]) AND p.disabled_at IS NULL ON CONFLICT DO NOTHING`, [ids, now]);
    await client.query('UPDATE family_notification_events SET fanned_at=$2 WHERE id=ANY($1::uuid[])', [ids, now]);
    return inbox.rowCount;
  });
}

async function claimDeliveries(db, now) {
  return transaction(db, async client => {
    const rows = (await client.query(`SELECT id FROM family_notification_deliveries WHERE
      (state='pending' AND available_at<=$1) OR (state='leased' AND lease_until<=$1)
      ORDER BY available_at,id LIMIT 12 FOR UPDATE SKIP LOCKED`, [now])).rows;
    const leases = [];
    for (const row of rows) {
      const leaseId = randomUUID();
      await client.query("UPDATE family_notification_deliveries SET state='leased',lease_id=$2,lease_until=$3 WHERE id=$1", [row.id, leaseId, new Date(now.getTime() + 120_000)]);
      leases.push({ id: row.id, leaseId });
    }
    return leases;
  });
}

export function lockScreenPayload(notificationId, event) {
  // Private mode keeps all details in authenticated Activity. Detailed mode is an account preference.
  const alert = event ? Object.fromEntries(['title','body'].map((key, i) => [key, notificationText(event)[i]])) : null;
  return { aps: { alert: alert || { title: 'Family Frame', body: 'Your family has an update. Open Family Frame to see it.' }, sound: 'default', category: 'FAMILY_UPDATE', 'thread-id': 'family-frame' }, notificationId };
}

async function deliver(db, lease, env, now, send) {
  return transaction(db, async client => {
    const delivery = await one(client, `SELECT d.*,i.mobile_session_id,i.household_id,e.id AS event_id,e.type,e.person_id,e.chore_id,e.date::text,e.payload || jsonb_build_object('personName',coalesce(e.payload->>'personName',(SELECT name FROM family_people WHERE household_id=e.household_id AND id=e.person_id))) AS payload,e.expires_at,
      p.credentials,p.environment,p.registered_at::text AS registered_version,p.disabled_at,p.mobile_session_id AS installation_session,h.timezone,account_inbox.id AS account_notification_id FROM family_notification_deliveries d
      JOIN family_notification_inbox i ON i.id=d.inbox_id JOIN family_notification_events e ON e.id=i.event_id
      JOIN family_push_installations p ON p.id=d.installation_id JOIN family_households h ON h.id=i.household_id
      JOIN family_mobile_sessions owner ON owner.id=i.mobile_session_id
      LEFT JOIN family_account_notification_inbox account_inbox ON account_inbox.event_id=e.id AND account_inbox.household_id=i.household_id AND account_inbox.user_id=owner.user_id
      WHERE d.id=$1 AND d.state='leased' AND d.lease_id=$2 FOR UPDATE OF d`, [lease.id, lease.leaseId]);
    if (!delivery) return 'skipped';
    const suppress = async reason => { await client.query("UPDATE family_notification_deliveries SET state='suppressed',last_error=$2,lease_id=NULL,lease_until=NULL WHERE id=$1", [delivery.id, reason]); return 'suppressed'; };
    const session = await one(client, `SELECT s.* FROM family_mobile_sessions s WHERE s.id=$1 AND ${activeSession()} AND s.household_id=$3 FOR SHARE OF s`, [delivery.mobile_session_id, now, delivery.household_id]);
    if (!session || delivery.disabled_at || delivery.installation_session !== delivery.mobile_session_id) return suppress('recipient_inactive');
    if (new Date(delivery.expires_at) <= now) return suppress('expired');
    if (delivery.type === 'calendar_upcoming') return suppress('frame_only');
    if (delivery.attempts >= 6) return suppress('attempt_limit');
    if (session.kind === 'child' && (delivery.person_id !== session.person_id || ![...childChoreKinds, ...childNetworkKinds, ...childDailyKinds].includes(delivery.type))) return suppress('recipient_scope');
    if (delivery.payload?.excludeUserId === session.user_id || delivery.payload?.audience === 'parents' && session.kind === 'child'
      || delivery.payload?.audience === 'children' && session.kind !== 'child') return suppress('recipient_scope');
    if (delivery.type === 'daily_tasks_reminder') {
      const schoolDay = await schoolDayForDate(client, delivery.household_id, delivery.date);
      const pending = await one(client, `SELECT count(*)::int AS remaining FROM family_chore_occurrences
        WHERE household_id=$1 AND person_id=$2 AND date=$3::date AND status='pending'`, [delivery.household_id, delivery.person_id, delivery.date]);
      if (!pending.remaining || schoolDay.type !== delivery.payload.schoolType || delivery.date !== localDate(now, delivery.timezone).toString()) return suppress('tasks_changed');
      delivery.payload.remaining = pending.remaining;
    }
    if (delivery.type === 'daily_tasks_completed') {
      const totals = await one(client, `SELECT count(*)::int AS total,bool_and(status='completed') AS complete FROM family_chore_occurrences
        WHERE household_id=$1 AND person_id=$2 AND date=$3::date AND status<>'skipped'`, [delivery.household_id, delivery.person_id, delivery.payload.date]);
      if (!totals.total || !totals.complete) return suppress('tasks_changed');
    }
    if (delivery.type === 'access_requested') {
      const request = await one(client, "SELECT id FROM family_access_requests WHERE household_id=$1 AND id=$2 AND status='pending' AND expires_at>$3", [delivery.household_id, delivery.payload.requestId, now]);
      if (!request) return suppress('request_resolved');
    }
    if (delivery.chore_id) {
      const occurrenceId = uuidJson(delivery.payload?.occurrenceId);
      const occurrence = occurrenceId ? await one(client, 'SELECT *,date::text FROM family_chore_occurrences WHERE household_id=$1 AND id=$2 FOR SHARE', [delivery.household_id, occurrenceId])
        : await one(client, `SELECT *,date::text FROM family_chore_occurrences WHERE household_id=$1 AND chore_id=$2 AND date=$3::date
          ORDER BY (status<>'skipped') DESC,updated_at DESC LIMIT 1 FOR SHARE`, [delivery.household_id, delivery.chore_id, delivery.date]);
      if (!occurrence || occurrence.chore_id !== delivery.chore_id || occurrence.date !== delivery.date || occurrence.person_id !== delivery.person_id
        || session.kind === 'child' && occurrence.person_id !== session.person_id) return suppress('occurrence_changed');
      // Today's immutable definition, not the editable recurring routine, owns
      // identity and recipients. A queued reminder survives step progress, but
      // rescheduling or submission/completion always invalidates it.
      if (['chore_due_soon', 'chore_overdue'].includes(delivery.type)) {
        if (occurrence.status !== 'pending' || occurrence.routine_version !== delivery.payload.choreVersion
          || delivery.payload.dueTime && occurrence.due_time !== delivery.payload.dueTime) return suppress('completion_changed');
      } else if (occurrence.completion_version !== delivery.payload.completionVersion
        || ['submitted', 'completed'].includes(occurrence.status) !== delivery.payload.completed
        || delivery.payload.occurrenceVersion !== undefined && occurrence.version !== delivery.payload.occurrenceVersion
        || delivery.payload.occurrenceStatus && occurrence.status !== delivery.payload.occurrenceStatus) return suppress('completion_changed');
    } else if (session.kind === 'child' && ![...childNetworkKinds, ...childDailyKinds].includes(delivery.type)) return suppress('recipient_scope');
    const row = await one(client, 'SELECT * FROM family_account_notification_preferences WHERE household_id=$1 AND user_id=$2', [session.household_id, session.user_id]);
    const preferences = preferencesDto(row, delivery.timezone);
    if (!preferences.pushEnabled || !preferences[preferenceForKind[delivery.type]]) return suppress('preference_disabled');
    const resume = quietUntil(now, delivery.timezone, preferences.quietStart, preferences.quietEnd);
    if (resume) {
      if (resume >= new Date(delivery.expires_at)) return suppress('quiet_hours_expired');
      await client.query("UPDATE family_notification_deliveries SET state='pending',available_at=$2,lease_id=NULL,lease_until=NULL,last_error='quiet_hours' WHERE id=$1", [delivery.id, resume]);
      return 'deferred';
    }
    let token;
    try {
      const credentials = decryptCredentials(delivery.household_id, delivery.credentials, env);
      if (credentials.purpose !== 'apns-device') return suppress('installation_invalid');
      token = credentials.token;
    } catch { return suppress('installation_unavailable'); }
    let result;
    try { result = await send({ token, environment: delivery.environment, notificationId: delivery.id, expiresAt: delivery.expires_at, payload: lockScreenPayload(delivery.account_notification_id || delivery.inbox_id, preferences.showDetails ? delivery : undefined) }, env); }
    catch { result = { accepted: false, status: 0, reason: 'transport_error' }; }
    const decision = classifyApnsResult(result, delivery.attempts + 1);
    if (decision.disable) await client.query('UPDATE family_push_installations SET disabled_at=$2 WHERE id=$1 AND registered_at=$3::timestamptz', [delivery.installation_id, now, delivery.registered_version]);
    await client.query(`UPDATE family_notification_deliveries SET state=$2,attempts=attempts+1,available_at=$3,
      accepted_at=$4,last_error=$5,lease_id=NULL,lease_until=NULL WHERE id=$1`, [delivery.id, decision.state,
      decision.retrySeconds ? new Date(now.getTime() + decision.retrySeconds * 1000) : now, decision.state === 'accepted' ? now : null, decision.reason]);
    return decision.state;
  });
}

export async function processNotifications(db, { env = process.env, now = new Date(), send } = {}) {
  now = new Date(now);
  requireValue(Number.isFinite(now.getTime()), 422, 'invalid_date', 'Use a valid notification scan time.');
  const counts = { eventsCreated: 0, inboxCreated: 0, accepted: 0, pending: 0, failed: 0, suppressed: 0, deferred: 0, skipped: 0, pushConfigured: true };
  const households = (await db.query('SELECT id,title,timezone FROM family_households ORDER BY id')).rows;
  for (const household of households) counts.eventsCreated += await scanHousehold(db, household, now);
  counts.inboxCreated = await fanOut(db, now);
  if (!send) {
    try { await preflightApns(env, now); } catch { counts.pushConfigured = false; return counts; }
  }
  const leases = await claimDeliveries(db, now);
  // Bound a cron request to at most four waves of three six-second APNs requests.
  for (let index = 0; index < leases.length; index += 3) {
    const results = await Promise.all(leases.slice(index, index + 3).map(lease => deliver(db, lease, env, now, send || sendApns)));
    for (const result of results) counts[result]++;
  }
  return counts;
}
