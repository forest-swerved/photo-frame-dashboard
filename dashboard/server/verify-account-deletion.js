import assert from 'node:assert/strict';

// Called by release verification after owner migrations. No table/Data API
// grants are needed by the Edge runtime; service_role only executes this RPC.
export async function verifyAccountDeletionBoundary(db, schema = 'public', { requireServiceRole = true } = {}) {
  const { rows } = await db.query(`SELECT p.prosecdef AS definer,p.proowner=current_user::regrole AS owned_by_server,
    p.prorettype='jsonb'::regtype AS json_result,
    p.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',$1::text)] AS safe_path,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) AS public_revoked,
    NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles r ON r.oid=a.grantee
      WHERE a.grantee<>p.proowner AND r.rolname<>'service_role') AS only_service_role,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') AS service_exists,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles r ON r.oid=a.grantee
      WHERE r.rolname='service_role' AND a.privilege_type='EXECUTE') AS service_execute
    FROM pg_proc p WHERE p.oid=to_regprocedure(format('%I.family_delete_account_data(uuid,text,text,uuid)',$1::text))`, [schema]);
  assert.equal(rows.length, 1, 'The account deletion RPC must exist.');
  for (const key of ['definer', 'owned_by_server', 'json_result', 'safe_path', 'public_revoked', 'only_service_role']) assert.equal(rows[0][key], true, `Account deletion boundary ${key} must hold.`);
  if (requireServiceRole) assert.equal(rows[0].service_exists && rows[0].service_execute, true, 'Only the Supabase Edge service role must be able to execute account deletion.');
  else if (rows[0].service_exists) assert.equal(rows[0].service_execute, true);
  return true;
}
