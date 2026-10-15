import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createPool } from './database.js';

export async function verifySchema(pool, schema = 'public') {
  const { rows } = await pool.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
    pg_get_userbyid(c.relowner)=current_user AS owned_by_server,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee=0) AS public_revoked,
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid) AS no_browser_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname LIKE 'family\\_%' ESCAPE '\\' AND c.relkind='r' ORDER BY c.relname`, [schema]);
  assert.equal(rows.length, 12, 'Expected all twelve household tables.');
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname}: RLS must be enabled`);
    assert.equal(row.relforcerowsecurity, false, `${row.relname}: owner must retain server access`);
    assert.equal(row.owned_by_server, true, `${row.relname}: server role must own table`);
    assert.equal(row.public_revoked, true, `${row.relname}: PUBLIC privileges must be revoked`);
    assert.equal(row.no_browser_policies, true, `${row.relname}: browser policies must remain absent`);
  }
  return rows.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  verifySchema(pool).then(count => console.log(`Verified server ownership, RLS and PUBLIC revocation on ${count} household tables.`))
    .catch(() => { console.error('Household schema permission verification failed.'); process.exitCode = 1; })
    .finally(() => pool.end());
}
