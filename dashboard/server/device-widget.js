import { timingSafeEqual } from 'node:crypto';
import { one } from './database.js';
import { keyedDigest } from './credentials.js';
import { requireValue } from './errors.js';
import { activeMobileSessionSql } from './mobile.js';
import { deviceAccessState } from './internet-state.js';

const signature = (row, expires, env) => keyedDigest('device-widget-read-v1', `${row.id}:${row.token_hash}:${expires}`, env);
const activeSession = (db, id, now) => one(db, `SELECT s.id,s.household_id,s.token_hash,s.expires_at
 FROM family_mobile_sessions s WHERE s.id=$1 AND s.kind='parent' AND ${activeMobileSessionSql('s', '$2')}`, [id, now]);

// A separate, read-only capability. It cannot authenticate to any normal app API.
export async function widgetCredential(db, principal, { env = process.env, now = new Date() } = {}) {
  requireValue(principal.authType === 'mobile' && ['admin', 'member'].includes(principal.role), 403, 'parent_required', 'Sign in as a parent to use the device widget.');
  const row = await activeSession(db, principal.mobileSessionId, now);
  requireValue(row, 401, 'mobile_session_revoked', 'Sign in again.');
  const expires = Math.floor(Math.min(+new Date(row.expires_at), (Math.floor(+now / 86400000) + 8) * 86400000) / 1000);
  return { token: `${row.id}.${expires}.${signature(row, expires, env)}`, expiresAt: new Date(expires * 1000).toISOString() };
}

export function widgetItems(devices, sessions, commands, people, now) {
  const names = new Map(people.map(p => [p.id, p.name]));
  return devices.flatMap(device => {
    const live = sessions.filter(s => s.device_id === device.id && !['ended', 'failed'].includes(s.state));
    const session = live.find(s => s.desired_state === 'allowed') || live[0];
    const access = deviceAccessState(device, sessions, commands, now);
    const defaultOffOn = device.default_access === 'blocked' && (device.desired_access === 'allowed' || device.observed_access === 'allowed');
    if (!session && !defaultOffOn) return [];
    const confirmed = access.phase === 'confirmed';
    const ended = session?.ends_at && +new Date(session.ends_at) <= +now;
    const status = ended ? 'Confirming block' : !confirmed ? 'Checking access' : session?.state === 'paused' ? 'Paused' : access.confirmedMode === 'timed' ? 'Time running' : access.confirmedMode === 'on' ? 'Internet on' : 'Internet off';
    return [{ id: device.id, device: device.name,
      person: session ? names.get(session.person_id) || 'Device time' : (device.person_ids || []).map(id => names.get(id)).filter(Boolean).join(', '),
      status, defaultOffOn, endsAt: confirmed && session?.state === 'active' && !ended ? access.endsAt : null,
      preparationEndsAt: confirmed && session?.state === 'active' ? session.policy_snapshot?.preparation?.endsAt || null : null }];
  }).sort((a, b) => (a.endsAt || 'z').localeCompare(b.endsAt || 'z') || a.device.localeCompare(b.device));
}

export async function deviceWidgetSnapshot(request, db, { env = process.env, now = new Date() } = {}) {
  const match = /^FamilyWidget ([0-9a-f-]{36})\.(\d{10})\.([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
  requireValue(match && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(match[1]) && Number(match[2]) * 1000 > +now, 401, 'widget_session_required', 'Open Family Frame to reconnect your widget.');
  const row = await activeSession(db, match[1], now);
  requireValue(row && timingSafeEqual(Buffer.from(match[3], 'hex'), Buffer.from(signature(row, match[2], env), 'hex')), 401, 'widget_session_revoked', 'Open Family Frame to reconnect your widget.');
  const household = row.household_id;
  const devices = (await db.query('SELECT * FROM family_managed_devices WHERE household_id=$1 AND removed_at IS NULL ORDER BY name,id', [household])).rows;
  const sessions = (await db.query("SELECT * FROM family_internet_sessions WHERE household_id=$1 AND state NOT IN ('ended','failed')", [household])).rows;
  const commands = (await db.query("SELECT device_id,session_id,state,last_error FROM family_internet_commands WHERE household_id=$1 AND state IN ('pending','leased','attention')", [household])).rows;
  const people = (await db.query('SELECT id,name FROM family_people WHERE household_id=$1', [household])).rows;
  return { checkedAt: now.toISOString(), items: widgetItems(devices, sessions, commands, people, now) };
}
