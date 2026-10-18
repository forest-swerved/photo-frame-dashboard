import { userToken, clearAuthCache } from './auth.js';

let frameMode = false;
let frameAccess = null;
export function setFrameAccess(value) {
  frameAccess = value && typeof value.token === 'string' && Number.isFinite(Date.parse(value.expiresAt)) ? { ...value } : null;
}
export function frameAccessStatus() {
  if (frameAccess && Date.parse(frameAccess.expiresAt) <= Date.now()) frameAccess = null;
  if (!frameAccess) return null;
  const { scope, personId, expiresAt } = frameAccess;
  return { scope, personId, expiresAt };
}

export class ApiError extends Error {
  constructor(message, status, code, details, requestId) {
    super(message);
    Object.assign(this, { status, code, details, requestId });
  }
}

// A paired frame authenticates exclusively with a first-party HttpOnly cookie.
// Its credential is never available to JavaScript or written to browser storage.
export function setFrameMode(value) { frameMode = value === true; if (!frameMode) frameAccess = null; }

export async function request(path, options = {}) {
  const { method = 'GET', body, authenticated = true } = options;
  const headers = { Accept: 'application/json' };
  if (frameMode && frameAccessStatus()) headers['X-Family-Authorization'] = frameAccess.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    if (authenticated && !frameMode) {
      const token = await userToken();
      if (!token) throw new ApiError('Sign in to continue.', 401, 'unauthenticated');
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if ([401, 403].includes(response.status)) clearAuthCache();
      throw new ApiError(result.error?.message || 'The request could not be completed.', response.status, result.error?.code || 'request_failed', result.error?.details, result.requestId);
    }
    return result.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'AbortError' ? 'The server took too long to respond. Try again.' : 'Cannot reach the dashboard. Check your connection and try again.', 0, 'network_error');
  } finally {
    clearTimeout(timeout);
  }
}
