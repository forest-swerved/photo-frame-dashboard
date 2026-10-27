import Foundation
import SwiftUI
import UIKit

@MainActor
final class InternetModel: ObservableObject {
    @Published private(set) var snapshot: InternetSnapshot?
    @Published private(set) var isLoading = false
    @Published private(set) var isStale = true
    @Published private(set) var isChanging = false
    @Published private(set) var message: String?
    @Published private(set) var mutationNeedsReview = false
    @Published var earnedReward: RewardCredit?
    @Published var openedSession: InternetSession?
    var authenticationFailed: ((String) async -> Void)?
    private let api: any FamilyAPI
    private let monotonic: () -> TimeInterval
    private var principal: MobileSession?
    private var generation = 0
    private var revision = 0
    private var task: Task<Void, Never>?
    private var requested = false
    private var celebrate = false
    private var knownCreditIDs = Set<String>()
    private var presentedCredits = Set<String>()
    private var serverAnchor: Date?
    private var anchorUptime: TimeInterval = 0
    private var readUptime: TimeInterval?
    private var confirmedSessions: [String: InternetSession] = [:]
    init(api: any FamilyAPI, monotonic: (() -> TimeInterval)? = nil) {
        self.api = api
        let origin = ContinuousClock.now
        self.monotonic = monotonic ?? {
            let elapsed = origin.duration(to: .now).components
            return Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
        }
    }
    var serverNow: Date { serverAnchor?.addingTimeInterval(max(0, monotonic() - anchorUptime)) ?? .distantPast }
    var role: String? { principal?.role }
    var isChild: Bool { principal?.isChild == true }
    var personID: String? { principal?.personId }
    var canManage: Bool { principal != nil && !isChild && snapshot?.capabilities.manageInternet == true }
    var canChange: Bool {
        guard principal != nil, snapshot != nil, !isStale, !isChanging, let readUptime else { return false }
        return (0...60).contains(monotonic() - readUptime)
    }
    var integrationReady: Bool { snapshot?.integration.isReady == true }
    var sessions: [InternetSession] {
        (snapshot?.sessions ?? []).filter { !isChild || $0.personId == personID }
    }
    var accessRequests: [DeviceAccessRequest] { (snapshot?.requests ?? []).filter { !isChild || $0.personId == personID } }
    func requestIsPending(_ item: DeviceAccessRequest) -> Bool {
        item.status == "pending" && (Dates.instant(item.expiresAt) ?? .distantPast) > serverNow
    }
    var liveSessions: [InternetSession] { sessions.filter { !$0.isTerminal } }
    var hasPendingNetworkWork: Bool { liveSessions.contains { !$0.isStable } || devices.contains { $0.accessPending == true } }
    var devices: [ManagedInternetDevice] { (snapshot?.devices ?? []).filter { !isChild || $0.personIds.contains(personID ?? "") } }
    var availableCredits: [RewardCredit] {
        (snapshot?.credits ?? []).filter { $0.status == "available" && (!isChild || $0.personId == personID) && (Dates.instant($0.expiresAt) ?? .distantPast) > serverNow }
    }
    func bind(_ session: MobileSession?) {
        if session?.cacheIdentity == principal?.cacheIdentity && session?.role == principal?.role { principal = session; return }
        generation += 1; task?.cancel(); task = nil; requested = false; principal = session
        snapshot = nil; isLoading = false; isChanging = false; isStale = true; message = nil; mutationNeedsReview = false
        serverAnchor = nil; readUptime = nil; confirmedSessions = [:]; knownCreditIDs = []; presentedCredits = []; earnedReward = nil; openedSession = nil; celebrate = false
    }
    func refresh(celebrateRewards: Bool = false) async {
        guard principal != nil else { return }
        requested = true; celebrate = celebrate || celebrateRewards
        if let task { await task.value; return }
        let started = generation; isLoading = true
        let next = Task { [weak self] in guard let self else { return }; await self.refreshLoop(generation: started) }; task = next
        await next.value
    }
    private func refreshLoop(generation started: Int) async {
        defer { if generation == started { task = nil; isLoading = false } }
        while requested && generation == started && !Task.isCancelled {
            requested = false; let readRevision = revision, shouldCelebrate = celebrate; celebrate = false
            do {
                var result = try await api.internet()
                guard generation == started, !Task.isCancelled else { return }
                guard readRevision == revision else { requested = true; celebrate = celebrate || shouldCelebrate; continue }
                guard let time = Dates.instant(result.serverTime), result.role == principal?.role, result.timezone == principal?.household.timezone else {
                    throw APIError(status: 0, code: "invalid_response", message: "Network status could not be confirmed. Refresh before changing access.")
                }
                result.sessions = result.sessions.map { item in
                    let known = confirmedSessions[item.id]
                    return known.map { $0.version > item.version ? $0 : item } ?? item
                }
                for item in result.sessions where item.version >= (confirmedSessions[item.id]?.version ?? 0) { confirmedSessions[item.id] = item }
                serverAnchor = time; anchorUptime = monotonic(); readUptime = anchorUptime
                let hadSnapshot = snapshot != nil
                let newCredits = result.credits.filter { !knownCreditIDs.contains($0.id) }
                knownCreditIDs.formUnion(result.credits.map(\.id)); snapshot = result; isStale = false; message = nil
                let candidates = shouldCelebrate ? result.credits : hadSnapshot ? newCredits : []
                if isChild, let reward = candidates.first(where: { $0.personId == personID && $0.status == "available" && !presentedCredits.contains($0.id) && (Dates.instant($0.expiresAt) ?? .distantPast) > serverNow }) {
                    presentedCredits.insert(reward.id); earnedReward = reward
                    UIAccessibility.post(notification: .announcement, argument: "Great job! You earned \(reward.minutes) minutes of Internet time. Use your reward now or save it for later.")
                }
                if let shown = earnedReward, !availableCredits.contains(where: { $0.id == shown.id }) { earnedReward = nil }
            } catch {
                guard generation == started, !Task.isCancelled, !(error is CancellationError) else { return }
                if (error as? APIError)?.isAuthenticationFailure == true { await authenticationFailed?(error.localizedDescription); return }
                isStale = true; message = "Internet status could not refresh. Any session shown is the last confirmed status; controls stay paused."
            }
        }
    }
    func currentSession(_ original: InternetSession) -> InternetSession {
        var latest = original
        if let confirmed = confirmedSessions[original.id], confirmed.version >= latest.version { latest = confirmed }
        // Provider attention can change state without advancing the command's
        // CAS version. At equal versions the latest authenticated read wins.
        if let current = snapshot?.sessions.first(where: { $0.id == original.id }), current.version >= latest.version { latest = current }
        return latest
    }
    func deviceAvailable(_ device: ManagedInternetDevice, for person: String) -> Bool {
        guard let current = devices.first(where: { $0.id == device.id }) else { return false }
        return current.isReady && current.isBlocked && current.personIds.contains(person) && !liveSessions.contains { $0.deviceId == current.id || $0.personId == person }
    }
    func redeem(_ credit: RewardCredit, device: ManagedInternetDevice) async -> Bool {
        guard canChange, isChild, credit.personId == personID, integrationReady,
              availableCredits.contains(where: { $0.id == credit.id }), deviceAvailable(device, for: credit.personId), device.defaultAccess == "blocked", device.rewardAvailable == true else { return false }
        return await change({ try await self.api.redeemInternet(creditID: credit.id, deviceID: device.id, mutationID: UUID().uuidString.lowercased()) }) { result in
            guard result.personId == credit.personId, result.deviceId == device.id, result.creditId == credit.id else { return false }
            self.mergeSession(result)
            if let index = self.snapshot?.credits.firstIndex(where: { $0.id == credit.id }) { self.snapshot?.credits[index].status = "reserved" }
            self.earnedReward = nil; return true
        }
    }
    func grant(personID: String, device: ManagedInternetDevice, minutes: Int, allDay: Bool, reason: String) async -> Bool {
        guard canChange, canManage, integrationReady, deviceAvailable(device, for: personID) else { return false }
        return await change({ try await self.api.grantInternet(personID: personID, deviceID: device.id, minutes: allDay ? nil : minutes, allDay: allDay, reason: reason.isEmpty ? nil : reason, mutationID: UUID().uuidString.lowercased()) }) { result in
            guard result.personId == personID, result.deviceId == device.id, result.source == "parent" else { return false }; self.mergeSession(result); return true
        }
    }
    func requestAccess(device: ManagedInternetDevice, minutes: Int, reason: String) async -> Bool {
        let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canChange, isChild, (1...1439).contains(minutes), reason.count <= 500,
              devices.contains(where: { $0.id == device.id }), !accessRequests.contains(where: { $0.deviceId == device.id && requestIsPending($0) }) else { return false }
        return await change({ try await self.api.requestDeviceAccess(deviceID: device.id, minutes: minutes, reason: reason.isEmpty ? nil : reason, mutationID: UUID().uuidString.lowercased()) }) { result in
            guard result.personId == self.personID, result.deviceId == device.id, result.minutes == minutes, result.status == "pending" else { return false }
            self.mergeRequest(result); return true
        }
    }
    func decideAccess(_ item: DeviceAccessRequest, approve: Bool) async -> Bool {
        guard canChange, canManage, !approve || integrationReady, requestIsPending(item),
              accessRequests.contains(where: { $0.id == item.id && $0.version == item.version }) else { return false }
        return await change({ try await self.api.decideDeviceAccess(item, approve: approve, mutationID: UUID().uuidString.lowercased()) }) { result in
            guard result.id == item.id, result.personId == item.personId, result.deviceId == item.deviceId,
                  result.version > item.version, result.status == (approve ? "approved" : "declined"), !approve || result.sessionId != nil else { return false }
            self.mergeRequest(result); return true
        }
    }
    private func mergeRequest(_ result: DeviceAccessRequest) {
        var items = snapshot?.requests ?? []
        if let i = items.firstIndex(where: { $0.id == result.id }) { if result.version >= items[i].version { items[i] = result } }
        else { items.insert(result, at: 0) }
        snapshot?.requests = items
    }
    func act(_ original: InternetSession, action: String, deltaMinutes: Int? = nil, reason: String? = nil) async -> Bool {
        let item = original
        guard currentSession(original).version == original.version, currentSession(original).state == original.state else {
            mutationNeedsReview = true; message = "This session changed elsewhere. Review its current state before making another change."; return false
        }
        guard canChange, canManage, !item.isTerminal, sessions.contains(where: { $0.id == item.id }), item.isStable || action == "end" else { return false }
        let request = InternetSessionAction(action: action, expectedVersion: item.version, mutationId: UUID().uuidString.lowercased(), deltaMinutes: deltaMinutes, reason: reason)
        return await change({ try await self.api.changeInternetSession(item.id, action: request) }) { result in
            guard result.id == item.id, result.deviceId == item.deviceId, result.personId == item.personId, result.version >= item.version else { return false }; self.mergeSession(result); return true
        }
    }
    func internetIsOn(_ device: ManagedInternetDevice) -> Bool {
        device.desiredAccess == "allowed" || device.observedAccess == "allowed" || liveSessions.contains { $0.deviceId == device.id && $0.desiredState == "allowed" }
    }
    func controlDevice(_ original: ManagedInternetDevice) async -> Bool {
        guard canChange, canManage, integrationReady, let device = devices.first(where: { $0.id == original.id }),
              device.version == original.version, device.isReady, device.accessPending != true || device.desiredAccess == "allowed" else { return false }
        let access = internetIsOn(device) ? "blocked" : "allowed"
        return await change({ try await self.api.changeDeviceAccess(device, access: access, mutationID: UUID().uuidString.lowercased()) }) { result in
            guard result.id == device.id, result.version > device.version, result.desiredAccess == access, result.accessPending == true else { return false }
            if let i = self.snapshot?.devices.firstIndex(where: { $0.id == result.id }) { self.snapshot?.devices[i] = result }; return true
        }
    }
    func rewardDevices(for person: String) -> [ManagedInternetDevice] {
        guard integrationReady else { return [] }
        return devices.filter { $0.defaultAccess == "blocked" && $0.rewardAvailable == true && deviceAvailable($0, for: person) }
    }
    func saveDevice(_ draft: ManagedDeviceDraft, id: String?) async -> Bool {
        guard canChange, canManage else { return false }
        return await change({ try await self.api.saveInternetDevice(draft, id: id) }) { result in
            guard id == nil || result.id == id else { return false }
            if let i = self.snapshot?.devices.firstIndex(where: { $0.id == result.id }) { self.snapshot?.devices[i] = result } else { self.snapshot?.devices.append(result) }; return true
        }
    }
    func deleteDevice(_ device: ManagedInternetDevice) async -> Bool {
        guard canChange, canManage, device.controlState == "unenrolled" else { return false }
        return await change({ try await self.api.deleteInternetDevice(device, mutationID: UUID().uuidString.lowercased()) }) { _ in self.snapshot?.devices.removeAll { $0.id == device.id }; return true }
    }
    func savePolicy(_ policy: RewardPolicy, draft: RewardPolicyDraft) async -> Bool {
        guard canChange, canManage else { return false }
        return await change({ try await self.api.saveInternetPolicy(policy.personId, draft: draft) }) { result in
            guard result.personId == policy.personId, result.version >= policy.version else { return false }
            if let i = self.snapshot?.policies.firstIndex(where: { $0.personId == result.personId }) { self.snapshot?.policies[i] = result }; return true
        }
    }
    func resolve(_ credit: RewardCredit, action: String, reason: String) async -> Bool {
        guard canChange, canManage, credit.status == "review", !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return await change({ try await self.api.resolveInternetCredit(credit.id, action: action, reason: reason, mutationID: UUID().uuidString.lowercased()) }) { result in
            guard result.id == credit.id, result.personId == credit.personId else { return false }
            if let i = self.snapshot?.credits.firstIndex(where: { $0.id == result.id }) { self.snapshot?.credits[i] = result }; return true
        }
    }
    func history() async throws -> [InternetHistoryItem] {
        guard principal != nil else { throw CancellationError() }; let started = generation
        do { let result = try await api.internetHistory(); guard generation == started else { throw CancellationError() }; return result }
        catch { guard generation == started else { throw CancellationError() }; throw error }
    }
    private func mergeSession(_ result: InternetSession) {
        if result.version >= (confirmedSessions[result.id]?.version ?? 0) { confirmedSessions[result.id] = result }
        let latest = confirmedSessions[result.id] ?? result
        if let i = snapshot?.sessions.firstIndex(where: { $0.id == result.id }) { snapshot?.sessions[i] = latest } else { snapshot?.sessions.insert(latest, at: 0) }
    }
    private func change<T>(_ operation: () async throws -> T, apply: (T) -> Bool) async -> Bool {
        let started = generation; revision += 1; isChanging = true; mutationNeedsReview = false; message = nil
        defer { if started == generation { isChanging = false } }
        do {
            let result = try await operation(); guard generation == started else { return false }
            revision += 1
            guard apply(result) else { throw APIError(status: 0, code: "invalid_response", message: "The server response did not confirm this change.") }
            Task { await refresh() }; return true
        } catch {
            guard generation == started else { return false }; revision += 1
            if (error as? APIError)?.isAuthenticationFailure == true { await authenticationFailed?(error.localizedDescription); return false }
            let failure = error as? APIError
            mutationNeedsReview = failure.map { $0.status == 0 || $0.isConflict || $0.status >= 500 } ?? true
            if mutationNeedsReview { isStale = true; message = "This change is not confirmed. Refresh and review the session or device before trying another change. No request was replayed." }
            else { message = error.localizedDescription }
            return false
        }
    }
}
