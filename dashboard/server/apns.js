import { connect } from 'node:http2';
import { createHash, createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { ApiError, requireValue } from './errors.js';

export const APNS_HOSTS = Object.freeze({ sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' });
const tokenCache = new Map();
const knownReasons = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered', 'TooManyRequests', 'TooManyProviderTokenUpdates',
  'ExpiredProviderToken', 'InvalidProviderToken', 'Forbidden', 'PayloadTooLarge', 'BadTopic', 'MissingTopic', 'ServiceUnavailable',
  'InternalServerError', 'Shutdown', 'IdleTimeout', 'BadExpirationDate', 'BadPriority', 'BadCollapseId', 'BadPath', 'MethodNotAllowed']);

export function apnsConfiguration(env = process.env) {
  const { FAMILY_APNS_TEAM_ID: teamId, FAMILY_APNS_KEY_ID: keyId, FAMILY_APNS_TOPIC: topic } = env;
  const privateKey = env.FAMILY_APNS_PRIVATE_KEY?.replace(/\\n/g, '\n');
  requireValue(/^[A-Z0-9]{10}$/.test(teamId || '') && /^[A-Z0-9]{10}$/.test(keyId || '')
    && /^[A-Za-z0-9][A-Za-z0-9.-]{2,199}$/.test(topic || '') && privateKey?.includes('-----BEGIN PRIVATE KEY-----'),
  503, 'push_not_configured', 'Push notifications are awaiting Apple developer configuration.');
  return { teamId, keyId, topic, privateKey };
}

export async function providerToken(env = process.env, now = new Date()) {
  const config = apnsConfiguration(env);
  const key = createHash('sha256').update(`${config.teamId}:${config.keyId}:${config.topic}:${config.privateKey}`).digest('hex');
  const seconds = Math.floor(now.getTime() / 1000);
  const cached = tokenCache.get(key);
  if (cached && seconds >= cached.issuedAt && seconds - cached.issuedAt < 50 * 60) return cached.token;
  let signingKey;
  try {
    signingKey = createPrivateKey(config.privateKey);
    requireValue(signingKey.asymmetricKeyType === 'ec' && signingKey.asymmetricKeyDetails?.namedCurve === 'prime256v1',
      503, 'push_not_configured', 'Push notifications are awaiting Apple developer configuration.');
  } catch { throw new ApiError(503, 'push_not_configured', 'Push notifications are awaiting Apple developer configuration.'); }
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: config.keyId }).setIssuer(config.teamId).setIssuedAt(seconds).sign(signingKey);
  tokenCache.clear(); // A process serves one dedicated app; keep secret-derived cache bounded.
  tokenCache.set(key, { token, issuedAt: seconds });
  return token;
}

export function classifyApnsResult(result, attempt = 1) {
  if (result.accepted && result.status === 200) return { state: 'accepted', reason: null, retrySeconds: null, disable: false };
  const reason = knownReasons.has(result.reason) ? result.reason : 'provider_error';
  if (result.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason)) {
    return { state: 'failed', reason, retrySeconds: null, disable: true };
  }
  const retryable = result.status === 0 || result.status === 429 || result.status >= 500;
  if (!retryable || attempt >= 6) return { state: 'failed', reason, retrySeconds: null, disable: false };
  // Apple currently requests a 15-minute delay before retrying 5xx responses.
  const floor = result.status >= 500 ? 900 : 60;
  const retrySeconds = Math.min(3600, Math.max(floor * 2 ** Math.max(0, attempt - 1), Number(result.retryAfter) || 0));
  return { state: 'pending', reason, retrySeconds, disable: false };
}

export async function sendApns({ token, environment, notificationId, expiresAt, payload }, env = process.env) {
  const config = apnsConfiguration(env);
  requireValue(Object.hasOwn(APNS_HOSTS, environment) && typeof token === 'string' && /^[0-9a-f]{64,400}$/i.test(token) && token.length % 2 === 0,
    422, 'invalid_push_device', 'This push installation is invalid.');
  const encoded = JSON.stringify(payload);
  requireValue(Buffer.byteLength(encoded) <= 4096, 422, 'invalid_push_payload', 'This notification is too large.');
  const jwt = await providerToken(env);
  // No caller can override the host, topic, TLS validation, path, or authorization.
  return new Promise(resolve => {
    let finished = false;
    let client;
    let stream;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stream?.close();
      client?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ accepted: false, status: 0, reason: 'timeout' }), 6000);
    try {
      client = connect(APNS_HOSTS[environment], { rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      client.on('error', () => finish({ accepted: false, status: 0, reason: 'transport_error' }));
      client.on('goaway', () => finish({ accepted: false, status: 0, reason: 'transport_error' }));
      stream = client.request({ ':method': 'POST', ':path': `/3/device/${token.toLowerCase()}`, authorization: `bearer ${jwt}`,
        'apns-topic': config.topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-id': notificationId,
        'apns-collapse-id': notificationId, 'apns-expiration': String(Math.floor(new Date(expiresAt).getTime() / 1000)), 'content-type': 'application/json' });
      let headers = {};
      let body = '';
      stream.on('response', value => { headers = value; });
      stream.on('data', chunk => {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 8192) finish({ accepted: false, status: 0, reason: 'provider_error' });
      });
      stream.on('error', () => finish({ accepted: false, status: 0, reason: 'transport_error' }));
      stream.on('end', () => {
        const status = Number(headers[':status']) || 0;
        let reason;
        try { reason = JSON.parse(body || '{}').reason; } catch { /* Never expose provider response bodies. */ }
        finish({ accepted: status === 200, status, reason: knownReasons.has(reason) ? reason : 'provider_error',
          retryAfter: /^\d+$/.test(String(headers['retry-after'] || '')) ? Math.min(3600, Number(headers['retry-after'])) : undefined });
      });
      stream.end(encoded);
    } catch { finish({ accepted: false, status: 0, reason: 'transport_error' }); }
  });
}
