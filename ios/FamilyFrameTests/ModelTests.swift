import XCTest
@testable import FamilyFrame

final class ModelTests: XCTestCase {
    func testHouseholdDateUsesZoneRatherThanPhoneDate() {
        let instant = Dates.instant("2026-10-18T01:00:00.000Z")!
        XCTAssertEqual(Dates.day(instant, in: TimeZone(identifier: "America/Denver")!), "2026-10-17")
        XCTAssertEqual(Dates.day(instant, in: TimeZone(identifier: "Asia/Tokyo")!), "2026-10-18")
    }
    func testCalendarDayMathAcrossDST() {
        XCTAssertEqual(Dates.shiftedDay("2026-03-08", by: 1), "2026-03-09")
        XCTAssertEqual(Dates.shiftedDay("2026-11-01", by: 1), "2026-11-02")
        XCTAssertEqual(Dates.weekday("2026-10-17"), 6)
        XCTAssertEqual(Dates.weekday("2026-10-18"), 0)
        XCTAssertEqual(Dates.weekday("invalid"), -1)
    }
    func testStrictWallTimeValidation() {
        XCTAssertTrue(Dates.validTime("00:00")); XCTAssertTrue(Dates.validTime("23:59"))
        for invalid in ["24:00", "9:30", "18:60", "18:30Z", ""] { XCTAssertFalse(Dates.validTime(invalid)) }
    }
    func testDraftExplicitNullClearsAssignmentAndDeadline() throws {
        let draft = ChoreDraft(title: "Test-only chore", personId: nil, weekdays: [1, 3], dueTime: nil, reminderMinutes: 15, expectedVersion: 7)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        XCTAssertTrue(json["personId"] is NSNull); XCTAssertTrue(json["dueTime"] is NSNull)
        XCTAssertEqual(json["expectedVersion"] as? Int, 7)
    }
    func testChildAccountSessionSeparatesAccountAndProfileIdentity() throws {
        let json = Data(#"{"authenticated":true,"authType":"mobile","role":"child","household":{"id":"test-home","title":"Test-only household","timezone":"America/Denver"},"user":{"id":"child-account","name":"Test child","email":"child@example.test"},"personId":"child-person"}"#.utf8)
        let value = try JSONDecoder().decode(MobileSession.self, from: json)
        XCTAssertTrue(value.isChild); XCTAssertFalse(value.isAdmin); XCTAssertEqual(value.user.email, "child@example.test")
        XCTAssertEqual(value.cacheIdentity, "test-home|child-account|child-person")
    }
    func testCalendarEventsKeepAllCoveredDaysAndExclusiveEnd() throws {
        let json = Data(#"{"id":"test-event","title":"Test-only event","allDay":true,"startDate":"2026-10-17","endDateExclusive":"2026-10-20"}"#.utf8)
        let event = try JSONDecoder().decode(CalendarEvent.self, from: json)
        let zone = TimeZone(identifier: "America/Denver")!
        XCTAssertTrue(eventOccurs(event, on: "2026-10-17", zone: zone))
        XCTAssertTrue(eventOccurs(event, on: "2026-10-19", zone: zone))
        XCTAssertFalse(eventOccurs(event, on: "2026-10-20", zone: zone))
    }
    func testOvernightEventAndMidnightExclusiveEnd() throws {
        let json = Data(#"{"id":"test-event","title":"Test-only event","allDay":false,"startAt":"2026-10-18T05:00:00Z","endAt":"2026-10-19T06:00:00Z"}"#.utf8)
        let event = try JSONDecoder().decode(CalendarEvent.self, from: json)
        let zone = TimeZone(identifier: "America/Denver")!
        XCTAssertTrue(eventOccurs(event, on: "2026-10-17", zone: zone))
        XCTAssertTrue(eventOccurs(event, on: "2026-10-18", zone: zone))
        XCTAssertFalse(eventOccurs(event, on: "2026-10-19", zone: zone))
    }
    func testPublicServerConfigurationRejectsCredentialAndRedirectTricks() {
        XCTAssertEqual(APIClient.validatedBaseURL("https://forest-family-frame.vercel.app/")?.host, "forest-family-frame.vercel.app")
        for invalid in ["http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com?token=x", "https://example.com#fragment", "https://example.com:8443"] { XCTAssertNil(APIClient.validatedBaseURL(invalid)) }
    }
    func testQuietHoursOffEncodesExplicitNulls() throws {
        let prefs = NotificationPreferences()
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(prefs)) as? [String: Any])
        XCTAssertTrue(json["quietStart"] is NSNull); XCTAssertTrue(json["quietEnd"] is NSNull)
        XCTAssertNil(json["previewDetails"]); XCTAssertNil(json["timezone"])
    }
    func testRichRoutineDraftEncodesRequiredApprovalAndOneTimeSchedule() throws {
        var draft = ChoreDraft(title: "Synthetic one-time task", personId: "child-person", weekdays: Array(0...6), dueTime: "17:00", reminderMinutes: 15, expectedVersion: 5)
        draft.required = false; draft.requiresApproval = true; draft.instructions = "Synthetic instructions"
        draft.subtasks = [ChoreStep(id: "test-step", title: "Synthetic step")]
        draft.scheduleType = "one_off"; draft.scheduledDate = "2026-10-18"
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        XCTAssertEqual(json["required"] as? Bool, false); XCTAssertEqual(json["requiresApproval"] as? Bool, true)
        XCTAssertEqual(json["scheduleType"] as? String, "one_off"); XCTAssertEqual(json["scheduledDate"] as? String, "2026-10-18")
        XCTAssertEqual((json["subtasks"] as? [[String: Any]])?.first?["id"] as? String, "test-step")
        draft.scheduleType = "weekly"; draft.scheduledDate = nil
        let weekly = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        XCTAssertTrue(weekly["scheduledDate"] is NSNull, "Switching back to weekly must clear the old one-time date")
    }
    func testLegacySnapshotAndExplicitEmptyOccurrencesRemainDistinct() throws {
        let legacy = #"{"household":{"id":"test-home","title":"Synthetic home","timezone":"America/Denver"},"role":"admin","date":"2026-10-18","people":[],"chores":[]}"#
        let old = try JSONDecoder().decode(HouseholdSnapshot.self, from: Data(legacy.utf8))
        let modern = try JSONDecoder().decode(HouseholdSnapshot.self, from: Data((String(legacy.dropLast()) + ",\"occurrences\":[]}").utf8))
        XCTAssertNil(old.occurrences); XCTAssertEqual(modern.occurrences?.count, 0)
    }
    func testAccountPreferencesDefaultNewKindsAndPreserveExplicitOff() throws {
        let prefs = try JSONDecoder().decode(NotificationPreferences.self, from: Data(#"{"pushEnabled":false,"rewards":false}"#.utf8))
        XCTAssertFalse(prefs.pushEnabled); XCTAssertFalse(prefs.rewards); XCTAssertTrue(prefs.internetSessions)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(prefs)) as? [String: Any])
        XCTAssertEqual(json["rewards"] as? Bool, false); XCTAssertEqual(json["internetSessions"] as? Bool, true)
        XCTAssertNil(json["timezone"], "Household timezone is server-owned")
    }
}
