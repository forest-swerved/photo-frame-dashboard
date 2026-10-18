import XCTest
@testable import FamilyFrame

final class CalendarAgendaTests: XCTestCase {
    private let zone = TimeZone(identifier: "America/Denver")!
    private func event(_ index: Int = 0, start: String = "2026-10-18T04:00:00Z", end: String = "2026-10-18T14:00:00Z") -> CalendarEvent {
        CalendarEvent(id: "fixture-\(index)", title: "Synthetic event", location: nil, allDay: false, startAt: start, endAt: end, startDate: nil, endDateExclusive: nil, calendarId: "fixture-calendar")
    }
    func testOvernightEventHasContextualTimeAndLocalizedEnd() throws {
        let sections = CalendarAgenda.sections(events: [event()], calendars: [], from: "2026-10-17", zone: zone)
        XCTAssertEqual(sections.map(\.day), ["2026-10-17", "2026-10-18"])
        XCTAssertTrue(try XCTUnwrap(sections.first?.items.first).timeLabel.contains("continues"))
        let next = try XCTUnwrap(sections.last?.items.first)
        XCTAssertEqual(next.timeLabel, "Continues · until " + Dates.time(Dates.instant("2026-10-18T14:00:00Z")!, in: zone))
    }
    func testMidnightEndIsExclusiveAndAllDayIsFirst() {
        let overnight = event(end: "2026-10-18T06:00:00Z")
        let allDay = CalendarEvent(id: "fixture-all-day", title: "Synthetic all day", location: nil, allDay: true, startAt: nil, endAt: nil, startDate: "2026-10-17", endDateExclusive: "2026-10-18", calendarId: nil)
        let sections = CalendarAgenda.sections(events: [overnight, allDay], calendars: [], from: "2026-10-17", zone: zone)
        XCTAssertEqual(sections.count, 1); XCTAssertEqual(sections[0].items.first?.event.id, allDay.id)
    }
    func testMetadataIsOptionalAndInvalidColorsCannotBreakEvents() throws {
        let old = Data(#"{"status":"ready","events":[]}"#.utf8)
        XCTAssertTrue(try JSONDecoder().decode(CalendarSnapshot.self, from: old).calendars.isEmpty)
        let malformed = Data(#"{"status":"ready","events":[],"calendars":[{"id":"fixture-calendar","name":"Family","color":"not-a-color"}]}"#.utf8)
        let snapshot = try JSONDecoder().decode(CalendarSnapshot.self, from: malformed)
        XCTAssertEqual(snapshot.calendars.first?.color, "#00748c")
        let sections = CalendarAgenda.sections(events: [event()], calendars: snapshot.calendars, from: "2026-10-17", zone: zone)
        XCTAssertEqual(sections.first?.items.first?.calendarName, "Family")
        let wrongType = Data(#"{"status":"ready","events":[],"calendars":"unsupported"}"#.utf8)
        XCTAssertTrue(try JSONDecoder().decode(CalendarSnapshot.self, from: wrongType).calendars.isEmpty)
    }
    func testMaximumWindowParsesEachEventOnlyOnce() {
        let events = (0..<400).map { event($0) }
        var parseCount = 0
        let sections = CalendarAgenda.sections(events: events, calendars: [], from: "2026-10-17", zone: zone, parseInstant: { value in parseCount += 1; return Dates.instant(value) })
        XCTAssertEqual(parseCount, 800, "Fourteen calendar days must not multiply ISO parsing")
        XCTAssertEqual(sections.flatMap(\.items).count, 800)
    }
    func testGroupingMaximumSupportedEventsPerformance() {
        let events = (0..<400).map { event($0) }
        let options = XCTMeasureOptions(); options.iterationCount = 5
        measure(options: options) { _ = CalendarAgenda.sections(events: events, calendars: [], from: "2026-10-17", zone: zone) }
    }
    func testUnchangedAgendaInputsAreMemoizedButDayAndZoneInvalidate() {
        var cache = CalendarAgendaCache()
        XCTAssertNotNil(cache.update(events: [event()], calendars: [], from: "2026-10-17", zone: zone))
        XCTAssertNil(cache.update(events: [event()], calendars: [], from: "2026-10-17", zone: zone))
        XCTAssertNotNil(cache.update(events: [event()], calendars: [], from: "2026-10-18", zone: zone))
        XCTAssertNotNil(cache.update(events: [event()], calendars: [], from: "2026-10-18", zone: TimeZone(identifier: "Asia/Tokyo")!))
    }
    func testEmptyCalendarIsConfirmedOnlyForFreshCompleteCoveredWindow() throws {
        let payloads = [
            #"{"status":"loading","events":[],"sync":{"state":"scheduled"}}"#,
            #"{"status":"stale","events":[],"coverage":{"complete":true,"truncated":false,"startDate":"2026-10-17","endDateExclusive":"2026-11-17","timeZone":"America/Denver"}}"#,
            #"{"status":"error","events":[],"error":{"code":"CALENDAR_TIMEOUT","message":"Synthetic retry"},"sync":{"state":"retrying"}}"#,
            #"{"status":"ready","events":[]}"#,
            #"{"status":"ready","events":[],"coverage":{"complete":true,"truncated":true,"startDate":"2026-10-17","endDateExclusive":"2026-11-17","timeZone":"America/Denver"}}"#,
            #"{"status":"ready","events":[],"coverage":{"complete":true,"truncated":false,"startDate":"2026-10-17","endDateExclusive":"2026-10-18","timeZone":"America/Denver"}}"#
        ]
        for payload in payloads {
            let snapshot = try JSONDecoder().decode(CalendarSnapshot.self, from: Data(payload.utf8))
            XCTAssertFalse(snapshot.confirmsAvailability(from: "2026-10-17", to: "2026-10-31", zone: zone))
            XCTAssertTrue(snapshot.availabilityMessage.contains("not confirmed"))
        }
        let ready = CalendarSnapshot(status: "ready", events: [], lastSuccessfulSyncAt: nil, error: nil, coverage: CalendarCoverage(startDate: "2026-10-17", endDateExclusive: "2026-11-17", timeZone: "America/Denver", complete: true, truncated: false))
        XCTAssertTrue(ready.confirmsAvailability(from: "2026-10-17", to: "2026-10-31", zone: zone))
        XCTAssertFalse(ready.confirmsAvailability(from: "2026-10-17", to: "2026-10-31", zone: TimeZone(identifier: "Asia/Tokyo")!))
    }
    func testMalformedOptionalCoverageAndSyncNeverProveAvailability() throws {
        let payload = #"{"status":"ready","events":[],"coverage":{"complete":"yes","truncated":false},"sync":{"state":"private-internal-value","lease_id":"must-not-be-used"}}"#
        let snapshot = try JSONDecoder().decode(CalendarSnapshot.self, from: Data(payload.utf8))
        XCTAssertFalse(snapshot.confirmsAvailability(from: "2026-10-17", to: "2026-10-18", zone: zone))
        XCTAssertEqual(snapshot.sync?.state, "unknown")
    }
    func testDeadlineDSTResolutionMatchesServerCompatiblePolicy() {
        XCTAssertEqual(Dates.wallTime("02:30", on: "2026-03-08", in: zone), Dates.instant("2026-03-08T09:30:00Z"))
        XCTAssertEqual(Dates.wallTime("01:30", on: "2026-11-01", in: zone), Dates.instant("2026-11-01T07:30:00Z"))
        XCTAssertNil(Dates.wallTime("18:00", on: "2026-02-30", in: zone))
    }
    func testDeadlineUrgencyUsesHouseholdWallClock() throws {
        var chore = Chore(id: "fixture", title: "Synthetic chore", personId: nil, weekdays: Array(0...6), version: 1, dueTime: "18:00", reminderMinutes: 15, completion: ChoreCompletion(date: "2026-10-17", completed: false, version: 0, updatedAt: nil))
        let due = Dates.wallTime("18:00", on: "2026-10-17", in: zone)!
        XCTAssertEqual(ChoreDeadline(chore: chore, day: "2026-10-17", zone: zone, now: due.addingTimeInterval(-1800))?.urgency, .later)
        XCTAssertEqual(ChoreDeadline(chore: chore, day: "2026-10-17", zone: zone, now: due.addingTimeInterval(-300))?.urgency, .dueSoon)
        XCTAssertEqual(ChoreDeadline(chore: chore, day: "2026-10-17", zone: zone, now: due)?.urgency, .overdue)
        chore.completion.completed = true
        XCTAssertEqual(ChoreDeadline(chore: chore, day: "2026-10-17", zone: zone, now: due)?.urgency, .completed)
        XCTAssertEqual(Dates.wallTimeString(due, in: zone), "18:00")
    }
}
