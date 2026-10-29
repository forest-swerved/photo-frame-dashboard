import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { one, transaction } from './database.js';
import { digest } from './credentials.js';
import { requireHousehold } from './auth.js';
import { parentCapabilities, requireCapability } from './capabilities.js';
import { ApiError, dateField, householdDate, requireValue, textField, uuidField, versionField } from './errors.js';
import { ensureDailyOccurrences, getRequiredProgress, lockChoreDay } from './chore-occurrences.js';
import { normalizedMac, unifiConfiguration, managementHost as configuredManagementHost, networkChecksPassed, applePushReady, parentAcceptedSetup } from './unifi.js';

const iso = value => value ? new Date(value).toISOString() : null;
const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const terminal = new Set(['ended', 'failed']);
const notFound = () => new ApiError(404, 'not_found', 'That item does not exist in your family.');
const timeField = value => value === null || typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export const preparationBufferSeconds = 5 * 60;
// Persisted in the existing server-only session snapshot. Old sessions have no buffer.
export function preparationRemaining(row, now = new Date()) {
  if (row.all_day || terminal.has(row.state)) return 0;
  const prep = row.policy_snapshot?.preparation;
  if (!prep || !Number.isFinite(prep.remainingSeconds)) return 0;
  if (row.state === 'paused' || !row.ends_at) return Math.max(0, prep.remainingSeconds);
  const end = Date.parse(prep.endsAt);
  return Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : 0;
}
export const defaultRewardPolicy = personId => ({ personId, version: 0, enabled: true, rewardMinutes: 60, carryoverDays: 7, dailyLimitMinutes: 180, bedtime: null, warningMinutes: 5 });
export const policyDto = row => row ? ({ personId: row.person_id, version: row.version, enabled: row.enabled, rewardMinutes: row.reward_minutes,
  carryoverDays: row.carryover_days, dailyLimitMinutes: row.daily_limit_minutes, bedtime: row.bedtime?.slice(0, 5) || null, warningMinutes: row.warning_minutes }) : null;
export const creditDto = row => ({ id: row.id, personId: row.person_id, earnedDate: day(row.earned_date), minutes: row.minutes,
  status: row.status, expiresAt: iso(row.expires_at), policyVersion: row.policy_version });
export const sessionDto = row => ({ id: row.id, personId: row.person_id, deviceId: row.device_id, creditId: row.credit_id, source: row.source,
  state: row.state, version: row.version, desiredState: row.desired_state, observedState: row.observed_state, requestedAt: iso(row.requested_at),
  startedAt: iso(row.started_at), endsAt: iso(row.ends_at), remainingSeconds: row.remaining_seconds, verifiedAt: iso(row.verified_at),
  endedAt: iso(row.ended_at), reason: row.reason, lastError: row.last_error, allDay: row.all_day,
  preparationRemainingSeconds: row.all_day ? 0 : row.policy_snapshot?.preparation?.remainingSeconds || 0,
  preparationEndsAt: row.all_day ? null : row.policy_snapshot?.preparation?.endsAt || null,
  grantedSeconds: row.allocated_seconds });
export const deviceDto = (row, parent = false) => ({ id: row.id, name: row.name, kind: row.kind, personIds: row.person_ids, version: row.version,
  defaultAccess: row.default_access || 'blocked', rewardAvailable: row.reward_available === true,
  desiredAccess: row.desired_access || 'blocked', observedAccess: row.observed_access || 'unknown',
  accessVerifiedAt: iso(row.access_verified_at), accessPending: row.access_pending === true, accessError: row.access_error || null,
  allowApplePush: row.allow_apple_push === true,
  controlState: row.control_state, online: row.online, lastSeenAt: iso(row.last_seen_at), managementAccessVerifiedAt: iso(row.management_verified_at),
  ...(parent ? { macAddresses: row.mac_addresses } : {}) });

export function nextDayStart(date, timezone, days = 1) {
  return new Date(Temporal.PlainDate.from(date).add({ days }).toZonedDateTime({ timeZone: timezone, plainTime: '00:00' }).epochMilliseconds);
}
export function validateTimedWindow(startAt, endsAt, timezone, { allDay = false } = {}) {
  if (allDay) return;
  try {
    const start = Temporal.Instant.from(new Date(startAt).toISOString()).toZonedDateTimeISO(timezone);
    const end = Temporal.Instant.from(new Date(endsAt).toISOString()).toZonedDateTimeISO(timezone);
    start.toPlainDateTime().toZonedDateTime(timezone, { disambiguation: 'reject' });
    end.toPlainDateTime().toZonedDateTime(timezone, { disambiguation: 'reject' });
    if (start.offset !== end.offset) throw Error('clock transition');
    if (start.hour === end.hour && start.minute === end.minute) throw Error('equal schedule times');
  } catch {
    throw new ApiError(422, 'dst_window_unrepresentable', 'This timed window crosses an ambiguous clock change. Choose All day or start after the clock change.');
  }
}
export function sessionDeadline(now, timezone, seconds, { allDay = false, bedtime = null, roundUp = false } = {}) {
  now = new Date(now);
  const today = householdDate(timezone, now);
  const midnight = nextDayStart(today, timezone);
  let end = allDay ? midnight : new Date(now.getTime() + seconds * 1000);
  let cutoff = null;
  if (!allDay && bedtime) {
    cutoff = new Date(Temporal.PlainDate.from(today).toPlainDateTime(bedtime).toZonedDateTime(timezone, { disambiguation: 'earlier' }).epochMilliseconds);
    requireValue(cutoff > now && end <= cutoff, 409, 'bedtime_limit', 'This reward does not fit before bedtime. Ask a parent to adjust the limit.');
  }
  // Gateway schedules have minute precision. A free preparation phase absorbs
  // upward rounding so the child's granted usage time is never shortened.
  end = new Date((roundUp && !allDay ? Math.ceil : Math.floor)(end.getTime() / 60_000) * 60_000);
  if (cutoff) requireValue(end <= cutoff, 409, 'bedtime_limit', 'This reward does not fit before bedtime. Ask a parent to adjust the limit.');
  requireValue(end - now >= 30_000 && (allDay ? end - now <= 90000_000 : end - now < 86400_000),
    422, 'invalid_duration', 'Choose a window shorter than 24 hours, or All day until household midnight.');
  validateTimedWindow(now, end, timezone, { allDay });
  return end;
}

export function scheduleSupport(integration, timezone, now = new Date()) {
  const today = householdDate(timezone, now), start = nextDayStart(today, timezone, 0), end = nextDayStart(today, timezone);
  const overnight = integration?.pilot_checks?.midnight === true;
  return { overnight, allDay: overnight && (end - start === 86400_000 || integration?.pilot_checks?.dst === true) };
}
export function requireScheduleSupport(integration, timezone, start, end, { allDay = false } = {}) {
  const support = scheduleSupport(integration, timezone, start);
  if (allDay) requireValue(support.allDay, 409, 'schedule_unverified', 'All-day access is not enabled yet. Choose a timed window ending today.');
  else requireValue(householdDate(timezone, start) === householdDate(timezone, end) || support.overnight,
    409, 'schedule_unverified', 'Overnight access is not enabled yet. Choose a window ending before household midnight.');
}

export function validateRewardPolicy(body, current) {
  const value = { ...current };
  for (const [key, min, max] of [['rewardMinutes', 1, 1439], ['carryoverDays', 0, 365], ['dailyLimitMinutes', 1, 1440], ['warningMinutes', 0, 60]]) {
    if (body[key] !== undefined) value[key] = body[key];
    requireValue(Number.isInteger(value[key]) && value[key] >= min && value[key] <= max, 422, 'invalid_policy', `${key} must be between ${min} and ${max}.`);
  }
  if (body.enabled !== undefined) value.enabled = body.enabled;
  requireValue(typeof value.enabled === 'boolean', 422, 'invalid_policy', 'Enabled must be true or false.');
  if (body.bedtime !== undefined) value.bedtime = body.bedtime;
  requireValue(timeField(value.bedtime), 422, 'invalid_policy', 'Bedtime uses HH:mm, or null for no cutoff.');
  return value;
}

export async function internetEvent(client, { householdId, personId = null, sessionId = null, deviceId = null, type, actor, reason = null, details = {}, now = new Date() }) {
  await client.query(`INSERT INTO family_internet_events(id,household_id,person_id,session_id,device_id,type,actor,reason,details,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`, [randomUUID(), householdId, personId, sessionId, deviceId, type, actor, reason, JSON.stringify(details), now]);
}
async function notificationActor(client, principal) {
  const member = await one(client, `SELECT m.user_id,m.name FROM family_members m WHERE m.household_id=$1 AND m.revoked_at IS NULL
    AND m.user_id=CASE WHEN $3::uuid IS NULL THEN $2 ELSE (SELECT created_by FROM family_frame_authorizations WHERE household_id=$1 AND id=$3) END`,
    [principal.household.id, principal.user?.id || null, principal.verifiedFrameGrant?.id || null]);
  return { actorName: member?.name || principal.user?.name || 'A parent', excludeUserId: member?.user_id || principal.user?.id };
}

export async function internetNotification(client, { householdId, personId, type, key, sessionId, creditId, deviceId, actorName, excludeUserId, payload = {}, now = new Date() }) {
  const context = await one(client, `SELECT p.name AS person_name,d.name AS device_name,d.kind AS device_kind,s.source,s.state,s.ends_at,s.started_at,s.remaining_seconds,s.allocated_seconds,s.all_day,s.policy_snapshot,h.timezone
    FROM family_people p JOIN family_households h ON h.id=p.household_id LEFT JOIN family_internet_sessions s ON s.household_id=p.household_id AND s.id=$3
    LEFT JOIN family_managed_devices d ON d.household_id=p.household_id AND d.id=coalesce($4::uuid,s.device_id)
    WHERE p.household_id=$1 AND p.id=$2`, [householdId, personId, sessionId || null, deviceId || null]);
  const preparationSeconds = context ? preparationRemaining(context,now) : 0;
  const totalRemaining = context?.state==='paused' ? context.remaining_seconds : context?.ends_at ? Math.max(0,Math.ceil((new Date(context.ends_at)-now)/1000)) : context?.remaining_seconds;
  payload = { personName:context?.person_name, deviceName:context?.device_name, deviceKind:context?.device_kind,
    source:context?.source, minutes:context?.allocated_seconds / 60, allDay:context?.all_day,
    timezone:context?.timezone, endsAt:iso(context?.ends_at), startedAt:iso(context?.started_at),
    usageRemainingSeconds:Math.max(0,(totalRemaining || 0)-preparationSeconds), preparationSeconds,
    paused:context?.state==='paused', ...(deviceId ? {deviceId} : {}), actorName, excludeUserId, ...payload };
  await client.query(`INSERT INTO family_notification_events(id,household_id,event_key,type,person_id,payload,occurred_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(household_id,event_key) DO NOTHING`,
  [randomUUID(), householdId, key, type, personId, JSON.stringify({ ...payload, ...(sessionId ? { sessionId } : {}), ...(creditId ? { creditId } : {}) }), now, new Date(now.getTime() + 86400_000)]);
}

async function earningSourcesEligible(client, householdId, personId, date, occurrenceIds) {
  const sources = (await client.query(`SELECT o.id,o.status,o.person_id,
    o.approved_at>=($3::date::timestamp AT TIME ZONE h.timezone) AS approved_on_or_after_day
    FROM family_chore_occurrences o JOIN family_households h ON h.id=o.household_id
    WHERE o.household_id=$1 AND o.id=ANY($2::uuid[])`, [householdId, occurrenceIds, date])).rows;
  // Former clients could write future completion dates. Import those facts for
  // history, but never turn a completion recorded before that day into a reward.
  return sources.length === occurrenceIds.length && sources.some(row => row.status === 'completed' && row.approved_on_or_after_day)
    && sources.every(row => row.person_id === personId && (row.status === 'skipped' || row.status === 'completed' && row.approved_on_or_after_day));
}
async function creditEligible(client, credit) {
  const progress = await getRequiredProgress(client, credit.household_id, credit.person_id, day(credit.earned_date));
  return progress.eligible && earningSourcesEligible(client, credit.household_id, credit.person_id, day(credit.earned_date), credit.occurrence_ids);
}

// Invoked inside the occurrence transaction and its household-day lock. Only
// today's approved work earns a daily credit; historical corrections do not.
export async function syncChoreReward(client, change, { now = new Date() } = {}) {
  if (!change.personId) return;
  const household = await one(client, 'SELECT id,timezone FROM family_households WHERE id=$1', [change.householdId]);
  const today = householdDate(household.timezone, now);
  if (![change.date, ...(change.affectedDates || [])].map(day).includes(today)) return;
  await lockChoreDay(client, household.id, today);
  await notifyDailyCompletion(client, household, change.personId, today, now);
  const progress = await getRequiredProgress(client, household.id, change.personId, today);
  const existing = await one(client, 'SELECT * FROM family_reward_credits WHERE household_id=$1 AND person_id=$2 AND earned_date=$3::date FOR UPDATE', [household.id, change.personId, today]);
  if (existing) {
    if (['available', 'held'].includes(existing.status)) await client.query('UPDATE family_reward_credits SET status=$2 WHERE id=$1',
      [existing.id, new Date(existing.expires_at) <= now ? 'expired' : await creditEligible(client, existing) ? 'available' : 'held']);
    return;
  }
  if (!progress.eligible) return;
  if (!await earningSourcesEligible(client, household.id, change.personId, today, progress.occurrenceIds)) return;
  await client.query('INSERT INTO family_reward_policies(household_id,person_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [household.id, change.personId]);
  const policy = policyDto(await one(client, 'SELECT * FROM family_reward_policies WHERE household_id=$1 AND person_id=$2', [household.id, change.personId]));
  if (!policy.enabled) return;
  const id = randomUUID();
  await client.query(`INSERT INTO family_reward_credits(id,household_id,person_id,earned_date,minutes,policy_version,policy_snapshot,occurrence_ids,status,expires_at)
    VALUES($1,$2,$3,$4::date,$5,$6,$7::jsonb,$8,'available',$9)`,
  [id, household.id, change.personId, today, policy.rewardMinutes, policy.version, JSON.stringify(policy), progress.occurrenceIds, nextDayStart(today, household.timezone, policy.carryoverDays + 1)]);
  await internetEvent(client, { householdId: household.id, personId: change.personId, type: 'reward_earned', actor: change.actor || 'system:chores', details: { creditId: id, minutes: policy.rewardMinutes, date: today }, now });
  await internetNotification(client, { householdId: household.id, personId: change.personId, type: 'reward_earned', key: `reward:${change.personId}:${today}`, creditId: id, payload: { minutes: policy.rewardMinutes }, now });
}

export async function notifyDailyCompletion(client, household, personId, date, now) {
  const totals = await one(client, `SELECT count(*)::int AS total,bool_and(status='completed') AS complete
    FROM family_chore_occurrences WHERE household_id=$1 AND person_id=$2 AND date=$3::date AND status<>'skipped'`, [household.id, personId, date]);
  if (totals.total && totals.complete) await internetNotification(client, { householdId: household.id, personId,
    type: 'daily_tasks_completed', key: `daily-complete:${personId}:${date}`, payload: { date, audience: 'parents', total: totals.total }, now });
}

export const accessRequestDto = row => ({ id: row.id, personId: row.person_id, deviceId: row.device_id, minutes: row.minutes,
  reason: row.reason, status: row.status, version: row.version, requestedAt: iso(row.requested_at), expiresAt: iso(row.expires_at),
  decidedAt: iso(row.decided_at), sessionId: row.session_id });

export async function internetSnapshot(db, principal, { env = process.env, now = new Date() } = {}) {
  const householdId = requireHousehold(principal), capabilities = await parentCapabilities(db, principal);
  const parent = capabilities.manageInternet;
  const personFilter = principal.role === 'child' ? principal.personId : null;
  const date = householdDate(principal.household.timezone, now);
  return transaction(db, async client => {
    const people = (await client.query('SELECT id FROM family_people WHERE household_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY id', [householdId, personFilter])).rows;
    await ensureDailyOccurrences(client, principal.household, date, { now });
    for (const person of people) await syncChoreReward(client, { householdId, personId: person.id, date, actor: 'system:chores' }, { now });
    await client.query("UPDATE family_reward_credits SET status='expired' WHERE household_id=$1 AND status IN ('available','held') AND expires_at<=$2", [householdId, now]);
    const policies = await client.query('SELECT * FROM family_reward_policies WHERE household_id=$1 AND ($2::uuid IS NULL OR person_id=$2)', [householdId, personFilter]);
    const credits = await client.query('SELECT *,earned_date::text FROM family_reward_credits WHERE household_id=$1 AND ($2::uuid IS NULL OR person_id=$2) ORDER BY created_at DESC LIMIT 100', [householdId, personFilter]);
    for (const credit of credits.rows) if (['available', 'held'].includes(credit.status)) {
      const status = await creditEligible(client, credit) ? 'available' : 'held';
      if (status !== credit.status) {
        const changed = await one(client, "UPDATE family_reward_credits SET status=$2 WHERE id=$1 AND status IN ('available','held') RETURNING status", [credit.id, status]);
        credit.status = changed?.status || (await one(client, 'SELECT status FROM family_reward_credits WHERE id=$1', [credit.id])).status;
      }
    }
    const devices = await client.query(`SELECT d.*,
      EXISTS(SELECT 1 FROM family_internet_commands c WHERE c.device_id=d.id AND c.state IN ('pending','leased','attention')) AS access_pending,
      d.default_access='blocked' AND d.desired_access='blocked' AND d.control_state='ready' AND d.management_verified_at IS NOT NULL
      AND d.observed_access='blocked' AND d.access_verified_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM family_internet_commands c WHERE c.device_id=d.id AND c.state IN ('pending','leased','attention'))
      AND NOT EXISTS(SELECT 1 FROM family_internet_sessions s WHERE s.household_id=d.household_id AND s.device_id=d.id AND s.state NOT IN ('ended','failed'))
      AND coalesce((SELECT s.observed_state='blocked' AND s.verified_at IS NOT NULL FROM family_internet_sessions s WHERE s.household_id=d.household_id AND s.device_id=d.id ORDER BY s.requested_at DESC,s.id DESC LIMIT 1),true) AS reward_available
      FROM family_managed_devices d WHERE d.household_id=$1 AND d.removed_at IS NULL AND ($2::uuid IS NULL OR $2=ANY(d.person_ids)) ORDER BY d.name,d.id`, [householdId, personFilter]);
    await client.query("UPDATE family_access_requests SET status='expired',version=version+1 WHERE household_id=$1 AND status='pending' AND expires_at<=$2", [householdId, now]);
    const requests = await client.query("SELECT * FROM family_access_requests WHERE household_id=$1 AND ($2::uuid IS NULL OR person_id=$2) ORDER BY (status='pending') DESC,requested_at DESC LIMIT 100", [householdId, personFilter]);
    const sessions = await client.query('SELECT * FROM family_internet_sessions WHERE household_id=$1 AND ($2::uuid IS NULL OR person_id=$2) ORDER BY requested_at DESC LIMIT 100', [householdId, personFilter]);
    const integration = await one(client, 'SELECT * FROM family_network_integrations WHERE household_id=$1', [householdId]);
    let configured = false, managementHost = 'forest-family-frame.vercel.app';
    try { unifiConfiguration(env); managementHost = configuredManagementHost(env); configured = true; } catch { /* Inactive state is explicit. */ }
    const progress = [];
    for (const person of people) progress.push(await getRequiredProgress(client, householdId, person.id, date));
    return { serverTime: now.toISOString(), timezone: principal.household.timezone, role: principal.role, capabilities,
      integration: { state: !configured ? 'unconfigured' : integration?.state || 'pilot_required', managementHost,
        enrollmentBasis: parentAcceptedSetup(integration) ? 'parent_accepted' : 'pilot',
        scheduleSupport: scheduleSupport(integration, principal.household.timezone, now),
        managementAccessVerifiedAt: iso(integration?.management_verified_at), lastCheckedAt: iso(integration?.last_checked_at), error: integration?.last_error || null },
      policies: people.map(person => policyDto(policies.rows.find(p => p.person_id === person.id)) || defaultRewardPolicy(person.id)),
      credits: credits.rows.map(creditDto), devices: devices.rows.map(row => deviceDto(row, parent)), sessions: sessions.rows.map(sessionDto), requests: requests.rows.map(accessRequestDto), progress };
  });
}

async function idempotent(db, principal, body, operation, work) {
  const householdId = requireHousehold(principal); uuidField(body.mutationId, 'Mutation ID');
  // Explicit ordered entries make retries independent of JSON property order.
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const hash = digest(JSON.stringify({ operation, body: canonical(body) }));
  return transaction(db, async client => {
    // One household lock serializes credit/device/person reservations and
    // parent changes, including requests from separate installations.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${householdId}`]);
    const replay = await one(client, 'SELECT request_hash,response FROM family_mutations WHERE household_id=$1 AND actor=$2 AND mutation_id=$3', [householdId, principal.actor, body.mutationId]);
    if (replay) {
      requireValue(replay.request_hash === hash, 409, 'mutation_reused', 'Use a new request ID for a different change.');
      requireValue(principal.role !== 'child' || replay.response.personId === principal.personId, 404, 'not_found', 'That item does not exist in your family.');
      return replay.response;
    }
    const result = await work(client, householdId);
    await client.query('INSERT INTO family_mutations(household_id,actor,mutation_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)', [householdId, principal.actor, body.mutationId, hash, JSON.stringify(result)]);
    return result;
  });
}

export async function saveRewardPolicy(db, principal, personId, body) {
  await requireCapability(db, principal, 'manageInternet'); uuidField(personId); versionField(body.expectedVersion);
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${principal.household.id}`]);
    requireValue(await one(client, 'SELECT id FROM family_people WHERE household_id=$1 AND id=$2', [principal.household.id, personId]), 404, 'not_found', 'That child profile does not exist.');
    const row = await one(client, 'SELECT * FROM family_reward_policies WHERE household_id=$1 AND person_id=$2 FOR UPDATE', [principal.household.id, personId]);
    requireValue((row?.version || 0) === body.expectedVersion, 409, 'version_conflict', 'This policy changed. Refresh and try again.');
    const value = validateRewardPolicy(body, policyDto(row) || defaultRewardPolicy(personId));
    const changed = await one(client, `INSERT INTO family_reward_policies(household_id,person_id,enabled,reward_minutes,carryover_days,daily_limit_minutes,bedtime,warning_minutes)
      VALUES($1,$2,$3,$4,$5,$6,$7::time,$8) ON CONFLICT(household_id,person_id) DO UPDATE SET enabled=$3,reward_minutes=$4,carryover_days=$5,
      daily_limit_minutes=$6,bedtime=$7::time,warning_minutes=$8,version=family_reward_policies.version+1,updated_at=now() RETURNING *`,
    [principal.household.id, personId, value.enabled, value.rewardMinutes, value.carryoverDays, value.dailyLimitMinutes, value.bedtime, value.warningMinutes]);
    await internetEvent(client, { householdId: principal.household.id, personId, type: 'policy_changed', actor: principal.actor, details: policyDto(changed) });
    return policyDto(changed);
  });
}

export function deviceFields(body, current = {}) {
  const name = textField(body.name ?? current.name, 'Device name', 80);
  const kind = body.kind ?? current.kind ?? 'other';
  requireValue(['console', 'tablet', 'phone', 'computer', 'tv', 'other'].includes(kind), 422, 'invalid_device', 'Choose a device type.');
  const personIds = body.personIds ?? current.person_ids, macAddresses = body.macAddresses ?? current.mac_addresses;
  requireValue(Array.isArray(personIds) && personIds.length >= 1 && personIds.length <= 20, 422, 'invalid_device', 'Assign at least one child.');
  const defaultAccess = body.defaultAccess ?? current.default_access ?? 'blocked';
  requireValue(['blocked', 'allowed'].includes(defaultAccess), 422, 'invalid_device', 'Choose blocked or allowed by default.');
  requireValue(Array.isArray(macAddresses) && macAddresses.length >= 1 && macAddresses.length <= 8, 422, 'invalid_device', 'Enter one to eight stable device MAC addresses.');
  const allowApplePush = body.allowApplePush ?? current.allow_apple_push ?? ['tablet', 'phone'].includes(kind);
  requireValue(typeof allowApplePush === 'boolean', 422, 'invalid_device', 'Choose whether this Apple device needs notifications.');
  return { name, kind, defaultAccess, allowApplePush, personIds: [...new Set(personIds.map(id => uuidField(id, 'Child profile')))].sort(), macAddresses: [...new Set(macAddresses.map(normalizedMac))].sort() };
}
export async function saveManagedDevice(db, principal, id, body, remove = false) {
  await requireCapability(db, principal, 'manageInternet'); if (id) { uuidField(id); versionField(body.expectedVersion); }
  return idempotent(db, principal, body, `${remove ? 'remove' : 'save'}-device:${id || 'new'}`, async (client, householdId) => {
    const row = id ? await one(client, 'SELECT * FROM family_managed_devices WHERE household_id=$1 AND id=$2 AND removed_at IS NULL FOR UPDATE', [householdId, id]) : null;
    if (id && !row) throw notFound();
    if (row) {
      requireValue(row.version === body.expectedVersion, 409, 'version_conflict', 'This device changed. Refresh and try again.');
      requireValue(row.control_state === 'unenrolled', 409, 'device_enrolled', 'Remove network enrollment and confirm its policies before editing this device.');
    }
    if (remove) { await client.query('UPDATE family_managed_devices SET removed_at=now(),version=version+1 WHERE id=$1', [id]); return { deleted: true }; }
    const value = deviceFields(body, row || {});
    const people = (await client.query('SELECT id FROM family_people WHERE household_id=$1 AND id=ANY($2::uuid[])', [householdId, value.personIds])).rows;
    requireValue(people.length === value.personIds.length, 422, 'invalid_device', 'Every child must belong to this family.');
    requireValue(!await one(client, 'SELECT id FROM family_managed_devices WHERE household_id=$1 AND removed_at IS NULL AND mac_addresses && $2::text[] AND ($3::uuid IS NULL OR id<>$3)', [householdId, value.macAddresses, id]), 409, 'identity_in_use', 'This MAC address already belongs to a device.');
    const changed = row ? await one(client, `UPDATE family_managed_devices SET name=$3,kind=$4,person_ids=$5,mac_addresses=$6,allow_apple_push=$7,default_access=$8,desired_access=$8,version=version+1 WHERE household_id=$1 AND id=$2 RETURNING *`, [householdId, id, value.name, value.kind, value.personIds, value.macAddresses, value.allowApplePush, value.defaultAccess])
      : await one(client, `INSERT INTO family_managed_devices(id,household_id,name,kind,person_ids,mac_addresses,allow_apple_push,default_access,desired_access) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [randomUUID(), householdId, value.name, value.kind, value.personIds, value.macAddresses, value.allowApplePush, value.defaultAccess]);
    await internetEvent(client, { householdId, deviceId: changed.id, type: row ? 'device_changed' : 'device_added', actor: principal.actor });
    return deviceDto(changed, true);
  });
}

async function requireReady(client, householdId, device, env) {
  unifiConfiguration(env);
  const integration = await one(client, 'SELECT * FROM family_network_integrations WHERE household_id=$1', [householdId]);
  requireValue(integration?.state === 'ready' && integration.management_host === configuredManagementHost(env) && integration.management_verified_at
    && networkChecksPassed(integration, device.id)
    && (!device.allow_apple_push || applePushReady(integration, device.id) && device.apple_push_policy_id)
    && device.control_state === 'ready' && device.management_verified_at && device.management_policy_id && device.deny_policy_id && device.reviewed_policy_fingerprint,
  503, 'network_not_ready', 'A parent must finish the UniFi access and blocking checks before starting Internet time. Family Frame access must stay available.');
  return integration;
}
export async function queueInternetCommand(client, row, now) {
  await client.query(`UPDATE family_internet_commands SET state='superseded',lease_id=NULL,lease_until=NULL
    WHERE session_id=$1 AND session_version<>$2 AND state IN ('pending','attention')`, [row.id, row.version]);
  await client.query(`INSERT INTO family_internet_commands(id,household_id,session_id,session_version,action,available_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(session_id,session_version) DO NOTHING`, [randomUUID(), row.household_id, row.id, row.version, row.desired_state === 'allowed' ? 'allow' : 'block', now]);
}

export async function changeDeviceAccess(db, principal, id, body, { env = process.env, now = new Date() } = {}) {
  await requireCapability(db, principal, 'manageInternet'); uuidField(id); versionField(body.expectedVersion);
  requireValue(['allowed', 'blocked'].includes(body.access), 422, 'invalid_access', 'Choose Internet on or off.');
  return idempotent(db, principal, body, `device-access:${id}`, async (client, householdId) => {
    const device = await one(client, 'SELECT * FROM family_managed_devices WHERE household_id=$1 AND id=$2 AND removed_at IS NULL FOR UPDATE', [householdId, id]);
    if (!device) throw notFound();
    requireValue(device.version === body.expectedVersion, 409, 'version_conflict', 'This device changed. Refresh and try again.');
    await requireReady(client, householdId, device, env);
    const pending = (await client.query("SELECT * FROM family_internet_commands WHERE device_id=$1 AND state IN ('pending','leased','attention')", [id])).rows;
    requireValue(!pending.length || body.access === 'blocked' && pending.every(command => command.action === 'allow'),
      409, 'device_access_pending', 'Wait for the current device control to be confirmed.');
    if (pending.length) await client.query("UPDATE family_internet_commands SET available_at=$2 WHERE device_id=$1 AND state='pending'", [id, now]);
    // Finish every allowance first, including an ALLOW still awaiting confirmation.
    const sessions = (await client.query("SELECT * FROM family_internet_sessions WHERE household_id=$1 AND device_id=$2 AND state NOT IN ('ended','failed') FOR UPDATE", [householdId, id])).rows;
    for (const session of sessions) {
      const ending = await one(client, "UPDATE family_internet_sessions SET state='ending',desired_state='blocked',pending_action='end',version=version+1,last_error=NULL WHERE id=$1 RETURNING *", [session.id]);
      await queueInternetCommand(client, ending, now);
    }
    const changed = await one(client, "UPDATE family_managed_devices SET desired_access=$3,observed_access='unknown',access_error=NULL,version=version+1 WHERE household_id=$1 AND id=$2 RETURNING *", [householdId, id, body.access]);
    await client.query(`INSERT INTO family_internet_commands(id,household_id,device_id,session_version,action,available_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$6)`, [randomUUID(), householdId, id, changed.version, body.access === 'allowed' ? 'allow' : 'block', now]);
    await internetEvent(client, { householdId, deviceId: id, type: 'device_access_requested', actor: principal.actor, details: { access: body.access, version: changed.version }, now });
    if (body.access === 'allowed') for (const personId of device.person_ids) await internetNotification(client, {
      householdId, personId, deviceId: id, type: 'access_granted', key: `device-grant:${id}:${changed.version}:${personId}`,
      ...await notificationActor(client, principal), payload: { indefinite: true }, now });
    return deviceDto({ ...changed, access_pending: true }, true);
  });
}

export async function startInternetSession(db, principal, body, { reward = false, env = process.env, now = new Date() } = {}) {
  const parent = reward ? false : Boolean(await requireCapability(db, principal, 'manageInternet'));
  if (reward) requireValue(principal.role === 'child' && (['user', 'mobile'].includes(principal.authType) || principal.verifiedFrameGrant?.scope === 'child'),
    403, 'child_required', 'Use your own child account, or unlock your profile on the frame with your phone.');
  uuidField(body.deviceId, 'Device'); if (reward) uuidField(body.creditId, 'Reward'); else uuidField(body.personId, 'Child profile');
  return idempotent(db, principal, body, reward ? 'redeem' : 'grant', (client, householdId) =>
    createInternetSession(client, principal, body, { reward, parent, env, now, householdId }));
}

async function createInternetSession(client, principal, body, { reward = false, parent = true, env, now, householdId }) {
  let credit = null;
  if (reward) {
    credit = await one(client, 'SELECT *,earned_date::text FROM family_reward_credits WHERE household_id=$1 AND id=$2 AND person_id=$3', [householdId, body.creditId, principal.personId]);
    if (!credit) throw notFound();
    requireValue(credit.status === 'available' && new Date(credit.expires_at) > now, 409, 'reward_unavailable', 'This reward is no longer available. Refresh your tasks.');
    // Redemption rechecks the frozen earning day as well as today's work;
    // reopening or rescheduling a source task cannot bypass the ledger.
    await lockChoreDay(client, householdId, day(credit.earned_date));
    credit = await one(client, 'SELECT *,earned_date::text FROM family_reward_credits WHERE household_id=$1 AND id=$2 AND person_id=$3 FOR UPDATE', [householdId, body.creditId, principal.personId]);
    requireValue(credit?.status === 'available' && new Date(credit.expires_at) > now, 409, 'reward_unavailable', 'This reward is no longer available. Refresh your tasks.');
    requireValue(await creditEligible(client, credit), 409, 'chores_incomplete', 'Finish the required tasks for this reward before using it.');
  }
  const personId = credit?.person_id || body.personId;
  const device = await one(client, 'SELECT * FROM family_managed_devices WHERE household_id=$1 AND id=$2 AND removed_at IS NULL FOR UPDATE', [householdId, body.deviceId]);
  requireValue(device && device.person_ids.includes(personId), 404, 'not_found', 'That device is not assigned to this child.');
  requireValue(!reward || (device.default_access || 'blocked') === 'blocked', 409, 'device_not_reward', 'This device is controlled by parents and is not in the earned-time pool.');
  const integration = await requireReady(client, householdId, device, env);
  requireValue(device.desired_access === 'blocked' && device.observed_access === 'blocked' && device.access_verified_at
    && !await one(client, "SELECT id FROM family_internet_commands WHERE device_id=$1 AND state IN ('pending','leased','attention')", [device.id]),
  409, 'device_not_blocked', 'Choose a device whose Internet blocking is confirmed.');
  if (reward) {
    const last = await one(client, 'SELECT state,observed_state,verified_at FROM family_internet_sessions WHERE household_id=$1 AND device_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 1', [householdId, device.id]);
    requireValue(!last || terminal.has(last.state) && last.observed_state === 'blocked' && last.verified_at, 409, 'device_not_blocked', 'Choose a device whose Internet blocking is confirmed.');
  }
  requireValue(!await one(client, "SELECT id FROM family_internet_sessions WHERE household_id=$1 AND state NOT IN ('ended','failed') AND (person_id=$2 OR device_id=$3)", [householdId, personId, device.id]), 409, 'session_in_use', 'This child or device already has an Internet session.');
  const policy = policyDto(await one(client, 'SELECT * FROM family_reward_policies WHERE household_id=$1 AND person_id=$2', [householdId, personId])) || defaultRewardPolicy(personId);
  const allDay = parent && body.allDay === true;
  requireValue(body.allDay === undefined || typeof body.allDay === 'boolean', 422, 'invalid_duration', 'All day must be true or false.');
  const minutes = reward ? credit.minutes : body.minutes ?? 60;
  requireValue(Number.isInteger(minutes) && minutes >= 1 && minutes <= 1439, 422, 'invalid_duration', 'Choose 1–1439 minutes, or All day.');
  requireValue(allDay || minutes <= 1434, 422, 'invalid_duration', 'Choose 1–1434 usage minutes plus the free five-minute buffer, or All day.');
  const buffer = allDay ? 0 : preparationBufferSeconds;
  const candidateEnd = sessionDeadline(now, principal.household.timezone, minutes * 60 + buffer, { allDay, roundUp: !!buffer, bedtime: reward ? policy.bedtime : null });
  requireScheduleSupport(integration, principal.household.timezone, now, candidateEnd, { allDay });
  // Validate now, but plan a normal window only when the worker first owns
  // activation. Waiting in the durable queue cannot consume reserved time.
  const endsAt = allDay ? candidateEnd : null;
  const seconds = allDay ? Math.floor((candidateEnd - now) / 1000) : minutes * 60;
  if (reward) {
    requireValue(policy.enabled, 409, 'rewards_paused', 'A parent has paused Internet rewards.');
    const from = new Date(Temporal.PlainDate.from(householdDate(principal.household.timezone, now)).toZonedDateTime({ timeZone: principal.household.timezone, plainTime: '00:00' }).epochMilliseconds);
    const used = await one(client, "SELECT coalesce(sum(allocated_seconds),0)::int AS seconds FROM family_internet_sessions WHERE household_id=$1 AND person_id=$2 AND requested_at>=$3 AND state<>'failed'", [householdId, personId, from]);
    requireValue(used.seconds + seconds <= policy.dailyLimitMinutes * 60, 409, 'daily_limit', 'This reward exceeds today’s limit. Ask a parent for an adjustment.');
  }
  const id = randomUUID();
  const row = await one(client, `INSERT INTO family_internet_sessions(id,household_id,person_id,device_id,credit_id,source,state,desired_state,requested_at,ends_at,remaining_seconds,allocated_seconds,reason,all_day,policy_snapshot,created_by,pending_action)
    VALUES($1,$2,$3,$4,$5,$6,'starting','allowed',$7,$8,$9,$14,$10,$11,$12::jsonb,$13,'start') RETURNING *`,
  [id, householdId, personId, device.id, credit?.id || null, reward ? 'reward' : 'parent', now, endsAt, seconds + buffer, body.reason ? textField(body.reason, 'Reason', 500) : null, allDay,
    JSON.stringify({ ...policy, ...(!allDay ? { preparation: { remainingSeconds: buffer, endsAt: null } } : {}) }), principal.actor, seconds]);
  if (credit) await client.query("UPDATE family_reward_credits SET status='reserved',reserved_by=$2 WHERE id=$1", [credit.id, id]);
  await queueInternetCommand(client, row, now);
  await internetEvent(client, { householdId, personId, deviceId: device.id, sessionId: id, type: 'session_requested', actor: principal.actor, reason: row.reason, details: { endsAt: iso(endsAt), source: row.source }, now });
  if (parent && !body.requestId) await internetNotification(client, { householdId, personId, sessionId: id, type: 'access_granted',
    key: `grant:${id}`, ...await notificationActor(client, principal),
    payload: { minutes, allDay, reason: row.reason }, now });
  return sessionDto(row);
}

export async function changeInternetSession(db, principal, id, body, { now = new Date() } = {}) {
  await requireCapability(db, principal, 'manageInternet'); uuidField(id); versionField(body.expectedVersion);
  requireValue(['pause', 'resume', 'end', 'adjust', 'all_day'].includes(body.action), 422, 'invalid_action', 'Choose a session action.');
  return idempotent(db, principal, body, `session:${id}`, async (client, householdId) => {
    const row = await one(client, 'SELECT * FROM family_internet_sessions WHERE household_id=$1 AND id=$2 FOR UPDATE', [householdId, id]);
    if (!row) throw notFound();
    requireValue(row.version === body.expectedVersion, 409, 'version_conflict', 'This session changed. Refresh and try again.');
    requireValue(!terminal.has(row.state), 409, 'session_ended', 'This session has ended.');
    // Uncertain commands retain reservations and may only be ended. Never
    // issue another allow while a previous provider outcome is unresolved.
    requireValue(['active', 'paused'].includes(row.state) || body.action === 'end', 409, 'session_checking', 'The network is confirming this session. You may end it or wait.');
    let state, desired, endsAt = row.ends_at, remaining = row.remaining_seconds, allDay = row.all_day;
    let snapshot = row.policy_snapshot, buffer = preparationRemaining(row, now);
    const liveRemaining = row.state === 'paused' ? remaining : Math.max(0, Math.ceil((new Date(endsAt) - now) / 1000));
    const usageRemaining = Math.max(0, liveRemaining - buffer);
    let allocationDelta = 0;
    if (body.action === 'end') { state = 'ending'; desired = 'blocked'; }
    else if (body.action === 'pause') { requireValue(row.state === 'active', 409, 'invalid_state', 'Only an active session can pause.'); state = 'pausing'; desired = 'blocked'; }
    else if (body.action === 'resume') {
      requireValue(row.state === 'paused' && remaining > 0, 409, 'invalid_state', 'There is no paused time to resume.'); state = 'resuming'; desired = 'allowed';
      if (row.all_day) { requireValue(endsAt && new Date(endsAt) - now >= 30_000, 409, 'session_ended', 'The all-day window has ended.'); }
      else { sessionDeadline(now, principal.household.timezone, remaining, { roundUp: buffer > 0 }); endsAt = null; }
    }
    else {
      if (body.action === 'adjust') {
        requireValue(Number.isInteger(body.deltaMinutes) && body.deltaMinutes !== 0 && Math.abs(body.deltaMinutes) <= 1440, 422, 'invalid_duration', 'Add or remove 1–1440 minutes.');
        const usage = Math.max(0, usageRemaining + body.deltaMinutes * 60);
        remaining = usage > 0 ? usage + buffer : 0; allDay = false;
        allocationDelta = usage - usageRemaining;
      } else { endsAt = sessionDeadline(now, principal.household.timezone, 0, { allDay: true }); remaining = Math.floor((endsAt - now) / 1000); allDay = true; allocationDelta = remaining - usageRemaining; buffer = 0; }
      if (snapshot.preparation) snapshot = { ...snapshot, preparation: { remainingSeconds: buffer, endsAt: allDay ? null : snapshot.preparation.endsAt } };
      requireValue(allDay ? remaining <= 90000 : remaining < 86400, 422, 'invalid_duration', 'A timed session must be shorter than 24 hours.');
      if (!remaining) { state = 'ending'; desired = 'blocked'; }
      else if (row.state === 'paused') { state = 'paused'; desired = 'blocked'; if (!allDay) endsAt = null; }
      else {
        state = 'adjusting'; desired = 'allowed';
        if (!allDay) endsAt = sessionDeadline(now, principal.household.timezone,
          (new Date(row.ends_at).getTime() + body.deltaMinutes * 60_000 - now.getTime()) / 1000);
      }
    }
    if (desired === 'allowed') {
      const device = await one(client, 'SELECT * FROM family_managed_devices WHERE household_id=$1 AND id=$2', [householdId, row.device_id]);
      requireValue(device?.desired_access === 'blocked' && device.observed_access === 'blocked' && device.access_verified_at
        && !await one(client, "SELECT id FROM family_internet_commands WHERE device_id=$1 AND state IN ('pending','leased','attention')", [row.device_id]),
      409, 'device_access_pending', 'A parent device control is being confirmed. Refresh before changing this session.');
    }
    if (desired === 'allowed' || body.action === 'all_day') {
      const integration = await one(client, 'SELECT * FROM family_network_integrations WHERE household_id=$1', [householdId]);
      requireScheduleSupport(integration, principal.household.timezone, now,
        endsAt || sessionDeadline(now, principal.household.timezone, remaining, { allDay }), { allDay });
    }
    const changed = await one(client, `UPDATE family_internet_sessions SET state=$3,desired_state=$4,ends_at=$5,remaining_seconds=$6,all_day=$7,version=version+1,last_error=NULL,pending_action=$9,
      activation_planned_at=CASE WHEN $9='resume' THEN NULL ELSE activation_planned_at END,
      allocated_seconds=greatest(0,allocated_seconds+$8),policy_snapshot=$10::jsonb WHERE household_id=$1 AND id=$2 RETURNING *`,
    [householdId, id, state, desired, endsAt, remaining, allDay, allocationDelta,
      state === 'paused' ? null : body.action === 'all_day' ? 'adjust' : body.action, JSON.stringify(snapshot)]);
    if (state !== 'paused') await queueInternetCommand(client, changed, now);
    await internetEvent(client, { householdId, personId: row.person_id, sessionId: id, deviceId: row.device_id, type: `session_${body.action}_requested`, actor: principal.actor,
      reason: body.reason ? textField(body.reason, 'Reason', 500) : null, details: { version: changed.version, remainingSeconds: remaining, endsAt: iso(endsAt) }, now });
    if (['all_day','resume'].includes(body.action) || body.action === 'adjust' && body.deltaMinutes > 0) await internetNotification(client, {
      householdId, personId: row.person_id, sessionId: id, type: 'access_granted', key: `grant-adjust:${id}:${changed.version}`,
      ...await notificationActor(client, principal),
      payload: { minutes: body.action === 'resume' ? Math.max(0, remaining - buffer) / 60 : body.deltaMinutes, allDay: body.action === 'all_day' || body.action === 'resume' && row.all_day, additional: body.action === 'adjust' }, now });
    if (state === 'paused') await internetNotification(client, { householdId, personId: row.person_id, sessionId: id, type: 'session_adjusted', key: `session-adjusted:${id}:${changed.version}`, now });
    return sessionDto(changed);
  });
}

export async function internetHistory(db, principal) {
  const householdId = requireHousehold(principal);
  const rows = (await db.query(`SELECT id,person_id,session_id,device_id,type,actor,reason,details,created_at FROM family_internet_events
    WHERE household_id=$1 AND ($2::uuid IS NULL OR person_id=$2) ORDER BY created_at DESC,id DESC LIMIT 100`, [householdId, principal.role === 'child' ? principal.personId : null])).rows;
  return { history: rows.map(row => ({ id: row.id, personId: row.person_id, sessionId: row.session_id, deviceId: row.device_id, type: row.type,
    actor: principal.role === 'child' ? undefined : row.actor, reason: row.reason, details: row.details, createdAt: iso(row.created_at) })) };
}

export async function resolveRewardReview(db, principal, id, body, { now = new Date() } = {}) {
  await requireCapability(db, principal, 'manageInternet'); uuidField(id, 'Reward');
  requireValue(['restore', 'consume'].includes(body.action), 422, 'invalid_action', 'Restore the reward or record it as used.');
  const reason = textField(body.reason, 'Reason for resolving the uncertain allowance', 500);
  return idempotent(db, principal, body, `reward-review:${id}`, async (client, householdId) => {
    const row = await one(client, 'SELECT *,earned_date::text FROM family_reward_credits WHERE household_id=$1 AND id=$2 FOR UPDATE', [householdId, id]);
    requireValue(row?.status === 'review', 409, 'review_resolved', 'This reward no longer needs review. Refresh and try again.');
    const status = body.action === 'consume' ? 'spent' : new Date(row.expires_at) <= now ? 'expired' : 'available';
    const updated = await one(client, 'UPDATE family_reward_credits SET status=$2,reserved_by=NULL WHERE id=$1 RETURNING *,earned_date::text', [id, status]);
    await internetEvent(client, { householdId, personId: row.person_id, type: 'reward_review_resolved', actor: principal.actor, reason, details: { creditId: id, resolution: body.action }, now });
    return creditDto(updated);
  });
}

export async function requestDeviceAccess(db, principal, body, { now = new Date() } = {}) {
  requireValue(principal.role === 'child' && ['user','mobile'].includes(principal.authType), 403, 'child_required', 'Use your own child account to request time.');
  uuidField(body.deviceId, 'Device');
  requireValue(Number.isInteger(body.minutes) && body.minutes >= 1 && body.minutes <= 1439, 422, 'invalid_duration', 'Choose 1–1439 minutes.');
  const reason = body.reason == null || body.reason === '' ? null : textField(body.reason, 'Reason', 500);
  return idempotent(db, principal, body, 'request-access', async (client, householdId) => {
    const device = await one(client, 'SELECT * FROM family_managed_devices WHERE household_id=$1 AND id=$2 AND removed_at IS NULL', [householdId, body.deviceId]);
    requireValue(device?.person_ids.includes(principal.personId), 404, 'not_found', 'That device is not assigned to you.');
    await client.query("UPDATE family_access_requests SET status='expired',version=version+1 WHERE household_id=$1 AND status='pending' AND expires_at<=$2", [householdId, now]);
    requireValue(!await one(client, "SELECT id FROM family_access_requests WHERE household_id=$1 AND person_id=$2 AND device_id=$3 AND status='pending'", [householdId, principal.personId, device.id]),
      409, 'request_pending', 'You already have a pending request for this device.');
    const count = await one(client, "SELECT count(*)::int AS total FROM family_access_requests WHERE household_id=$1 AND person_id=$2 AND requested_at>$3", [householdId, principal.personId, new Date(now - 86400_000)]);
    requireValue(count.total < 20, 429, 'request_limit', 'You have sent enough requests today. Ask a parent to review them.');
    const row = await one(client, `INSERT INTO family_access_requests(id,household_id,person_id,device_id,minutes,reason,requested_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [randomUUID(), householdId, principal.personId, device.id, body.minutes, reason, now, new Date(now.getTime()+86400_000)]);
    await internetNotification(client, { householdId, personId: principal.personId, deviceId: device.id, type: 'access_requested', key: `access-request:${row.id}`,
      payload: { requestId: row.id, minutes: row.minutes, reason, audience: 'parents' }, now });
    return accessRequestDto(row);
  });
}

export async function decideDeviceAccess(db, principal, id, body, { env = process.env, now = new Date() } = {}) {
  await requireCapability(db, principal, 'manageInternet'); uuidField(id); versionField(body.expectedVersion);
  requireValue(['approve','decline'].includes(body.action), 422, 'invalid_action', 'Approve or decline this request.');
  return idempotent(db, principal, body, `decide-access:${id}`, async (client, householdId) => {
    const row = await one(client, 'SELECT * FROM family_access_requests WHERE household_id=$1 AND id=$2 FOR UPDATE', [householdId, id]);
    if (!row) throw notFound();
    requireValue(row.version === body.expectedVersion && row.status === 'pending' && new Date(row.expires_at)>now,
      409, 'request_changed', 'This request changed or expired. Refresh before deciding.');
    let session = null;
    if (body.action === 'approve') session = await createInternetSession(client, principal,
      { deviceId: row.device_id, personId: row.person_id, minutes: row.minutes, reason: row.reason, requestId: row.id }, { env, now, householdId });
    const result = await one(client, `UPDATE family_access_requests SET status=$3,version=version+1,decided_at=$4,decided_by=$5,session_id=$6
      WHERE household_id=$1 AND id=$2 RETURNING *`, [householdId, id, session ? 'approved' : 'declined', now, principal.actor, session?.id || null]);
    await internetNotification(client, { householdId, personId: row.person_id, deviceId: row.device_id, sessionId: session?.id,
      type: session ? 'access_approved' : 'access_declined', key: `access-decision:${id}`, ...await notificationActor(client, principal),
      payload: { requestId: id, minutes: row.minutes, reason: row.reason }, now });
    return accessRequestDto(result);
  });
}
