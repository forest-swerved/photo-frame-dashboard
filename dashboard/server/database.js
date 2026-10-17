import pg from 'pg';
import { requireValue } from './errors.js';

export function poolConfig(env = process.env, { migration = false, max = 3 } = {}) {
  const connection = migration ? env.DATABASE_URL_UNPOOLED : env.DATABASE_URL;
  let url;
  try { url = new URL(connection); } catch { /* Return only a redacted configuration error. */ }
  requireValue(url && ['postgres:', 'postgresql:'].includes(url.protocol), 503, 'configuration_missing', 'Household storage is not configured.');
  // node-postgres replaces its SSL object when these URL parameters exist.
  // Remove them so neither sslmode=require nor a URL can weaken verification.
  for (const key of ['ssl', 'sslmode', 'sslnegotiation', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);
  return { connectionString: url.href, max, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true, ...(env.SUPABASE_DB_CA_CERT ? { ca: env.SUPABASE_DB_CA_CERT } : {}) } };
}

export function createPool(env = process.env, options) {
  return new pg.Pool(poolConfig(env, options));
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
