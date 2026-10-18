import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { ApiError, requireValue, uuidField } from './errors.js';
import { decryptCredentials, digest, encryptCredentials, keyedDigest } from './credentials.js';
import { one, transaction } from './database.js';
import { classifyApnsResult, preflightApns, sendApns } from './apns.js';
import { activeMobileSessionSql as activeSession } from './mobile.js';

const preferenceColumns = Object.freeze({ pushEnabled: 'push_enabled', choreCompleted: 'chore_completed', choreReopened: 'chore_reopened',
  choreDueSoon: 'chore_due_soon', choreOverdue: 'chore_overdue', calendarEvents: 'calendar_events', frameStatus: 'frame_status' });
const preferenceForKind = { chore_completed: 'choreCompleted', chore_reopened: 'choreReopened', chore_due_soon: 'choreDueSoon',
  chore_overdue: 'choreOverdue', calendar_upcoming: 'calendarEvents', calendar_unavailable: 'calendarEvents', calendar_restored: 'calendarEvents', frame_offline: 'frameStatus', frame_online: 'frameStatus' };
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
  return transaction(db, async client => {
    const session = await checkedSession(client, principal, new Date(), 'FOR SHARE OF s');
    await client.query('INSERT INTO family_notification_preferences(mobile_session_id,household_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [session.id, session.household_id]);
    const row = await one(client, 'SELECT * FROM family_notification_preferences WHERE mobile_session_id=$1 AND household_id=$2 FOR UPDATE', [session.id, session.household_id]);
    const current = preferencesDto(row, principal.household.timezone);
    if (body === undefined) return current;
    const value = validatePreferences(body, current);
    const keys = Object.entries(preferenceColumns);
    await client.query(`UPDATE family_notification_preferences SET ${keys.map(([, column], i) => `${column}=$${i + 3}`).join(',')},
      quiet_start=$10::time,quiet_end=$11::time,updated_at=now() WHERE mobile_session_id=$1 AND household_id=$2`,
    [session.id, session.household_id, ...keys.map(([key]) => value[key]), value.quietStart, value.quietEnd]);
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

export function notificationText(event) {
  const chore = String(event.payload?.title || 'A chore').slice(0, 160);
  const labels = {
    chore_completed: ['Chore completed', `${chore} was marked done.`], chore_reopened: ['Chore reopened', `${chore} was reopened.`],
    chore_due_soon: ['Chore due soon', `${chore} is due soon.`], chore_overdue: ['Chore overdue', `${chore} has not been marked done.`],
    calendar_upcoming: ['Calendar reminder', `${String(event.payload?.title || 'An event').slice(0, 160)} starts soon.`],
    calendar_unavailable: ['Calendar needs attention', 'The calendar has not synced recently. Check its connection in Setup.'],
    calendar_restored: ['Calendar restored', 'Your calendar is syncing again.'],
    frame_offline: ['Frame may be offline', 'Your frame has not checked in recently.'], frame_online: ['Frame connected', 'Your frame is connected again.'],
  };
  return labels[event.type] || ['Family update', 'There is a new family update.'];
}

export async function notificationInbox(db, principal) {
  const session = await checkedSession(db, principal);
  const rows = (await db.query(`SELECT i.id,i.created_at,i.read_at,e.type,e.chore_id,e.date::text,e.payload FROM family_notification_inbox i
    JOIN family_notification_events e ON e.id=i.event_id
    WHERE i.mobile_session_id=$1 AND i.household_id=$2 AND ($3::uuid IS NULL OR (e.person_id=$3 AND EXISTS
      (SELECT 1 FROM family_chores c WHERE c.id=e.chore_id AND c.household_id=i.household_id AND c.person_id=$3 AND c.deleted_at IS NULL)))
    ORDER BY i.created_at DESC,i.id DESC LIMIT 100`, [session.id, session.household_id, session.kind === 'child' ? session.person_id : null])).rows;
  return { notifications: rows.map(row => { const [title, body] = notificationText(row); return { id: row.id, kind: row.type, title, body,
    choreId: row.chore_id || null, date: row.date || null, createdAt: iso(row.created_at), readAt: row.read_at ? iso(row.read_at) : null }; }) };
}

export async function markNotificationRead(db, principal, id) {
  uuidField(id);
  const session = await checkedSession(db, principal);
  const row = await one(db, `UPDATE family_notification_inbox i SET read_at=coalesce(i.read_at,now()) FROM family_notification_events e
    WHERE i.id=$1 AND i.event_id=e.id AND i.mobile_session_id=$2 AND i.household_id=$3 AND ($4::uuid IS NULL OR (e.person_id=$4 AND EXISTS
      (SELECT 1 FROM family_chores c WHERE c.id=e.chore_id AND c.household_id=i.household_id AND c.person_id=$4 AND c.deleted_at IS NULL))) RETURNING i.id`,
  [id, session.id, session.household_id, session.kind === 'child' ? session.person_id : null]);
  if (!row) throw notFound();
  return { read: true };
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
    const inserted = await one(client, 'INSERT INTO family_notification_scan_state(household_id,scanned_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING household_id', [household.id, now]);
    const checkpoint = await one(client, 'SELECT * FROM family_notification_scan_state WHERE household_id=$1 FOR UPDATE', [household.id]);
    if (new Date(checkpoint.scanned_at) > now) return 0;
    const since = new Date(Math.max(new Date(checkpoint.scanned_at).getTime(), now.getTime() - 24 * 3600_000));
    let events = 0;
    if (!inserted) {
      const chores = (await client.query('SELECT * FROM family_chores WHERE household_id=$1 AND deleted_at IS NULL AND due_time IS NOT NULL', [household.id])).rows;
      const completed = (await client.query(`SELECT chore_id,date::text FROM family_completions WHERE household_id=$1 AND completed
        AND date BETWEEN $2::date AND $3::date`, [household.id, localDate(since, household.timezone).subtract({ days: 1 }).toString(), localDate(now, household.timezone).add({ days: 1 }).toString()])).rows;
      const done = new Set(completed.map(row => `${row.chore_id}:${row.date}`));
      for (const chore of chores) for (const occurrence of choreOccurrences(chore, household.timezone, since, now)) {
        if (done.has(`${chore.id}:${occurrence.date}`)) continue;
        events += await insertEvent(client, { householdId: household.id, key: `${occurrence.type}:${chore.id}:${chore.version}:${occurrence.date}`,
          type: occurrence.type, personId: chore.person_id, choreId: chore.id, date: occurrence.date, at: occurrence.at,
          expiresAt: occurrence.type === 'chore_due_soon' ? occurrence.due : new Date(occurrence.due.getTime() + 6 * 3600_000),
          payload: { title: chore.title, choreVersion: chore.version } });
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
    if (!inserted && healthy) for (const item of cache.snapshot.events || []) {
      if (item.allDay || !item.startAt || !Number.isFinite(Date.parse(item.startAt))) continue;
      const start = new Date(item.startAt);
      const at = new Date(start.getTime() - 10 * 60_000);
      // A cache may recover after the ten-minute threshold. Catch up while the
      // event is still upcoming; the occurrence key prevents repeat reminders.
      if (at <= now && start > now) events += await insertEvent(client, { householdId: household.id,
        key: `calendar_upcoming:${digest(`${item.calendarId}:${item.id}:${item.startAt}`)}`, type: 'calendar_upcoming', at, expiresAt: start, payload: { title: String(item.title || 'An event').slice(0, 160) } });
    }
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
    const inbox = await client.query(`INSERT INTO family_notification_inbox(id,event_id,household_id,mobile_session_id,created_at)
      SELECT gen_random_uuid(),e.id,e.household_id,s.id,e.occurred_at FROM family_notification_events e
      JOIN family_mobile_sessions s ON s.household_id=e.household_id WHERE e.id=ANY($1::uuid[]) AND ${activeSession()}
      AND s.created_at<=e.occurred_at AND (s.kind='parent' OR s.person_id=e.person_id)
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

export function lockScreenPayload(notificationId) {
  // Deliberately excludes names, calendar/chore titles, assignments, and dates.
  return { aps: { alert: { title: 'Family Frame', body: 'Your family has an update. Open Family Frame to see it.' }, sound: 'default', category: 'FAMILY_UPDATE', 'thread-id': 'family-frame' }, notificationId };
}

async function deliver(db, lease, env, now, send) {
  return transaction(db, async client => {
    const delivery = await one(client, `SELECT d.*,i.mobile_session_id,i.household_id,e.id AS event_id,e.type,e.person_id,e.chore_id,e.date::text,e.payload,e.expires_at,
      p.credentials,p.environment,p.registered_at::text AS registered_version,p.disabled_at,p.mobile_session_id AS installation_session,h.timezone FROM family_notification_deliveries d
      JOIN family_notification_inbox i ON i.id=d.inbox_id JOIN family_notification_events e ON e.id=i.event_id
      JOIN family_push_installations p ON p.id=d.installation_id JOIN family_households h ON h.id=i.household_id
      WHERE d.id=$1 AND d.state='leased' AND d.lease_id=$2 FOR UPDATE OF d`, [lease.id, lease.leaseId]);
    if (!delivery) return 'skipped';
    const suppress = async reason => { await client.query("UPDATE family_notification_deliveries SET state='suppressed',last_error=$2,lease_id=NULL,lease_until=NULL WHERE id=$1", [delivery.id, reason]); return 'suppressed'; };
    const session = await one(client, `SELECT s.* FROM family_mobile_sessions s WHERE s.id=$1 AND ${activeSession()} AND s.household_id=$3 FOR SHARE OF s`, [delivery.mobile_session_id, now, delivery.household_id]);
    if (!session || delivery.disabled_at || delivery.installation_session !== delivery.mobile_session_id) return suppress('recipient_inactive');
    if (new Date(delivery.expires_at) <= now) return suppress('expired');
    if (delivery.attempts >= 6) return suppress('attempt_limit');
    if (delivery.chore_id) {
      const chore = await one(client, 'SELECT * FROM family_chores WHERE id=$1 AND household_id=$2 FOR SHARE', [delivery.chore_id, delivery.household_id]);
      if (!chore || chore.deleted_at || chore.version !== delivery.payload.choreVersion || session.kind === 'child' && chore.person_id !== session.person_id) return suppress('chore_changed');
      // Match setCompletion's lock order (chore, then completion advisory lock) and hold through APNs acceptance.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`completion:${delivery.household_id}:${delivery.chore_id}:${delivery.date}`]);
      const completion = await one(client, 'SELECT completed,version FROM family_completions WHERE household_id=$1 AND chore_id=$2 AND date=$3::date', [delivery.household_id, delivery.chore_id, delivery.date]);
      if (['chore_due_soon', 'chore_overdue'].includes(delivery.type) ? completion?.completed : completion?.version !== delivery.payload.completionVersion || completion?.completed !== delivery.payload.completed) return suppress('completion_changed');
    } else if (session.kind === 'child') return suppress('recipient_scope');
    const row = await one(client, 'SELECT * FROM family_notification_preferences WHERE mobile_session_id=$1 AND household_id=$2', [session.id, session.household_id]);
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
    try { result = await send({ token, environment: delivery.environment, notificationId: delivery.id, expiresAt: delivery.expires_at, payload: lockScreenPayload(delivery.inbox_id) }, env); }
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
