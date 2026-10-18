import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './app.js';

test('calendar scheduler never reads data with missing or incorrect cron authorization', async () => {
  const db = { query: () => { throw Error('unauthorized request reached the database'); } };
  const request = authorization => new Request('https://family.example/api/calendar/jobs/sync', { headers: authorization ? { authorization } : {} });
  const missing = await handleRequest(request(), { db, env: {} });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'calendar_jobs_unconfigured');
  for (const authorization of [undefined, 'Bearer wrong', `Basic ${'x'.repeat(48)}`]) {
    assert.equal((await handleRequest(request(authorization), { db, env: { CRON_SECRET: 'x'.repeat(48) } })).status, 401);
  }
});

test('authorized calendar scheduler runs independently of any signed-in household client', async () => {
  const sql = [];
  const db = { query: async statement => { sql.push(statement); return { rows: [] }; } };
  const result = await handleRequest(new Request('https://family.example/api/calendar/jobs/sync', { headers: { authorization: `Bearer ${'x'.repeat(48)}` } }),
    { db, env: { CRON_SECRET: 'x'.repeat(48) }, authenticate: () => { throw Error('scheduler must not depend on a phone session'); } });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).data, { processed: 0, synced: 0, failed: 0, busy: 0 });
  assert.ok(sql.some(statement => statement.includes('family_calendar_connections')));
  assert.ok(sql.some(statement => statement.includes('family_calendar_sync_jobs')));
});
