# Family Frame for iPhone and iPad

Native SwiftUI app, iOS 17+, using the same dedicated Swerved Family Frame API and household as the web dashboard and physical frame. No production credentials, family data, or APNs private keys are bundled. The interface follows the dashboard's bright Swerved light theme.

## Implemented

- Today with household progress and a section for every actual person, including empty sections. Chores supports profile filters, repeating weekdays, assignment, due times in the household timezone, reminder lead time, and admin create/edit/delete.
- Shared calendar for the next two weeks, including multi-day all-day events and overnight events. Calendar connection and parent invitations link to the existing web setup.
- Shared parent/child email-and-password sign-in, native account creation, emailed confirmation codes and resend, followed by an opaque mobile-session exchange. A parent creates an invitation bound to a child's real email and chore profile; only that verified account can accept it.
- Activity inbox, mark-as-read, notification category preferences, quiet hours, parent-created child account invitations, device revocation, and own-session sign-out.
- iOS notification permission, APNs registration delegate, stable installation UUID in Keychain, authenticated token registration, separate sandbox/production configuration, and server-readiness status. Registration and permission are shown separately from server configuration.
- Pull-to-refresh and foreground refresh. Cached household/calendar/activity is clearly marked stale on startup/offline, and completion changes remain paused until a current household refresh. A completion sends its server version and a new mutation UUID. Conflicts are never automatically overwritten or replayed with a newer version.

## Open and build

`FamilyFrame.xcodeproj` is checked in. No Swift package or other third-party runtime dependencies are required. `project.yml` is the source for regenerating the project with XcodeGen when adding files or changing project settings.

```sh
open ios/FamilyFrame.xcodeproj
```

The checked public configuration is `Config/FamilyFrame.xcconfig`:

- Bundle ID: `com.swerved.familyframe` (confirm availability under the selected Apple Developer team; the backend's Swerved account does not determine the signing team).
- API host: `forest-family-frame.vercel.app`.
- No development team is selected. Add the actual team in Xcode's Signing & Capabilities or an ignored `Config/Local.xcconfig` containing `DEVELOPMENT_TEAM = <your team ID>`.
- Debug requests the APNs `development` entitlement and sends `sandbox`; Release requests `production`. Build settings alone do not prove the signed result: an archive can be development-signed despite its Release configuration. Verify that the exported app's code entitlements, embedded provisioning profile, and `FamilyAPNSEnvironment` agree. Ad hoc and TestFlight distribution use production APNs; development-signed builds use the `development` entitlement and send `sandbox`.

A simulator build does not need a signing team:

```sh
cd ios
xcodebuild -project FamilyFrame.xcodeproj -scheme FamilyFrame \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO build
```

Run the model and client-contract tests on an available simulator (substitute its actual ID from `xcrun simctl list devices available`):

```sh
xcodebuild -project FamilyFrame.xcodeproj -scheme FamilyFrame \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_UUID>' \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  -derivedDataPath build/SignedSimulator CODE_SIGN_IDENTITY=- test
```

Use local ad-hoc simulator signing (`CODE_SIGN_IDENTITY=-`) for the tests: Keychain integration tests need an application identity even though they do not require an Apple Developer team.

To regenerate the project after editing `project.yml`, run `xcodegen generate` from this folder. Regenerate the original vector app icon with `swift scripts/make-app-icon.swift FamilyFrame/Assets.xcassets/AppIcon.appiconset/AppIcon.png` on macOS.

## Authentication and local protection

Account onboarding uses a memory-only URLSession cookie store for the gateway's email/password or signup/confirmation → `/api/auth/token` → optional `/api/join` → `/api/mobile/sessions` sequence. Redirects are refused, requests stay on the configured HTTPS origin, and login cookies are cleared after the mobile exchange succeeds or onboarding is canceled. An account awaiting email confirmation or a household invitation retains only that ephemeral in-memory cookie jar. Passwords and provider JWTs are never written to app storage. Subsequent requests use `Authorization: FamilyMobile <opaque token>` and the canonical Origin. Parents create email/profile-bound child invitations through `/api/invites` with role `child`, the chosen `personId`, and the child's actual email. The child signs in or signs up with their own email, confirms it, and accepts the invitation through `/api/join`. The server verifies the authoritative confirmed email and derives the mobile role/profile; the client never assigns its own privileges. Accounts without household membership remain in Join your family and receive no mobile credential. The UI shows a child only their own assigned chores. Anonymous child code pairing is retired; the physical frame's pairing remains separate.

The mobile credential and current session metadata use Keychain `WhenUnlockedThisDeviceOnly`. The installation UUID has its own Keychain item; it survives local sign-out so server token registration remains tied to the same installation. If the server explicitly returns `installation_conflict`, the app rotates the Keychain installation UUID and retries registration once; other errors are not silently retried. No secrets use UserDefaults. Cached data is scoped to the authenticated principal, written atomically with complete file protection, and excluded from device backups. Sign-out clears the credential and cache, requests server revocation, and removes delivered notifications. If revocation cannot reach the server, the app explicitly reports that only local sign-out is confirmed. App-switcher snapshots are covered when the scene is inactive.

Offline data is for reading. The app does not queue background mutations or infer that a timed-out write failed. It pauses changes after an uncertain response and asks the user to refresh before trying again. This avoids silently marking the wrong occurrence or forcing an old state over another family member's update.

## Account deletion is a release prerequisite

Native account creation is implemented. In-app account deletion initiation and server-side fulfillment are not implemented yet and must be completed before requesting external review. Apple's account-deletion requirement applies to apps that support account creation. Device sign-out/revocation is already available; account deletion remains a separate required release feature. Implement actual deletion/revocation and appropriate data handling rather than a support-email or disabled placeholder. [Apple's account deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/).

## Signing and distribution

A simulator build and tests do **not** establish distribution or push delivery. Use the intended Apple Developer team, enable Push Notifications, and provision the chosen bundle ID. Keep APNs authentication keys and their Key ID / Team ID / topic only in the server environment; never add a `.p8` file to the app, Git, or an xcconfig. Follow the backend's documented environment names for separate sandbox and production keys, and configure the server scheduler. App Settings reads `/api/mobile/status` to show server readiness separately from device permission and registration.

- **Private registered-device installation:** export the archive with Xcode's `release-testing` method for ad hoc distribution. Every intended iPhone/iPad UDID must be registered and included in the exported app's provisioning profile. Verify the exported signature and matching production APNs configuration before installing; installing the raw archive is not equivalent. This route does not establish TestFlight availability.
- **TestFlight:** create the App Store Connect app record, validate and upload the distribution build, complete app/privacy/export metadata, and request external beta review. Complete account deletion, the privacy policy and its in-app link, accurate export-compliance declarations, and isolated reviewer access/data before external review. Invite family testers after approval. TestFlight builds expire after 90 days; continued household use needs maintained releases or another approved distribution route.

On physical iPhones/iPads, verify parent/child signup, email delivery/confirmation, email-bound invitation acceptance, sign-in, permissions, each enabled notification category, notification-open refresh, quiet hours, token rotation, device revocation, and closed-app receipt. Server acceptance, device delivery, and the person reading an alert are separate proof states.

Alerts are standard UserNotifications alerts with private generic lock-screen content; detailed information is fetched in the authenticated Activity inbox. The app does not bypass Focus or use Critical Alerts. APNs and iOS are best-effort, so exact alarm-clock delivery times cannot be guaranteed. Scheduled due/overdue work runs on the server, not in unreliable iOS background timers.

Official references: [APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns), [notification permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications), [APNs server authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), [sending APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), [background-push limits](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app), [TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/), [current App Store SDK floor](https://developer.apple.com/news/upcoming-requirements/?id=04282026a).

## Verification boundary

Test fixtures exist only in the unit-test target and never appear in the shipped interface. Simulator tests, live sign-in, provider acceptance, physical receipt, and TestFlight distribution are separate checks.

Local verification on 2026-10-17: Xcode 27 simulator build passed; 21 model/client/Keychain tests and two native entry UI tests passed, covering role-derived account exchange, signup/confirmation, invitation acceptance before mobile access, and shared parent/child email entry. The simulator app launched and its bright sign-in layout was visually inspected. The account creation UI test types a reserved test-only email but never submits an account or invitation.

Physical verification on 2026-10-17: a distribution-signed `release-testing` export passed signature, provisioning, and matching production APNs checks. It installed and launched on the owner's provisioned iPhone. Live parent sign-in and production push registration succeeded; Apple returned HTTP 200 for one generic test alert, and the owner confirmed receiving it. This does not establish native calendar rendering or completion of every dashboard flow.

Still to verify: actual chore completion, due-soon and overdue notifications, closed-app receipt, and children's email-account onboarding when their addresses are available. TestFlight upload and external review remain pending, including account deletion, privacy policy/link, export-compliance metadata, and isolated reviewer data/access.
