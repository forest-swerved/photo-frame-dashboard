import { randomUUID } from 'node:crypto';
import { ApiError, json, readJson, requireValue, textField, timezoneField, uuidField, versionField } from './errors.js';
import { sharedPool, one, transaction } from './database.js';
import { authenticate, assertSameOrigin, cookieValue, FRAME_COOKIE, requireAdmin, requireHousehold } from './auth.js';
import { authGateway, confirmedAccountEmail, createAuthContext } from './supabase-auth.js';
import { digest } from './credentials.js';
import { enforcePairRateLimit } from './pair-rate-limit.js';
import { claimHousehold, createChore, createChoreBatch, createFramePair, createInvite, createPerson, changeChore, changePerson, householdSnapshot, joinHousehold, redeemFramePair, revokeHouseholdMember, sessionData, setCompletion } from './household.js';
import { calendarConnection, calendarSnapshot, connectCalendar, removeCalendar, selectCalendars, processCalendarSyncJobs } from './calendar-service.js';
import { createMobileSession, createMobilePair, redeemMobilePair, mobileSessionData, mobileDevices, revokeMobile } from './mobile.js';
import { registerPush, sendTestNotification, notificationPreferences, notificationInbox, markNotificationRead, markAllNotificationsRead, processNotifications } from './notifications.js';
import { preflightApns } from './apns.js';
import { setOccurrenceCompletion, changeChoreOccurrence, choreHistory, choreExceptions, createChoreException, revokeChoreException } from './chore-occurrences.js';
import { parentCapabilities, changeMemberCapabilities, createFrameAccessCode, redeemFrameAccess, frameAuthorization, transferOwnership } from './capabilities.js';
import { deleteAccount } from './account-deletion.js';
import { internetSnapshot, saveRewardPolicy, saveManagedDevice, changeDeviceAccess, startInternetSession, changeInternetSession, internetHistory, syncChoreReward, resolveRewardReview, requestDeviceAccess, decideDeviceAccess } from './internet.js';
import { processInternetJobs } from './internet-worker.js';
import { drainInternetQueue, startsInternetWork } from './internet-queue.js';
import { liveStatus } from './live-status.js';
import { saveSchoolCalendar, schoolCalendarSnapshot } from './school-calendar.js';

export function apiPath(request) {
  const url = new URL(request.url);
  const route = url.pathname === '/api/index' || url.pathname === '/api/index.js' ? url.searchParams.get('__route') : url.pathname.replace(/^\/api\/?/, '');
  requireValue(typeof route === 'string' && route.length <= 180 && !route.includes('..') && !/[\\%\x00]/.test(route), 404, 'not_found', 'That endpoint does not exist.');
  return route.replace(/^\/+|\/+$/g, '');
}

function deleteVersion(url) {
  const value = url.searchParams.get('expectedVersion');
  requireValue(value !== null && /^\d+$/.test(value), 422, 'invalid_version', 'Refresh this item before deleting it.');
  return versionField(Number(value));
}

async function deviceList(db, principal) {
  requireAdmin(principal);
  return { devices: (await db.query('SELECT id,label,created_at,last_seen_at,expires_at,revoked_at FROM family_devices WHERE household_id=$1 ORDER BY created_at DESC', [principal.household.id])).rows.map(row => ({ id: row.id, label: row.label, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, revokedAt: row.revoked_at })) };
}

export async function dispatch(request, db, principal, route, options = {}) {
  const method = request.method;
  const url = new URL(request.url);
  if (route === 'account/delete' && method === 'POST') {
    const result = await deleteAccount(db, principal, await readJson(request), options);
    options.authContext?.clearCookies();
    return json(result);
  }
  if (route === 'session' && method === 'GET') return json(await sessionData(db, principal));
  if (route === 'claim' && method === 'POST') return json(await claimHousehold(db, principal, await readJson(request), options.env));
  if (route === 'join' && method === 'POST') return json(await joinHousehold(db, principal, await readJson(request), { getVerifiedEmail: () => confirmedAccountEmail(request, principal, options) }));
  requireHousehold(principal);
  if (route === 'live-status' && method === 'GET') return json(await liveStatus(db, principal, options));
  if (route === 'account/transfer-ownership' && method === 'POST') return json(await transferOwnership(db, principal, await readJson(request)));
  if (principal.role === 'member' && /^(household|chores|chore-occurrences|chore-exceptions|chore-history|school-calendar)(\/|$)/.test(route)) principal = { ...principal, verifiedCapabilities: await parentCapabilities(db, principal) };
  options = { ...options, choreOptions: { ...options.choreOptions, onChange: options.choreOptions?.onChange || ((client, change) => syncChoreReward(client, change)) } };
  if (route === 'frame-access-codes' && method === 'POST') return json(await createFrameAccessCode(db, principal, await readJson(request), options), 201);
  if (route === 'frame-access/redeem' && method === 'POST') {
    await enforcePairRateLimit(db, request, options.env);
    return json(await redeemFrameAccess(db, principal, await readJson(request), options));
  }
  if (route === 'notifications' && method === 'GET') return json(await notificationInbox(db, principal));
  const notificationRead = /^notifications\/([^/]+)\/read$/.exec(route);
  if (notificationRead && method === 'POST') return json(await markNotificationRead(db, principal, notificationRead[1]));
  if (route === 'notification-preferences' && ['GET', 'PUT', 'PATCH'].includes(method)) return json(await notificationPreferences(db, principal, method === 'GET' ? undefined : await readJson(request)));
  if (route === 'internet' && method === 'GET') return json(await internetSnapshot(db, principal, options));
  if (route === 'internet/history' && method === 'GET') return json(await internetHistory(db, principal));
  const rewardReview = /^internet\/credits\/([^/]+)\/resolve$/.exec(route);
  if (rewardReview && method === 'POST') return json(await resolveRewardReview(db, principal, rewardReview[1], await readJson(request), options));
  if (route === 'internet/redeem' && method === 'POST') return json(await startInternetSession(db, principal, await readJson(request), { ...options, reward: true }), 202);
  if (route === 'internet/requests' && method === 'POST') return json(await requestDeviceAccess(db, principal, await readJson(request), options), 201);
  const accessDecision = /^internet\/requests\/([^/]+)\/decision$/.exec(route);
  if (accessDecision && method === 'POST') return json(await decideDeviceAccess(db, principal, accessDecision[1], await readJson(request), options), 202);
  if (route === 'internet/grants' && method === 'POST') return json(await startInternetSession(db, principal, await readJson(request), options), 202);
  const internetSession = /^internet\/sessions\/([^/]+)\/actions$/.exec(route);
  if (internetSession && method === 'POST') return json(await changeInternetSession(db, principal, internetSession[1], await readJson(request), options), 202);
  if (route === 'internet/devices' && method === 'POST') return json(await saveManagedDevice(db, principal, null, await readJson(request)), 201);
  const deviceAccess = /^internet\/devices\/([^/]+)\/access$/.exec(route);
  if (deviceAccess && method === 'POST') return json(await changeDeviceAccess(db, principal, deviceAccess[1], await readJson(request), options), 202);
  const managedDevice = /^internet\/devices\/([^/]+)$/.exec(route);
  if (managedDevice && ['PATCH', 'DELETE'].includes(method)) return json(await saveManagedDevice(db, principal, managedDevice[1], method === 'DELETE'
    ? { expectedVersion: deleteVersion(url), mutationId: url.searchParams.get('mutationId') || randomUUID() } : await readJson(request), method === 'DELETE'));
  const rewardPolicy = /^internet\/policies\/([^/]+)$/.exec(route);
  if (rewardPolicy && method === 'PUT') return json(await saveRewardPolicy(db, principal, rewardPolicy[1], await readJson(request)));
  if (route === 'mobile/sessions' && method === 'POST') return json(await createMobileSession(db, principal, await readJson(request)), 201);
  if (route === 'mobile/pairings' && method === 'POST') return json(await createMobilePair(db, principal, await readJson(request), options.env), 201);
  if (route === 'mobile/devices' && method === 'GET') return json(await mobileDevices(db, principal));
  const mobileDevice = /^mobile\/devices\/([^/]+)$/.exec(route);
  if (mobileDevice && method === 'DELETE') return json(await revokeMobile(db, principal, mobileDevice[1]));
  if (route.startsWith('mobile/')) {
    requireValue(principal.authType === 'mobile', 403, 'mobile_required', 'Use the Family Frame iOS app.');
    if (route === 'mobile/status' && method === 'GET') {
      let pushConfigured = false;
      try { await preflightApns(options.env || process.env); pushConfigured = true; }
      catch { /* Report missing provider setup without exposing configuration. */ }
      return json({ pushConfigured, schedulingConfigured: Boolean((options.env || process.env).CRON_SECRET), serverTime: new Date().toISOString() });
    }
    if (route === 'mobile/session' && method === 'GET') return json(mobileSessionData(principal));
    if (route === 'mobile/session' && method === 'DELETE') return json(await revokeMobile(db, principal, principal.mobileSessionId));
    if (route === 'mobile/push-installations' && method === 'POST') return json(await registerPush(db, principal, await readJson(request), options.env));
    if (route === 'mobile/notifications/test' && method === 'POST') return json(await sendTestNotification(db, principal, options.notificationOptions || { env: options.env }));
    if (route === 'mobile/notification-preferences' && ['GET', 'PUT', 'PATCH'].includes(method)) return json(await notificationPreferences(db, principal, method === 'GET' ? undefined : await readJson(request)));
    if (route === 'mobile/notifications' && method === 'GET') return json(await notificationInbox(db, principal));
    if (route === 'mobile/notifications/read-all' && method === 'POST') return json(await markAllNotificationsRead(db, principal));
    const readNotification = /^mobile\/notifications\/([^/]+)\/read$/.exec(route);
    if (readNotification && method === 'POST') return json(await markNotificationRead(db, principal, readNotification[1]));
  }
  if (route === 'household' && method === 'GET') return json(await householdSnapshot(db, principal, url.searchParams.get('date')));
  if (route === 'school-calendar' && method === 'GET') return json(await schoolCalendarSnapshot(db, principal, url.searchParams.get('date')));
  if (route === 'school-calendar' && ['PUT', 'PATCH'].includes(method)) return json(await saveSchoolCalendar(db, principal, await readJson(request), { ...options.choreOptions, override: method === 'PATCH' }));
  if (route === 'chore-history' && method === 'GET') return json(await choreHistory(db, principal, Object.fromEntries(url.searchParams)));
  if (route === 'chore-exceptions' && method === 'GET') return json(await choreExceptions(db, principal));
  if (route === 'chore-exceptions' && method === 'POST') return json(await createChoreException(db, principal, await readJson(request)), 201);
  const exception = /^chore-exceptions\/([^/]+)\/revoke$/.exec(route);
  if (exception && method === 'POST') return json(await revokeChoreException(db, principal, exception[1], await readJson(request)));
  const occurrenceCompletion = /^chore-occurrences\/([^/]+)\/completion$/.exec(route);
  if (occurrenceCompletion && method === 'PUT') return json(await setOccurrenceCompletion(db, principal, occurrenceCompletion[1], await readJson(request), options.choreOptions));
  const occurrenceAction = /^chore-occurrences\/([^/]+)\/actions$/.exec(route);
  if (occurrenceAction && method === 'POST') return json(await changeChoreOccurrence(db, principal, occurrenceAction[1], await readJson(request), options.choreOptions));
  if (route === 'invites' && method === 'POST') return json(await createInvite(db, principal, await readJson(request)), 201);
  if (route === 'child-invites' && method === 'POST') return json(await createInvite(db, principal, { ...await readJson(request), role: 'child' }), 201);
  if (route === 'frame-pairs' && method === 'POST') return json(await createFramePair(db, principal, await readJson(request), options.env), 201);
  if (route === 'devices' && method === 'GET') return json(await deviceList(db, principal));
  const device = /^devices\/([^/]+)$/.exec(route);
  if (device && method === 'DELETE') {
    requireAdmin(principal); uuidField(device[1]);
    const changed = await db.query('UPDATE family_devices SET revoked_at=now() WHERE id=$1 AND household_id=$2 RETURNING id', [device[1], principal.household.id]);
    requireValue(changed.rowCount > 0, 404, 'not_found', 'That frame does not exist in this household.');
    return json({ deleted: true });
  }
  if (route === 'members' && method === 'GET') {
    requireAdmin(principal);
    return json({ members: (await db.query('SELECT user_id,name,email,role,person_id,joined_at,manage_chores,manage_internet FROM family_members WHERE household_id=$1 AND revoked_at IS NULL ORDER BY joined_at', [principal.household.id])).rows.map(row => ({ id: row.user_id, name: row.name, email: row.email, role: row.role, personId: row.person_id || null, joinedAt: row.joined_at, capabilities: { manageChores: row.role === 'admin' || row.manage_chores, manageInternet: row.role === 'admin' || row.manage_internet } })) });
  }
  const memberCapabilities = /^members\/([^/]+)\/capabilities$/.exec(route);
  if (memberCapabilities && method === 'PATCH') return json(await changeMemberCapabilities(db, principal, memberCapabilities[1], await readJson(request)));
  const member = /^members\/([^/]+)$/.exec(route);
  if (member && method === 'DELETE') {
    return json(await revokeHouseholdMember(db, principal, member[1]));
  }
  if (route === 'people' && method === 'POST') return json(await createPerson(db, principal, await readJson(request)), 201);
  const person = /^people\/([^/]+)$/.exec(route);
  if (person && ['PATCH', 'DELETE'].includes(method)) {
    const body = method === 'DELETE' ? { expectedVersion: deleteVersion(url) } : await readJson(request);
    return json(await changePerson(db, principal, person[1], body, method === 'DELETE'));
  }
  if (route === 'chores' && method === 'POST') return json(await createChore(db, principal, await readJson(request)), 201);
  if (route === 'chores/batch' && method === 'POST') return json(await createChoreBatch(db, principal, await readJson(request)), 201);
  const chore = /^chores\/([^/]+)$/.exec(route);
  if (chore && ['PATCH', 'DELETE'].includes(method)) {
    const body = method === 'DELETE' ? { expectedVersion: deleteVersion(url) } : await readJson(request);
    return json(await changeChore(db, principal, chore[1], body, method === 'DELETE'));
  }
  const completion = /^chores\/([^/]+)\/completions\/([^/]+)$/.exec(route);
  if (completion && method === 'PUT') return json(await setCompletion(db, principal, completion[1], completion[2], await readJson(request), options.choreOptions));
  if (route === 'settings' && method === 'PATCH') {
    requireAdmin(principal);
    const body = await readJson(request);
    const title = body.title === undefined ? undefined : textField(body.title, 'Household title', 80);
    const timezone = body.timezone === undefined ? undefined : timezoneField(body.timezone);
    const changed = await transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`internet:${principal.household.id}`]);
      const current = await one(client, 'SELECT id,title,timezone FROM family_households WHERE id=$1 FOR UPDATE', [principal.household.id]);
      requireValue(current, 404, 'not_found', 'This household is no longer available.');
      if (timezone !== undefined && timezone !== current.timezone) {
        const enrolled = await one(client, `SELECT id FROM family_managed_devices WHERE household_id=$1 AND
          (management_policy_id IS NOT NULL OR deny_policy_id IS NOT NULL OR apple_push_policy_id IS NOT NULL OR control_state='ready') LIMIT 1`, [current.id]);
        const active = await one(client, "SELECT id FROM family_internet_sessions WHERE household_id=$1 AND state NOT IN ('ended','failed') LIMIT 1", [current.id]);
        requireValue(!enrolled && !active, 409, 'network_timezone_locked', 'End all Internet sessions and safely unenroll managed devices before changing the home timezone.');
        await client.query("UPDATE family_network_integrations SET state='pilot_required',pilot_checks='{}',management_verified_at=NULL,version=version+1 WHERE household_id=$1", [current.id]);
      }
      return one(client, 'UPDATE family_households SET title=$2,timezone=$3 WHERE id=$1 RETURNING id,title,timezone',
        [current.id, title ?? current.title, timezone ?? current.timezone]);
    });
    return json({ household: changed });
  }
  if (route === 'calendar/connection') {
    if (method === 'GET') return json(await calendarConnection(db, principal));
    if (method === 'POST') return json(await connectCalendar(db, principal, await readJson(request), options.env));
    if (method === 'DELETE') return json(await removeCalendar(db, principal));
  }
  if (route === 'calendar/selection' && method === 'PUT') return json(await selectCalendars(db, principal, await readJson(request)));
  if (route === 'calendar' && method === 'GET') return json(await calendarSnapshot(db, principal, url.searchParams.get('from'), url.searchParams.get('to'), { env: options.env }));
  if (route === 'calendar/sync' && method === 'POST') {
    requireAdmin(principal);
    const body = await readJson(request);
    return json(await calendarSnapshot(db, principal, body.from, body.to, { env: options.env, force: true }));
  }
  throw new ApiError(404, 'not_found', 'That endpoint does not exist.');
}

export async function handleRequest(request, options = {}) {
  const requestId = randomUUID();
  let db;
  let route;
  let authContext;
  try {
    route = apiPath(request);
    if (!['GET', 'HEAD'].includes(request.method)) assertSameOrigin(request);
    if (route === 'health' && request.method === 'GET') return json({ ok: true });
    if (['mobile/pairings','mobile/pairings/redeem'].includes(route) && request.method === 'POST') throw new ApiError(410, 'child_accounts_required', 'Children now use their own email accounts and a parent invitation.');
    db = options.db || sharedPool(options.env);
    if (route === 'internet/jobs/process' && request.method === 'GET') {
      const env = options.env || process.env;
      requireValue(typeof env.CRON_SECRET === 'string' && env.CRON_SECRET.length >= 32, 503, 'internet_jobs_unconfigured', 'Internet scheduling is not configured.');
      requireValue(digest(request.headers.get('authorization') || '') === digest(`Bearer ${env.CRON_SECRET}`), 401, 'unauthenticated', 'Unauthorized.');
      return json(await processInternetJobs(db, { env, ...options.internetJobs }));
    }
    if (route === 'calendar/jobs/sync' && request.method === 'GET') {
      const env = options.env || process.env;
      requireValue(typeof env.CRON_SECRET === 'string' && env.CRON_SECRET.length >= 32, 503, 'calendar_jobs_unconfigured', 'Calendar scheduling is not configured.');
      requireValue(digest(request.headers.get('authorization') || '') === digest(`Bearer ${env.CRON_SECRET}`), 401, 'unauthenticated', 'Unauthorized.');
      return json(await processCalendarSyncJobs(db, { env, ...(options.calendarSync ? { sync: options.calendarSync } : {}) }));
    }
    if (route === 'mobile/jobs/notifications' && request.method === 'GET') {
      const env = options.env || process.env;
      requireValue(typeof env.CRON_SECRET === 'string' && env.CRON_SECRET.length >= 32, 503, 'notifications_unconfigured', 'Notification scheduling is not configured.');
      requireValue(digest(request.headers.get('authorization') || '') === digest(`Bearer ${env.CRON_SECRET}`), 401, 'unauthenticated', 'Unauthorized.');
      return json(await processNotifications(db, { env }));
    }
    if (route.startsWith('auth/')) return await authGateway(request, route.slice(5), db, options);
    if (route === 'mobile/pairings/redeem' && request.method === 'POST') {
      await enforcePairRateLimit(db, request, options.env);
      return json(await redeemMobilePair(db, await readJson(request), options.env));
    }
    if (route === 'frame-pairs/redeem' && request.method === 'POST') {
      const body = await readJson(request);
      await enforcePairRateLimit(db, request, options.env);
      const result = await redeemFramePair(db, body, options.env);
      return json(result.data, 200, { 'Set-Cookie': result.cookie });
    }
    if (route === 'frame-session' && request.method === 'DELETE') {
      const token = cookieValue(request, FRAME_COOKIE);
      if (token) await db.query('UPDATE family_devices SET revoked_at=now() WHERE token_hash=$1', [digest(token)]);
      return json({ deleted: true }, 200, { 'Set-Cookie': `${FRAME_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (!options.authenticate && request.headers.get('authorization')?.startsWith('Bearer ') && !['GET', 'HEAD'].includes(request.method)) authContext = (options.createAuthContext || createAuthContext)(request, options);
    let principal = await (options.authenticate || authenticate)(request, db, { ...options, authContext });
    if (request.headers.has('x-family-authorization')) principal = await frameAuthorization(db, principal, request.headers.get('x-family-authorization'));
    const response = await dispatch(request, db, principal, route, { ...options, ...(authContext ? { authContext } : {}) });
    if (response.ok && options.scheduleBackground && startsInternetWork(route, request.method)) {
      const work = Promise.resolve().then(() => (options.internetQueue || drainInternetQueue)(db, { env: options.env || process.env })).catch(() => {
        console.error(JSON.stringify({ requestId,code:'internet_background_failed',route,method:request.method }));
      });
      try { options.scheduleBackground(work); }
      catch { console.error(JSON.stringify({requestId,code:'internet_background_unavailable',route,method:request.method})); }
    }
    return authContext ? authContext.finish(response) : response;
  } catch (error) {
    const known = error instanceof ApiError;
    const status = known ? error.status : 500;
    const code = known ? error.code : 'internal_error';
    // Log only a stable code and correlation ID, never error objects, bodies or query strings.
    if (status >= 500) console.error(JSON.stringify({ requestId, code, route, method: request.method }));
    const response = Response.json({ error: { code, message: known ? error.message : 'Something went wrong. Please try again.', ...(known && error.details ? { details: error.details } : {}) }, requestId }, { status, headers: { 'Cache-Control': 'no-store' } });
    return authContext ? authContext.finish(response) : response;
  }
}
