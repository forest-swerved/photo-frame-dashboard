# Account deletion boundary

This function is prepared for release; writing its source does not deploy it.
The application uses a publishable key. The service-role key is read only from
Supabase Edge's default environment and must never be copied to Vercel or iOS.

`verify_jwt = false` disables the platform's legacy JWT gate. The handler still
requires `auth.getUser(bearer)` to authenticate the user against this exact
project, a password AMR timestamp and JWT issuance within five minutes, and the
exact confirmation `DELETE MY ACCOUNT`. Request JSON cannot select an identity.
It sends the verified user ID, confirmed email, and signed session ID to the
cleanup RPC. That RPC checks the live session through the existing private
read-only Auth session view before cleanup or retry, so a signed-out JWT cannot
authorize deletion.

Apply `dashboard/server/account-deletion-schema.sql` as `family_frame_server`
after the complete household schema, including Internet controls. The versioned
CLI migration is the same owner SQL and must not be applied as the CLI admin.
The owner must retain all household tables; only `service_role` receives EXECUTE
on `family_delete_account_data(uuid,text,text,uuid)`. No API role receives table
privileges. `verifyAccountDeletionBoundary` checks the function owner, its
hardened search path, revoked public grants, and exclusive service-role grant.
Run Supabase security advisors after applying production DDL.

The function validates ownership, device enrollment, and Internet sessions
before changing anything. It cleans family data and atomically saves a recovery
tombstone, then globally signs out Auth sessions and hard-deletes the verified
Auth user. Failed provider deletion can be retried with a newly authenticated
password session even when the family membership has already been removed.
The application must expose account deletion before its household guard. Claim
and invitation redemption must reject users with a deletion tombstone while
holding the same `membership:<user UUID>` advisory lock.

Shared child profiles, chores, calendar connections, and historical family
facts remain when another household administrator exists. Login identifiers in
retained audit actors are anonymized. A final household is removed only after
every managed network policy has been unenrolled and all Internet sessions are
terminal. The RPC does not call UniFi or remove firewall rules. Concurrent edits
that cannot acquire locks within two seconds roll back all cleanup and can be
retried.

Meaningful local verification:

```sh
cd dashboard
FAMILY_RUN_DB_TESTS=1 node --env-file=.env.test.local --test server/account-deletion.test.js server/account-deletion.integration.test.js
cd ..
deno check --config supabase/functions/family-delete-account/deno.json supabase/functions/family-delete-account/index.ts
```

Tests use a disposable local TLS PostgreSQL schema and fake Auth/Edge clients.
They never delete a real Auth user. A release still needs the owner migration,
Edge deployment, unauthorized-request rejection, and a disposable-account
end-to-end deletion test. Keep production family accounts out of that test.

Primary references checked October 17, 2026:

- [Edge function authentication](https://supabase.com/docs/guides/functions/auth)
- [JWT fields and password AMR](https://supabase.com/docs/guides/auth/jwt-fields)
- [Admin identity deletion](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser)
- [TLS cipher deprecation notice](https://supabase.com/changelog/cbc-tls-ciphers-deprecated)

The announced November 2026 removal of CBC TLS 1.2 ciphers does not change the
Node/Deno TLS configuration used here. The frame calls the Vercel application;
these deletion provider requests run on the server.
