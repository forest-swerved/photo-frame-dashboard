import ActivityKit
import Foundation
import Security

struct LiveActivityRegistration: Codable, Equatable {
    let registrationId: String
    let reportToken: String
    let expiresAt: String
}
private struct StoredActivityRegistration: Codable {
    let identity: String
    let registration: LiveActivityRegistration
}
private enum LiveActivityStore {
    static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.swerved.familyframe.activity-report", kSecAttrAccount as String: "current"]
    static func load() -> StoredActivityRegistration? {
        var request = query; request[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(StoredActivityRegistration.self, from: data)
    }
    static func save(_ value: StoredActivityRegistration) throws {
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw StorageError.keychain }
    }
    static func clear() { SecItemDelete(query as CFDictionary) }
}
private final class ActivityRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor
final class DeviceLiveActivityController: ObservableObject {
    static let shared = DeviceLiveActivityController()
    @Published private(set) var message = "Open the app once to connect automatic Live Activities."
    private var startTask: Task<Void, Never>?
    private var activityTask: Task<Void, Never>?
    private var tokenTasks: [String: Task<Void, Never>] = [:]
    private var stateTasks: [String: Task<Void, Never>] = [:]
    private var generation = UUID()
    private var startToken: String?
    private var credential: StoredActivityRegistration?
    var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    func start() {
        guard startTask == nil else { return }
        credential = LiveActivityStore.load()
        for activity in Activity<DeviceAccessActivityAttributes>.activities { observe(activity) }
        activityTask = Task { [weak self] in
            for await activity in Activity<DeviceAccessActivityAttributes>.activityUpdates {
                guard !Task.isCancelled else { return }; self?.observe(activity)
            }
        }
        if #available(iOS 17.2, *) {
            startTask = Task { [weak self] in
                for await token in Activity<DeviceAccessActivityAttributes>.pushToStartTokenUpdates {
                    guard !Task.isCancelled, let self else { return }
                    startToken = hex(token)
                    await report(["kind": "start", "token": hex(token)])
                }
            }
        } else { message = "Automatic Live Activities require iOS 17.2 or later." }
    }
    func activate(_ registration: LiveActivityRegistration, identity: String) async throws {
        start()
        let epoch = UUID(); generation = epoch
        let value = StoredActivityRegistration(identity: identity, registration: registration)
        try LiveActivityStore.save(value); credential = value
        guard enabled else {
            await report(["kind": "disable"])
            guard generation == epoch else { return }
            await endLocalActivities(); message = "Live Activities are disabled in iOS Settings."; return
        }
        if #available(iOS 17.2, *), let token = Activity<DeviceAccessActivityAttributes>.pushToStartToken { startToken = hex(token) }
        if let startToken { await report(["kind": "start", "token": startToken]) }
        guard generation == epoch else { return }
        let current = Activity<DeviceAccessActivityAttributes>.activities
        for activity in current {
            guard generation == epoch else { return }
            guard activity.attributes.registrationId == registration.registrationId else { await activity.end(nil, dismissalPolicy: .immediate); continue }
            observe(activity)
            if let token = activity.pushToken { await report(["kind": "update", "runId": activity.attributes.runId, "token": hex(token)]) }
        }
        guard generation == epoch else { return }
        await report(["kind": "reconcile", "runIds": current.filter { $0.attributes.registrationId == registration.registrationId }.map { $0.attributes.runId }])
        if generation == epoch, startToken != nil { message = "Connected · appears automatically when device access is on." }
    }
    func clear() {
        generation = UUID()
        let previous = credential
        let previousActivities = Activity<DeviceAccessActivityAttributes>.activities
        credential = nil; LiveActivityStore.clear()
        tokenTasks.values.forEach { $0.cancel() }; stateTasks.values.forEach { $0.cancel() }
        tokenTasks = [:]; stateTasks = [:]
        Task {
            if let previous { try? await send(["kind": "disable"], using: previous.registration) }
            for activity in previousActivities { await activity.end(nil, dismissalPolicy: .immediate) }
        }
        message = "Open the app once to connect automatic Live Activities."
    }
    private func endLocalActivities() async {
        for activity in Activity<DeviceAccessActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
    }
    private func observe(_ activity: Activity<DeviceAccessActivityAttributes>) {
        guard tokenTasks[activity.id] == nil else { return }
        tokenTasks[activity.id] = Task { [weak self] in
            for await token in activity.pushTokenUpdates {
                guard !Task.isCancelled, let self else { return }
                guard credential?.registration.registrationId == activity.attributes.registrationId else { await activity.end(nil, dismissalPolicy: .immediate); return }
                await report(["kind": "update", "runId": activity.attributes.runId, "token": hex(token)])
            }
        }
        stateTasks[activity.id] = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                guard !Task.isCancelled, let self else { return }
                if state == .dismissed || state == .ended {
                    if credential?.registration.registrationId == activity.attributes.registrationId { await report(["kind": "dismiss", "runId": activity.attributes.runId]) }
                    tokenTasks.removeValue(forKey: activity.id)?.cancel(); stateTasks.removeValue(forKey: activity.id); return
                }
            }
        }
    }
    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
    private func report(_ body: [String: Any]) async {
        guard let saved = credential?.registration else { return }
        do { try await send(body, using: saved) }
        catch { if credential?.registration == saved { message = "Live Activity connection needs a refresh. Open the app while online." } }
    }
    private func send(_ body: [String: Any], using registration: LiveActivityRegistration) async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil; configuration.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: configuration, delegate: ActivityRedirectGuard(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: APIClient.configuredURL.appendingPathComponent("api/live-activity/tokens"))
        request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("FamilyActivity \(registration.reportToken)", forHTTPHeaderField: "Authorization")
        request.setValue(APIClient.configuredURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
    }
}
