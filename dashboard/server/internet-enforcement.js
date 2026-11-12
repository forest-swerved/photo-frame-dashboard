import { randomUUID } from 'node:crypto';
import { internetEvent, queueInternetCommand } from './internet.js';
import { one, transaction } from './database.js';
import { requireValue } from './errors.js';
import { managedPolicyPlan, policyContentFingerprint, verifyNetworkScope } from './unifi.js';

import { sameManagedPolicy, inspectDevicePolicyScope } from './internet-policy-scope.js';
export { sameManagedPolicy } from './internet-policy-scope.js';

// This recovery can only narrow access on registered policies. It does not
// accept a changed inventory, move rules, create exceptions, or report success.
export async function restrictDeviceAccess({ device, integration, sessions, provider, env, assertOwnership }) {
  requireValue(device?.deny_policy_id && integration?.site_id, 503, 'network_not_ready', 'Device enrollment is unavailable.');
  const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses,
    sourceZoneId: integration.source_zone_id, destinationZoneId: integration.external_zone_id }, env);
  const site = integration.site_id, deny = await provider.policy(site, device.deny_policy_id);
  requireValue(typeof deny?.enabled === 'boolean' && sameManagedPolicy(deny, { ...plan.deny, enabled: deny.enabled }),
    503, 'management_policy_changed', 'The registered blocking rule changed.');
  if (!deny.enabled) {
    await assertOwnership();
    await provider.replacePolicy(site, deny.id, deny, { enabled: true });
  }
  requireValue(sameManagedPolicy(await provider.policy(site, deny.id), plan.deny), 503, 'block_unconfirmed', 'Blocking was not confirmed.');
  for (const session of sessions) {
    if (!session.policy_id) continue;
    const policy = await provider.policy(site, session.policy_id);
    if (!policy || policy.enabled === false) continue;
    requireValue(policy.metadata?.origin === 'USER_DEFINED' && policy.action?.type === 'ALLOW'
      && (session.policy_fingerprint && policyContentFingerprint(policy) === session.policy_fingerprint
        || session.allow_attempted_at && session.planned_policy_fingerprint && policyContentFingerprint(policy) === session.planned_policy_fingerprint),
      503, 'session_policy_changed', 'The registered allowance changed.');
    await assertOwnership();
    await provider.replacePolicy(site, policy.id, policy, { enabled: false });
    requireValue((await provider.policy(site, policy.id))?.enabled === false, 503, 'block_unconfirmed', 'Allowance removal was not confirmed.');
  }
}

// Read once, assess each device independently, then publish only if its entire
// generation (including sessions) still matches and no command owns the device.
export async function auditInternetDevices(db, { env, provider, now = new Date() }) {
  const integrations = (await db.query("SELECT * FROM family_network_integrations WHERE state='ready' AND (last_checked_at IS NULL OR last_checked_at<$1)", [new Date(+now - 60000)])).rows;
  for (const integration of integrations) {
    const householdId = integration.household_id;
    if (await one(db, "SELECT id FROM family_internet_commands WHERE household_id=$1 AND state='leased' AND lease_until>$2 LIMIT 1", [householdId, now])) continue;
    const devices = (await db.query("SELECT * FROM family_managed_devices WHERE household_id=$1 AND removed_at IS NULL AND control_state='ready'", [householdId])).rows;
    const sessions = (await db.query('SELECT * FROM family_internet_sessions WHERE household_id=$1', [householdId])).rows;
    let policies, order, readError = null, householdError = null;
    try {
      await verifyNetworkScope(provider, integration);
      policies = await provider.policies(integration.site_id);
      order = await provider.ordering(integration.site_id, integration.source_zone_id, integration.external_zone_id);
    } catch (e) { readError = safeError(e); }
    for (const device of devices) {
      const ownSessions = sessions.filter(s => s.device_id === device.id);
      let problem = readError;
      try {
        if (!problem) inspectDevicePolicyScope({ device, integration, policies, orderedIds: order.orderedFirewallPolicyIds,
          sessions: ownSessions, env, denyEnabled: device.desired_access === 'blocked', requireAllowance: true });
      } catch (e) { problem = safeError(e); }
      const published = await transaction(db, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${householdId}`]);
        if (await one(client, "SELECT id FROM family_internet_commands WHERE household_id=$1 AND state='leased' AND lease_until>$2 LIMIT 1", [householdId, now])) return false;
        const current = await one(client, 'SELECT * FROM family_managed_devices WHERE id=$1 AND version=$2 AND removed_at IS NULL FOR UPDATE', [device.id, device.version]);
        if (!current) return false;
        const currentSessions = (await client.query('SELECT * FROM family_internet_sessions WHERE household_id=$1 AND device_id=$2 ORDER BY id FOR UPDATE', [householdId, device.id])).rows;
        if (sessionGeneration(currentSessions) !== sessionGeneration(ownSessions)) return false;
        if (await one(client, `SELECT id FROM family_internet_commands WHERE household_id=$1 AND state IN ('pending','leased','attention')
          AND (device_id=$2 OR session_id IN (SELECT id FROM family_internet_sessions WHERE household_id=$1 AND device_id=$2)) LIMIT 1`, [householdId, device.id])) return false;
        await client.query('UPDATE family_managed_devices SET observed_access=$2,access_error=$3,access_verified_at=CASE WHEN $3::text IS NULL THEN $4 ELSE access_verified_at END WHERE id=$1',
          [device.id, problem ? 'unknown' : device.desired_access, problem, now]);
        if (!problem) {
          await client.query("UPDATE family_internet_sessions SET verified_at=$3,last_error=NULL WHERE household_id=$1 AND device_id=$2 AND state IN ('active','paused')", [householdId, device.id, now]);
          return true;
        }
        if (current.access_error !== problem) await internetEvent(client, { householdId, deviceId: device.id, type: 'device_drift_detected', actor: 'system:unifi', details: { error: problem }, now });
        const live = currentSessions.filter(s => !['ended','failed'].includes(s.state));
        if (live.length) {
          for (const session of live) {
            // Reconcile the existing deadline; never allocate extra time. A
            // paused reward remains paused, and an expired session only blocks.
            const expired = session.ends_at && new Date(session.ends_at) <= now;
            const desired = expired ? 'blocked' : session.desired_state;
            const action = desired === 'blocked' ? session.state === 'paused' && !expired ? 'pause' : 'end' : 'adjust';
            const row = await one(client, `UPDATE family_internet_sessions SET state='checking',observed_state='unknown',last_error=$2,
              desired_state=$3,pending_action=$4,version=version+1 WHERE id=$1 RETURNING *`, [session.id, problem, desired, action]);
            await queueInternetCommand(client, row, now);
          }
        } else if (current.desired_access === 'blocked') {
          await client.query(`INSERT INTO family_internet_commands(id,household_id,device_id,session_version,action,available_at,created_at)
            VALUES($1,$2,$3,$4,'block',$5,$5)`, [randomUUID(), householdId, device.id, device.version, now]);
        }
        // Indefinite On is never re-enabled automatically after external drift.
        return true;
      });
      if (published) householdError ||= problem;
    }
    await db.query('UPDATE family_network_integrations SET last_checked_at=$2,last_error=$3 WHERE household_id=$1', [householdId, now, readError || householdError]);
  }
}
const safeError = error => typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'network_unavailable';
const sessionGeneration = rows => JSON.stringify(rows.map(s => [s.id, s.version, s.state, s.desired_state]).sort((a, b) => a[0].localeCompare(b[0])));
