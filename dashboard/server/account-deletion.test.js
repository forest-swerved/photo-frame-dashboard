import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deleteAccount } from './account-deletion.js';
import { createDeleteAccountHandler, freshDeletionClaims } from '../../supabase/functions/family-delete-account/handler.mjs';

const now = new Date('2026-10-18T03:00:00Z'), seconds = now.getTime() / 1000;
const id = randomUUID(), base = 'https://family-fixture.supabase.co';
const env = { SUPABASE_URL: `${base}/`, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', SUPABASE_ANON_KEY: 'fixture-public', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-secret' };
const claims = { sub: id, session_id: randomUUID(), role: 'authenticated', iss: `${base}/auth/v1`, aud: 'authenticated', exp: seconds + 900, iat: seconds, amr: [{ method: 'password', timestamp: seconds }] };
const token = payload => `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture-signature`;
const body = { password: 'fixture password only', confirmation: 'DELETE MY ACCOUNT' };
const principal = { authType: 'user', user: { id, email: 'fixture@example.test' }, household: null };
const request = (payload = claims, json = { confirmation: body.confirmation }) => new Request(`${base}/functions/v1/family-delete-account`, {
  method: 'POST', headers: { authorization: `Bearer ${token(payload)}`, 'content-type': 'application/json' }, body: JSON.stringify(json),
});

function edgeFixture(options = {}) {
  const calls = [];
  const handler = createDeleteAccountHandler({ env, now: () => now, createClient(_url, key) {
    if (key === env.SUPABASE_ANON_KEY) return { auth: { async getUser(jwt) { calls.push(['getUser', jwt]); return { data: { user: { id: options.userId || id, email: 'fixture@example.test', email_confirmed_at: now.toISOString() } }, error: options.userError }; } } };
    assert.equal(key, env.SUPABASE_SERVICE_ROLE_KEY);
    return { rpc(name, values) {
      calls.push(['rpc', name, values]);
      // Deliberately use a PromiseLike without .catch, like PostgREST builders.
      return { then(resolve, reject) { return Promise.resolve(values.p_action === 'prepare'
        ? { data: options.guard || { ok: true, stage: 'data_deleted' } } : { data: { ok: true, stage: 'auth_deleted' } }).then(resolve, reject); } };
    }, auth: { admin: {
      async signOut(jwt, scope) { calls.push(['signOut', jwt, scope]); return { error: options.signOutError }; },
      async deleteUser(userId, soft) { calls.push(['deleteUser', userId, soft]); return { error: options.deleteError }; },
    } } };
  } });
  return { handler, calls };
}

test('deletion authority requires a fresh password method, fresh issuance, exact subject and project', () => {
  assert.equal(freshDeletionClaims(token(claims), id, base, now).sub, id);
  for (const changed of [
    { iat: seconds - 301 }, { iat: seconds + 6 }, { exp: seconds }, { role: 'service_role' },
    { amr: [{ method: 'otp', timestamp: seconds }] }, { amr: [{ method: 'password', timestamp: seconds - 301 }] },
    { amr: [{ method: 'password', timestamp: seconds + 6 }] }, { sub: randomUUID() }, { iss: 'https://other.supabase.co/auth/v1' },
  ]) assert.equal(freshDeletionClaims(token({ ...claims, ...changed }), id, base, now), null);
});

test('Edge ignores no identity supplied by a caller and verifies the token before its RPC', async () => {
  const { handler, calls } = edgeFixture();
  assert.equal((await handler(request(claims, { confirmation: body.confirmation, userId: randomUUID() }))).status, 422);
  assert.equal(calls.length, 0);
  const response = await handler(request()); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deleted: true });
  assert.equal(calls[0][0], 'getUser');
  assert.deepEqual(calls[1], ['rpc', 'family_delete_account_data', { p_user_id: id, p_action: 'prepare', p_verified_email: 'fixture@example.test', p_verified_session_id: claims.session_id }]);
  assert.equal(calls[2][0], 'signOut'); assert.equal(calls[2][2], 'global');
  assert.deepEqual(calls[3], ['deleteUser', id, false]);
  assert.equal(calls[4][2].p_action, 'complete');
});

test('guard failures leave Auth intact, and failed identity deletion retains a retryable cleanup result', async () => {
  const guarded = edgeFixture({ guard: { ok: false, code: 'ownership_transfer_required', message: 'Transfer ownership first.' } });
  const conflict = await guarded.handler(request()); assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'ownership_transfer_required');
  assert.deepEqual(guarded.calls.map(call => call[0]), ['getUser', 'rpc']);
  const failed = edgeFixture({ deleteError: { code: 'unexpected_failure', message: 'sensitive provider response' } });
  const response = await failed.handler(request()); assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'deletion_incomplete');
  assert.equal(failed.calls.filter(call => call[0] === 'rpc').length, 1, 'Completion cannot acknowledge a failed Auth deletion.');
  const retry = edgeFixture({ guard: { ok: true, stage: 'data_deleted' } });
  assert.equal((await retry.handler(request())).status, 200);
});

test('Edge rejects another identity or stale refreshed password claims without cleanup', async () => {
  for (const [options, payload] of [[{ userId: randomUUID() }, claims], [{}, { ...claims, amr: [{ method: 'password', timestamp: seconds - 400 }] }]]) {
    const { handler, calls } = edgeFixture(options);
    assert.equal((await handler(request(payload))).status, 401);
    assert.deepEqual(calls.map(call => call[0]), ['getUser']);
  }
  const signedOut = edgeFixture({ guard: { ok: false, code: 'reauthentication_required' } });
  assert.equal((await signedOut.handler(request())).status, 401);
  assert.deepEqual(signedOut.calls.map(call => call[0]), ['getUser', 'rpc']);
});

function bffFixture(options = {}) {
  const calls = [];
  const opts = { env, now, verifyJwt: async jwt => { calls.push(['verifyJwt', jwt]); return options.claims || claims; },
    verifySession: async (_db, verified) => { calls.push(['verifySession', verified.sub]); },
    createPublicClient(_url, key, config) {
      assert.equal(key, env.SUPABASE_PUBLISHABLE_KEY); assert.equal(config.auth.persistSession, false);
      return { auth: { async signInWithPassword(credentials) { calls.push(['password', credentials]); return options.authResponse || { data: { session: { access_token: token(claims) } } }; } } };
    }, async fetchImpl(url, init) {
      calls.push(['fetch', url, init]); return Response.json(options.edge || { deleted: true }, { status: options.status || 200 });
    } };
  return { calls, opts };
}

test('web/mobile reauthentication stays account-scoped and uses only a public key for the fixed Edge endpoint', async () => {
  for (const authType of ['user', 'mobile']) {
    const { calls, opts } = bffFixture();
    assert.deepEqual(await deleteAccount({}, { ...principal, authType }, body, opts), { deleted: true });
    assert.deepEqual(calls[0], ['password', { email: principal.user.email, password: body.password }]);
    const edgeCall = calls.find(call => call[0] === 'fetch');
    assert.equal(edgeCall[1], `${base}/functions/v1/family-delete-account`);
    assert.equal(edgeCall[2].headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(edgeCall[2].headers.authorization, `Bearer ${token(claims)}`);
    assert.deepEqual(JSON.parse(edgeCall[2].body), { confirmation: body.confirmation });
    assert.ok(!JSON.stringify(calls).includes(env.SUPABASE_SERVICE_ROLE_KEY));
    assert.ok(edgeCall[2].body.indexOf(body.password) === -1);
  }
});

test('the real pinned public SDK sends the password only to the fixed Auth token endpoint', async () => {
  const calls = [];
  const result = await deleteAccount({}, principal, body, { env, now,
    verifyJwt: async () => claims, verifySession: async () => {},
    async fetchImpl(url, init) {
      calls.push({ url: String(url), init });
      if (String(url) === `${base}/auth/v1/token?grant_type=password`) return Response.json({
        access_token: token(claims), refresh_token: 'fixture-refresh-token', token_type: 'bearer', expires_in: 900,
        user: { id, email: principal.user.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: now.toISOString() },
      });
      assert.equal(String(url), `${base}/functions/v1/family-delete-account`);
      return Response.json({ deleted: true });
    },
  });
  assert.deepEqual(result, { deleted: true }); assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].init.body).password, body.password);
  assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[1].init.redirect, 'error');
  assert.ok(!calls[1].init.body.includes(body.password));
});

test('BFF denies frames, caller-selected identities and password login to another account', async () => {
  const { calls, opts } = bffFixture();
  await assert.rejects(deleteAccount({}, { ...principal, authType: 'frame' }, body, opts), e => e.status === 403);
  await assert.rejects(deleteAccount({}, principal, { ...body, userId: randomUUID() }, opts), e => e.status === 422);
  assert.equal(calls.length, 0);
  const wrong = bffFixture({ claims: { ...claims, sub: randomUUID() } });
  await assert.rejects(deleteAccount({}, principal, body, wrong.opts), e => e.code === 'reauthentication_required');
  assert.ok(!wrong.calls.some(call => call[0] === 'fetch'));
});

test('BFF exposes only safe actionable deletion guards and sanitizes unexpected provider failures', async () => {
  const blocked = bffFixture({ status: 409, edge: { error: { code: 'managed_devices_enrolled', message: 'do not echo credentials' } } });
  await assert.rejects(deleteAccount({}, principal, body, blocked.opts), e => e.status === 409 && e.code === 'managed_devices_enrolled' && !e.message.includes('credentials'));
  const failed = bffFixture({ status: 500, edge: { error: { code: 'provider_secret', message: 'sensitive payload' } } });
  await assert.rejects(deleteAccount({}, principal, body, failed.opts), e => e.status === 503 && e.code === 'deletion_incomplete' && !e.message.includes('sensitive'));
});
