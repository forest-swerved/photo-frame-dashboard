import Foundation

struct InternetScheduleSupport: Decodable, Equatable {
    let overnight: Bool
    let allDay: Bool
}
struct InternetIntegration: Decodable, Equatable {
    let state: String
    let managementHost: String
    let managementAccessVerifiedAt: String?
    let lastCheckedAt: String?
    let error: String?
    var scheduleSupport: InternetScheduleSupport? = nil
    var supportsAllDay: Bool { scheduleSupport?.allDay ?? true }
    var isReady: Bool { state == "ready" && managementAccessVerifiedAt.flatMap(Dates.instant) != nil }
    var title: String {
        switch state { case "unconfigured": return "Connect your home network"; case "pilot_required": return "Network checks required"; case "ready": return isReady ? "Home network connected" : "Connection needs verification"; default: return "Network needs attention" }
    }
    var detail: String {
        switch state {
        case "unconfigured": return "Internet controls are not connected to UniFi yet. Add the children's devices, then complete network setup and blocking checks."
        case "pilot_required": return "A parent must finish the access, blocking, expiry, and management-access checks before sessions can start."
        case "ready": return isReady ? "Sessions start only after the network confirms access. Family Frame stays reachable while Internet access is blocked." : "The connection has not passed its management-access check."
        default: return "The network has not confirmed its expected state. Check the connection and any sessions awaiting confirmation."
        }
    }
}

struct RewardPolicy: Decodable, Identifiable, Equatable {
    let personId: String
    let version: Int
    let rewardMinutes: Int
    let carryoverDays: Int
    let dailyLimitMinutes: Int
    let bedtime: String?
    let warningMinutes: Int
    let enabled: Bool
    var id: String { personId }
}
struct RewardPolicyDraft: Encodable {
    let expectedVersion: Int
    let rewardMinutes: Int
    let carryoverDays: Int
    let dailyLimitMinutes: Int
    let bedtime: String?
    let warningMinutes: Int
    let enabled: Bool
    enum CodingKeys: String, CodingKey { case expectedVersion, rewardMinutes, carryoverDays, dailyLimitMinutes, bedtime, warningMinutes, enabled }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(expectedVersion, forKey: .expectedVersion); try c.encode(rewardMinutes, forKey: .rewardMinutes)
        try c.encode(carryoverDays, forKey: .carryoverDays); try c.encode(dailyLimitMinutes, forKey: .dailyLimitMinutes)
        try c.encode(bedtime, forKey: .bedtime); try c.encode(warningMinutes, forKey: .warningMinutes); try c.encode(enabled, forKey: .enabled)
    }
}
struct RewardCredit: Decodable, Identifiable, Equatable {
    let id: String
    let personId: String
    let earnedDate: String
    let minutes: Int
    var status: String
    let expiresAt: String
    let policyVersion: Int
    var statusLabel: String {
        switch status { case "available": return "Ready to use"; case "held": return "Required work needs review"; case "reserved": return "Reserved for a session"; case "spent": return "Used"; case "expired": return "Expired"; case "review": return "Parent review required"; default: return "Status unavailable" }
    }
}
struct ManagedInternetDevice: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let kind: String
    let personIds: [String]
    let macAddresses: [String]?
    let version: Int
    let controlState: String
    let online: Bool?
    let lastSeenAt: String?
    let managementAccessVerifiedAt: String?
    var allowApplePush: Bool? = nil
    var defaultAccess: String? = nil
    var desiredAccess: String? = nil
    var observedAccess: String? = nil
    var accessVerifiedAt: String? = nil
    var accessPending: Bool? = nil
    var accessError: String? = nil
    var rewardAvailable: Bool? = nil
    var isBlocked: Bool { desiredAccess == "blocked" && observedAccess == "blocked" && accessVerifiedAt.flatMap(Dates.instant) != nil && accessPending != true }
    var isReady: Bool { controlState == "ready" && managementAccessVerifiedAt.flatMap(Dates.instant) != nil }
    var symbol: String {
        switch kind { case "console": return "gamecontroller.fill"; case "tablet": return "ipad"; case "phone": return "iphone"; case "computer": return "laptopcomputer"; case "tv": return "tv"; default: return "desktopcomputer" }
    }
    var controlLabel: String {
        if accessError != nil {
            return ["policy_review_required", "management_policy_changed", "session_policy_changed", "network_scope_changed"].contains(accessError ?? "")
                ? "Network rules need parent review · access not confirmed" : "Internet change could not be confirmed · retrying"
        }
        switch controlState { case "unenrolled": return "Awaiting network setup"; case "ready": return isReady ? (accessPending == true ? "Changing Internet access…" : observedAccess == "allowed" ? "Internet on · allowed by parent" : isBlocked ? "Internet off · blocking confirmed" : "Internet access unconfirmed") : "Management access not verified"; default: return "Needs network attention" }
    }
}
struct ManagedDeviceDraft: Encodable {
    var defaultAccess: String = "blocked"
    let name: String
    let kind: String
    let personIds: [String]
    let macAddresses: [String]
    let mutationId: String
    let expectedVersion: Int?
    var allowApplePush: Bool? = nil
}
struct InternetSession: Decodable, Identifiable, Equatable {
    let id: String
    let personId: String
    let deviceId: String
    let creditId: String?
    let source: String
    var state: String
    let version: Int
    let desiredState: String
    let observedState: String
    let requestedAt: String
    let startedAt: String?
    let endsAt: String?
    let remainingSeconds: Int
    let verifiedAt: String?
    let endedAt: String?
    let reason: String?
    let lastError: String?
    let allDay: Bool
    var preparationRemainingSeconds: Int? = nil
    var preparationEndsAt: String? = nil
    var grantedSeconds: Int? = nil
    var isTerminal: Bool { ["ended", "failed"].contains(state) }
    var isStable: Bool { ["active", "paused"].contains(state) }
    var hasVerifiedAccess: Bool { state == "active" && observedState == "allowed" && verifiedAt.flatMap(Dates.instant) != nil }
    var hasPendingWindow: Bool { !allDay && endsAt == nil && ["starting", "resuming", "checking"].contains(state) }
    func remaining(at serverNow: Date) -> Int {
        if isTerminal { return 0 }
        if state == "paused" && !allDay { return max(0, remainingSeconds) }
        if hasPendingWindow { return max(0, remainingSeconds) }
        guard let end = endsAt.flatMap(Dates.instant) else { return 0 }
        return max(0, Int(ceil(end.timeIntervalSince(serverNow))))
    }
    func preparation(at serverNow: Date) -> Int {
        guard !allDay, !isTerminal else { return 0 }
        if state == "paused" || endsAt == nil { return max(0, preparationRemainingSeconds ?? 0) }
        guard let end = preparationEndsAt.flatMap(Dates.instant) else { return 0 }
        return max(0, Int(ceil(end.timeIntervalSince(serverNow))))
    }
    func displayRemaining(at serverNow: Date) -> Int {
        let preparation = preparation(at: serverNow)
        return preparation > 0 ? preparation : remaining(at: serverNow)
    }
    func countdownLabel(at serverNow: Date) -> String {
        if hasPendingWindow { return "Waiting for network confirmation" }
        let label = preparation(at: serverNow) > 0 ? "Get ready · free buffer" : allDay ? "All-day access" : "Usage time remaining"
        return state == "paused" ? "\(label) · paused" : label
    }
    func statusLabel(at serverNow: Date) -> String {
        switch state {
        case "active": return hasVerifiedAccess && remaining(at: serverNow) > 0 ? preparation(at: serverNow) > 0 ? "Internet is on · get ready!" : "Internet access active" : remaining(at: serverNow) == 0 ? "Time is up · confirming block" : "Confirming network access"
        case "paused": return observedState == "blocked" && verifiedAt.flatMap(Dates.instant) != nil ? "Paused · Internet blocked" : "Pause needs confirmation"
        case "starting": return "Starting · waiting for network"
        case "pausing": return "Pausing · confirming block"
        case "resuming": return "Resuming · waiting for network"
        case "adjusting": return "Updating the access window"
        case "ending": return "Ending · confirming block"
        case "ended": return observedState == "blocked" && verifiedAt.flatMap(Dates.instant) != nil ? "Ended · Internet blocked" : "Ended · block not confirmed"
        case "failed": return "Session failed · check network status"
        default: return "Checking network state"
        }
    }
    static func durationLabel(_ seconds: Int) -> String {
        let seconds = max(0, seconds), hours = seconds / 3600, minutes = (seconds % 3600) / 60, remainder = seconds % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, remainder) : String(format: "%d:%02d", minutes, remainder)
    }
}
struct InternetSessionAction: Encodable {
    let action: String
    let expectedVersion: Int
    let mutationId: String
    var deltaMinutes: Int?
    var reason: String?
}
struct RequiredChoreProgress: Decodable, Identifiable {
    let personId: String
    let date: String
    let requiredCount: Int
    let completedCount: Int
    let pendingApprovalCount: Int
    let remainingCount: Int
    let eligible: Bool
    let occurrenceIds: [String]
    var id: String { personId }
}
struct DeviceAccessRequest: Decodable, Identifiable, Equatable {
    let id: String
    let personId: String
    let deviceId: String
    let minutes: Int
    let reason: String?
    let status: String
    let version: Int
    let requestedAt: String
    let expiresAt: String
    let decidedAt: String?
    let sessionId: String?
}

struct InternetSnapshot: Decodable {
    let serverTime: String
    let timezone: String
    let role: String
    let capabilities: ParentCapabilities
    let integration: InternetIntegration
    var policies: [RewardPolicy]
    var credits: [RewardCredit]
    var devices: [ManagedInternetDevice]
    var sessions: [InternetSession]
    let progress: [RequiredChoreProgress]
    var requests: [DeviceAccessRequest]? = nil
}
struct InternetHistoryItem: Decodable, Identifiable {
    let id: String
    let personId: String?
    let sessionId: String?
    let deviceId: String?
    let type: String
    let reason: String?
    let createdAt: String
    var title: String { type.replacingOccurrences(of: "_", with: " ").capitalized }
}
struct InternetHistoryList: Decodable { let history: [InternetHistoryItem] }
