import test from 'node:test';
import assert from 'node:assert/strict';
import { authClient, tokenForClient, clearAuthCache } from './auth.js';

test('a signed-out managed session is ordinary state and does not request a JWT', async () => {
  let tokenRequests = 0;
  const token = await tokenForClient({ getSession: async () => ({ data: null, error: null }), token: async () => { tokenRequests++; } });
  assert.equal(token, null);
  assert.equal(tokenRequests, 0);
});

test('the bearer comes from the JWT endpoint rather than an opaque session credential', async () => {
  const auth = {
    getSession: async () => ({ data: { session: { expiresAt: '2099-01-01T00:00:00Z' } } }),
    token: async () => ({ data: { token: 'signed-jwt' } }),
  };
  const token = await tokenForClient(auth);
  assert.equal(token, 'signed-jwt');
});

test('an expired session during token refresh returns signed-out state', async () => {
  const token = await tokenForClient({ getSession: async () => ({ data: { session: {} } }), token: async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); } });
  assert.equal(token, null);
});

test('the BFF client keeps sign-in and verification bodies on the same origin with no cache', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    requests.push({ path, ...options });
    return Response.json({ success: true });
  });
  const auth = await authClient();
  await auth.signIn.email({ email: 'test@example.invalid', password: 'fixture-password' });
  await auth.verifyEmail({ email: 'test@example.invalid', token: '123456' });
  await auth.verifyEmail({ confirmationLink: 'https://fixture.supabase.invalid/auth/v1/verify?token=fixture&type=signup' });
  await auth.resendVerification({ email: 'test@example.invalid' });
  assert.deepEqual(requests.map(item => item.path), ['/api/auth/sign-in/email', '/api/auth/verify-email', '/api/auth/verify-email', '/api/auth/resend-verification']);
  assert.ok(requests.every(item => item.method === 'POST' && item.credentials === 'same-origin' && item.cache === 'no-store' && item.redirect === 'error'));
  assert.equal(JSON.parse(requests[1].body).token, '123456');
  assert.equal(JSON.parse(requests[2].body).confirmationLink.includes('token=fixture'), true);
});

test('the BFF client preserves structured provider errors and does not cache a token as a session', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async path => {
    paths.push(path);
    if (path.endsWith('get-session')) return Response.json({ session: { expiresAt: '2099-01-01T00:00:00Z' }, user: { id: 'fixture-user' } });
    if (path.endsWith('/token')) return Response.json({ token: 'fixture-jwt' });
    return Response.json({ error: { code: 'email_not_confirmed', message: 'Confirm your email.' }, requestId: 'fixture-request' }, { status: 403 });
  });
  const auth = await authClient();
  assert.equal(await tokenForClient(auth), 'fixture-jwt');
  const failed = await auth.signIn.email({ email: 'test@example.invalid', password: 'fixture' });
  assert.deepEqual(failed.error, { status: 403, code: 'email_not_confirmed', message: 'Confirm your email.', requestId: 'fixture-request' });
  assert.deepEqual(paths.slice(0, 2), ['/api/auth/get-session', '/api/auth/token']);
});

test('a provider failure is not mistaken for a normal signed-out session', async () => {
  await assert.rejects(tokenForClient({ getSession: async () => { throw Object.assign(new Error('Provider unavailable'), { status: 503 }); } }), /Provider unavailable/);
});

test('concurrent data reads share a transient token refresh and refresh before the earliest expiry', async () => {
  const now = Date.parse('2026-10-17T18:00:00Z');
  const jwt = `fixture.${Buffer.from(JSON.stringify({ exp: (now + 90_000) / 1000 })).toString('base64url')}.fixture`;
  let sessions = 0, tokens = 0;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const auth = {
    getSession: async () => { sessions++; await waiting; return { data: { session: { expiresAt: new Date(now + 3_600_000).toISOString() } } }; },
    token: async () => { tokens++; return { data: { token: jwt } }; },
  };
  const reads = Array.from({ length: 4 }, () => tokenForClient(auth, now));
  release();
  assert.deepEqual(await Promise.all(reads), [jwt, jwt, jwt, jwt]);
  assert.equal(sessions, 1); assert.equal(tokens, 1);
  assert.equal(await tokenForClient(auth, now + 59_000), jwt);
  assert.equal(sessions, 1);
  await tokenForClient(auth, now + 61_000);
  assert.equal(sessions, 2); assert.equal(tokens, 2);
});

test('an auth transition discards an older in-flight credential and forces a new session check', async () => {
  const now = Date.now();
  let releaseOld;
  let tokenCalls = 0;
  const auth = {
    getSession: async () => ({ data: { session: { expiresAt: new Date(now + 3_600_000).toISOString() } } }),
    token: async () => {
      tokenCalls++;
      if (tokenCalls === 1) return new Promise(resolve => { releaseOld = () => resolve({ data: { token: 'old-fixture-token' } }); });
      return { data: { token: 'current-fixture-token' } };
    },
  };
  const old = tokenForClient(auth, now);
  await new Promise(resolve => setImmediate(resolve));
  clearAuthCache();
  assert.equal(await tokenForClient(auth, now), 'current-fixture-token');
  releaseOld();
  assert.equal(await old, null);
  assert.equal(await tokenForClient(auth, now), 'current-fixture-token');
  assert.equal(tokenCalls, 2);
});
