import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { APNS_HOSTS, apnsConfiguration, classifyApnsResult, preflightApns, providerToken, sendApns } from './apns.js';
import { choreOccurrences, dailyTaskReminderSlots, dailyOccurrenceReminders, frameIsOffline, lockScreenPayload, notificationText, occurrenceInstant, preferencesDto, processNotifications, quietUntil, registerPush, validatePreferences } from './notifications.js';
import { handleRequest } from './app.js';

function signingKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}
function scopedApnsFixture() {
  const sandbox = signingKey(), production = signingKey();
  return { sandbox, production, env: { FAMILY_APNS_TEAM_ID: 'ABCDEFGHIJ', FAMILY_APNS_TOPIC: 'com.example.family-frame',
    FAMILY_APNS_SANDBOX_KEY_ID: 'SANDBOX001', FAMILY_APNS_SANDBOX_PRIVATE_KEY: sandbox.pem,
    FAMILY_APNS_PRODUCTION_KEY_ID: 'PRODKEY001', FAMILY_APNS_PRODUCTION_PRIVATE_KEY: production.pem } };
}

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

test('immutable daily reminders clamp cross-midnight lead times and ignore skipped/submitted work', () => {
  const occurrence = { status: 'pending', date: '2026-10-18', due_time: '00:05:00', reminder_minutes: 15, created_at: '2026-10-18T06:00Z' };
  assert.deepEqual(dailyOccurrenceReminders(occurrence, 'America/Denver', new Date('2026-10-18T05:49Z'), new Date('2026-10-18T05:51Z')), []);
  const midnight = dailyOccurrenceReminders(occurrence, 'America/Denver', new Date('2026-10-18T05:59Z'), new Date('2026-10-18T06:01Z'));
  assert.deepEqual(midnight.map(item => [item.type, item.at.toISOString()]), [['chore_due_soon', '2026-10-18T06:00:00.000Z']]);
  for (const status of ['submitted', 'completed', 'skipped']) assert.deepEqual(dailyOccurrenceReminders({ ...occurrence, status }, 'America/Denver', new Date('2026-10-18T06:00Z'), new Date('2026-10-18T06:10Z')), []);
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

test('private APNs mode includes only an opaque notification ID', () => {
  const payload = lockScreenPayload('fixture-notification-id');
  assert.deepEqual(Object.keys(payload).sort(), ['aps', 'notificationId']);
  assert.equal(payload.aps.alert.title, 'Family Frame');
  assert.equal(JSON.stringify(payload).includes('choreId'), false);
  assert.deepEqual(notificationText({ type: 'chore_completed', payload: { title: 'Private chore title' } }), ['Your child finished a task', "Private chore title · Marked done. Open Tasks to see today's progress."]);
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
  await assert.rejects(sendApns({token:'a'.repeat(64),environment:'production',pushType:'background',payload:{aps:{'content-available':1,sound:'default'}}},env),error=>error.code==='invalid_push_payload');
  await assert.rejects(providerToken({ ...env, FAMILY_APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ninvalid' }), error => error.code === 'push_not_configured');
});

test('topic-specific APNs environments select their own signing key and retain both cached JWTs', async () => {
  const { env, sandbox, production } = scopedApnsFixture();
  const now = new Date('2026-10-17T12:00:00Z');
  const tokens = {};
  for (const [environment, key] of Object.entries({ sandbox, production })) {
    const config = apnsConfiguration(env, environment);
    assert.equal(config.keyId, env[`FAMILY_APNS_${environment.toUpperCase()}_KEY_ID`]);
    assert.equal(config.privateKey, key.pem);
    tokens[environment] = await providerToken(env, now, environment);
    const verified = await jwtVerify(tokens[environment], key.publicKey, { algorithms: ['ES256'], issuer: env.FAMILY_APNS_TEAM_ID });
    assert.equal(verified.protectedHeader.kid, config.keyId);
    assert.equal(verified.payload.iat, now.getTime() / 1000);
  }
  const later = new Date(now.getTime() + 20 * 60_000);
  await preflightApns(env, later);
  // ES256 creates a new signature when signing again, so equality verifies that
  // alternating environments and readiness checks actually reuse both tokens.
  for (const environment of ['sandbox', 'production', 'sandbox', 'production']) {
    assert.equal(await providerToken(env, later, environment), tokens[environment]);
  }
  const replacement = signingKey();
  const rotated = { ...env, FAMILY_APNS_SANDBOX_KEY_ID: 'SANDBOX002', FAMILY_APNS_SANDBOX_PRIVATE_KEY: replacement.pem };
  const rotatedToken = await providerToken(rotated, later, 'sandbox');
  assert.notEqual(rotatedToken, tokens.sandbox);
  assert.equal((await jwtVerify(rotatedToken, replacement.publicKey)).protectedHeader.kid, 'SANDBOX002');
  assert.equal(await providerToken(rotated, later, 'production'), tokens.production, 'Rotating one environment must not evict the other environment.');
});

test('APNs scoped credentials never mix partial pairs or fall back to the other environment', async () => {
  const { env, production } = scopedApnsFixture();
  const legacy = { FAMILY_APNS_TEAM_ID: env.FAMILY_APNS_TEAM_ID, FAMILY_APNS_TOPIC: env.FAMILY_APNS_TOPIC,
    FAMILY_APNS_KEY_ID: 'LEGACY0001', FAMILY_APNS_PRIVATE_KEY: production.pem };
  assert.equal(apnsConfiguration(legacy, 'sandbox').keyId, 'LEGACY0001');
  assert.equal(apnsConfiguration(legacy, 'production').keyId, 'LEGACY0001');
  await preflightApns(legacy);
  assert.equal((await jwtVerify(await providerToken(legacy, new Date(), 'sandbox'), production.publicKey)).protectedHeader.kid, 'LEGACY0001');
  assert.equal(apnsConfiguration({ ...legacy, ...env }, 'sandbox').keyId, 'SANDBOX001');
  assert.equal(apnsConfiguration({ ...legacy, ...env }, 'production').keyId, 'PRODKEY001');
  assert.equal(apnsConfiguration({ ...legacy, FAMILY_APNS_SANDBOX_KEY_ID: '', FAMILY_APNS_SANDBOX_PRIVATE_KEY: '' }, 'sandbox').keyId, 'LEGACY0001');
  for (const environment of ['sandbox', 'production']) {
    const prefix = `FAMILY_APNS_${environment.toUpperCase()}`;
    for (const partial of [{ [`${prefix}_KEY_ID`]: env[`${prefix}_KEY_ID`] }, { [`${prefix}_PRIVATE_KEY`]: env[`${prefix}_PRIVATE_KEY`] }]) {
      assert.throws(() => apnsConfiguration({ ...legacy, ...partial }, environment), error => error.code === 'push_not_configured');
    }
  }
  const onlySandbox = { ...env, FAMILY_APNS_PRODUCTION_KEY_ID: undefined, FAMILY_APNS_PRODUCTION_PRIVATE_KEY: undefined };
  assert.equal(apnsConfiguration(onlySandbox, 'sandbox').keyId, 'SANDBOX001');
  assert.throws(() => apnsConfiguration(onlySandbox, 'production'), error => error.code === 'push_not_configured');
  await assert.rejects(preflightApns(onlySandbox), error => error.code === 'push_not_configured');
});

test('notification readiness validates both real signing keys and stops before leasing with incomplete APNs setup', async () => {
  const { env } = scopedApnsFixture();
  let leases = 0;
  const client = { release() {}, async query(sql) {
    if (sql.includes('SELECT id FROM family_notification_deliveries')) leases++;
    return { rows: [] };
  } };
  const db = { connect: async () => client, query: async () => ({ rows: [] }) };
  for (const invalid of [
    { ...env, FAMILY_APNS_SANDBOX_KEY_ID: undefined, FAMILY_APNS_SANDBOX_PRIVATE_KEY: undefined },
    { ...env, FAMILY_APNS_PRODUCTION_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ninvalid' },
  ]) {
    const result = await processNotifications(db, { env: invalid });
    assert.equal(result.pushConfigured, false);
    assert.equal(leases, 0);
    const status = await handleRequest(new Request('https://family.example/api/mobile/status'), {
      db, env: invalid, authenticate: async () => ({ authType: 'mobile', household: { id: 'fixture' } }),
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).data.pushConfigured, false);
  }
  const result = await processNotifications(db, { env });
  assert.equal(result.pushConfigured, true);
  assert.equal(leases, 1);
  const status = await handleRequest(new Request('https://family.example/api/mobile/status'), {
    db, env, authenticate: async () => ({ authType: 'mobile', household: { id: 'fixture' } }),
  });
  assert.equal((await status.json()).data.pushConfigured, true);
});

test('push registration refuses non-mobile principals and validates client inputs before any DB access', async () => {
  const db = { query() { assert.fail('Validation must run before database access.'); } };
  await assert.rejects(registerPush(db, { authType: 'user' }, {}), error => error.status === 403);
  const mobile = { authType: 'mobile', mobileSessionId: '00000000-0000-4000-8000-000000000001', household: { id: '00000000-0000-4000-8000-000000000002' } };
  await assert.rejects(registerPush(db, mobile, { installationId: 'invalid', token: 'a'.repeat(64), environment: 'sandbox' }), error => error.status === 422);
  await assert.rejects(registerPush(db, mobile, { installationId: '00000000-0000-4000-8000-000000000003', token: 'private invalid token', environment: 'sandbox' }), error => error.status === 422);
});

test('daily task reminder slots follow school classification, local timezone and bounded catch-up', () => {
  const slots = (date, type, from, to) => dailyTaskReminderSlots(date, type, 'America/Denver', new Date(from), new Date(to)).map(s => s.time);
  assert.deepEqual(slots('2026-10-26','school_day','2026-10-26T12:59Z','2026-10-26T13:00Z'), ['07:00']);
  assert.deepEqual(slots('2026-10-26','school_day','2026-10-26T21:59Z','2026-10-26T22:00Z'), ['16:00']);
  assert.deepEqual(slots('2026-10-26','school_day','2026-10-26T13:00Z','2026-10-26T13:01Z'), []);
  assert.deepEqual(slots('2026-10-25','non_school_day','2026-10-25T16:59Z','2026-10-25T17:00Z'), ['11:00']);
  assert.deepEqual(slots('2026-10-25','non_school_day','2026-10-25T12:59Z','2026-10-25T13:00Z'), []);
  assert.deepEqual(slots('2026-10-26','unknown','2026-10-26T12:59Z','2026-10-26T13:00Z'), []);
  assert.deepEqual(slots('2026-10-26','school_day','2026-10-26T12:59Z','2026-10-26T20:00Z'), []);
  assert.deepEqual(slots('2026-11-02','school_day','2026-11-02T13:59Z','2026-11-02T14:00Z'), ['07:00'], 'After DST, the local time stays 7 AM.');
});

test('detailed push alerts identify the family action while navigation uses an opaque ID', () => {
  const event = { type: 'access_granted', payload: { actorName: 'Forest', personName: 'Andre', deviceName: 'PS5', minutes: 60 } };
  const detailed = lockScreenPayload('opaque-id', event);
  assert.equal(detailed.aps.alert.body, 'Forest granted Andre 1 hour access to PS5. Network confirmation is pending.');
  assert.equal(detailed.notificationId, 'opaque-id');
  assert.deepEqual(Object.keys(detailed).sort(), ['aps','artwork','notificationId']);
  assert.match(notificationText({ type: 'chore_completed', payload: { personName: 'Andre', title: 'Dishes' } })[1], /Dishes.*Marked done/);
  assert.match(notificationText({ type: 'session_started', payload: { personName: 'Andre', deviceName: 'PS5', source: 'reward' } })[1], /PS5.*earned/);
  assert.match(notificationText({ type: 'access_requested', payload: { personName: 'Andre', deviceName: 'PS5', minutes: 45, reason: 'Play with friends' } })[1], /PS5.*45 minutes.*Play with friends/);
  for (const key of ['showDetails','taskReminders','dailyCompleted','accessRequests']) {
    assert.equal(preferencesDto(null, 'America/Denver')[key], true);
    assert.equal(validatePreferences({ [key]: false }, preferencesDto(null, 'America/Denver'))[key], false);
  }
});
