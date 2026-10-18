import test from 'node:test';
import assert from 'node:assert/strict';
import { authGateway, recoveryCredentials } from './supabase-auth.js';
const env = { SUPABASE_URL: 'https://auth.example', FAMILY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') };
const claims = { sub: '00000000-0000-4000-8000-000000000001', accessToken: 'recovery-session' };
const request = (route, body) => new Request(`https://family.example/api/auth/${route}`, { method: 'POST', headers: { origin: 'https://family.example', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const db = { async query() { return { rows: [], rowCount: 0 }; }, async connect() { return { async query(sql) { return { rows: sql.includes('RETURNING attempts') ? [{ attempts: 1 }] : [] }; }, release() {} }; } };
test('recovery links require exact project and recovery type; never follow redirects', () => {
  const token = 'a'.repeat(32);
  assert.deepEqual(recoveryCredentials({ recoveryLink: `https://auth.example/auth/v1/verify?token=${token}&type=recovery&redirect_to=https://ignored.example`, password: 'unused' }, env), { token_hash: token, type: 'recovery' });
  for (const recoveryLink of [`https://attacker.example/auth/v1/verify?token=${token}&type=recovery`, `https://auth.example/auth/v1/verify?token=${token}&type=signup`, `https://auth.example/auth/v1/verify?token=${token}&type=recovery&type=recovery`]) assert.throws(() => recoveryCredentials({ recoveryLink }, env));
});
test('successful recovery verifies a fresh proof before password change and revokes sign-ins', async () => {
  const calls = [], revocations = []; let signedOut = false;
  const auth = { async verifyOtp(proof) { calls.push(['proof', proof]); return { data: { user: { id: claims.sub }, session: { access_token: claims.accessToken } } }; },
    async updateUser(value) { calls.push(['password', value]); return {}; }, async signOut(value) { calls.push(['signOut', value]); signedOut = true; return {}; } };
  const context = { client: { auth }, async sessionClaims() { calls.push(['claims']); return claims; }, clearCookies() { calls.push(['clear']); }, finish: response => response };
  const record = async (sql, values) => { revocations.push({ sql, values, signedOut }); return { rows: sql.includes('RETURNING attempts') ? [{ attempts: 1 }] : sql.startsWith('SELECT household_id') ? [{ household_id: '00000000-0000-4000-8000-000000000002' }, { household_id: '00000000-0000-4000-8000-000000000003' }] : [], rowCount: 0 }; };
  const resetDb = { query: record, async connect() { return { query: record, release() {} }; } };
  const response = await authGateway(request('reset-password', { email: 'fixture@example.test', token: '123456', password: 'a-new-strong-password' }), 'reset-password', resetDb, { env, createAuthContext: () => context });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true });
  assert.deepEqual(calls.map(c => c[0]), ['proof', 'claims', 'password', 'signOut', 'clear']); assert.equal(calls[0][1].type, 'recovery'); assert.equal(calls[3][1].scope, 'global');
  assert.ok(revocations.some(q => q.sql.startsWith('UPDATE family_mobile_sessions') && q.values[0] === claims.sub));
  assert.ok(revocations.some(q => q.sql.startsWith('UPDATE family_frame_authorizations') && q.values[0] === claims.sub), 'Password recovery revokes issued parent/child frame approvals.');
  assert.ok(revocations.some(q => q.sql.startsWith('UPDATE family_frame_authorizations') && q.signedOut), 'Final revocation runs after global Auth sign-out.');
  assert.deepEqual(revocations.filter(q => q.signedOut && q.sql.includes('pg_advisory_xact_lock')).map(q => q.values[0]), ['frame-unlock:00000000-0000-4000-8000-000000000002:' + claims.sub, 'frame-unlock:00000000-0000-4000-8000-000000000003:' + claims.sub]);
});
test('a previous normal session or failed recovery cannot authorize a new password', async () => {
  for (const result of [{ error: { code: 'otp_expired' } }, { data: {} }, { data: { user: { id: 'another-user' }, session: { access_token: claims.accessToken } } }]) {
    let updated = false;
    const context = { client: { auth: { verifyOtp: async () => result, updateUser: async () => { updated = true; return {}; } } }, sessionClaims: async () => claims, clearCookies() {}, finish: response => response };
    const response = await authGateway(request('reset-password', { email: 'fixture@example.test', token: '123456', password: 'a-new-strong-password' }), 'reset-password', db, { env, createAuthContext: () => context });
    assert.ok([401, 422].includes(response.status)); assert.equal(updated, false);
  }
});
test('password reset requests do not expose whether an address has an account', async () => {
  for (const result of [{}, { error: { code: 'user_not_found' } }]) {
    const context = { client: { auth: { resetPasswordForEmail: async () => result } }, finish: response => response };
    const response = await authGateway(request('request-password-reset', { email: 'fixture@example.test' }), 'request-password-reset', db, { env, createAuthContext: () => context });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true });
  }
});
