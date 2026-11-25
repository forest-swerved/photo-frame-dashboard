import XCTest
import UserNotifications
@testable import FamilyFrame

final class NotificationPresentationTests: XCTestCase {
    func testNotificationActionsOpenTheAppAndRequireUnlocking() {
        XCTAssertEqual(Set(FamilyNotificationCategories.all.map(\.identifier)), ["FAMILY_TASK", "FAMILY_INTERNET", "FAMILY_ACCESS_REQUEST", "FAMILY_REWARD", "FAMILY_UPDATE", "FAMILY_PREVIEW", "FAMILY_ALARM"])
        for category in FamilyNotificationCategories.all {
            // Every category opens the app behind the device lock. Only the alarm adds a second action.
            XCTAssertTrue(category.actions[0].options.contains(.foreground))
            XCTAssertTrue(category.actions[0].options.contains(.authenticationRequired))
            XCTAssertEqual(category.actions[0].identifier, "FAMILY_OPEN")
            XCTAssertEqual(category.actions.count, category.identifier == FamilyNotificationCategories.alarm ? 2 : 1)
        }
    }
    func testAlarmSnoozeIsTheOnlyBackgroundActionAndCannotCompleteATask() throws {
        let alarm = try XCTUnwrap(FamilyNotificationCategories.all.first { $0.identifier == FamilyNotificationCategories.alarm })
        let snooze = alarm.actions[1]
        XCTAssertEqual(snooze.identifier, FamilyNotificationCategories.alarmSnooze)
        XCTAssertFalse(snooze.options.contains(.foreground)); XCTAssertTrue(snooze.options.contains(.authenticationRequired))
        XCTAssertFalse(alarm.actions.contains { $0.identifier.contains("DONE") || $0.identifier.contains("COMPLETE") }, "Confirming the task always happens in the app.")
    }
    func testBundledArtworkDoesNotChangeNotificationTextOrOpaqueNavigation() {
        let content = UNMutableNotificationContent()
        content.title = "Stevie's device time started"; content.subtitle = "Stevie's iPad · 2 hours"
        content.body = "5 minutes to get ready. This window ends at 6:47 PM MDT."
        content.categoryIdentifier = "FAMILY_INTERNET"
        content.userInfo = ["artwork":"tablet", "notificationId":"opaque-fixture"]
        let service = NotificationService(); var deliveries = 0
        service.didReceive(UNNotificationRequest(identifier: "fixture", content: content, trigger: nil)) { result in
            deliveries += 1
            XCTAssertEqual(result.title, content.title); XCTAssertEqual(result.subtitle, content.subtitle); XCTAssertEqual(result.body, content.body)
            XCTAssertEqual(result.userInfo["notificationId"] as? String, "opaque-fixture")
            XCTAssertEqual(result.attachments.count, 1)
            XCTAssertEqual(result.attachments.first?.type, "public.png")
        }
        service.serviceExtensionTimeWillExpire()
        XCTAssertEqual(deliveries, 1, "The system receives exactly one completion, including the expiry fallback.")
    }
    func testPrivateUnknownAndUntrustedArtworkFallBackToText() {
        for (category, artwork) in [("FAMILY_UPDATE", "tablet"), ("FAMILY_INTERNET", "../../private"), ("FAMILY_INTERNET", "https://example.invalid/image.png")] {
            let content = UNMutableNotificationContent(); content.body = "Original text"
            content.categoryIdentifier = category; content.userInfo = ["artwork":artwork]
            var deliveries = 0
            NotificationService().didReceive(UNNotificationRequest(identifier: "fixture", content: content, trigger: nil)) { result in
                deliveries += 1; XCTAssertTrue(result.attachments.isEmpty); XCTAssertEqual(result.body, content.body)
            }
            XCTAssertEqual(deliveries, 1)
        }
    }
}
