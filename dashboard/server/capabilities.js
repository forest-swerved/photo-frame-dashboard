import { randomInt, randomUUID } from 'node:crypto';
import { one, transaction } from './database.js';
import { digest, keyedDigest, randomToken } from './credentials.js';
import { requireAdmin, requireHousehold } from './auth.js';
import { requireValue, uuidField } from './errors.js';

export async function parentCapabilities(db, principal) {
  requireHousehold(principal);
  if (principal.verifiedFrameGrant) return principal.verifiedFrameGrant.scope === 'parent'
    ? principal.verifiedFrameGrant.capabilities : { manageChores: false, manageInternet: false };
  if (!['user', 'mobile'].includes(principal.authType) || principal.role === 'child') return { manageChores: false, manageInternet: false };
  const row = await one(db, 'SELECT role,manage_chores,manage_internet FROM family_members WHERE household_id=$1 AND user_id=$2 AND revoked_at IS NULL', [principal.household.id, principal.user.id]);
  return { manageChores: Boolean(row && (row.role === 'admin' || row.role === 'member' && row.manage_chores)),
    manageInternet: Boolean(row && (row.role === 'admin' || row.role === 'member' && row.manage_internet)) };
}

export async function requireCapability(db, principal, capability) {
  const capabilities = await parentCapabilities(db, principal);
  requireValue(capabilities[capability] === true, 403, 'parent_required', 'A parent with permission must approve this action.');
  return capabilities;
}

export function requireChoreManager(principal) {
  requireHousehold(principal);
  requireValue(['user', 'mobile'].includes(principal.authType) && principal.role === 'admin'
    || principal.verifiedCapabilities?.manageChores === true,
  403, 'parent_required', 'A parent with task permission must approve this action.');
}

export async function changeMemberCapabilities(db, principal, userId, body) {
  requireAdmin(principal);
  requireValue(Object.keys(body).every(key => ['manageChores', 'manageInternet'].includes(key))
    && typeof body.manageChores === 'boolean' && typeof body.manageInternet === 'boolean', 422, 'invalid_capabilities', 'Choose both caregiver permissions.');
  const row = await one(db, `UPDATE family_members SET manage_chores=$3,manage_internet=$4
    WHERE household_id=$1 AND user_id=$2 AND role='member' AND revoked_at IS NULL RETURNING user_id`,
  [principal.household.id, String(userId), body.manageChores, body.manageInternet]);
  requireValue(row, 404, 'not_found', 'That caregiver account does not exist.');
  return { id: row.user_id, capabilities: { manageChores: body.manageChores, manageInternet: body.manageInternet } };
}

export async function transferOwnership(db, principal, body) {
  requireAdmin(principal);
  const userId = uuidField(body.userId, 'New owner');
  requireValue(userId !== principal.user.id, 422, 'invalid_owner', 'Choose another adult account.');
  return transaction(db, async client => {
    for (const id of [principal.user.id, userId].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`membership:${id}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${principal.household.id}`]);
    const members = (await client.query('SELECT user_id,role,revoked_at FROM family_members WHERE household_id=$1 AND user_id=ANY($2::text[]) ORDER BY user_id FOR UPDATE', [principal.household.id, [principal.user.id, userId]])).rows;
    requireValue(members.some(row => row.user_id === principal.user.id && row.role === 'admin' && !row.revoked_at), 403, 'admin_required', 'Only the current administrator can transfer ownership.');
    requireValue(members.some(row => row.user_id === userId && row.role === 'member' && !row.revoked_at), 422, 'invalid_owner', 'Choose an existing adult caregiver account.');
    requireValue(!await one(client, 'SELECT user_id FROM family_account_deletion_jobs WHERE user_id=$1', [userId]), 409, 'account_deleting', 'That account is being deleted.');
    await client.query("UPDATE family_members SET role='admin',manage_chores=true,manage_internet=true WHERE household_id=$1 AND user_id=$2", [principal.household.id, userId]);
    await client.query("UPDATE family_members SET role='member',manage_chores=true,manage_internet=true WHERE household_id=$1 AND user_id=$2", [principal.household.id, principal.user.id]);
    return { transferred: true, userId };
  });
}

// Recheck issuance authority after taking the code lock. Authentication may have
// happened before recovery, membership changes, or account cleanup began.
async function frameCodeIssuer(client, principal, scope, personId) {
  const member = await one(client, `SELECT role,person_id,manage_chores,manage_internet FROM family_members m
    WHERE household_id=$1 AND user_id=$2 AND revoked_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM family_account_deletion_jobs d WHERE d.user_id=$2::uuid)`,
  [principal.household.id, principal.user.id]);
  requireValue(member, 403, 'parent_required', 'Your household access has ended. Sign in again.');
  let live;
  if (principal.authType === 'user') {
    requireValue(principal.sessionId, 401, 'session_required', 'Your sign-in has ended. Sign in again.');
    live = await one(client, `SELECT id FROM family_internal.auth_sessions WHERE id=$1::uuid AND user_id=$2::uuid
      AND (not_after IS NULL OR not_after>clock_timestamp())`, [principal.sessionId, principal.user.id]);
  } else {
    requireValue(principal.mobileSessionId, 401, 'mobile_session_revoked', 'Sign in to this app again.');
    live = await one(client, `SELECT s.id FROM family_mobile_sessions s JOIN family_internal.auth_sessions a
      ON a.id=s.provider_session_id AND a.user_id::text=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.household_id=$3 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND (a.not_after IS NULL OR a.not_after>clock_timestamp())
        AND ((s.kind='parent' AND $4 IN ('admin','member') AND s.person_id IS NULL AND $5::uuid IS NULL)
          OR (s.kind='child' AND $4='child' AND s.person_id=$5::uuid))`,
    [principal.mobileSessionId, principal.user.id, principal.household.id, member.role, member.person_id]);
  }
  requireValue(live, 401, 'session_required', 'Your sign-in has ended. Sign in again.');
  if (scope === 'parent') requireValue(member.role === 'admin' || member.role === 'member' && (member.manage_chores || member.manage_internet),
    403, 'parent_required', 'A parent with permission must create this unlock.');
  else {
    requireValue(member.role === 'child' ? member.person_id === personId : member.role === 'admin' || member.role === 'member' && member.manage_internet,
      403, 'parent_required', 'Use your own profile, or ask a parent with Internet permission.');
    requireValue(await one(client, 'SELECT id FROM family_people WHERE household_id=$1 AND id=$2', [principal.household.id, personId]),
      404, 'not_found', 'That child profile does not exist.');
  }
}

// Run after global provider sign-out. Issuance uses these same ordered locks and
// rechecks its live session inside them, so an older queued request cannot mint
// a surviving grant after recovery. Ordinary sign-out does not call this.
export async function revokeFrameAccessAfterRecovery(db, userId) {
  return transaction(db, async client => {
    const households = (await client.query(`SELECT household_id FROM family_members WHERE user_id=$1
      UNION SELECT household_id FROM family_frame_authorizations WHERE created_by=$1 ORDER BY household_id`, [userId])).rows;
    for (const row of households) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`frame-unlock:${row.household_id}:${userId}`]);
    await client.query('UPDATE family_frame_authorizations SET revoked_at=coalesce(revoked_at,now()) WHERE created_by=$1', [userId]);
  });
}

export async function createFrameAccessCode(db, principal, body, { env = process.env, now = new Date() } = {}) {
  requireHousehold(principal);
  requireValue(['user', 'mobile'].includes(principal.authType), 403, 'account_required', 'Create an unlock code from your signed-in phone.');
  requireValue(['parent', 'child'].includes(body.scope), 422, 'invalid_scope', 'Choose a parent or child unlock.');
  const personId = body.scope === 'child' ? uuidField(body.personId, 'Child profile') : null;
  return transaction(db, async client => {
    // Match cleanup/ownership lock ordering so deletion cannot be followed by
    // a stale in-flight issuer recreating an account-owned authorization row.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`membership:${principal.user.id}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`frame-unlock:${principal.household.id}:${principal.user.id}`]);
    await frameCodeIssuer(client, principal, body.scope, personId);
    await client.query("DELETE FROM family_frame_authorizations WHERE household_id=$1 AND expires_at<$2::timestamptz-interval '1 day'", [principal.household.id, now]);
    await client.query('UPDATE family_frame_authorizations SET revoked_at=$3 WHERE household_id=$1 AND created_by=$2 AND revoked_at IS NULL', [principal.household.id, principal.user.id, now]);
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = String(randomInt(1_000_000)).padStart(6, '0');
      const row = await one(client, `INSERT INTO family_frame_authorizations(id,household_id,created_by,scope,person_id,code_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(code_hash) DO NOTHING RETURNING id`,
      [randomUUID(), principal.household.id, principal.user.id, body.scope, personId, keyedDigest('frame-unlock', code, env), expiresAt]);
      if (row) return { code, scope: body.scope, personId, expiresAt: expiresAt.toISOString() };
    }
    throw new Error('Unlock code allocation failed.');
  });
}

export async function redeemFrameAccess(db, principal, body, { env = process.env, now = new Date() } = {}) {
  requireValue(principal.authType === 'frame' && !principal.verifiedFrameGrant, 403, 'frame_required', 'Enter this code on the paired family frame.');
  requireValue(typeof body.code === 'string' && /^\d{6}$/.test(body.code), 403, 'invalid_unlock', 'That unlock code is invalid or expired.');
  return transaction(db, async client => {
    const row = await one(client, `SELECT * FROM family_frame_authorizations WHERE household_id=$1 AND code_hash=$2
      AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at>$3 FOR UPDATE`, [principal.household.id, keyedDigest('frame-unlock', body.code, env), now]);
    requireValue(row, 403, 'invalid_unlock', 'That unlock code is invalid or expired.');
    const token = randomToken(), expiresAt = new Date(now.getTime() + 10 * 60_000);
    await client.query('UPDATE family_frame_authorizations SET token_hash=$2,frame_id=$3,redeemed_at=$4,expires_at=$5 WHERE id=$1', [row.id, digest(token), principal.user.id, now, expiresAt]);
    return { token, scope: row.scope, personId: row.person_id, expiresAt: expiresAt.toISOString() };
  });
}

export async function frameAuthorization(db, principal, token, now = new Date()) {
  requireValue(principal.authType === 'frame' && typeof token === 'string' && token.length <= 200, 403, 'invalid_unlock', 'Unlock the frame again from your phone.');
  const row = await one(db, `SELECT a.*,m.role AS owner_role,m.person_id AS owner_person,m.manage_chores,m.manage_internet
    FROM family_frame_authorizations a JOIN family_members m ON m.household_id=a.household_id AND m.user_id=a.created_by
    WHERE a.household_id=$1 AND a.frame_id=$2 AND a.token_hash=$3 AND a.redeemed_at IS NOT NULL AND a.revoked_at IS NULL
      AND a.expires_at>$4 AND m.revoked_at IS NULL`, [principal.household.id, principal.user.id, digest(token), now]);
  requireValue(row && (row.scope === 'parent' ? row.owner_role === 'admin' || row.owner_role === 'member' && (row.manage_internet || row.manage_chores)
    : row.owner_role === 'admin' || row.owner_role === 'member' && row.manage_internet || row.owner_role === 'child' && row.owner_person === row.person_id),
  403, 'invalid_unlock', 'Unlock the frame again from your phone.');
  const capabilities = row.scope === 'parent' ? { manageChores: row.owner_role === 'admin' || row.manage_chores, manageInternet: row.owner_role === 'admin' || row.manage_internet } : { manageChores: false, manageInternet: false };
  return { ...principal, role: row.scope === 'child' ? 'child' : 'caregiver', personId: row.person_id,
    actor: `${principal.actor}:approval:${row.id}`, verifiedCapabilities: capabilities,
    verifiedFrameGrant: { id: row.id, scope: row.scope, capabilities } };
}
