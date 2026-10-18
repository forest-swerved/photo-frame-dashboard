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

struct ParentCapabilities: Codable, Equatable {
    let manageChores: Bool
    let manageInternet: Bool
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
    var routines: [ChoreRoutine]? = nil
    var occurrences: [ChoreOccurrence]? = nil
    var capabilities: ParentCapabilities? = nil
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
    var required = true
    var instructions = ""
    var subtasks: [ChoreStep] = []
    var scheduleType = "weekly"
    var scheduledDate: String? = nil
    var requiresApproval = false
    // Explicit nulls clear assignment/deadline when editing.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(title, forKey: .title)
        try c.encode(personId, forKey: .personId)
        try c.encode(weekdays, forKey: .weekdays)
        try c.encode(dueTime, forKey: .dueTime)
        try c.encode(reminderMinutes, forKey: .reminderMinutes)
        try c.encodeIfPresent(expectedVersion, forKey: .expectedVersion)
        try c.encode(required, forKey: .required); try c.encode(instructions, forKey: .instructions)
        try c.encode(subtasks, forKey: .subtasks); try c.encode(scheduleType, forKey: .scheduleType)
        try c.encode(scheduledDate, forKey: .scheduledDate); try c.encode(requiresApproval, forKey: .requiresApproval)
    }
    enum CodingKeys: String, CodingKey { case title, personId, weekdays, dueTime, reminderMinutes, expectedVersion, required, instructions, subtasks, scheduleType, scheduledDate, requiresApproval }
}

struct CalendarEvent: Codable, Identifiable, Equatable {
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
        return Dates.time(date, in: zone)
    }
}

struct CalendarPaletteEntry: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let color: String
    init(id: String, name: String, color: String) {
        self.id = String(id.prefix(200)); self.name = String(name.prefix(120))
        self.color = color.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil ? color : "#00748c"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: (try? c.decode(String.self, forKey: .id)) ?? "",
                  name: (try? c.decode(String.self, forKey: .name)) ?? "Calendar",
                  color: (try? c.decode(String.self, forKey: .color)) ?? "#00748c")
    }
}
struct CalendarCoverage: Codable, Equatable {
    let startDate: String?
    let endDateExclusive: String?
    let timeZone: String?
    let complete: Bool
    let truncated: Bool
    init(startDate: String?, endDateExclusive: String?, timeZone: String?, complete: Bool, truncated: Bool) {
        self.startDate = startDate; self.endDateExclusive = endDateExclusive; self.timeZone = timeZone
        self.complete = complete; self.truncated = truncated
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        startDate = try? c.decode(String.self, forKey: .startDate)
        endDateExclusive = try? c.decode(String.self, forKey: .endDateExclusive)
        timeZone = try? c.decode(String.self, forKey: .timeZone)
        complete = (try? c.decode(Bool.self, forKey: .complete)) ?? false
        truncated = (try? c.decode(Bool.self, forKey: .truncated)) ?? true
    }
    func covers(from: String, to: String, zone: TimeZone) -> Bool {
        guard complete, !truncated, timeZone == zone.identifier, let startDate, let endDateExclusive,
              Dates.dayDate(startDate) != nil, Dates.dayDate(endDateExclusive) != nil else { return false }
        return startDate <= from && endDateExclusive >= to && from < to
    }
}
struct CalendarSyncInfo: Codable {
    let state: String
    let lastAttemptAt: String?
    let nextAttemptAt: String?
    let error: CalendarProblem?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decode(String.self, forKey: .state)) ?? "unknown"
        state = ["idle", "scheduled", "syncing", "retrying"].contains(raw) ? raw : "unknown"
        lastAttemptAt = try? c.decode(String.self, forKey: .lastAttemptAt)
        nextAttemptAt = try? c.decode(String.self, forKey: .nextAttemptAt)
        error = try? c.decode(CalendarProblem.self, forKey: .error)
    }
}
struct CalendarSnapshot: Codable {
    let status: String
    let events: [CalendarEvent]
    let lastSuccessfulSyncAt: String?
    let error: CalendarProblem?
    let calendars: [CalendarPaletteEntry]
    let coverage: CalendarCoverage?
    let sync: CalendarSyncInfo?
    init(status: String, events: [CalendarEvent], lastSuccessfulSyncAt: String?, error: CalendarProblem?, calendars: [CalendarPaletteEntry] = [], coverage: CalendarCoverage? = nil, sync: CalendarSyncInfo? = nil) {
        self.status = status; self.events = events; self.lastSuccessfulSyncAt = lastSuccessfulSyncAt; self.error = error; self.calendars = calendars
        self.coverage = coverage; self.sync = sync
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(String.self, forKey: .status); events = try c.decode([CalendarEvent].self, forKey: .events)
        lastSuccessfulSyncAt = try c.decodeIfPresent(String.self, forKey: .lastSuccessfulSyncAt)
        error = try c.decodeIfPresent(CalendarProblem.self, forKey: .error)
        // Metadata is optional on older servers. Invalid labels/colors must never
        // make the authoritative event list unreadable.
        calendars = ((try? c.decodeIfPresent([CalendarPaletteEntry].self, forKey: .calendars)) ?? []).filter { !$0.id.isEmpty }
        coverage = try? c.decode(CalendarCoverage.self, forKey: .coverage)
        sync = try? c.decode(CalendarSyncInfo.self, forKey: .sync)
    }
    func confirmsAvailability(from: String, to: String, zone: TimeZone) -> Bool {
        status == "ready" && error == nil && coverage?.covers(from: from, to: to, zone: zone) == true
    }
    var availabilityMessage: String {
        if ["scheduled", "syncing"].contains(sync?.state ?? "") { return "Calendar is syncing. Events are not confirmed yet." }
        if status == "error" || error != nil || sync?.error != nil { return "Calendar availability is not confirmed. Sync will retry automatically." }
        return "Calendar availability is not confirmed yet."
    }
    var isStale: Bool { status == "stale" || status == "error" || status == "refreshing" }
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
    var occurrenceId: String? = nil
    var sessionId: String? = nil
    var creditId: String? = nil
    var target: String? = nil
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
    var rewards = true
    var internetSessions = true
    var quietStart: String? = nil
    var quietEnd: String? = nil
    var timezone = "America/Denver"
    enum CodingKeys: String, CodingKey { case pushEnabled, choreCompleted, choreReopened, choreDueSoon, choreOverdue, calendarEvents, frameStatus, rewards, internetSessions, quietStart, quietEnd, timezone }
    init() { }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pushEnabled = try c.decodeIfPresent(Bool.self, forKey: .pushEnabled) ?? true
        choreCompleted = try c.decodeIfPresent(Bool.self, forKey: .choreCompleted) ?? true
        choreReopened = try c.decodeIfPresent(Bool.self, forKey: .choreReopened) ?? true
        choreDueSoon = try c.decodeIfPresent(Bool.self, forKey: .choreDueSoon) ?? true
        choreOverdue = try c.decodeIfPresent(Bool.self, forKey: .choreOverdue) ?? true
        calendarEvents = try c.decodeIfPresent(Bool.self, forKey: .calendarEvents) ?? true
        frameStatus = try c.decodeIfPresent(Bool.self, forKey: .frameStatus) ?? true
        rewards = try c.decodeIfPresent(Bool.self, forKey: .rewards) ?? true
        internetSessions = try c.decodeIfPresent(Bool.self, forKey: .internetSessions) ?? true
        quietStart = try c.decodeIfPresent(String.self, forKey: .quietStart); quietEnd = try c.decodeIfPresent(String.self, forKey: .quietEnd)
        timezone = try c.decodeIfPresent(String.self, forKey: .timezone) ?? "America/Denver"
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(pushEnabled, forKey: .pushEnabled)
        try c.encode(choreCompleted, forKey: .choreCompleted)
        try c.encode(choreReopened, forKey: .choreReopened)
        try c.encode(choreDueSoon, forKey: .choreDueSoon)
        try c.encode(choreOverdue, forKey: .choreOverdue)
        try c.encode(calendarEvents, forKey: .calendarEvents)
        try c.encode(frameStatus, forKey: .frameStatus)
        try c.encode(rewards, forKey: .rewards); try c.encode(internetSessions, forKey: .internetSessions)
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
    // Shared formatters are configured once and used under a lock, including
    // from background grouping work. No formatter is mutated after caching.
    private static let lock = NSRecursiveLock()
    private static var formatters: [String: DateFormatter] = [:]
    private static let precise: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let basic = ISO8601DateFormatter()
    private static let relativeFormatter = RelativeDateTimeFormatter()
    private static func formatter(_ key: String, build: () -> DateFormatter) -> DateFormatter {
        if let f = formatters[key] { return f }
        let f = build(); formatters[key] = f; return f
    }
    static func instant(_ value: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        return precise.date(from: value) ?? basic.date(from: value)
    }
    private static func dayFormatter(_ zone: TimeZone) -> DateFormatter {
        formatter("day|" + zone.identifier) {
            let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = zone; f.dateFormat = "yyyy-MM-dd"; f.isLenient = false; return f
        }
    }
    static func day(_ date: Date = Date(), in zone: TimeZone) -> String {
        lock.lock(); defer { lock.unlock() }; return dayFormatter(zone).string(from: date)
    }
    static func dayDate(_ day: String) -> Date? {
        lock.lock(); defer { lock.unlock() }; return dayFormatter(TimeZone(secondsFromGMT: 0)!).date(from: day)
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
        guard let date = dayDate(day) else { return day }
        lock.lock(); defer { lock.unlock() }
        return formatter("label|" + Locale.current.identifier) {
            let f = DateFormatter(); f.timeZone = TimeZone(secondsFromGMT: 0); f.setLocalizedDateFormatFromTemplate("EEEEMMMd"); return f
        }.string(from: date)
    }
    static func time(_ date: Date, in zone: TimeZone) -> String {
        lock.lock(); defer { lock.unlock() }
        return formatter("time|" + zone.identifier + "|" + Locale.current.identifier) {
            let f = DateFormatter(); f.timeZone = zone; f.timeStyle = .short; f.dateStyle = .none; return f
        }.string(from: date)
    }
    static func wallTime(_ value: String, on day: String, in zone: TimeZone) -> Date? {
        guard validTime(value) else { return nil }
        guard day.count == 10, let date = dayDate(day), self.day(date, in: TimeZone(secondsFromGMT: 0)!) == day else { return nil }
        let parts = day.split(separator: "-").compactMap { Int($0) }, clock = value.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 3, clock.count == 2 else { return nil }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        // Calendar resolves a missing spring hour forward and chooses the first
        // fall-back occurrence, matching the server's Temporal compatible policy.
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: clock[0], minute: clock[1]))
    }
    static func wallTimeString(_ date: Date, in zone: TimeZone) -> String {
        lock.lock(); defer { lock.unlock() }
        return formatter("clock|" + zone.identifier) {
            let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = zone; f.dateFormat = "HH:mm"; return f
        }.string(from: date)
    }
    static func validTime(_ value: String) -> Bool { value.range(of: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil }
    static func relative(_ value: String?) -> String {
        guard let value, let date = instant(value) else { return "Not yet" }
        lock.lock(); defer { lock.unlock() }; return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }
}

struct MobileServiceStatus: Decodable {
    let pushConfigured: Bool
    let schedulingConfigured: Bool
    let serverTime: String
}
