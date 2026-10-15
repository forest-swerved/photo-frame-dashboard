import { Pool } from '@neondatabase/serverless';
import { requireValue } from './errors.js';

export function createPool(env = process.env) {
  requireValue(Boolean(env.DATABASE_URL), 503, 'configuration_missing', 'Household storage is not configured.');
  return new Pool({ connectionString: env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000 });
}

export async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function one(db, sql, values = []) {
  return (await db.query(sql, values)).rows[0] || null;
}
