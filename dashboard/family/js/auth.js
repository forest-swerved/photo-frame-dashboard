// Authentication stays on this origin. Only the server handles the provider's
// HttpOnly session/refresh cookies; this module has no SDK or persistent cache.
export async function authRequest(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`/api/auth/${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data;
    try { data = await response.json(); }
    catch { return { data: null, error: { status: response.status || 502, code: 'invalid_auth_response', message: 'Sign-in is unavailable right now. Please try again.' } }; }
    if (!response.ok) return { data: null, error: { status: response.status, code: data?.error?.code || 'auth_failed', message: data?.error?.message || 'The sign-in request could not be completed.', requestId: data?.requestId } };
    return { data, error: null };
  } catch (error) {
    return { data: null, error: { status: 0, code: 'network_error', message: error.name === 'AbortError' ? 'Sign-in took too long to respond. Please try again.' : 'Cannot reach sign-in. Check your connection and try again.' } };
  } finally { clearTimeout(timeout); }
}

const post = (path, body = {}) => authRequest(path, { method: 'POST', body });
const client = {
  getSession: () => authRequest('get-session'),
  token: () => authRequest('token'),
  signIn: { email: credentials => post('sign-in/email', credentials) },
  signUp: { email: credentials => post('sign-up/email', credentials) },
  signOut: () => post('sign-out'),
  verifyEmail: credentials => post('verify-email', credentials),
  resendVerification: credentials => post('resend-verification', credentials),
};
export async function authClient() { return client; }

export async function userToken() {
  return tokenForClient(await authClient());
}

export async function tokenForClient(auth) {
  try {
    const session = await auth.getSession();
    if (session.error) {
      if ([401, 403].includes(session.error.status)) return null;
      throw session.error;
    }
    if (!session.data?.session) return null;
    const { data, error } = await auth.token();
    if (error) {
      if ([401, 403].includes(error.status)) return null;
      throw error;
    }
    return data?.token || null;
  } catch (error) {
    // A session can expire between the session check and the token request.
    if ([401, 403].includes(error.status)) return null;
    throw error;
  }
}
