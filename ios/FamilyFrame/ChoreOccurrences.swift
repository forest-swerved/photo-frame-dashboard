import Foundation

struct ChoreStep: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var completed: Bool?
    init(id: String = UUID().uuidString.lowercased(), title: String, completed: Bool? = nil) {
        self.id = id; self.title = title; self.completed = completed
    }
}

struct ChoreRoutine: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    var personId: String?
    var weekdays: [Int]
    var version: Int
    var dueTime: String?
    var reminderMinutes: Int?
    var required: Bool
    var instructions: String
    var subtasks: [ChoreStep]
    var scheduleType: String
    var scheduledDate: String?
    var requiresApproval: Bool
    var schoolDayFilter = "any"
    var taskSection = "tasks"
    private enum CodingKeys: String, CodingKey {
        case id, title, personId, weekdays, version, dueTime, reminderMinutes, required, instructions, subtasks, scheduleType, scheduledDate, requiresApproval, schoolDayFilter, taskSection
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); title = try c.decode(String.self, forKey: .title)
        personId = try c.decodeIfPresent(String.self, forKey: .personId); weekdays = try c.decode([Int].self, forKey: .weekdays)
        version = try c.decode(Int.self, forKey: .version); dueTime = try c.decodeIfPresent(String.self, forKey: .dueTime)
        reminderMinutes = try c.decodeIfPresent(Int.self, forKey: .reminderMinutes); required = try c.decode(Bool.self, forKey: .required)
        instructions = try c.decode(String.self, forKey: .instructions); subtasks = try c.decode([ChoreStep].self, forKey: .subtasks)
        scheduleType = try c.decode(String.self, forKey: .scheduleType); scheduledDate = try c.decodeIfPresent(String.self, forKey: .scheduledDate)
        requiresApproval = try c.decode(Bool.self, forKey: .requiresApproval)
        schoolDayFilter = try c.decodeIfPresent(String.self, forKey: .schoolDayFilter) ?? "any"
        taskSection = try c.decodeIfPresent(String.self, forKey: .taskSection) ?? "tasks"
    }
    init(legacy chore: Chore) {
        id = chore.id; title = chore.title; personId = chore.personId; weekdays = chore.weekdays; version = chore.version
        dueTime = chore.dueTime; reminderMinutes = chore.reminderMinutes; required = true; instructions = ""; subtasks = []
        scheduleType = "weekly"; scheduledDate = nil; requiresApproval = false
        taskSection = chore.taskSection
    }
    var legacy: Chore {
        Chore(id: id, title: title, personId: personId, weekdays: weekdays, version: version, dueTime: dueTime, reminderMinutes: reminderMinutes,
              completion: ChoreCompletion(date: "", completed: false, version: 0, updatedAt: nil), taskSection: taskSection)
    }
}

enum SchoolSchedule {
    static func filterLabel(_ value: String) -> String {
        switch value {
        case "any": return "Any school status"
        case "school_day": return "School days only"
        case "non_school_day": return "Non-school days only"
        default: return "School schedule unavailable"
        }
    }
}

struct SchoolDayStatus: Codable, Equatable {
    let date: String
    let type: String
    let label: String
    let reason: String
    let calendarVersion: Int?
    var isKnown: Bool { type == "school_day" || type == "non_school_day" }
}

struct SchoolCalendarClosure: Codable, Identifiable, Equatable {
    let fromDate: String
    let toDateExclusive: String
    let label: String
    var id: String { fromDate + "|" + toDateExclusive + "|" + label }
}

struct SchoolDayOverride: Codable, Identifiable, Equatable {
    let date: String
    let type: String
    let reason: String
    var id: String { date }
}

struct SchoolCalendarDocument: Codable, Equatable {
    let title: String
    let sourceName: String
    let sourceSha256: String?
    let sourceUrl: String?
    let coverageStart: String
    let coverageEndExclusive: String
    let termStart: String
    let termEndExclusive: String
    let weekdays: [Int]
    let closures: [SchoolCalendarClosure]
    let overrides: [SchoolDayOverride]
    let version: Int
    let updatedAt: String?
    var sourceURL: URL? {
        guard let sourceUrl, let url = URL(string: sourceUrl), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
    func covers(_ date: String) -> Bool { Dates.dayDate(date) != nil && date >= coverageStart && date < coverageEndExclusive }
}

struct SchoolCalendarResponse: Decodable {
    let calendar: SchoolCalendarDocument?
    let schoolDay: SchoolDayStatus
}

struct SchoolDayOverrideDraft: Encodable {
    let expectedVersion: Int
    let change: Change
    private enum CodingKeys: String, CodingKey { case expectedVersion; case change = "override" }
    struct Change: Encodable {
        let date: String
        let type: String?
        let reason: String
        private enum CodingKeys: String, CodingKey { case date, type, reason }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(date, forKey: .date); try c.encode(type, forKey: .type); try c.encode(reason, forKey: .reason)
        }
    }
}

struct ChoreOccurrence: Codable, Identifiable, Equatable {
    let id: String
    let choreId: String
    var date: String
    let originalDate: String
    let title: String
    let personId: String?
    let personName: String?
    let required: Bool
    let instructions: String
    var subtasks: [ChoreStep]
    let requiresApproval: Bool
    var status: String
    var version: Int
    var completion: ChoreCompletion
    var dueTime: String?
    let reminderMinutes: Int?
    var skipReason: String?
    var rescheduledFrom: String?
    var completedAt: String?
    var approvedAt: String?
    let definitionSource: String
    let routineVersion: Int
    let createdAt: String?
    var updatedAt: String?
    var taskSection = "tasks"
    var schoolDayFilter = "any"
    var schoolScheduleExempt = false
    private enum CodingKeys: String, CodingKey {
        case id, choreId, date, originalDate, title, personId, personName, required, instructions, subtasks, requiresApproval, status, version, completion, dueTime, reminderMinutes, skipReason, rescheduledFrom, completedAt, approvedAt, definitionSource, routineVersion, createdAt, updatedAt, taskSection, schoolDayFilter, schoolScheduleExempt
    }
    var isDone: Bool { status == "completed" }
    var isSubmitted: Bool { status == "submitted" }
    var isSkipped: Bool { status == "skipped" }
    var canComplete: Bool { ["pending", "submitted", "completed"].contains(status) }
    func applies(to schoolDay: SchoolDayStatus?) -> Bool {
        schoolDayFilter == "any" || schoolScheduleExempt || date != originalDate || definitionSource == "parent_correction"
            || schoolDay?.date == date && schoolDay?.type == schoolDayFilter
    }
    var statusLabel: String {
        switch status { case "pending": return "To do"; case "submitted": return "Waiting for parent approval"; case "completed": return requiresApproval ? "Approved" : "Done"; case "skipped": return "Excused"; default: return "Status unavailable" }
    }
    var legacy: Chore {
        Chore(id: choreId, title: title, personId: personId, weekdays: [Dates.weekday(date)], version: routineVersion, dueTime: dueTime, reminderMinutes: reminderMinutes, completion: completion, taskSection: taskSection)
    }
}

extension ChoreOccurrence {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id), choreId: try c.decode(String.self, forKey: .choreId),
                  date: try c.decode(String.self, forKey: .date), originalDate: try c.decode(String.self, forKey: .originalDate),
                  title: try c.decode(String.self, forKey: .title), personId: try c.decodeIfPresent(String.self, forKey: .personId),
                  personName: try c.decodeIfPresent(String.self, forKey: .personName), required: try c.decode(Bool.self, forKey: .required),
                  instructions: try c.decode(String.self, forKey: .instructions), subtasks: try c.decode([ChoreStep].self, forKey: .subtasks),
                  requiresApproval: try c.decode(Bool.self, forKey: .requiresApproval), status: try c.decode(String.self, forKey: .status),
                  version: try c.decode(Int.self, forKey: .version), completion: try c.decode(ChoreCompletion.self, forKey: .completion),
                  dueTime: try c.decodeIfPresent(String.self, forKey: .dueTime), reminderMinutes: try c.decodeIfPresent(Int.self, forKey: .reminderMinutes),
                  skipReason: try c.decodeIfPresent(String.self, forKey: .skipReason), rescheduledFrom: try c.decodeIfPresent(String.self, forKey: .rescheduledFrom),
                  completedAt: try c.decodeIfPresent(String.self, forKey: .completedAt), approvedAt: try c.decodeIfPresent(String.self, forKey: .approvedAt),
                  definitionSource: try c.decode(String.self, forKey: .definitionSource), routineVersion: try c.decode(Int.self, forKey: .routineVersion),
                  createdAt: try c.decodeIfPresent(String.self, forKey: .createdAt), updatedAt: try c.decodeIfPresent(String.self, forKey: .updatedAt),
                  taskSection: try c.decodeIfPresent(String.self, forKey: .taskSection) ?? "tasks",
                  schoolDayFilter: try c.decodeIfPresent(String.self, forKey: .schoolDayFilter) ?? "any",
                  schoolScheduleExempt: try c.decodeIfPresent(Bool.self, forKey: .schoolScheduleExempt) ?? false)
    }
}

struct TaskSectionGroup<Item>: Identifiable {
    let id: String
    let title: String
    let items: [Item]
}

enum TaskSections {
    static func label(_ section: String, schoolDay: Bool = true) -> String {
        guard schoolDay else { return "Tasks" }
        switch section { case "before_school": return "Before school"; case "after_school": return "After school"; default: return "Any time" }
    }
    static func groups(_ items: [ChoreOccurrence], schoolDay: Bool, showEmpty: Bool = false) -> [TaskSectionGroup<ChoreOccurrence>] { groups(items, schoolDay: schoolDay, showEmpty: showEmpty, section: { $0.taskSection }) }
    static func groups(_ items: [Chore], schoolDay: Bool, showEmpty: Bool = false) -> [TaskSectionGroup<Chore>] { groups(items, schoolDay: schoolDay, showEmpty: showEmpty, section: { $0.taskSection }) }
    private static func groups<Item>(_ items: [Item], schoolDay: Bool, showEmpty: Bool, section: (Item) -> String) -> [TaskSectionGroup<Item>] {
        guard !items.isEmpty || showEmpty else { return [] }
        guard schoolDay else { return [.init(id: "tasks", title: "Tasks", items: items)] }
        return ["before_school", "after_school", "tasks"].compactMap { key in
            let rows = items.filter { let value = section($0); return key == "tasks" ? !["before_school", "after_school"].contains(value) : value == key }
            return rows.isEmpty && (!showEmpty || key == "tasks") ? nil : .init(id: key, title: label(key), items: rows)
        }
    }
}

struct OccurrenceAction: Encodable {
    let action: String
    let expectedVersion: Int
    let mutationId: String
    var reason: String?
    var toDate: String?
    var dueTime: String?
    var completedSubtaskIds: [String]?
    private enum CodingKeys: String, CodingKey { case action, expectedVersion, mutationId, reason, toDate, dueTime, completedSubtaskIds }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(action, forKey: .action); try c.encode(expectedVersion, forKey: .expectedVersion); try c.encode(mutationId, forKey: .mutationId)
        try c.encodeIfPresent(reason, forKey: .reason); try c.encodeIfPresent(toDate, forKey: .toDate)
        if action == "reschedule" { try c.encode(dueTime, forKey: .dueTime) }
        try c.encodeIfPresent(completedSubtaskIds, forKey: .completedSubtaskIds)
    }
}

struct ChoreHistoryItem: Decodable, Identifiable {
    let id: String
    let occurrenceId: String
    let title: String
    let personId: String?
    let personName: String?
    let date: String
    let type: String
    let actorName: String
    let reason: String?
    let createdAt: String
    var actionLabel: String {
        switch type {
        case "created": return "Scheduled"
        case "submitted": return "Submitted for approval"
        case "completed": return "Marked done"
        case "reopened": return "Reopened"
        case "approved": return "Approved"
        case "rejected": return "Returned to do"
        case "skipped": return "Excused"
        case "rescheduled": return "Rescheduled"
        case "subtasks_changed": return "Updated checklist"
        case "exception_removed": return "Task break removed"
        case "school_schedule_changed": return "School schedule changed"
        default: return "Updated"
        }
    }
}

struct ChoreBreak: Codable, Identifiable {
    let id: String
    let personId: String?
    let choreId: String?
    let fromDate: String
    let toDateExclusive: String
    let reason: String
    let version: Int
    let createdAt: String?
    let revokedAt: String?
}

struct ChoreBreakDraft: Encodable {
    let fromDate: String
    let toDateExclusive: String
    let personId: String?
    let choreId: String?
    let reason: String
    let mutationId: String
}

struct ChoreHistoryResponse: Decodable { let history: [ChoreHistoryItem] }
struct ChoreBreaksResponse: Decodable { let exceptions: [ChoreBreak] }
