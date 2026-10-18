import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';
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
  const pool = new pg.Pool(poolConfig(env, options));
  // Idle sockets can fail between requests. A handler prevents an unhandled
  // EventEmitter error without logging connection URLs or provider credentials.
  pool.on('error', () => {});
  return pool;
}

// One small pool per warm runtime/configuration. An injected test pool bypasses
// this helper, and changing URL/CA replaces the old pool rather than sharing it
// across environments. Callers must not end this borrowed runtime pool.
let runtimePool;
let runtimeConfig;
export function sharedPool(env = process.env) {
  const config = poolConfig(env);
  const signature = JSON.stringify({ ...config, vercelLifecycle: env.VERCEL === '1' });
  if (runtimePool && runtimeConfig === signature) return runtimePool;
  const previous = runtimePool;
  runtimePool = createPool(env);
  if (env.VERCEL === '1') attachDatabasePool(runtimePool);
  runtimeConfig = signature;
  if (previous) previous.end().catch(() => {});
  return runtimePool;
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
