import { createClient } from '@supabase/supabase-js';
import { authUrl, verifySessionRow, verifyUserJwt } from './auth.js';
import { ApiError, requireValue, uuidField } from './errors.js';

const confirmation = 'DELETE MY ACCOUNT';
const edgeCodes = new Map([
  ['ownership_transfer_required', [409, 'Transfer household ownership to an existing adult before deleting your account.']],
  ['managed_devices_enrolled', [409, 'Unenroll managed Internet devices and verify their firewall policies are removed before deleting this household.']],
  ['internet_sessions_active', [409, 'End all Internet sessions and wait for confirmed blocking before deleting this household.']],
  ['reauthentication_required', [401, 'Enter your password again before deleting your account.']],
  ['deletion_incomplete', [503, 'Account deletion could not finish. Sign in again and retry deletion.']],
]);

function recentPassword(claims, now) {
  const seconds = now.getTime() / 1000;
  return Number.isInteger(claims.iat) && claims.iat <= seconds + 5 && seconds - claims.iat <= 300
    && Array.isArray(claims.amr) && claims.amr.some(method => method?.method === 'password'
      && Number.isInteger(method.timestamp) && method.timestamp <= seconds + 5 && seconds - method.timestamp <= 300);
}

async function edgeResult(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

// Passwords are sent only to this project's public Auth endpoint. Vercel never
// receives a service-role key; privileged deletion stays inside Supabase Edge.
export async function deleteAccount(db, principal, body, {
  env = process.env, fetchImpl = fetch, createPublicClient = createClient,
  verifyJwt = verifyUserJwt, verifySession = verifySessionRow, now,
} = {}) {
  requireValue(['user', 'mobile'].includes(principal?.authType) && principal.user?.id,
    403, 'account_required', 'Sign in to your own account to delete it.');
  const userId = uuidField(principal.user.id, 'Account');
  requireValue(body && Object.keys(body).every(key => ['password', 'confirmation'].includes(key))
    && body.confirmation === confirmation && typeof body.password === 'string' && body.password.length > 0 && body.password.length <= 1024,
  422, 'deletion_confirmation_required', 'Enter your password and type DELETE MY ACCOUNT exactly.');
  requireValue(typeof principal.user.email === 'string' && principal.user.email.length > 3 && principal.user.email.length <= 254,
    401, 'reauthentication_required', 'Sign in again with your current account email before deleting it.');
  const base = new URL(authUrl(env)).origin;
  requireValue(typeof env.SUPABASE_PUBLISHABLE_KEY === 'string' && env.SUPABASE_PUBLISHABLE_KEY.length > 10,
    503, 'configuration_missing', 'Account deletion is not configured.');
  const boundedFetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requireValue(url.origin === base && url.pathname === '/auth/v1/token' && url.search === '?grant_type=password',
      503, 'deletion_unavailable', 'Account reauthentication could not be completed.');
    return fetchImpl(input, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  };
  const client = createPublicClient(base, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: boundedFetch },
  });
  let response;
  try { response = await client.auth.signInWithPassword({ email: principal.user.email, password: body.password }); }
  catch { throw new ApiError(503, 'deletion_unavailable', 'Account reauthentication is temporarily unavailable.'); }
  if (response.error || !response.data?.session?.access_token) {
    if (response.error?.status === 429) throw new ApiError(429, 'auth_rate_limited', 'Too many password attempts. Wait a moment and try again.');
    if (response.error?.status >= 500) throw new ApiError(503, 'deletion_unavailable', 'Account reauthentication is temporarily unavailable.');
    throw new ApiError(401, 'reauthentication_required', 'The password was not accepted. Enter your current password.');
  }
  const token = response.data.session.access_token;
  const claims = await verifyJwt(token, env);
  requireValue(claims.sub === userId && recentPassword(claims, now || new Date()), 401, 'reauthentication_required', 'Enter your current account password again before deleting it.');
  await verifySession(db, claims);
  let result;
  try {
    const edge = await fetchImpl(`${base}/functions/v1/family-delete-account`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(45_000),
      headers: { authorization: `Bearer ${token}`, apikey: env.SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation }),
    });
    result = await edgeResult(edge);
    if (!edge.ok || result?.deleted !== true) {
      const known = edgeCodes.get(result?.error?.code);
      if (known) throw new ApiError(known[0], result.error.code, known[1]);
      throw new ApiError(503, 'deletion_incomplete', 'Account deletion could not finish. Sign in again and retry deletion.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'deletion_incomplete', 'Account deletion could not finish. Sign in again and retry deletion.');
  }
  return { deleted: true };
}
