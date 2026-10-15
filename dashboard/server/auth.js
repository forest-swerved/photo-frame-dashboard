import { createRemoteJWKSet, jwtVerify } from 'jose';
import { extractNeonAuthCookies, NEON_AUTH_COOKIE_PREFIX, NEON_AUTH_HEADER_MIDDLEWARE_NAME, parseSetCookies, serializeSetCookie } from '@neondatabase/auth/server';
import { ApiError, readJson, requireValue } from './errors.js';
import { digest } from './credentials.js';
import { one } from './database.js';

const keySets = new Map();
export const FRAME_COOKIE = 'family_frame_session';
export const FRAME_COOKIE_AGE = 365 * 24 * 60 * 60;
const gatewayRoutes = new Map([
  ['sign-in/email', 'POST'], ['sign-up/email', 'POST'], ['sign-out', 'POST'],
  ['get-session', 'GET'], ['token', 'GET'],
]);

export function authUrl(env = process.env) {
  let url;
  try { url = new URL(env.NEON_AUTH_BASE_URL); } catch { throw new ApiError(503, 'configuration_missing', 'Sign-in is not configured.'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    503, 'configuration_missing', 'Sign-in is not configured.');
  return url.href.replace(/\/$/, '');
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

export function providerCookies(request) {
  const value = request.headers.get('cookie') || '';
  requireValue(value.length <= 16_384, 431, 'headers_too_large', 'Sign in again to refresh this session.');
  return extractNeonAuthCookies(value);
}

export async function verifyUserJwt(token, env = process.env) {
  const base = authUrl(env);
  if (!keySets.has(base)) keySets.set(base, createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`), { timeoutDuration: 5_000 }));
  try {
    const { payload } = await jwtVerify(token, keySets.get(base), {
      issuer: new URL(base).origin,
      audience: new URL(base).origin,
      algorithms: ['EdDSA'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5,
    });
    requireValue(typeof payload.sub === 'string' && payload.sub.length > 0, 401, 'unauthenticated', 'Please sign in.');
    return payload;
  } catch {
    throw new ApiError(401, 'unauthenticated', 'Your sign-in has expired. Please sign in again.');
  }
}

export async function verifyFreshSession(request, userId, env = process.env, fetchImpl = fetch) {
  const cookie = providerCookies(request);
  requireValue(Boolean(cookie), 401, 'session_required', 'Please sign in again before making changes.');
  let response;
  try {
    response = await fetchImpl(`${authUrl(env)}/get-session?disableCookieCache=true`, {
      headers: { cookie, origin: new URL(request.url).origin, [NEON_AUTH_HEADER_MIDDLEWARE_NAME]: 'true' }, redirect: 'manual',
      signal: AbortSignal.timeout(8_000), cache: 'no-store',
    });
  } catch { throw new ApiError(503, 'auth_unavailable', 'Sign-in verification is temporarily unavailable.'); }
  requireValue(response.ok, response.status === 401 ? 401 : 503, 'session_required', 'Please sign in again before making changes.');
  let result;
  try { result = await response.json(); } catch { throw new ApiError(503, 'auth_unavailable', 'Sign-in verification is temporarily unavailable.'); }
  requireValue(result?.user?.id === userId && result?.session && Date.parse(result.session.expiresAt) > Date.now()
    && (!result.session.userId || result.session.userId === userId),
  401, 'session_required', 'Please sign in again before making changes.');
  return result;
}

export async function authenticate(request, db, { env = process.env, verifyJwt = verifyUserJwt, fetchImpl = fetch } = {}) {
  const authorization = request.headers.get('authorization');
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
  requireValue(/^Bearer \S+$/.test(authorization), 401, 'unauthenticated', 'Please sign in.');
  const claims = await verifyJwt(authorization.slice(7), env);
  const row = await one(db, `SELECT m.role, h.id AS household_id, h.title, h.timezone
    FROM family_members m JOIN family_households h ON h.id=m.household_id
    WHERE m.user_id=$1 AND m.revoked_at IS NULL`, [claims.sub]);
  if (!['GET', 'HEAD'].includes(request.method)) await verifyFreshSession(request, claims.sub, env, fetchImpl);
  return { authType: 'user', actor: `user:${claims.sub}`, role: row?.role || null,
    user: { id: claims.sub, name: typeof claims.name === 'string' ? claims.name : '', email: typeof claims.email === 'string' ? claims.email : '' },
    household: row ? householdDto(row) : null };
}

function householdDto(row) { return { id: row.household_id, title: row.title, timezone: row.timezone }; }

export function requireHousehold(principal) {
  requireValue(principal.household, 403, 'membership_required', 'Join your household with an invitation.');
  return principal.household.id;
}

export function requireAdmin(principal) {
  requireHousehold(principal);
  requireValue(principal.authType === 'user' && principal.role === 'admin', 403, 'admin_required', 'Only the household administrator can change Setup.');
}

export function firstPartyCookie(setCookie) {
  // Use the pinned SDK's actual namespace and parser, including challenge cookies.
  const cookies = parseSetCookies(setCookie);
  requireValue(cookies.length === 1 && cookies[0].name.startsWith(`${NEON_AUTH_COOKIE_PREFIX}.`), 502, 'auth_unavailable', 'Unexpected sign-in response.');
  return serializeSetCookie({ ...cookies[0], domain: undefined, path: '/', httpOnly: true, secure: true, sameSite: 'lax', partitioned: undefined });
}

export async function authGateway(request, path, { env = process.env, fetchImpl = fetch } = {}) {
  requireValue(gatewayRoutes.get(path) === request.method, 404, 'not_found', 'That endpoint does not exist.');
  if (request.method === 'POST' || request.headers.has('origin')) assertSameOrigin(request);
  requireValue(request.headers.get('sec-fetch-site') !== 'cross-site', 403, 'origin_rejected', 'Open this dashboard directly before signing in.');
  const incoming = new URL(request.url);
  const target = new URL(`${authUrl(env)}/${path}`);
  for (const [key, value] of incoming.searchParams) {
    if (key === '__route' || key === 'path') {
      requireValue(value === `auth/${path}`, 422, 'invalid_auth_query', 'This sign-in route is invalid.');
      continue;
    }
    requireValue(path === 'get-session' && key === 'disableCookieCache' && ['true', 'false'].includes(value), 422, 'invalid_auth_query', 'This sign-in request is invalid.');
    target.searchParams.set(key, value);
  }
  const headers = { 'Content-Type': 'application/json', origin: incoming.origin, cookie: providerCookies(request), [NEON_AUTH_HEADER_MIDDLEWARE_NAME]: 'true' };
  let body;
  if (request.method === 'POST') {
    const data = await readJson(request);
    const allowed = path === 'sign-in/email' ? ['email', 'password', 'rememberMe'] : path === 'sign-up/email' ? ['email', 'password', 'name'] : [];
    requireValue(Object.keys(data).every(key => allowed.includes(key)), 422, 'invalid_auth_body', 'This sign-in request contains unsupported fields.');
    body = JSON.stringify(data);
  }
  let upstream;
  try { upstream = await fetchImpl(target, { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000), cache: 'no-store' }); }
  catch { throw new ApiError(503, 'auth_unavailable', 'Sign-in is temporarily unavailable.'); }
  requireValue(upstream.status < 300 || upstream.status >= 400, 502, 'auth_unavailable', 'Unexpected sign-in redirect.');
  const responseHeaders = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  for (const name of ['set-auth-jwt']) if (upstream.headers.has(name)) responseHeaders.set(name, upstream.headers.get(name));
  for (const value of upstream.headers.getSetCookie()) responseHeaders.append('Set-Cookie', firstPartyCookie(value));
  return new Response(await upstream.text(), { status: upstream.status, headers: responseHeaders });
}
