import XCTest
import SwiftUI
import UIKit
@testable import FamilyFrame

private final class MemoryCredentialStore: CredentialStoring {
    var value: MobileCredential?
    init(_ value: MobileCredential) { self.value = value }
    func load() throws -> MobileCredential? { value }
    func save(_ credential: MobileCredential) throws { value = credential }
    func clear() throws { value = nil }
    func installationID() throws -> String { "11111111-1111-4111-8111-111111111111" }
    func replaceInstallationID() throws -> String { "22222222-2222-4222-8222-222222222222" }
}

private final class MemoryDashboardCache: DashboardCaching {
    var value: CachedDashboard?
    func read(identity: String) -> CachedDashboard? { value?.identity == identity ? value : nil }
    func write(_ value: CachedDashboard) throws { self.value = value }
    func clear() { value = nil }
}

@MainActor
final class Deferred<Value> {
    private var continuation: CheckedContinuation<Value, Error>?
    private(set) var waiting = false
    func wait() async throws -> Value {
        try await withCheckedThrowingContinuation { continuation = $0; waiting = true }
    }
    func resolve(_ value: Value) { continuation?.resume(returning: value); continuation = nil }
    func fail(_ error: Error) { continuation?.resume(throwing: error); continuation = nil }
}

@MainActor
final class DashboardAPI: FamilyAPI {
    var mobileToken: String?
    var current: MobileSession
    var data: HouseholdSnapshot
    var calendarData = CalendarSnapshot(status: "ready", events: [], lastSuccessfulSyncAt: nil, error: nil)
    var householdCalls = 0, calendarCalls = 0, sessionCalls = 0, preferenceCalls = 0, statusCalls = 0
    var householdHandler: (() async throws -> HouseholdSnapshot)?
    var calendarHandler: (() async throws -> CalendarSnapshot)?
    var sessionHandler: (() async throws -> MobileSession)?
    var completionHandler: (() async throws -> CompletionResult)?
    var activityHandler: (() async throws -> [FamilyNotification])?
    var statusHandler: (() async throws -> MobileServiceStatus)?
    var preferencesHandler: (() async throws -> NotificationPreferences)?
    var savePreferencesHandler: ((NotificationPreferences) async throws -> NotificationPreferences)?
    var markReadHandler: (() async throws -> Void)?
    var frameCodeHandler: ((String, String?) async throws -> FrameAccessCode)?
    var resetPasswordHandler: (() async throws -> Void)?
    var deleteAccountHandler: (() async throws -> Void)?
    var transferHandler: (() async throws -> Void)?
    var signInHandler: (() async throws -> AccountOutcome)?
    var deletionCalls = 0, transferCalls = 0
    var markReadCalls = 0, frameCodeCalls = 0, memberCalls = 0
    var occurrenceHandler: ((ChoreOccurrence, Bool) async throws -> ChoreOccurrence)?
    var actionHandler: ((String, OccurrenceAction) async throws -> ChoreOccurrence)?
    var occurrenceCalls = 0, actionCalls = 0, breakCalls = 0
    var schoolReadCalls = 0, schoolChangeCalls = 0
    var schoolReadHandler: (() async throws -> SchoolCalendarResponse)?
    var schoolChangeHandler: ((SchoolDayOverrideDraft) async throws -> SchoolCalendarResponse)?
    var historyPersonID: String?
    var internetData: InternetSnapshot?
    var internetHandler: (() async throws -> InternetSnapshot)?
    var redeemHandler: (() async throws -> InternetSession)?
    var grantHandler: (() async throws -> InternetSession)?
    var internetActionHandler: ((String, InternetSessionAction) async throws -> InternetSession)?
    var resolveHandler: (() async throws -> RewardCredit)?
    var internetCalls = 0, redeemCalls = 0, grantCalls = 0, internetActionCalls = 0, internetManagementCalls = 0
    init(session: MobileSession, data: HouseholdSnapshot) { self.current = session; self.data = data }
    func currentSession() async throws -> MobileSession { sessionCalls += 1; return try await sessionHandler?() ?? current }
    func household(date: String) async throws -> HouseholdSnapshot { householdCalls += 1; return try await householdHandler?() ?? data }
    func calendar(from: String, to: String) async throws -> CalendarSnapshot { calendarCalls += 1; return try await calendarHandler?() ?? calendarData }
    func notifications() async throws -> [FamilyNotification] { try await activityHandler?() ?? [] }
    func preferences() async throws -> NotificationPreferences { preferenceCalls += 1; return try await preferencesHandler?() ?? NotificationPreferences() }
    func serviceStatus() async throws -> MobileServiceStatus { statusCalls += 1; if let statusHandler { return try await statusHandler() }; return MobileServiceStatus(pushConfigured: true, schedulingConfigured: true, serverTime: "2026-10-17T18:00:00Z") }
    func setCompletion(_ chore: Chore, date: String, completed: Bool, mutationID: String) async throws -> CompletionResult {
        if let completionHandler { return try await completionHandler() }
        data.chores[0].completion = ChoreCompletion(date: date, completed: completed, version: chore.completion.version + 1, updatedAt: nil)
        return CompletionResult(choreId: chore.id, date: date, completed: completed, version: chore.completion.version + 1, updatedAt: nil, mutationId: mutationID)
    }
    func signOut() async throws { }
    func saveChore(_ draft: ChoreDraft, id: String?) async throws { }
    func deleteChore(_ chore: Chore) async throws { }
    func markRead(id: String) async throws { markReadCalls += 1; try await markReadHandler?() }
    func registerPush(token: String, environment: String, installationID: String) async throws { }
    func savePreferences(_ prefs: NotificationPreferences) async throws -> NotificationPreferences { try await savePreferencesHandler?(prefs) ?? prefs }
    func devices() async throws -> [MobileDevice] { [] }
    func revokeDevice(id: String) async throws { }
    func setOccurrenceCompletion(_ occurrence: ChoreOccurrence, completed: Bool, mutationID: String) async throws -> ChoreOccurrence {
        occurrenceCalls += 1
        if let occurrenceHandler { return try await occurrenceHandler(occurrence, completed) }
        var result = occurrence; result.version += 1; result.status = completed ? occurrence.requiresApproval && current.role != "admin" ? "submitted" : "completed" : "pending"
        result.completion.completed = completed; result.completion.version += 1; return result
    }
    func changeOccurrence(_ id: String, action: OccurrenceAction) async throws -> ChoreOccurrence { actionCalls += 1; guard let actionHandler else { throw unexpected }; return try await actionHandler(id, action) }
    func choreHistory(from: String, to: String, personID: String?) async throws -> [ChoreHistoryItem] { historyPersonID = personID; return [] }
    func choreBreaks() async throws -> [ChoreBreak] { breakCalls += 1; return [] }
    func schoolCalendar(date: String) async throws -> SchoolCalendarResponse { schoolReadCalls += 1; guard let schoolReadHandler else { throw unexpected }; return try await schoolReadHandler() }
    func changeSchoolDay(_ draft: SchoolDayOverrideDraft) async throws -> SchoolCalendarResponse { schoolChangeCalls += 1; guard let schoolChangeHandler else { throw unexpected }; return try await schoolChangeHandler(draft) }
    func createChoreBreak(_ draft: ChoreBreakDraft) async throws -> ChoreBreak { breakCalls += 1; throw unexpected }
    func revokeChoreBreak(_ item: ChoreBreak, reason: String, mutationID: String) async throws -> ChoreBreak { breakCalls += 1; throw unexpected }
    private var unexpected: APIError { APIError(status: 0, code: "unexpected_test_call", message: "No account calls belong in dashboard state tests.") }
    func accountSignIn(email: String, password: String, invitation: String) async throws -> AccountOutcome { guard let signInHandler else { throw unexpected }; return try await signInHandler() }
    func createAccount(name: String, email: String, password: String, invitation: String) async throws -> AccountOutcome { throw unexpected }
    func confirmAccount(email: String, code: String, invitation: String) async throws -> AccountOutcome { throw unexpected }
    func resendConfirmation(email: String) async throws { throw unexpected }
    func requestPasswordReset(email: String) async throws { throw unexpected }
    func resetPassword(email: String, token: String, recoveryLink: String, password: String) async throws { guard let resetPasswordHandler else { throw unexpected }; try await resetPasswordHandler() }
    func joinFamily(invitation: String) async throws -> AccountOutcome { throw unexpected }
    func cancelAccountOnboarding() async { }
    func createChildInvitation(personID: String, email: String) async throws -> ChildInvitation { throw unexpected }
    func createFrameAccessCode(scope: String, personID: String?) async throws -> FrameAccessCode { frameCodeCalls += 1; guard let frameCodeHandler else { throw unexpected }; return try await frameCodeHandler(scope, personID) }
    func members() async throws -> [FamilyMember] { memberCalls += 1; throw unexpected }
    func changeMemberCapabilities(_ id: String, capabilities: ParentCapabilities) async throws -> MemberCapabilitiesResult { throw unexpected }
    func internet() async throws -> InternetSnapshot {
        internetCalls += 1
        if let internetHandler { return try await internetHandler() }
        return internetData ?? InternetSnapshot(serverTime: "2026-10-17T18:00:00Z", timezone: current.household.timezone, role: current.role, capabilities: ParentCapabilities(manageChores: current.isAdmin, manageInternet: current.isAdmin), integration: InternetIntegration(state: "unconfigured", managementHost: "frame.test", managementAccessVerifiedAt: nil, lastCheckedAt: nil, error: nil), policies: [], credits: [], devices: [], sessions: [], progress: [])
    }
    func redeemInternet(creditID: String, deviceID: String, mutationID: String) async throws -> InternetSession { redeemCalls += 1; guard let redeemHandler else { throw unexpected }; return try await redeemHandler() }
    func grantInternet(personID: String, deviceID: String, minutes: Int?, allDay: Bool, reason: String?, mutationID: String) async throws -> InternetSession { grantCalls += 1; guard let grantHandler else { throw unexpected }; return try await grantHandler() }
    func changeInternetSession(_ id: String, action: InternetSessionAction) async throws -> InternetSession { internetActionCalls += 1; guard let internetActionHandler else { throw unexpected }; return try await internetActionHandler(id, action) }
    func saveInternetDevice(_ draft: ManagedDeviceDraft, id: String?) async throws -> ManagedInternetDevice { internetManagementCalls += 1; throw unexpected }
    func deleteInternetDevice(_ item: ManagedInternetDevice, mutationID: String) async throws { internetManagementCalls += 1; throw unexpected }
    func saveInternetPolicy(_ personID: String, draft: RewardPolicyDraft) async throws -> RewardPolicy { internetManagementCalls += 1; throw unexpected }
    func resolveInternetCredit(_ id: String, action: String, reason: String, mutationID: String) async throws -> RewardCredit { internetManagementCalls += 1; guard let resolveHandler else { throw unexpected }; return try await resolveHandler() }
    func internetHistory() async throws -> [InternetHistoryItem] { throw unexpected }
    func deleteAccount(password: String) async throws { deletionCalls += 1; guard let deleteAccountHandler else { throw unexpected }; try await deleteAccountHandler() }
    func transferOwnership(userID: String) async throws { transferCalls += 1; guard let transferHandler else { throw unexpected }; try await transferHandler() }
}

@MainActor
final class AppModelTests: XCTestCase {
    private let instant = Dates.instant("2026-10-17T18:00:00Z")!
    private func fixture(now: (() -> Date)? = nil, role: String = "admin", personID: String? = nil) -> (AppModel, DashboardAPI, MemoryCredentialStore, MemoryDashboardCache) {
        let home = Household(id: "fixture-home", title: "Synthetic family", timezone: "America/Denver")
        let session = MobileSession(authenticated: true, authType: "mobile", role: role, household: home, user: FamilyUser(id: "fixture-parent", name: "Synthetic parent", email: nil), personId: personID)
        let chore = Chore(id: "fixture-chore", title: "Synthetic chore", personId: nil, weekdays: Array(0...6), version: 1, dueTime: "18:00", reminderMinutes: 15, completion: ChoreCompletion(date: "2026-10-17", completed: false, version: 0, updatedAt: nil))
        let data = HouseholdSnapshot(household: home, role: role, date: "2026-10-17", people: [], chores: [chore])
        let store = MemoryCredentialStore(MobileCredential(token: String(repeating: "a", count: 43), expiresAt: "2099-01-01T00:00:00Z", session: session))
        let api = DashboardAPI(session: session, data: data), cache = MemoryDashboardCache()
        return (AppModel(api: api, keychain: store, cache: cache, now: now ?? { self.instant }, observesPush: false), api, store, cache)
    }
    private func occurrence(_ id: String = "fixture-occurrence", personID: String? = nil, required: Bool = true, approval: Bool = false, status: String = "pending", date: String = "2026-10-17", version: Int = 1, choreID: String = "fixture-chore") -> ChoreOccurrence {
        ChoreOccurrence(id: id, choreId: choreID, date: date, originalDate: date, title: "Synthetic daily chore", personId: personID, personName: personID == nil ? nil : "Synthetic child", required: required, instructions: "Put each item in its place.", subtasks: [ChoreStep(id: "fixture-step", title: "First step", completed: status == "completed")], requiresApproval: approval, status: status, version: version, completion: ChoreCompletion(date: date, completed: ["completed", "submitted"].contains(status), version: status == "pending" ? 0 : 1, updatedAt: nil), dueTime: "18:00", reminderMinutes: 15, skipReason: status == "skipped" ? "Synthetic school holiday" : nil, rescheduledFrom: nil, completedAt: nil, approvedAt: nil, definitionSource: "routine", routineVersion: 1, createdAt: nil, updatedAt: nil)
    }
    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let limit = ContinuousClock.now.advanced(by: .seconds(5))
        while !condition() && ContinuousClock.now < limit { try? await Task.sleep(for: .milliseconds(2)) }
        XCTAssertTrue(condition(), "Expected asynchronous state was not reached", file: file, line: line)
    }
    func testRequiredProgressExcludesExcusedOptionalAndUnapprovedWork() async {
        let (model, api, _, _) = fixture()
        api.data.occurrences = [occurrence("pending", choreID: "pending-routine"), occurrence("submitted", approval: true, status: "submitted", choreID: "submitted-routine"), occurrence("optional", required: false, status: "completed", choreID: "optional-routine"), occurrence("excused", status: "skipped", choreID: "excused-routine")]
        await model.start()
        XCTAssertEqual(model.requiredCount, 2); XCTAssertEqual(model.completedCount, 0); XCTAssertEqual(model.approvalCount, 1)
    }
    func testCaregiverNeedsExplicitChorePermissionAndCannotEditMembers() async {
        let (model, api, _, _) = fixture(role: "member")
        let item = occurrence(approval: true, status: "submitted"); api.data.occurrences = [item]
        await model.start(); XCTAssertFalse(model.canManageChores)
        let denied = await model.actOnOccurrence(item, action: "approve"); XCTAssertFalse(denied); XCTAssertEqual(api.actionCalls, 0)
        api.data.capabilities = ParentCapabilities(manageChores: true, manageInternet: false); await model.refresh()
        XCTAssertTrue(model.canManageChores); XCTAssertFalse(model.canManageInternet); XCTAssertFalse(model.isAdmin)
        do { _ = try await model.familyMembers(); XCTFail("Caregivers cannot edit membership permissions") } catch { XCTAssertEqual((error as? APIError)?.status, 403) }
        XCTAssertEqual(api.memberCalls, 0)
    }
    func testNotificationNavigationOnlyUsesCurrentAuthenticatedInbox() async {
        let (model, api, _, _) = fixture(); let item = occurrence(); api.data.occurrences = [item]
        var notification = FamilyNotification(id: "test-notification", kind: "chore_submitted", title: "Synthetic update", body: "Synthetic body", createdAt: "2026-10-17T18:00:00Z", readAt: nil, choreId: item.choreId, date: item.date)
        notification.occurrenceId = item.id; notification.target = "chores"; api.activityHandler = { [notification] }
        await model.start(); await model.openNotification(id: "untrusted-missing-id")
        XCTAssertEqual(model.selectedTab, 4); XCTAssertNil(model.openedOccurrence); XCTAssertEqual(api.markReadCalls, 0)
        await model.openNotification(id: notification.id)
        XCTAssertEqual(model.selectedTab, 1); XCTAssertEqual(model.openedOccurrence?.id, item.id); XCTAssertEqual(api.markReadCalls, 1)
        XCTAssertEqual(model.unreadCount, 0)
    }
    func testLateNotificationLookupCannotOpenPreviousAccountDetails() async {
        let (model, api, _, _) = fixture(); await model.start()
        let deferred = Deferred<[FamilyNotification]>(); api.activityHandler = { try await deferred.wait() }
        let opened = Task { await model.openNotification(id: "test-notification") }; await waitUntil { deferred.waiting }
        await model.signOut(); deferred.resolve([]); await opened.value
        XCTAssertNil(model.session); XCTAssertNil(model.openedOccurrence); XCTAssertTrue(model.notifications.isEmpty); XCTAssertEqual(model.selectedTab, 0)
    }
    func testChildUnlockIsOwnProfileOnlyAndLateCodeIsDiscarded() async {
        let (model, api, _, _) = fixture(role: "child", personID: "fixture-child"); await model.start()
        for request in [("parent", nil), ("child", Optional("fixture-sibling"))] {
            do { _ = try await model.frameAccessCode(scope: request.0, personID: request.1); XCTFail("Child must not escalate frame access") } catch { XCTAssertEqual((error as? APIError)?.status, 403) }
        }
        XCTAssertEqual(api.frameCodeCalls, 0)
        let deferred = Deferred<FrameAccessCode>(); api.frameCodeHandler = { _, _ in try await deferred.wait() }
        let code = Task { try await model.frameAccessCode(scope: "child", personID: "fixture-child") }; await waitUntil { deferred.waiting }
        await model.signOut(); deferred.resolve(FrameAccessCode(code: "000000", scope: "child", personId: "fixture-child", expiresAt: "2026-10-17T18:05:00Z"))
        do { _ = try await code.value; XCTFail("A previous account's code cannot remain visible") } catch is CancellationError { } catch { XCTFail("Expected cancellation, got \(error)") }
    }
    func testChoreOnlyCaregiverCanUnlockParentChoresButCannotUnlockAChildProfile() async {
        let (model, api, _, _) = fixture(role: "member")
        api.data.capabilities = ParentCapabilities(manageChores: true, manageInternet: false)
        api.frameCodeHandler = { scope, person in
            XCTAssertEqual(scope, "parent"); XCTAssertNil(person)
            return FrameAccessCode(code: "000000", scope: "parent", personId: nil, expiresAt: "2099-01-01T00:00:00Z")
        }
        await model.start()
        do { let code = try await model.frameAccessCode(scope: "parent", personID: nil); XCTAssertEqual(code.scope, "parent") } catch { XCTFail("Chore permission must allow its parent scope: \(error)") }
        do { _ = try await model.frameAccessCode(scope: "child", personID: "fixture-child"); XCTFail("Child Internet scope still requires Internet management") } catch { XCTAssertEqual((error as? APIError)?.status, 403) }
        XCTAssertEqual(api.frameCodeCalls, 1)
        await attachLayout(NavigationStack { FrameAccessScreen() }.environmentObject(model), name: "Synthetic review - chore caregiver parent unlock")
    }
    func testSuccessfulPasswordRecoveryClearsCredentialAndHousehold() async {
        let (model, api, store, cache) = fixture(); await model.start(); api.resetPasswordHandler = { }
        let reset = await model.resetPassword(email: "synthetic@example.test", token: "000000", recoveryLink: "", password: "test-only-password")
        XCTAssertTrue(reset); XCTAssertNil(model.session); XCTAssertNil(store.value); XCTAssertNil(cache.value); XCTAssertNil(model.snapshot)
    }
    func testAccountDeletionRequiresExactConfirmationAndClearsLocalAccessOnlyAfterAcknowledgment() async {
        let (model, api, store, cache) = fixture(); await model.start(); api.deleteAccountHandler = { }
        let missing = await model.deleteAccount(password: "test-only-password", confirmation: "DELETE")
        XCTAssertFalse(missing); XCTAssertEqual(api.deletionCalls, 0); XCTAssertNotNil(model.session)
        let deleted = await model.deleteAccount(password: "test-only-password", confirmation: "DELETE MY ACCOUNT")
        XCTAssertTrue(deleted); XCTAssertNil(model.session); XCTAssertNil(model.snapshot); XCTAssertNil(store.value); XCTAssertNil(cache.value)
        XCTAssertNil(model.internet.snapshot); XCTAssertEqual(model.accountStage, .entry); XCTAssertEqual(api.deletionCalls, 1)
    }
    func testOwnershipConflictDoesNotPretendAccountWasDeleted() async {
        let (model, api, store, _) = fixture(); await model.start()
        api.deleteAccountHandler = { throw APIError(status: 409, code: "ownership_transfer_required", message: "Transfer household ownership before deleting your account.") }
        let result = await model.deleteAccount(password: "test-only-password", confirmation: "DELETE MY ACCOUNT")
        XCTAssertFalse(result); XCTAssertNotNil(model.session); XCTAssertNotNil(store.value); XCTAssertFalse(model.accountDeletionNeedsReview)
        XCTAssertEqual(model.message, "Transfer household ownership before deleting your account.")
    }
    func testUncertainDeletionCanBeRetriedFromVerifiedUnlinkedOnboardingWithoutFamilyJoin() async {
        let (model, api, _, _) = fixture(); await model.start()
        api.deleteAccountHandler = { throw APIError(status: 502, code: "identity_cleanup_pending", message: "Synthetic provider interruption") }
        let uncertain = await model.deleteAccount(password: "test-only-password", confirmation: "DELETE MY ACCOUNT")
        XCTAssertFalse(uncertain); XCTAssertTrue(model.accountDeletionNeedsReview)
        await model.signOut(); api.signInHandler = { .invitationRequired }
        let signedIn = await model.signIn(email: "synthetic@example.test", password: "test-only-password")
        XCTAssertTrue(signedIn); XCTAssertNil(model.session); XCTAssertTrue(model.canDeleteAccount); XCTAssertFalse(model.accountDeletionNeedsReview)
        XCTAssertEqual(model.accountStage, .joinFamily("synthetic@example.test"))
        api.deleteAccountHandler = { }; let retried = await model.deleteAccount(password: "test-only-password", confirmation: "DELETE MY ACCOUNT")
        XCTAssertTrue(retried); XCTAssertEqual(model.accountStage, .entry); XCTAssertEqual(api.deletionCalls, 2)
    }
    func testLateDeletionResponseCannotRestoreOrAffectSignedOutState() async {
        let (model, api, store, _) = fixture(); await model.start()
        let delayed = Deferred<Void>(); api.deleteAccountHandler = { try await delayed.wait() }
        let deletion = Task { await model.deleteAccount(password: "test-only-password", confirmation: "DELETE MY ACCOUNT") }; await waitUntil { delayed.waiting }
        await model.signOut(); delayed.resolve(()); let result = await deletion.value
        XCTAssertFalse(result); XCTAssertNil(model.session); XCTAssertNil(store.value); XCTAssertNil(model.message); XCTAssertFalse(model.isSigningIn)
    }
    func testOwnershipTransferRequiresAdministratorAndRefreshesRole() async {
        let (child, childAPI, _, _) = fixture(role: "child", personID: "test-child"); await child.start()
        let denied = await child.transferOwnership(userID: "test-caregiver"); XCTAssertFalse(denied); XCTAssertEqual(childAPI.transferCalls, 0)
        let (model, api, store, _) = fixture(); await model.start()
        api.transferHandler = {
            api.current = MobileSession(authenticated: true, authType: "mobile", role: "member", household: api.current.household, user: api.current.user, personId: nil)
            api.data = HouseholdSnapshot(household: api.current.household, role: "member", date: "2026-10-17", people: [], chores: [], capabilities: ParentCapabilities(manageChores: false, manageInternet: false))
        }
        let result = await model.transferOwnership(userID: "test-caregiver")
        XCTAssertTrue(result); XCTAssertFalse(model.isAdmin); XCTAssertFalse(model.canManageChores); XCTAssertEqual(store.value?.session.role, "member")
    }
    func testChildSubmissionDoesNotBecomeApprovedAfterOldSnapshotRefresh() async {
        let (model, api, _, _) = fixture(role: "child", personID: "fixture-child")
        let item = occurrence(personID: "fixture-child", approval: true); api.data.occurrences = [item]
        await model.start(); let changed = await model.toggleOccurrence(item); await model.refresh()
        XCTAssertTrue(changed); XCTAssertEqual(model.visibleOccurrences.first?.status, "submitted")
        XCTAssertEqual(model.completedCount, 0); XCTAssertEqual(model.approvalCount, 1)
        XCTAssertEqual(model.visibleOccurrences.first?.version, 2)
    }
    func testChildCannotApproveSiblingOrManageChoreBreaks() async {
        let (model, api, _, _) = fixture(role: "child", personID: "fixture-child")
        let own = occurrence(personID: "fixture-child", approval: true, status: "submitted")
        let sibling = occurrence("sibling-occurrence", personID: "fixture-sibling", choreID: "sibling-routine")
        api.data.occurrences = [own, sibling]; await model.start()
        let approved = await model.actOnOccurrence(own, action: "approve")
        let siblingChanged = await model.toggleOccurrence(sibling)
        XCTAssertFalse(approved); XCTAssertFalse(siblingChanged); XCTAssertEqual(api.actionCalls, 0); XCTAssertEqual(api.occurrenceCalls, 0)
        XCTAssertEqual(model.visibleOccurrences.map(\.id), [own.id])
        do { _ = try await model.loadChoreBreaks(); XCTFail("Child must not manage holidays") } catch { XCTAssertEqual((error as? APIError)?.status, 403) }
        XCTAssertEqual(api.breakCalls, 0)
        _ = try? await model.loadChoreHistory(from: "2026-10-01", to: "2026-10-18", personID: "fixture-sibling")
        XCTAssertEqual(api.historyPersonID, "fixture-child")
    }
    func testChildCannotChangeSchoolDayAndUnknownSchoolStatusRemainsReadable() async throws {
        let (model, api, _, _) = fixture(role: "child", personID: "fixture-child")
        let status = SchoolDayStatus(date: "2026-10-17", type: "unknown", label: "Calendar not confirmed", reason: "Synthetic missing year", calendarVersion: nil)
        api.data.schoolDay = status; api.schoolReadHandler = { SchoolCalendarResponse(calendar: nil, schoolDay: status) }
        await model.start()
        let response = try await model.loadSchoolCalendar(date: model.today)
        XCTAssertFalse(response.schoolDay.isKnown)
        let changed = await model.changeSchoolDay(.init(expectedVersion: 1, change: .init(date: model.today, type: "school_day", reason: "Synthetic parent change")))
        XCTAssertFalse(changed); XCTAssertEqual(api.schoolReadCalls, 1); XCTAssertEqual(api.schoolChangeCalls, 0)
    }
    func testUncertainSchoolCalendarMutationRequiresReviewBeforeRetry() async {
        let (model, api, _, _) = fixture(); await model.start()
        api.schoolChangeHandler = { _ in throw APIError(status: 0, code: "network_error", message: "Synthetic uncertain school date change") }
        let draft = SchoolDayOverrideDraft(expectedVersion: 1, change: .init(date: model.today, type: "non_school_day", reason: "Synthetic date change"))
        let changed = await model.changeSchoolDay(draft)
        XCTAssertFalse(changed); XCTAssertTrue(model.lastMutationNeedsReview); XCTAssertTrue(model.isStale)
        let replay = await model.changeSchoolDay(draft)
        XCTAssertFalse(replay); XCTAssertEqual(api.schoolChangeCalls, 1)
    }
    func testPastSchoolDateChangesStayReadOnly() async {
        let (model, api, _, _) = fixture(); await model.start()
        let yesterday = Dates.shiftedDay(model.today, by: -1)
        XCTAssertFalse(model.canEditSchoolDate(yesterday)); XCTAssertTrue(model.canEditSchoolDate(model.today))
        XCTAssertTrue(model.canEditSchoolDate(Dates.shiftedDay(model.today, by: 1)))
        let changed = await model.changeSchoolDay(.init(expectedVersion: 1, change: .init(date: yesterday, type: "school_day", reason: "Synthetic historical edit")))
        XCTAssertFalse(changed); XCTAssertEqual(api.schoolChangeCalls, 0)
    }
    func testRescheduleAcknowledgmentCannotBeResurrectedByOldRead() async {
        let (model, api, _, _) = fixture(); let item = occurrence(); api.data.occurrences = [item]
        api.actionHandler = { _, request in
            XCTAssertEqual(request.expectedVersion, item.version)
            var moved = item; moved.date = "2026-10-18"; moved.version += 1; moved.rescheduledFrom = item.date; return moved
        }
        await model.start()
        let changed = await model.actOnOccurrence(item, action: "reschedule", reason: "Synthetic reason", toDate: "2026-10-18")
        await model.refresh()
        XCTAssertTrue(changed); XCTAssertTrue(model.visibleOccurrences.isEmpty)
        XCTAssertEqual(model.currentOccurrence(item).date, "2026-10-18")
        XCTAssertFalse(model.canChangeOccurrence(model.currentOccurrence(item)))
    }
    func testOccurrenceAcknowledgmentAfterMidnightDoesNotChangeNewOccurrence() async {
        var clock = Dates.instant("2026-10-18T05:59:00Z")!
        let (model, api, _, _) = fixture(now: { clock }); let item = occurrence(); api.data.occurrences = [item]
        let delayed = Deferred<ChoreOccurrence>(); api.occurrenceHandler = { _, _ in try await delayed.wait() }
        await model.start(); let toggle = Task { await model.toggleOccurrence(item) }; await waitUntil { delayed.waiting }
        clock = Dates.instant("2026-10-18T06:01:00Z")!
        let next = occurrence("next-day-occurrence", date: "2026-10-18")
        api.data = HouseholdSnapshot(household: api.current.household, role: "admin", date: "2026-10-18", people: [], chores: [next.legacy], occurrences: [next])
        await model.refresh()
        var ack = item; ack.status = "completed"; ack.version += 1; ack.completion.completed = true
        delayed.resolve(ack); _ = await toggle.value; await model.refresh()
        XCTAssertEqual(model.visibleOccurrences.map(\.id), [next.id]); XCTAssertFalse(model.visibleOccurrences.first?.isDone ?? true)
    }
    func testOccurrenceReplyAfterSignOutCannotRestoreChores() async {
        let (model, api, _, _) = fixture(); let item = occurrence(); api.data.occurrences = [item]
        let delayed = Deferred<ChoreOccurrence>(); api.occurrenceHandler = { _, _ in try await delayed.wait() }
        await model.start(); let toggle = Task { await model.toggleOccurrence(item) }; await waitUntil { delayed.waiting }
        await model.signOut(); delayed.resolve(item); let changed = await toggle.value
        XCTAssertFalse(changed); XCTAssertNil(model.snapshot); XCTAssertTrue(model.visibleOccurrences.isEmpty)
    }
    func testUncertainOccurrenceWritePausesEditingWithoutReplay() async {
        let (model, api, _, _) = fixture(); let item = occurrence(); api.data.occurrences = [item]
        api.occurrenceHandler = { _, _ in throw APIError(status: 0, code: "network_error", message: "Synthetic uncertain occurrence write") }
        await model.start(); let changed = await model.toggleOccurrence(item)
        XCTAssertFalse(changed); XCTAssertTrue(model.isStale); XCTAssertEqual(api.occurrenceCalls, 1)
        XCTAssertFalse(model.visibleOccurrences.first?.isDone ?? true); XCTAssertTrue(model.changingChores.isEmpty)
    }
    func testSyntheticOccurrenceAndRoutineLayouts() async {
        let (model, api, _, _) = fixture()
        let child = Person(id: "fixture-child", name: "Synthetic child", color: "#00748c", version: 1)
        let submitted = occurrence(personID: child.id, approval: true, status: "submitted")
        let optional = occurrence("optional", personID: child.id, required: false, choreID: "optional-routine")
        api.data.people = [child]; api.data.occurrences = [submitted, optional]
        var routine = ChoreRoutine(legacy: api.data.chores[0]); routine.instructions = "Synthetic routine instructions"; routine.requiresApproval = true; routine.subtasks = submitted.subtasks
        routine.schoolDayFilter = "school_day"
        api.data.schoolDay = SchoolDayStatus(date: "2026-10-17", type: "non_school_day", label: "No school", reason: "Synthetic regular day off", calendarVersion: 1)
        api.data.routines = [routine]; await model.start()
        await attachLayout(NavigationStack { TodayScreen() }.environmentObject(model), name: "Synthetic Stage2 Today - submitted approval")
        await attachLayout(OccurrenceDetailScreen(original: optional).environmentObject(model).environment(\.dynamicTypeSize, .accessibility1), name: "Synthetic Stage2 chore details - accessible checklist")
        await attachLayout(ChoreEditor(routine: routine).environmentObject(model), name: "Synthetic Stage2 routine editor")
    }
    func testSyntheticSchoolCalendarLayouts() async {
        let (model, api, _, _) = fixture()
        let calendar = SchoolCalendarDocument(title: "Synthetic school year", sourceName: "Synthetic approved calendar", sourceSha256: nil, sourceUrl: "https://school.example.test/calendar", coverageStart: "2026-08-01", coverageEndExclusive: "2027-08-01", termStart: "2026-08-20", termEndExclusive: "2027-05-29", weekdays: [1,2,3,4,5], closures: [.init(fromDate: "2026-10-15", toDateExclusive: "2026-10-17", label: "Synthetic school break")], overrides: [], version: 1, updatedAt: nil)
        let status = SchoolDayStatus(date: "2026-10-17", type: "non_school_day", label: "No school", reason: "Synthetic regular day off", calendarVersion: 1)
        api.data.schoolDay = status; api.schoolReadHandler = { SchoolCalendarResponse(calendar: calendar, schoolDay: status) }
        await model.start()
        await attachLayout(NavigationStack { SchoolCalendarScreen() }.environmentObject(model), name: "Synthetic school calendar - approved schedule")
        await attachLayout(SchoolDayCard().environmentObject(model).environment(\.dynamicTypeSize, .accessibility1), name: "Synthetic school-day status - accessible type")
    }
    func testEarlierSchoolScheduleStaysVisibleWithoutCountingTowardCurrentTasks() async {
        let (model, api, _, _) = fixture()
        var earlierDone = occurrence("earlier-done", status: "completed", choreID: "earlier-routine")
        earlierDone.schoolDayFilter = "school_day"; earlierDone.taskSection = "before_school"
        var earlierSubmitted = occurrence("earlier-submitted", approval: true, status: "submitted", choreID: "earlier-approval")
        earlierSubmitted.schoolDayFilter = "school_day"; earlierSubmitted.taskSection = "after_school"
        var current = occurrence("current-pending", choreID: "non-school-routine"); current.schoolDayFilter = "non_school_day"
        var parentMoved = occurrence("parent-moved", choreID: "explicitly-moved"); parentMoved.schoolDayFilter = "school_day"; parentMoved.schoolScheduleExempt = true
        api.data.occurrences = [earlierDone, earlierSubmitted, current, parentMoved]
        api.data.schoolDay = SchoolDayStatus(date: "2026-10-17", type: "non_school_day", label: "No school", reason: "Synthetic parent change", calendarVersion: 2)
        await model.start()
        XCTAssertEqual(model.visibleOccurrences.count, 4, "Saved submitted/completed work remains available")
        XCTAssertEqual(model.requiredCount, 2); XCTAssertEqual(model.completedCount, 0); XCTAssertEqual(model.approvalCount, 0)
        XCTAssertFalse(model.isCurrentSchoolSchedule(earlierDone)); XCTAssertTrue(model.isCurrentSchoolSchedule(parentMoved))
    }
    func testSyntheticSchoolTaskSectionsAndEmptyOnboardingLayouts() async {
        let (model, api, _, _) = fixture()
        let child = Person(id: "fixture-child", name: "Synthetic child", color: "#00748c", version: 1)
        var before = occurrence("before-school", personID: child.id, choreID: "before-routine"); before.schoolDayFilter = "school_day"; before.taskSection = "before_school"
        var after = occurrence("after-school", personID: child.id, choreID: "after-routine"); after.schoolDayFilter = "school_day"; after.taskSection = "after_school"
        api.data.people = [child]; api.data.occurrences = [before, after]
        api.data.schoolDay = SchoolDayStatus(date: "2026-10-17", type: "school_day", label: "School day", reason: "Synthetic school schedule", calendarVersion: 1)
        await model.start()
        await attachLayout(NavigationStack { ScrollView { PersonOccurrencesCard(person: child, occurrences: model.visibleOccurrences, showEmptySections: true).padding(20) } }.environmentObject(model), name: "Synthetic Tasks - before and after school")
        await attachLayout(NavigationStack { ScrollView { PersonOccurrencesCard(person: child, occurrences: [], showEmptySections: true).padding(20) } }.environmentObject(model), name: "Synthetic Tasks - empty school sections and add actions")
        await attachLayout(ChoreEditor(routine: nil, assignedPersonID: child.id, initialSchoolDayFilter: "school_day", initialTaskSection: "before_school").environmentObject(model), name: "Synthetic task editor - before-school preset")
        api.data.schoolDay = SchoolDayStatus(date: "2026-10-17", type: "non_school_day", label: "No school", reason: "Synthetic school break", calendarVersion: 2)
        await model.refresh()
        await attachLayout(NavigationStack { ScrollView { PersonOccurrencesCard(person: child, occurrences: model.visibleOccurrences, showEmptySections: true).padding(20) } }.environmentObject(model), name: "Synthetic Tasks - flat non-school day")
    }
    func testFreshChoresStayEditableWhileSlowCalendarIsLoading() async throws {
        let (model, api, _, _) = fixture(), delayed = Deferred<CalendarSnapshot>()
        api.calendarHandler = { try await delayed.wait() }
        let start = Task { await model.start() }
        await waitUntil { delayed.waiting && model.snapshot != nil }
        XCTAssertTrue(model.isLoading); XCTAssertFalse(model.isStale); XCTAssertTrue(model.canChange)
        delayed.resolve(api.calendarData); await start.value
        XCTAssertFalse(model.isLoading)
    }
    func testFreshChoresStayEditableWhileInternetStatusIsSlow() async {
        let (model, api, _, _) = fixture(); let delayed = Deferred<InternetSnapshot>()
        api.internetHandler = { try await delayed.wait() }
        let start = Task { await model.start() }; await waitUntil { delayed.waiting && model.snapshot != nil }
        XCTAssertTrue(model.canChange); XCTAssertFalse(model.isStale); XCTAssertTrue(model.internet.isLoading)
        delayed.resolve(InternetFixtures.snapshot(role: "admin", integration: "unconfigured")); await start.value
        XCTAssertTrue(model.canChange)
    }
    func testInternetNotificationResolvesOwnedSessionFromAuthenticatedSnapshot() async {
        let (model, api, _, _) = fixture(role: "child", personID: InternetFixtures.child)
        let session = InternetFixtures.session(); api.internetData = InternetFixtures.snapshot(sessions: [session])
        var notification = FamilyNotification(id: "test-session-update", kind: "session_started", title: "Synthetic session update", body: "Synthetic body", createdAt: InternetFixtures.time, readAt: nil, choreId: nil, date: nil)
        notification.target = "devices"; notification.sessionId = session.id; api.activityHandler = { [notification] }
        await model.start(); await model.openNotification(id: notification.id)
        XCTAssertEqual(model.selectedTab, 3); XCTAssertEqual(model.internet.openedSession?.id, session.id)
        XCTAssertEqual(api.markReadCalls, 1)
    }
    func testSyntheticInternetParentChildAndEditorLayouts() async {
        let (parent, api, _, _) = fixture()
        api.data.people = [Person(id: InternetFixtures.child, name: "Synthetic child", color: "#00748c", version: 1)]
        api.internetData = InternetFixtures.snapshot(role: "admin", credits: [InternetFixtures.credit(status: "review")], sessions: [InternetFixtures.session()])
        await parent.start(); parent.selectedTab = 3
        await attachLayout(DashboardTabs().environmentObject(parent), name: "Synthetic Stage3 Devices - parent session and five tabs")
        let starting = InternetFixtures.session(state: "starting", version: 2, observed: "unknown", end: nil, remaining: 3600)
        api.internetData?.sessions = [starting]; await parent.internet.refresh()
        await attachLayout(NavigationStack { InternetSessionDetail(network: parent.internet, original: starting) }.environmentObject(parent).environment(\.dynamicTypeSize, .accessibility1), name: "Synthetic Stage3 session details - accessible pending state")
        let tablet = ManagedInternetDevice(id: "synthetic-tablet", name: "Synthetic iPad", kind: "tablet", personIds: [InternetFixtures.child], macAddresses: ["02:00:00:00:00:02"], version: 1, controlState: "unenrolled", online: nil, lastSeenAt: nil, managementAccessVerifiedAt: nil, allowApplePush: true)
        await attachLayout(ManagedDeviceEditor(network: parent.internet, device: tablet).environmentObject(parent), name: "Synthetic Stage3 device editor - Apple notification transport")
        let (child, childAPI, _, _) = fixture(role: "child", personID: InternetFixtures.child)
        childAPI.data.people = api.data.people; childAPI.internetData = InternetFixtures.snapshot(credits: [InternetFixtures.credit()]); await child.start()
        childAPI.data.occurrences = [occurrence(personID: InternetFixtures.child, status: "completed")]; await child.refresh()
        await child.internet.refresh(celebrateRewards: true)
        XCTAssertNotNil(child.internet.earnedReward); XCTAssertEqual(child.requiredCount, 1); XCTAssertEqual(child.completedCount, 1)
        await attachLayout(NavigationStack { ChoresScreen() }.environmentObject(child), name: "Synthetic Stage3 child - earned reward now or later")
        await attachLayout(RewardDevicePicker(network: child.internet, credit: InternetFixtures.credit()).environmentObject(child), name: "Synthetic Stage3 child - one device reward picker")
    }
    func testSyntheticAccountDeletionAndUnlinkedRecoveryLayouts() async {
        let (model, api, _, _) = fixture(); await model.start()
        await attachLayout(AccountDeletionScreen().environmentObject(model), name: "Synthetic Stage3 account deletion - password and exact confirmation")
        await model.signOut(); api.signInHandler = { .invitationRequired }
        _ = await model.signIn(email: "synthetic@example.test", password: "test-only-password")
        XCTAssertTrue(model.canDeleteAccount)
        await attachLayout(WelcomeScreen().environmentObject(model), name: "Synthetic Stage3 unlinked verified account - deletion without joining")
    }
    func testBackgroundRefreshDoesNotRepeatedlyFetchSettings() async {
        let (model, api, _, _) = fixture(); await model.start()
        XCTAssertEqual(api.preferenceCalls, 1); XCTAssertEqual(api.statusCalls, 1)
        await model.refresh(); await model.refresh()
        XCTAssertEqual(api.preferenceCalls, 1); XCTAssertEqual(api.statusCalls, 1)
        await model.refresh(includePreferences: true, includeStatus: true)
        XCTAssertEqual(api.preferenceCalls, 2); XCTAssertEqual(api.statusCalls, 2)
    }
    func testReadinessFailureRetriesOnlyOnExplicitSettingsRequest() async {
        let (model, api, _, _) = fixture()
        api.statusHandler = { throw APIError(status: 503, code: "fixture", message: "Synthetic readiness failure") }
        await model.start(); await model.refresh()
        XCTAssertNil(model.deliveryStatus); XCTAssertEqual(api.statusCalls, 1)
        await model.refresh(includeStatus: true)
        XCTAssertEqual(api.statusCalls, 2)
    }
    func testInvalidationsDuringRefreshProduceOneTrailingRead() async {
        let (model, api, _, _) = fixture(); await model.start()
        let delayed = Deferred<CalendarSnapshot>()
        api.calendarHandler = { api.calendarCalls == 2 ? try await delayed.wait() : api.calendarData }
        let first = Task { await model.refresh() }; await waitUntil { delayed.waiting }
        let entered = expectation(description: "Both invalidation callers entered"); entered.expectedFulfillmentCount = 2
        let second = Task { entered.fulfill(); await model.refresh(includePreferences: true) }
        let third = Task { entered.fulfill(); await model.refresh(includeStatus: true) }
        await fulfillment(of: [entered], timeout: 5)
        delayed.resolve(api.calendarData)
        await first.value; await second.value; await third.value
        XCTAssertEqual(api.householdCalls, 3, "Initial load plus one flight and one coalesced trailing read")
        XCTAssertEqual(api.sessionCalls, 3); XCTAssertEqual(api.preferenceCalls, 2); XCTAssertEqual(api.statusCalls, 2)
    }
    func testOldReadCannotReplaceConfirmedCompletionAndRowFinishesImmediately() async throws {
        let (model, api, _, _) = fixture(); await model.start()
        let oldSnapshot = api.data, delayed = Deferred<HouseholdSnapshot>()
        api.householdHandler = { api.householdCalls == 2 ? try await delayed.wait() : api.data }
        let refresh = Task { await model.refresh() }; await waitUntil { delayed.waiting }
        let chore = try XCTUnwrap(model.snapshot?.chores.first)
        await model.toggle(chore)
        XCTAssertTrue(model.changingChores.isEmpty, "Confirmed write must not spin until unrelated reads finish")
        XCTAssertTrue(model.snapshot?.chores.first?.completion.completed == true)
        XCTAssertTrue(model.isLoading)
        delayed.resolve(oldSnapshot); await refresh.value
        XCTAssertEqual(model.snapshot?.chores.first?.completion.version, 1)
        XCTAssertTrue(model.snapshot?.chores.first?.completion.completed == true)
        XCTAssertEqual(api.householdCalls, 3)
    }
    func testCachedReadyEmptyCalendarIsNotProofUntilCurrentSessionRead() async {
        let (model, api, store, cache) = fixture()
        let complete = CalendarSnapshot(status: "ready", events: [], lastSuccessfulSyncAt: "2026-10-17T18:00:00Z", error: nil, coverage: CalendarCoverage(startDate: "2026-10-17", endDateExclusive: "2026-11-17", timeZone: "America/Denver", complete: true, truncated: false))
        cache.value = CachedDashboard(identity: store.value!.session.cacheIdentity, savedAt: instant, snapshot: api.data, calendar: complete, notifications: [])
        let delayed = Deferred<CalendarSnapshot>(); api.calendarHandler = { try await delayed.wait() }
        let start = Task { await model.start() }; await waitUntil { delayed.waiting && model.canChange }
        XCTAssertNotNil(model.calendar)
        XCTAssertFalse(model.confirmsCalendarAvailability(from: "2026-10-17", to: "2026-10-31"))
        delayed.resolve(complete); await start.value
        XCTAssertTrue(model.confirmsCalendarAvailability(from: "2026-10-17", to: "2026-10-31"))
    }
    func testFailedCalendarRefreshCannotReuseReadyEmptyProof() async {
        var clock = instant
        let (model, api, _, _) = fixture(now: { clock })
        api.calendarData = CalendarSnapshot(status: "ready", events: [], lastSuccessfulSyncAt: "2026-10-17T18:00:00Z", error: nil, coverage: CalendarCoverage(startDate: "2026-10-17", endDateExclusive: "2026-11-17", timeZone: "America/Denver", complete: true, truncated: false))
        await model.start()
        XCTAssertTrue(model.confirmsCalendarAvailability(from: "2026-10-17", to: "2026-10-31"))
        clock = instant.addingTimeInterval(301)
        XCTAssertFalse(model.confirmsCalendarAvailability(from: "2026-10-17", to: "2026-10-31"))
        clock = instant
        api.calendarHandler = { throw APIError(status: 503, code: "fixture", message: "Synthetic unavailable calendar") }
        await model.refresh()
        XCTAssertEqual(model.calendar?.status, "ready", "Retain last snapshot for reading")
        XCTAssertFalse(model.confirmsCalendarAvailability(from: "2026-10-17", to: "2026-10-31"))
    }
    func testPreviousDayAcknowledgmentCannotCompleteNewDayOccurrence() async throws {
        var clock = Dates.instant("2026-10-18T05:59:00Z")!
        let (model, api, _, _) = fixture(now: { clock }); await model.start()
        let delayed = Deferred<CompletionResult>()
        api.completionHandler = { try await delayed.wait() }
        let chore = try XCTUnwrap(model.snapshot?.chores.first)
        let toggle = Task { await model.toggle(chore) }; await waitUntil { delayed.waiting }
        clock = Dates.instant("2026-10-18T06:01:00Z")!
        var next = chore; next.completion = ChoreCompletion(date: "2026-10-18", completed: false, version: 0, updatedAt: nil)
        api.data = HouseholdSnapshot(household: api.current.household, role: "admin", date: "2026-10-18", people: [], chores: [next])
        await model.refresh()
        XCTAssertEqual(model.snapshot?.date, "2026-10-18")
        delayed.resolve(CompletionResult(choreId: chore.id, date: "2026-10-17", completed: true, version: 1, updatedAt: nil, mutationId: "fixture-mutation"))
        await toggle.value; await model.refresh()
        XCTAssertEqual(model.snapshot?.chores.first?.completion.date, "2026-10-18")
        XCTAssertEqual(model.snapshot?.chores.first?.completion.version, 0)
        XCTAssertFalse(model.snapshot?.chores.first?.completion.completed ?? true)
    }
    func testAcknowledgmentMustMatchRequestedChoreAndOccurrence() async throws {
        for mismatch in ["id", "date"] {
            let (model, api, _, _) = fixture(); await model.start()
            let chore = try XCTUnwrap(model.snapshot?.chores.first)
            api.completionHandler = { CompletionResult(choreId: mismatch == "id" ? "different-chore" : chore.id, date: mismatch == "date" ? "2026-10-18" : "2026-10-17", completed: true, version: 1, updatedAt: nil, mutationId: "fixture-mutation") }
            await model.toggle(chore); await model.refresh()
            XCTAssertEqual(model.snapshot?.chores.first?.completion.version, 0)
            XCTAssertFalse(model.snapshot?.chores.first?.completion.completed ?? true)
        }
    }
    func testLatePreferencesSaveCannotRestoreStateAfterSignOut() async {
        let (model, api, _, _) = fixture(); await model.start()
        let delayed = Deferred<NotificationPreferences>()
        api.savePreferencesHandler = { _ in try await delayed.wait() }
        var changed = NotificationPreferences(); changed.pushEnabled = false
        let save = Task { await model.savePreferences(changed) }; await waitUntil { delayed.waiting }
        await model.signOut(); delayed.resolve(changed)
        let saved = await save.value
        XCTAssertFalse(saved); XCTAssertNil(model.preferences); XCTAssertNil(model.session); XCTAssertNil(model.message)
    }
    func testOldPreferencesRefreshCannotOverwriteConfirmedSave() async {
        let (model, api, _, _) = fixture(); await model.start()
        let delayed = Deferred<NotificationPreferences>()
        api.preferencesHandler = { try await delayed.wait() }
        let refresh = Task { await model.refresh(includePreferences: true) }; await waitUntil { delayed.waiting }
        var changed = NotificationPreferences(); changed.pushEnabled = false
        let saved = await model.savePreferences(changed); XCTAssertTrue(saved)
        delayed.resolve(NotificationPreferences()); await refresh.value
        XCTAssertEqual(model.preferences, changed)
    }
    func testPreferencesReadStartedDuringSaveCannotOverwriteItsAcknowledgment() async {
        let (model, api, _, _) = fixture(); await model.start()
        let saveReply = Deferred<NotificationPreferences>(), readReply = Deferred<NotificationPreferences>()
        api.savePreferencesHandler = { _ in try await saveReply.wait() }
        api.preferencesHandler = { try await readReply.wait() }
        var changed = NotificationPreferences(); changed.pushEnabled = false
        let save = Task { await model.savePreferences(changed) }; await waitUntil { saveReply.waiting }
        let refresh = Task { await model.refresh(includePreferences: true) }; await waitUntil { readReply.waiting }
        saveReply.resolve(changed); _ = await save.value
        readReply.resolve(NotificationPreferences()); await refresh.value
        XCTAssertEqual(model.preferences, changed)
    }
    func testLateMarkReadFailureCannotShowPreviousAccountError() async {
        let (model, api, _, _) = fixture()
        let item = FamilyNotification(id: "fixture-notification", kind: "chore_completed", title: "Synthetic notification", body: "Synthetic body", createdAt: "2026-10-17T18:00:00Z", readAt: nil, choreId: "fixture-chore", date: "2026-10-17")
        api.activityHandler = { [item] }; await model.start()
        let delayed = Deferred<Void>(); api.markReadHandler = { try await delayed.wait() }
        let read = Task { await model.markRead(item) }; await waitUntil { delayed.waiting }
        await model.signOut(); delayed.fail(APIError(status: 500, code: "fixture", message: "Synthetic previous-account error")); await read.value
        XCTAssertNil(model.message); XCTAssertTrue(model.notifications.isEmpty)
    }
    func testOldReadCannotResolveNewerUncertainWrite() async throws {
        let (model, api, _, _) = fixture(); await model.start()
        let oldRead = Deferred<HouseholdSnapshot>(), newRead = Deferred<HouseholdSnapshot>()
        api.householdHandler = { try await (api.householdCalls == 2 ? oldRead : newRead).wait() }
        api.completionHandler = { throw APIError(status: 0, code: "network_error", message: "Synthetic uncertain write") }
        let refresh = Task { await model.refresh() }; await waitUntil { oldRead.waiting }
        await model.toggle(try XCTUnwrap(model.snapshot?.chores.first))
        XCTAssertTrue(model.isStale); XCTAssertFalse(model.canChange)
        oldRead.resolve(api.data); await waitUntil { newRead.waiting }
        XCTAssertTrue(model.isStale, "Only a read started after the uncertain write may reopen editing")
        newRead.resolve(api.data); await refresh.value
        XCTAssertFalse(model.isStale); XCTAssertTrue(model.canChange)
    }
    func testSlowReadCannotRestoreSessionAfterSignOut() async {
        let (model, api, store, cache) = fixture(); await model.start()
        let delayed = Deferred<HouseholdSnapshot>()
        api.householdHandler = { try await delayed.wait() }
        let refresh = Task { await model.refresh() }; await waitUntil { delayed.waiting }
        await model.signOut(); delayed.resolve(api.data); await refresh.value
        XCTAssertNil(model.session); XCTAssertNil(model.snapshot); XCTAssertNil(store.value); XCTAssertNil(cache.value)
        XCTAssertFalse(model.canChange); XCTAssertFalse(model.isLoading)
    }
    func testIndependentPanelFailuresDoNotMarkCurrentHouseholdOffline() async {
        let (model, api, _, _) = fixture()
        api.calendarHandler = { throw APIError(status: 502, code: "fixture", message: "Synthetic calendar failure") }
        api.activityHandler = { throw APIError(status: 503, code: "fixture", message: "Synthetic activity failure") }
        await model.start()
        XCTAssertTrue(model.canChange); XCTAssertFalse(model.isStale)
        XCTAssertNotNil(model.calendarMessage); XCTAssertNotNil(model.activityMessage)
    }
    func testCachedCopyRemainsReadOnlyUntilAuthoritativeHouseholdArrives() async {
        let (model, api, store, cache) = fixture(), delayed = Deferred<HouseholdSnapshot>()
        cache.value = CachedDashboard(identity: store.value!.session.cacheIdentity, savedAt: instant, snapshot: api.data, calendar: api.calendarData, notifications: [])
        api.householdHandler = { try await delayed.wait() }
        let start = Task { await model.start() }; await waitUntil { delayed.waiting }
        XCTAssertNotNil(model.snapshot); XCTAssertTrue(model.isStale); XCTAssertFalse(model.canChange)
        delayed.resolve(api.data); await start.value
        XCTAssertTrue(model.canChange)
    }
    func testSyntheticAuthenticatedLayoutsAtLargeTextSizes() async {
        let (model, api, _, _) = fixture()
        api.calendarData = CalendarSnapshot(status: "ready", events: [
            CalendarEvent(id: "fixture-event", title: "Synthetic overnight family event", location: "Synthetic place", allDay: false, startAt: "2026-10-18T04:00:00Z", endAt: "2026-10-18T14:00:00Z", startDate: nil, endDateExclusive: nil, calendarId: "fixture-calendar")
        ], lastSuccessfulSyncAt: "2026-10-17T18:00:00Z", error: nil, calendars: [CalendarPaletteEntry(id: "fixture-calendar", name: "Synthetic family calendar", color: "#a91675")])
        await model.start()
        await attachLayout(NavigationStack { TodayScreen() }.environmentObject(model).environment(\.dynamicTypeSize, .accessibility2), name: "Synthetic Today - accessibility text")
        await attachLayout(NavigationStack { CalendarScreen() }.environmentObject(model), name: "Synthetic Calendar - overnight and palette")
        var quiet = NotificationPreferences(); quiet.quietStart = "21:00"; quiet.quietEnd = "07:00"
        await attachLayout(NavigationStack { NotificationPreferencesScreen(initial: quiet) }.environmentObject(model), name: "Synthetic notification preferences - native time pickers")
    }
    private func attachLayout<Content: View>(_ content: Content, name: String) async {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return XCTFail("Simulator window scene is required") }
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene); window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        let host = UIHostingController(rootView: content.preferredColorScheme(.light).tint(Brand.red)); window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKey() }
        host.view.frame = window.bounds; host.view.setNeedsLayout(); host.view.layoutIfNeeded()
        try? await Task.sleep(for: .milliseconds(150))
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        XCTAssertEqual(image.size.width, 402)
    }
    func testRevokedSessionClearsCachedDataRatherThanCallingItOffline() async {
        let (model, api, store, cache) = fixture()
        api.sessionHandler = { throw APIError(status: 401, code: "mobile_session_revoked", message: "Synthetic revoked session") }
        await model.start()
        XCTAssertNil(model.session); XCTAssertNil(model.snapshot); XCTAssertNil(store.value); XCTAssertNil(cache.value)
        XCTAssertEqual(api.householdCalls, 0)
    }
}
