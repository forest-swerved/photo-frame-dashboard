import UIKit
import UserNotifications

// Device illustrations are bundled, so attaching one never needs Internet,
// family credentials, shared storage, or an untrusted URL from a push.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock(); handler = contentHandler; content = request.content; lock.unlock()
        guard let updated = request.content.mutableCopy() as? UNMutableNotificationContent,
              ["FAMILY_INTERNET", "FAMILY_ACCESS_REQUEST", "FAMILY_PREVIEW"].contains(updated.categoryIdentifier),
              let artwork = updated.userInfo["artwork"] as? String,
              ["tablet", "tablet-pro", "phone", "laptop", "console", "ps5", "switch", "apple-tv", "other"].contains(artwork),
              let data = UIImage(named: "Device-" + artwork)?.pngData() else { finish(); return }
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("device.png")
            try data.write(to: url)
            updated.attachments = [try UNNotificationAttachment(identifier: "device", url: url)]
            lock.lock(); content = updated; lock.unlock()
        } catch { /* The original text alert remains useful if an attachment fails. */ }
        finish()
    }
    override func serviceExtensionTimeWillExpire() { finish() }
    private func finish() {
        lock.lock()
        let callback = handler, result = content
        handler = nil
        lock.unlock()
        if let callback, let result { callback(result) }
    }
}
