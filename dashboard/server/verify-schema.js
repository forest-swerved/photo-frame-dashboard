import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createPool } from './database.js';
import { verifyAccountDeletionBoundary } from './verify-account-deletion.js';

export async function verifySchema(pool, schema = 'public', expectedCount = 36) {
  const { rows } = await pool.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
    pg_get_userbyid(c.relowner)=current_user AS owned_by_server,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee=0) AS public_revoked,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE r.rolname IN ('anon','authenticated','service_role')) AS api_roles_revoked,
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid) AS no_browser_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname LIKE 'family\\_%' ESCAPE '\\' AND c.relkind='r' ORDER BY c.relname`, [schema]);
  assert.equal(rows.length, expectedCount, 'Expected all server-owned household, mobile and notification tables.');
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname}: RLS must be enabled`);
    assert.equal(row.relforcerowsecurity, false, `${row.relname}: owner must retain server access`);
    assert.equal(row.owned_by_server, true, `${row.relname}: server role must own table`);
    assert.equal(row.public_revoked, true, `${row.relname}: PUBLIC privileges must be revoked`);
    assert.equal(row.api_roles_revoked, true, `${row.relname}: API role privileges must be revoked`);
    assert.equal(row.no_browser_policies, true, `${row.relname}: browser policies must remain absent`);
  }
  return rows.length;
}

export async function verifyAuthBoundary(pool) {
  const { rows } = await pool.query(`SELECT
    has_schema_privilege(current_user,'family_internal','USAGE') AS server_schema,
    has_table_privilege(current_user,'family_internal.auth_sessions','SELECT') AS server_read,
    NOT has_schema_privilege(current_user,'auth','USAGE') AS no_auth_schema,
    NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=current_user AND
      (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)) AS restricted_role,
    NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=current_user) AS no_memberships,
    NOT EXISTS(SELECT 1 FROM pg_namespace n,LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
      LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname='family_internal'
      AND (a.grantee=0 OR r.rolname IN ('anon','authenticated','service_role'))) AS private_schema,
    NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee
      WHERE n.nspname='family_internal' AND c.relname='auth_sessions'
      AND (a.grantee=0 OR r.rolname IN ('anon','authenticated','service_role'))) AS private_view`);
  for (const [name, value] of Object.entries(rows[0])) assert.equal(value, true, `Auth boundary ${name} must hold.`);
  const columns = await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='family_internal' AND table_name='auth_sessions' ORDER BY ordinal_position`);
  assert.deepEqual(columns.rows.map(row => row.column_name), ['id', 'user_id', 'not_after']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  verifySchema(pool).then(async count => {
    await verifyAuthBoundary(pool);
    await verifyAccountDeletionBoundary(pool);
    console.log(`Verified ${count} server-only household tables and the private three-column auth session boundary.`);
  })
    .catch(() => { console.error('Household schema permission verification failed.'); process.exitCode = 1; })
    .finally(() => pool.end());
}
