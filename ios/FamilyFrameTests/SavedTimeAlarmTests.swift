import XCTest
@testable import FamilyFrame

final class SavedTimeAlarmTests: XCTestCase {
    private func credit(_ id: String, expires: String, useOrLose: Bool = false, status: String = "available", person: String = "kid") -> RewardCredit {
        RewardCredit(id: id, personId: person, earnedDate: "2026-12-01", minutes: 60, status: status, expiresAt: expires, policyVersion: 1, useOrLose: useOrLose)
    }

    func testOlderServerResponsesWithoutNewFieldsStillDecode() throws {
        let person = try JSONDecoder().decode(Person.self, from: Data(##"{"id":"kid","name":"Kid","color":"#112233","version":1}"##.utf8))
        XCTAssertNil(person.pinConfigured)
        let credit = try JSONDecoder().decode(RewardCredit.self, from: Data(#"{"id":"c","personId":"kid","earnedDate":"2026-12-01","minutes":60,"status":"available","expiresAt":"2026-12-09T07:00:00.000Z","policyVersion":1}"#.utf8))
        XCTAssertFalse(credit.isUseOrLose)
    }
    func testAlarmDraftNeedsADeadline() throws {
        var draft = ChoreDraft(title: "Test-only chore", personId: "kid", weekdays: [1], dueTime: nil, reminderMinutes: 0)
        draft.alarm = true
        var body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]
        XCTAssertEqual(body["alarm"] as? Bool, false)
        draft.dueTime = "16:30"
        body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]
        XCTAssertEqual(body["alarm"] as? Bool, true)
    }
    func testSavedTimeCountsSpendableCreditsAndSpendsSoonestExpiringFirst() {
        let now = Dates.instant("2026-12-02T21:00:00.000Z")!
        let time = SavedTime(credits: [credit("late", expires: "2026-12-20T07:00:00.000Z"), credit("soon", expires: "2026-12-04T07:00:00.000Z"),
                                       credit("gone", expires: "2026-12-01T07:00:00.000Z"), credit("held", expires: "2026-12-09T07:00:00.000Z", status: "held"),
                                       credit("other", expires: "2026-12-09T07:00:00.000Z", person: "sibling")], personID: "kid", capMinutes: 600, now: now)
        XCTAssertEqual(time.savedMinutes, 120); XCTAssertEqual(time.next?.id, "soon"); XCTAssertFalse(time.isFull); XCTAssertEqual(time.fraction, 0.2, accuracy: 0.0001)
        XCTAssertEqual(SavedTime.label(0), "0 min"); XCTAssertEqual(SavedTime.label(45), "45 min"); XCTAssertEqual(SavedTime.label(150), "2 h 30 min"); XCTAssertEqual(SavedTime.label(600), "10 h")
    }
    func testRewardEarnedAtTheCapIsUseItOrLoseIt() {
        let now = Dates.instant("2026-12-02T21:00:00.000Z")!
        let bank = (0..<10).map { credit("c\($0)", expires: "2026-12-\(10 + $0)T07:00:00.000Z") }
        let extra = credit("today", expires: "2026-12-03T07:00:00.000Z", useOrLose: true)
        let time = SavedTime(credits: bank + [extra], personID: "kid", capMinutes: 600, now: now)
        XCTAssertEqual(time.savedMinutes, 600); XCTAssertEqual(time.todayOnlyMinutes, 60); XCTAssertTrue(time.isFull); XCTAssertEqual(time.next?.id, "today")
        XCTAssertTrue(time.earnedMessage(for: extra).contains("maxed out how much time you can save (10 h)"))
        XCTAssertTrue(time.earnedMessage(for: extra).contains("use it or lose it"))
        XCTAssertTrue(SavedTime(credits: Array(bank.prefix(3)), personID: "kid", capMinutes: 600, now: now).earnedMessage(for: bank[0]).contains("You have 3 h saved of 10 h"))
    }
}
