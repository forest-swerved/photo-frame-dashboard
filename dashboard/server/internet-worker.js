import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Temporal } from '@js-temporal/polyfill';
import { one, transaction } from './database.js';
import { requireValue } from './errors.js';
import { createUniFiClient, managedPolicyPlan, managementHost, networkChecksPassed, applePushReady, policyContentFingerprint, policyOrdering, verifyNetworkScope } from './unifi.js';
import { inspectDevicePolicyScope } from './internet-policy-scope.js';
import { sameManagedPolicy, restrictDeviceAccess, auditInternetDevices } from './internet-enforcement.js';
import { internetEvent, internetNotification, preparationRemaining, queueInternetCommand, sessionDeadline, validateTimedWindow } from './internet.js';

const terminal = row => ['ended', 'failed'].includes(row.state);
export { sameManagedPolicy } from './internet-enforcement.js';
export function sessionOrdering(existing, managementId, denyId, sessionId) {
  const ordering = policyOrdering(existing), before = ordering.beforeSystemDefined;
  requireValue(before.includes(managementId) && before.includes(denyId) && before.indexOf(managementId) < before.indexOf(denyId),
  503, 'management_policy_changed', 'The permanent Family Frame access policy must precede Internet blocking.');
  const order = before.filter(id => id !== sessionId), at = order.indexOf(denyId);
  return { beforeSystemDefined: [...order.slice(0, at), sessionId, ...order.slice(at)],
    afterSystemDefined: ordering.afterSystemDefined.filter(id => id !== sessionId) };
}
export function scheduledSessionPolicy(session, device, integration, timezone, now, { startAt = now, env = process.env } = {}) {
  const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses, sourceZoneId: integration.source_zone_id, destinationZoneId: integration.external_zone_id }, env);
  const start = Temporal.Instant.from(new Date(startAt).toISOString()).toZonedDateTimeISO(timezone);
  const end = Temporal.Instant.from(new Date(session.ends_at).toISOString()).toZonedDateTimeISO(timezone);
  const elapsed = new Date(session.ends_at) - now;
  if (session.all_day) {
    const date = end.subtract({ milliseconds: 1 }).toPlainDate();
    const dayStart = date.toZonedDateTime({ timeZone: timezone, plainTime: '00:00' });
    const nextMidnight = date.add({ days: 1 }).toZonedDateTime({ timeZone: timezone, plainTime: '00:00' });
    requireValue(nextMidnight.epochMilliseconds === new Date(session.ends_at).getTime()
      && date.toString() === Temporal.Instant.from(new Date(now).toISOString()).toZonedDateTimeISO(timezone).toPlainDate().toString()
      && elapsed >= 30_000 && elapsed <= 25 * 3600_000,
    409, 'window_elapsed', 'All-day access must end at the current household day’s next midnight.');
    requireValue(integration.pilot_checks?.midnight === true && (nextMidnight.epochMilliseconds - dayStart.epochMilliseconds === 86400_000 || integration.pilot_checks?.dst === true),
      503, 'schedule_unverified', 'All-day enforcement has not passed its midnight or daylight-saving gateway test.');
    return { ...plan.deny, name: `Family Frame session ${session.id}`, description: `family-frame:${device.id}:session:${session.id}`,
      action: { type: 'ALLOW', allowReturnTraffic: false }, connectionStateFilter: ['NEW', 'ESTABLISHED', 'RELATED'], schedule: { mode: 'ONE_TIME_ONLY', date: date.toString(), timeFilter: null } };
  }
  requireValue(elapsed >= 30_000 && elapsed < 86400_000, 409, 'window_elapsed', 'The scheduled window has elapsed or exceeds one day.');
  validateTimedWindow(startAt, session.ends_at, timezone);
  const crossesMidnight = end.toPlainDate().toString() !== start.toPlainDate().toString();
  requireValue(!crossesMidnight || integration.pilot_checks?.midnight === true, 503, 'schedule_unverified', 'Overnight enforcement has not passed its gateway test.');
  return { ...plan.deny, name: `Family Frame session ${session.id}`, description: `family-frame:${device.id}:session:${session.id}`,
    action: { type: 'ALLOW', allowReturnTraffic: false }, connectionStateFilter: ['NEW', 'ESTABLISHED', 'RELATED'], schedule: { mode: 'ONE_TIME_ONLY', date: start.toPlainDate().toString(),
      timeFilter: { startTime: start.toPlainTime().toString({ smallestUnit: 'minute' }), stopTime: end.toPlainTime().toString({ smallestUnit: 'minute' }) } } };
}

async function adoptCreatedPolicy(db, session, policy) {
  if (!policy || session.policy_id === policy.id) return;
  requireValue(!session.policy_id && session.policy_creation_started_at && policy.enabled === false
    && session.policy_fingerprint && policyContentFingerprint(policy) === session.policy_fingerprint,
  503, 'policy_identity_unverified', 'An untracked session policy requires a parent review.');
  const adopted = await db.query(`UPDATE family_internet_sessions SET policy_id=$2 WHERE id=$1 AND policy_id IS NULL
    AND policy_creation_started_at IS NOT NULL AND policy_fingerprint=$3`, [session.id, policy.id, session.policy_fingerprint]);
  if (!adopted.rowCount) {
    const current = await one(db, 'SELECT policy_id FROM family_internet_sessions WHERE id=$1', [session.id]);
    requireValue(current?.policy_id === policy.id, 503, 'policy_identity_unverified', 'The session policy identity changed.');
  }
  session.policy_id = policy.id;
}

async function assertSessionPolicyScope(db, provider, session, device, integration, policies, plannedPolicy = null, env = process.env) {
  const ordering = await provider.ordering(integration.site_id, integration.source_zone_id, integration.external_zone_id);
  const sessions = (await db.query('SELECT * FROM family_internet_sessions WHERE household_id=$1 AND device_id=$2', [session.household_id, device.id])).rows;
  inspectDevicePolicyScope({ device, integration, policies, orderedIds: ordering.orderedFirewallPolicyIds, sessions,
    plannedSessionId: session.id, plannedPolicy, env });
  return ordering;
}

async function scanSessions(db, now) {
  return transaction(db, async client => {
    // Same ordering as every parent/child session mutation.
    const households = (await client.query('SELECT id FROM family_households ORDER BY id')).rows;
    let queued = 0;
    for (const household of households) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${household.id}`]);
      const rows = (await client.query("SELECT * FROM family_internet_sessions WHERE household_id=$1 AND state NOT IN ('ended','failed') AND (state<>'paused' OR all_day) ORDER BY id FOR UPDATE", [household.id])).rows;
      for (const row of rows) {
        if (row.ends_at && new Date(row.ends_at) <= now && (row.desired_state === 'allowed' || row.state === 'paused' && row.all_day)) {
          const updated = await one(client, "UPDATE family_internet_sessions SET state='ending',desired_state='blocked',pending_action='end',version=version+1,last_error=NULL WHERE id=$1 RETURNING *", [row.id]);
          await queueInternetCommand(client, updated, now); queued++;
        } else if (row.state === 'active' && row.ends_at && preparationRemaining(row, now) === 0 && row.policy_snapshot.warningMinutes > 0 && new Date(row.ends_at) - now <= row.policy_snapshot.warningMinutes * 60_000) {
          await internetNotification(client, { householdId: row.household_id, personId: row.person_id, sessionId: row.id, type: 'session_warning', key: `session-warning:${row.id}:${new Date(row.ends_at).toISOString()}`, now });
        }
      }
    }
    return queued;
  });
}
async function claimCommand(db, now) {
  return transaction(db, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('internet-provider-claim',0))");
    // Retain an in-flight command's lease when a parent changes the desired
    // state. A later BLOCK must never race an older ALLOW at the provider.
    if (await one(client, "SELECT id FROM family_internet_commands WHERE state='leased' AND lease_until>$1 LIMIT 1", [now])) return null;
    const row = await one(client, `SELECT * FROM family_internet_commands WHERE ((state IN ('pending','attention') AND available_at<=$1 AND (state='pending' OR action='block'))
      OR (state='leased' AND lease_until<=$1)) AND (device_id IS NULL OR NOT EXISTS(SELECT 1 FROM family_internet_commands older
        WHERE older.device_id=family_internet_commands.device_id AND older.session_version<family_internet_commands.session_version AND older.state='leased' AND older.lease_until>$1)) ORDER BY (action='block') DESC,available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now]);
    if (!row) return null;
    const leaseId = randomUUID();
    return one(client, "UPDATE family_internet_commands SET state='leased',lease_id=$2,lease_until=$3,attempts=attempts+1 WHERE id=$1 RETURNING *", [row.id, leaseId, new Date(now.getTime() + 180_000)]);
  });
}
async function loadCommand(db, command, env) {
  const session = await one(db, 'SELECT s.*,h.timezone FROM family_internet_sessions s JOIN family_households h ON h.id=s.household_id WHERE s.id=$1', [command.session_id]);
  if (!session || session.version !== command.session_version || terminal(session)) return null;
  const [device, integration] = await Promise.all([
    one(db, 'SELECT * FROM family_managed_devices WHERE household_id=$1 AND id=$2 AND removed_at IS NULL', [session.household_id, session.device_id]),
    one(db, 'SELECT * FROM family_network_integrations WHERE household_id=$1', [session.household_id]),
  ]);
  requireValue(device && integration && (command.action === 'block' || integration.state === 'ready' && integration.management_host === managementHost(env)
    && integration.management_verified_at && networkChecksPassed(integration, device.id)
    && device.control_state === 'ready' && device.management_verified_at),
  503, 'network_not_ready', 'Network control requires verified Family Frame access and blocking.');
  return { session, device, integration };
}

// Provider I/O happens outside SQL transactions. The command lease and session
// generation are checked again before publishing a result. Only one command
// per invocation bounds provider requests and console API usage.
async function assertWriteOwnership(db, command, clock) {
  if (command.device_id) {
    const owned = await one(db, `SELECT d.id FROM family_managed_devices d JOIN family_internet_commands c ON c.device_id=d.id AND c.household_id=d.household_id
      WHERE c.id=$1 AND c.state='leased' AND c.lease_id=$2 AND c.lease_until>$3 AND d.version=c.session_version
      AND d.removed_at IS NULL AND d.desired_access=$4`, [command.id, command.lease_id, clock(), command.action === 'allow' ? 'allowed' : 'blocked']);
    requireValue(owned, 409, 'command_superseded', 'The device control changed or its lease expired.');
    return;
  }
  const owned = await one(db, `SELECT s.id FROM family_internet_sessions s JOIN family_internet_commands c ON c.session_id=s.id
    WHERE c.id=$1 AND c.state='leased' AND c.lease_id=$2 AND c.lease_until>$3
    AND s.version=c.session_version AND s.version=$4 AND s.desired_state=$5 AND s.state NOT IN ('ended','failed')`,
  [command.id, command.lease_id, clock(), command.session_version, command.action === 'allow' ? 'allowed' : 'blocked']);
  requireValue(owned, 409, 'command_superseded', 'The network command lease or requested session changed.');
}
async function recordAllowAttempt(db, command, fingerprint, clock) {
  const now = clock();
  const updated = await db.query(`UPDATE family_internet_sessions s
    SET allow_attempted_at=coalesce(allow_attempted_at,$3),planned_policy_fingerprint=$4
    WHERE s.id=$1 AND s.version=$5 AND s.desired_state='allowed' AND s.state NOT IN ('ended','failed')
    AND EXISTS(SELECT 1 FROM family_internet_commands c WHERE c.id=$2 AND c.session_id=s.id AND c.session_version=s.version
      AND c.state='leased' AND c.lease_id=$6 AND c.lease_until>$3)`,
  [command.session_id, command.id, now, fingerprint, command.session_version, command.lease_id]);
  requireValue(updated.rowCount === 1, 409, 'command_superseded', 'The network command lease or requested session changed.');
}
async function prepareActivation(db, command, clock) {
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${command.household_id}`]);
    const owned = await one(client, "SELECT * FROM family_internet_commands WHERE id=$1 AND state='leased' AND lease_id=$2 FOR UPDATE", [command.id, command.lease_id]);
    const session = await one(client, `SELECT s.*,h.timezone FROM family_internet_sessions s JOIN family_households h ON h.id=s.household_id
      WHERE s.id=$1 FOR UPDATE OF s`, [command.session_id]);
    const now = clock();
    requireValue(owned && new Date(owned.lease_until) > now && session && session.version === command.session_version
      && session.desired_state === 'allowed' && !terminal(session), 409, 'command_superseded', 'The network command lease or requested session changed.');
    if (session.all_day || !['start', 'resume'].includes(session.pending_action) || session.activation_planned_at) return session;
    // Queue wait never consumes a timed reward. Start the immutable gateway
    // window when its owned worker first begins activation. Retries retain the
    // same plan even when a provider result was ambiguous.
    // A confirmed pause leaves the reusable policy identity and old attempt
    // markers intact. A new resume generation gets its own fixed window.
    const previouslyAttempted = session.pending_action === 'start' && (session.allow_attempted_at || session.policy_creation_started_at);
    requireValue(!previouslyAttempted || session.ends_at, 503, 'activation_uncertain', 'The previous activation deadline requires a parent review.');
    const plannedAt = previouslyAttempted ? command.created_at : now;
    const buffer = preparationRemaining(session, now);
    const endsAt = previouslyAttempted ? session.ends_at : sessionDeadline(plannedAt, session.timezone, session.remaining_seconds,
      { roundUp: buffer > 0, bedtime: session.source === 'reward' ? session.policy_snapshot.bedtime : null });
    let snapshot = session.policy_snapshot, remaining = session.remaining_seconds;
    if (!previouslyAttempted && snapshot.preparation) {
      const usage = Math.max(0, remaining - buffer);
      remaining = Math.max(0, Math.ceil((new Date(endsAt) - plannedAt) / 1000));
      const actualBuffer = buffer > 0 ? Math.max(0, remaining - usage) : 0;
      snapshot = { ...snapshot, preparation: { remainingSeconds: actualBuffer,
        endsAt: actualBuffer > 0 ? new Date(new Date(endsAt).getTime() - usage * 1000).toISOString() : null } };
    }
    const updated = await one(client, `UPDATE family_internet_sessions SET ends_at=$2,activation_planned_at=$3,policy_snapshot=$4::jsonb,remaining_seconds=$5 WHERE id=$1 RETURNING *`,
      [session.id, endsAt, plannedAt, JSON.stringify(snapshot), remaining]);
    return { ...updated, timezone: session.timezone };
  });
}
async function applyCommand(db, command, env, provider, now, clock) {
  const loaded = await loadCommand(db, command, env);
  if (!loaded) return { superseded: true };
  const { device, integration } = loaded, site = integration.site_id;
  if (command.action === 'allow') await verifyNetworkScope(provider, integration);
  const session = command.action === 'allow' ? await prepareActivation(db, command, clock) : loaded.session;
  const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses, sourceZoneId: integration.source_zone_id, destinationZoneId: integration.external_zone_id }, env);
  if (command.action === 'block') {
    const sessions = (await db.query('SELECT * FROM family_internet_sessions WHERE household_id=$1 AND device_id=$2', [session.household_id, device.id])).rows;
    await restrictDeviceAccess({ device, integration, sessions, provider, env, assertOwnership: () => assertWriteOwnership(db, command, clock) });
  }
  let policies = await provider.policies(site);
  if (command.action === 'allow') {
    // A parent may switch indefinite access to a timed window. Restore the
    // permanent deny first, under this session's ownership, before granting.
    await assertSessionPolicyScope(db, provider, session, device, integration, policies, null, env);
    const deny = policies.find(p => p.id === device.deny_policy_id);
    if (deny.enabled === false) {
      await assertWriteOwnership(db, command, clock);
      await provider.replacePolicy(site, deny.id, deny, { enabled: true });
      policies = await provider.policies(site);
    }
  }
  const management = policies.find(p => p.id === device.management_policy_id), deny = policies.find(p => p.id === device.deny_policy_id);
  if (device.allow_apple_push) {
    const applePlan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses, sourceZoneId: integration.source_zone_id,
      destinationZoneId: integration.external_zone_id, allowApplePush: true }, env).applePush;
    requireValue(applePushReady(integration, device.id) && sameManagedPolicy(policies.find(p => p.id === device.apple_push_policy_id), applePlan),
      503, 'apple_push_policy_changed', 'The permanent Apple notification path requires review.');
  }
  const description = `family-frame:${device.id}:session:${session.id}`;
  const matches = policies.filter(p => p.description === description);
  let policy = matches[0];
  if (policy) await adoptCreatedPolicy(db, session, policy);
  if (command.action === 'block') {
    requireValue(matches.length <= 8, 503, 'duplicate_policy', 'Duplicate session policies require a parent review.');
    requireValue(sameManagedPolicy(management, plan.management) && sameManagedPolicy(deny, plan.deny), 503, 'management_policy_changed', 'The permanent Family Frame access or blocking policy changed. A parent must review it.');
    await assertSessionPolicyScope(db, provider, session, device, integration, policies, null, env);
    for (const duplicate of matches) if (duplicate.enabled) {
      await assertWriteOwnership(db, command, clock);
      await provider.replacePolicy(site, duplicate.id, duplicate, { enabled: false });
      const observed = await provider.policy(site, duplicate.id);
      requireValue(observed.enabled === false, 503, 'block_unconfirmed', 'UniFi has not confirmed that the session allowance is disabled.');
    }
    const verifiedPolicies = await provider.policies(site);
    await assertSessionPolicyScope(db, provider, session, device, integration, verifiedPolicies, null, env);
    const verifiedPolicy = verifiedPolicies.find(item => item.id === session.policy_id);
    requireValue(!verifiedPolicy || verifiedPolicy.enabled === false, 503, 'block_unconfirmed', 'The session allowance is still active.');
    return { observed: 'blocked', policyId: policy?.id || null, policyFingerprint: verifiedPolicy ? policyContentFingerprint(verifiedPolicy) : null };
  }
  requireValue(matches.length <= 1, 503, 'duplicate_policy', 'Duplicate session policies require a parent review.');
  requireValue(sameManagedPolicy(management, plan.management) && sameManagedPolicy(deny, plan.deny), 503, 'management_policy_changed', 'The permanent Family Frame access or blocking policy changed. A parent must review it.');
  // The command start is immutable across retries; an ambiguous successful PUT
  // can be recognized without silently creating a different schedule on retry.
  const startAt = !session.all_day && ['start', 'resume'].includes(session.pending_action) ? session.activation_planned_at : command.created_at;
  const expected = scheduledSessionPolicy(session, device, integration, session.timezone, clock(), { startAt, env });
  await assertSessionPolicyScope(db, provider, session, device, integration, policies, expected, env);
  if (!policy) {
    requireValue(!session.policy_creation_started_at, 503, 'policy_creation_uncertain', 'The previous policy creation is being reconciled. End the session if no policy appears.');
    const creationPolicy = { ...expected, enabled: false };
    const creationFingerprint = policyContentFingerprint(creationPolicy);
    await assertWriteOwnership(db, command, clock);
    const attempted = await db.query(`UPDATE family_internet_sessions s SET policy_creation_started_at=$3,policy_fingerprint=$4
      WHERE id=$1 AND version=$2 AND policy_creation_started_at IS NULL AND desired_state='allowed'
      AND EXISTS(SELECT 1 FROM family_internet_commands c WHERE c.id=$5 AND c.session_id=s.id AND c.session_version=s.version
        AND c.state='leased' AND c.lease_id=$6 AND c.lease_until>$3)`, [session.id, command.session_version, clock(), creationFingerprint, command.id, command.lease_id]);
    requireValue(attempted.rowCount === 1, 503, 'policy_creation_uncertain', 'Another worker already attempted policy creation.');
    // Creation is initially disabled. A process crash cannot leave a new
    // unverified ALLOW active or trigger a second creation on retry.
    session.policy_creation_started_at = now;
    session.policy_fingerprint = creationFingerprint;
    await assertWriteOwnership(db, command, clock);
    const created = await provider.createPolicy(site, creationPolicy);
    requireValue(created?.id, 503, 'allow_unconfirmed', 'UniFi did not return the session policy identity.');
    policy = await provider.policy(site, created.id);
    await adoptCreatedPolicy(db, session, policy);
  }
  requireValue(policy?.id, 503, 'allow_unconfirmed', 'UniFi did not return the session policy identity.');
  const ordering = await provider.ordering(site, integration.source_zone_id, integration.external_zone_id);
  const order = sessionOrdering(ordering?.orderedFirewallPolicyIds, management.id, deny.id, policy.id);
  if (!isDeepStrictEqual(order, ordering.orderedFirewallPolicyIds)) {
    await assertWriteOwnership(db, command, clock);
    await provider.reorder(site, integration.source_zone_id, integration.external_zone_id, order);
  }
  // Recheck the desired generation before the final provider mutation. A late
  // end request queues its own block; the gateway deadline remains bounded.
  await assertWriteOwnership(db, command, clock);
  if (!sameManagedPolicy(policy, expected)) {
    await verifyNetworkScope(provider, integration);
    // Durable evidence is written before attempting ALLOW. A timeout may mean
    // the gateway accepted it, so an unconfirmed start cannot be auto-refunded.
    // A later parent END can also recognize and disable this exact allowance.
    await recordAllowAttempt(db, command, policyContentFingerprint(expected), clock);
    await assertWriteOwnership(db, command, clock);
    await provider.replacePolicy(site, policy.id, policy, expected);
  }
  policy = await provider.policy(site, policy.id);
  requireValue(sameManagedPolicy(policy, expected), 503, 'allow_unconfirmed', 'UniFi has not confirmed the scheduled allowance.');
  const verifiedPolicies = await provider.policies(site);
  const verifiedPolicy = verifiedPolicies.find(item => item.id === policy.id);
  requireValue(sameManagedPolicy(verifiedPolicy, expected), 503, 'allow_unconfirmed', 'UniFi did not consistently confirm the scheduled allowance.');
  const verifiedOrder = await assertSessionPolicyScope(db, provider, session, device, integration, verifiedPolicies, expected, env);
  requireValue(isDeepStrictEqual(verifiedOrder.orderedFirewallPolicyIds, order), 503, 'order_unconfirmed', 'UniFi has not confirmed the session policy order.');
  await verifyNetworkScope(provider, integration);
  return { observed: 'allowed', policyId: policy.id, policyFingerprint: policyContentFingerprint(verifiedPolicy) };
}

async function publishCommand(db, command, outcome, now) {
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${command.household_id}`]);
    const owned = await one(client, "SELECT * FROM family_internet_commands WHERE id=$1 AND state='leased' AND lease_id=$2 AND lease_until>$3 FOR UPDATE", [command.id, command.lease_id, now]);
    if (!owned) return 'superseded';
    const row = await one(client, 'SELECT * FROM family_internet_sessions WHERE id=$1 FOR UPDATE', [command.session_id]);
    if (outcome.superseded || row.version !== command.session_version || terminal(row)) {
      await client.query("UPDATE family_internet_commands SET state='superseded',lease_id=NULL,lease_until=NULL WHERE id=$1", [command.id]); return 'superseded';
    }
    const state = outcome.observed === 'allowed' ? 'active' : row.pending_action === 'pause' ? 'paused' : 'ended';
    const remaining = state === 'paused' && row.ends_at ? Math.max(0, Math.ceil((new Date(row.ends_at) - now) / 1000))
      : state === 'ended' ? 0 : row.remaining_seconds;
    const snapshot = state === 'paused' && row.policy_snapshot.preparation ? { ...row.policy_snapshot,
      preparation: { remainingSeconds: Math.min(remaining, preparationRemaining(row, now)), endsAt: null } } : row.policy_snapshot;
    const updated = await one(client, `UPDATE family_internet_sessions SET state=$2,observed_state=$3,verified_at=$4,policy_id=$5,policy_fingerprint=$7,last_error=NULL,
      started_at=CASE WHEN $3='allowed' THEN coalesce(started_at,$4) ELSE started_at END,ended_at=CASE WHEN $2='ended' THEN $4 ELSE NULL END,
      remaining_seconds=$6,ends_at=CASE WHEN $2='paused' AND NOT all_day THEN NULL ELSE ends_at END,pending_action=NULL,version=version+1,policy_snapshot=$8::jsonb WHERE id=$1 RETURNING *`, [row.id, state, outcome.observed, now, outcome.policyId, remaining, outcome.policyFingerprint || null, JSON.stringify(snapshot)]);
    await client.query("UPDATE family_managed_devices SET observed_access='blocked',access_verified_at=$3,access_error=NULL WHERE household_id=$1 AND id=$2 AND desired_access='blocked'", [row.household_id, row.device_id, now]);
    if (row.credit_id && state === 'active') await client.query("UPDATE family_reward_credits SET status='spent' WHERE id=$1 AND reserved_by=$2", [row.credit_id, row.id]);
    // Only a known never-attempted ALLOW is safe to refund automatically.
    // Ambiguous grants stay tied to their session for explicit parent review.
    if (row.credit_id && state === 'ended' && !row.started_at) {
      if (row.allow_attempted_at) await client.query("UPDATE family_reward_credits SET status='review' WHERE id=$1 AND status='reserved' AND reserved_by=$2", [row.credit_id, row.id]);
      else await client.query("UPDATE family_reward_credits SET status=CASE WHEN expires_at>$3 THEN 'available' ELSE 'expired' END,reserved_by=NULL WHERE id=$1 AND status='reserved' AND reserved_by=$2", [row.credit_id, row.id, now]);
    }
    await client.query("UPDATE family_internet_commands SET state='done',lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1", [command.id]);
    const type = state === 'paused' ? 'session_paused' : state === 'ended' ? row.ends_at && new Date(row.ends_at) <= now ? 'session_expired' : 'session_ended'
      : row.started_at ? 'session_adjusted' : 'session_started';
    await internetEvent(client, { householdId: row.household_id, personId: row.person_id, sessionId: row.id, deviceId: row.device_id, type, actor: 'system:unifi', details: { observedState: outcome.observed, endsAt: updated.ends_at }, now });
    await internetNotification(client, { householdId: row.household_id, personId: row.person_id, sessionId: row.id, type, key: `${type}:${row.id}:${updated.version}`, payload:{action:row.pending_action}, now });
    return state;
  });
}
async function commandFailed(db, command, error, now) {
  const code = typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'network_unavailable';
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${command.household_id}`]);
    const owned = await one(client, "SELECT * FROM family_internet_commands WHERE id=$1 AND state='leased' AND lease_id=$2 FOR UPDATE", [command.id, command.lease_id]);
    if (!owned) return 'superseded';
    const row = await one(client, 'SELECT * FROM family_internet_sessions WHERE id=$1 AND version=$2 FOR UPDATE', [command.session_id, command.session_version]);
    if (!row) { await client.query("UPDATE family_internet_commands SET state='superseded',lease_id=NULL,lease_until=NULL WHERE id=$1", [command.id]); return 'superseded'; }
    await client.query("UPDATE family_internet_sessions SET state='checking',observed_state='unknown',last_error=$2 WHERE id=$1", [row.id, code]);
    // Uncertain outcomes are never refunded. Continue reconciliation; a parent
    // can always request an end while reservations remain held.
    await client.query("UPDATE family_internet_commands SET state=$4,available_at=$2,last_error=$3,lease_id=NULL,lease_until=NULL WHERE id=$1", [command.id, new Date(now.getTime() + (command.attempts >= 3 ? 300 : 15 * 2 ** command.attempts) * 1000), code, command.attempts >= 3 ? 'attention' : 'pending']);
    await internetNotification(client, { householdId: row.household_id, personId: row.person_id, sessionId: row.id, type: 'enforcement_failed', key: `enforcement-failed:${row.id}:${command.session_version}`, now });
    return 'checking';
  });
}
export async function processInternetJobs(db, { env = process.env, now = new Date(), provider, clock = () => new Date(), audit = false } = {}) {
  provider ||= createUniFiClient({ env });
  if (audit) await auditInternetDevices(db, { env, provider, now });
  const expiredQueued = await scanSessions(db, now), command = await claimCommand(db, now);
  if (!command) return { processed: 0, expiredQueued };
  let outcome;
  try { outcome = await (command.device_id ? applyDeviceCommand : applyCommand)(db, command, env, provider, now, clock); }
  catch (error) {
    return { processed: 1, expiredQueued, error: typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'network_unavailable',
      state: await (command.device_id ? deviceCommandFailed : commandFailed)(db, command, error, clock()) };
  }
  return { processed: 1, expiredQueued, state: await (command.device_id ? publishDeviceCommand : publishCommand)(db, command, outcome, clock()) };
}

// Each command owns one device generation. Unrelated device rules are neither
// rewritten nor rebased. A stale applied command is followed by the latest intent.
async function applyDeviceCommand(db, command, env, provider, now, clock) {
  const device = await one(db, 'SELECT * FROM family_managed_devices WHERE household_id=$1 AND id=$2 AND removed_at IS NULL', [command.household_id, command.device_id]);
  if (!device || device.version !== command.session_version) return { superseded: true };
  const integration = await one(db, 'SELECT * FROM family_network_integrations WHERE household_id=$1', [command.household_id]);
  requireValue(integration && device.management_policy_id && device.deny_policy_id, 503, 'network_not_ready', 'Device enrollment is unavailable.');
  if (command.action === 'allow') {
    requireValue(integration.state === 'ready' && integration.management_host === managementHost(env) && integration.management_verified_at
      && networkChecksPassed(integration, device.id) && device.control_state === 'ready' && device.management_verified_at,
      503, 'network_not_ready', 'Device access requires verified network setup.');
    await verifyNetworkScope(provider, integration);
  }
  const sessions = (await db.query('SELECT * FROM family_internet_sessions WHERE household_id=$1 AND device_id=$2', [command.household_id, device.id])).rows;
  const assertOwnership = () => assertWriteOwnership(db, command, clock);
  if (command.action === 'block') await restrictDeviceAccess({ device, integration, sessions, provider, env, assertOwnership });
  if (sessions.some(row => !terminal(row))) return { waiting: true };
  const site = integration.site_id, policies = await provider.policies(site), order = await provider.ordering(site, integration.source_zone_id, integration.external_zone_id);
  const { deny } = inspectDevicePolicyScope({ device, integration, sessions, policies, orderedIds: order.orderedFirewallPolicyIds, env, requireAllowance: true });
  const enabled = command.action === 'block';
  if (deny.enabled !== enabled) {
    if (command.action === 'allow') await verifyNetworkScope(provider, integration);
    await assertOwnership();
    await provider.replacePolicy(site, deny.id, deny, { enabled });
  }
  const readback = await provider.policies(site), ordering = await provider.ordering(site, integration.source_zone_id, integration.external_zone_id);
  inspectDevicePolicyScope({ device, integration, sessions, policies: readback, orderedIds: ordering.orderedFirewallPolicyIds, env, denyEnabled: enabled, requireAllowance: true });
  if (command.action === 'allow') await verifyNetworkScope(provider, integration);
  return { observed: enabled ? 'blocked' : 'allowed' };
}
async function publishDeviceCommand(db, command, outcome, now) {
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${command.household_id}`]);
    const owned = await one(client, "SELECT * FROM family_internet_commands WHERE id=$1 AND state='leased' AND lease_id=$2 FOR UPDATE", [command.id, command.lease_id]);
    if (!owned || new Date(owned.lease_until) <= now) return 'superseded';
    if (outcome.waiting) {
      await client.query("UPDATE family_internet_commands SET state='pending',available_at=$2,lease_id=NULL,lease_until=NULL WHERE id=$1", [command.id, new Date(now.getTime() + 1000)]);
      return 'waiting_for_sessions';
    }
    const device = await one(client, 'SELECT * FROM family_managed_devices WHERE household_id=$1 AND id=$2 FOR UPDATE', [command.household_id, command.device_id]);
    if (outcome.superseded || !device || device.version !== command.session_version) {
      await client.query("UPDATE family_internet_commands SET state='superseded',lease_id=NULL,lease_until=NULL WHERE id=$1", [command.id]); return 'superseded';
    }
    if (outcome.observed === 'blocked') await client.query(`UPDATE family_internet_sessions SET observed_state='blocked',verified_at=$3
      WHERE household_id=$1 AND device_id=$2 AND state IN ('ended','failed') AND observed_state<>'blocked'`, [command.household_id, device.id, now]);
    await client.query('UPDATE family_managed_devices SET observed_access=$3,access_verified_at=$4,access_error=NULL WHERE household_id=$1 AND id=$2', [command.household_id, device.id, outcome.observed, now]);
    await client.query("UPDATE family_internet_commands SET state=$2,lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1", [command.id, device.version === command.session_version ? 'done' : 'superseded']);
    await internetEvent(client, { householdId: command.household_id, deviceId: device.id, type: 'device_access_confirmed', actor: 'system:unifi', details: { access: outcome.observed, version: command.session_version, currentVersion: device.version }, now });
    return outcome.observed;
  });
}
async function deviceCommandFailed(db, command, error, now) {
  const code = typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'network_unavailable';
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${command.household_id}`]);
    const owned = await one(client, "SELECT * FROM family_internet_commands WHERE id=$1 AND state='leased' AND lease_id=$2 FOR UPDATE", [command.id, command.lease_id]);
    if (!owned) return 'superseded';
    await client.query("UPDATE family_managed_devices SET observed_access='unknown',access_error=$3 WHERE household_id=$1 AND id=$2 AND version=$4", [command.household_id, command.device_id, code, command.session_version]);
    await client.query("UPDATE family_internet_commands SET state=$4,available_at=$2,last_error=$3,lease_id=NULL,lease_until=NULL WHERE id=$1", [command.id, new Date(now.getTime() + (command.attempts >= 3 ? 300 : 15 * 2 ** command.attempts) * 1000), code, command.attempts >= 3 ? 'attention' : 'pending']);
    if (command.attempts >= 3) {
      const device = await one(client, 'SELECT person_ids FROM family_managed_devices WHERE household_id=$1 AND id=$2', [command.household_id, command.device_id]);
      await internetNotification(client, { householdId: command.household_id, personId: device?.person_ids[0], deviceId: command.device_id,
        type: 'enforcement_failed', key: `device-enforcement:${command.id}`, now });
    }
    return 'checking';
  });
}
