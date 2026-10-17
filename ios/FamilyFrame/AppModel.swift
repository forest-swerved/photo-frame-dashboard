import Foundation
import SwiftUI
import UserNotifications

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var session: MobileSession?
    @Published private(set) var snapshot: HouseholdSnapshot?
    @Published private(set) var calendar: CalendarSnapshot?
    @Published private(set) var notifications: [FamilyNotification] = []
    @Published private(set) var deliveryStatus: MobileServiceStatus?
    @Published private(set) var preferences: NotificationPreferences?
    @Published private(set) var isStale = true
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var isLoading = false
    @Published private(set) var isSigningIn = false
    @Published private(set) var lastMutationNeedsReview = false
    @Published private(set) var changingChores: Set<String> = []
    @Published var message: String?
    @Published private(set) var refreshIssue: String?
    @Published private(set) var calendarMessage: String?
    @Published private(set) var activityMessage: String?
    @Published var selectedTab = 0
    private let api: APIClient
    private let keychain = SecureStore()
    private let cache = DashboardCache()
    private var credential: MobileCredential?
    private var generation = 0
    private var hasStarted = false
    private var registeredPushKey: String?
    private var isRegisteringPush = false
    var isAdmin: Bool { session?.isAdmin == true }
    var canChange: Bool { session != nil && !isStale && !isLoading && snapshot?.date == today }
    var zone: TimeZone { session?.household.timeZone ?? TimeZone(secondsFromGMT: 0)! }
    var today: String { Dates.day(in: zone) }
    var visibleChores: [Chore] { snapshot?.todaysChores ?? [] }
    var completedCount: Int { visibleChores.filter { $0.completion.completed }.count }
    var unreadCount: Int { notifications.filter { $0.readAt == nil }.count }
    var canViewChildSettings: Bool { session?.isChild != true }
    init(api: APIClient? = nil) {
        self.api = api ?? APIClient()
        NotificationController.shared.onToken = { [weak self] token in await self?.registerPush(token) }
    }
    func start() async {
        guard !hasStarted else { return }; hasStarted = true
        do {
            if let saved = try keychain.load(), saved.isValid {
                credential = saved; session = saved.session; api.mobileToken = saved.token
                if let savedCache = cache.read(identity: saved.session.cacheIdentity) {
                    snapshot = savedCache.snapshot; calendar = savedCache.calendar; notifications = savedCache.notifications
                    lastUpdated = savedCache.savedAt
                }
                await refresh(includePreferences: true)
            } else { try keychain.clear(); cache.clear() }
        } catch { message = error.localizedDescription }
    }
    func signIn(email: String, password: String) async -> Bool {
        guard !isSigningIn else { return false }; isSigningIn = true
        defer { isSigningIn = false }
        do { try accept(await api.parentLogin(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)); await refresh(includePreferences: true); return true }
        catch { message = error.localizedDescription; return false }
    }
    func pairChild(code: String) async -> Bool {
        guard !isSigningIn else { return false }; isSigningIn = true
        defer { isSigningIn = false }
        do { try accept(await api.childPair(code: code)); await refresh(includePreferences: true); return true }
        catch { message = error.localizedDescription; return false }
    }
    private func accept(_ value: MobileCredential) throws {
        guard value.isValid else { throw APIError(status: 0, code: "invalid_session", message: "The server did not create a valid app session.") }
        try keychain.save(value)
        generation += 1; cache.clear(); clearDashboard()
        credential = value; session = value.session; api.mobileToken = value.token
    }
    func refresh(includePreferences: Bool = false) async {
        guard session != nil, !isLoading else { return }
        isLoading = true; let started = generation
        defer { isLoading = false }
        do {
            let current = try await api.currentSession()
            guard started == generation else { return }
            guard current.cacheIdentity == session?.cacheIdentity else {
                throw APIError(status: 401, code: "session_changed", message: "This app's access changed. Sign in or pair again.")
            }
            session = current
            if var credential { credential.session = current; try keychain.save(credential); self.credential = credential }
            let currentSnapshot = try await api.household(date: today)
            guard started == generation else { return }
            snapshot = currentSnapshot; lastUpdated = Date(); isStale = false; refreshIssue = nil
        } catch {
            guard started == generation else { return }
            if (error as? APIError)?.isAuthenticationFailure == true { await forgetSession(reason: error.localizedDescription); return }
            isStale = true
            refreshIssue = error.localizedDescription
            return
        }
        do {
            let result = try await api.calendar(from: today, to: Dates.shiftedDay(today, by: 14))
            guard started == generation else { return }
            calendar = result; calendarMessage = nil
        } catch {
            guard started == generation else { return }
            calendarMessage = "Calendar could not refresh. Any events shown are from the last successful sync."
        }
        do {
            let result = try await api.notifications()
            guard started == generation else { return }
            notifications = result; activityMessage = nil
        } catch {
            guard started == generation else { return }
            activityMessage = "Activity could not refresh. Pull to try again."
        }
        if includePreferences || preferences == nil {
            do {
                let result = try await api.preferences()
                guard started == generation else { return }
                preferences = result
            } catch { /* Settings displays an explicit unavailable state and retry. */ }
        }
        do {
            let result = try await api.serviceStatus()
            guard started == generation else { return }
            deliveryStatus = result
        } catch { deliveryStatus = nil }
        persistCache()
        if let token = NotificationController.shared.currentToken { await registerPush(token) }
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
            if let i = self.snapshot?.chores.firstIndex(where: { $0.id == chore.id }) {
                self.snapshot?.chores[i].completion = ChoreCompletion(date: result.date, completed: result.completed, version: result.version, updatedAt: result.updatedAt)
                persistCache()
            }
            await refresh()
        } catch {
            guard started == generation else { return }
            isStale = true
            if let apiError = error as? APIError, apiError.isConflict {
                message = "This chore changed on another device. Your change was not forced. Refresh, review the current status, then try again."
            } else { message = error.localizedDescription }
        }
    }
    func saveChore(_ draft: ChoreDraft, id: String?) async -> Bool {
        guard isAdmin, canChange else { return false }
        lastMutationNeedsReview = false
        do { try await api.saveChore(draft, id: id); await refresh(); return true }
        catch {
            let failure = error as? APIError
            lastMutationNeedsReview = failure.map { $0.isConflict || $0.status == 0 || $0.status >= 500 } ?? true
            if lastMutationNeedsReview {
                isStale = true
                message = failure?.isConflict == true ? "This chore changed elsewhere. Close this editor, refresh, and review the current chore before editing again." : "The save could not be confirmed. Close this editor and refresh to check whether it was saved before making another change."
            } else { message = error.localizedDescription }
            return false
        }
    }
    func deleteChore(_ chore: Chore) async -> Bool {
        guard isAdmin, canChange else { return false }
        do { try await api.deleteChore(chore); await refresh(); return true }
        catch { message = error.localizedDescription; return false }
    }
    func pairing(for person: Person) async throws -> ChildPairing {
        guard isAdmin else { throw APIError(status: 403, code: "admin_required", message: "Only a parent administrator can pair a child device.") }
        return try await api.createPairing(personID: person.id, label: "\(person.name)'s iPhone or iPad")
    }
    func devices() async throws -> [MobileDevice] { try await api.devices() }
    func revoke(_ id: String) async throws { try await api.revokeDevice(id: id) }
    func savePreferences(_ value: NotificationPreferences) async -> Bool {
        do { preferences = try await api.savePreferences(value); return true }
        catch { message = error.localizedDescription; return false }
    }
    func markRead(_ item: FamilyNotification) async {
        guard item.readAt == nil, !isStale else { return }
        do {
            try await api.markRead(id: item.id)
            if let i = notifications.firstIndex(where: { $0.id == item.id }) { notifications[i].readAt = ISO8601DateFormatter().string(from: Date()) }
            persistCache()
        } catch { message = error.localizedDescription }
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
    func signOut() async {
        do { try await api.signOut(); await forgetSession(reason: nil) }
        catch {
            // Local access still ends; do not pretend the server confirmed revocation.
            await forgetSession(reason: "Signed out on this device. Server revocation could not be confirmed; a parent can revoke this device in Settings.")
        }
    }
    private func forgetSession(reason: String?) async {
        generation += 1; api.mobileToken = nil; credential = nil; session = nil
        clearDashboard(); cache.clear()
        do { try keychain.clear() } catch { message = error.localizedDescription; return }
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        message = reason
    }
    private func clearDashboard() {
        snapshot = nil; calendar = nil; notifications = []; preferences = nil; deliveryStatus = nil; lastUpdated = nil
        changingChores = []; registeredPushKey = nil; isStale = true; refreshIssue = nil; calendarMessage = nil; activityMessage = nil; selectedTab = 0
    }
}
