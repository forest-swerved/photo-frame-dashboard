# Set up your family dashboard

The family app has **Today**, **Calendar**, **Chores**, and **Setup** screens. It uses your
household's actual data, with no sample family, events, weather, or home-security status.
The same app adapts to a phone and a 1280 × 800 frame.

The dashboard uses Swerved Stack's light palette: white surfaces, dark text, red actions,
and bright cyan, lime and magenta accents. It keeps that appearance at every hour, with no
automatic night dimming.
Screen brightness is controlled separately in Android Settings; choose manual brightness
and set it to 100% to keep the frame at full brightness.

Verification snapshot: **2026-10-16**. The family app is deployed on Vercel with a dedicated
Swerved Supabase project for its database and sign-in. The checks below distinguish hosted
application results from the remaining physical-frame checks.

## 1. Create your administrator account

After the dashboard's HTTPS address is deployed and verified:

1. Open that address on your phone and choose **Create an account**.
2. Enter your name, email, and a password of at least 12 characters for this dashboard. If confirmation is required,
   the app shows **Confirm your email**. Enter the code from the confirmation email, or choose
   **Paste link** and paste its full confirmation link. The app submits that link to its own
   server for verification; it does not navigate to it. **Resend confirmation email** requests
   another message. If you already followed the email link, return to **Back to sign in**.
3. Under **Set up your household**, enter a household name and the private setup code supplied
   separately by the person configuring the app. Submit **Create household**.

The setup code can claim the household only once. Creating a sign-in account alone does not
grant access to family data. Keep the setup code out of chat, screenshots, source files, and
shared links.

The setup code can be a short PIN configured by the person setting up the dashboard.
For a short PIN, bind setup to the intended confirmed account with the server-only
`FAMILY_BOOTSTRAP_USER_ID` setting. The account password and emailed confirmation code
remain separate from this one-use household setup code.

Account passwords, email confirmation codes, and confirmation links belong only in the app's
forms. The browser does not save them or authentication tokens in local/session storage.
Phone sign-in uses server-managed first-party HttpOnly cookies; signing in does not require
opening a provider's page or connecting the browser directly to Supabase.

In **Setup → Your household**, confirm the household name and timezone. The initial timezone
is `America/Denver`; calendar display times and recurring chore dates use this setting.

## 2. Add family profiles and chores

In **Setup → Family profiles**, add each person's name and color. Profiles are for assignments;
they do not create sign-in accounts. You can assign a chore to a profile or to **Anyone**.

In **Chores**, choose **Add a chore**, enter its title and assignee, and select the weekdays on
which it repeats. Administrators can edit or delete recurring chores and profiles. Deleting a
profile leaves its chores unassigned. Deleting a chore retains its earlier completion history.

Each day has its own completion. Tap a chore to complete it; tap it again to reopen it. The
app shows **Saving…** until the server replies. A failed save is not confirmed. If another
device changed the chore, the latest state appears with an explicit **Retry my change** action.
Other open devices refresh their shared state periodically, approximately every 20 seconds.

## 3. Connect your private Apple Calendar

Use **Setup → Apple Calendar** on an administrator's phone:

1. At [account.apple.com](https://account.apple.com/), open **Sign-In and Security →
   App-Specific Passwords** and generate a password for this dashboard. Apple requires
   two-factor authentication for this feature. See [Apple's instructions](https://support.apple.com/en-us/102654).
2. In the dashboard's **Apple Account email** and **App-specific password** fields, enter your
   Apple email and the generated password. Choose **Connect Apple Calendar**.
3. After discovery succeeds, select the calendars to display and choose **Save calendar
   selection**. An account may return only the calendars it has permission to access.
4. Open **Calendar**, choose Day, Week, or Month, and check the sync status.

Enter the app-specific password **only in the dashboard UI**. Use the generated password
rather than your main Apple Account password. The form sends it privately to the server and
clears the password field after the response. Saved connection credentials are encrypted on
the server; the frame receives calendar events, never the Apple credentials. A public calendar
link is not required.

Calendar access is read-only in this app. Create and edit events in Apple Calendar. The frame
does not claim a day is empty until a successful, complete sync covers that day. Failed refreshes
can retain the last good events with an out-of-date warning. **Refresh** requests a fresh sync
for an administrator; normal reads may use a recent cached result.

To remove the connection and its cached events, choose **Disconnect Apple Calendar** in Setup.
You can also revoke the generated password in your Apple Account. Changing your main Apple
password revokes app-specific passwords, so reconnect with a new one if needed.

## 4. Add family members' phones

The administrator chooses **Setup → Invite family → Create an invitation**, then shares the
link privately. Invitations are single-use and currently expire after 24 hours.

Each recipient opens the link, creates their own account or signs in, and submits **Join
household**. An invitation token or link can also be pasted into the join form. Generate a
separate invitation for each person.

Invited members can view the shared calendar and complete or reopen chores. The administrator
manages recurring chore definitions, profiles, connections, invitations, and frame access.
Use **Remove** beside a member in Setup to revoke that person's household access.

Once the cloud deployment works, phones use the same HTTPS address on home Wi-Fi or mobile
data. A computer at home does not need to stay awake. Internet access is required for sign-in,
calendar refreshes, and saving shared changes; this version does not queue offline edits.

## 5. Pair the PF1007L frame

Prepare the hardware using [PF1007L: start here](pf1007l-start-here.md), then follow the
[kiosk guide](../dashboard/kiosk/README.md). A stock PF1007L WebView can be too old; the app's
build targets WebView 106. Confirm your particular frame's version, clock, network, and HTTPS
certificate trust before pairing. Preserve a verified backup and a working way back to
Android Settings before device changes.

1. Open `<dashboard-address>/family.html?display=frame` in the frame's kiosk, replacing
   `<dashboard-address>` with the verified HTTPS origin.
2. On the administrator's phone, open **Setup → Pair your frame**, name the frame, and choose
   **Create pairing code**.
3. Enter the six-digit code on the frame and choose **Pair this frame**.

Pairing codes are single-use, expire after 10 minutes, and a newly generated code replaces the
previous active code. Pairing gives the frame calendar-reading and chore-completion access;
administrative changes stay on the administrator's phone. Its session is stored in a
first-party HttpOnly cookie, so use HTTPS and keep kiosk cookies enabled.

In the frame's Setup screen, **Remove this frame connection** disconnects that display. The
administrator can also choose **Revoke** beside a frame in Setup. Pair it again with a new code
if access expires, is revoked, or its cookies are cleared. Power-cycle testing is needed to
confirm that this frame retains its pairing and reopens the dashboard after boot.

## What has and has not been proved

The implementation has passed its production build and regression checks for sign-in state,
calendar coverage, date boundaries, and concurrent chore updates. Local browser checks covered
the real signed-out API flow at **390 × 844** and **1280 × 800**, with no JavaScript errors or
external font/photo requests. Shared-state UI behavior was also exercised with clearly labeled
test fixtures; those checks alone do not establish multi-device behavior.

The deployed HTTPS app also passed a real Supabase test-account flow: confirmation, browser
acceptance of private cookies, rejection of household access before membership, and logout
revocation. Temporary test accounts were removed. Signup's per-flow PKCE cookies and the
confirmation/resend flow were checked separately. The owner then confirmed their actual
account, claimed the household with an account-bound short setup code, and connected a private
Apple Calendar. Live discovery, selected-calendar events, and complete sync coverage were
verified without adding calendar contents or account identifiers to this repository.

Email confirmation uses Swerved's existing Resend account with a dedicated sending key
restricted to the verified sender domain. Configuration readback, certificate-verified SMTP
login, and the owner's actual confirmation succeeded. Password-reset screens are not
configured in this build.

On one PF1007L, the full exposed eMMC user-area backup passed its independent host audit. All 15
segments matched before the guarded boot patch; a full comparison after the write matched
the original backup plus exactly the validated patch plan. Root USB access survived Android
restarts. The complete stock WebView tree was preserved before replacing it with WebView 106;
file readbacks, the new provider after boot, native library loading, JavaScript execution,
and page rendering passed.

The owner selected **Home HQ → Always** and physically tested the two-finger menu,
**Android settings → Apps**, and floating **Back / Dashboard** controls. The three identified
vendor apps were disabled, with their stopped and saved disabled states checked again after
restart; Home HQ started automatically. Home HQ 1.2 is installed; an actual Android keyboard
test verified that the focused field stays visible, with keyboard dismissal, reopening and
full-height restoration.

The frame is now paired. Network access failures on the earlier network cleared after the
owner moved it to an IoT network, and the owner reported it working. Fresh device connectivity,
a nonrevoked frame record and a successful calendar-cache refresh were verified. No additional
proxy or firmware change was needed to resolve the network problem.

The owner confirmed the intended calendar is visible and a real chore updated on both
devices after creating it on the phone and completing it on the frame.

The owner also completed a full power cycle with all USB / power disconnected, the microSD
removed, and the usual power adapter. Automatic dashboard startup, Wi-Fi reconnection,
retained pairing, calendar / saved chore state, and the two-finger menu all returned.

Android manual maximum brightness passed Settings, PowerManager and actual display-controller
readbacks. A further Android restart retained brightness 255 / 255, automatic brightness off,
and automatic Home HQ startup. The Swerved light theme and removal of automatic web dimming
are deployed at the same production address. Production build and eight fixture views across
phone and frame sizes passed without overflow or JavaScript errors; deployed JavaScript and
CSS matched the staged files exactly.

On the actual paired frame, the live page returned healthy responses at 1280 × 800 and had no
brightness filter or overnight dimming class. Its white panels and cyan / lime borders match
the Swerved light theme, with magenta in the palette. Temporary debugging was disabled and
its forwarding rule removed.

## Keep for recovery

Keep the verified backups, the prepared recovery microSD, the complete original WebView tree,
and the recorded undo procedure private. Preserve the fallback launcher and working USB
access. The hardware guides explain the recovery routes; this single frame's results do not
establish compatibility with another firmware build.

Normal dashboard use needs the frame's usual power supply and an Internet connection. The
Mac and its USB data cable are only needed for installation or diagnostics. Manage calendar
connections, profiles, invitations, recurring chores, and paired-frame access from an
administrator's phone; edit calendar events in Apple Calendar.

## iPhone and iPad app

The native Family Frame app is in [ios/](../ios/README.md). Parents use their existing
account; children can pair a phone to their own family profile with a short-lived
code generated by a parent administrator. Each profile has a chore section even
before a chore is assigned. Parents can set a due-by time and early reminder when
adding or editing a chore. Due times follow the household timezone.

The app includes calendar viewing, personal chore lists, an activity inbox,
notification preferences, quiet hours and mobile-device revocation. It distinguishes
stale offline data from confirmed saves. Notifications cover chore completion,
reopening, approaching deadlines, missed deadlines, calendar reminders/sync health
and frame connection status. The backend runs scheduled checks independently of
whether the app is open.

The native app builds and is tested locally. Installing it on family devices and
receiving real Apple push notifications still requires the intended Apple Developer
team, signing, APNs credentials and a distributed build. Follow the iOS guide for the
TestFlight steps; local/simulator checks alone do not establish device delivery.
