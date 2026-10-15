import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenForClient } from './auth.js';

test('a signed-out managed session is ordinary state and does not request a JWT', async () => {
  let tokenRequests = 0;
  const token = await tokenForClient({ getSession: async () => ({ data: null, error: null }), token: async () => { tokenRequests++; } });
  assert.equal(token, null);
  assert.equal(tokenRequests, 0);
});

test('the bearer comes from the JWT endpoint rather than an opaque session credential', async () => {
  let cachedSession;
  const auth = {
    getSession: async () => { cachedSession = { session: { token: 'opaque-session-cookie' } }; return { data: cachedSession }; },
    // The pinned SDK routes /token through its getSession cache hook. A normal
    // token call after getSession therefore returns the cached session shape.
    token: async options => options?.fetchOptions?.headers?.['X-Force-Fetch'] ? { data: { token: 'signed-jwt' } } : { data: cachedSession },
  };
  await auth.getSession();
  assert.equal((await auth.token()).data.token, undefined);
  const token = await tokenForClient(auth);
  assert.equal(token, 'signed-jwt');
});

test('the pinned SDK throwing Unauthorized during token refresh returns signed-out state', async () => {
  const token = await tokenForClient({ getSession: async () => ({ data: { session: {} } }), token: async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); } });
  assert.equal(token, null);
});

test('a provider failure is not mistaken for a normal signed-out session', async () => {
  await assert.rejects(tokenForClient({ getSession: async () => { throw Object.assign(new Error('Provider unavailable'), { status: 503 }); } }), /Provider unavailable/);
});
