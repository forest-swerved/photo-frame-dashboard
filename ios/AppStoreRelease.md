# Family Frame App Store release draft

Reviewed against the native app and current server source on October 17, 2026. This is a preparation checklist, not an App Store submission, approval, reviewer account, or proof of live UniFi enforcement. Do not put real credentials, child emails, owner calendar events, MAC addresses, API keys, or signing keys in this file or screenshots.

## App record and copy

| Field | Draft / action |
| --- | --- |
| App name | Family Frame; confirm availability in App Store Connect |
| Subtitle | Chores, calendars & rewards |
| Primary category | Productivity; confirm before submission |
| Platforms | iPhone and iPad, iOS/iPadOS 17 or later |
| Version / build | 1.0.0 / 2 in the current source; match the final processed archive |
| Developer team | Forest McColley; preserve the local signing configuration |
| Privacy policy URL | `https://forest-family-frame.vercel.app/privacy.html` |
| Support | `family-calendar@swerved.com`; provide an accessible HTTPS support page with this contact in App Store Connect |
| Marketing URL | Optional; omit until a public product page exists |
| Keywords | family,chores,calendar,routines,rewards,household,reminders |
| Copyright | Confirm the rights holder and year before entering |

Description draft:

> Bring your family's day together with shared calendars, clear chore routines, and timely reminders. See what's coming up, give each child their own checklist, and keep parents and children in sync from iPhone, iPad, and a paired household frame.
>
> Add instructions and steps, set due times, approve submitted chores, and plan breaks for holidays. Choose the notifications you want and review recent family Activity. Children use their own accounts and see their assigned work.
>
> Optional Internet-time rewards require a compatible UniFi home network and verified setup. Parents can manage access windows for enrolled devices. Home-network controls apply only on that network; they do not control cellular data or other networks.
>
> An account and household access are required. Apple Calendar is connected by a parent through Family Frame's web setup. Calendar events are edited in Apple Calendar. Notification delivery requires permission and an Internet connection.

Do not advertise Internet control as generally available until the live driver, enrollment, expiry, management-access and recovery pilot has passed. The current app deliberately shows unconfigured or checks-required states until verification. A frame is optional for the companion's calendar and chore views. There are no purchases, subscriptions, advertising, chat, or user-to-public social feed in this build.

Complete Apple's current age-rating questionnaire from actual features and content. Parent controls and child profiles do not automatically make the app eligible for the Kids category; choose that category only after its separate requirements are satisfied. Do not assert a rating before App Store Connect calculates it. See [Apple's child and age-appropriate experience guidance](https://developer.apple.com/kids/).

## Privacy label draft

Answer **Yes, data is collected**. The service stores account-linked household information. All categories below are **linked to the user**, **not used for tracking**, and used for **App Functionality**. No advertising, behavioral analytics, data brokerage, or cross-app tracking is implemented. Account authorization and assigned family content serve the requested feature; there is no recommendation or marketing personalization engine.

| App Store category | Data actually used by this app/service |
| --- | --- |
| Contact Info → Name | Account/display names and parent-created family profile names |
| Contact Info → Email Address | Sign-in, confirmation, recovery, invitation and account identity |
| Identifiers → User ID | Auth user, household membership, child profile and actor IDs |
| Identifiers → Device ID | App installation UUID, APNs token, frame identity and enrolled device MAC addresses; no IDFA |
| User Content → Other User Content | Chore titles/instructions/steps, calendar titles/details/location text, routine and parent-entered reason text |
| Usage Data → Product Interaction | Confirmed chore actions/approvals, reward redemption, parent access actions and Activity read status retained to provide shared state/history |
| Usage Data → Other Usage Data | Network session/device online state, request/start/end times, duration, pauses, reward history and enforcement observations |
| Diagnostics → Other Diagnostic Data | Connection/synchronization/enforcement failures and delivery status used to explain and recover service behavior |
| Other Data → Other Data Types | Notification preferences, quiet hours, roles/capabilities, recurrence/holiday rules, network reward policies and account/session security records |

Calendar content is fetched by the service from the calendars a parent selects; the native app does not read the system Contacts or EventKit store. Apple Calendar connection credentials are entered through web setup and kept encrypted server-side. The app does not collect device browsing history, precise/coarse location, photos, audio, payment information, or advertising/search history. Event location text remains user content; no location permission or GPS lookup is used. Chore instructions are general text, not a structured health or sensitive-information feature. Do not select "Data Not Collected" merely because a particular integration is optional.

This mapping follows [Apple's privacy-label definitions](https://developer.apple.com/app-store/app-privacy-details/). Review provider operational/security logging and any future SDK changes before final entry. Vercel hosts the API, Supabase provides authentication/database, Apple provides APNs and optional iCloud Calendar, and optional UniFi requests go to the configured home-network provider. Their service processing is described on the privacy page. The native target currently links Apple frameworks only; it embeds no third-party analytics or crash-reporting SDK.

`FamilyFrame/PrivacyInfo.xcprivacy` records the above nine data types, no tracking domains and no required-reason API use. It intentionally does **not** claim that no data is collected. Generate an archive privacy report in Xcode Organizer and reconcile it with the App Store Connect answers; the bundled manifest does not submit those answers for you. [Apple manifest guidance](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files) and [data-use keys](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests).

## Required-reason API and encryption review

The October 17 source review found no calls to Apple's listed required-reason APIs: UserDefaults, systemUptime/mach_absolute_time, file timestamp reads, available disk-space reads, or active keyboard enumeration. `SecureStorage.swift` uses Keychain and an app-container JSON cache with Data Protection and backup exclusion; it does not query file timestamps or disk capacity. `InternetModel.swift` measures elapsed time with Swift `ContinuousClock`; that Swift API is not on the current published list. Its elapsed origin stays on the device. New dependencies or API use require another review and an accurate reason rather than copying an arbitrary reason code. [Apple's current API categories](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype).

`Info.plist` sets `ITSAppUsesNonExemptEncryption` to **false**. The native binary uses Apple URLSession HTTPS/TLS, Keychain and OS Data Protection; it implements no cryptography, custom encryption, VPN tunnel or bundled crypto library. This is an OS-encryption-only exemption assessment for the shipped iOS binary, not a statement that connections are unencrypted or that the server performs no encryption. Server-side protection of calendar/push credentials is not cryptographic code bundled in the app.

Apple permits false for exempt encryption and describes OS-provided HTTPS as typically exempt from documentation upload. Reassess if native crypto or dependencies change; complete any country-specific/export obligations prompted by the actual distribution choices. [Apple encryption guidance](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations), [Info.plist key](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption), and [documentation decision guide](https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation/).

## Account deletion and recovery

Signed-in users find **Settings → Delete my account**. A verified account that has not joined a household also has **Delete my account** on the Join-family screen, including after an interrupted deletion. The user enters their current password and `DELETE MY ACCOUNT`, then confirms the destructive action. The server freshly authenticates its own verified email; the client never supplies a deletion target. A confirmed response clears local sign-in/cache. If the response is uncertain, the app asks the person to sign in again and check/retry rather than falsely reporting success.

Deletion removes the login, membership, mobile sessions, push installations, invitations, private Activity and preferences. Shared family records remain with a surviving household, with the departing account/actor identity removed. Final-household deletion removes that household's data and encrypted calendar connection. It does not erase iCloud events or reset physical hardware. The privacy policy explains the minimal interruption-recovery record and provider backup/log retention.

The sole administrator with other members must first use the in-app ownership transfer to an existing adult caregiver. Final-household deletion is blocked while a network session is unfinished or any device remains enrolled, to avoid orphaning network policies. **Release gate for enabled network control:** confirm that a parent can end/reconcile every session and safely unenroll all devices without being forced to contact support. The current enrollment/unenrollment operator tooling is not a self-service app flow. Do not enable a generally available enrollment feature until that safe deletion prerequisite has an accessible path. Review deletion with a disposable isolated household, never the owner's account.

Apple allows intentional confirmation and reauthentication, but expects an easily found full-account deletion path. It does not guarantee acceptance of this app's ownership/network guards. [Apple account-deletion requirements](https://developer.apple.com/support/offering-account-deletion-in-your-app/).

## Isolated App Review provisioning plan

No reviewer account or household has been created by this document. Provision these only in a dedicated review environment/tenant, using the same authorization and current API contract as the submitted build:

1. Create isolated parent, caregiver and child review accounts with dedicated mailboxes controlled for review. Verify them ahead of time so review does not depend on the owner's OTP. Store the credentials only in App Store Connect's private App Review information and an approved secret store. Give Apple enough information to exercise account creation/recovery too; never give Apple an owner session, Supabase admin key, Apple app-specific password or UniFi key.
2. Create synthetic children, chores with steps/approvals/due times, a holiday break, recent Activity, an available credit and a private synthetic calendar. Use a separate test calendar account with no owner events; credentials stay on the server. Keep event dates and chore occurrences current throughout review. Test the child login cannot see parent controls or another child's private network records.
3. Keep hardware independent from the owner's household. For end-to-end Internet control, use a separate lab UniFi site/console, test client identities, configured least-privilege key, and a spare paired frame if demonstrating frame behavior. Complete the same live safety pilot and expiring-window checks. A test row or a simulated success must not claim that provider enforcement occurred. If no reviewed hardware path is available, leave the feature honestly unavailable and resolve full-review access with Apple before submission.
4. Provide a short physical-device video showing the iPhone/iPad app interacting with the review hardware, including pairing and a bounded start/expiry, if the submitted feature depends on that hardware. Explain that remote home-network controls do not use Apple's Screen Time/Family Controls entitlement and cannot block cellular/other networks. A local simulator screenshot does not prove hardware behavior.
5. Supply an additional disposable account/isolated household for account deletion, with no enrolled hardware or other members. Confirm full deletion and the unlinked-account retry path. Keep the main review household available after that account is deleted; do not share a sole review administrator whose deletion destroys all other reviewer access.
6. Write concise private reviewer steps: sign in; Today/Chores; finish a checklist; parent approval; Calendar; Activity/preferences/test push; Devices reward and parent controls; Settings deletion/ownership transfer. Include separate credentials for each role and the expected unconfigured/pilot state if applicable. Never make a reviewer wait for approval from a real child or parent.

Apple requests usable account access and complete instructions/resources, including hardware evidence where needed. [Current complete-review guidance](https://developer.apple.com/help/app-review/before-submitting-for-review/complete-review).

## Final submission checklist

- [ ] Final production API and `/privacy.html` are reachable over HTTPS without sign-in; support contact works.
- [ ] Reviewed archive includes exactly one root `PrivacyInfo.xcprivacy`, correct public API host, version/build, intended team and correct APNs entitlement; no private config, test launch data or diagnostic artifacts are bundled.
- [ ] Export/privacy questions are entered from this reviewed binary/service behavior; Xcode's generated report and App Store Connect labels agree.
- [ ] iPhone and iPad screenshots use only synthetic data, current bright UI and real supported dimensions; no secrets or household names appear. Accessibility labels make only claims verified on physical devices.
- [ ] Current sign-up/confirmation/recovery, role isolation, calendar stale/offline behavior, notifications, deletion/transfer and interrupted-request paths pass against the deployed build.
- [ ] Devices marketing/review scope matches the live pilot and self-service cleanup capabilities; no simulated enforcement is presented as real.
- [ ] Isolated review accounts, synthetic data and any lab hardware are available for the entire review; their secrets are provided only in private review fields.
- [ ] Complete age-rating, rights, availability, pricing, support and reviewer contact fields. Choose manual release until review/acceptance is complete.
- [ ] Upload/processing success, TestFlight availability, App Review approval and public release are recorded as separate states.
