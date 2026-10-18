# Dedicated family dashboard database

Use a new project in the intended organization. The deployed instance belongs to
Swerved; no existing business project's database, Auth users, or credentials are
shared. Keep database passwords and server environment files outside source control.

The household tables are owned by the dedicated `family_frame_server` login. It has
no superuser, database/role creation, replication, BYPASSRLS, or inherited roles.
Provision that login with a random password through the administrative connection,
grant database CONNECT and temporary USAGE/CREATE on public, and configure the app's
verified-TLS pooler credentials for it. Do not deploy the administrative database
login or a Supabase secret/service-role key as application credentials.

Run `npm run db:migrate` from `dashboard/` using that login. It creates the twenty
household, mobile and notification tables and revokes PUBLIC and Supabase API-role access. Supabase's
temporary CLI administrator cannot assume this custom role; do not remove ownership
checks or substitute the administrative login to work around that boundary.

After the household migration, apply the administrative migration in `migrations/`
through the project's authorized administrator. It creates a private, three-column
view of managed session identity and expiry, then revokes schema CREATE from the
app login. The view's owner privileges are intentional: the app can check revoked
sessions without receiving access to the managed Auth schema or refresh-token data.
The `family_internal` schema must remain outside the Data API's exposed schemas.

Run `npm run db:verify` as the app login. Also verify that direct Auth reads, view
writes, and new public-table creation fail. Supabase advisors should report no
security finding for these tables or the private view.

Auth uses an exact production Site URL, email confirmation, eight-digit confirmation
codes, and 15-minute access tokens. Configure custom SMTP for users outside the
Supabase organization team. The current confirmation email template contains
`{{ .Token }}`. Never put credentials or confirmation links into dashboard URLs.

Keep provider administration separate from reusable application migrations:
`dashboard/server/schema.sql` and its additive SQL files are applied as their owner.
The private-session-boundary migration uses the project administrator; the mobile
and child-account migrations are owner SQL and must use `family_frame_server`.

For the mobile/notification upgrade, temporarily restore CREATE on public to the same
server owner, run the owner migration and revoke CREATE afterward (including on failure).
The versioned mobile migration is owner SQL; it must not be executed as the CLI
administrator. The new completion trigger is SECURITY INVOKER and owned by that server
role. Keep both managed Auth access and broad role membership restricted as before.

The child-account upgrade adds role/profile/email constraints to the existing
twenty-table model. A child invitation requires the intended account's confirmed
email from the provider before linking its user ID to the profile. Browser and
native authorization recheck that stored membership; notifications also recheck
the provider session. Existing anonymous child sessions and pairing codes are
revoked by the owner migration. Frame pairing is unchanged.
