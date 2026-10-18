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
private final class Deferred<Value> {
    private var continuation: CheckedContinuation<Value, Error>?
    private(set) var waiting = false
    func wait() async throws -> Value {
        try await withCheckedThrowingContinuation { continuation = $0; waiting = true }
    }
    func resolve(_ value: Value) { continuation?.resume(returning: value); continuation = nil }
    func fail(_ error: Error) { continuation?.resume(throwing: error); continuation = nil }
}

@MainActor
private final class DashboardAPI: FamilyAPI {
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
    func markRead(id: String) async throws { try await markReadHandler?() }
    func registerPush(token: String, environment: String, installationID: String) async throws { }
    func savePreferences(_ prefs: NotificationPreferences) async throws -> NotificationPreferences { try await savePreferencesHandler?(prefs) ?? prefs }
    func devices() async throws -> [MobileDevice] { [] }
    func revokeDevice(id: String) async throws { }
    private var unexpected: APIError { APIError(status: 0, code: "unexpected_test_call", message: "No account calls belong in dashboard state tests.") }
    func accountSignIn(email: String, password: String, invitation: String) async throws -> AccountOutcome { throw unexpected }
    func createAccount(name: String, email: String, password: String, invitation: String) async throws -> AccountOutcome { throw unexpected }
    func confirmAccount(email: String, code: String, invitation: String) async throws -> AccountOutcome { throw unexpected }
    func resendConfirmation(email: String) async throws { throw unexpected }
    func joinFamily(invitation: String) async throws -> AccountOutcome { throw unexpected }
    func cancelAccountOnboarding() async { }
    func createChildInvitation(personID: String, email: String) async throws -> ChildInvitation { throw unexpected }
}

@MainActor
final class AppModelTests: XCTestCase {
    private let instant = Dates.instant("2026-10-17T18:00:00Z")!
    private func fixture(now: (() -> Date)? = nil) -> (AppModel, DashboardAPI, MemoryCredentialStore, MemoryDashboardCache) {
        let home = Household(id: "fixture-home", title: "Synthetic family", timezone: "America/Denver")
        let session = MobileSession(authenticated: true, authType: "mobile", role: "admin", household: home, user: FamilyUser(id: "fixture-parent", name: "Synthetic parent", email: nil), personId: nil)
        let chore = Chore(id: "fixture-chore", title: "Synthetic chore", personId: nil, weekdays: Array(0...6), version: 1, dueTime: "18:00", reminderMinutes: 15, completion: ChoreCompletion(date: "2026-10-17", completed: false, version: 0, updatedAt: nil))
        let data = HouseholdSnapshot(household: home, role: "admin", date: "2026-10-17", people: [], chores: [chore])
        let store = MemoryCredentialStore(MobileCredential(token: String(repeating: "a", count: 43), expiresAt: "2099-01-01T00:00:00Z", session: session))
        let api = DashboardAPI(session: session, data: data), cache = MemoryDashboardCache()
        return (AppModel(api: api, keychain: store, cache: cache, now: now ?? { self.instant }, observesPush: false), api, store, cache)
    }
    private func waitUntil(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let limit = ContinuousClock.now.advanced(by: .seconds(5))
        while !condition() && ContinuousClock.now < limit { try? await Task.sleep(for: .milliseconds(2)) }
        XCTAssertTrue(condition(), "Expected asynchronous state was not reached", file: file, line: line)
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
