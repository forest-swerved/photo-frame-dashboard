import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Temporal } from '@js-temporal/polyfill';
import { createPool, one, transaction } from './database.js';
import { ApiError, requireValue, textField, uuidField } from './errors.js';
import { checkedPolicyOrdering, createUniFiClient, managedPolicyPlan, normalizedMac, policyContentFingerprint, policyInventoryFingerprint, reviewedPolicyFingerprint, unifiConfiguration } from './unifi.js';
import { validateTimedWindow } from './internet.js';

const PROOF_AGE = 24 * 3600_000;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const matches = (actual, expected) => Boolean(actual?.metadata?.origin === 'USER_DEFINED' && expected && policyContentFingerprint(actual) === policyContentFingerprint(expected));
const live = "state NOT IN ('ended','failed')";
const confirmation = (input, deviceId) => requireValue(input.apply === true && input.confirmDevice === deviceId,
  422, 'operator_confirmation_required', 'This command writes owner records. Pass --apply and --confirm-device with the exact device UUID.');

export async function assertOperatorDatabase(db, expectedRole = 'family_frame_server') {
  const role = await one(db, `SELECT current_user AS name,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS no_memberships FROM pg_roles r WHERE r.rolname=current_user`);
  requireValue(role?.name === expectedRole && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication && !role.rolbypassrls && role.no_memberships,
    503, 'operator_role_required', 'Use the dedicated restricted family_frame_server database connection.');
  const owned = await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[]) AND c.relowner=current_user::regrole`,
  [['family_managed_devices', 'family_network_integrations', 'family_internet_events']]);
  requireValue(owned.rowCount === 3, 503, 'operator_role_required', 'The server role must own the Internet control tables.');
}

async function loadDevice(db, input) {
  uuidField(input.deviceId, 'Device');
  const device = await one(db, `SELECT d.*,h.timezone FROM family_managed_devices d JOIN family_households h ON h.id=d.household_id
    WHERE d.id=$1 AND d.removed_at IS NULL`, [input.deviceId]);
  requireValue(device, 404, 'device_not_found', 'Add the device and its stable addresses in Family Frame before making an enrollment plan.');
  const integration = await one(db, 'SELECT * FROM family_network_integrations WHERE household_id=$1', [device.household_id]);
  const config = { siteId: input.siteId || integration?.site_id, sourceZoneId: input.sourceZoneId || integration?.source_zone_id,
    externalZoneId: input.externalZoneId || integration?.external_zone_id };
  for (const [key, stored] of [['siteId', 'site_id'], ['sourceZoneId', 'source_zone_id'], ['externalZoneId', 'external_zone_id']]) {
    uuidField(config[key], key);
    requireValue(!integration?.[stored] || integration[stored] === config[key], 409, 'integration_changed', 'The plan cannot silently change an existing household network connection.');
  }
  const macs = [...new Set(device.mac_addresses.map(normalizedMac))].sort();
  requireValue(macs.length === device.mac_addresses.length, 409, 'identity_changed', 'Remove duplicated device addresses before enrollment.');
  const overlaps = await one(db, 'SELECT id FROM family_managed_devices WHERE household_id=$1 AND id<>$2 AND removed_at IS NULL AND mac_addresses && $3::text[] LIMIT 1', [device.household_id, device.id, macs]);
  requireValue(!overlaps, 409, 'identity_in_use', 'A saved address belongs to another managed device. Review grouped identities first.');
  return { device, integration, config, macs };
}

export function inspectPolicyInventory({ device, config, macs, policies, orderedIds, knownSessions = [], input, consoleId, applicationVersion, env = process.env, now = new Date() }) {
  requireValue(typeof applicationVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(applicationVersion),
    503, 'application_version_unverified', 'Read the Network application version before reviewing its policy behavior.');
  const ordering = checkedPolicyOrdering(policies, orderedIds, { sourceZoneId: config.sourceZoneId, destinationZoneId: config.externalZoneId });
  const beforeIds = ordering.beforeSystemDefined;
  const byId = new Map(policies.map(policy => [uuidField(policy.id), policy]));
  const plan = managedPolicyPlan({ deviceId: device.id, macAddresses: macs, sourceZoneId: config.sourceZoneId,
    destinationZoneId: config.externalZoneId, allowApplePush: device.allow_apple_push === true }, env);
  const ids = { management: input.managementPolicyId || device.management_policy_id || null,
    deny: input.denyPolicyId || device.deny_policy_id || null,
    applePush: device.allow_apple_push ? input.applePolicyId || device.apple_push_policy_id || null : null };
  for (const [kind, stored] of [['management', 'management_policy_id'], ['deny', 'deny_policy_id'], ['applePush', 'apple_push_policy_id']]) {
    if (ids[kind]) uuidField(ids[kind], `${kind} policy`);
    requireValue(!device[stored] || device[stored] === ids[kind], 409, 'policy_identity_changed', 'An existing managed policy identity cannot be replaced by a command-line argument.');
  }
  const selectedIds = Object.values(ids).filter(Boolean);
  requireValue(new Set(selectedIds).size === selectedIds.length, 422, 'policy_identity_changed', 'Management, notification and blocking policies need distinct identities.');
  const ignoredSessions = [];
  for (const session of knownSessions) {
    const policy = byId.get(session.policy_id);
    if (!policy) continue;
    requireValue(policy.enabled === false || session.state === 'active' && session.observed_state === 'allowed' && session.verified_at
      && session.policy_fingerprint && policyContentFingerprint(policy) === session.policy_fingerprint,
    409, 'session_policy_unverified', 'An existing session policy must be reconciled before enrollment.');
    ignoredSessions.push(policy.id);
  }
  requireValue(!selectedIds.some(id => ignoredSessions.includes(id)), 409, 'policy_identity_changed', 'A session policy cannot become a permanent device policy.');
  const foreign = beforeIds.filter(id => !selectedIds.includes(id) && !ignoredSessions.includes(id));
  const before = input.beforePolicyId;
  requireValue(before === 'system' || foreign.includes(before), 422, 'policy_anchor_required', 'Review a custom --before policy UUID, or --before system to insert immediately before the built-in rules.');
  const at = before === 'system' ? foreign.length : foreign.indexOf(before);
  const installed = [ids.management, ids.applePush, ids.deny].filter(id => id && byId.has(id));
  const expectedOrder = [...foreign.slice(0, at), ...installed, ...foreign.slice(at)];
  const actualOrder = beforeIds.filter(id => !ignoredSessions.includes(id));
  const placementVerified = JSON.stringify(expectedOrder) === JSON.stringify(actualOrder)
    && !ordering.afterSystemDefined.some(id => selectedIds.includes(id));
  const management = byId.get(ids.management), deny = byId.get(ids.deny), apple = byId.get(ids.applePush);
  const managementVerified = matches(management, plan.management) && beforeIds.includes(ids.management);
  const appleVerified = !device.allow_apple_push || matches(apple, plan.applePush) && beforeIds.includes(ids.applePush);
  const permanentDenyVerified = matches(deny, { ...plan.deny, enabled: device.default_access !== 'allowed' }) && beforeIds.includes(ids.deny);
  let pilotDenyVerified = false;
  if (deny?.schedule?.mode === 'ONE_TIME_ONLY' && deny.schedule.timeFilter && matches(deny, { ...plan.deny, schedule: deny.schedule })) {
    try {
      const schedule = deny.schedule, filter = schedule.timeFilter;
      requireValue(/^\d{4}-\d{2}-\d{2}$/.test(schedule.date) && /^\d{2}:\d{2}$/.test(filter.startTime) && /^\d{2}:\d{2}$/.test(filter.stopTime), 422, 'pilot_window_invalid', 'A pilot needs a concrete bounded window.');
      const start = Temporal.PlainDate.from(schedule.date).toPlainDateTime(filter.startTime).toZonedDateTime(device.timezone, { disambiguation: 'reject' });
      const end = Temporal.PlainDate.from(schedule.date).toPlainDateTime(filter.stopTime).toZonedDateTime(device.timezone, { disambiguation: 'reject' });
      validateTimedWindow(new Date(start.epochMilliseconds), new Date(end.epochMilliseconds), device.timezone);
      pilotDenyVerified = end.epochMilliseconds > start.epochMilliseconds && end.epochMilliseconds - start.epochMilliseconds <= 300_000
        && end.epochMilliseconds >= now.getTime() - PROOF_AGE && start.epochMilliseconds <= now.getTime() + 300_000;
    } catch { /* A broad, ambiguous or stale pilot is not accepted. */ }
  }
  const identity = { deviceId: device.id, householdId: device.household_id, name: device.name, kind: device.kind,
    personIds: [...device.person_ids].sort(), defaultAccess: device.default_access || 'blocked', macAddresses: macs, allowApplePush: device.allow_apple_push === true,
    timezone: device.timezone, consoleId, applicationVersion, ...config, managementHost: plan.managementHost, beforePolicyId: before };
  const foreignDigest = policyInventoryFingerprint(policies, ordering, { ignoredPolicyIds: [...selectedIds, ...ignoredSessions],
    sourceZoneId: config.sourceZoneId, destinationZoneId: config.externalZoneId });
  const identityBinding = hash({ version: 2, identity });
  const managementBinding = hash({ identityBinding, foreignDigest, managementId: ids.management, applePushId: ids.applePush,
    management: policyContentFingerprint(plan.management), applePush: plan.applePush ? policyContentFingerprint(plan.applePush) : null });
  const binding = hash({ managementBinding, denyId: ids.deny, deny: policyContentFingerprint(plan.deny) });
  const reviewedFingerprint = ids.management && ids.deny && permanentDenyVerified && managementVerified && appleVerified && placementVerified
    ? reviewedPolicyFingerprint(policies, ordering, { managementId: ids.management, denyId: ids.deny, ignoredSessionIds: ignoredSessions }) : null;
  return { version: 2, deviceId: device.id, deviceName: device.name, ...config, beforePolicyId: before, macAddresses: macs,
    managementHost: plan.managementHost, applicationVersion, timezone: device.timezone, policyIds: ids, requiredChecks: ['identity_stability', 'management_preflight', ...plan.requiredChecks],
    policies: { management: plan.management, ...(plan.applePush ? { applePush: plan.applePush } : {}), deny: plan.deny },
    orderedPolicyIds: ordering, foreignPolicyDigest: foreignDigest, identityBinding, managementBinding, binding, reviewedFingerprint,
    observations: { managementVerified, appleVerified, permanentDenyVerified, pilotDenyVerified, placementVerified,
      denyAbsentOrDisabled: !deny || deny.enabled === false }, providerWrites: false };
}

async function inspection(db, input, { env = process.env, provider = createUniFiClient({ env }), now = new Date(), expectedRole } = {}) {
  await assertOperatorDatabase(db, expectedRole);
  const context = await loadDevice(db, input), { device, config } = context;
  const { consoleId } = unifiConfiguration(env);
  const [info, sites, zones, policies, ordering, known] = await Promise.all([
    provider.info(), provider.sites(), provider.zones(config.siteId), provider.policies(config.siteId), provider.ordering(config.siteId, config.sourceZoneId, config.externalZoneId),
    db.query('SELECT * FROM family_internet_sessions WHERE household_id=$1 AND policy_id IS NOT NULL', [device.household_id]),
  ]);
  requireValue(sites.some(site => site.id === config.siteId) && zones.some(zone => zone.id === config.sourceZoneId) && zones.some(zone => zone.id === config.externalZoneId),
    422, 'network_selection_invalid', 'The selected site and firewall zones must exist on this console.');
  const plan = inspectPolicyInventory({ ...context, policies, orderedIds: ordering?.orderedFirewallPolicyIds, knownSessions: known.rows, input, consoleId, applicationVersion: info?.applicationVersion, env, now });
  return { ...context, plan };
}

async function proofs(db, context, now) {
  const rows = (await db.query(`SELECT details,created_at,id FROM family_internet_events WHERE household_id=$1 AND device_id=$2 AND type='operator_proof'
    ORDER BY created_at DESC,id DESC LIMIT 1000`, [context.device.household_id, context.device.id])).rows;
  const seen = new Map();
  for (const row of rows) {
    const item = row.details;
    const expected = item.check === 'identity_stability' ? context.plan.identityBinding : item.check === 'management_preflight' ? context.plan.managementBinding : context.plan.binding;
    if (item.binding !== expected || seen.has(item.check)) continue;
    seen.set(item.check, item);
  }
  return context.plan.requiredChecks.map(check => {
    const proof = seen.get(check), age = proof ? now - new Date(proof.observedAt) : Infinity;
    return { check, passed: proof?.result === 'pass' && age >= -5000 && age <= PROOF_AGE, proof: proof || null };
  });
}

async function exclusiveContext(client, original) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${original.device.household_id}`]);
  const household = await one(client, 'SELECT timezone FROM family_households WHERE id=$1 FOR SHARE', [original.device.household_id]);
  const device = await one(client, 'SELECT * FROM family_managed_devices WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [original.device.id]);
  const integration = await one(client, 'SELECT * FROM family_network_integrations WHERE household_id=$1 FOR UPDATE', [original.device.household_id]);
  requireValue(household?.timezone === original.device.timezone && device?.version === original.device.version
    && (integration?.version || 0) === (original.integration?.version || 0),
    409, 'operator_plan_changed', 'The saved device, household timezone, or connection changed during inspection. Build a new plan.');
  requireValue(!await one(client, "SELECT id FROM family_internet_commands WHERE household_id=$1 AND device_id IS NOT NULL AND state IN ('pending','leased','attention') LIMIT 1", [device.household_id]),
    409, 'device_access_pending', 'Confirm pending parent device controls before changing network enrollment.');
  requireValue(!await one(client, `SELECT id FROM family_internet_sessions WHERE household_id=$1 AND ${live} LIMIT 1`, [device.household_id]),
    409, 'internet_sessions_active', 'End all household Internet sessions and confirm their blocking before enrollment.');
  return { device, integration };
}

export async function runOperator(db, command, input, options = {}) {
  const now = options.now || new Date();
  if (command === 'inventory') {
    await assertOperatorDatabase(db, options.expectedRole);
    const devices = (await db.query('SELECT id,name,kind,person_ids,mac_addresses,control_state FROM family_managed_devices WHERE removed_at IS NULL ORDER BY name,id LIMIT 100')).rows;
    try { unifiConfiguration(options.env || process.env); }
    catch { return { inactive: true, reason: 'unifi_not_configured', devices, requiredEnvironment: ['FAMILY_UNIFI_API_KEY', 'FAMILY_UNIFI_CONSOLE_ID'], providerWrites: false }; }
    const provider = options.provider || createUniFiClient({ env: options.env || process.env });
    const [info, sites] = await Promise.all([provider.info(), provider.sites()]);
    if (!input.siteId) return { applicationVersion: info?.applicationVersion, sites, devices, providerWrites: false };
    uuidField(input.siteId);
    const zones = await provider.zones(input.siteId);
    if (!input.sourceZoneId || !input.externalZoneId) return { sites, zones, devices, providerWrites: false };
    uuidField(input.sourceZoneId); uuidField(input.externalZoneId);
    const [policies, ordering] = await Promise.all([provider.policies(input.siteId), provider.ordering(input.siteId, input.sourceZoneId, input.externalZoneId)]);
    return { sites, zones, devices, policies, ordering, providerWrites: false };
  }
  const context = await inspection(db, input, { ...options, now });
  const { plan, device, config } = context;
  const checks = await proofs(db, context, now);
  if (['plan', 'inspect'].includes(command)) return { ...plan, checks: checks.map(({ check, passed }) => ({ check, passed })),
    activationAllowed: checks.every(item => item.passed) && Boolean(plan.reviewedFingerprint), storedControlState: device.control_state };
  if (command === 'begin-pilot') {
    if (!input.apply) return { dryRun: true, effect: 'Gate household Internet starts and require every previously enrolled device to be reviewed again.', deviceId: device.id };
    confirmation(input, device.id);
    return transaction(db, async client => {
      await exclusiveContext(client, context);
      await client.query(`INSERT INTO family_network_integrations(household_id,site_id,source_zone_id,external_zone_id,state,management_host,pilot_checks)
        VALUES($1,$2,$3,$4,'pilot_required',$5,'{}') ON CONFLICT(household_id) DO UPDATE SET state='pilot_required',pilot_checks='{}',
          site_id=EXCLUDED.site_id,source_zone_id=EXCLUDED.source_zone_id,external_zone_id=EXCLUDED.external_zone_id,management_host=EXCLUDED.management_host,
          version=family_network_integrations.version+1,last_error=NULL`,
      [device.household_id, config.siteId, config.sourceZoneId, config.externalZoneId, plan.managementHost]);
      await client.query("UPDATE family_managed_devices SET control_state='attention',version=version+1 WHERE household_id=$1 AND control_state='ready'", [device.household_id]);
      await client.query("INSERT INTO family_internet_events(id,household_id,device_id,type,actor,details,created_at) VALUES($1,$2,$3,'operator_pilot_started','operator:local',$4::jsonb,$5)",
        [randomUUID(), device.household_id, device.id, JSON.stringify({ binding: plan.binding, beforePolicyId: plan.beforePolicyId }), now]);
      return { pilotRequired: true, providerWrites: false };
    });
  }
  requireValue(context.integration?.state === 'pilot_required' || command === 'activate' && context.integration?.state === 'ready',
    409, 'pilot_gate_required', 'Run begin-pilot with explicit confirmation before collecting proofs or finalizing enrollment.');
  if (command === 'record-proof') {
    requireValue(plan.requiredChecks.includes(input.check) && ['pass', 'fail'].includes(input.result), 422, 'invalid_proof', 'Name a required check and its actual pass/fail result.');
    const operator = textField(input.operator, 'Named operator', 80), summary = textField(input.summary, 'Observed result', 1000);
    const observed = new Date(input.observedAt);
    requireValue(input.observedAt && Number.isFinite(observed.getTime()) && now - observed >= -5000 && now - observed <= PROOF_AGE,
      422, 'invalid_proof', 'Record the actual observation time within the last 24 hours.');
    requireValue(typeof input.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(input.evidenceSha256), 422, 'invalid_proof', 'Provide a SHA-256 digest of the private evidence file.');
    const obs = plan.observations;
    if (input.check !== 'identity_stability') requireValue(obs.managementVerified && obs.appleVerified && obs.placementVerified,
      409, 'management_unverified', 'Install and read back the permanent management and notification exceptions in the reviewed order first.');
    if (input.check === 'management_preflight') requireValue(obs.denyAbsentOrDisabled, 409, 'premature_block', 'Management preflight must happen before enabling the device block.');
    if (!['identity_stability', 'management_preflight'].includes(input.check)) {
      requireValue(checks.filter(item => ['identity_stability', 'management_preflight'].includes(item.check)).every(item => item.passed), 409, 'preflight_required', 'Record stable identity and management preflight before the blocking pilot.');
      requireValue(obs.pilotDenyVerified || obs.permanentDenyVerified, 409, 'pilot_policy_unverified', 'The device block must exactly match the bounded pilot or reviewed permanent policy.');
    }
    const detail = { check: input.check, result: input.result, operator, summary, observedAt: observed.toISOString(), evidenceSha256: input.evidenceSha256,
      binding: input.check === 'identity_stability' ? plan.identityBinding : input.check === 'management_preflight' ? plan.managementBinding : plan.binding };
    if (!input.apply) return { dryRun: true, proof: detail, providerWrites: false };
    confirmation(input, device.id);
    return transaction(db, async client => {
      await exclusiveContext(client, context);
      // Serialize proof ordering independently of a laptop clock or equal
      // millisecond timestamps: a newly recorded failure must supersede a pass.
      await client.query(`INSERT INTO family_internet_events(id,household_id,device_id,type,actor,details,created_at)
        VALUES($1,$2,$3,'operator_proof','operator:local',$4::jsonb,greatest(clock_timestamp(),coalesce(
          (SELECT max(e.created_at)+interval '1 microsecond' FROM family_internet_events e WHERE e.household_id=$2 AND e.device_id=$3 AND e.type='operator_proof'),'-infinity'::timestamptz)))`,
      [randomUUID(), device.household_id, device.id, JSON.stringify(detail)]);
      return { recorded: true, check: input.check, result: input.result, providerWrites: false };
    });
  }
  if (command === 'pilot-plan') {
    requireValue(checks.filter(item => ['identity_stability', 'management_preflight'].includes(item.check)).every(item => item.passed), 409, 'preflight_required', 'Record stable identity and actual management preflight before the blocking pilot.');
    requireValue(plan.observations.managementVerified && plan.observations.appleVerified && plan.observations.placementVerified,
      409, 'management_unverified', 'The permanent exceptions changed after preflight.');
    const start = Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(device.timezone);
    const end = start.add({ minutes: 5 }).round({ smallestUnit: 'minute', roundingMode: 'floor' });
    validateTimedWindow(now, new Date(end.epochMilliseconds), device.timezone);
    requireValue(start.toPlainDate().equals(end.toPlainDate()), 409, 'pilot_window_unsafe', 'Run the initial short pilot away from household midnight.');
    return { dryRun: true, providerWrites: false, deviceId: device.id, binding: plan.binding,
      pilotDeny: { ...plan.policies.deny, schedule: { mode: 'ONE_TIME_ONLY', date: start.toPlainDate().toString(),
        timeFilter: { startTime: start.toPlainTime().toString({ smallestUnit: 'minute' }), stopTime: end.toPlainTime().toString({ smallestUnit: 'minute' }) } } },
      endsAt: new Date(end.epochMilliseconds).toISOString(), instruction: 'Manually install this bounded pilot only on the named device; retain local gateway access and both permanent exceptions.' };
  }
  requireValue(['permanent-plan', 'activate'].includes(command), 422, 'invalid_command', 'Choose inventory, inspect, plan, begin-pilot, record-proof, pilot-plan, permanent-plan, or activate.');
  requireValue(checks.every(item => item.passed), 409, 'pilot_proofs_missing', `Enrollment is inactive. Missing or failed checks: ${checks.filter(item => !item.passed).map(item => item.check).join(', ')}.`);
  if (command === 'permanent-plan') return { dryRun: true, providerWrites: false, deviceId: device.id, binding: plan.binding, permanentDeny: { ...plan.policies.deny, enabled: device.default_access !== 'allowed' },
    instruction: 'Manually replace only the tested device deny with this permanent policy. Read back the full inventory before activate.' };
  requireValue(plan.reviewedFingerprint, 409, 'permanent_policies_unverified', 'The permanent exceptions, deny policy and full reviewed order must match before activation.');
  if (!input.apply) return { dryRun: true, activationAllowed: true, deviceId: device.id, providerWrites: false };
  confirmation(input, device.id);
  return transaction(db, async client => {
    await exclusiveContext(client, context);
    const latestProofs = await proofs(client, context, now);
    requireValue(latestProofs.every(item => item.passed), 409, 'pilot_proofs_missing', 'A required proof changed. Review the pilot before activation.');
    await client.query(`UPDATE family_managed_devices SET control_state='ready',management_policy_id=$2,deny_policy_id=$3,apple_push_policy_id=$4,
      reviewed_policy_fingerprint=$5,management_verified_at=$6,desired_access=default_access,observed_access=default_access,access_verified_at=$6,access_error=NULL,version=version+1 WHERE id=$1`,
    [device.id, plan.policyIds.management, plan.policyIds.deny, plan.policyIds.applePush, plan.reviewedFingerprint, now]);
    await client.query(`UPDATE family_network_integrations SET state='ready',pilot_checks=pilot_checks||$2::jsonb,management_verified_at=$3,last_checked_at=$3,last_error=NULL,version=version+1 WHERE household_id=$1`,
      [device.household_id, JSON.stringify(Object.fromEntries(plan.requiredChecks.filter(check => !['identity_stability', 'management_preflight'].includes(check)).map(check => [check, true]))), now]);
    await client.query("INSERT INTO family_internet_events(id,household_id,device_id,type,actor,details,created_at) VALUES($1,$2,$3,'operator_device_activated','operator:local',$4::jsonb,$5)",
      [randomUUID(), device.household_id, device.id, JSON.stringify({ binding: plan.binding, reviewedFingerprint: plan.reviewedFingerprint }), now]);
    return { ready: true, deviceId: device.id, providerWrites: false };
  });
}

export async function operatorMain(argv = process.argv.slice(2), env = process.env) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    device: { type: 'string' }, site: { type: 'string' }, 'source-zone': { type: 'string' }, 'external-zone': { type: 'string' }, before: { type: 'string' },
    'management-policy': { type: 'string' }, 'deny-policy': { type: 'string' }, 'apple-policy': { type: 'string' },
    apply: { type: 'boolean', default: false }, 'confirm-device': { type: 'string' }, check: { type: 'string' }, result: { type: 'string' },
    operator: { type: 'string' }, summary: { type: 'string' }, evidence: { type: 'string' }, 'observed-at': { type: 'string' },
  } });
  requireValue(positionals.length === 1, 422, 'invalid_command', 'Supply one operator command. See docs/unifi-operator-guide.md.');
  const input = { deviceId: values.device, siteId: values.site, sourceZoneId: values['source-zone'], externalZoneId: values['external-zone'], beforePolicyId: values.before,
    managementPolicyId: values['management-policy'], denyPolicyId: values['deny-policy'], applePolicyId: values['apple-policy'], apply: values.apply,
    confirmDevice: values['confirm-device'], check: values.check, result: values.result, operator: values.operator, summary: values.summary, observedAt: values['observed-at'] };
  if (values.evidence) {
    const file = await readFile(values.evidence);
    requireValue(file.length > 0 && file.length <= 5 * 1024 * 1024, 422, 'invalid_proof', 'Keep each private evidence file between 1 byte and 5 MiB.');
    input.evidenceSha256 = createHash('sha256').update(file).digest('hex');
  }
  const pool = createPool(env, { migration: true, max: 1 });
  try { return await runOperator(pool, positionals[0], input, { env }); }
  finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  operatorMain().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    const known = error instanceof ApiError;
    process.stderr.write(`${known ? error.code : 'operator_failed'}: ${known ? error.message : 'The operator command failed; no credentials were logged.'}\n`);
    process.exitCode = 1;
  });
}
