import XCTest
import SwiftUI
import UIKit
@testable import FamilyFrame

enum InternetFixtures {
    static let time = "2026-10-17T18:00:00Z"
    static let child = "synthetic-child"
    static let device = ManagedInternetDevice(id: "synthetic-console", name: "Synthetic console", kind: "console", personIds: [child], macAddresses: ["02:00:00:00:00:01"], version: 1, controlState: "ready", online: true, lastSeenAt: time, managementAccessVerifiedAt: time, defaultAccess: "blocked", desiredAccess: "blocked", observedAccess: "blocked", accessVerifiedAt: time, accessPending: false, rewardAvailable: true)
    static func credit(status: String = "available", id: String = "synthetic-credit", person: String = child, earnedDate: String = "2026-10-17") -> RewardCredit { RewardCredit(id: id, personId: person, earnedDate: earnedDate, minutes: 60, status: status, expiresAt: "2026-10-25T06:00:00Z", policyVersion: 1) }
    static func progress(required: Int = 9, completed: Int = 9, date: String = "2026-10-17") -> RequiredChoreProgress {
        RequiredChoreProgress(personId: child, date: date, requiredCount: required, completedCount: completed, pendingApprovalCount: 0, remainingCount: required-completed, eligible: required>0 && completed==required, occurrenceIds: [])
    }
    static func session(state: String = "active", version: Int = 1, observed: String = "allowed", end: String? = "2026-10-17T19:00:00Z", allDay: Bool = false, person: String = child, credit: String? = "synthetic-credit", remaining: Int = 1800) -> InternetSession {
        InternetSession(id: "synthetic-session", personId: person, deviceId: device.id, creditId: credit, source: credit == nil ? "parent" : "reward", state: state, version: version, desiredState: ["paused", "pausing", "ending", "ended"].contains(state) ? "blocked" : "allowed", observedState: observed, requestedAt: time, startedAt: state == "starting" ? nil : time, endsAt: end, remainingSeconds: remaining, verifiedAt: observed == "unknown" ? nil : time, endedAt: state == "ended" ? time : nil, reason: nil, lastError: nil, allDay: allDay)
    }
    static func snapshot(role: String = "child", credits: [RewardCredit] = [], sessions: [InternetSession] = [], integration: String = "ready", manage: Bool? = nil, scheduleSupport: InternetScheduleSupport? = nil, progress: [RequiredChoreProgress] = [], serverTime: String = time) -> InternetSnapshot {
        InternetSnapshot(serverTime: serverTime, timezone: "America/Denver", role: role, capabilities: ParentCapabilities(manageChores: manage ?? (role == "admin"), manageInternet: manage ?? (role == "admin")), integration: InternetIntegration(state: integration, managementHost: "frame.test", managementAccessVerifiedAt: integration == "ready" ? time : nil, lastCheckedAt: time, error: nil, scheduleSupport: scheduleSupport), policies: [RewardPolicy(personId: child, version: 1, rewardMinutes: 60, carryoverDays: 7, dailyLimitMinutes: 180, bedtime: "21:00", warningMinutes: 5, enabled: true)], credits: credits, devices: [device], sessions: sessions, progress: progress)
    }
}

@MainActor
final class InternetModelTests: XCTestCase {
    func testPreparationCountdownPreservesFullUsageAndFrozenPauseWithoutChangingLegacySessions() {
        let now=Dates.instant(InternetFixtures.time)!
        var item=InternetFixtures.session(end:"2026-10-17T19:05:00Z",remaining:3900)
        item.preparationRemainingSeconds=300; item.preparationEndsAt="2026-10-17T18:05:00Z"; item.grantedSeconds=3600
        XCTAssertEqual(item.remaining(at:now),3900); XCTAssertEqual(item.displayRemaining(at:now),300)
        XCTAssertEqual(item.displayRemaining(at:now.addingTimeInterval(300)),3600)
        XCTAssertEqual(item.preparation(at:now.addingTimeInterval(300)),0)
        XCTAssertEqual(item.countdownLabel(at:now),"Get ready · free buffer")
        var paused=InternetFixtures.session(state:"paused",observed:"blocked",end:nil,remaining:3780)
        paused.preparationRemainingSeconds=180
        XCTAssertEqual(paused.preparation(at:now.addingTimeInterval(900)),180)
        XCTAssertEqual(paused.remaining(at:now.addingTimeInterval(900))-paused.preparation(at:now),3600)
        XCTAssertEqual(InternetFixtures.session().displayRemaining(at:now),3600)
    }
    private func fixture(role: String = "child", monotonic: (() -> TimeInterval)? = nil) -> (InternetModel, DashboardAPI) {
        let home = Household(id: "synthetic-home", title: "Synthetic family", timezone: "America/Denver")
        let session = MobileSession(authenticated: true, authType: "mobile", role: role, household: home, user: FamilyUser(id: "synthetic-account", name: "Synthetic account", email: nil), personId: role == "child" ? InternetFixtures.child : nil)
        let api = DashboardAPI(session: session, data: HouseholdSnapshot(household: home, role: role, date: "2026-10-17", people: [], chores: []))
        api.internetData = InternetFixtures.snapshot(role: role)
        let model = InternetModel(api: api, monotonic: monotonic); model.bind(session); return (model, api)
    }
    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let limit = ContinuousClock.now.advanced(by: .seconds(5))
        while !condition() && ContinuousClock.now < limit { try? await Task.sleep(for: .milliseconds(2)) }
        XCTAssertTrue(condition(), "Expected deferred state", file: file, line: line)
    }
    func testCountdownUsesMonotonicServerClockAndExpiresWithoutClaimingBlocked() async {
        var elapsed: TimeInterval = 900
        let (model, api) = fixture(monotonic: { elapsed }); let session = InternetFixtures.session()
        api.internetData = InternetFixtures.snapshot(sessions: [session]); await model.refresh()
        XCTAssertEqual(session.remaining(at: model.serverNow), 3600)
        elapsed += 90; XCTAssertEqual(session.remaining(at: model.serverNow), 3510)
        XCTAssertFalse(model.canChange, "Read freshness expires independently of phone wall time")
        elapsed += 3600; XCTAssertEqual(session.remaining(at: model.serverNow), 0)
        XCTAssertEqual(session.statusLabel(at: model.serverNow), "Time is up · confirming block")
        XCTAssertEqual(model.sessions.first?.state, "active", "A display timer cannot invent a provider result")
    }
    func testTimedPauseFreezesRemainderWhileAllDayPauseKeepsMidnightDeadline() {
        let now = Dates.instant("2026-10-18T05:59:00Z")!
        let timed = InternetFixtures.session(state: "paused", observed: "blocked", end: nil)
        XCTAssertEqual(timed.remaining(at: now), 1800)
        let allDay = InternetFixtures.session(state: "paused", observed: "blocked", end: "2026-10-18T06:00:00Z", allDay: true)
        XCTAssertEqual(allDay.remaining(at: now), 60); XCTAssertEqual(allDay.remaining(at: now.addingTimeInterval(61)), 0)
    }
    func testQueuedStartAndResumeKeepReservedTimeUntilWindowIsAssigned() {
        for state in ["starting", "resuming", "checking"] {
            let pending = InternetFixtures.session(state: state, observed: "unknown", end: nil, remaining: 3600)
            XCTAssertTrue(pending.hasPendingWindow); XCTAssertFalse(pending.hasVerifiedAccess)
            XCTAssertEqual(pending.remaining(at: Dates.instant(InternetFixtures.time)!), 3600)
            XCTAssertEqual(pending.remaining(at: Dates.instant(InternetFixtures.time)!.addingTimeInterval(600)), 3600, "Queue wait must not consume the child's reservation")
            XCTAssertFalse(pending.statusLabel(at: Dates.instant(InternetFixtures.time)!).contains("active"))
        }
    }
    func testUnknownAndUnverifiedStatesNeverClaimActiveInternet() {
        let now = Dates.instant(InternetFixtures.time)!
        let unknown = InternetFixtures.session(state: "future-state", observed: "unknown")
        XCTAssertEqual(unknown.statusLabel(at: now), "Checking network state"); XCTAssertFalse(unknown.isStable)
        let active = InternetFixtures.session(observed: "unknown")
        XCTAssertFalse(active.hasVerifiedAccess); XCTAssertEqual(active.statusLabel(at: now), "Confirming network access")
        XCTAssertEqual(InternetSession.durationLabel(3661), "1:01:01"); XCTAssertEqual(InternetSession.durationLabel(-1), "0:00")
    }
    func testPendingRedemptionReservesOneDeviceWithoutPretendingNetworkAccess() async {
        let (model, api) = fixture(); let credit = InternetFixtures.credit(), device = InternetFixtures.device
        api.internetData = InternetFixtures.snapshot(credits: [credit]); await model.refresh()
        let pending = InternetFixtures.session(state: "starting", observed: "unknown")
        api.redeemHandler = { api.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit(status: "reserved")], sessions: [pending]); return pending }
        let success = await model.redeem(credit, device: device)
        XCTAssertTrue(success); XCTAssertEqual(model.sessions.first?.state, "starting"); XCTAssertFalse(model.sessions.first?.hasVerifiedAccess ?? true)
        XCTAssertEqual(model.snapshot?.credits.first?.status, "reserved"); XCTAssertTrue(model.availableCredits.isEmpty)
        XCTAssertFalse(model.deviceAvailable(device, for: credit.personId)); XCTAssertEqual(api.redeemCalls, 1)
    }
    func testDuplicateTapCannotRedeemTwiceAndLateMutationCannotRestoreLoggedOutState() async {
        let (model, api) = fixture(); let credit = InternetFixtures.credit(); api.internetData = InternetFixtures.snapshot(credits: [credit]); await model.refresh()
        let delayed = Deferred<InternetSession>(); api.redeemHandler = { try await delayed.wait() }
        let first = Task { await model.redeem(credit, device: InternetFixtures.device) }; await until { delayed.waiting }
        let duplicate = await model.redeem(credit, device: InternetFixtures.device)
        XCTAssertFalse(duplicate); XCTAssertEqual(api.redeemCalls, 1)
        model.bind(nil); delayed.resolve(InternetFixtures.session(state: "starting", observed: "unknown"))
        let result = await first.value; XCTAssertFalse(result); XCTAssertNil(model.snapshot); XCTAssertFalse(model.isChanging); XCTAssertNil(model.earnedReward)
    }
    func testOldReadCannotRestoreAvailableCreditAfterAcknowledgedRedemption() async {
        let (model, api) = fixture(); let credit = InternetFixtures.credit(), old = InternetFixtures.snapshot(credits: [InternetFixtures.credit()])
        api.internetData = old; await model.refresh()
        let delayed = Deferred<InternetSnapshot>(); api.internetHandler = { api.internetCalls == 2 ? try await delayed.wait() : api.internetData! }
        let read = Task { await model.refresh() }; await until { delayed.waiting }
        let pending = InternetFixtures.session(state: "starting", version: 2, observed: "unknown")
        api.redeemHandler = { api.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit(status: "reserved")], sessions: [pending]); return pending }
        let result = await model.redeem(credit, device: InternetFixtures.device); XCTAssertTrue(result)
        delayed.resolve(old); await read.value
        XCTAssertTrue(model.availableCredits.isEmpty); XCTAssertEqual(model.sessions.first?.version, 2); XCTAssertEqual(model.snapshot?.credits.first?.status, "reserved")
    }
    func testUncertainWriteNeedsPostFailureReadAndDoesNotReplay() async {
        let (model, api) = fixture(); let credit = InternetFixtures.credit(), data = InternetFixtures.snapshot(credits: [InternetFixtures.credit()])
        api.internetData = data; await model.refresh()
        let before = Deferred<InternetSnapshot>(), after = Deferred<InternetSnapshot>()
        api.internetHandler = { try await (api.internetCalls == 2 ? before : after).wait() }
        let read = Task { await model.refresh() }; await until { before.waiting }
        api.redeemHandler = { throw APIError(status: 0, code: "network_error", message: "Synthetic uncertain allowance") }
        let result = await model.redeem(credit, device: InternetFixtures.device)
        XCTAssertFalse(result); XCTAssertTrue(model.isStale); XCTAssertTrue(model.mutationNeedsReview)
        before.resolve(data); await until { after.waiting }; XCTAssertTrue(model.isStale)
        after.resolve(data); await read.value
        XCTAssertFalse(model.isStale); XCTAssertEqual(api.redeemCalls, 1)
    }
    func testRejectedDSTWindowPreservesCanonicalStateAndExplainsServerError() async {
        let (model, api) = fixture(); let credit = InternetFixtures.credit(); api.internetData = InternetFixtures.snapshot(credits: [credit]); await model.refresh()
        api.redeemHandler = { throw APIError(status: 422, code: "dst_window_unrepresentable", message: "Synthetic daylight-saving window cannot be represented") }
        let result = await model.redeem(credit, device: InternetFixtures.device)
        XCTAssertFalse(result); XCTAssertFalse(model.isStale); XCTAssertFalse(model.mutationNeedsReview); XCTAssertEqual(model.message, "Synthetic daylight-saving window cannot be represented")
        XCTAssertEqual(model.snapshot?.credits.first?.status, "available"); XCTAssertTrue(model.sessions.isEmpty)
    }
    func testChildCannotGrantOrControlSessionResolveCreditOrRedeemSiblingReward() async {
        let (model, api) = fixture(); api.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit()], sessions: [InternetFixtures.session()]); await model.refresh()
        let grant = await model.grant(personID: InternetFixtures.child, device: InternetFixtures.device, minutes: 60, allDay: true, reason: "")
        let changed = await model.act(InternetFixtures.session(), action: "end")
        let resolved = await model.resolve(InternetFixtures.credit(status: "review"), action: "restore", reason: "Synthetic decision")
        let sibling = await model.redeem(InternetFixtures.credit(person: "sibling"), device: InternetFixtures.device)
        XCTAssertFalse(grant); XCTAssertFalse(changed); XCTAssertFalse(resolved); XCTAssertFalse(sibling)
        XCTAssertEqual(api.grantCalls + api.internetActionCalls + api.internetManagementCalls + api.redeemCalls, 0)
    }
    func testUnavailableAllDayDoesNotSubmitOrMutateAParentSession() async {
        let (model, api) = fixture(role: "admin")
        let session = InternetFixtures.session()
        api.internetData = InternetFixtures.snapshot(role: "admin", sessions: [session], scheduleSupport: InternetScheduleSupport(overnight: false, allDay: false))
        await model.refresh()
        XCTAssertTrue(model.integrationReady); XCTAssertFalse(model.supportsAllDay)
        let grant = await model.grant(personID: InternetFixtures.child, device: InternetFixtures.device, minutes: 60, allDay: true, reason: "")
        let changed = await model.act(session, action: "all_day")
        XCTAssertFalse(grant); XCTAssertFalse(changed)
        XCTAssertEqual(api.grantCalls + api.internetActionCalls, 0)
        XCTAssertEqual(model.sessions.first, session)
    }
    func testCaregiverRequiresServerInternetPermission() async {
        let (model, api) = fixture(role: "member"); await model.refresh(); XCTAssertFalse(model.canManage)
        api.internetData = InternetFixtures.snapshot(role: "member", manage: true); await model.refresh(); XCTAssertTrue(model.canManage)
        XCTAssertEqual(model.role, "member")
    }
    func testParentActionsUsePresentedVersionAndCannotForcePastNewerSession() async {
        let (model, api) = fixture(role: "admin"); let old = InternetFixtures.session(version: 1)
        api.internetData = InternetFixtures.snapshot(role: "admin", sessions: [InternetFixtures.session(version: 2)]); await model.refresh()
        let result = await model.act(old, action: "adjust", deltaMinutes: 15)
        XCTAssertFalse(result); XCTAssertTrue(model.mutationNeedsReview); XCTAssertEqual(api.internetActionCalls, 0)
        api.internetActionHandler = { _, request in
            XCTAssertEqual(request.expectedVersion, 2); XCTAssertEqual(request.deltaMinutes, -15)
            return InternetFixtures.session(state: "adjusting", version: 3)
        }
        let changed = await model.act(model.sessions[0], action: "adjust", deltaMinutes: -15)
        XCTAssertTrue(changed); XCTAssertEqual(model.sessions.first?.version, 3)
        await model.refresh(); XCTAssertEqual(model.sessions.first?.version, 3, "Older reads cannot demote a confirmed action")
    }
    func testUnconfiguredIntegrationCannotStartSessionButDoesNotPretendDefaultBlockVerified() async {
        let (model, api) = fixture(); let credit = InternetFixtures.credit(); api.internetData = InternetFixtures.snapshot(credits: [credit], integration: "unconfigured"); await model.refresh()
        XCTAssertFalse(model.integrationReady); XCTAssertEqual(model.snapshot?.integration.title, "Connect your home network")
        let result = await model.redeem(credit, device: InternetFixtures.device); XCTAssertFalse(result); XCTAssertEqual(api.redeemCalls, 0)
    }
    func testLateNetworkReadCannotRestoreAnotherAccountAndExpiredCreditsAreUnavailable() async {
        let (model, api) = fixture(); await model.refresh()
        let delayed = Deferred<InternetSnapshot>(); api.internetHandler = { try await delayed.wait() }
        let read = Task { await model.refresh() }; await until { delayed.waiting }; model.bind(nil)
        delayed.resolve(InternetFixtures.snapshot(credits: [InternetFixtures.credit()])); await read.value
        XCTAssertNil(model.snapshot); XCTAssertTrue(model.availableCredits.isEmpty); XCTAssertFalse(model.canManage)
    }
    func testEarnedPromptRequiresConfirmedAvailableCreditAndSaveLaterDoesNotSpendIt() async {
        let (model, api) = fixture(); await model.refresh()
        XCTAssertNil(model.earnedReward, "Finishing local checkboxes does not invent an award")
        api.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit(status: "held")]); await model.refresh()
        XCTAssertNil(model.earnedReward)
        api.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit()], progress: [InternetFixtures.progress()]); await model.refresh()
        XCTAssertNil(model.earnedReward, "Restoring an existing credit does not earn it again")
        api.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit(),InternetFixtures.credit(id: "new-credit")], progress: [InternetFixtures.progress()]); await model.refresh()
        XCTAssertEqual(model.earnedReward?.id, "new-credit"); model.earnedReward = nil; await model.refresh()
        XCTAssertNil(model.earnedReward, "Save for later prevents repeated prompts for the same award")
        XCTAssertEqual(model.availableCredits.count, 2); XCTAssertEqual(api.redeemCalls, 0)
    }
    func testSavedRewardsAndIncompleteDailyProgressCannotAnnounceEarnedTime() async {
        let (model, api) = fixture()
        let saved = InternetFixtures.credit(earnedDate: "2026-10-16")
        api.internetData = InternetFixtures.snapshot(credits: [saved], progress: [InternetFixtures.progress(completed: 1)])
        await model.refresh(); await model.refresh(); XCTAssertNil(model.earnedReward)
        XCTAssertEqual(model.availableCredits.count, 1, "Saved time stays available without claiming today's tasks are done")
        api.internetData = InternetFixtures.snapshot(credits: [saved,InternetFixtures.credit(id: "incomplete-credit")], progress: [InternetFixtures.progress(completed: 1)])
        await model.refresh(); XCTAssertNil(model.earnedReward)
        api.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit(id: "missing-progress")])
        await model.refresh(); XCTAssertNil(model.earnedReward)
    }
    func testInitialReadOfCurrentRewardDoesNotReplayItsCelebration() async {
        let (model, api) = fixture()
        api.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit()], progress: [InternetFixtures.progress()])
        await model.refresh(); await model.refresh(); XCTAssertNil(model.earnedReward)
    }
    func testMidnightClearsYesterdayCelebrationButKeepsItsSavedCredit() async {
        let (model, api) = fixture(); await model.refresh()
        api.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit()], progress: [InternetFixtures.progress()])
        await model.refresh(); XCTAssertNotNil(model.earnedReward)
        api.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit()], progress: [InternetFixtures.progress(completed: 1, date: "2026-10-18")], serverTime: "2026-10-18T06:01:00Z")
        await model.refresh(); XCTAssertNil(model.earnedReward); XCTAssertEqual(model.availableCredits.count, 1)
    }
    func testReviewCreditIsNeverAutomaticallyRestoredOrCharged() async {
        let (model, api) = fixture(role: "admin"); api.internetData = InternetFixtures.snapshot(role: "admin", credits: [InternetFixtures.credit(status: "review")]); await model.refresh()
        XCTAssertTrue(model.availableCredits.isEmpty); XCTAssertEqual(model.snapshot?.credits.first?.status, "review"); XCTAssertEqual(api.internetManagementCalls, 0)
        let blank = await model.resolve(InternetFixtures.credit(status: "review"), action: "restore", reason: " "); XCTAssertFalse(blank)
        api.resolveHandler = { api.internetData = InternetFixtures.snapshot(role: "admin", credits: [InternetFixtures.credit(status: "available")]); return InternetFixtures.credit(status: "available") }
        let result = await model.resolve(InternetFixtures.credit(status: "review"), action: "restore", reason: "Synthetic provider review")
        XCTAssertTrue(result); XCTAssertEqual(model.snapshot?.credits.first?.status, "available"); XCTAssertEqual(api.internetManagementCalls, 1)
    }
    func testSameVersionAttentionReadSupersedesOriginalSessionAndCannotBeAdjusted() async {
        let (model, api) = fixture(role: "admin"); let original = InternetFixtures.session()
        api.internetData = InternetFixtures.snapshot(role: "admin", sessions: [original]); await model.refresh()
        api.internetData = InternetFixtures.snapshot(role: "admin", sessions: [InternetFixtures.session(state: "checking", observed: "unknown")]); await model.refresh()
        XCTAssertEqual(model.currentSession(original).state, "checking")
        let result = await model.act(original, action: "adjust", deltaMinutes: 15)
        XCTAssertFalse(result); XCTAssertEqual(api.internetActionCalls, 0)
    }
    func testRewardPickerExcludesFreeDevicesEvenAfterAParentBlocksThem() async {
        let (model, api) = fixture()
        var free = InternetFixtures.device; free.defaultAccess = "allowed"
        var pending = InternetFixtures.device; pending.accessPending = true
        var busy = InternetFixtures.device; busy.rewardAvailable = false
        var unknown = InternetFixtures.device; unknown.observedAccess = "unknown"
        api.internetData = InternetFixtures.snapshot()
        await model.refresh()
        XCTAssertEqual(model.rewardDevices(for: InternetFixtures.child).count, 1)
        for unavailable in [free, pending, busy, unknown] {
            api.internetData?.devices = [unavailable]; await model.refresh()
            XCTAssertTrue(model.rewardDevices(for: InternetFixtures.child).isEmpty)
        }
        api.internetData = InternetFixtures.snapshot(integration: "pilot_required"); await model.refresh()
        XCTAssertTrue(model.rewardDevices(for: InternetFixtures.child).isEmpty)
    }

    private func accessRequest(status: String = "pending", version: Int = 1, person: String = InternetFixtures.child, expires: String = "2026-10-18T18:00:00Z") -> DeviceAccessRequest {
        DeviceAccessRequest(id: "synthetic-request", personId: person, deviceId: InternetFixtures.device.id, minutes: 60, reason: "Play with friends", status: status, version: version, requestedAt: InternetFixtures.time, expiresAt: expires, decidedAt: status == "pending" ? nil : InternetFixtures.time, sessionId: status == "approved" ? "synthetic-session" : nil)
    }
    func testChildCanRequestWithoutNetworkEnrollmentAndPendingRequestBlocksDuplicate() async {
        let (model, api) = fixture(); api.internetData = InternetFixtures.snapshot(integration: "pilot_required")
        await model.refresh(); let item = accessRequest(); var calls = 0
        api.requestAccessHandler = { calls += 1; api.internetData?.requests = [item]; return item }
        let success = await model.requestAccess(device: InternetFixtures.device, minutes: 60, reason: "Play with friends")
        XCTAssertTrue(success); XCTAssertEqual(model.accessRequests, [item])
        let duplicate = await model.requestAccess(device: InternetFixtures.device, minutes: 60, reason: "Again")
        XCTAssertFalse(duplicate); XCTAssertEqual(calls, 1)
    }
    func testRequestRequiresOwnDeviceValidDurationAndFreshSnapshot() async {
        let (model, api) = fixture(); await model.refresh(); var calls = 0
        api.requestAccessHandler = { calls += 1; return self.accessRequest() }
        for minutes in [0, 1440] { let result = await model.requestAccess(device: InternetFixtures.device, minutes: minutes, reason: ""); XCTAssertFalse(result) }
        let long = await model.requestAccess(device: InternetFixtures.device, minutes: 60, reason: String(repeating: "x", count: 501)); XCTAssertFalse(long)
        api.internetData?.devices = []; await model.refresh()
        let unavailable = await model.requestAccess(device: InternetFixtures.device, minutes: 60, reason: ""); XCTAssertFalse(unavailable); XCTAssertEqual(calls, 0)
    }
    func testDecisionRequiresCurrentParentAuthorityAndRequestVersion() async {
        let (model, api) = fixture(role: "admin"); let item = accessRequest()
        api.internetData?.requests = [item]; await model.refresh(); var calls = 0
        api.decideAccessHandler = { calls += 1; let approved = self.accessRequest(status: "approved", version: 2); api.internetData?.requests = [approved]; return approved }
        let approved = await model.decideAccess(item, approve: true); XCTAssertTrue(approved)
        XCTAssertEqual(model.accessRequests.first?.status, "approved"); XCTAssertTrue(model.liveSessions.isEmpty, "Approval cannot invent confirmed device access")
        let repeated = await model.decideAccess(item, approve: true); XCTAssertFalse(repeated); XCTAssertEqual(calls, 1)
        let (childModel, childAPI) = fixture(); childAPI.internetData?.requests = [item]; await childModel.refresh()
        let forbidden = await childModel.decideAccess(item, approve: true); XCTAssertFalse(forbidden)
    }
    func testDeclineWorksWithoutNetworkButApprovalAndExpiredRequestsAreBlocked() async {
        let (model, api) = fixture(role: "admin"); let item = accessRequest()
        api.internetData = InternetFixtures.snapshot(role: "admin", integration: "pilot_required"); api.internetData?.requests = [item]; await model.refresh()
        let approval = await model.decideAccess(item, approve: true); XCTAssertFalse(approval)
        api.decideAccessHandler = { let declined = self.accessRequest(status: "declined", version: 2); api.internetData?.requests = [declined]; return declined }
        let decline = await model.decideAccess(item, approve: false); XCTAssertTrue(decline)
        let expired = accessRequest(expires: InternetFixtures.time); api.internetData?.requests = [expired]; await model.refresh()
        let stale = await model.decideAccess(expired, approve: false); XCTAssertFalse(stale)
    }
    func testLateRequestAcknowledgmentCannotRestorePreviousAccountAfterSignOut() async {
        let (model, api) = fixture(); await model.refresh()
        var continuation: CheckedContinuation<DeviceAccessRequest, Error>?
        api.requestAccessHandler = { try await withCheckedThrowingContinuation { continuation = $0 } }
        let change = Task { await model.requestAccess(device: InternetFixtures.device, minutes: 60, reason: "") }
        await until { continuation != nil }; model.bind(nil); continuation?.resume(returning: accessRequest())
        let success = await change.value; XCTAssertFalse(success); XCTAssertTrue(model.accessRequests.isEmpty); XCTAssertNil(model.snapshot)
    }
    func testUncertainRequestIsNotReplayedAndRequiresRefresh() async {
        let (model, api) = fixture(); await model.refresh(); var calls = 0
        api.requestAccessHandler = { calls += 1; throw APIError(status: 0, code: "transport", message: "Unknown") }
        let first = await model.requestAccess(device: InternetFixtures.device, minutes: 60, reason: "")
        XCTAssertFalse(first); XCTAssertTrue(model.isStale); XCTAssertTrue(model.mutationNeedsReview)
        let retry = await model.requestAccess(device: InternetFixtures.device, minutes: 60, reason: "")
        XCTAssertFalse(retry); XCTAssertEqual(calls, 1)
    }

}
