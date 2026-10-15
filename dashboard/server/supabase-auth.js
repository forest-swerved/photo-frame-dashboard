import { randomUUID } from 'node:crypto';
import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import { ApiError, readJson, requireValue, textField } from './errors.js';
import { assertSameOrigin, authUrl, userDto, verifySessionRow, verifyUserJwt } from './auth.js';

export const AUTH_COOKIE = '__Host-family_auth';
const cookieName = name => name === AUTH_COOKIE || new RegExp(`^${AUTH_COOKIE}\\.\\d+$`).test(name)
  || name === `${AUTH_COOKIE}-code-verifier` || name === `${AUTH_COOKIE}-user`;
const routes = new Map([
  ['sign-in/email', 'POST'], ['sign-up/email', 'POST'], ['sign-out', 'POST'],
  ['verify-email', 'POST'], ['resend-verification', 'POST'], ['get-session', 'GET'], ['token', 'GET'],
]);
const rawJson = data => Response.json(data, { headers: { 'Cache-Control': 'private, no-store', Pragma: 'no-cache', Expires: '0' } });

function providerError(error) {
  const code = error?.code;
  if (code === 'email_not_confirmed') return new ApiError(403, 'email_not_confirmed', 'Confirm your email before signing in.');
  if (['over_email_send_rate_limit', 'over_request_rate_limit'].includes(code) || error?.status === 429) return new ApiError(429, 'auth_rate_limited', 'Too many requests. Wait a moment and try again.');
  if (code === 'email_address_not_authorized') return new ApiError(503, 'email_delivery_unavailable', 'Email delivery is not configured for this account.');
  if (code === 'otp_expired') return new ApiError(422, 'verification_expired', 'That confirmation has expired. Request another email.');
  if (code === 'weak_password') return new ApiError(422, 'weak_password', 'Choose a longer password with a mix of letters, numbers, and symbols.');
  if (code === 'user_already_exists') return new ApiError(422, 'account_exists', 'Try signing in or confirming your email.');
  if (code === 'invalid_credentials') return new ApiError(401, 'invalid_credentials', 'The email or password was not accepted.');
  if (error?.status >= 500 || error?.name === 'AuthRetryableFetchError') return new ApiError(503, 'auth_unavailable', 'Sign-in is temporarily unavailable.');
  return new ApiError(422, 'auth_request_failed', 'That sign-in request could not be completed. Check your details and try again.');
}

function boundedAuthFetch(base, fetchImpl) {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requireValue(url.origin === new URL(base).origin && /^\/auth\/v1\/(token|signup|verify|resend|logout|user)$/.test(url.pathname),
      502, 'auth_unavailable', 'Unexpected sign-in request.');
    const response = await fetchImpl(input, { ...init, redirect: 'manual', cache: 'no-store',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    requireValue(response.status < 300 || response.status >= 400, 502, 'auth_unavailable', 'Unexpected sign-in redirect.');
    return response;
  };
}

export function createAuthContext(request, { env = process.env, fetchImpl = fetch, createClient = createServerClient } = {}) {
  const base = authUrl(env);
  requireValue(typeof env.SUPABASE_PUBLISHABLE_KEY === 'string' && env.SUPABASE_PUBLISHABLE_KEY.length > 10,
    503, 'configuration_missing', 'Sign-in is not configured.');
  const incoming = request.headers.get('cookie') || '';
  requireValue(incoming.length <= 32_768, 431, 'headers_too_large', 'Sign in again to refresh this session.');
  const jar = new Map(parseCookieHeader(incoming).filter(cookie => cookieName(cookie.name)).map(cookie => [cookie.name, cookie.value]));
  const writes = new Map();
  const cacheHeaders = new Headers();
  const setCookie = (name, value, options = {}) => {
    requireValue(cookieName(name), 502, 'auth_unavailable', 'Unexpected sign-in cookie.');
    jar.set(name, value);
    writes.set(name, serializeCookieHeader(name, value, { ...options, domain: undefined, path: '/', httpOnly: true, secure: true, sameSite: 'lax' }));
  };
  const client = createClient(new URL(base).origin, env.SUPABASE_PUBLISHABLE_KEY, {
    cookieOptions: { name: AUTH_COOKIE, path: '/', httpOnly: true, secure: true, sameSite: 'lax' },
    cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies, headers = {}) => {
        for (const { name, value, options } of cookies) setCookie(name, value, options);
        for (const [name, value] of Object.entries(headers)) cacheHeaders.set(name, value);
      } },
    global: { fetch: boundedAuthFetch(base, fetchImpl) },
    auth: { autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    client,
    clearCookies() { for (const name of jar.keys()) setCookie(name, '', { maxAge: 0 }); },
    finish(response) {
      const headers = new Headers(response.headers);
      for (const value of writes.values()) headers.append('Set-Cookie', value);
      for (const [name, value] of cacheHeaders) headers.set(name, value);
      headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
      headers.set('Pragma', 'no-cache'); headers.set('Expires', '0');
      return new Response(response.body, { status: response.status, headers });
    },
    async sessionClaims(db, verifyJwt = verifyUserJwt) {
      // getSession is only storage/refresh. Its embedded user never authorizes;
      // verify the JWT and live provider session independently.
      const { data, error } = await client.auth.getSession();
      if (error) throw providerError(error);
      if (!data?.session?.access_token) return null;
      const claims = await verifyJwt(data.session.access_token, env);
      await verifySessionRow(db, claims);
      return { ...claims, accessToken: data.session.access_token };
    },
  };
}

export function confirmationCredentials(body, env = process.env) {
  if (Object.hasOwn(body, 'confirmationLink')) {
    requireValue(Object.keys(body).length === 1 && typeof body.confirmationLink === 'string' && body.confirmationLink.length <= 4096,
      422, 'invalid_verification', 'Paste the confirmation link from your email.');
    let link;
    try { link = new URL(body.confirmationLink.trim()); } catch { /* Redacted below. */ }
    const base = new URL(authUrl(env));
    requireValue(link && link.origin === base.origin && link.pathname === '/auth/v1/verify' && !link.username && !link.password && !link.hash
      && ['signup', 'email'].includes(link.searchParams.get('type')),
    422, 'invalid_verification', 'Use the confirmation link from this dashboard’s email.');
    const keys = [...link.searchParams.keys()];
    requireValue(keys.every(key => ['token', 'token_hash', 'type', 'redirect_to'].includes(key)) && new Set(keys).size === keys.length,
      422, 'invalid_verification', 'This confirmation link is invalid.');
    const hash = link.searchParams.get('token_hash') || link.searchParams.get('token');
    requireValue(!(link.searchParams.has('token_hash') && link.searchParams.has('token')) && typeof hash === 'string' && /^[A-Za-z0-9_-]{20,512}$/.test(hash),
      422, 'invalid_verification', 'This confirmation link is invalid.');
    // redirect_to is ignored, never opened, returned, or passed to the SDK.
    return { token_hash: hash, type: 'email' };
  }
  requireValue(Object.keys(body).every(key => ['email', 'token'].includes(key)) && typeof body.token === 'string' && /^\d{6,10}$/.test(body.token),
    422, 'invalid_verification', 'Enter the confirmation code from your email.');
  return { email: emailField(body.email), token: body.token, type: 'email' };
}

function emailField(value) {
  const email = textField(value, 'Email', 254);
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 422, 'invalid_email', 'Enter a valid email address.');
  return email;
}

function passwordField(value) {
  requireValue(typeof value === 'string' && value.length >= 1 && value.length <= 1024, 422, 'invalid_password', 'Enter your password.');
  return value;
}

function sessionDto(claims) {
  return claims ? { session: { expiresAt: new Date(claims.exp * 1000).toISOString() }, user: userDto(claims) } : null;
}

export async function authGateway(request, path, db, options = {}) {
  const { env = process.env, verifyJwt = verifyUserJwt } = options;
  let context;
  const requestId = randomUUID();
  try {
    requireValue(routes.get(path) === request.method, 404, 'not_found', 'That endpoint does not exist.');
    if (request.method === 'POST' || request.headers.has('origin')) assertSameOrigin(request);
    requireValue(request.headers.get('sec-fetch-site') !== 'cross-site', 403, 'origin_rejected', 'Open this dashboard directly before signing in.');
    const url = new URL(request.url);
    for (const [key, value] of url.searchParams) requireValue(['__route', 'path'].includes(key) && value === `auth/${path}`,
      422, 'invalid_auth_query', 'This sign-in request is invalid.');
    const body = request.method === 'POST' ? await readJson(request) : null;
    if (body && path !== 'verify-email') {
      const fields = path === 'sign-in/email' ? ['email', 'password'] : path === 'sign-up/email' ? ['email', 'password', 'name'] : path === 'resend-verification' ? ['email'] : [];
      requireValue(Object.keys(body).every(key => fields.includes(key)), 422, 'invalid_auth_body', 'This sign-in request contains unsupported fields.');
    }
    context = (options.createAuthContext || createAuthContext)(request, options);
    const auth = context.client.auth;
    let result;
    if (path === 'get-session' || path === 'token') {
      const claims = await context.sessionClaims(db, verifyJwt);
      if (path === 'token') requireValue(claims, 401, 'unauthenticated', 'Please sign in.');
      result = path === 'token' ? { token: claims.accessToken } : sessionDto(claims);
    } else if (path === 'sign-out') {
      const response = await auth.signOut({ scope: 'local' });
      if (response.error) throw providerError(response.error);
      context.clearCookies();
      result = { success: true };
    } else if (path === 'resend-verification') {
      const response = await auth.resend({ type: 'signup', email: emailField(body.email) });
      if (response.error) throw providerError(response.error);
      result = { success: true };
    } else {
      const response = path === 'verify-email' ? await auth.verifyOtp(confirmationCredentials(body, env))
        : path === 'sign-in/email' ? await auth.signInWithPassword({ email: emailField(body.email), password: passwordField(body.password) })
          : await auth.signUp({ email: emailField(body.email), password: passwordField(body.password), options: { data: { name: textField(body.name, 'Name', 120) } } });
      if (response.error) throw providerError(response.error);
      if (path === 'sign-up/email' && !response.data?.session) result = { session: null, user: null, confirmationRequired: true };
      else {
        const claims = await context.sessionClaims(db, verifyJwt);
        requireValue(claims, 401, 'session_required', 'Please sign in after confirming your email.');
        result = sessionDto(claims);
      }
    }
    return context.finish(rawJson(result));
  } catch (error) {
    const known = error instanceof ApiError;
    if (context && ['unauthenticated', 'session_required'].includes(error?.code)) context.clearCookies();
    const response = Response.json({ error: { code: known ? error.code : 'auth_unavailable',
      message: known ? error.message : 'Sign-in is temporarily unavailable.' }, requestId },
    { status: known ? error.status : 503, headers: { 'Cache-Control': 'private, no-store' } });
    return context ? context.finish(response) : response;
  }
}
