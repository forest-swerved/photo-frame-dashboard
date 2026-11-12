import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { one, transaction } from './database.js';
import { requireValue } from './errors.js';
import { managedPolicyPlan, policyContentFingerprint, policyFieldValue, reviewedPolicyFingerprint, verifyNetworkScope } from './unifi.js';

const writableFields = ['enabled', 'source', 'destination', 'action', 'ipProtocolScope', 'schedule', 'connectionStateFilter', 'ipsecFilter', 'description'];
export function sameManagedPolicy(actual, expected) {
  return actual?.metadata?.origin === 'USER_DEFINED' && writableFields.every(key =>
    isDeepStrictEqual(policyFieldValue(actual, key), policyFieldValue(expected, key)));
}

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
      && session.policy_fingerprint && policyContentFingerprint(policy) === session.policy_fingerprint,
      503, 'session_policy_changed', 'The registered allowance changed.');
    await assertOwnership();
    await provider.replacePolicy(site, policy.id, policy, { enabled: false });
    requireValue((await provider.policy(site, policy.id))?.enabled === false, 503, 'block_unconfirmed', 'Allowance removal was not confirmed.');
  }
}

// Cron checks idle devices too. Provider reads are outside transactions; the
// version and absence of in-flight work are checked again before publishing.
export async function auditInternetDevices(db, { env, provider, now = new Date() }) {
  const integrations = (await db.query("SELECT * FROM family_network_integrations WHERE state='ready' AND (last_checked_at IS NULL OR last_checked_at<$1)", [new Date(+now - 60000)])).rows;
  for (const integration of integrations) {
    const householdId = integration.household_id;
    if (await one(db, "SELECT id FROM family_internet_commands WHERE household_id=$1 AND state='leased' AND lease_until>$2 LIMIT 1", [householdId, now])) continue;
    const devices = (await db.query("SELECT * FROM family_managed_devices WHERE household_id=$1 AND removed_at IS NULL AND control_state='ready'", [householdId])).rows;
    const sessions = (await db.query('SELECT * FROM family_internet_sessions WHERE household_id=$1', [householdId])).rows;
    let policies, order, error = null;
    try {
      await verifyNetworkScope(provider, integration);
      policies = await provider.policies(integration.site_id);
      order = await provider.ordering(integration.site_id, integration.source_zone_id, integration.external_zone_id);
      for (const session of sessions) {
        const policy = policies.find(p => p.id === session.policy_id);
        requireValue(!policy || policy.enabled === false || session.policy_fingerprint && policyContentFingerprint(policy) === session.policy_fingerprint,
          503, 'session_policy_changed', 'An allowance changed outside Family Frame.');
      }
    } catch (e) { error = e.code || 'network_unavailable'; }
    for (const device of devices) {
      let problem = error, observed = 'unknown';
      try {
        if (problem) throw new Error(problem);
        const actual = reviewedPolicyFingerprint(policies, order.orderedFirewallPolicyIds, { managementId: device.management_policy_id,
          denyId: device.deny_policy_id, ignoredSessionIds: sessions.filter(s => s.policy_id).map(s => s.policy_id) });
        requireValue(actual === device.reviewed_policy_fingerprint, 503, 'policy_review_required', 'The firewall inventory changed.');
        const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: device.mac_addresses, sourceZoneId: integration.source_zone_id,
          destinationZoneId: integration.external_zone_id, allowApplePush: device.allow_apple_push }, env);
        const deny = policies.find(p => p.id === device.deny_policy_id);
        requireValue(sameManagedPolicy(deny, { ...plan.deny, enabled: device.desired_access === 'blocked' })
          && sameManagedPolicy(policies.find(p => p.id === device.management_policy_id), plan.management)
          && (!device.allow_apple_push || sameManagedPolicy(policies.find(p => p.id === device.apple_push_policy_id), plan.applePush)),
          503, 'management_policy_changed', 'A permanent device rule changed.');
        observed = device.desired_access;
      } catch (e) { problem ||= e.code || 'network_unavailable'; }
      await transaction(db, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${householdId}`]);
        if (await one(client, "SELECT id FROM family_internet_commands WHERE household_id=$1 AND state='leased' AND lease_until>$2 LIMIT 1", [householdId, now])) return;
        const current = await one(client, 'SELECT * FROM family_managed_devices WHERE id=$1 AND version=$2 AND removed_at IS NULL FOR UPDATE', [device.id, device.version]);
        if (!current || current.reviewed_policy_fingerprint !== device.reviewed_policy_fingerprint) return;
        if (await one(client, "SELECT id FROM family_internet_commands WHERE device_id=$1 AND state IN ('pending','leased','attention') LIMIT 1", [device.id])) return;
        await client.query('UPDATE family_managed_devices SET observed_access=$2,access_error=$3,access_verified_at=CASE WHEN $3::text IS NULL THEN $4 ELSE access_verified_at END WHERE id=$1', [device.id, observed, problem, now]);
        if (problem && current.desired_access === 'blocked' && !await one(client, "SELECT id FROM family_internet_sessions WHERE device_id=$1 AND state NOT IN ('ended','failed') LIMIT 1", [device.id])) {
          await client.query(`INSERT INTO family_internet_commands(id,household_id,device_id,session_version,action,available_at,created_at)
            VALUES($1,$2,$3,$4,'block',$5,$5)`, [randomUUID(), householdId, device.id, device.version, now]);
        }
      });
      error ||= problem;
    }
    await db.query('UPDATE family_network_integrations SET last_checked_at=$2,last_error=$3 WHERE household_id=$1', [householdId, now, error]);
  }
}
