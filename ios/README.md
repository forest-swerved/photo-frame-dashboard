# Family Frame for iPhone and iPad

Native SwiftUI app, iOS 17+, using the same dedicated Swerved Family Frame API and household as the web dashboard and physical frame. No production credentials, family data, signing team, or APNs private keys are bundled. The interface follows the dashboard's bright Swerved light theme.

## Implemented

- Today with household progress and a section for every actual person, including empty sections. Chores supports profile filters, repeating weekdays, assignment, due times in the household timezone, reminder lead time, and admin create/edit/delete.
- Shared calendar for the next two weeks, including multi-day all-day events and overnight events. Calendar connection and parent invitations link to the existing web setup.
- Native parent email/password sign-in through the existing first-party auth gateway, followed by an opaque mobile-session exchange. Children pair through a parent's temporary one-use code without an email account.
- Activity inbox, mark-as-read, notification category preferences, quiet hours, parent device revocation, and own-session sign-out.
- iOS notification permission, APNs registration delegate, stable installation UUID in Keychain, authenticated token registration, separate sandbox/production configuration, and server-readiness status. Registration and permission are shown separately from server configuration.
- Pull-to-refresh and foreground refresh. Cached household/calendar/activity is clearly marked stale on startup/offline, and completion changes remain paused until a current household refresh. A completion sends its server version and a new mutation UUID. Conflicts are never automatically overwritten or replayed with a newer version.

## Open and build

`FamilyFrame.xcodeproj` is checked in. No Swift package or other third-party runtime dependencies are required. `project.yml` is the source for regenerating the project with XcodeGen when adding files or changing project settings.

```sh
open ios/FamilyFrame.xcodeproj
```

The checked public configuration is `Config/FamilyFrame.xcconfig`:

- Suggested bundle ID: `com.swerved.familyframe` (confirm availability under the actual Swerved Apple Developer team).
- API host: `forest-family-frame.vercel.app`.
- No development team is selected. Add the actual team in Xcode's Signing & Capabilities or an ignored `Config/Local.xcconfig` containing `DEVELOPMENT_TEAM = <your team ID>`.
- Debug uses the APNs `development` entitlement and sends `sandbox`; Release uses `production` for both. TestFlight builds use production APNs.

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

The parent login uses a memory-only URLSession cookie store for the gateway's email/password → `/api/auth/token` → `/api/mobile/sessions` sequence. Redirects are refused, requests stay on the configured HTTPS origin, and login cookies are cleared afterward. Parent passwords and provider JWTs are never written to app storage. Subsequent requests use `Authorization: FamilyMobile <opaque token>` and the canonical Origin. Child pairing uses `/api/mobile/pairings/redeem`; child authorization is enforced on the server and the UI shows their own assigned chores.

The mobile credential and current session metadata use Keychain `WhenUnlockedThisDeviceOnly`. The installation UUID has its own Keychain item; it survives local sign-out so server token registration remains tied to the same installation. If the server explicitly returns `installation_conflict`, the app rotates the Keychain installation UUID and retries registration once; other errors are not silently retried. No secrets use UserDefaults. Cached data is scoped to the authenticated principal, written atomically with complete file protection, and excluded from device backups. Sign-out clears the credential and cache, requests server revocation, and removes delivered notifications. If revocation cannot reach the server, the app explicitly reports that only local sign-out is confirmed. App-switcher snapshots are covered when the scene is inactive.

Offline data is for reading. The app does not queue background mutations or infer that a timed-out write failed. It pauses changes after an uncertain response and asks the user to refresh before trying again. This avoids silently marking the wrong occurrence or forcing an old state over another family member's update.

## Push setup still requires Apple account configuration

A simulator build and tests do **not** establish TestFlight distribution or end-to-end push delivery. Completing the app's installable family beta requires:

1. An active Apple Developer Program team and App Store Connect app record with the chosen bundle ID.
2. Push Notifications capability and provisioning for that actual team.
3. APNs authentication key and its Key ID / Team ID / topic configured only in the server environment. Never add a `.p8` file to the app, Git, or an xcconfig. Follow the backend's documented environment names. Configure the server scheduler too; app Settings reads `/api/mobile/status` and shows missing setup.
4. Archive a signed Release build, validate it, upload it to App Store Connect, complete required app/privacy/export metadata, and submit the external beta for Apple's review. Invite the family after the build is approved. TestFlight builds expire after 90 days; permanent household use needs a maintained beta or a later approved distribution route.
5. On physical iPhones/iPads, verify parent/child login, permissions, each enabled notification category, notification-open refresh, quiet hours, token rotation, device revocation, and closed-app receipt. Server acceptance, device delivery, and the person reading an alert are separate proof states.

Alerts are standard UserNotifications alerts with private generic lock-screen content; detailed information is fetched in the authenticated Activity inbox. The app does not bypass Focus or use Critical Alerts. APNs and iOS are best-effort, so exact alarm-clock delivery times cannot be guaranteed. Scheduled due/overdue work runs on the server, not in unreliable iOS background timers.

Official references: [APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns), [notification permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications), [APNs server authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), [sending APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), [background-push limits](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app), [TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/), [current App Store SDK floor](https://developer.apple.com/news/upcoming-requirements/?id=04282026a).

## Verification boundary

The development build and client tests are exercised locally without signing in to a real household. Test fixtures exist only in the unit-test target and never appear in the shipped interface. No Apple Developer team is guessed, no live APNs key is generated, and no distribution or physical-device delivery is claimed until those steps are actually completed.

Local verification on 2026-10-17: Xcode 27 simulator build passed; 16 model/client/Keychain tests and two native entry UI tests passed. The simulator app launched and its bright sign-in layout was visually inspected. The child entry test types a synthetic test-only six-digit code but never submits it. No real household sign-in, Apple signing, TestFlight upload, or actual APNs receipt is implied by those results.
