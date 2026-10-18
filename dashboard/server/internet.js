import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { one, transaction } from './database.js';
import { digest } from './credentials.js';
import { requireHousehold } from './auth.js';
import { parentCapabilities, requireCapability } from './capabilities.js';
import { ApiError, dateField, householdDate, requireValue, textField, uuidField, versionField } from './errors.js';
import { ensureDailyOccurrences, getRequiredProgress, lockChoreDay } from './chore-occurrences.js';
import { normalizedMac, unifiConfiguration, managementHost as configuredManagementHost, requiredPilotChecks } from './unifi.js';

const iso = value => value ? new Date(value).toISOString() : null;
const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const terminal = new Set(['ended', 'failed']);
const notFound = () => new ApiError(404, 'not_found', 'That item does not exist in your family.');
const timeField = value => value === null || typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export const defaultRewardPolicy = personId => ({ personId, version: 0, enabled: true, rewardMinutes: 60, carryoverDays: 7, dailyLimitMinutes: 180, bedtime: null, warningMinutes: 5 });
export const policyDto = row => row ? ({ personId: row.person_id, version: row.version, enabled: row.enabled, rewardMinutes: row.reward_minutes,
  carryoverDays: row.carryover_days, dailyLimitMinutes: row.daily_limit_minutes, bedtime: row.bedtime?.slice(0, 5) || null, warningMinutes: row.warning_minutes }) : null;
export const creditDto = row => ({ id: row.id, personId: row.person_id, earnedDate: day(row.earned_date), minutes: row.minutes,
  status: row.status, expiresAt: iso(row.expires_at), policyVersion: row.policy_version });
export const sessionDto = row => ({ id: row.id, personId: row.person_id, deviceId: row.device_id, creditId: row.credit_id, source: row.source,
  state: row.state, version: row.version, desiredState: row.desired_state, observedState: row.observed_state, requestedAt: iso(row.requested_at),
  startedAt: iso(row.started_at), endsAt: iso(row.ends_at), remainingSeconds: row.remaining_seconds, verifiedAt: iso(row.verified_at),
  endedAt: iso(row.ended_at), reason: row.reason, lastError: row.last_error, allDay: row.all_day });
export const deviceDto = (row, parent = false) => ({ id: row.id, name: row.name, kind: row.kind, personIds: row.person_ids, version: row.version,
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
export function sessionDeadline(now, timezone, seconds, { allDay = false, bedtime = null } = {}) {
  now = new Date(now);
  const today = householdDate(timezone, now);
  const midnight = nextDayStart(today, timezone);
  let end = allDay ? midnight : new Date(now.getTime() + seconds * 1000);
  // The provider's schedule precision is one minute. Never round upward into
  // extra access. All-day is an explicit household-midnight deadline.
  if (!allDay && bedtime) {
    const cutoff = new Date(Temporal.PlainDate.from(today).toPlainDateTime(bedtime).toZonedDateTime(timezone, { disambiguation: 'earlier' }).epochMilliseconds);
    requireValue(cutoff > now && end <= cutoff, 409, 'bedtime_limit', 'This reward does not fit before bedtime. Ask a parent to adjust the limit.');
  }
  end = new Date(Math.floor(end.getTime() / 60_000) * 60_000);
  requireValue(end - now >= 30_000 && (allDay ? end - now <= 90000_000 : end - now < 86400_000),
    422, 'invalid_duration', 'Choose a window shorter than 24 hours, or All day until household midnight.');
  validateTimedWindow(now, end, timezone, { allDay });
  return end;
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
export async function internetNotification(client, { householdId, personId, type, key, sessionId, creditId, payload = {}, now = new Date() }) {
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
    const devices = await client.query('SELECT * FROM family_managed_devices WHERE household_id=$1 AND removed_at IS NULL AND ($2::uuid IS NULL OR $2=ANY(person_ids)) ORDER BY name,id', [householdId, personFilter]);
    const sessions = await client.query('SELECT * FROM family_internet_sessions WHERE household_id=$1 AND ($2::uuid IS NULL OR person_id=$2) ORDER BY requested_at DESC LIMIT 100', [householdId, personFilter]);
    const integration = await one(client, 'SELECT * FROM family_network_integrations WHERE household_id=$1', [householdId]);
    let configured = false, managementHost = 'forest-family-frame.vercel.app';
    try { unifiConfiguration(env); managementHost = configuredManagementHost(env); configured = true; } catch { /* Inactive state is explicit. */ }
    const progress = [];
    for (const person of people) progress.push(await getRequiredProgress(client, householdId, person.id, date));
    return { serverTime: now.toISOString(), timezone: principal.household.timezone, role: principal.role, capabilities,
      integration: { state: !configured ? 'unconfigured' : integration?.state || 'pilot_required', managementHost,
        managementAccessVerifiedAt: iso(integration?.management_verified_at), lastCheckedAt: iso(integration?.last_checked_at), error: integration?.last_error || null },
      policies: people.map(person => policyDto(policies.rows.find(p => p.person_id === person.id)) || defaultRewardPolicy(person.id)),
      credits: credits.rows.map(creditDto), devices: devices.rows.map(row => deviceDto(row, parent)), sessions: sessions.rows.map(sessionDto), progress };
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
  requireValue(Array.isArray(macAddresses) && macAddresses.length >= 1 && macAddresses.length <= 8, 422, 'invalid_device', 'Enter one to eight stable device MAC addresses.');
  const allowApplePush = body.allowApplePush ?? current.allow_apple_push ?? ['tablet', 'phone'].includes(kind);
  requireValue(typeof allowApplePush === 'boolean', 422, 'invalid_device', 'Choose whether this Apple device needs notifications.');
  return { name, kind, allowApplePush, personIds: [...new Set(personIds.map(id => uuidField(id, 'Child profile')))].sort(), macAddresses: [...new Set(macAddresses.map(normalizedMac))].sort() };
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
    const changed = row ? await one(client, `UPDATE family_managed_devices SET name=$3,kind=$4,person_ids=$5,mac_addresses=$6,allow_apple_push=$7,version=version+1 WHERE household_id=$1 AND id=$2 RETURNING *`, [householdId, id, value.name, value.kind, value.personIds, value.macAddresses, value.allowApplePush])
      : await one(client, `INSERT INTO family_managed_devices(id,household_id,name,kind,person_ids,mac_addresses,allow_apple_push) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), householdId, value.name, value.kind, value.personIds, value.macAddresses, value.allowApplePush]);
    await internetEvent(client, { householdId, deviceId: changed.id, type: row ? 'device_changed' : 'device_added', actor: principal.actor });
    return deviceDto(changed, true);
  });
}

async function requireReady(client, householdId, device, env) {
  unifiConfiguration(env);
  const integration = await one(client, 'SELECT * FROM family_network_integrations WHERE household_id=$1', [householdId]);
  requireValue(integration?.state === 'ready' && integration.management_host === configuredManagementHost(env) && integration.management_verified_at
    && requiredPilotChecks.every(key => integration.pilot_checks?.[key] === true)
    && (!device.allow_apple_push || integration.pilot_checks?.apple_push === true && device.apple_push_policy_id)
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

export async function startInternetSession(db, principal, body, { reward = false, env = process.env, now = new Date() } = {}) {
  const parent = reward ? false : Boolean(await requireCapability(db, principal, 'manageInternet'));
  if (reward) requireValue(principal.role === 'child' && (['user', 'mobile'].includes(principal.authType) || principal.verifiedFrameGrant?.scope === 'child'),
    403, 'child_required', 'Use your own child account, or unlock your profile on the frame with your phone.');
  uuidField(body.deviceId, 'Device'); if (reward) uuidField(body.creditId, 'Reward'); else uuidField(body.personId, 'Child profile');
  return idempotent(db, principal, body, reward ? 'redeem' : 'grant', async (client, householdId) => {
    let credit = null;
    if (reward) {
      credit = await one(client, 'SELECT *,earned_date::text FROM family_reward_credits WHERE household_id=$1 AND id=$2 AND person_id=$3', [householdId, body.creditId, principal.personId]);
      if (!credit) throw notFound();
      requireValue(credit.status === 'available' && new Date(credit.expires_at) > now, 409, 'reward_unavailable', 'This reward is no longer available. Refresh your chores.');
      // Redemption rechecks the frozen earning day as well as today's work;
      // reopening or rescheduling a source chore cannot bypass the ledger.
      await lockChoreDay(client, householdId, day(credit.earned_date));
      credit = await one(client, 'SELECT *,earned_date::text FROM family_reward_credits WHERE household_id=$1 AND id=$2 AND person_id=$3 FOR UPDATE', [householdId, body.creditId, principal.personId]);
      requireValue(credit?.status === 'available' && new Date(credit.expires_at) > now, 409, 'reward_unavailable', 'This reward is no longer available. Refresh your chores.');
      requireValue(await creditEligible(client, credit), 409, 'chores_incomplete', 'Finish the required chores for this reward before using it.');
    }
    const personId = credit?.person_id || body.personId;
    const device = await one(client, 'SELECT * FROM family_managed_devices WHERE household_id=$1 AND id=$2 AND removed_at IS NULL FOR UPDATE', [householdId, body.deviceId]);
    requireValue(device && device.person_ids.includes(personId), 404, 'not_found', 'That device is not assigned to this child.');
    await requireReady(client, householdId, device, env);
    requireValue(!await one(client, "SELECT id FROM family_internet_sessions WHERE household_id=$1 AND state NOT IN ('ended','failed') AND (person_id=$2 OR device_id=$3)", [householdId, personId, device.id]), 409, 'session_in_use', 'This child or device already has an Internet session.');
    const policy = policyDto(await one(client, 'SELECT * FROM family_reward_policies WHERE household_id=$1 AND person_id=$2', [householdId, personId])) || defaultRewardPolicy(personId);
    const allDay = parent && body.allDay === true;
    requireValue(body.allDay === undefined || typeof body.allDay === 'boolean', 422, 'invalid_duration', 'All day must be true or false.');
    const minutes = reward ? credit.minutes : body.minutes ?? 60;
    requireValue(Number.isInteger(minutes) && minutes >= 1 && minutes <= 1439, 422, 'invalid_duration', 'Choose 1–1439 minutes, or All day.');
    const candidateEnd = sessionDeadline(now, principal.household.timezone, minutes * 60, { allDay, bedtime: reward ? policy.bedtime : null });
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
      VALUES($1,$2,$3,$4,$5,$6,'starting','allowed',$7,$8,$9,$9,$10,$11,$12::jsonb,$13,'start') RETURNING *`,
    [id, householdId, personId, device.id, credit?.id || null, reward ? 'reward' : 'parent', now, endsAt, seconds, body.reason ? textField(body.reason, 'Reason', 500) : null, allDay, JSON.stringify(policy), principal.actor]);
    if (credit) await client.query("UPDATE family_reward_credits SET status='reserved',reserved_by=$2 WHERE id=$1", [credit.id, id]);
    await queueInternetCommand(client, row, now);
    await internetEvent(client, { householdId, personId, deviceId: device.id, sessionId: id, type: 'session_requested', actor: principal.actor, reason: row.reason, details: { endsAt: iso(endsAt), source: row.source }, now });
    return sessionDto(row);
  });
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
    const liveRemaining = row.state === 'paused' ? remaining : Math.max(0, Math.floor((new Date(endsAt) - now) / 1000));
    if (body.action === 'end') { state = 'ending'; desired = 'blocked'; }
    else if (body.action === 'pause') { requireValue(row.state === 'active', 409, 'invalid_state', 'Only an active session can pause.'); state = 'pausing'; desired = 'blocked'; }
    else if (body.action === 'resume') {
      requireValue(row.state === 'paused' && remaining > 0, 409, 'invalid_state', 'There is no paused time to resume.'); state = 'resuming'; desired = 'allowed';
      if (row.all_day) { requireValue(endsAt && new Date(endsAt) - now >= 30_000, 409, 'session_ended', 'The all-day window has ended.'); }
      else { sessionDeadline(now, principal.household.timezone, remaining); endsAt = null; }
    }
    else {
      if (body.action === 'adjust') {
        requireValue(Number.isInteger(body.deltaMinutes) && body.deltaMinutes !== 0 && Math.abs(body.deltaMinutes) <= 1440, 422, 'invalid_duration', 'Add or remove 1–1440 minutes.');
        remaining = Math.max(0, liveRemaining + body.deltaMinutes * 60); allDay = false;
      } else { endsAt = sessionDeadline(now, principal.household.timezone, 0, { allDay: true }); remaining = Math.floor((endsAt - now) / 1000); allDay = true; }
      requireValue(allDay ? remaining <= 90000 : remaining < 86400, 422, 'invalid_duration', 'A timed session must be shorter than 24 hours.');
      if (!remaining) { state = 'ending'; desired = 'blocked'; }
      else if (row.state === 'paused') { state = 'paused'; desired = 'blocked'; if (!allDay) endsAt = null; }
      else { state = 'adjusting'; desired = 'allowed'; if (!allDay) endsAt = sessionDeadline(now, principal.household.timezone, remaining); }
    }
    const changed = await one(client, `UPDATE family_internet_sessions SET state=$3,desired_state=$4,ends_at=$5,remaining_seconds=$6,all_day=$7,version=version+1,last_error=NULL,pending_action=$9,
      activation_planned_at=CASE WHEN $9='resume' THEN NULL ELSE activation_planned_at END,
      allocated_seconds=greatest(0,allocated_seconds+$8) WHERE household_id=$1 AND id=$2 RETURNING *`,
    [householdId, id, state, desired, endsAt, remaining, allDay, ['adjust', 'all_day'].includes(body.action) ? remaining - liveRemaining : 0,
      state === 'paused' ? null : body.action === 'all_day' ? 'adjust' : body.action]);
    if (state !== 'paused') await queueInternetCommand(client, changed, now);
    await internetEvent(client, { householdId, personId: row.person_id, sessionId: id, deviceId: row.device_id, type: `session_${body.action}_requested`, actor: principal.actor,
      reason: body.reason ? textField(body.reason, 'Reason', 500) : null, details: { version: changed.version, remainingSeconds: remaining, endsAt: iso(endsAt) }, now });
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
