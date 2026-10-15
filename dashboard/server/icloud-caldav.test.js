import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIcloudReadFetch, validateIcloudUrl, listIcloudCalendars, syncIcloudCalendar,
} from './icloud-caldav.js';

const credentials = { username: 'fixture@example.test', appPassword: 'fixture-not-a-real-password' };
const xml = (body) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">${body}</d:multistatus>`, {
  status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' },
});
const property = (href, props, status = '200 OK') => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat></d:response>`;
const fixtureIcs = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:fixture-uid',
  'DTSTART;TZID=America/Denver:20261101T090000', 'DURATION:PT1H', 'SUMMARY:Family breakfast',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

function davFixture({ forbiddenObject = false, deniedObject = false, data = fixtureIcs } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.get('authorization'), `Basic ${Buffer.from(`${credentials.username}:${credentials.appPassword}`).toString('base64')}`);
    assert.ok(['PROPFIND', 'REPORT', 'GET'].includes(options.method));
    if (parsed.pathname === '/.well-known/caldav') return new Response(null, { status: 301, headers: { location: 'https://p01-caldav.icloud.com/' } });
    const body = String(options.body ?? '');
    if (body.includes('current-user-principal')) return xml(property('/', '<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>'));
    if (body.includes('calendar-home-set')) return xml(property('/123/principal/', '<c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set>'));
    if (parsed.pathname === '/123/calendars/') return xml(property('/123/calendars/family/', [
      '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>',
      '<d:displayname>Family</d:displayname><a:calendar-color>#AABBCCFF</a:calendar-color>',
      '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
    ].join('')));
    if (body.includes('supported-report-set')) return xml(property('/123/calendars/family/', '<d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report></d:supported-report-set>'));
    const href = forbiddenObject ? 'https://evil.example/steal' : '/123/calendars/family/extensionless-object';
    if (body.includes('calendar-query')) return xml(property(href, '<d:getetag>"fixture-1"</d:getetag>'));
    if (body.includes('calendar-multiget')) return xml(property(href, `<d:getetag>"fixture-1"</d:getetag><c:calendar-data><![CDATA[${data}]]></c:calendar-data>`, deniedObject ? '403 Forbidden' : '200 OK'));
    assert.fail(`Unexpected fixture DAV operation: ${options.method} ${parsed.pathname}`);
  };
  return { fetchImpl, calls };
}

test('host allowlist rejects credential exfiltration and SSRF URL variants before fetch', async () => {
  const bad = [
    'http://caldav.icloud.com/', 'https://caldav.icloud.com.evil.example/',
    'https://evilicloud.com/', 'https://icloud.com/', 'https://contacts.icloud.com/',
    'https://127.0.0.1/', 'https://[::1]/', 'https://user:pass@caldav.icloud.com/',
    'https://caldav.icloud.com:444/', 'https://caldav.icloud.com/?target=secret',
    'https://caldav.icloud.com/#secret', 'https://p0011-caldav.icloud.com/',
  ];
  let calls = 0;
  const transport = createIcloudReadFetch({ ...credentials, fetchImpl: async () => { calls++; return new Response('ok'); } });
  for (const url of bad) await assert.rejects(transport(url), { code: 'CALENDAR_UNSAFE_URL' });
  assert.equal(calls, 0);
  assert.equal(validateIcloudUrl('https://p123-caldav.icloud.com/').hostname, 'p123-caldav.icloud.com');
});

test('write methods never reach the provider', async () => {
  let calls = 0;
  const transport = createIcloudReadFetch({ ...credentials, fetchImpl: async () => { calls++; return new Response('ok'); } });
  for (const method of ['PUT', 'DELETE', 'POST', 'MKCALENDAR', 'PROPPATCH', 'MOVE']) {
    await assert.rejects(transport('https://caldav.icloud.com/', { method }), { code: 'CALENDAR_READ_ONLY' });
  }
  assert.equal(calls, 0);
});

test('redirects validate each destination before auth and preserve a DAV method', async () => {
  const calls = [];
  const transport = createIcloudReadFetch({ ...credentials, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, auth: options.headers.get('authorization') });
    if (calls.length === 1) return new Response(null, { status: 307, headers: { location: 'https://p01-caldav.icloud.com/next/' } });
    return new Response('<ok/>', { headers: { 'content-type': 'application/xml' } });
  } });
  const result = await transport('https://caldav.icloud.com/', { method: 'PROPFIND', body: '<propfind/>' });
  assert.equal(result.url, 'https://p01-caldav.icloud.com/next/');
  assert.deepEqual(calls.map(({ method }) => method), ['PROPFIND', 'PROPFIND']);
  assert.ok(calls.every(({ auth }) => auth?.startsWith('Basic ')));
  let count = 0;
  const unsafe = createIcloudReadFetch({ ...credentials, fetchImpl: async () => {
    count++;
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
  } });
  await assert.rejects(unsafe('https://caldav.icloud.com/', { method: 'REPORT' }), { code: 'CALENDAR_UNSAFE_URL' });
  assert.equal(count, 1);
});

test('manual discovery redirects are validated without being followed and loops are bounded', async () => {
  let count = 0;
  const transport = createIcloudReadFetch({ ...credentials, fetchImpl: async () => {
    count++;
    return new Response(null, { status: 301, headers: { location: '/other/' } });
  } });
  const response = await transport('https://caldav.icloud.com/.well-known/caldav', { method: 'PROPFIND', redirect: 'manual' });
  assert.equal(response.headers.get('location'), 'https://caldav.icloud.com/other/');
  assert.equal(count, 1);
  await assert.rejects(transport('https://caldav.icloud.com/', { method: 'PROPFIND' }), { code: 'CALENDAR_UNSAFE_URL' });
  assert.equal(count, 5);
});

test('provider/auth/size/XML failures are sanitized', async () => {
  const cases = [
    [new Response('secret provider response', { status: 401 }), 'CALENDAR_AUTH_FAILED'],
    [new Response('secret provider response', { status: 500 }), 'CALENDAR_PROVIDER_ERROR'],
    [new Response('<!DOCTYPE root [<!ENTITY x "secret">]><root/>'), 'CALENDAR_PROVIDER_ERROR'],
    [new Response('x'.repeat(4 * 1024 * 1024 + 1)), 'CALENDAR_RESPONSE_LIMIT'],
  ];
  for (const [response, code] of cases) {
    const transport = createIcloudReadFetch({ ...credentials, fetchImpl: async () => response });
    await assert.rejects(transport('https://caldav.icloud.com/'), (error) => error.code === code && !error.message.includes('secret'));
  }
});

test('aborted requests return a sanitized timeout rather than transport details', async () => {
  const controller = new AbortController();
  controller.abort(new Error('private transport detail'));
  const transport = createIcloudReadFetch({ ...credentials, fetchImpl: async (_url, options) => {
    options.signal.throwIfAborted();
  } });
  await assert.rejects(transport('https://caldav.icloud.com/', { signal: controller.signal }),
    (error) => error.code === 'CALENDAR_TIMEOUT' && !error.message.includes('private'));
});

test('discovery returns minimal stable calendar IDs with no credentials or DAV URLs', async () => {
  const fixture = davFixture();
  const calendars = await listIcloudCalendars({ ...credentials, fetchImpl: fixture.fetchImpl });
  assert.equal(calendars.length, 1);
  assert.deepEqual(Object.keys(calendars[0]).sort(), ['color', 'id', 'name']);
  assert.equal(calendars[0].name, 'Family');
  assert.equal(calendars[0].color, '#AABBCC');
  assert.match(calendars[0].id, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(calendars).includes('icloud.com'));
  assert.ok(!JSON.stringify(calendars).includes(credentials.username));
  assert.ok(!JSON.stringify(calendars).includes(credentials.appPassword));
});

test('full mocked discovery/REPORT sync handles extensionless resources and complete coverage', async () => {
  const fixture = davFixture();
  const [calendar] = await listIcloudCalendars({ ...credentials, fetchImpl: fixture.fetchImpl });
  const result = await syncIcloudCalendar({
    ...credentials, fetchImpl: fixture.fetchImpl, calendarIds: [calendar.id],
    startDate: '2026-11-01', endDateExclusive: '2026-11-08', timeZone: 'America/Denver', now: '2026-10-30T12:00:00Z',
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].title, 'Family breakfast');
  assert.equal(result.events[0].startAt, '2026-11-01T16:00:00.000Z');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.truncated, false);
  assert.equal(result.lastSuccessfulSyncAt, '2026-10-30T12:00:00.000Z');
  assert.ok(fixture.calls.some(({ options }) => options.method === 'REPORT'));
  assert.ok(fixture.calls.every(({ options }) => ['PROPFIND', 'REPORT', 'GET'].includes(options.method)));
});

test('selected missing calendars, hostile object URLs, and partial multistatus never look ready', async () => {
  const initial = davFixture();
  const [calendar] = await listIcloudCalendars({ ...credentials, fetchImpl: initial.fetchImpl });
  const options = { ...credentials, calendarIds: [calendar.id], startDate: '2026-11-01', endDateExclusive: '2026-11-08', timeZone: 'America/Denver' };
  for (const [fixture, code] of [
    [davFixture({ forbiddenObject: true }), 'CALENDAR_UNSAFE_URL'],
    [davFixture({ deniedObject: true }), 'CALENDAR_PROVIDER_ERROR'],
  ]) {
    await assert.rejects(syncIcloudCalendar({ ...options, fetchImpl: fixture.fetchImpl }), (error) => error.code === code && error.coverage.complete === false);
    assert.ok(fixture.calls.every(({ url }) => !url.includes('evil.example')));
  }
  await assert.rejects(syncIcloudCalendar({ ...options, calendarIds: ['a'.repeat(64)], fetchImpl: initial.fetchImpl }), { code: 'CALENDAR_NOT_FOUND' });
});
