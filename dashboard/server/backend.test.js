import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { combineChunks, createChunks, parseCookieHeader, stringFromBase64URL, stringToBase64URL } from '@supabase/ssr';
import { authenticate, verifySessionRow, verifyUserJwt } from './auth.js';
import { AUTH_COOKIE, authGateway, confirmationCredentials, createAuthContext } from './supabase-auth.js';
import { poolConfig } from './database.js';
import { handleRequest } from './app.js';
import { decryptCredentials, encryptCredentials } from './credentials.js';
import { changePerson, completionDecision } from './household.js';
import { calendarSnapshot, connectCalendar, selectCalendars } from './calendar-service.js';
import { CalendarSyncError } from './icloud-caldav.js';
import { dateField, readJson } from './errors.js';
import { trustedClientIp } from './pair-rate-limit.js';

const origin = 'https://family.example';
const keyEnv = { FAMILY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
const household = { id: randomUUID(), title: 'Test family', timezone: 'America/Denver' };
const member = { authType: 'user', actor: 'user:member', user: { id: 'member' }, household, role: 'member' };
const frame = { ...member, authType: 'frame', actor: 'frame:fixture', role: 'frame' };
const req = (path, method = 'GET', body, headers = {}) => new Request(`${origin}/api/${path}`, { method,
  headers: { ...(method !== 'GET' ? { origin, 'Content-Type': 'application/json' } : {}), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const neverDb = { query: async () => { throw new Error('Unexpected database access'); } };

test('Supabase JWTs require issuer, audience, asymmetric signature and UUID session identity', async t => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'ES256', use: 'sig' };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ keys: [jwk] }));
  const env = { SUPABASE_URL: `https://auth-${randomUUID()}.example` };
  const issuer = `${env.SUPABASE_URL}/auth/v1`;
  const subject = randomUUID();
  const sign = overrides => new SignJWT({ sub: subject, session_id: randomUUID(), role: 'authenticated', ...overrides }).setProtectedHeader({ alg: 'ES256', kid: 'fixture' })
    .setIssuedAt().setIssuer(overrides?.iss || issuer).setAudience(overrides?.aud || 'authenticated').setExpirationTime(overrides?.exp ?? '15m').sign(privateKey);
  assert.equal((await verifyUserJwt(await sign(), env)).sub, subject);
  for (const overrides of [{ iss: 'https://attacker.example' }, { aud: 'other' }, { exp: 1 }, { session_id: 'not-a-session' }, { sub: 'not-a-uuid' }, { role: 'service_role' }, { is_anonymous: true }]) {
    await assert.rejects(verifyUserJwt(await sign(overrides), env), error => error.status === 401);
  }
  const valid = await sign();
  await assert.rejects(verifyUserJwt(`${valid.slice(0, -5)}wrong`, env), error => error.status === 401);
  const hs = await new SignJWT({ sub: subject, session_id: randomUUID(), role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt().setIssuer(issuer).setAudience('authenticated').setExpirationTime('15m').sign(Buffer.alloc(32, 1));
  await assert.rejects(verifyUserJwt(hs, env), error => error.status === 401);
});

test('every phone read checks provider session revocation and mutations bind cookie session', async () => {
  const claims = { sub: randomUUID(), session_id: randomUUID(), email: 'fixture@example.test' };
  let active = true;
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: sql.includes('family_internal.auth_sessions') && active ? [{ id: claims.session_id }] : [] }; } };
  const options = { verifyJwt: async () => claims };
  const read = req('session', 'GET', undefined, { authorization: 'Bearer fixture' });
  assert.equal((await authenticate(read, db, options)).household, null);
  assert.deepEqual(calls.find(call => call.sql.includes('family_internal.auth_sessions')).values, [claims.session_id, claims.sub]);
  assert.match(calls[0].sql, /not_after>now\(\)/);
  active = false;
  await assert.rejects(authenticate(read, db, options), error => error.code === 'session_required');
  active = true;
  const mutation = req('people', 'POST', {}, { authorization: 'Bearer fixture' });
  await assert.rejects(authenticate(mutation, db, { ...options, authContext: { sessionClaims: async () => ({ ...claims, session_id: randomUUID() }) } }), error => error.status === 401);
  assert.equal((await authenticate(mutation, db, { ...options, authContext: { sessionClaims: async () => claims } })).user.id, claims.sub);
});

test('SSR cookie adapter keeps chunks private, host-only and copied to error responses', async () => {
  let sdk;
  const context = createAuthContext(req('session', 'GET', undefined, { cookie: `${AUTH_COOKIE}.0=old; unrelated=private` }), {
    env: { SUPABASE_URL: 'https://auth.example', SUPABASE_PUBLISHABLE_KEY: 'publishable-fixture' },
    createClient: (url, key, options) => { sdk = options; return { auth: {} }; },
  });
  assert.deepEqual(sdk.cookies.getAll(), [{ name: `${AUTH_COOKIE}.0`, value: 'old' }]);
  await sdk.cookies.setAll([
    { name: `${AUTH_COOKIE}.0`, value: 'new', options: { domain: 'bad.example', path: '/bad', httpOnly: false, secure: false } },
    { name: `${AUTH_COOKIE}.1`, value: 'chunk', options: {} },
  ], { Expires: '0', Pragma: 'no-cache' });
  const result = context.finish(Response.json({ error: 'fixture' }, { status: 409 }));
  assert.equal(result.status, 409);
  assert.equal(result.headers.getSetCookie().length, 2);
  for (const cookie of result.headers.getSetCookie()) {
    assert.ok(!cookie.includes('Domain=')); assert.match(cookie, /Path=\//); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
  }
  assert.match(result.headers.get('Cache-Control'), /private.*no-store/);
  context.clearCookies();
  assert.ok(context.finish(Response.json({})).headers.getSetCookie().every(value => /Max-Age=0/.test(value)));
});

test('BFF allows only proven routing keys and fixed auth operations', async () => {
  const options = { createAuthContext: () => ({ client: { auth: {} }, sessionClaims: async () => null, finish: response => response }) };
  const response = await authGateway(req('auth/get-session?__route=auth/get-session&path=auth/get-session'), 'get-session', neverDb, options);
  assert.equal(response.status, 200);
  assert.equal(await response.json(), null);
  for (const query of ['path=sign-up/email', 'redirect=https://attacker.example', '__route=wrong']) {
    assert.equal((await authGateway(req(`auth/get-session?${query}`), 'get-session', neverDb, options)).status, 422);
  }
  assert.equal((await authGateway(req('auth/unknown'), 'unknown', neverDb, options)).status, 404);
  assert.equal((await authGateway(req('auth/sign-in/email', 'POST', { email: 'test@example.com', password: 'fixture', callbackURL: 'https://attacker.example' }), 'sign-in/email', neverDb, options)).status, 422);
});

test('confirmation links are parsed locally for the exact project without redirects', () => {
  const env = { SUPABASE_URL: 'https://auth.example' };
  const hash = 'a'.repeat(64);
  assert.deepEqual(confirmationCredentials({ confirmationLink: `https://auth.example/auth/v1/verify?token=${hash}&type=signup&redirect_to=https://attacker.example` }, env), { token_hash: hash, type: 'email' });
  assert.deepEqual(confirmationCredentials({ email: 'test@example.com', token: '123456' }, env), { email: 'test@example.com', token: '123456', type: 'email' });
  for (const link of [`https://attacker.example/auth/v1/verify?token=${hash}&type=signup`, `https://auth.example/auth/v1/verify?token=${hash}&type=recovery`, `https://auth.example/auth/v1/verify?token=${hash}&token=${hash}&type=email`]) {
    assert.throws(() => confirmationCredentials({ confirmationLink: link }, env), error => error.status === 422);
  }
});

test('node-postgres effective SSL cannot be overridden by URL parameters', () => {
  for (const suffix of ['ssl=0', 'sslmode=require', 'sslnegotiation=direct', 'sslrootcert=bad', 'sslcert=bad&sslkey=bad']) {
    const client = new pg.Client(poolConfig({ DATABASE_URL: `postgresql://fixture:fixture@db.example.invalid/postgres?${suffix}`, SUPABASE_DB_CA_CERT: 'fixture-ca' }));
    assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: true, ca: 'fixture-ca' });
  }
});

test('pinned SSR SDK chunks, refreshes and clears real sessions without exposing refresh tokens', async () => {
  const env = { SUPABASE_URL: 'https://ssr-fixture.example', SUPABASE_PUBLISHABLE_KEY: 'publishable-fixture' };
  const claims = { sub: randomUUID(), session_id: randomUUID(), role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    email: 'fixture@example.test', user_metadata: { name: 'N'.repeat(7000) } };
  const { privateKey } = await generateKeyPair('ES256');
  const access = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'fixture' }).setIssuedAt().sign(privateKey);
  const refresh = 'private-refresh-fixture';
  let loggedOut = false;
  let refreshed = false;
  const fetches = [];
  const fetchImpl = async (url, options) => {
    fetches.push({ url: String(url), options });
    if (String(url).includes('/logout')) { loggedOut = true; return new Response(null, { status: 204 }); }
    if (String(url).includes('grant_type=refresh_token')) refreshed = true;
    return Response.json({ access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 3600,
      expires_at: claims.exp, user: { id: claims.sub, email: claims.email, user_metadata: claims.user_metadata } });
  };
  const db = { query: async () => ({ rows: [{ id: claims.session_id }] }) };
  const options = { env, fetchImpl, verifyJwt: async token => { assert.equal(token, access); return claims; } };
  const signedIn = await authGateway(req('auth/sign-in/email', 'POST', { email: claims.email, password: 'password-fixture' }), 'sign-in/email', db, options);
  assert.equal(signedIn.status, 200);
  const result = await signedIn.clone().json();
  assert.equal(result.user.id, claims.sub);
  assert.ok(!JSON.stringify(result).includes(refresh));
  assert.ok(!JSON.stringify(result).includes(access));
  const cookieWrites = signedIn.headers.getSetCookie();
  assert.ok(cookieWrites.length >= 2, 'Large sessions must preserve all SDK chunks.');
  let cookie = cookieWrites.map(value => value.split(';')[0]).join('; ');
  const jar = new Map(parseCookieHeader(cookie).map(item => [item.name, item.value]));
  const encoded = await combineChunks(AUTH_COOKIE, async name => jar.get(name));
  const expiredSession = JSON.parse(stringFromBase64URL(encoded.slice('base64-'.length)));
  expiredSession.expires_at = Math.floor(Date.now() / 1000) - 60;
  cookie = createChunks(AUTH_COOKIE, `base64-${stringToBase64URL(JSON.stringify(expiredSession))}`).map(item => `${item.name}=${item.value}`).join('; ');
  const session = await authGateway(req('auth/get-session', 'GET', undefined, { cookie }), 'get-session', db, options);
  assert.equal((await session.json()).user.id, claims.sub);
  assert.equal(refreshed, true);
  assert.ok(session.headers.getSetCookie().length > 0, 'Updated refresh chunks must reach the response.');
  const refreshedJar = new Map(parseCookieHeader(cookie).map(item => [item.name, item.value]));
  for (const value of session.headers.getSetCookie()) {
    const item = parseCookieHeader(value.split(';')[0])[0];
    if (/Max-Age=0/.test(value)) refreshedJar.delete(item.name); else refreshedJar.set(item.name, item.value);
  }
  cookie = [...refreshedJar].map(([name, value]) => `${name}=${value}`).join('; ');
  const token = await authGateway(req('auth/token', 'GET', undefined, { cookie }), 'token', db, options);
  assert.deepEqual(await token.json(), { token: access });
  const signOut = await authGateway(req('auth/sign-out', 'POST', {}, { cookie }), 'sign-out', db, options);
  assert.equal(signOut.status, 200);
  assert.equal(loggedOut, true);
  assert.ok(signOut.headers.getSetCookie().length >= 2);
  assert.ok(signOut.headers.getSetCookie().every(value => /Max-Age=0/.test(value)));
  assert.ok(fetches.every(call => call.options.redirect === 'manual'));
});

test('BFF confirmation, revoked-session cookies and provider errors remain sanitized', async () => {
  let received;
  const context = {
    client: { auth: { signUp: async body => { received = body; return { data: { session: null }, error: null }; },
      signInWithPassword: async () => ({ error: { code: 'email_not_confirmed', status: 400, message: 'private details' } }),
      verifyOtp: async body => { received = body; return { error: { code: 'otp_expired', status: 403, message: 'private token' } }; } } },
    sessionClaims: async () => { throw Object.assign(new Error('Private user'), { code: 'session_required' }); },
    clearCookies() {}, finish: response => response,
  };
  const options = { createAuthContext: () => context, env: { SUPABASE_URL: 'https://auth.example' } };
  const signup = await authGateway(req('auth/sign-up/email', 'POST', { email: 'test@example.com', password: 'password-fixture', name: 'Owner' }), 'sign-up/email', neverDb, options);
  assert.deepEqual(await signup.json(), { session: null, user: null, confirmationRequired: true });
  assert.deepEqual(received.options.data, { name: 'Owner' });
  const unconfirmed = await authGateway(req('auth/sign-in/email', 'POST', { email: 'test@example.com', password: 'password-fixture' }), 'sign-in/email', neverDb, options);
  assert.equal(unconfirmed.status, 403);
  const unconfirmedBody = await unconfirmed.json();
  assert.equal(unconfirmedBody.error.code, 'email_not_confirmed');
  assert.ok(!JSON.stringify(unconfirmedBody).includes('private details'));
  const verify = await authGateway(req('auth/verify-email', 'POST', { email: 'test@example.com', token: '123456' }), 'verify-email', neverDb, options);
  assert.equal(verify.status, 422);
  assert.equal((await verify.json()).error.code, 'verification_expired');
  assert.deepEqual(received, { email: 'test@example.com', token: '123456', type: 'email' });
});

test('API validation errors preserve cookie refresh writes from the same request', async () => {
  const claims = { sub: randomUUID(), session_id: randomUUID() };
  const db = { query: async sql => ({ rows: sql.includes('family_internal.auth_sessions') ? [{ id: claims.session_id }]
    : [{ role: 'admin', household_id: household.id, title: household.title, timezone: household.timezone }] }) };
  const response = await handleRequest(req('people', 'POST', {}, { authorization: 'Bearer fixture' }), {
    db, verifyJwt: async () => claims,
    createAuthContext: () => ({ sessionClaims: async () => claims, finish: response => {
      const headers = new Headers(response.headers);
      headers.append('Set-Cookie', `${AUTH_COOKIE}.0=refreshed; Path=/; HttpOnly; Secure; SameSite=Lax`);
      return new Response(response.body, { status: response.status, headers });
    } }),
  });
  assert.equal(response.status, 422);
  assert.equal(response.headers.getSetCookie().length, 1);
});

test('frames and members cannot change setup, identities, chore definitions or credentials', async () => {
  const routes = [['people', 'POST'], [`people/${randomUUID()}`, 'PATCH'], ['chores', 'POST'], ['invites', 'POST'], ['frame-pairs', 'POST'], ['calendar/connection', 'GET'], ['calendar/selection', 'PUT'], ['settings', 'PATCH'], ['devices', 'GET'], ['members', 'GET']];
  for (const principal of [frame, member]) for (const [path, method] of routes) {
    const response = await handleRequest(req(path, method, method === 'GET' ? undefined : {}), { db: neverDb, authenticate: async () => principal });
    assert.equal(response.status, 403, `${principal.role}: ${method} ${path}`);
  }
});

test('sign-up alone grants neither household data nor owner membership', async () => {
  const principal = { ...member, role: null, household: null };
  const response = await handleRequest(req('session'), { db: { query: async () => ({ rows: [{ id: household.id }] }) }, authenticate: async () => principal });
  const { data } = await response.json();
  assert.equal(data.household, null);
  assert.equal(data.role, null);
  assert.equal(data.claimRequired, false);
  const blocked = await handleRequest(req('household'), { db: neverDb, authenticate: async () => principal });
  assert.equal(blocked.status, 403);
});

test('paired frame authentication consults current revocation and expiry row on each request', async () => {
  let active = true;
  const db = { query: async sql => ({ rows: sql.startsWith('SELECT') && active ? [{ id: 'fixture-frame', label: 'Frame', household_id: household.id, ...household }] : [] }) };
  const request = req('session', 'GET', undefined, { cookie: `family_frame_session=${'a'.repeat(43)}` });
  assert.equal((await authenticate(request, db)).role, 'frame');
  active = false;
  await assert.rejects(authenticate(request, db), error => error.status === 401);
});

test('IDOR lookup includes household and never updates an absent foreign person', async () => {
  const calls = [];
  const client = { release() {}, query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  const db = { connect: async () => client };
  await assert.rejects(changePerson(db, { ...member, role: 'admin' }, randomUUID(), { expectedVersion: 1, name: 'Changed' }), error => error.status === 404);
  const lookup = calls.find(call => call.sql.startsWith('SELECT * FROM family_people'));
  assert.equal(lookup.values[1], household.id);
  assert.ok(!calls.some(call => call.sql.startsWith('UPDATE')));
});

test('completion desired state is not a toggle and stale versions cannot overwrite', () => {
  const initial = { completed: false, version: 0 };
  const completed = completionDecision(initial, true, 0);
  assert.deepEqual(completed, { completed: true, version: 1 });
  assert.equal(completionDecision(completed, true, 1), completed);
  assert.throws(() => completionDecision(completed, false, 0), error => error.status === 409 && error.details.current === completed);
});

test('encrypted Apple credentials are randomized, tamper-evident and bound to household', () => {
  const credentials = { username: 'private@example.com', appPassword: 'private-fixture' };
  const encrypted = encryptCredentials(household.id, credentials, keyEnv);
  assert.deepEqual(decryptCredentials(household.id, encrypted, keyEnv), credentials);
  assert.notEqual(encrypted.iv, encryptCredentials(household.id, credentials, keyEnv).iv);
  assert.ok(!JSON.stringify(encrypted).includes(credentials.username));
  assert.throws(() => decryptCredentials(randomUUID(), encrypted, keyEnv), error => error.code === 'calendar_credentials_unavailable');
  assert.throws(() => decryptCredentials(household.id, { ...encrypted, ciphertext: 'AAAA' }, keyEnv));
});

test('input and origin boundaries reject malformed, huge and cross-site requests', async () => {
  assert.throws(() => dateField('2026-02-30'));
  await assert.rejects(readJson(new Request(origin, { method: 'POST', body: JSON.stringify({ title: 'x'.repeat(17_000) }), headers: { 'Content-Type': 'application/json' } })), error => error.status === 413);
  const response = await handleRequest(req('claim', 'POST', {}, { origin: 'https://attacker.example' }), { db: neverDb });
  assert.equal(response.status, 403);
  assert.equal(trustedClientIp(req('session', 'GET', undefined, { 'x-forwarded-for': '1.2.3.4' }), { VERCEL: '1' }), 'unknown');
  assert.equal(trustedClientIp(req('session', 'GET', undefined, { 'x-vercel-forwarded-for': '192.0.2.1' }), { VERCEL: '1' }), '192.0.2.1');
});

test('failed or incomplete calendar sync retains only last known good snapshot as stale', async () => {
  const connection = { credentials: encryptCredentials(household.id, { username: 'fixture', appPassword: 'fixture' }, keyEnv), selected_ids: ['calendar'], version: 1 };
  const snapshot = { events: [{ id: 'old-good' }], coverage: { complete: true }, lastSuccessfulSyncAt: '2026-01-01T00:00:00Z' };
  const db = { query: async sql => ({ rows: sql.includes('family_calendar_connections') ? [connection] : [{ snapshot, successful_at: new Date(0) }] }) };
  const result = await calendarSnapshot(db, member, '2026-10-01', '2026-11-01', { env: keyEnv, sync: async () => { throw new Error('private upstream body'); } });
  assert.equal(result.status, 'stale');
  assert.deepEqual(result.events, snapshot.events);
  assert.equal(result.lastSuccessfulSyncAt, snapshot.lastSuccessfulSyncAt);
  assert.ok(!JSON.stringify(result).includes('private upstream'));
});

test('calendar setup enforces the adapter selection cap and redacts discovery failures', async () => {
  const admin = { ...member, role: 'admin' };
  await assert.rejects(selectCalendars(neverDb, admin, { calendarIds: Array.from({ length: 11 }, (_, index) => String(index)) }), error => error.status === 422);
  await assert.rejects(connectCalendar(neverDb, admin, { username: 'private@example.com', appPassword: 'private' }, keyEnv,
    async () => { throw new CalendarSyncError('CALENDAR_AUTH_FAILED', 'private provider message'); }),
  error => error.status === 502 && error.code === 'calendar_connection_failed' && !error.message.includes('private'));
});

test('delete requires an explicit valid entity version before looking up the item', async () => {
  const response = await handleRequest(req(`people/${randomUUID()}`, 'DELETE'), { db: neverDb, authenticate: async () => ({ ...member, role: 'admin' }) });
  assert.equal(response.status, 422);
});
