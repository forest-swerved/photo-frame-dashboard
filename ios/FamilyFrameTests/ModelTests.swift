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
    func testExistingRoutinesDecodeWithAnySchoolStatusAndKeepExplicitFilters() throws {
        let legacy = #"{"id":"synthetic-routine","title":"Synthetic chore","weekdays":[1,2,3,4,5],"version":1,"required":true,"instructions":"","subtasks":[],"scheduleType":"weekly","requiresApproval":false}"#
        let old = try JSONDecoder().decode(ChoreRoutine.self, from: Data(legacy.utf8))
        XCTAssertEqual(old.schoolDayFilter, "any")
        XCTAssertEqual(old.taskSection, "tasks")
        for filter in ["school_day", "non_school_day"] {
            let updated = String(legacy.dropLast()) + ",\"schoolDayFilter\":\"" + filter + "\"}"
            let routine = try JSONDecoder().decode(ChoreRoutine.self, from: Data(updated.utf8))
            XCTAssertEqual(routine.schoolDayFilter, filter)
            let roundtrip = try JSONDecoder().decode(ChoreRoutine.self, from: JSONEncoder().encode(routine))
            XCTAssertEqual(roundtrip.schoolDayFilter, filter)
        }
        XCTAssertEqual(SchoolSchedule.filterLabel("unknown-future-filter"), "School schedule unavailable")
    }
    func testSchoolAwareRoutineDraftEncodesSchoolFilter() throws {
        var draft = ChoreDraft(title: "Synthetic school chore", personId: nil, weekdays: [1,2,3,4,5], dueTime: nil, reminderMinutes: 15)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        XCTAssertEqual(json["schoolDayFilter"] as? String, "any")
        draft.schoolDayFilter = "non_school_day"
        json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        XCTAssertEqual(json["schoolDayFilter"] as? String, "non_school_day")
        draft.scheduleType = "one_off"; draft.scheduledDate = "2026-10-18"
        json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        XCTAssertEqual(json["schoolDayFilter"] as? String, "any", "One-time chores must not be silently omitted by a school-day filter")
    }
    func testTaskPhasesEncodeDailyPlacementAndNormalizeOneTimeOrDaysOff() throws {
        var draft = ChoreDraft(title: "Synthetic phase task", personId: nil, weekdays: Array(0...6), dueTime: nil, reminderMinutes: 15)
        draft.taskSection = "after_school"
        for (frequency, filter, expected) in [("weekly", "school_day", "after_school"), ("weekly", "non_school_day", "tasks"), ("weekly", "any", "after_school"), ("one_off", "school_day", "tasks")] {
            draft.scheduleType = frequency; draft.schoolDayFilter = filter
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
            XCTAssertEqual(json["taskSection"] as? String, expected)
        }
    }
    func testBatchTaskRequestEncodesIndependentChildrenAndStableOperation() throws {
        var draft = ChoreDraft(title: "Synthetic daily task", personId: nil, weekdays: [5], dueTime: nil, reminderMinutes: 15)
        draft.taskSection = "after_school"
        let request = TaskCreationRequest(draft: draft, personIds: ["child-b", "child-a"], mutationId: "stable-operation")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(json["personIds"] as? [String], ["child-a", "child-b"])
        XCTAssertEqual(json["mutationId"] as? String, "stable-operation")
        XCTAssertEqual(json["taskSection"] as? String, "after_school")
        XCTAssertEqual(json["weekdays"] as? [Int], [5])
    }
    func testTaskSectionsDecodeFrozenPhasesAndFlattenForNonSchoolDays() throws {
        let legacy = #"{"id":"synthetic-task","choreId":"synthetic-routine","date":"2026-10-18","originalDate":"2026-10-18","title":"Synthetic task","required":true,"instructions":"","subtasks":[],"requiresApproval":false,"status":"pending","version":1,"completion":{"date":"2026-10-18","completed":false,"version":0},"definitionSource":"routine","routineVersion":1}"#
        let original = try JSONDecoder().decode(ChoreOccurrence.self, from: Data(legacy.utf8))
        XCTAssertEqual(original.taskSection, "tasks"); XCTAssertEqual(original.schoolDayFilter, "any"); XCTAssertFalse(original.schoolScheduleExempt)
        let beforeJSON = String(legacy.dropLast()) + #","taskSection":"before_school","schoolDayFilter":"school_day"}"#
        let before = try JSONDecoder().decode(ChoreOccurrence.self, from: Data(beforeJSON.utf8))
        var after = before; after.taskSection = "after_school"
        let school = TaskSections.groups([after, original, before], schoolDay: true)
        XCTAssertEqual(school.map(\.title), ["Before school", "After school", "Any time"])
        XCTAssertEqual(school.first?.items.first?.taskSection, "before_school")
        var editedRoutine = ChoreRoutine(legacy: before.legacy); editedRoutine.taskSection = "after_school"
        XCTAssertEqual(before.taskSection, "before_school", "A routine edit must not relabel the saved occurrence")
        let off = TaskSections.groups([after, original, before], schoolDay: false)
        XCTAssertEqual(off.map(\.title), ["Tasks"]); XCTAssertEqual(off.first?.items.count, 3)
        let empty: [ChoreOccurrence] = []
        XCTAssertEqual(TaskSections.groups(empty, schoolDay: true, showEmpty: true).map(\.title), ["Before school", "After school"])
        XCTAssertEqual(TaskSections.groups(empty, schoolDay: false, showEmpty: true).map(\.title), ["Tasks"])
        XCTAssertTrue(TaskSections.groups(empty, schoolDay: true).isEmpty)
    }
    func testSchoolDaySnapshotAcceptsOlderServerAndDoesNotTreatUnknownAsSchoolOff() throws {
        let legacy = #"{"household":{"id":"test-home","title":"Synthetic home","timezone":"America/Denver"},"role":"admin","date":"2026-10-18","people":[],"chores":[]}"#
        let old = try JSONDecoder().decode(HouseholdSnapshot.self, from: Data(legacy.utf8))
        XCTAssertNil(old.schoolDay)
        let updated = String(legacy.dropLast()) + #","schoolDay":{"date":"2026-10-18","type":"unknown","label":"Calendar not confirmed","reason":"No school calendar for this date","calendarVersion":null}}"#
        let snapshot = try JSONDecoder().decode(HouseholdSnapshot.self, from: Data(updated.utf8))
        XCTAssertFalse(try XCTUnwrap(snapshot.schoolDay).isKnown)
        XCTAssertNil(snapshot.schoolDay?.calendarVersion)
    }
    func testRemovingSchoolOverrideEncodesExplicitNullWithVersionAndReason() throws {
        let draft = SchoolDayOverrideDraft(expectedVersion: 7, change: .init(date: "2026-10-18", type: nil, reason: "Use the published schedule"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        XCTAssertEqual(json["expectedVersion"] as? Int, 7)
        let change = try XCTUnwrap(json["override"] as? [String: Any])
        XCTAssertTrue(change["type"] is NSNull); XCTAssertEqual(change["date"] as? String, "2026-10-18")
        XCTAssertEqual(change["reason"] as? String, "Use the published schedule")
    }
    func testSchoolCalendarCoverageIsExclusiveAndSourceLinkRequiresSafeHTTPS() throws {
        let template = #"{"title":"Synthetic school year","sourceName":"Synthetic school calendar","sourceSha256":null,"coverageStart":"2026-08-01","coverageEndExclusive":"2027-08-01","termStart":"2026-08-20","termEndExclusive":"2027-05-29","weekdays":[1,2,3,4,5],"closures":[],"overrides":[],"version":1,"sourceUrl":"SOURCE"}"#
        for source in ["https://school.example.test/calendar", "http://school.example.test", "javascript:alert(1)", "https://user:password@school.example.test"] {
            let json = template.replacingOccurrences(of: "SOURCE", with: source)
            let calendar = try JSONDecoder().decode(SchoolCalendarDocument.self, from: Data(json.utf8))
            XCTAssertEqual(calendar.sourceURL != nil, source == "https://school.example.test/calendar")
            XCTAssertTrue(calendar.covers("2026-08-01")); XCTAssertTrue(calendar.covers("2027-07-31"))
            XCTAssertFalse(calendar.covers("2027-08-01")); XCTAssertFalse(calendar.covers("invalid"))
        }
    }
}
