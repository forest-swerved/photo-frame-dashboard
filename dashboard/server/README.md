# Family dashboard backend

This backend serves `family.html` on Vercel Node 24. It uses a dedicated Supabase project in Swerved for Postgres and Auth. Household data is available only through this API; browser sign-up alone does not create membership.

Required server environment variables are `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `FAMILY_ENCRYPTION_KEY` (standard base64, 32 random bytes), and `FAMILY_BOOTSTRAP_HASH` (SHA-256 hex of the configured private claim code). `SUPABASE_DB_CA_CERT` provides the project CA PEM when needed. Keep these settings out of `VITE_*` variables and source control. The browser uses only the same-origin `/api/auth` backend; it has no Supabase client, project key, or refresh token.

## Initialize and verify

After verifying the Vercel project link and dedicated database target, run from `dashboard/`:

```sh
node --env-file=.env.local server/migrate.js
node --env-file=.env.local server/verify-schema.js
node --test server/backend.test.js server/calendar-normalize.test.js server/calendar-normalize-bounded.test.js server/icloud-caldav.test.js
```

The migration changes only twelve `family_*` tables. Each has RLS enabled, no browser policies, and no PUBLIC/anon/authenticated/service_role privileges. The server role `family_frame_server` owns only these tables and retains owner access. It has no superuser, role/database creation, replication, BYPASSRLS, or inherited role privileges. Provision table creation separately, then revoke its schema CREATE privilege. Database connections use node-postgres with verified TLS; URL flags cannot disable certificate verification or replace the explicit CA configuration.

The privileged setup process also provisions a non-exposed `family_internal.auth_sessions` view, owned by `postgres`, with exactly `id`, `user_id`, and `not_after` from managed `auth.sessions`. Only the server role receives schema USAGE and view SELECT. PUBLIC and API roles receive neither. This intentional private definer view gives the application a narrow revocation lookup without auth-schema USAGE, direct auth-table grants, auth DDL, or broad RLS bypass. `verify-schema.js` verifies both the household tables and this boundary.

Database race tests use the existing separate test database named **`family_frame_tests`** and an ignored `.env.test.local`. They refuse any other database before DDL. Each run creates and removes only its own random schema; managed Supabase tables are never fixture targets:

```sh
FAMILY_RUN_DB_TESTS=1 node --env-file=.env.test.local --test server/backend.integration.test.js
```

## Sign-in and household access

The browser's small fetch helper preserves `auth.signIn.email()`, `auth.signUp.email()`, `auth.getSession()`, `auth.token()`, and `auth.signOut()` for the UI. It receives only transient access JWTs and safe identity data; it never copies credentials into localStorage or URLs. Keep fetch credentials `same-origin`.

The server uses pinned `@supabase/ssr@0.12.7` and `@supabase/supabase-js@2.118.0`, creating a separate server client for each request. Its official getAll/setAll adapter preserves SDK cookie chunking and refreshes in first-party `__Host-family_auth` cookies, always Secure, HttpOnly, SameSite=Lax, Path=/, and host-only. Cookie writes and cache prevention headers are copied to successful and error responses. Browser JavaScript cannot read refresh tokens. The gateway allows only fixed email sign-up/sign-in, sign-out, confirmation/resend, get-session, and token operations. It rejects unknown body/query fields, cross-origin requests, and upstream redirects.

Every phone API request verifies the JWT signature using only ES256/RS256, its project `/auth/v1` issuer, `authenticated` audience/role, expiry, UUID subject, and UUID `session_id`. It then checks that exact session/user in the private view with a future or null `not_after`, and reads current household membership. Mutations additionally match the current cookie session's subject and session ID to the bearer. Current session/membership revocation therefore applies to reads as well as writes; a remaining cryptographically valid JWT does not bypass a removed provider session. User metadata is display data only and never grants roles.

Email confirmation stays enabled. `POST /api/auth/verify-email` accepts either `{email,token}` (6–10 numeric digits) or `{confirmationLink}`. Link mode accepts only this exact project's HTTPS `/auth/v1/verify` URL with signup/email type; it extracts the hash for `verifyOtp` and never follows, redirects, logs, or returns the link. `redirect_to` is ignored. Configure the provider confirmation template to include an OTP where supported, and verify actual email delivery separately. The resend endpoint accepts `{email}`. These provider auth responses use raw `{session,user}`/`null`, `{token}`, or `{success:true}`; the phone helper wraps them for the UI. Signup without a session returns `{session:null,user:null,confirmationRequired:true}`.

The private bootstrap code can claim the single household exactly once and creates its administrator atomically. It may be a short PIN; set `FAMILY_BOOTSTRAP_USER_ID` to the intended confirmed account UUID so only that signed-in account can use it. Store only its digest in `FAMILY_BOOTSTRAP_HASH`. Admins create single-use invitations for manual sharing. No invitation emails are sent by this application. People profiles are display names and are separate from authenticated accounts.

Frame pairing uses a six-digit code valid for ten minutes. Creating a new code invalidates older active codes. Redemption has database-backed limits of five attempts per IP per minute and thirty globally per minute. A successful redemption sets only a Secure HttpOnly SameSite=Strict `family_frame_session` cookie. Its random secret is stored as a hash in the database, expires after one year, and is checked for expiry/revocation on every request. Frames can read the household/calendar and complete chores; they cannot change Setup, credentials, membership, or chore definitions.

## API contract

Success is `{data: ...}`. Errors are `{error:{code,message,details?},requestId}`. Version conflicts use HTTP 409 with `details.current`. Unsafe requests require JSON and an exact same-origin `Origin` header, with a 16 KiB body limit.

| Route | Behavior |
| --- | --- |
| `GET /api/session` | Identity, role, household, and whether an authenticated user can claim |
| `POST /api/claim` | `{bootstrapCode,title?}`; first administrator only |
| `POST /api/invites`, `POST /api/join` | Create manual-share token; consume `{token}` once |
| `GET /api/members`, `DELETE /api/members/:id` | Admin list/revoke; administrator cannot remove themselves |
| `POST /api/frame-pairs` | Admin creates `{code,expiresAt}` from optional `{label}` |
| `POST /api/frame-pairs/redeem` | Anonymous `{code}` sets frame cookie; no bearer returned |
| `DELETE /api/frame-session` | Revoke current frame session and clear its cookie |
| `GET /api/devices`, `DELETE /api/devices/:id` | Admin list/revoke paired frames |
| `GET /api/household?date=YYYY-MM-DD` | Household, people, chore definitions and dated completion states |
| `POST /api/people`, `PATCH /api/people/:id`, `DELETE /api/people/:id` | Admin display profiles; edits require `expectedVersion`; deletion uses query parameter |
| `POST /api/chores`, `PATCH /api/chores/:id`, `DELETE /api/chores/:id` | Admin definitions with title, personId and weekdays (Sunday=0); versioned edits/deletion |
| `PUT /api/chores/:id/completions/:date` | `{completed,expectedVersion,mutationId}`; desired state, never toggle |
| `PATCH /api/settings` | Admin `{title?,timezone?}` |
| `GET/POST/DELETE /api/calendar/connection` | Admin connection status / `{username,appPassword}` / disconnect |
| `PUT /api/calendar/selection` | Admin `{calendarIds}`; up to ten discovered calendars |
| `GET /api/calendar?from&to`, `POST /api/calendar/sync` | Read snapshot; admin explicit refresh `{from,to}` |

Completion mutations use UUID IDs. Retrying an identical mutation returns its saved response. Reusing its ID for a different request conflicts. A new request with an old version also conflicts; clients must not overwrite newer polled state with an older retry acknowledgement.

## iCloud calendar boundary

Use an Apple app-specific password. Username and password are encrypted together with AES-256-GCM, a fresh IV, and household-bound authenticated data. They never appear in connection responses, localStorage, errors or logs. The API returns discovered calendar IDs without DAV URLs.

Requests use household local `from` / exclusive `to` dates and an IANA timezone. Windows are capped at 60 calendar days and 400 expanded events. Five-minute successful caches are marked ready. Provider, parse, timeout or coverage failures retain a previous matching good snapshot as stale and do not advance its success timestamp. Selection/disconnection/reconnection invalidates the old connection's results, including in-flight successes and failures. No partial snapshot is marked ready.

The adapter validates every Apple DAV destination and redirect before credentials are attached, limits transport and object sizes, and bounds recurrence normalization in a worker. Known IANA TZIDs work without embedded timezone definitions; custom TZIDs need valid calendar definitions. Unsupported RDATE PERIOD or EXRULE data fails explicitly. Fixture tests do not prove real-account connectivity or deployed browser cookie acceptance; those require live sign-in and the owner's calendar connection.

## Native iOS and notification service

`ios/FamilyFrame.xcodeproj` contains the native iPhone/iPad app. It shares this API and
household with the frame; see [the iOS guide](../../ios/README.md) for build, signing,
and Apple push configuration.

Parent login uses the existing first-party auth gateway and exchanges the verified
browser session at `POST /api/mobile/sessions` for a revocable, hashed mobile token.
Subsequent native requests use `Authorization: FamilyMobile <opaque token>` and the
canonical HTTPS Origin. Each request checks the parent's current membership and live
provider session. A parent administrator creates a ten-minute, single-use child code
at `POST /api/mobile/pairings`. Redeeming it binds that installation to one profile.
Children can read and complete their own chores; they cannot manage Setup or edit a
sibling's chores. Mobile tokens expire after 90 days and can be revoked in the app.

Chores accept optional `dueTime` (`HH:mm`, household timezone) and `reminderMinutes`
(0–1440). Profiles keep a section even when no chores are scheduled. No household
names or children's names are built into the application.

Completion/reopening events are inserted transactionally by an invoker trigger.
A production Vercel Cron calls `/api/mobile/jobs/notifications` every minute using
`CRON_SECRET`. The worker maintains a durable inbox and per-installation delivery
leases, suppresses obsolete reminders after completion/reassignment, respects quiet
hours, retries transient APNs failures and disables rejected tokens. Push acceptance
and inbox read status are different states. Lock-screen payloads are generic; event
details are available only through the authenticated inbox.

Supported categories are completed/reopened chores, due-soon/overdue chores, upcoming
timed calendar events, calendar sync-health transitions and frame connection status.
Calendar reminders use fresh, complete cached coverage and a ten-minute lead time;
provider calendar refresh remains driven by dashboard/app reads. Frame offline alerts
use a fifteen-minute grace above the five-minute heartbeat write interval. Initial
scans establish a baseline rather than flooding users with historical overdue alerts.

Configure the server-only `FAMILY_APNS_TEAM_ID`, `FAMILY_APNS_KEY_ID`,
`FAMILY_APNS_PRIVATE_KEY` and `FAMILY_APNS_TOPIC` from the actual Apple Developer
team. Never put the `.p8` key in source or the app. Debug installs use sandbox APNs;
TestFlight/Release uses production. `/api/mobile/status` reports missing Apple setup
separately from iOS permission or token registration. Without Apple credentials, the
inbox/scheduler still work but no push delivery is claimed.

### Additive schema upgrade

There are now twenty server-owned tables. `schema.sql`, `mobile-schema.sql` and
`notifications-schema.sql` are applied together by `npm run db:migrate`. Existing
households, calendars, chores, sessions and history are retained. The app login's
normal schema-CREATE permission remains revoked. For an upgrade, an authorized
administrator temporarily grants CREATE on `public` to the existing
`family_frame_server` table owner, runs the owner migration, then revokes CREATE even
if migration fails. Run `npm run db:verify` afterward; it checks ownership, RLS,
absence of browser/PUBLIC grants, and the private managed-session boundary. Do not
replace the runtime login with the administrative login or grant it broad role
membership. The versioned mobile migration records the owner SQL, not an instruction
to run it as Supabase's temporary CLI administrator.

### Qualification

`npm test` includes native-auth and notification unit tests. `npm run test:db` adds
concurrency, parent revocation, one-use child pairing, sibling isolation, deadline
races, quiet hours, installation ownership, token invalidation, calendar/frame status
and retry checks. Integration suites refuse any database not named
`family_frame_tests` and use unique test schemas; never point them at the household
database. A separately provisioned local PostgreSQL 17 database with a trusted local
TLS certificate can be used if the remote test database is unavailable.
