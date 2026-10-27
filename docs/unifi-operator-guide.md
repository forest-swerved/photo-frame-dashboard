# UniFi enrollment and pilot control

Family Frame Internet control remains inactive until a parent supplies the
devices' stable addresses, connects the official Cloud Connector API, installs
the reviewed policies, and records the actual gateway tests below. Adding a
device in the app does not block it or enroll it.

The operator CLI **never creates, changes, orders, or deletes a UniFi policy**.
It reads official API inventory, prints exact installation plans, records
explicit test evidence, and can update the dedicated database's readiness
records. Manual policy installation is a separate supervised step in UniFi.
No household was enrolled by the implementation tests.

## Requirements

- Use the dedicated `family_frame_server` connection and verified TLS CA. The
  tool rejects an administrative or broadly privileged database login.
- Keep the database URL and `FAMILY_UNIFI_API_KEY` in a private environment file,
  never command-line arguments, Git, screenshots, or evidence notes. The
  console identity is `FAMILY_UNIFI_CONSOLE_ID`. Never expose the gateway to the
  public Internet or use a legacy controller cookie/session.
- Identify the correct home site, source device zone, and external Internet
  zone. Controls apply to the home network even when a parent is elsewhere.
  They do not apply on hotel Wi-Fi or cellular.
- In each physical device, disable address randomization for the home SSID.
  Record its Wi-Fi and Ethernet identities together in one Family Frame device.
  Check every address on its actual network connection. A device may have
  separate stable identities on different home SSIDs.
- Keep independent local gateway access from an unmanaged parent computer.
  Save the original policy order and have a parent present with the test
  device. The first block is a short, gateway-expiring pilot on that one device.
- Finish or end all household Internet sessions and confirm blocking before
  starting enrollment. Enrollment is not an emergency repair path for an
  ambiguous live allowance.

The app's permanent exact-host HTTPS exception must survive every pause, end,
midnight, and reward expiry. Apple devices also need the separately tested
permanent APNs transport when that option is enabled. APNs is a transport shared
by installed Apple apps; it cannot be limited to Family Frame alone.

## Inspect without writes

Run from `dashboard/`. The example environment file is private and ignored; it
must use the server database role, not a Supabase service-role key. The CLI
does not use a Supabase service-role key.

```sh
node --env-file=.env.operator.local server/internet-operator.js inventory
```

Without a configured UniFi key this returns an explicit inactive state and the
saved device inventory. With the connection configured, it lists the console's
sites. Add `--site SITE_UUID` to list zones. Add both `--source-zone SOURCE_UUID`
and `--external-zone EXTERNAL_UUID` to inspect policies and their current order.
Replace these uppercase placeholders with the UUIDs returned by inventory.

Set task-specific shell variables using those reviewed values:

```sh
task_device='DEVICE_UUID'
task_site='SITE_UUID'
task_source='SOURCE_ZONE_UUID'
task_external='EXTERNAL_ZONE_UUID'
task_before='REVIEWED_EXISTING_POLICY_UUID'

node --env-file=.env.operator.local server/internet-operator.js plan \
  --device "$task_device" --site "$task_site" \
  --source-zone "$task_source" --external-zone "$task_external" \
  --before "$task_before"
```

The current Network Integration API returns separate `beforeSystemDefined` and
`afterSystemDefined` custom-policy arrays. Review an explicit custom policy UUID
in the first group, or use `--before system` to insert immediately before the
built-in rules. Both groups retain foreign policy membership and relative order;
built-in IDs never enter the ordering PUT. Family Frame ALLOW rules explicitly
exclude INVALID connection states, preserving the gateway's built-in invalid
traffic block. Review the complete plan before changing UniFi.

The plan includes exact management, optional APNs, and deny request bodies, the
grouped addresses, required checks, content/order fingerprints, and the Network
application version. It contains no API key. Keep real inventory and generated
plans private because they contain device addresses and local policy details.

## Enter a supervised pilot

First make a dry run, then explicitly confirm the owner-record change:

```sh
node --env-file=.env.operator.local server/internet-operator.js begin-pilot \
  --device "$task_device" --site "$task_site" \
  --source-zone "$task_source" --external-zone "$task_external" --before "$task_before"

node --env-file=.env.operator.local server/internet-operator.js begin-pilot \
  --device "$task_device" --site "$task_site" \
  --source-zone "$task_source" --external-zone "$task_external" --before "$task_before" \
  --apply --confirm-device "$task_device"
```

This writes no network policy. It gates new household Internet starts, clears
integration pilot flags, and marks previously ready devices as needing review.
The transaction refuses to proceed while any nonterminal household session
exists. This matters because adding policies changes every device's reviewed
foreign inventory. An active session must never be stranded behind an obsolete
ordering fingerprint.

Install only the permanent management exception first, using its emitted body
and reviewed insertion point. Install the APNs exception too when enabled. Do
not enable the default deny yet. Read back both exceptions with `inspect` and
their actual API-assigned identities:

```sh
task_management='MANAGEMENT_POLICY_UUID'
task_apple='APNS_POLICY_UUID'

node --env-file=.env.operator.local server/internet-operator.js inspect \
  --device "$task_device" --site "$task_site" \
  --source-zone "$task_source" --external-zone "$task_external" --before "$task_before" \
  --management-policy "$task_management" --apple-policy "$task_apple"
```

Omit `--apple-policy` for devices without the APNs option. Require verified
management/notification content and placement. A matching description is
insufficient; the tool compares the full managed request content.

## Record actual observations

The tool records **named operator attestations**, not automated proof that a
physical device behaved correctly. Never label a hypothetical, scheduled,
simulated-only, or unperformed home-gateway check as a pass. Implementation
tests use synthetic fixtures and cannot satisfy these checks.

Keep screenshots, command output, or a written test report in a private file.
Only its SHA-256 digest is stored in household audit history; file contents are
not uploaded. Notes must not include passwords, API keys, pairing tokens,
private calendar details, or credential-bearing URLs.

Record `identity_stability`, then `management_preflight`. Preflight must occur
while the device's deny is absent or disabled, after reading back its permanent
exceptions and reaching Family Frame on each actual saved identity.

```sh
node --env-file=.env.operator.local server/internet-operator.js record-proof \
  --device "$task_device" --site "$task_site" \
  --source-zone "$task_source" --external-zone "$task_external" --before "$task_before" \
  --management-policy "$task_management" --apple-policy "$task_apple" \
  --check management_preflight --result pass --operator 'Actual parent name' \
  --observed-at 'ACTUAL_ISO_TIMESTAMP' \
  --summary 'Actual observations from this device, identities and network.' \
  --evidence /private/path/to/actual-evidence.txt
```

Without `--apply` this only prints a proposed record. After verifying the result,
repeat with `--apply --confirm-device "$task_device"`. Record `fail` whenever a
performed check fails. The latest record for a check and configuration wins,
including failures. Observations must be within 24 hours at activation.

## Install a bounded pilot

After both preflight receipts exist, `pilot-plan` prints a device-specific deny
with a concrete one-time window of at most five minutes. It refuses the initial
pilot near household midnight or an ambiguous daylight-saving clock change.

```sh
node --env-file=.env.operator.local server/internet-operator.js pilot-plan \
  --device "$task_device" --site "$task_site" \
  --source-zone "$task_source" --external-zone "$task_external" --before "$task_before" \
  --management-policy "$task_management" --apple-policy "$task_apple"
```

Manually install that exact short deny below management/APNs and above the
reviewed anchor. Its gateway schedule provides a recovery deadline even if the
operator's computer or controller loses contact. Capture its actual identity
as `task_deny='DENY_POLICY_UUID'` and include `--deny-policy "$task_deny"` in all
subsequent commands. Do not reuse the expired pilot on a later day.

Perform and record every check:

| Check | Required real observation |
| --- | --- |
| `identity_stability` | Physical settings and each Wi-Fi/Ethernet connection match the grouped fixed identities; none rotates or duplicates another device. |
| `management_preflight` | Permanent management/APNs exceptions are read back in the reviewed position, and Family Frame is reachable before the first block. |
| `management_access` | Family Frame website and iOS API remain usable from the blocked device, including refresh, sign-in and required family actions. |
| `unrelated_internet_blocked` | Unrelated web/app traffic cannot reach the Internet while the block applies. Test relevant protocols, including QUIC, rather than just one browser page. |
| `shared_cdn_isolation` | Another unrelated site on the same shared CDN infrastructure is blocked. An IP-wide exception that opens unrelated sites is a failure. |
| `expiry` | A short test allowance expires at its gateway deadline and the device is blocked again without an app, foreground timer or successful cloud cron. |
| `existing_connections` | Connections opened before a pause/end or deadline cannot continue unrestricted afterward. |
| `ipv6` | Both IPv4 and IPv6 follow the intended management exception, allowance and default block. |
| `controller_outage` | A scheduled allowance still ends and management access remains correct when the controller/Cloud Connector is unavailable. |
| `gateway_restart` | A gateway restart preserves the permanent exceptions, default block and remaining concrete expiry behavior. |
| `midnight` | The intended one-time schedule works across household midnight; an all-day window ends at its specified midnight and cannot roll into another day. |
| `dst` | The installed gateway's concrete all-day behavior is verified through the relevant daylight-saving transition; ambiguous timed windows are refused. |
| `apple_push` | When enabled, Family Frame notifications arrive over the permanent Apple transport while other Internet traffic remains blocked. |

Expiry/outage/restart tests require a short, separately supervised temporary
ALLOW inside a still-active deny. Keep its end earlier than the pilot deny's
recovery deadline. Remove all temporary test allowances and restore the reviewed
policy inventory before recording final receipts. Do not add an untracked
session-looking rule to the application database or exempt it by description.

Time-dependent tests need actual evidence on the installed gateway. Do not
change a production router's clock or invent a future pass to get past the gate.
If a check cannot be verified safely, leave that device inactive. A successful
curl, API response, or unit test does not prove the physical packet behavior.

## Finalize the reviewed default block

When all required current receipts pass, `permanent-plan` prints the exact
permanent deny body. Manually replace only the tested deny, retaining its
identity and the permanent exceptions. Then `activate` reads back the complete
inventory and order again:

```sh
node --env-file=.env.operator.local server/internet-operator.js activate \
  --device "$task_device" --site "$task_site" \
  --source-zone "$task_source" --external-zone "$task_external" --before "$task_before" \
  --management-policy "$task_management" --apple-policy "$task_apple" --deny-policy "$task_deny"
```

This is a dry run. Only after reviewing it, repeat with
`--apply --confirm-device "$task_device"`. Activation writes the exact verified
policy IDs, reviewed order/content fingerprint, and readiness timestamps. It
does not modify UniFi. Only explicitly verified devices become ready; other
devices stay unenrolled or require attention.

For several devices, finish the intended final policy layout while the
household gate is closed. Any changed foreign policy, placement, application
version, hostname, identity or assignment can invalidate receipts. Recheck
invalidated evidence rather than editing the audit history or bypassing the
gate. Finalize each device before allowing household sessions; activation still
refuses while any session is nonterminal. A later `begin-pilot` deliberately
gates all devices again.

After a gateway/Network update, policy edit, address change, new SSID, or failure,
end active sessions and start a new supervised review. Never rebase stored
fingerprints just to silence an error. The application worker separately checks
the permanent exceptions, full foreign inventory, session fingerprints and
order before allowing or blocking a session.

## Verification of the implementation

```sh
cd dashboard
FAMILY_RUN_DB_TESTS=1 node --env-file=.env.test.local --test \
  server/internet-operator.test.js server/internet-operator.integration.test.js
```

These tests use a disposable local TLS database and a fake provider whose write
methods throw. They verify confirmation, role restriction, staged gates,
required evidence, failure precedence, foreign drift, transaction races, APNs
readiness, and exact policy fingerprints. No provider API or live database is
changed by that test suite.

The adapter and emitted request bodies follow the [official Network 10.6.106
OpenAPI](https://developer.ui.com/network/v10.6.106/openapi.json), including the
documented `/v1/info` application version and one-time schedule fields. The
[Cloud Connector documentation](https://developer.ui.com/site-manager-api/cloud-connector)
describes the remote transport. Console compatibility and physical enforcement
still require the recorded gateway pilot above.
