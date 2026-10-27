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

The complete migration manages thirty-six `family_*` tables. Each has RLS enabled, no browser policies, and no PUBLIC/anon/authenticated/service_role table privileges. The server role `family_frame_server` owns only these tables and retains owner access. It has no superuser, role/database creation, replication, BYPASSRLS, or inherited role privileges. Provision table creation separately, then revoke its schema CREATE privilege. Database connections use node-postgres with verified TLS; URL flags cannot disable certificate verification or replace the explicit CA configuration.

The privileged setup process also provisions a non-exposed `family_internal.auth_sessions` view, owned by `postgres`, with exactly `id`, `user_id`, and `not_after` from managed `auth.sessions`. Only the server role receives schema USAGE and view SELECT. PUBLIC and API roles receive neither. This intentional private definer view gives the application a narrow revocation lookup without auth-schema USAGE, direct auth-table grants, auth DDL, or broad RLS bypass. `verify-schema.js` verifies both the household tables and this boundary.

Database race tests use the existing separate test database named **`family_frame_tests`** and an ignored `.env.test.local`. They refuse any other database before DDL. Each run creates and removes only its own random schema; managed Supabase tables are never fixture targets:

```sh
FAMILY_RUN_DB_TESTS=1 node --env-file=.env.test.local --test server/backend.integration.test.js
```

## School schedules and task sections

The interface calls chores **Tasks**, while existing API routes, event kinds, and stored identifiers remain compatible. Repeating routines accept `schoolDayFilter` (`any`, `school_day`, `non_school_day`) alongside their weekdays. School-day routines can use `taskSection` (`before_school`, `after_school`, or the legacy `tasks` default). One-off and non-school routines normalize to `tasks`. Daily occurrences preserve their original filter and section when a routine changes.

`GET /api/school-calendar?date=YYYY-MM-DD` returns the covering calendar and classification in household-local dates. A chore-authorized parent can `PUT` a validated calendar document or `PATCH` a version-checked date override for today or later. Source metadata and revisions live in the server-only `family_school_calendars` table. Overrides win over published closures, instructional weekdays and summer dates. Dates outside imported coverage stay unknown; school-dependent work waits, and uncertain required work cannot earn a reward. Importing another school year early preserves the current year's classification.

A current-day calendar change exchanges pending task sets, preserving completed/submitted work, explicit parent reschedules, and the change history. School days show Before school/After school groups; non-school days use Tasks. Task breaks remain a separate way to excuse work entirely. Existing routines default to any day type and the general Tasks section until a parent assigns a schedule.

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

`family-notifications-schema.sql` adds server-owned device-time requests and account switches for daily reminders, completion summaries, requests/decisions and detailed alerts. Apply it after `internet-schema.sql`; the matching additive Supabase migration is `20261027011601_family_notification_workflows.sql`. The normal owner migration replays this schema too. New table creation requires the existing authorized schema-creation migration path.

`POST /api/internet/requests` accepts a child's assigned `deviceId`, 1–1439 `minutes`, optional `reason` (500 characters) and `mutationId`. Requests expire after 24 hours, with one pending request per child/device and at most 20 requests per day. `POST /api/internet/requests/:id/decision` requires parent Internet capability, `action` (`approve`/`decline`), `expectedVersion` and `mutationId`. Approval uses the existing network-readiness gates and reserves a timed parent session in the same transaction. Retries deduplicate and simultaneous decisions conflict. `/api/internet` includes scoped requests; a child sees only their own.

The minute notification cron uses school calendar classification and household-local time for child-only 07:00/16:00 school-day reminders and 11:00 non-school-day reminders. Unknown coverage produces no scheduled daily reminder. Only pending work is actionable; submitted/approved/skipped work does not trigger reminders. Slots catch up for at most one hour, deduplicate by child/date/time and recheck pending tasks and school classification at delivery. Task completion summaries cover all non-excused daily tasks after approval, once per child/day even when rewards are disabled. Event Activity survives push suppression. Detailed alerts include names, device/task names and request reasons by default; `showDetails:false` keeps generic lock-screen text. Approval/grant alerts exclude the acting parent's account across installations; network-confirmed session starts are separate alerts.

`ios/FamilyFrame.xcodeproj` contains the native iPhone/iPad app. It shares this API and
household with the frame; see [the iOS guide](../../ios/README.md) for build, signing,
and Apple push configuration.

Account login uses the existing first-party auth gateway and exchanges the verified
browser session at `POST /api/mobile/sessions` for a revocable, hashed mobile token.
Subsequent native requests use `Authorization: FamilyMobile <opaque token>` and the
canonical HTTPS Origin. Each request checks the account's current membership and live
provider session. A parent administrator creates a child invitation at `POST /api/invites`
with `{role:"child",personId,email}` (`POST /api/child-invites` is an equivalent alias).
The child creates their own password, confirms their email, and accepts the private
token at `POST /api/join` before mobile exchange. Every production invitation join
checks the current confirmed email directly with the provider, including family-member
invitations, so stale JWT emails cannot bypass a child reservation. Concurrent joins
are serialized; existing child accounts cannot consume adult invitations to widen access.

Children can read and complete their own chores and view the shared calendar; they
cannot manage Setup or edit a sibling's chores. Both browser and native requests
derive the profile from the stored membership. Anonymous `/api/mobile/pairings` and
its redemption route return 410. Mobile tokens expire after 90 days and can be revoked
in the app; provider sign-out and parent removal also stop account access and push fanout.

Chores accept optional `dueTime` (`HH:mm`, household timezone) and `reminderMinutes`
(0–1440). Profiles keep a section even when no chores are scheduled. No household
names or children's names are built into the application.

Completion/reopening events are inserted transactionally by an invoker trigger.
A production Vercel Cron calls `/api/mobile/jobs/notifications` every minute using
`CRON_SECRET`. The worker maintains a durable inbox and per-installation delivery
leases, suppresses obsolete reminders after completion/reassignment, respects quiet
hours, retries transient APNs failures and disables rejected tokens. Push acceptance
and inbox read status are different states. Private alert mode uses generic lock-screen text. Detailed alert mode shows family
actions; detail/deep-link IDs are still resolved through the authenticated inbox.

Supported categories are completed/reopened chores, due-soon/overdue chores,
calendar sync-health transitions and frame connection status. Timed event alerts never
enter the phone push queue; previously queued `calendar_upcoming` deliveries are
suppressed as `frame_only`, regardless of notification preferences. Paired frames
show a silent, dismissible 20-second animated card ten minutes before a timed event
and again at its start, using fresh complete household-zone calendar coverage.
Event identifiers are deduplicated locally, including across page reloads. Reduced
motion disables animation. Stale/cancelled/removed events cannot announce; phones
never show the card, including a phone opened with `?display=frame`.
Calendar connection-health alerts remain account preferences;
provider calendar refresh also runs through the leased five-minute calendar worker. Frame offline alerts
use a fifteen-minute grace above the five-minute heartbeat write interval. Initial
scans establish a baseline rather than flooding users with historical overdue alerts.

Configure the server-only shared `FAMILY_APNS_TEAM_ID` and `FAMILY_APNS_TOPIC`,
then separate topic-specific key pairs: `FAMILY_APNS_SANDBOX_KEY_ID` /
`FAMILY_APNS_SANDBOX_PRIVATE_KEY` and `FAMILY_APNS_PRODUCTION_KEY_ID` /
`FAMILY_APNS_PRODUCTION_PRIVATE_KEY`. Scope both Apple keys to the actual app topic
(`com.swerved.familyframe`); the sandbox and production keys remain distinct.
Never put either `.p8` key in source or the app. Debug installs use sandbox APNs;
TestFlight/Release uses production, and each installation selects its own environment's
credentials. Legacy `FAMILY_APNS_KEY_ID` / `FAMILY_APNS_PRIVATE_KEY` remain a fallback
for an environment with neither scoped value configured, for existing team-wide keys.
Setting either scoped value requires its complete pair; a partial pair never falls
back to the other environment or the legacy key. Both pairs may be empty to select
the legacy fallback.

The worker and `/api/mobile/status` validate signing in both environments. Incomplete
Apple setup leaves the inbox/scheduler working but takes no push-delivery leases and
reports `pushConfigured:false`. Readiness is separate from iOS permission, token
registration, provider acceptance and actual device delivery. Provider JWTs are cached
in two bounded environment slots, so alternating sandbox and production deliveries
reuse the correct token rather than regenerate it on every send.

### Additive schema upgrade

There are now thirty-six server-owned tables. `schema.sql`, `mobile-schema.sql`,
`notifications-schema.sql`, `child-accounts-schema.sql`, calendar synchronization, daily chores, account Activity, Internet rewards and account deletion owner schemas are applied together by
`npm run db:migrate`. Existing households, calendars, chores and history are retained.
The child upgrade revokes legacy anonymous child sessions and unused child pairing
codes; frame pairing is unchanged. The app login's
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
concurrency, confirmed-email child invitations, provider/parent revocation, sibling isolation, deadline
races, quiet hours, installation ownership, token invalidation, calendar/frame status
and retry checks. Child tests also cover stale-email reservations, role/profile
changes, retired anonymous credentials, repeated migrations and concurrent profile
deletion/session issuance. Integration suites refuse any database not named
`family_frame_tests` and use unique test schemas; never point them at the household
database. A separately provisioned local PostgreSQL 17 database with a trusted local
TLS certificate can be used if the remote test database is unavailable.

### Daily work and account Activity

Daily occurrence definitions retain the assigned child, required flag, instructions,
steps and approval policy when a routine is edited. Only the household's current
local day is materialized automatically. Historical views use existing facts;
administrators need a correction reason to write another day. Completion callbacks
run within the date lock and transaction, so a reward ledger can commit atomically.
Reschedules report both source and target dates in `affectedDates`.

Notification scans use pending occurrences. Submitted chores await parent approval
and do not generate due/overdue alerts. Skips and vacation exceptions suppress
reminders. For an early-morning due time, a lead reminder that would fall on the
previous day is clamped to local midnight. This keeps tomorrow's definitions editable
until the new household day starts instead of freezing them for an early reminder.
The worker never creates missing historical occurrences to manufacture overdue work.

`account-notifications-schema.sql` adds account-owned inbox/read state and preferences.
Phones still have separate push installations/delivery leases, but sign-out or a
second phone does not reset Activity or settings. Legacy preferences migrate by
latest update and deterministic session-ID tie-break; existing account settings win
on reruns. Read state merges across known device inboxes. Both browser and native
access recheck provider sessions and current household membership. Child visibility
uses immutable occurrence ownership, excludes parent-review/enforcement alerts, and
allows only that child's reward/session events. Paired frames cannot read a general
account's Activity. Push text follows the account's alert-details preference; validated
detail/deep-link IDs are returned only from the authenticated inbox endpoint.

## Internet rewards and protected frame controls

Daily required occurrences mint at most one credit per child and household date. Optional or entirely excused lists do not earn a credit. Approval-gated work counts only after approval. Each credit records its source occurrences and policy revision; moving or reopening unfinished source work cannot produce another reward. Credits persist according to the visible carryover policy.

`GET /api/internet` supplies authoritative server time, progress, credits, inventory, sessions and integration health. Device records are separate from frame pairings and mobile sign-ins. Stable Wi-Fi and wired MACs can belong to one device. Children receive their own eligible inventory; only authorized parents receive MAC addresses.

Redemption and parent grants reserve a child and device atomically. Every mutation carries a request UUID; session changes also require `expectedVersion`. Starting, checking, pausing and ending are pending operations. A command being queued is never proof that Internet access changed. Provider reads confirm a bounded policy and reviewed firewall order before a credit is spent. An ambiguous allowance ended before confirmation puts its credit into parent review, with an audited Restore/Consume decision.

Timed sessions count elapsed access, including when a device sleeps. Pause freezes remaining time after blocking is confirmed. All day has a concrete household-midnight expiry, including a 25-hour daylight-saving day, and expires even while paused. Ordinary timed windows that cross an ambiguous clock change are rejected because the gateway schedule cannot encode that distinction safely. The gateway deadline, rather than APNs or an open app, must stop Internet access.

Existing invited adults have no implicit network authority. An administrator explicitly grants `manageChores` and `manageInternet`. A frame cookie permits normal household chores but cannot spend credits or control a network. A signed-in parent or child generates a one-use phone code at `/api/frame-access-codes`; redemption binds a ten-minute authorization to that paired frame. Child scope is limited to its own profile. Tokens remain in memory and expire; the setup claim code is never an administrator unlock.

## UniFi activation boundary

The server adapter uses the official Cloud Connector and a server-only **Site Manager API key** with the intended console ID. No key belongs in an iOS build, a frame, a browser request or this repository. Remote API access does not require router port forwarding. Home-network control works from outside the home; it does not enforce limits on cellular or another Wi-Fi network.

Enrollment remains inactive until a real gateway pilot passes. Keep a permanent, exact Family Frame HTTPS exception above the persistent Internet deny. Apple devices additionally need a permanent APNs transport exception, using Apple's published narrow IPv4/IPv6 ranges on TCP 5223/443. APNs carries notifications for installed apps; that transport cannot be limited to one iOS app. General browsing remains subject to the deny.

A DOMAIN filter or a successful policy readback alone does not prove that a shared CDN is isolated. Required pilot evidence includes Family Frame access while denied, an unrelated site on the shared CDN remaining blocked, IPv4/IPv6, existing connection cutoff, expiry, pause/end, controller/cloud outage, gateway restart, midnight and daylight saving. Apple devices must also receive push while denied. If exact-site isolation fails, use a separately verified management path before enabling blocking.

A reviewed firewall insertion point preserves existing security rules. Policy content/order fingerprints reject drift, and only identified Family Frame policies may be changed. Durable commands serialize provider mutations and reconcile ambiguous writes. Never replace trusted-device blocking with guest hotspot authorization, and never permanently unblock a device while depending solely on a later cloud job to block it again.

References: [UniFi Network 10.6.106 API](https://developer.ui.com/network/v10.6.106/openapi.json), [Cloud Connector](https://developer.ui.com/network/v10.6.106/connectorpost), [Apple APNs network requirements](https://support.apple.com/en-us/102266).

## Account recovery and deletion

Password recovery accepts a same-project recovery code or link and changes the password only after recovery proof succeeds. A normal signed-in session alone cannot authorize that endpoint. Reset signs out other sessions; shared household data remains.

Account deletion is available before household onboarding as well as in Settings. The BFF reauthenticates using the public Auth client; only the Supabase Edge function holds the administrative capability to delete that verified identity. Its cleanup RPC also checks the live provider session, uses a fixed definer search path, and grants EXECUTE only to the Edge service role. Vercel retains no Auth service-role key. Owner transfer and network cleanup guards prevent orphaned households or firewall restrictions. An idempotent tombstone lets an interrupted deletion resume after fresh sign-in. Use synthetic accounts for release tests; never delete the household owner to prove deployment.
