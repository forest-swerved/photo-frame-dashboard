import { randomInt, randomUUID } from 'node:crypto';
import { ApiError, dateField, householdDate, requireValue, textField, uuidField, versionField, weekdaysField } from './errors.js';
import { digest, keyedDigest, matchesDigest, randomToken } from './credentials.js';
import { one, transaction } from './database.js';
import { FRAME_COOKIE, FRAME_COOKIE_AGE, requireAdmin, requireHousehold } from './auth.js';

const notFound = () => new ApiError(404, 'not_found', 'That item does not exist in this household.');
export const personDto = row => ({ id: row.id, name: row.name, color: row.color, version: row.version });
export const completionDto = (row, choreId, date) => ({ choreId, date, completed: row?.completed || false, version: row?.version || 0,
  updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null });
const householdDto = row => ({ id: row.id, title: row.title, timezone: row.timezone });

export async function sessionData(db, principal) {
  const claimed = await one(db, 'SELECT id FROM family_households LIMIT 1');
  return { authenticated: true, authType: principal.authType, user: principal.user, role: principal.role,
    household: principal.household, personId: principal.personId || null, claimRequired: !claimed && principal.authType === 'user' };
}

export async function claimHousehold(db, principal, body, env = process.env) {
  requireValue(principal.authType === 'user', 403, 'user_required', 'Sign in to claim the household.');
  if (env.FAMILY_BOOTSTRAP_USER_ID) {
    let ownerId;
    try { ownerId = uuidField(env.FAMILY_BOOTSTRAP_USER_ID).toLowerCase(); }
    catch { throw new ApiError(503, 'configuration_missing', 'Household setup is not configured.'); }
    requireValue(principal.user.id === ownerId, 403, 'invalid_claim', 'That claim code is invalid.');
  }
  requireValue(matchesDigest(textField(body.bootstrapCode, 'Claim code', 200), env.FAMILY_BOOTSTRAP_HASH),
    403, 'invalid_claim', 'That claim code is invalid.');
  return transaction(db, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('family-household-claim', 0))");
    requireValue(!await one(client, 'SELECT id FROM family_households LIMIT 1'), 409, 'already_claimed', 'This household has already been claimed.');
    const id = randomUUID();
    const household = await one(client, 'INSERT INTO family_households(id,title) VALUES($1,$2) RETURNING *', [id, body.title ? textField(body.title, 'Household title', 80) : 'Our family']);
    await client.query('INSERT INTO family_members(household_id,user_id,name,email,role) VALUES($1,$2,$3,$4,$5)',
      [id, principal.user.id, principal.user.name || 'Administrator', principal.user.email, 'admin']);
    return { authenticated: true, authType: 'user', user: principal.user, role: 'admin', household: householdDto(household), claimRequired: false };
  });
}

export async function createInvite(db, principal, body) {
  requireAdmin(principal);
  requireValue(Object.keys(body).every(key => ['role','personId','email','expiresInHours'].includes(key)), 422, 'invalid_invite', 'This invitation contains unsupported fields.');
  const role = body.role ?? 'member';
  requireValue(['member','child'].includes(role), 422, 'invalid_invite', 'Invite a family member or a child profile.');
  const hours = body.expiresInHours ?? 24;
  requireValue(Number.isInteger(hours) && hours >= 1 && hours <= 168, 422, 'invalid_expiry', 'Invitations may last 1–168 hours.');
  let personId = null, email = null;
  if (role === 'child') {
    personId = uuidField(body.personId, 'Child profile');
    email = textField(body.email, 'Child email', 254).toLowerCase();
    requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 422, 'invalid_email', 'Enter the child’s own email address.');
  } else requireValue(body.personId === undefined && body.email === undefined, 422, 'invalid_invite', 'Choose the child invitation type to bind an email to a profile.');
  const token = randomToken();
  return transaction(db, async client => {
    if (role === 'child') {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`membership-email:${principal.household.id}:${email}`]);
      requireValue(await one(client, 'SELECT id FROM family_people WHERE household_id=$1 AND id=$2 FOR UPDATE', [principal.household.id, personId]), 404, 'not_found', 'That child profile does not exist.');
      const account = await one(client, 'SELECT role,person_id FROM family_members WHERE household_id=$1 AND lower(trim(email))=$2 LIMIT 1', [principal.household.id, email]);
      requireValue(!account || account.role === 'child' && account.person_id === personId, 409, 'child_profile_locked', 'This email is already linked to another family role or profile.');
      const assigned = await one(client, "SELECT email FROM family_members WHERE household_id=$1 AND person_id=$2 AND role='child' AND revoked_at IS NULL", [principal.household.id, personId]);
      requireValue(!assigned || assigned.email.trim().toLowerCase() === email, 409, 'profile_already_claimed', 'This profile is already linked to another account. Remove that account’s access first.');
      await client.query("UPDATE family_invites SET revoked_at=now() WHERE household_id=$1 AND (person_id=$2 OR email=$3) AND role='child' AND redeemed_at IS NULL AND revoked_at IS NULL", [principal.household.id, personId, email]);
    }
    const row = await one(client, `INSERT INTO family_invites(id,household_id,token_hash,expires_at,created_by,role,person_id,email)
      VALUES($1,$2,$3,now()+($4::int * interval '1 hour'),$5,$6,$7,$8) RETURNING id,expires_at`,
    [randomUUID(), principal.household.id, digest(token), hours, principal.user.id, role, personId, email]);
    return { id: row.id, token, expiresAt: row.expires_at, role, personId, email };
  });
}

export async function joinHousehold(db, principal, body, { getVerifiedEmail } = {}) {
  requireValue(principal.authType === 'user', 403, 'user_required', 'Sign in to use an invitation.');
  const token = textField(body.token, 'Invitation', 200);
  const candidate = await one(db, 'SELECT id,household_id,role,person_id FROM family_invites WHERE token_hash=$1', [digest(token)]);
  requireValue(candidate, 403, 'invalid_invite', 'That invitation has expired or was already used.');
  // Production supplies a provider lookup for every join, including member
  // invitations: a stale JWT email must not bypass a child's email reservation.
  const verifiedEmail = getVerifiedEmail ? await getVerifiedEmail() : null;
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`membership:${principal.user.id}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`membership-email:${candidate.household_id}:${verifiedEmail || (principal.user.email || '').trim().toLowerCase()}`]);
    let profile;
    if (candidate.role === 'child') {
      profile = await one(client, 'SELECT id,name FROM family_people WHERE household_id=$1 AND id=$2 FOR UPDATE', [candidate.household_id, candidate.person_id]);
      requireValue(profile, 403, 'invalid_invite', 'That invitation has expired or was already used.');
    }
    const invite = await one(client, 'SELECT * FROM family_invites WHERE token_hash=$1 FOR UPDATE', [digest(token)]);
    requireValue(invite && !invite.redeemed_at && !invite.revoked_at && new Date(invite.expires_at) > new Date()
      && invite.role === candidate.role && invite.person_id === candidate.person_id, 403, 'invalid_invite', 'That invitation has expired or was already used.');
    requireValue(!principal.household || principal.household.id === invite.household_id, 409, 'already_member', 'You already belong to a household.');
    const existing = await one(client, 'SELECT * FROM family_members WHERE user_id=$1 ORDER BY joined_at LIMIT 1 FOR UPDATE', [principal.user.id]);
    requireValue(!existing || existing.household_id === invite.household_id, 409, 'already_member', 'You already belong to a household.');
    let role = existing && !existing.revoked_at ? existing.role : 'member';
    let name = principal.user.name || 'Family member', email = verifiedEmail || principal.user.email, personId = null;
    if (invite.role === 'child') {
      requireValue(verifiedEmail && verifiedEmail === invite.email, 403, 'invited_email_required', 'Sign in with the confirmed email address this invitation was created for.');
      requireValue(!existing || existing.role === 'child' && existing.person_id === invite.person_id,
        409, 'child_profile_locked', 'This account is already linked. A parent must manage its access.');
      const assigned = await one(client, "SELECT user_id FROM family_members WHERE household_id=$1 AND person_id=$2 AND role='child' AND revoked_at IS NULL AND user_id<>$3", [invite.household_id, invite.person_id, principal.user.id]);
      requireValue(!assigned, 409, 'profile_already_claimed', 'This profile is already linked to another account.');
      role = 'child'; personId = invite.person_id; name = profile.name; email = verifiedEmail;
    } else {
      const reserved = !existing || existing.revoked_at ? await one(client, "SELECT id FROM family_invites WHERE household_id=$1 AND role='child' AND email=$2 LIMIT 1", [invite.household_id, (verifiedEmail || principal.user.email || '').trim().toLowerCase()]) : null;
      requireValue(existing?.role !== 'child' && !reserved, 409, 'child_profile_locked', 'A child account cannot accept a parent or family-member invitation.');
    }
    await client.query(`INSERT INTO family_members(household_id,user_id,name,email,role,person_id) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(household_id,user_id) DO UPDATE SET revoked_at=NULL,name=EXCLUDED.name,email=EXCLUDED.email,role=EXCLUDED.role,person_id=EXCLUDED.person_id`,
    [invite.household_id, principal.user.id, name, email, role, personId]);
    await client.query('UPDATE family_invites SET redeemed_at=now(),redeemed_by=$2 WHERE id=$1', [invite.id, principal.user.id]);
    const row = await one(client, `SELECT m.role,h.id,h.title,h.timezone FROM family_members m JOIN family_households h ON h.id=m.household_id WHERE m.household_id=$1 AND m.user_id=$2`, [invite.household_id, principal.user.id]);
    return { authenticated: true, authType: 'user', user: { ...principal.user, name, email }, role: row.role, personId, household: householdDto(row), claimRequired: false };
  });
}

export async function revokeHouseholdMember(db, principal, userId) {
  requireAdmin(principal); uuidField(userId, 'Account ID');
  requireValue(userId !== principal.user.id, 422, 'cannot_remove_owner', 'The administrator cannot remove their own access.');
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`membership:${userId}`]);
    const candidate = await one(client, 'SELECT person_id FROM family_members WHERE household_id=$1 AND user_id=$2', [principal.household.id, userId]);
    if (candidate?.person_id) await client.query('SELECT id FROM family_people WHERE household_id=$1 AND id=$2 FOR UPDATE', [principal.household.id, candidate.person_id]);
    const member = await one(client, "SELECT * FROM family_members WHERE household_id=$1 AND user_id=$2 AND role IN ('member','child') AND revoked_at IS NULL FOR UPDATE", [principal.household.id, userId]);
    requireValue(member, 404, 'not_found', 'That family account does not exist.');
    await client.query('UPDATE family_members SET revoked_at=now() WHERE household_id=$1 AND user_id=$2', [principal.household.id, userId]);
    await client.query('UPDATE family_mobile_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE household_id=$1 AND user_id=$2', [principal.household.id, userId]);
    if (member.person_id) await client.query("UPDATE family_invites SET revoked_at=coalesce(revoked_at,now()) WHERE household_id=$1 AND person_id=$2 AND role='child' AND redeemed_at IS NULL", [principal.household.id, member.person_id]);
    return { deleted: true };
  });
}

export async function createFramePair(db, principal, body, env = process.env) {
  requireAdmin(principal);
  return transaction(db, async client => {
    await client.query('SELECT id FROM family_households WHERE id=$1 FOR UPDATE', [principal.household.id]);
    await client.query('UPDATE family_frame_pairs SET redeemed_at=now() WHERE household_id=$1 AND redeemed_at IS NULL', [principal.household.id]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = String(randomInt(1_000_000)).padStart(6, '0');
      const row = await one(client, `INSERT INTO family_frame_pairs(id,household_id,code_hash,label,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '10 minutes') ON CONFLICT(code_hash) DO NOTHING RETURNING expires_at`,
      [randomUUID(), principal.household.id, keyedDigest('frame-pair', code, env), body.label ? textField(body.label, 'Frame name', 80) : 'Family frame']);
      if (row) return { code, expiresAt: row.expires_at };
    }
    throw new ApiError(503, 'pair_unavailable', 'A pairing code could not be created. Try again.');
  });
}

export async function redeemFramePair(db, body, env = process.env) {
  const code = body.code;
  requireValue(typeof code === 'string' && /^\d{6}$/.test(code), 403, 'invalid_pair', 'That pairing code has expired or was already used.');
  return transaction(db, async client => {
    const candidate = await one(client, 'SELECT id,household_id FROM family_frame_pairs WHERE code_hash=$1', [keyedDigest('frame-pair', code, env)]);
    requireValue(candidate, 403, 'invalid_pair', 'That pairing code has expired or was already used.');
    await client.query('SELECT id FROM family_households WHERE id=$1 FOR UPDATE', [candidate.household_id]);
    const pair = await one(client, 'SELECT * FROM family_frame_pairs WHERE id=$1 FOR UPDATE', [candidate.id]);
    requireValue(pair && !pair.redeemed_at && new Date(pair.expires_at) > new Date(), 403, 'invalid_pair', 'That pairing code has expired or was already used.');
    const token = randomToken();
    const device = await one(client, `INSERT INTO family_devices(id,household_id,label,token_hash) VALUES($1,$2,$3,$4) RETURNING id,label,expires_at`, [randomUUID(), pair.household_id, pair.label, digest(token)]);
    await client.query('UPDATE family_frame_pairs SET redeemed_at=now() WHERE id=$1', [pair.id]);
    const household = await one(client, 'SELECT * FROM family_households WHERE id=$1', [pair.household_id]);
    return { data: { device: { id: device.id, label: device.label, expiresAt: device.expires_at }, household: householdDto(household) },
      cookie: `${FRAME_COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${FRAME_COOKIE_AGE}` };
  });
}

export async function householdSnapshot(db, principal, requestedDate) {
  const householdId = requireHousehold(principal);
  const date = dateField(requestedDate || householdDate(principal.household.timezone));
  const people = (await db.query('SELECT * FROM family_people WHERE household_id=$1 AND ($2::uuid IS NULL OR id=$2::uuid) ORDER BY created_at,id', [householdId, principal.role === 'child' ? principal.personId : null])).rows.map(personDto);
  const chores = (await db.query(`SELECT c.*,x.completed,x.version AS completion_version,x.updated_at AS completion_updated_at
    FROM family_chores c LEFT JOIN family_completions x ON x.household_id=c.household_id AND x.chore_id=c.id AND x.date=$2::date
    WHERE c.household_id=$1 AND c.deleted_at IS NULL AND ($3::uuid IS NULL OR c.person_id=$3::uuid) ORDER BY c.created_at,c.id`, [householdId, date, principal.role === 'child' ? principal.personId : null])).rows.map(row => ({
    id: row.id, title: row.title, personId: row.person_id, weekdays: row.weekdays, version: row.version,
    dueTime: row.due_time?.slice(0, 5) || null, reminderMinutes: row.reminder_minutes ?? 15,
    completion: { date, completed: row.completed || false, version: row.completion_version || 0, updatedAt: row.completion_updated_at || null },
  }));
  return { household: principal.household, role: principal.role, date, people, chores };
}

function colorField(value = '#6b7c59') {
  requireValue(typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value), 422, 'invalid_color', 'Use a six-digit hex color.');
  return value.toLowerCase();
}

export async function createPerson(db, principal, body) {
  requireAdmin(principal);
  return personDto(await one(db, 'INSERT INTO family_people(id,household_id,name,color) VALUES($1,$2,$3,$4) RETURNING *',
    [randomUUID(), principal.household.id, textField(body.name, 'Name', 60), colorField(body.color)]));
}

export async function changePerson(db, principal, id, body, remove = false) {
  requireAdmin(principal); uuidField(id); versionField(body.expectedVersion);
  return transaction(db, async client => {
    const row = await one(client, 'SELECT * FROM family_people WHERE id=$1 AND household_id=$2 FOR UPDATE', [id, principal.household.id]);
    if (!row) throw notFound();
    requireValue(row.version === body.expectedVersion, 409, 'version_conflict', 'This person changed. Refresh and try again.', { current: personDto(row) });
    if (remove) {
      await client.query("UPDATE family_mobile_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE household_id=$1 AND person_id=$2", [principal.household.id, id]);
      await client.query("UPDATE family_members SET revoked_at=coalesce(revoked_at,now()),person_id=NULL WHERE household_id=$1 AND person_id=$2 AND role='child'", [principal.household.id, id]);
      await client.query('UPDATE family_chores SET person_id=NULL,version=version+1 WHERE person_id=$1 AND household_id=$2', [id, principal.household.id]);
      await client.query('DELETE FROM family_people WHERE id=$1 AND household_id=$2', [id, principal.household.id]);
      return { deleted: true };
    }
    return personDto(await one(client, 'UPDATE family_people SET name=$3,color=$4,version=version+1 WHERE id=$1 AND household_id=$2 RETURNING *',
      [id, principal.household.id, body.name === undefined ? row.name : textField(body.name, 'Name', 60), body.color === undefined ? row.color : colorField(body.color)]));
  });
}

const choreDto = row => ({ id: row.id, title: row.title, personId: row.person_id, weekdays: row.weekdays, version: row.version, dueTime: row.due_time?.slice(0, 5) || null, reminderMinutes: row.reminder_minutes ?? 15 });
export function dueTimeField(value) {
  requireValue(value === null || typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value), 422, 'invalid_due_time', 'Choose a valid due time.');
  return value;
}
export function reminderMinutesField(value) {
  requireValue(Number.isInteger(value) && value >= 0 && value <= 1440, 422, 'invalid_reminder', 'Reminders must be 0–1440 minutes before the due time.');
  return value;
}

async function checkedPerson(client, householdId, personId) {
  if (personId === null || personId === undefined || personId === '') return null;
  uuidField(personId, 'Person ID');
  requireValue(await one(client, 'SELECT id FROM family_people WHERE id=$1 AND household_id=$2 FOR KEY SHARE', [personId, householdId]), 404, 'not_found', 'That person does not exist in this household.');
  return personId;
}

export async function createChore(db, principal, body) {
  requireAdmin(principal);
  return transaction(db, async client => choreDto(await one(client, 'INSERT INTO family_chores(id,household_id,title,person_id,weekdays,due_time,reminder_minutes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [randomUUID(), principal.household.id, textField(body.title, 'Chore', 100), await checkedPerson(client, principal.household.id, body.personId), weekdaysField(body.weekdays), dueTimeField(body.dueTime ?? null), reminderMinutesField(body.reminderMinutes ?? 15)])));
}

export async function changeChore(db, principal, id, body, remove = false) {
  requireAdmin(principal); uuidField(id); versionField(body.expectedVersion);
  return transaction(db, async client => {
    // Take the person reference lock before the chore, matching person deletion.
    const checkedPersonId = body.personId === undefined ? undefined : await checkedPerson(client, principal.household.id, body.personId);
    const row = await one(client, 'SELECT * FROM family_chores WHERE id=$1 AND household_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, principal.household.id]);
    if (!row) throw notFound();
    requireValue(row.version === body.expectedVersion, 409, 'version_conflict', 'This chore changed. Refresh and try again.', { current: choreDto(row) });
    if (remove) {
      await client.query('UPDATE family_chores SET deleted_at=now(),version=version+1 WHERE id=$1 AND household_id=$2', [id, principal.household.id]);
      return { deleted: true };
    }
    const personId = body.personId === undefined ? row.person_id : checkedPersonId;
    return choreDto(await one(client, 'UPDATE family_chores SET title=$3,person_id=$4,weekdays=$5,due_time=$6,reminder_minutes=$7,version=version+1 WHERE id=$1 AND household_id=$2 RETURNING *',
      [id, principal.household.id, body.title === undefined ? row.title : textField(body.title, 'Chore', 100), personId, body.weekdays === undefined ? row.weekdays : weekdaysField(body.weekdays), body.dueTime === undefined ? row.due_time : dueTimeField(body.dueTime), body.reminderMinutes === undefined ? row.reminder_minutes : reminderMinutesField(body.reminderMinutes)]));
  });
}

export function completionDecision(current, desired, expectedVersion) {
  requireValue(current.version === expectedVersion, 409, 'version_conflict', 'This chore was changed on another screen.', { current });
  return current.completed === desired ? current : { ...current, completed: desired, version: current.version + 1 };
}

export async function setCompletion(db, principal, choreId, date, body) {
  const householdId = requireHousehold(principal);
  uuidField(choreId); dateField(date); uuidField(body.mutationId, 'Mutation ID'); versionField(body.expectedVersion);
  requireValue(typeof body.completed === 'boolean', 422, 'invalid_completion', 'Send the desired completed state.');
  const requestHash = digest(JSON.stringify({ choreId, date, completed: body.completed, expectedVersion: body.expectedVersion }));
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mutation:${householdId}:${principal.actor}:${body.mutationId}`]);
    const replay = await one(client, 'SELECT request_hash,response FROM family_mutations WHERE household_id=$1 AND actor=$2 AND mutation_id=$3', [householdId, principal.actor, body.mutationId]);
    if (replay) {
      requireValue(replay.request_hash === requestHash, 409, 'mutation_reused', 'Use a new mutation ID for a different change.');
      return replay.response;
    }
    requireValue(await one(client, 'SELECT id FROM family_chores WHERE id=$1 AND household_id=$2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR person_id=$3::uuid) FOR SHARE', [choreId, householdId, principal.role === 'child' ? principal.personId : null]), 404, 'not_found', 'That chore does not exist in this household.');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`completion:${householdId}:${choreId}:${date}`]);
    const row = await one(client, 'SELECT * FROM family_completions WHERE household_id=$1 AND chore_id=$2 AND date=$3::date FOR UPDATE', [householdId, choreId, date]);
    const current = completionDto(row, choreId, date);
    const desired = completionDecision(current, body.completed, body.expectedVersion);
    let result = current;
    if (desired !== current) result = completionDto(await one(client, `INSERT INTO family_completions(household_id,chore_id,date,completed,version,actor)
      VALUES($1,$2,$3::date,$4,$5,$6) ON CONFLICT(household_id,chore_id,date) DO UPDATE SET completed=EXCLUDED.completed,version=EXCLUDED.version,actor=EXCLUDED.actor,updated_at=now() RETURNING *`,
    [householdId, choreId, date, desired.completed, desired.version, principal.actor]), choreId, date);
    result = { ...result, mutationId: body.mutationId };
    await client.query('INSERT INTO family_mutations(household_id,actor,mutation_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)', [householdId, principal.actor, body.mutationId, requestHash, JSON.stringify(result)]);
    return result;
  });
}
