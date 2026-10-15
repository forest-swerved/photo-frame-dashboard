import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError, requireValue } from './errors.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

export function matchesDigest(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  return timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(expected, 'hex'));
}

function encryptionKey(env) {
  const value = env.FAMILY_ENCRYPTION_KEY;
  requireValue(typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 503, 'configuration_missing', 'Calendar storage is not configured.');
  const key = Buffer.from(value, 'base64');
  requireValue(key.length === 32, 503, 'configuration_missing', 'Calendar storage is not configured.');
  return key;
}

const additionalData = householdId => Buffer.from(`family-calendar:icloud:${householdId}:v1`);
export const keyedDigest = (purpose, value, env = process.env) => createHmac('sha256', encryptionKey(env)).update(`${purpose}:${value}`).digest('hex');

export function encryptCredentials(householdId, value, env = process.env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  cipher.setAAD(additionalData(householdId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { v: 1, kid: 'family-v1', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function decryptCredentials(householdId, envelope, env = process.env) {
  try {
    if (envelope?.v !== 1 || envelope.kid !== 'family-v1') throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(additionalData(householdId));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw new ApiError(503, 'calendar_credentials_unavailable', 'Reconnect the calendar in Setup.');
  }
}
