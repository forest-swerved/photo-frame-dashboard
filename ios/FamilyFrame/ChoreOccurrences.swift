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
    init(legacy chore: Chore) {
        id = chore.id; title = chore.title; personId = chore.personId; weekdays = chore.weekdays; version = chore.version
        dueTime = chore.dueTime; reminderMinutes = chore.reminderMinutes; required = true; instructions = ""; subtasks = []
        scheduleType = "weekly"; scheduledDate = nil; requiresApproval = false
    }
    var legacy: Chore {
        Chore(id: id, title: title, personId: personId, weekdays: weekdays, version: version, dueTime: dueTime, reminderMinutes: reminderMinutes,
              completion: ChoreCompletion(date: "", completed: false, version: 0, updatedAt: nil))
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
    var isDone: Bool { status == "completed" }
    var isSubmitted: Bool { status == "submitted" }
    var isSkipped: Bool { status == "skipped" }
    var canComplete: Bool { ["pending", "submitted", "completed"].contains(status) }
    var statusLabel: String {
        switch status { case "pending": return "To do"; case "submitted": return "Waiting for parent approval"; case "completed": return requiresApproval ? "Approved" : "Done"; case "skipped": return "Excused"; default: return "Status unavailable" }
    }
    var legacy: Chore {
        Chore(id: choreId, title: title, personId: personId, weekdays: [Dates.weekday(date)], version: routineVersion, dueTime: dueTime, reminderMinutes: reminderMinutes, completion: completion)
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
        case "exception_removed": return "Chore break removed"
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
