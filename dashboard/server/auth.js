import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError, requireValue, uuidField } from './errors.js';
import { digest } from './credentials.js';
import { one } from './database.js';
import { createAuthContext } from './supabase-auth.js';
import { authenticateMobile } from './mobile.js';

const keySets = new Map();
export const FRAME_COOKIE = 'family_frame_session';
export const FRAME_COOKIE_AGE = 365 * 24 * 60 * 60;

export function authUrl(env = process.env) {
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { /* Redacted below. */ }
  requireValue(url && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    503, 'configuration_missing', 'Sign-in is not configured.');
  return `${url.origin}/auth/v1`;
}

export function assertSameOrigin(request) {
  requireValue(request.headers.get('origin') === new URL(request.url).origin,
    403, 'origin_rejected', 'Open this dashboard directly before making changes.');
}

export function cookieValue(request, name) {
  const cookies = request.headers.get('cookie') || '';
  const prefix = `${name}=`;
  return cookies.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length) || null;
}

export async function verifyUserJwt(token, env = process.env) {
  const base = authUrl(env);
  if (!keySets.has(base)) keySets.set(base, createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`), { timeoutDuration: 5_000 }));
  try {
    const { payload } = await jwtVerify(token, keySets.get(base), {
      issuer: base, audience: 'authenticated', algorithms: ['ES256', 'RS256'],
      requiredClaims: ['sub', 'session_id', 'exp', 'iat'], clockTolerance: 5,
    });
    uuidField(payload.sub); uuidField(payload.session_id);
    requireValue(payload.role === 'authenticated' && payload.is_anonymous !== true, 401, 'unauthenticated', 'Please sign in.');
    return payload;
  } catch {
    throw new ApiError(401, 'unauthenticated', 'Your sign-in has expired. Please sign in again.');
  }
}

export async function verifySessionRow(db, claims) {
  // A signed JWT can outlive sign-out. Supabase's documented session_id must
  // still identify this user's current, read-only provider session row.
  const session = await one(db, `SELECT id FROM family_internal.auth_sessions WHERE id=$1::uuid AND user_id=$2::uuid
    AND (not_after IS NULL OR not_after>now())`, [claims.session_id, claims.sub]);
  requireValue(session, 401, 'session_required', 'Your sign-in has ended. Please sign in again.');
}

export function userDto(claims) {
  const metadata = claims.user_metadata;
  const name = metadata && typeof metadata.name === 'string' ? metadata.name : metadata && typeof metadata.full_name === 'string' ? metadata.full_name : '';
  return { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : '', name: name.slice(0, 120) };
}

export async function authenticate(request, db, options = {}) {
  const { env = process.env, verifyJwt = verifyUserJwt } = options;
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('FamilyMobile ')) return authenticateMobile(request, db);
  if (!authorization) {
    const token = cookieValue(request, FRAME_COOKIE);
    requireValue(token && /^[A-Za-z0-9_-]{43}$/.test(token), 401, 'unauthenticated', 'Sign in or pair this frame.');
    const row = await one(db, `SELECT d.id, d.label, h.id AS household_id, h.title, h.timezone
      FROM family_devices d JOIN family_households h ON h.id=d.household_id
      WHERE d.token_hash=$1 AND d.revoked_at IS NULL AND d.expires_at>now()`, [digest(token)]);
    requireValue(row, 401, 'device_revoked', 'This frame needs to be paired again.');
    await db.query(`UPDATE family_devices SET last_seen_at=now() WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at<now()-interval '5 minutes')`, [row.id]);
    return { authType: 'frame', actor: `frame:${row.id}`, role: 'frame', user: { id: row.id, name: row.label }, household: householdDto(row) };
  }
  requireValue(/^Bearer \S+$/.test(authorization) && authorization.length < 16_384, 401, 'unauthenticated', 'Please sign in.');
  const claims = await verifyJwt(authorization.slice(7), env);
  await verifySessionRow(db, claims);
  if (!['GET', 'HEAD'].includes(request.method)) {
    const context = options.authContext || createAuthContext(request, options);
    const cookieClaims = await context.sessionClaims(db, verifyJwt);
    requireValue(cookieClaims && cookieClaims.sub === claims.sub && cookieClaims.session_id === claims.session_id,
      401, 'session_required', 'Please sign in again before making changes.');
  }
  const row = await one(db, `SELECT m.role,m.person_id,p.name AS person_name,h.id AS household_id,h.title,h.timezone
    FROM family_members m JOIN family_households h ON h.id=m.household_id
    LEFT JOIN family_people p ON p.household_id=m.household_id AND p.id=m.person_id
    WHERE m.user_id=$1 AND m.revoked_at IS NULL AND (m.role<>'child' OR p.id IS NOT NULL)`, [claims.sub]);
  return { authType: 'user', actor: `user:${claims.sub}`, role: row?.role || null,
    user: { ...userDto(claims), ...(row?.role === 'child' ? { name: row.person_name } : {}) }, personId: row?.person_id || null,
    sessionId: claims.session_id, household: row ? householdDto(row) : null };
}

function householdDto(row) { return { id: row.household_id, title: row.title, timezone: row.timezone }; }

export function requireHousehold(principal) {
  requireValue(principal.household, 403, 'membership_required', 'Join your household with an invitation.');
  return principal.household.id;
}

export function requireAdmin(principal) {
  requireHousehold(principal);
  requireValue(['user', 'mobile'].includes(principal.authType) && principal.role === 'admin', 403, 'admin_required', 'Only the household administrator can change Setup.');
}
