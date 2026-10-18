const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const guardCodes = new Set(['ownership_transfer_required', 'managed_devices_enrolled', 'internet_sessions_active']);
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'private, no-store', pragma: 'no-cache' } });
const failure = (code, message, status) => reply({ error: { code, message } }, status);

// Called only after Auth getUser(token) has cryptographically authenticated the
// exact token. Parsing its verified payload must never substitute for getUser.
export function freshDeletionClaims(token, userId, base, now = new Date()) {
  try {
    const part = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), char => char.charCodeAt(0))));
    const seconds = now.getTime() / 1000;
    if (claims.sub !== userId || !UUID.test(userId) || !UUID.test(claims.session_id || '') || claims.role !== 'authenticated'
      || claims.is_anonymous === true || claims.iss !== `${base}/auth/v1` || !(claims.aud === 'authenticated' || Array.isArray(claims.aud) && claims.aud.includes('authenticated'))
      || !Number.isInteger(claims.exp) || claims.exp <= seconds || !Number.isInteger(claims.iat) || claims.iat > seconds + 5 || seconds - claims.iat > 300
      || !Array.isArray(claims.amr) || !claims.amr.some(method => method?.method === 'password' && Number.isInteger(method.timestamp)
        && method.timestamp <= seconds + 5 && seconds - method.timestamp <= 300)) return null;
    return claims;
  } catch { return null; }
}

async function readConfirmation(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return false;
  const reader = request.body?.getReader();
  if (!reader) return false;
  let text = '', size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); return false; }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    return body && Object.keys(body).length === 1 && body.confirmation === 'DELETE MY ACCOUNT';
  } catch { return false; }
  finally { reader.releaseLock(); }
}

export function createDeleteAccountHandler({ createClient, env, now = () => new Date(), fetchImpl = fetch }) {
  return async request => {
    if (request.method !== 'POST') return failure('method_not_allowed', 'Use POST for account deletion.', 405);
    const authorization = request.headers.get('authorization') || '';
    if (authorization.length > 16_384 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) return failure('reauthentication_required', 'Sign in again before deleting your account.', 401);
    if (!await readConfirmation(request)) return failure('deletion_confirmation_required', 'Type DELETE MY ACCOUNT exactly.', 422);
    let base;
    try {
      const url = new URL(env.SUPABASE_URL);
      if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw Error('configuration');
      base = url.origin;
      if (!env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) throw Error('configuration');
    } catch { return failure('deletion_unavailable', 'Account deletion is temporarily unavailable.', 503); }
    const token = authorization.slice(7);
    const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== base || !/^\/(?:auth\/v1\/(?:user|logout|admin\/users\/[0-9a-f-]{36})|rest\/v1\/rpc\/family_delete_account_data)$/.test(url.pathname)) throw Error('unexpected endpoint');
        return fetchImpl(input, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      } } };
    const publicClient = createClient(base, env.SUPABASE_ANON_KEY, options);
    const admin = createClient(base, env.SUPABASE_SERVICE_ROLE_KEY, options);
    let user;
    try {
      const verified = await publicClient.auth.getUser(token);
      if (verified.error || !verified.data?.user) return failure('reauthentication_required', 'Sign in again before deleting your account.', 401);
      user = verified.data.user;
    } catch { return failure('deletion_unavailable', 'Account verification is temporarily unavailable.', 503); }
    const claims = freshDeletionClaims(token, user.id, base, now());
    if (!claims) return failure('reauthentication_required', 'Reenter your password before deleting your account.', 401);
    try {
      // Identity is derived only from getUser, never request JSON or JWT parsing.
      const prepared = await admin.rpc('family_delete_account_data', { p_user_id: user.id, p_action: 'prepare', p_verified_email: user.email_confirmed_at ? user.email : null, p_verified_session_id: claims.session_id });
      if (prepared.error || !prepared.data?.ok) {
        if (guardCodes.has(prepared.data?.code)) return failure(prepared.data.code, prepared.data.message, 409);
        if (prepared.data?.code === 'reauthentication_required') return failure('reauthentication_required', 'Sign in again before deleting your account.', 401);
        return failure('deletion_incomplete', 'Account cleanup could not finish. Reauthenticate and retry deletion.', 503);
      }
      // Guard failures do not sign out the caller. Cleanup revokes all family
      // credentials first; global Auth sign-out then prevents token refresh.
      const signedOut = await admin.auth.admin.signOut(token, 'global');
      if (signedOut.error && !['session_not_found', 'user_not_found'].includes(signedOut.error.code)) return failure('deletion_incomplete', 'Account cleanup finished. Sign in again and retry deletion.', 503);
      const deleted = await admin.auth.admin.deleteUser(user.id, false);
      if (deleted.error && deleted.error.code !== 'user_not_found') return failure('deletion_incomplete', 'Account cleanup finished. Sign in again and retry deletion.', 503);
      // The tombstone remains if this acknowledgement fails after Auth deletion.
      // It contains no email, password, token, or household data.
      try { await admin.rpc('family_delete_account_data', { p_user_id: user.id, p_action: 'complete' }); } catch { /* Auth deletion already succeeded. */ }
      return reply({ deleted: true });
    } catch { return failure('deletion_incomplete', 'Account deletion could not finish. Reauthenticate and retry deletion.', 503); }
  };
}
