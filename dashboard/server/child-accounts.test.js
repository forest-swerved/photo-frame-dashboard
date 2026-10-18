import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { confirmedAccountEmail } from './supabase-auth.js';
import { createInvite } from './household.js';
import { createMobilePair, redeemMobilePair } from './mobile.js';
import { handleRequest } from './app.js';

const id = randomUUID();
const principal = { authType: 'user', role: 'admin', user: { id, name: 'Parent' }, household: { id: randomUUID() } };
const request = new Request('https://family.example/api/join', { headers: { authorization: 'Bearer fixture-access-token' } });

test('child redemption confirms the exact provider user and its confirmed email, never metadata or phone confirmation', async () => {
  let calls = 0;
  const user = { id, email: '  Child@Example.Invalid ', email_confirmed_at: '2026-10-17T00:00:00Z', user_metadata: { role: 'admin', email_verified: true } };
  const options = value => ({ authContext: { client: { auth: { async getUser(jwt) { calls++; assert.equal(jwt, 'fixture-access-token'); return { data: { user: value }, error: null }; } } } } });
  assert.equal(await confirmedAccountEmail(request, principal, options(user)), 'child@example.invalid');
  assert.equal(calls, 1);
  for (const bad of [{ ...user, id: randomUUID() }, { ...user, email_confirmed_at: null, confirmed_at: '2026-10-17T00:00Z' },
    { ...user, email_confirmed_at: 'invalid' }]) {
    await assert.rejects(confirmedAccountEmail(request, principal, options(bad)), error => error.status === 403 && error.code === 'email_not_confirmed');
  }
});

test('only administrators may target a child and request fields cannot create an admin invitation', async () => {
  const db = { query() { assert.fail('Rejected invitation must not access storage.'); } };
  for (const role of ['member', 'child', 'frame']) await assert.rejects(createInvite(db, { ...principal, role }, { role: 'child', personId: randomUUID(), email: 'child@example.invalid' }), error => error.status === 403);
  for (const body of [{ role: 'admin' }, { role: 'child', personId: randomUUID(), email: 'invalid' }, { role: 'member', personId: randomUUID() }, { userId: randomUUID() }]) {
    await assert.rejects(createInvite(db, principal, body), error => error.status === 422);
  }
});

test('retired anonymous child pairing returns 410 without opening storage or consuming a rate-limit bucket', async () => {
  await assert.rejects(createMobilePair(), error => error.status === 410 && error.code === 'child_accounts_required');
  await assert.rejects(redeemMobilePair(), error => error.status === 410 && error.code === 'child_accounts_required');
  for (const path of ['mobile/pairings', 'mobile/pairings/redeem']) {
    const response = await handleRequest(new Request(`https://family.example/api/${path}`, { method: 'POST', headers: { origin: 'https://family.example' } }), { db: { query() { assert.fail('Retired route must not query.'); } } });
    assert.equal(response.status, 410);
  }
});
