import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handleRequest } from './app.js';
const origin = 'https://family.example';
const frame = { authType: 'frame', role: 'frame', actor: 'frame:fixture', household: { id: randomUUID(), timezone: 'America/Denver' }, user: { id: randomUUID() } };
const request = (route, method = 'GET', body, headers = {}) => new Request(`${origin}/api/${route}`, { method, headers: { ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const db = { query() { throw Error('Unexpected storage access'); } };
test('bare paired frames cannot administer network, account Activity, or account lifecycle', async () => {
  for (const [route, method, body] of [['internet/grants', 'POST', {}], ['internet/redeem', 'POST', {}], [`internet/sessions/${randomUUID()}/actions`, 'POST', {}], ['internet/devices', 'POST', {}], ['frame-access-codes', 'POST', {}], ['notifications', 'GET'], ['notification-preferences', 'GET'], ['account/delete', 'POST', {}], ['account/transfer-ownership', 'POST', {}]]) {
    let scheduled=0;
    assert.equal((await handleRequest(request(route, method, body), { db, authenticate: async () => frame, scheduleBackground:()=>{scheduled++;} })).status, 403, route);
    assert.equal(scheduled,0,'Unauthorized writes never start network processing.');
  }
});
test('network cron authentication never queries storage without its strong secret', async () => {
  assert.equal((await handleRequest(request('internet/jobs/process'), { db, env: {} })).status, 503);
  assert.equal((await handleRequest(request('internet/jobs/process'), { db, env: { CRON_SECRET: 'x'.repeat(32) } })).status, 401);
});
