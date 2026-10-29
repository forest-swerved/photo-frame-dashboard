import XCTest
import UserNotifications
@testable import FamilyFrame

final class NotificationPresentationTests: XCTestCase {
    func testNotificationActionsOpenTheAppAndRequireUnlocking() {
        XCTAssertEqual(Set(FamilyNotificationCategories.all.map(\.identifier)), ["FAMILY_TASK", "FAMILY_INTERNET", "FAMILY_ACCESS_REQUEST", "FAMILY_REWARD", "FAMILY_UPDATE", "FAMILY_PREVIEW"])
        for category in FamilyNotificationCategories.all {
            XCTAssertEqual(category.actions.count, 1)
            XCTAssertTrue(category.actions[0].options.contains(.foreground))
            XCTAssertTrue(category.actions[0].options.contains(.authenticationRequired))
            XCTAssertEqual(category.actions[0].identifier, "FAMILY_OPEN")
        }
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
