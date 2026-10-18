import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPool } from './database.js';

export async function migrate(env = process.env) {
  // The parent setup workflow verifies this dedicated project's environment before invocation.
  if (!env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED is required for this migration.');
  const schema = (await Promise.all(['schema.sql', 'mobile-schema.sql', 'notifications-schema.sql', 'child-accounts-schema.sql', 'calendar-sync-schema.sql', 'chore-schema.sql', 'account-notifications-schema.sql', 'internet-schema.sql', 'account-deletion-schema.sql'].map(name => readFile(new URL(name, import.meta.url), 'utf8')))).join('\n');
  const pool = createPool(env, { migration: true, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('forest-family-schema-v1', 0))");
      await client.query(schema);
      await client.query('COMMIT');
      console.log('Family schema migration completed.');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch(() => { console.error('Family schema migration failed; no credentials were logged.'); process.exitCode = 1; });
}
