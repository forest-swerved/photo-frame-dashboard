import { randomUUID } from 'node:crypto';
import { ApiError, json, readJson, requireValue, textField, timezoneField, uuidField, versionField } from './errors.js';
import { createPool, one, transaction } from './database.js';
import { authenticate, assertSameOrigin, cookieValue, FRAME_COOKIE, requireAdmin, requireHousehold } from './auth.js';
import { authGateway, createAuthContext } from './supabase-auth.js';
import { digest } from './credentials.js';
import { enforcePairRateLimit } from './pair-rate-limit.js';
import { claimHousehold, createChore, createFramePair, createInvite, createPerson, changeChore, changePerson, householdSnapshot, joinHousehold, redeemFramePair, sessionData, setCompletion } from './household.js';
import { calendarConnection, calendarSnapshot, connectCalendar, removeCalendar, selectCalendars } from './calendar-service.js';
import { createMobileSession, createMobilePair, redeemMobilePair, mobileSessionData, mobileDevices, revokeMobile } from './mobile.js';
import { registerPush, notificationPreferences, notificationInbox, markNotificationRead, processNotifications } from './notifications.js';
import { apnsConfiguration } from './apns.js';

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
  if (route === 'session' && method === 'GET') return json(await sessionData(db, principal));
  if (route === 'claim' && method === 'POST') return json(await claimHousehold(db, principal, await readJson(request), options.env));
  if (route === 'join' && method === 'POST') return json(await joinHousehold(db, principal, await readJson(request)));
  requireHousehold(principal);
  if (route === 'mobile/sessions' && method === 'POST') return json(await createMobileSession(db, principal, await readJson(request)), 201);
  if (route === 'mobile/pairings' && method === 'POST') return json(await createMobilePair(db, principal, await readJson(request), options.env), 201);
  if (route === 'mobile/devices' && method === 'GET') return json(await mobileDevices(db, principal));
  const mobileDevice = /^mobile\/devices\/([^/]+)$/.exec(route);
  if (mobileDevice && method === 'DELETE') return json(await revokeMobile(db, principal, mobileDevice[1]));
  if (route.startsWith('mobile/')) {
    requireValue(principal.authType === 'mobile', 403, 'mobile_required', 'Use the Family Frame iOS app.');
    if (route === 'mobile/status' && method === 'GET') { let pushConfigured = false; try { apnsConfiguration(options.env || process.env); pushConfigured = true; } catch { /* Report missing provider setup without exposing configuration. */ } return json({ pushConfigured, schedulingConfigured: Boolean((options.env || process.env).CRON_SECRET), serverTime: new Date().toISOString() }); }
    if (route === 'mobile/session' && method === 'GET') return json(mobileSessionData(principal));
    if (route === 'mobile/session' && method === 'DELETE') return json(await revokeMobile(db, principal, principal.mobileSessionId));
    if (route === 'mobile/push-installations' && method === 'POST') return json(await registerPush(db, principal, await readJson(request), options.env));
    if (route === 'mobile/notification-preferences' && ['GET', 'PUT', 'PATCH'].includes(method)) return json(await notificationPreferences(db, principal, method === 'GET' ? undefined : await readJson(request)));
    if (route === 'mobile/notifications' && method === 'GET') return json(await notificationInbox(db, principal));
    const readNotification = /^mobile\/notifications\/([^/]+)\/read$/.exec(route);
    if (readNotification && method === 'POST') return json(await markNotificationRead(db, principal, readNotification[1]));
  }
  if (route === 'household' && method === 'GET') return json(await householdSnapshot(db, principal, url.searchParams.get('date')));
  if (route === 'invites' && method === 'POST') return json(await createInvite(db, principal, await readJson(request)), 201);
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
    return json({ members: (await db.query('SELECT user_id,name,email,role,joined_at FROM family_members WHERE household_id=$1 AND revoked_at IS NULL ORDER BY joined_at', [principal.household.id])).rows.map(row => ({ id: row.user_id, name: row.name, email: row.email, role: row.role, joinedAt: row.joined_at })) });
  }
  const member = /^members\/([^/]+)$/.exec(route);
  if (member && method === 'DELETE') {
    requireAdmin(principal);
    requireValue(member[1] !== principal.user.id, 422, 'cannot_remove_owner', 'The administrator cannot remove their own access.');
    const changed = await db.query("UPDATE family_members SET revoked_at=now() WHERE household_id=$1 AND user_id=$2 AND role='member' AND revoked_at IS NULL RETURNING user_id", [principal.household.id, member[1]]);
    requireValue(changed.rowCount > 0, 404, 'not_found', 'That family member does not exist.');
    return json({ deleted: true });
  }
  if (route === 'people' && method === 'POST') return json(await createPerson(db, principal, await readJson(request)), 201);
  const person = /^people\/([^/]+)$/.exec(route);
  if (person && ['PATCH', 'DELETE'].includes(method)) {
    const body = method === 'DELETE' ? { expectedVersion: deleteVersion(url) } : await readJson(request);
    return json(await changePerson(db, principal, person[1], body, method === 'DELETE'));
  }
  if (route === 'chores' && method === 'POST') return json(await createChore(db, principal, await readJson(request)), 201);
  const chore = /^chores\/([^/]+)$/.exec(route);
  if (chore && ['PATCH', 'DELETE'].includes(method)) {
    const body = method === 'DELETE' ? { expectedVersion: deleteVersion(url) } : await readJson(request);
    return json(await changeChore(db, principal, chore[1], body, method === 'DELETE'));
  }
  const completion = /^chores\/([^/]+)\/completions\/([^/]+)$/.exec(route);
  if (completion && method === 'PUT') return json(await setCompletion(db, principal, completion[1], completion[2], await readJson(request)));
  if (route === 'settings' && method === 'PATCH') {
    requireAdmin(principal);
    const body = await readJson(request);
    const changed = await one(db, 'UPDATE family_households SET title=$2,timezone=$3 WHERE id=$1 RETURNING id,title,timezone',
      [principal.household.id, body.title === undefined ? principal.household.title : textField(body.title, 'Household title', 80), body.timezone === undefined ? principal.household.timezone : timezoneField(body.timezone)]);
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
    db = options.db || createPool(options.env);
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
    const principal = await (options.authenticate || authenticate)(request, db, { ...options, authContext });
    const response = await dispatch(request, db, principal, route, options);
    return authContext ? authContext.finish(response) : response;
  } catch (error) {
    const known = error instanceof ApiError;
    const status = known ? error.status : 500;
    const code = known ? error.code : 'internal_error';
    // Log only a stable code and correlation ID, never error objects, bodies or query strings.
    if (status >= 500) console.error(JSON.stringify({ requestId, code, route, method: request.method }));
    const response = Response.json({ error: { code, message: known ? error.message : 'Something went wrong. Please try again.', ...(known && error.details ? { details: error.details } : {}) }, requestId }, { status, headers: { 'Cache-Control': 'no-store' } });
    return authContext ? authContext.finish(response) : response;
  } finally {
    if (db && !options.db) await db.end().catch(() => {});
  }
}
