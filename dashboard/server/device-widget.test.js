import test from 'node:test';
import assert from 'node:assert/strict';
import { widgetCredential, deviceWidgetSnapshot, widgetItems } from './device-widget.js';
import { handleRequest } from './app.js';
const now = new Date('2026-11-22T18:00:00.000Z');
const env = { FAMILY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
const row = { id: '00000000-0000-4000-8000-000000000001', household_id: 'household', token_hash: 'a'.repeat(64), expires_at: new Date(+now + 86400000) };
const principal = { authType: 'mobile', role: 'admin', mobileSessionId: row.id };
const device = { id: 'console', name: 'Console', person_ids: ['child'], default_access: 'blocked', desired_access: 'blocked', observed_access: 'blocked', access_verified_at: now };
const people = [{ id: 'child', name: 'Alex' }];
function database(active = row) {
  const calls = [];
  return { calls, async query(sql, values) {
    calls.push({sql, values});
    assert.ok(sql.trimStart().startsWith('SELECT'), 'Widget must remain read-only');
    if (sql.includes('family_mobile_sessions')) {
      assert.match(sql, /provider_session_id/); assert.match(sql, /revoked_at IS NULL/); assert.match(sql, /kind='parent'/);
      return { rows: active ? [active] : [] };
    }
    assert.deepEqual(values, ['household'], 'All reads must be household-scoped');
    return { rows: sql.includes('family_managed_devices') ? [device] : sql.includes('family_people') ? people : [] };
  }};
}
const request = token => new Request('https://frame.test/api/widget/devices', { headers: { authorization: `FamilyWidget ${token}` } });
test('read-only widget capability is parent-only, scoped to a live session and rejects tampering', async () => {
  const db = database();
  const credential = await widgetCredential(db, principal, { env, now });
  const result = await deviceWidgetSnapshot(request(credential.token), db, { env, now });
  assert.deepEqual(result.items, []);
  assert.equal(result.checkedAt, now.toISOString());
  for (const role of ['child', 'frame']) await assert.rejects(widgetCredential(db, {...principal, role}, {env, now}), {status:403});
  await assert.rejects(deviceWidgetSnapshot(request(credential.token.slice(0,-1) + (credential.token.endsWith('0') ? '1' : '0')), db, {env, now}), {status:401});
  await assert.rejects(deviceWidgetSnapshot(request(credential.token), database(null), {env, now}), {status:401});
  await assert.rejects(deviceWidgetSnapshot(request(credential.token), db, {env, now:new Date(+now+86400001)}), {status:401});
  await assert.rejects(deviceWidgetSnapshot(request(credential.token), database({...row, token_hash:'b'.repeat(64)}), {env, now}), {status:401});
});
test('widget capability cannot access ordinary reads or mutations', async () => {
  const credential = await widgetCredential(database(), principal, {env, now});
  for (const [method,path] of [['GET','internet'], ['POST','internet/grants'], ['GET','mobile/widget-credential']]) {
    const response = await handleRequest(new Request(`https://frame.test/api/${path}`, {method, headers:{authorization:`FamilyWidget ${credential.token}`,origin:'https://frame.test'}}), {db:database(),env});
    assert.equal(response.status,401);
  }
});
test('confirmed time, default-off overrides, paused and uncertain state remain distinct', () => {
  const end = new Date(+now+3600000).toISOString();
  const active = {id:'session',device_id:device.id,person_id:'child',state:'active',desired_state:'allowed',observed_state:'allowed',ends_at:end,verified_at:now};
  const timed = widgetItems([device],[active],[],people,now)[0];
  assert.equal(timed.person,'Alex'); assert.equal(timed.endsAt,end); assert.equal(timed.status,'Time running');
  const on = {...device,desired_access:'allowed',observed_access:'allowed'};
  assert.equal(widgetItems([on],[],[],people,now)[0].status,'Internet on');
  assert.deepEqual(widgetItems([{...on,default_access:'allowed'}],[],[],people,now),[]);
  assert.equal(widgetItems([device],[{...active,state:'paused',desired_state:'blocked',observed_state:'blocked',ends_at:null}],[],people,now)[0].status,'Paused');
  for (const [sessions,commands,time] of [[[active],[{device_id:device.id,state:'pending'}],now], [[active],[],new Date(+now+180001)], [[{...active,ends_at:now}],[],now]]) {
    const item=widgetItems([device],sessions,commands,people,time)[0]; assert.equal(item.endsAt,null); assert.notEqual(item.status,'Time running');
  }
  assert.deepEqual(widgetItems([device],[{...active,state:'ended'}],[],people,now),[]);
  assert.equal(JSON.stringify(timed).includes('token_hash'),false);
});
