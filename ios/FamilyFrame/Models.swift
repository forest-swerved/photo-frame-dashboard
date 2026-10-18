import Foundation

struct Household: Codable, Equatable {
    let id: String
    let title: String
    let timezone: String
    var timeZone: TimeZone { TimeZone(identifier: timezone) ?? TimeZone(secondsFromGMT: 0)! }
}

struct FamilyUser: Codable, Equatable {
    let id: String
    let name: String
    let email: String?
}

struct MobileSession: Codable, Equatable {
    let authenticated: Bool
    let authType: String
    let role: String
    let household: Household
    let user: FamilyUser
    let personId: String?
    var isAdmin: Bool { role == "admin" }
    var isChild: Bool { role == "child" }
    var cacheIdentity: String { "\(household.id)|\(user.id)|\(personId ?? "parent")" }
}

struct MobileCredential: Codable {
    let token: String
    let expiresAt: String
    var session: MobileSession
    var isExpired: Bool { Dates.instant(expiresAt).map { $0 <= Date() } ?? true }
    var isValid: Bool { token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil && !isExpired }
}

struct Person: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let color: String
    let version: Int
}

struct ChoreCompletion: Codable, Equatable {
    let date: String
    var completed: Bool
    var version: Int
    var updatedAt: String?
}

struct Chore: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    var personId: String?
    var weekdays: [Int]
    var version: Int
    var dueTime: String?
    var reminderMinutes: Int?
    var completion: ChoreCompletion
    func applies(on date: String) -> Bool { weekdays.contains(Dates.weekday(date)) }
}

struct HouseholdSnapshot: Codable {
    let household: Household
    let role: String
    let date: String
    var people: [Person]
    var chores: [Chore]
    var todaysChores: [Chore] { chores.filter { $0.applies(on: date) } }
}

struct CompletionResult: Decodable {
    let choreId: String
    let date: String
    let completed: Bool
    let version: Int
    let updatedAt: String?
    let mutationId: String
}

struct ChoreDraft: Encodable {
    var title: String
    var personId: String?
    var weekdays: [Int]
    var dueTime: String?
    var reminderMinutes: Int
    var expectedVersion: Int?
    // Explicit nulls clear assignment/deadline when editing.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(title, forKey: .title)
        try c.encode(personId, forKey: .personId)
        try c.encode(weekdays, forKey: .weekdays)
        try c.encode(dueTime, forKey: .dueTime)
        try c.encode(reminderMinutes, forKey: .reminderMinutes)
        try c.encodeIfPresent(expectedVersion, forKey: .expectedVersion)
    }
    enum CodingKeys: String, CodingKey { case title, personId, weekdays, dueTime, reminderMinutes, expectedVersion }
}

struct CalendarEvent: Codable, Identifiable {
    let id: String
    let title: String
    let location: String?
    let allDay: Bool
    let startAt: String?
    let endAt: String?
    let startDate: String?
    let endDateExclusive: String?
    let calendarId: String?
    func day(in zone: TimeZone) -> String {
        if allDay { return startDate ?? "" }
        return startAt.flatMap(Dates.instant).map { Dates.day($0, in: zone) } ?? ""
    }
    func when(in zone: TimeZone) -> String {
        guard !allDay else { return "All day" }
        guard let startAt, let date = Dates.instant(startAt) else { return "Time unavailable" }
        let f = DateFormatter(); f.timeZone = zone; f.dateStyle = .none; f.timeStyle = .short
        return f.string(from: date)
    }
}

struct CalendarSnapshot: Codable {
    let status: String
    let events: [CalendarEvent]
    let lastSuccessfulSyncAt: String?
    let error: CalendarProblem?
    var isStale: Bool { status == "stale" || status == "error" }
}
struct CalendarProblem: Codable { let code: String; let message: String }

struct FamilyNotification: Codable, Identifiable {
    let id: String
    let kind: String
    let title: String
    let body: String
    let createdAt: String
    var readAt: String?
    let choreId: String?
    let date: String?
}
struct NotificationList: Decodable { let notifications: [FamilyNotification] }

struct NotificationPreferences: Codable, Equatable {
    var pushEnabled = true
    var choreCompleted = true
    var choreReopened = true
    var choreDueSoon = true
    var choreOverdue = true
    var calendarEvents = true
    var frameStatus = true
    var quietStart: String? = nil
    var quietEnd: String? = nil
    var timezone = "America/Denver"
    enum CodingKeys: String, CodingKey { case pushEnabled, choreCompleted, choreReopened, choreDueSoon, choreOverdue, calendarEvents, frameStatus, quietStart, quietEnd, timezone }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(pushEnabled, forKey: .pushEnabled)
        try c.encode(choreCompleted, forKey: .choreCompleted)
        try c.encode(choreReopened, forKey: .choreReopened)
        try c.encode(choreDueSoon, forKey: .choreDueSoon)
        try c.encode(choreOverdue, forKey: .choreOverdue)
        try c.encode(calendarEvents, forKey: .calendarEvents)
        try c.encode(frameStatus, forKey: .frameStatus)
        try c.encode(quietStart, forKey: .quietStart)
        try c.encode(quietEnd, forKey: .quietEnd)
    }
}

enum AccountStage: Equatable {
    case entry
    case confirmEmail(String)
    case joinFamily(String)
    var email: String? {
        switch self { case .entry: return nil; case .confirmEmail(let email), .joinFamily(let email): return email }
    }
}

enum AccountOutcome {
    case authenticated(MobileCredential)
    case confirmationRequired
    case invitationRequired
}

struct ChildInvitation: Decodable {
    let id: String
    let token: String
    let expiresAt: String
    let personId: String
    let email: String
    let role: String
}

struct MobileDevice: Decodable, Identifiable {
    let id: String
    let label: String?
    let role: String?
    let personId: String?
    let lastSeenAt: String?
    let expiresAt: String?
    let revokedAt: String?
}
struct MobileDevices: Decodable { let devices: [MobileDevice] }
struct Acknowledgement: Decodable { }

struct CachedDashboard: Codable {
    let identity: String
    let savedAt: Date
    let snapshot: HouseholdSnapshot?
    let calendar: CalendarSnapshot?
    let notifications: [FamilyNotification]
}

enum Dates {
    static func instant(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter(); precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    static func day(_ date: Date = Date(), in zone: TimeZone) -> String {
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone; f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
    static func dayDate(_ day: String) -> Date? {
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0); f.dateFormat = "yyyy-MM-dd"; f.isLenient = false
        return f.date(from: day)
    }
    static func weekday(_ day: String) -> Int {
        guard let date = dayDate(day) else { return -1 }
        var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(secondsFromGMT: 0)!
        return c.component(.weekday, from: date) - 1
    }
    static func shiftedDay(_ day: String, by count: Int) -> String {
        guard let date = dayDate(day) else { return day }
        var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(secondsFromGMT: 0)!
        return self.day(c.date(byAdding: .day, value: count, to: date)!, in: c.timeZone)
    }
    static func dayLabel(_ day: String) -> String {
        guard let d = dayDate(day) else { return day }
        let f = DateFormatter(); f.timeZone = TimeZone(secondsFromGMT: 0); f.dateFormat = "EEEE, MMM d"
        return f.string(from: d)
    }
    static func validTime(_ value: String) -> Bool { value.range(of: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil }
    static func relative(_ value: String?) -> String {
        guard let value, let date = instant(value) else { return "Not yet" }
        return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
    }
}

struct MobileServiceStatus: Decodable {
    let pushConfigured: Bool
    let schedulingConfigured: Bool
    let serverTime: String
}
