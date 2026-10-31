import SwiftUI
import UserNotifications
import UIKit

extension Notification.Name {
    static let familyNotificationReceived = Notification.Name("FamilyFrame.notificationReceived")
    static let familyNotificationOpened = Notification.Name("FamilyFrame.notificationOpened")
}

enum FamilyNotificationCategories {
    static let all: Set<UNNotificationCategory> = Set([
        ("FAMILY_TASK", "View tasks"), ("FAMILY_INTERNET", "Manage time"),
        ("FAMILY_ACCESS_REQUEST", "Review request"), ("FAMILY_REWARD", "View rewards"),
        ("FAMILY_UPDATE", "Open Family Frame"), ("FAMILY_PREVIEW", "Open Family Frame")
    ].map { identifier, title in
        UNNotificationCategory(identifier: identifier, actions: [
            // Every action opens the authenticated inbox. No lock-screen action can change a task or network rule.
            UNNotificationAction(identifier: "FAMILY_OPEN", title: title, options: [.foreground, .authenticationRequired])
        ], intentIdentifiers: [], options: [])
    })
}

@MainActor
final class NotificationController: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationController()
    @Published var permissionDescription = "Checking…"
    @Published var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published var registrationMessage: String?
    @Published var currentToken: String?
    @Published private(set) var openedNotificationID: String?
    var onToken: ((String) async -> Void)?
    var environment: String {
        (Bundle.main.object(forInfoDictionaryKey: "FamilyAPNSEnvironment") as? String) == "production" ? "production" : "sandbox"
    }
    func prepare() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories(FamilyNotificationCategories.all)
        Task { await refreshStatus() }
    }
    func refreshStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
        switch settings.authorizationStatus {
        case .authorized: permissionDescription = "Enabled"
        case .provisional: permissionDescription = "Quiet delivery"
        case .denied: permissionDescription = "Disabled in iOS Settings"
        case .ephemeral: permissionDescription = "Temporary permission"
        default: permissionDescription = "Not enabled yet"
        }
        if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }
    func requestPermission() async {
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            await refreshStatus()
        } catch { registrationMessage = "iOS could not enable notifications. Try again in Settings." }
    }
    func registered(_ data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        // Keep only the current APNs callback value in memory; never cache it locally.
        currentToken = token
        Task { await onToken?(token) }
    }
    func failed() { registrationMessage = "Push registration is unavailable. A signed app on an iPhone or iPad with APNs configured is required." }
    func consumeOpenedNotification(_ id: String) { if openedNotificationID == id { openedNotificationID = nil } }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .familyNotificationReceived, object: nil)
            completionHandler([.banner, .sound, .badge])
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        // Notification content is never trusted as a command; fetch the authoritative inbox.
        let raw = response.notification.request.content.userInfo["notificationId"] as? String
        let id = raw.flatMap { (1...128).contains($0.utf8.count) ? $0 : nil }
        DispatchQueue.main.async {
            self.openedNotificationID = id
            NotificationCenter.default.post(name: .familyNotificationOpened, object: nil)
            completionHandler()
        }
    }
}

final class FamilyAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NotificationController.shared.prepare()
        ParentLocationReporter.shared.resume()
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { NotificationController.shared.registered(deviceToken) }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { NotificationController.shared.failed() }
}
