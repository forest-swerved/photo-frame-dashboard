# Family dashboard backend

This backend serves `family.html` on Vercel Node 24. It uses the dedicated Neon database and managed Neon Auth. Household data is available only through this API; browser sign-up alone does not create membership.

Required server environment variables are `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_AUTH_BASE_URL`, `FAMILY_ENCRYPTION_KEY` (standard base64, 32 random bytes), and `FAMILY_BOOTSTRAP_HASH` (SHA-256 hex of a private random claim code). Keep them out of `VITE_*` variables and source control. `VITE_NEON_AUTH_URL` is public provider configuration; the browser client uses the same-origin `/api/auth` gateway.

## Initialize and verify

After verifying the Vercel project link and dedicated database target, run from `dashboard/`:

```sh
node --env-file=.env.local server/migrate.js
node --env-file=.env.local server/verify-schema.js
node --test server/backend.test.js server/calendar-normalize.test.js server/calendar-normalize-bounded.test.js server/icloud-caldav.test.js
```

The migration changes only twelve `family_*` tables. Each has RLS enabled, no browser policies, and no PUBLIC privileges. The owning server role retains access; managed `neon_auth` tables are not modified.

Database race tests require a separate database named **`family_frame_tests`** and an ignored `.env.test.local`. They refuse any other database before DDL. Each run creates and removes only its own random schema:

```sh
FAMILY_RUN_DB_TESTS=1 node --env-file=.env.test.local --test server/backend.integration.test.js
```

## Sign-in and household access

The pinned `@neondatabase/auth@0.6.0-beta` client uses the current origin:

```js
const auth = createAuthClient(`${location.origin}/api/auth`);
```

Sign-in/up use `auth.signIn.email()` / `auth.signUp.email()`. Obtain a transient bearer with `const { data, error } = await auth.token()` and `data.token`; do not save copies in browser storage. Keep fetch credentials `same-origin`.

The gateway allows only email sign-up/sign-in, sign-out, get-session, and token endpoints. It preserves the actual application origin for Neon trusted-origin checks. Configure the deployed application origin in Neon Auth before live sign-in. It rewrites only the official Neon cookie namespace to first-party Secure HttpOnly cookies using the pinned SDK cookie utilities, and rejects upstream redirects.

Every phone API request verifies the signed JWT issuer, audience, expiry and signature, then reads current household membership. Every phone mutation also validates the opaque provider cookie through fresh `get-session?disableCookieCache=true` and matches its user to the JWT subject. Membership revocation takes effect on subsequent requests. A signed-out JWT may remain valid for reads until its provider expiry (normally 15 minutes); it cannot authorize mutations without the fresh session cookie. The backend does not invent a JWT session ID.

The private bootstrap code can claim the single household exactly once and creates its administrator atomically. Admins create single-use invitations for manual sharing. No invitation emails are sent by this application. People profiles are display names and are separate from authenticated accounts.

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
