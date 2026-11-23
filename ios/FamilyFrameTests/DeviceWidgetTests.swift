import XCTest
import SwiftUI
import WidgetKit
@testable import FamilyFrame

@MainActor
final class DeviceWidgetTests: XCTestCase {
    func testScopedCredentialRoundTripAndSignOutClearing() throws {
        let value = DeviceWidgetCredential(token: "synthetic-read-only-widget-token", expiresAt: "2026-11-30T00:00:00.000Z")
        defer { DeviceWidgetStore.clear() }
        try DeviceWidgetStore.save(value)
        XCTAssertEqual(DeviceWidgetStore.load(), value)
        DeviceWidgetStore.clear()
        XCTAssertNil(DeviceWidgetStore.load())
    }
    func testExpiredTimersRequireConfirmationAndOldReadsBecomeStale() {
        let now = Date()
        let item = DeviceWidgetItem(id: "console", device: "Console", person: "Alex", status: "Time running", defaultOffOn: true, endsAt: now, preparationEndsAt: nil)
        XCTAssertEqual(item.label(at: now), "Confirming block")
        let snapshot = DeviceWidgetSnapshot(checkedAt: now, items: [item])
        XCTAssertFalse(DeviceStatusEntry(date: now, snapshot: snapshot).stale)
        XCTAssertTrue(DeviceStatusEntry(date: now.addingTimeInterval(900), snapshot: snapshot).stale)
    }
    func testLockScreenLayouts() {
        let now = Date()
        let timed = DeviceWidgetItem(id: "console", device: "Console", person: "Alex", status: "Time running", defaultOffOn: false, endsAt: now.addingTimeInterval(1800), preparationEndsAt: nil)
        let override = DeviceWidgetItem(id: "tablet", device: "iPad", person: "Sam", status: "Internet on", defaultOffOn: true, endsAt: nil, preparationEndsAt: nil)
        let entries = [
            DeviceStatusEntry(date: now, snapshot: DeviceWidgetSnapshot(checkedAt: now, items: [timed, override])),
            DeviceStatusEntry(date: now, snapshot: DeviceWidgetSnapshot(checkedAt: now, items: [])),
            DeviceStatusEntry(date: now.addingTimeInterval(900), snapshot: DeviceWidgetSnapshot(checkedAt: now, items: [timed])),
            DeviceStatusEntry(date: now, snapshot: nil, message: "Open app to reconnect")
        ]
        for (index, entry) in entries.enumerated() {
            let view = DeviceStatusWidgetView(entry: entry)
                .frame(width: 170, height: 80).padding(10).background(Color.black).foregroundStyle(.white)
            let renderer = ImageRenderer(content: view); renderer.scale = 3
            guard let image = renderer.uiImage else { return XCTFail("Widget did not render") }
            let attachment = XCTAttachment(image: image); attachment.name = "Lock screen state \(index)"; attachment.lifetime = .keepAlways; add(attachment)
        }
    }
}

extension DeviceWidgetTests {
    func testLiveActivityDecodesServerEpochsAndRenders() throws {
        let json = """
        {"items":[{"id":"one","person":"Alex","device":"Console","status":"Time running","endsAt":1900000000,"preparationEndsAt":null},{"id":"two","person":"Sam","device":"iPad","status":"Internet on","endsAt":null,"preparationEndsAt":null}],"totalCount":2,"checkedAt":1800000000}
        """
        let fixtureEnd = Date().timeIntervalSince1970 + 3720
        let previewJSON = json.replacingOccurrences(of: "1900000000", with: String(fixtureEnd))
        let state = try JSONDecoder().decode(DeviceAccessActivityAttributes.ContentState.self, from: Data(previewJSON.utf8))
        XCTAssertEqual(state.items[0].end, Date(timeIntervalSince1970: fixtureEnd))
        XCTAssertNil(state.items[1].end)
        XCTAssertEqual(try JSONDecoder().decode(DeviceAccessActivityAttributes.ContentState.self, from: JSONEncoder().encode(state)), state)
        for stale in [false, true] {
            let view = DeviceAccessLiveView(state: state, stale: stale).frame(width: 370).background(Color.black).foregroundStyle(.white)
            let renderer = ImageRenderer(content: view); renderer.scale = 3
            guard let image = renderer.uiImage else { return XCTFail("Live Activity did not render") }
            let attachment = XCTAttachment(image: image); attachment.name = "Live Activity stale \(stale)"; attachment.lifetime = .keepAlways; add(attachment)
        }
    }
}
