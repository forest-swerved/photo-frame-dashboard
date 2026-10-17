import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { APNS_HOSTS, apnsConfiguration, classifyApnsResult, providerToken, sendApns } from './apns.js';
import { choreOccurrences, frameIsOffline, lockScreenPayload, notificationText, occurrenceInstant, preferencesDto, quietUntil, registerPush, validatePreferences } from './notifications.js';

test('deadline occurrences follow household weekdays, cross-midnight lead times, and DST', () => {
  const chore = { due_time: '00:05:00', reminder_minutes: 15, weekdays: [0], created_at: '2026-01-01T00:00:00Z' };
  const beforeMidnight = choreOccurrences(chore, 'America/Denver', new Date('2026-10-18T05:49:00Z'), new Date('2026-10-18T05:51:00Z'));
  assert.deepEqual(beforeMidnight.map(event => [event.type, event.date, event.at.toISOString()]), [['chore_due_soon', '2026-10-18', '2026-10-18T05:50:00.000Z']]);
  assert.equal(occurrenceInstant('2026-03-08', '02:30', 'America/Denver').toISOString(), '2026-03-08T09:30:00.000Z', 'A nonexistent spring-forward time moves forward through the gap.');
  assert.equal(occurrenceInstant('2026-11-01', '01:30', 'America/Denver').toISOString(), '2026-11-01T07:30:00.000Z', 'A repeated fall-back time selects its first occurrence once.');
  const afterDue = choreOccurrences({ ...chore, due_time: '01:30', reminder_minutes: 0 }, 'America/Denver', new Date('2026-11-01T07:29Z'), new Date('2026-11-01T08:31Z'));
  assert.deepEqual(afterDue.map(event => event.type), ['chore_overdue']);
  assert.deepEqual(choreOccurrences({ ...chore, weekdays: [1] }, 'America/Denver', new Date('2026-10-18T05:49Z'), new Date('2026-10-18T06:06Z')), []);
  assert.deepEqual(choreOccurrences({ ...chore, created_at: '2026-10-18T07:00Z' }, 'America/Denver', new Date('2026-10-18T05:49Z'), new Date('2026-10-18T06:06Z')), [], 'Creating an already-due chore cannot generate historical reminders.');
});

test('quiet hours preserve inbox and calculate the next household-local end across midnight and DST', () => {
  assert.equal(quietUntil(new Date('2026-10-18T04:00Z'), 'America/Denver', '21:00', '07:00').toISOString(), '2026-10-18T13:00:00.000Z');
  assert.equal(quietUntil(new Date('2026-10-18T15:00Z'), 'America/Denver', '21:00', '07:00'), null);
  assert.equal(quietUntil(new Date('2026-03-08T07:30Z'), 'America/Denver', '21:00', '02:30').toISOString(), '2026-03-08T09:30:00.000Z');
  assert.equal(quietUntil(new Date('2026-11-01T06:30Z'), 'America/Denver', '21:00', '01:30').toISOString(), '2026-11-01T07:30:00.000Z');
  assert.equal(quietUntil(new Date('2026-11-01T08:10Z'), 'America/Denver', '21:00', '01:30').toISOString(), '2026-11-01T08:30:00.000Z');
  assert.equal(quietUntil(new Date('2026-10-18T16:30Z'), 'America/Denver', '09:00', '11:00').toISOString(), '2026-10-18T17:00:00.000Z');
});

test('frame heartbeat grace cannot flap within the five-minute heartbeat write interval', () => {
  const now = new Date('2026-10-17T18:00:00Z');
  assert.equal(frameIsOffline('2026-10-17T17:56:00Z', now), false);
  assert.equal(frameIsOffline('2026-10-17T17:45:00Z', now), false);
  assert.equal(frameIsOffline('2026-10-17T17:44:00Z', now), true);
  assert.equal(frameIsOffline(null, now), false);
});

test('notification preferences accept only explicit booleans and paired valid quiet-hour times', () => {
  const defaults = preferencesDto(null, 'America/Denver');
  assert.equal(defaults.pushEnabled, true);
  assert.equal(defaults.quietStart, null);
  assert.equal(validatePreferences({ choreCompleted: false, quietStart: '21:00', quietEnd: '07:00' }, defaults).choreCompleted, false);
  for (const body of [{ choreCompleted: 'false' }, { quietStart: '25:00', quietEnd: '07:00' }, { quietStart: '21:00' },
    { quietStart: '21:00', quietEnd: '21:00' }, { timezone: 'UTC' }, { householdId: 'other-family' }]) {
    assert.throws(() => validatePreferences(body, defaults), error => error.status === 422);
  }
});

test('APNs never includes family/private event details in a lock-screen payload', () => {
  const payload = lockScreenPayload('fixture-notification-id');
  assert.deepEqual(Object.keys(payload).sort(), ['aps', 'notificationId']);
  assert.equal(payload.aps.alert.title, 'Family Frame');
  assert.equal(JSON.stringify(payload).includes('choreId'), false);
  assert.deepEqual(notificationText({ type: 'chore_completed', payload: { title: 'Private chore title' } }), ['Chore completed', 'Private chore title was marked done.']);
});

test('APNs distinguishes provider acceptance from retries, invalid tokens, and exhausted attempts', () => {
  assert.deepEqual(classifyApnsResult({ accepted: true, status: 200 }), { state: 'accepted', reason: null, retrySeconds: null, disable: false });
  assert.equal(classifyApnsResult({ status: 410, reason: 'Unregistered' }).disable, true);
  assert.equal(classifyApnsResult({ status: 400, reason: 'BadDeviceToken' }).disable, true);
  assert.equal(classifyApnsResult({ status: 429, reason: 'TooManyRequests' }).retrySeconds, 60);
  assert.equal(classifyApnsResult({ status: 500, reason: 'InternalServerError' }).retrySeconds, 900);
  assert.equal(classifyApnsResult({ status: 503 }, 4).retrySeconds, 3600);
  assert.equal(classifyApnsResult({ status: 500 }, 6).state, 'failed');
  assert.equal(classifyApnsResult({ status: 403, reason: 'Forbidden' }).state, 'failed');
  assert.equal(classifyApnsResult({ status: 400, reason: 'private upstream body' }).reason, 'provider_error');
});

test('APNs JWT is ES256, correctly scoped, cached, and refreshed inside Apple token lifetime', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const env = { FAMILY_APNS_TEAM_ID: 'ABCDEFGHIJ', FAMILY_APNS_KEY_ID: 'KLMNOPQRST', FAMILY_APNS_TOPIC: 'com.example.family-frame', FAMILY_APNS_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const start = new Date('2026-10-17T12:00:00Z');
  const token = await providerToken(env, start);
  const verified = await jwtVerify(token, publicKey, { algorithms: ['ES256'], issuer: env.FAMILY_APNS_TEAM_ID });
  assert.equal(verified.protectedHeader.kid, env.FAMILY_APNS_KEY_ID);
  assert.equal(verified.payload.iat, start.getTime() / 1000);
  assert.equal(await providerToken(env, new Date(start.getTime() + 20 * 60_000)), token);
  assert.notEqual(await providerToken(env, new Date(start.getTime() + 51 * 60_000)), token);
  assert.deepEqual(Object.values(APNS_HOSTS), ['https://api.sandbox.push.apple.com', 'https://api.push.apple.com']);
  assert.throws(() => apnsConfiguration({}), error => error.code === 'push_not_configured');
  await assert.rejects(sendApns({ token: 'a'.repeat(64), environment: 'https://attacker.example', payload: {} }, env), error => error.status === 422);
  await assert.rejects(providerToken({ ...env, FAMILY_APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ninvalid' }), error => error.code === 'push_not_configured');
});

test('push registration refuses non-mobile principals and validates client inputs before any DB access', async () => {
  const db = { query() { assert.fail('Validation must run before database access.'); } };
  await assert.rejects(registerPush(db, { authType: 'user' }, {}), error => error.status === 403);
  const mobile = { authType: 'mobile', mobileSessionId: '00000000-0000-4000-8000-000000000001', household: { id: '00000000-0000-4000-8000-000000000002' } };
  await assert.rejects(registerPush(db, mobile, { installationId: 'invalid', token: 'a'.repeat(64), environment: 'sandbox' }), error => error.status === 422);
  await assert.rejects(registerPush(db, mobile, { installationId: '00000000-0000-4000-8000-000000000003', token: 'private invalid token', environment: 'sandbox' }), error => error.status === 422);
});
