import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { NEON_AUTH_SESSION_COOKIE_NAME } from '@neondatabase/auth/server';
import { authenticate, authGateway, firstPartyCookie, providerCookies, verifyFreshSession, verifyUserJwt } from './auth.js';
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

test('JWT verification requires the configured issuer, audience, expiry and signature', async t => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'EdDSA', use: 'sig' };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ keys: [jwk] }));
  const env = { NEON_AUTH_BASE_URL: `https://auth-${randomUUID()}.example/neondb/auth` };
  const issuer = new URL(env.NEON_AUTH_BASE_URL).origin;
  const sign = overrides => new SignJWT({ sub: 'member', ...overrides }).setProtectedHeader({ alg: 'EdDSA', kid: 'fixture' })
    .setIssuedAt().setIssuer(overrides?.iss || issuer).setAudience(overrides?.aud || issuer).setExpirationTime(overrides?.exp ?? '15m').sign(privateKey);
  assert.equal((await verifyUserJwt(await sign(), env)).sub, 'member');
  for (const overrides of [{ iss: 'https://attacker.example' }, { aud: 'other' }, { exp: 1 }]) {
    await assert.rejects(verifyUserJwt(await sign(overrides), env), error => error.status === 401);
  }
  const valid = await sign();
  await assert.rejects(verifyUserJwt(`${valid.slice(0, -5)}wrong`, env), error => error.status === 401);
});

test('managed session proof bypasses cache and binds the real cookie to JWT subject', async () => {
  const request = req('people', 'POST', {}, { cookie: `${NEON_AUTH_SESSION_COOKIE_NAME}=opaque; family_frame_session=not-provider` });
  const env = { NEON_AUTH_BASE_URL: 'https://auth.example/neondb/auth' };
  let seen;
  const response = userId => Response.json({ user: { id: userId }, session: { userId, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  await verifyFreshSession(request, 'member', env, async (url, options) => { seen = { url, options }; return response('member'); });
  assert.ok(seen.url.endsWith('/get-session?disableCookieCache=true'));
  assert.equal(seen.options.headers.cookie, `${NEON_AUTH_SESSION_COOKIE_NAME}=opaque`);
  await assert.rejects(verifyFreshSession(request, 'member', env, async () => response('someone-else')), error => error.status === 401);
  await assert.rejects(verifyFreshSession(request, 'member', env, async () => Response.json(null)), error => error.status === 401);
});

test('actual pinned SDK cookie namespace remains first-party, private and deletable', () => {
  assert.equal(NEON_AUTH_SESSION_COOKIE_NAME, '__Secure-neon-auth.session_token');
  const request = req('session', 'GET', undefined, { cookie: `${NEON_AUTH_SESSION_COOKIE_NAME}=opaque; unrelated=secret` });
  assert.equal(providerCookies(request), `${NEON_AUTH_SESSION_COOKIE_NAME}=opaque`);
  const rewritten = firstPartyCookie(`${NEON_AUTH_SESSION_COOKIE_NAME}=opaque; Domain=auth.example; Path=/neondb/auth; Secure; HttpOnly; SameSite=None; Max-Age=900`);
  assert.ok(!rewritten.includes('Domain='));
  assert.match(rewritten, /Path=\//);
  assert.match(rewritten, /HttpOnly/);
  assert.match(rewritten, /Secure/);
  assert.match(firstPartyCookie(`${NEON_AUTH_SESSION_COOKIE_NAME}=; Max-Age=0; Secure; HttpOnly`), /Max-Age=0/i);
  assert.throws(() => firstPartyCookie('unrelated=credential; HttpOnly; Secure'));
});

test('gateway forwards only proven Vercel routing keys and rejects redirects or open paths', async () => {
  const env = { NEON_AUTH_BASE_URL: 'https://auth.example/neondb/auth' };
  let seen;
  const fetchImpl = async (url, options) => { seen = { url: String(url), options }; return Response.json(null); };
  const response = await authGateway(req('auth/get-session?__route=auth/get-session&path=auth/get-session'), 'get-session', { env, fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(seen.url, `${env.NEON_AUTH_BASE_URL}/get-session`);
  assert.equal(seen.options.redirect, 'manual');
  for (const query of ['path=sign-up/email', 'redirect=https://attacker.example', '__route=wrong']) {
    await assert.rejects(authGateway(req(`auth/get-session?${query}`), 'get-session', { env, fetchImpl }), error => error.status === 422);
  }
  await assert.rejects(authGateway(req('auth/unknown'), 'unknown', { env, fetchImpl }), error => error.status === 404);
  await assert.rejects(authGateway(req('auth/get-session'), 'get-session', { env, fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://attacker.example' } }) }), error => error.status === 502);
  await assert.rejects(authGateway(req('auth/sign-in/email', 'POST', { email: 'test@example.com', password: 'fixture', callbackURL: 'https://attacker.example' }), 'sign-in/email', { env, fetchImpl }), error => error.status === 422);
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
