import Foundation
import SwiftUI
import UserNotifications
import UIKit

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var accountStage: AccountStage = .entry
    @Published private(set) var session: MobileSession?
    @Published private(set) var snapshot: HouseholdSnapshot?
    @Published private(set) var calendar: CalendarSnapshot?
    @Published private(set) var calendarAgenda: [CalendarDaySection] = []
    @Published private(set) var notifications: [FamilyNotification] = []
    @Published private(set) var deliveryStatus: MobileServiceStatus?
    @Published private(set) var preferences: NotificationPreferences?
    @Published private(set) var isStale = true
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var isLoading = false
    @Published private(set) var isSigningIn = false
    @Published private(set) var lastMutationNeedsReview = false
    @Published private(set) var accountDeletionNeedsReview = false
    @Published private(set) var changingChores: Set<String> = []
    @Published var message: String?
    @Published private(set) var refreshIssue: String?
    @Published private(set) var calendarMessage: String?
    @Published private(set) var activityMessage: String?
    @Published private(set) var hasLoadedActivity = false
    @Published var selectedTab = 0
    @Published var openedOccurrence: ChoreOccurrence?
    let internet: InternetModel
    private let api: any FamilyAPI
    private let keychain: any CredentialStoring
    private let cache: any DashboardCaching
    private let now: () -> Date
    private var refreshTask: Task<Void, Never>?
    private var refreshRequested = false
    private var preferencesRequested = false
    private var statusRequested = false
    private var hasRequestedPreferences = false
    private var hasRequestedStatus = false
    // An old read cannot resolve the outcome of a newer uncertain write.
    private var uncertaintyVersion = 0
    private var preferencesRevision = 0
    private var agendaCache = CalendarAgendaCache()
    private var calendarReadAt: Date?
    private var confirmedOccurrences: [String: ChoreOccurrence] = [:]
    private var credential: MobileCredential?
    private var generation = 0
    private var hasStarted = false
    private var registeredPushKey: String?
    private var isRegisteringPush = false
    var isAdmin: Bool { session?.isAdmin == true }
    var canManageChores: Bool { session?.isChild != true && session != nil && (isAdmin || snapshot?.capabilities?.manageChores == true) }
    var canManageInternet: Bool { session?.isChild != true && session != nil && (isAdmin || snapshot?.capabilities?.manageInternet == true) }
    var canChange: Bool { session != nil && !isStale && snapshot?.date == today }
    var zone: TimeZone { session?.household.timeZone ?? TimeZone(secondsFromGMT: 0)! }
    var today: String { Dates.day(now(), in: zone) }
    var presentationNow: Date { now() }
    var visibleChores: [Chore] { snapshot?.todaysChores ?? [] }
    var visibleOccurrences: [ChoreOccurrence] {
        (snapshot?.occurrences ?? []).filter { $0.date == snapshot?.date && (session?.isChild != true || $0.personId == session?.personId) }
    }
    var chorePeople: [Person] {
        var people = snapshot?.people ?? []
        for item in visibleOccurrences {
            if let id = item.personId, !people.contains(where: { $0.id == id }) { people.append(Person(id: id, name: item.personName ?? "Family member", color: "#00748c", version: 1)) }
        }
        return people
    }
    var isSchoolDay: Bool { snapshot?.schoolDay?.date == snapshot?.date && snapshot?.schoolDay?.type == "school_day" }
    func isCurrentSchoolSchedule(_ item: ChoreOccurrence) -> Bool { item.applies(to: snapshot?.schoolDay) }
    var requiredOccurrences: [ChoreOccurrence] { visibleOccurrences.filter { $0.required && !$0.isSkipped && isCurrentSchoolSchedule($0) } }
    var requiredCount: Int { snapshot?.occurrences == nil ? visibleChores.count : requiredOccurrences.count }
    var completedCount: Int { snapshot?.occurrences == nil ? visibleChores.filter { $0.completion.completed }.count : requiredOccurrences.filter(\.isDone).count }
    var approvalCount: Int { requiredOccurrences.filter(\.isSubmitted).count }
    var routines: [ChoreRoutine] { snapshot?.routines ?? (snapshot?.chores ?? []).map(ChoreRoutine.init(legacy:)) }
    var unreadCount: Int { notifications.filter { $0.readAt == nil }.count }
    var canViewChildSettings: Bool { session?.isChild != true }
    func confirmsCalendarAvailability(from: String, to: String) -> Bool {
        guard let read = calendarReadAt, calendarMessage == nil, (0...300).contains(now().timeIntervalSince(read)) else { return false }
        return calendar?.confirmsAvailability(from: from, to: to, zone: zone) == true
    }
    init(api: (any FamilyAPI)? = nil, keychain: any CredentialStoring = SecureStore(),
         cache: any DashboardCaching = DashboardCache(), now: @escaping () -> Date = Date.init,
         observesPush: Bool = true) {
        let client = api ?? APIClient()
        self.api = client; self.internet = InternetModel(api: client); self.keychain = keychain; self.cache = cache; self.now = now
        self.internet.authenticationFailed = { [weak self] reason in await self?.forgetSession(reason: reason) }
        if observesPush { NotificationController.shared.onToken = { [weak self] token in await self?.registerPush(token) } }
    }
    func start() async {
        guard !hasStarted else { return }; hasStarted = true
        do {
            if let saved = try keychain.load(), saved.isValid {
                credential = saved; session = saved.session; api.mobileToken = saved.token
                if let savedCache = cache.read(identity: saved.session.cacheIdentity) {
                    snapshot = savedCache.snapshot; applyCalendar(savedCache.calendar); notifications = savedCache.notifications
                    lastUpdated = savedCache.savedAt
                }
                await refresh(includePreferences: true)
            } else { try keychain.clear(); cache.clear() }
        } catch { message = error.localizedDescription }
    }
    func signIn(email: String, password: String, invitation: String = "") async -> Bool {
        guard !isSigningIn else { return false }; isSigningIn = true
        defer { isSigningIn = false }
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        do { let outcome = try await api.accountSignIn(email: cleanEmail, password: password, invitation: invitation); try await continueAccount(outcome, email: cleanEmail); return true }
        catch { message = error.localizedDescription; return false }
    }
    func createAccount(name: String, email: String, password: String, invitation: String = "") async -> Bool {
        guard !isSigningIn else { return false }; isSigningIn = true
        defer { isSigningIn = false }
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        do { let outcome = try await api.createAccount(name: name.trimmingCharacters(in: .whitespacesAndNewlines), email: cleanEmail, password: password, invitation: invitation); try await continueAccount(outcome, email: cleanEmail); return true }
        catch { message = error.localizedDescription; return false }
    }
    func confirmAccount(code: String, invitation: String = "") async -> Bool {
        guard !isSigningIn, let email = accountStage.email else { return false }; isSigningIn = true
        defer { isSigningIn = false }
        do { let outcome = try await api.confirmAccount(email: email, code: code, invitation: invitation); try await continueAccount(outcome, email: email); return true }
        catch { message = error.localizedDescription; return false }
    }
    func joinFamily(invitation: String) async -> Bool {
        guard !isSigningIn, let email = accountStage.email else { return false }; isSigningIn = true
        defer { isSigningIn = false }
        do { let outcome = try await api.joinFamily(invitation: invitation); try await continueAccount(outcome, email: email); return true }
        catch { message = error.localizedDescription; return false }
    }
    private func continueAccount(_ outcome: AccountOutcome, email: String) async throws {
        accountDeletionNeedsReview = false
        switch outcome {
        case .authenticated(let credential): try accept(credential); accountStage = .entry; await refresh(includePreferences: true)
        case .confirmationRequired: accountStage = .confirmEmail(email)
        case .invitationRequired: accountStage = .joinFamily(email)
        }
    }
    func resendConfirmation() async -> Bool {
        guard !isSigningIn, let email = accountStage.email else { return false }; isSigningIn = true
        defer { isSigningIn = false }
        do { try await api.resendConfirmation(email: email); return true }
        catch { message = error.localizedDescription; return false }
    }
    func cancelAccountOnboarding() async {
        guard !isSigningIn else { return }; isSigningIn = true
        await api.cancelAccountOnboarding(); accountStage = .entry; isSigningIn = false
    }
    private func accept(_ value: MobileCredential) throws {
        guard value.isValid else { throw APIError(status: 0, code: "invalid_session", message: "The server did not create a valid app session.") }
        try keychain.save(value)
        generation += 1; cancelRefresh(); cache.clear(); clearDashboard()
        credential = value; session = value.session; api.mobileToken = value.token
    }
    /// Coalesce pushes, foreground polling and user refresh into a single flight
    /// plus one trailing read. Every caller waits for the coalesced work.
    func refresh(includePreferences: Bool = false, includeStatus: Bool = false) async {
        guard session != nil else { return }
        refreshRequested = true
        preferencesRequested = preferencesRequested || includePreferences || !hasRequestedPreferences
        statusRequested = statusRequested || includeStatus || !hasRequestedStatus
        if preferencesRequested { hasRequestedPreferences = true }
        if statusRequested { hasRequestedStatus = true }
        if let task = refreshTask { await task.value; return }
        let started = generation
        isLoading = true
        let task = Task { [weak self] in
            guard let self else { return }
            await self.refreshLoop(generation: started)
        }
        refreshTask = task
        await task.value
    }
    private func refreshLoop(generation started: Int) async {
        defer { if generation == started { refreshTask = nil; isLoading = false } }
        while refreshRequested && generation == started && !Task.isCancelled {
            refreshRequested = false
            let loadPreferences = preferencesRequested, loadStatus = statusRequested
            preferencesRequested = false; statusRequested = false
            await refreshCycle(generation: started, includePreferences: loadPreferences, includeStatus: loadStatus)
        }
    }
    private func refreshCycle(generation started: Int, includePreferences: Bool, includeStatus: Bool) async {
        do {
            let current = try await api.currentSession()
            guard started == generation, !Task.isCancelled else { return }
            guard current.cacheIdentity == session?.cacheIdentity else {
                throw APIError(status: 401, code: "session_changed", message: "This app's access changed. Sign in again.")
            }
            session = current
            internet.bind(current)
            if var credential, credential.session != current { credential.session = current; try keychain.save(credential); self.credential = credential }
        } catch { await failedHouseholdRefresh(error, generation: started); return }
        // Each pane publishes independently. A slow calendar never gates fresh chores.
        async let household: Void = refreshHousehold(generation: started)
        async let events: Void = refreshCalendar(generation: started)
        async let activity: Void = refreshActivity(generation: started)
        async let settings: Void = refreshSettings(generation: started, preferences: includePreferences, status: includeStatus)
        async let network: Void = internet.refresh()
        _ = await (household, events, activity, settings, network)
        guard started == generation, !Task.isCancelled else { return }
        persistCache()
        if let token = NotificationController.shared.currentToken { await registerPush(token) }
    }
    private func refreshHousehold(generation started: Int) async {
        let uncertaintyAtStart = uncertaintyVersion
        do {
            let result = try await api.household(date: today)
            guard started == generation, !Task.isCancelled else { return }
            snapshot = mergeHousehold(result)
            guard uncertaintyAtStart == uncertaintyVersion else { refreshRequested = true; return }
            lastUpdated = now(); isStale = false; refreshIssue = nil
            persistCache()
        } catch { await failedHouseholdRefresh(error, generation: started) }
    }
    private func failedHouseholdRefresh(_ error: Error, generation started: Int) async {
        guard started == generation, !(error is CancellationError), !Task.isCancelled else { return }
        if (error as? APIError)?.isAuthenticationFailure == true { await forgetSession(reason: error.localizedDescription); return }
        isStale = true; refreshIssue = error.localizedDescription
    }
    private func refreshCalendar(generation started: Int) async {
        let day = today
        do {
            let result = try await api.calendar(from: day, to: Dates.shiftedDay(day, by: 14))
            guard started == generation, !Task.isCancelled else { return }
            calendarReadAt = now(); applyCalendar(result); calendarMessage = nil
        } catch {
            guard started == generation, !(error is CancellationError), !Task.isCancelled else { return }
            if (error as? APIError)?.isAuthenticationFailure == true { await forgetSession(reason: error.localizedDescription); return }
            calendarReadAt = nil
            calendarMessage = "Calendar could not refresh. Any events shown are from the last successful sync."
        }
    }
    private func refreshActivity(generation started: Int) async {
        do {
            let result = try await api.notifications()
            guard started == generation, !Task.isCancelled else { return }
            // A response started before mark-as-read must not restore the badge.
            let read = Dictionary(uniqueKeysWithValues: notifications.compactMap { item in item.readAt.map { (item.id, $0) } })
            notifications = result.map { item in var current = item; current.readAt = current.readAt ?? read[item.id]; return current }
            activityMessage = nil; hasLoadedActivity = true
        } catch {
            guard started == generation, !(error is CancellationError), !Task.isCancelled else { return }
            if (error as? APIError)?.isAuthenticationFailure == true { await forgetSession(reason: error.localizedDescription); return }
            activityMessage = "Activity could not refresh. Pull to try again."
        }
    }
    private func refreshSettings(generation started: Int, preferences loadPreferences: Bool, status loadStatus: Bool) async {
        async let preferences: Void = refreshPreferences(generation: started, enabled: loadPreferences)
        async let status: Void = refreshStatus(generation: started, enabled: loadStatus)
        _ = await (preferences, status)
    }
    private func refreshPreferences(generation started: Int, enabled: Bool) async {
        guard enabled else { return }
        let revision = preferencesRevision
        do { let result = try await api.preferences(); if started == generation && revision == preferencesRevision && !Task.isCancelled { preferences = result } }
        catch { /* Settings retains its explicit unavailable state and retry. */ }
    }
    private func refreshStatus(generation started: Int, enabled: Bool) async {
        guard enabled else { return }
        do { let result = try await api.serviceStatus(); if started == generation && !Task.isCancelled { deliveryStatus = result } }
        catch { if started == generation && !Task.isCancelled { deliveryStatus = nil } }
    }
    private func mergeHousehold(_ incoming: HouseholdSnapshot) -> HouseholdSnapshot {
        var merged = incoming
        if let occurrences = incoming.occurrences {
            merged.occurrences = occurrences.compactMap { occurrence in
                let known = confirmedOccurrences[occurrence.id]
                let current = known.map { $0.version > occurrence.version ? $0 : occurrence } ?? occurrence
                return current.date == incoming.date ? current : nil
            }
            for occurrence in merged.occurrences ?? [] {
                if occurrence.version >= (confirmedOccurrences[occurrence.id]?.version ?? 0) { confirmedOccurrences[occurrence.id] = occurrence }
            }
            merged.chores = (merged.occurrences ?? []).filter { !$0.isSkipped }.map(\.legacy)
        }
        guard let existing = snapshot, existing.date == incoming.date else { return merged }
        let completions = Dictionary(uniqueKeysWithValues: existing.chores.map { ($0.id, $0.completion) })
        for index in merged.chores.indices {
            if let completion = completions[merged.chores[index].id], completion.version > merged.chores[index].completion.version {
                merged.chores[index].completion = completion
            }
        }
        return merged
    }
    private func applyCalendar(_ value: CalendarSnapshot?) {
        calendar = value
        if let sections = agendaCache.update(events: value?.events ?? [], calendars: value?.calendars ?? [], from: today, zone: zone) { calendarAgenda = sections }
    }
    private func cancelRefresh() {
        refreshTask?.cancel(); refreshTask = nil; isLoading = false
        refreshRequested = false; preferencesRequested = false; statusRequested = false
    }
    private func persistCache() {
        guard let session, let lastUpdated else { return }
        do { try cache.write(CachedDashboard(identity: session.cacheIdentity, savedAt: lastUpdated, snapshot: snapshot, calendar: calendar, notifications: notifications)) }
        catch { message = "The latest data is visible, but a protected offline copy could not be saved." }
    }
    func toggle(_ chore: Chore) async {
        guard canChange, !changingChores.contains(chore.id), let snapshot else { return }
        changingChores.insert(chore.id); let started = generation
        defer { changingChores.remove(chore.id) }
        do {
            let result = try await api.setCompletion(chore, date: snapshot.date, completed: !chore.completion.completed, mutationID: UUID().uuidString.lowercased())
            guard started == generation else { return }
            guard result.choreId == chore.id, result.date == snapshot.date else {
                uncertaintyVersion += 1; isStale = true
                changingChores.remove(chore.id); Task { await refresh() }; return
            }
            if self.snapshot?.date == snapshot.date, let i = self.snapshot?.chores.firstIndex(where: { $0.id == chore.id }) {
                if result.version >= (self.snapshot?.chores[i].completion.version ?? 0) {
                    self.snapshot?.chores[i].completion = ChoreCompletion(date: result.date, completed: result.completed, version: result.version, updatedAt: result.updatedAt)
                }
                persistCache()
            }
            changingChores.remove(chore.id)
            UISelectionFeedbackGenerator().selectionChanged()
            Task { await refresh() }
        } catch {
            guard started == generation else { return }
            uncertaintyVersion += 1; isStale = true
            if let apiError = error as? APIError, apiError.isConflict {
                message = "This task changed on another device. Your change was not forced. Refresh, review the current status, then try again."
            } else { message = error.localizedDescription }
        }
    }
    func saveChore(_ draft: ChoreDraft, id: String?) async -> Bool {
        guard canManageChores, canChange else { return false }
        lastMutationNeedsReview = false; let started = generation
        do { try await api.saveChore(draft, id: id); guard started == generation else { return false }; Task { await refresh() }; return true }
        catch { await failedChoreMutation(error, generation: started); return false }
    }
    func createTasks(_ draft: ChoreDraft, personIDs: [String], mutationID: String) async -> Bool {
        guard canManageChores, canChange, !personIDs.isEmpty else { return false }
        lastMutationNeedsReview = false; let started = generation
        do { try await api.createTasks(draft, personIDs: personIDs, mutationID: mutationID); guard started == generation else { return false }; Task { await refresh() }; return true }
        catch { await failedChoreMutation(error, generation: started); return false }
    }
    func deleteChore(_ chore: Chore) async -> Bool {
        guard canManageChores, canChange else { return false }
        lastMutationNeedsReview = false; let started = generation
        do { try await api.deleteChore(chore); guard started == generation else { return false }; Task { await refresh() }; return true }
        catch { await failedChoreMutation(error, generation: started); return false }
    }
    func currentOccurrence(_ original: ChoreOccurrence) -> ChoreOccurrence {
        let current = snapshot?.occurrences?.first(where: { $0.id == original.id })
        let confirmed = confirmedOccurrences[original.id]
        return [original, current, confirmed].compactMap { $0 }.max(by: { $0.version < $1.version }) ?? original
    }
    func canChangeOccurrence(_ occurrence: ChoreOccurrence) -> Bool {
        canChange && occurrence.date == today && (session?.isChild != true || occurrence.personId == session?.personId)
    }
    func toggleOccurrence(_ occurrence: ChoreOccurrence) async -> Bool {
        guard canChangeOccurrence(occurrence), occurrence.canComplete, !changingChores.contains(occurrence.id) else { return false }
        return await mutateOccurrence(occurrence) {
            try await self.api.setOccurrenceCompletion(occurrence, completed: !occurrence.completion.completed, mutationID: UUID().uuidString.lowercased())
        }
    }
    func actOnOccurrence(_ occurrence: ChoreOccurrence, action: String, reason: String? = nil, toDate: String? = nil, dueTime: String? = nil, steps: [String]? = nil) async -> Bool {
        guard canChangeOccurrence(occurrence), !changingChores.contains(occurrence.id), action == "subtasks" || canManageChores else { return false }
        let request = OccurrenceAction(action: action, expectedVersion: occurrence.version, mutationId: UUID().uuidString.lowercased(), reason: reason, toDate: toDate, dueTime: dueTime, completedSubtaskIds: steps)
        return await mutateOccurrence(occurrence, expectedDate: toDate) { try await self.api.changeOccurrence(occurrence.id, action: request) }
    }
    private func mutateOccurrence(_ occurrence: ChoreOccurrence, expectedDate: String? = nil, operation: () async throws -> ChoreOccurrence) async -> Bool {
        changingChores.insert(occurrence.id); lastMutationNeedsReview = false; let started = generation, sourceDay = snapshot?.date
        defer { changingChores.remove(occurrence.id) }
        do {
            let result = try await operation()
            guard started == generation else { return false }
            guard result.id == occurrence.id, result.choreId == occurrence.choreId, result.date == (expectedDate ?? occurrence.date) else {
                throw APIError(status: 0, code: "invalid_response", message: "The task change could not be confirmed. Refresh before trying again.")
            }
            if result.version >= (confirmedOccurrences[result.id]?.version ?? 0) { confirmedOccurrences[result.id] = result }
            if snapshot?.date == sourceDay, let current = snapshot { snapshot = mergeHousehold(current) }
            // An acknowledgment may arrive after midnight or a reschedule. Only
            // the current day's matching occurrence is ever updated on screen.
            if snapshot?.date == sourceDay, var current = snapshot, var occurrences = current.occurrences {
                if let index = occurrences.firstIndex(where: { $0.id == result.id }) {
                    if result.date == current.date { if result.version >= occurrences[index].version { occurrences[index] = result } }
                    else { occurrences.remove(at: index) }
                }
                current.occurrences = occurrences; current.chores = occurrences.filter { !$0.isSkipped }.map(\.legacy); snapshot = current
            }
            persistCache(); changingChores.remove(occurrence.id); UISelectionFeedbackGenerator().selectionChanged()
            Task {
                async let household: Void = refresh()
                async let rewards: Void = internet.refresh(celebrateRewards: result.status == "completed" && result.required)
                _ = await (household, rewards)
            }; return true
        } catch { await failedChoreMutation(error, generation: started); return false }
    }
    private func failedChoreMutation(_ error: Error, generation started: Int) async {
        guard generation == started, !(error is CancellationError) else { return }
        if (error as? APIError)?.isAuthenticationFailure == true { await forgetSession(reason: error.localizedDescription); return }
        let failure = error as? APIError
        lastMutationNeedsReview = failure.map { $0.isConflict || $0.status == 0 || $0.status >= 500 } ?? true
        if lastMutationNeedsReview { uncertaintyVersion += 1; isStale = true }
        message = lastMutationNeedsReview ? "This change could not be confirmed or the task changed elsewhere. Refresh and review its current state before trying again." : error.localizedDescription
    }
    func loadChoreHistory(from: String, to: String, personID: String?) async throws -> [ChoreHistoryItem] {
        let started = generation
        do {
            let result = try await api.choreHistory(from: from, to: to, personID: session?.isChild == true ? session?.personId : personID)
            guard started == generation else { throw CancellationError() }; return result
        } catch { guard started == generation else { throw CancellationError() }; throw error }
    }
    func loadChoreBreaks() async throws -> [ChoreBreak] {
        guard canManageChores else { throw APIError(status: 403, code: "parent_required", message: "A parent with task permission must manage task breaks.") }
        let started = generation
        do { let result = try await api.choreBreaks(); guard started == generation else { throw CancellationError() }; return result }
        catch { guard started == generation else { throw CancellationError() }; throw error }
    }
    func loadSchoolCalendar(date: String) async throws -> SchoolCalendarResponse {
        let started = generation
        do { let result = try await api.schoolCalendar(date: date); guard started == generation else { throw CancellationError() }; return result }
        catch { guard started == generation else { throw CancellationError() }; throw error }
    }
    func changeSchoolDay(_ draft: SchoolDayOverrideDraft) async -> Bool {
        guard canEditSchoolDate(draft.change.date) else { return false }; lastMutationNeedsReview = false; let started = generation
        do {
            _ = try await api.changeSchoolDay(draft); guard started == generation else { return false }
            await refresh(); return true
        } catch { await failedChoreMutation(error, generation: started); return false }
    }
    func canEditSchoolDate(_ date: String) -> Bool { canManageChores && canChange && Dates.dayDate(date) != nil && date >= today }
    func createChoreBreak(_ draft: ChoreBreakDraft) async -> Bool {
        guard canManageChores, canChange else { return false }; lastMutationNeedsReview = false; let started = generation
        do { _ = try await api.createChoreBreak(draft); guard started == generation else { return false }; Task { await refresh() }; return true }
        catch { await failedChoreMutation(error, generation: started); return false }
    }
    func revokeChoreBreak(_ item: ChoreBreak, reason: String) async -> Bool {
        guard canManageChores, canChange else { return false }; lastMutationNeedsReview = false; let started = generation
        do { _ = try await api.revokeChoreBreak(item, reason: reason, mutationID: UUID().uuidString.lowercased()); guard started == generation else { return false }; Task { await refresh() }; return true }
        catch { await failedChoreMutation(error, generation: started); return false }
    }
    func deleteRoutine(_ routine: ChoreRoutine) async -> Bool { await deleteChore(routine.legacy) }
    func inviteChild(_ person: Person, email: String) async throws -> ChildInvitation {
        guard isAdmin else { throw APIError(status: 403, code: "admin_required", message: "Only a parent administrator can invite a child account.") }
        return try await api.createChildInvitation(personID: person.id, email: email.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    func devices() async throws -> [MobileDevice] { try await api.devices() }
    func revoke(_ id: String) async throws { try await api.revokeDevice(id: id) }
    func savePreferences(_ value: NotificationPreferences) async -> Bool {
        let started = generation
        preferencesRevision += 1; let revision = preferencesRevision
        do {
            let result = try await api.savePreferences(value)
            guard started == generation, revision == preferencesRevision else { return false }
            preferencesRevision += 1; preferences = result; return true
        } catch {
            guard started == generation, revision == preferencesRevision else { return false }
            preferencesRevision += 1; message = error.localizedDescription; return false
        }
    }
    func markRead(_ item: FamilyNotification) async {
        guard item.readAt == nil, !isStale else { return }
        let started = generation
        do {
            try await api.markRead(id: item.id)
            guard started == generation else { return }
            if let i = notifications.firstIndex(where: { $0.id == item.id }) { notifications[i].readAt = ISO8601DateFormatter().string(from: Date()) }
            persistCache()
        } catch { if started == generation { message = error.localizedDescription } }
    }
    func openNotification(id: String) async {
        guard session != nil else { return }
        let started = generation
        do {
            // The push supplies only an opaque lookup key. Navigation and detail
            // are accepted exclusively from this account's authenticated inbox.
            let inbox = try await api.notifications()
            guard started == generation else { return }
            let read = Dictionary(uniqueKeysWithValues: notifications.compactMap { item in item.readAt.map { (item.id, $0) } })
            notifications = inbox.map { item in var current = item; current.readAt = current.readAt ?? read[item.id]; return current }
            hasLoadedActivity = true; activityMessage = nil; persistCache()
            selectedTab = 4
            guard let item = inbox.first(where: { $0.id == id }) else { return }
            switch item.target {
            case "today": selectedTab = 0
            case "chores": selectedTab = 1
            case "devices":
                selectedTab = 3; await internet.refresh()
                guard started == generation else { return }
                if let sessionID = item.sessionId, let networkSession = internet.sessions.first(where: { $0.id == sessionID }) { internet.openedSession = networkSession }
            default: break
            }
            if let occurrenceID = item.occurrenceId,
               let occurrence = visibleOccurrences.first(where: { $0.id == occurrenceID }) { openedOccurrence = occurrence }
            await markRead(item)
        } catch {
            guard started == generation else { return }
            selectedTab = 4
            if (error as? APIError)?.isAuthenticationFailure == true { await forgetSession(reason: error.localizedDescription) }
            else { activityMessage = "This update could not be loaded. Refresh Activity while online." }
        }
    }
    func requestPasswordReset(email: String) async -> Bool {
        let started = generation
        do { try await api.requestPasswordReset(email: email.trimmingCharacters(in: .whitespacesAndNewlines)); return started == generation }
        catch { if started == generation { message = error.localizedDescription }; return false }
    }
    func resetPassword(email: String, token: String, recoveryLink: String, password: String) async -> Bool {
        let started = generation
        do {
            try await api.resetPassword(email: email.trimmingCharacters(in: .whitespacesAndNewlines), token: token, recoveryLink: recoveryLink.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            guard started == generation else { return false }
            await forgetSession(reason: nil); accountStage = .entry; return true
        } catch { if started == generation { message = error.localizedDescription }; return false }
    }
    var canDeleteAccount: Bool {
        if session != nil { return session?.authType == "mobile" }
        if case .joinFamily = accountStage { return true }
        return false
    }
    func deleteAccount(password: String, confirmation: String) async -> Bool {
        guard canDeleteAccount, !isSigningIn, !password.isEmpty, password.count <= 1024, confirmation == "DELETE MY ACCOUNT" else { return false }
        let started = generation; isSigningIn = true; accountDeletionNeedsReview = false
        defer { isSigningIn = false }
        do {
            try await api.deleteAccount(password: password); guard started == generation else { return false }
            await forgetSession(reason: nil); accountStage = .entry; return true
        } catch {
            guard started == generation else { return false }
            let failure = error as? APIError
            accountDeletionNeedsReview = failure.map { $0.status == 0 || $0.status >= 500 } ?? true
            if failure?.isAuthenticationFailure == true { await forgetSession(reason: "Sign in again to verify your account before retrying deletion."); accountStage = .entry }
            else { message = accountDeletionNeedsReview ? "Account deletion could not be confirmed. Sign in again to check your account before retrying. Any remaining account can be deleted without joining a family." : error.localizedDescription }
            return false
        }
    }
    func transferOwnership(userID: String) async -> Bool {
        guard isAdmin, !isStale else { return false }; let started = generation
        do {
            try await api.transferOwnership(userID: userID); guard started == generation else { return false }
            message = nil; await refresh(includePreferences: true); return generation == started
        } catch { if started == generation { message = error.localizedDescription }; return false }
    }
    func frameAccessCode(scope: String, personID: String?) async throws -> FrameAccessCode {
        let permitted = scope == "child" && (session?.isChild == true ? personID != nil && personID == session?.personId : canManageInternet)
            || scope == "parent" && (canManageChores || canManageInternet)
        guard session != nil, !isStale, permitted else {
            throw APIError(status: 403, code: "parent_required", message: "Your account cannot unlock those frame controls.")
        }
        let started = generation
        do { let result = try await api.createFrameAccessCode(scope: scope, personID: personID); guard started == generation else { throw CancellationError() }; return result }
        catch { guard started == generation else { throw CancellationError() }; throw error }
    }
    func familyMembers() async throws -> [FamilyMember] {
        guard isAdmin else { throw APIError(status: 403, code: "admin_required", message: "Only a parent administrator can change caregiver access.") }
        let started = generation
        do { let result = try await api.members(); guard started == generation else { throw CancellationError() }; return result }
        catch { guard started == generation else { throw CancellationError() }; throw error }
    }
    func changeCaregiver(_ id: String, capabilities: ParentCapabilities) async -> Bool {
        guard isAdmin, !isStale else { return false }; let started = generation
        do { _ = try await api.changeMemberCapabilities(id, capabilities: capabilities); return started == generation }
        catch { if started == generation { message = "Caregiver access was not confirmed. Refresh and review before trying again." }; return false }
    }
    func registerPush(_ token: String) async {
        guard let session else { return }
        let registrationKey = session.cacheIdentity + "|" + token
        guard registeredPushKey != registrationKey, !isRegisteringPush else { return }
        isRegisteringPush = true
        defer { isRegisteringPush = false }
        let started = generation
        do {
            let installationID = try keychain.installationID()
            do {
                try await api.registerPush(token: token, environment: NotificationController.shared.environment, installationID: installationID)
            } catch let error as APIError where error.status == 409 && error.code == "installation_conflict" {
                guard started == generation else { return }
                let replacement = try keychain.replaceInstallationID()
                // One fresh-identity attempt for this specific binding conflict only.
                try await api.registerPush(token: token, environment: NotificationController.shared.environment, installationID: replacement)
            }
            guard started == generation else { return }
            registeredPushKey = registrationKey
            NotificationController.shared.registrationMessage = "Registered with Family Frame"
        } catch { NotificationController.shared.registrationMessage = "Push registration has not reached Family Frame. Open the app online to retry." }
    }
    func sendTestNotification() async throws {
        guard session != nil else { throw APIError(status: 401, code: "session_required", message: "Sign in again to test notifications.") }
        let started = generation
        do {
            try await api.sendTestNotification()
            guard started == generation else { throw CancellationError() }
        } catch {
            guard started == generation else { throw CancellationError() }
            throw error
        }
    }
    func signOut() async {
        do { try await api.signOut(); await forgetSession(reason: nil) }
        catch {
            // Local access still ends; do not pretend the server confirmed revocation.
            await forgetSession(reason: "Signed out on this device. Server revocation could not be confirmed; a parent can revoke this device in Settings.")
        }
    }
    private func forgetSession(reason: String?) async {
        generation += 1; cancelRefresh(); api.mobileToken = nil; credential = nil; session = nil
        clearDashboard(); cache.clear()
        do { try keychain.clear() } catch { message = error.localizedDescription; return }
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        message = reason
    }
    private func clearDashboard() {
        internet.bind(nil)
        accountDeletionNeedsReview = false
        snapshot = nil; calendar = nil; calendarAgenda = []; agendaCache = CalendarAgendaCache(); calendarReadAt = nil; confirmedOccurrences = [:]; openedOccurrence = nil; notifications = []; preferences = nil; deliveryStatus = nil; lastUpdated = nil
        hasRequestedPreferences = false; hasRequestedStatus = false
        changingChores = []; registeredPushKey = nil; isStale = true; refreshIssue = nil; calendarMessage = nil; activityMessage = nil; hasLoadedActivity = false; selectedTab = 0
    }
}
