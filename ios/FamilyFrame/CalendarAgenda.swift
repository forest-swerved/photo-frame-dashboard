import Foundation

struct CalendarAgendaItem: Identifiable {
    let event: CalendarEvent
    let day: String
    let timeLabel: String
    let calendarName: String?
    let color: String
    var id: String { event.id + "|" + day }
}

struct CalendarDaySection: Identifiable {
    let day: String
    let label: String
    let items: [CalendarAgendaItem]
    var id: String { day }
}

struct CalendarAgendaCache {
    private struct Key: Equatable {
        let events: [CalendarEvent]
        let calendars: [CalendarPaletteEntry]
        let day: String
        let timezone: String
    }
    private var key: Key?
    mutating func update(events: [CalendarEvent], calendars: [CalendarPaletteEntry], from day: String, zone: TimeZone) -> [CalendarDaySection]? {
        let incoming = Key(events: events, calendars: calendars, day: day, timezone: zone.identifier)
        guard incoming != key else { return nil }
        key = incoming
        return CalendarAgenda.sections(events: events, calendars: calendars, from: day, zone: zone)
    }
}

enum CalendarAgenda {
    /// Parse each event once when its snapshot changes, rather than parsing all
    /// events fourteen times every time SwiftUI recomputes a body.
    static func sections(events: [CalendarEvent], calendars: [CalendarPaletteEntry], from startDay: String,
                         zone: TimeZone, days: Int = 14, parseInstant: (String) -> Date? = Dates.instant) -> [CalendarDaySection] {
        guard (1...60).contains(days), Dates.dayDate(startDay) != nil else { return [] }
        let dates = (0..<days).map { Dates.shiftedDay(startDay, by: $0) }
        var metadata: [String: CalendarPaletteEntry] = [:]
        for calendar in calendars { metadata[calendar.id] = calendar }
        var buckets: [String: [CalendarAgendaItem]] = [:]
        for event in events {
            let start = event.startAt.flatMap(parseInstant)
            let parsedEnd = event.endAt.flatMap(parseInstant)
            let end = parsedEnd.flatMap { value -> Date? in guard let start, value > start else { return nil }; return value }
            let first: String, last: String
            if event.allDay {
                guard let firstDay = event.startDate, let exclusiveEnd = event.endDateExclusive,
                      Dates.dayDate(firstDay) != nil, Dates.dayDate(exclusiveEnd) != nil, firstDay < exclusiveEnd else { continue }
                first = firstDay; last = Dates.shiftedDay(exclusiveEnd, by: -1)
            } else {
                guard let start else { continue }
                first = Dates.day(start, in: zone)
                last = end.map { $0 > start ? Dates.day($0.addingTimeInterval(-0.001), in: zone) : first } ?? first
            }
            guard last >= startDay, first <= dates.last! else { continue }
            let calendar = event.calendarId.flatMap { metadata[$0] }
            let startTime = start.map { Dates.time($0, in: zone) } ?? "Time unavailable"
            let endTime = end.map { Dates.time($0, in: zone) }
            for day in dates where first <= day && day <= last {
                let time: String
                if event.allDay { time = first == last ? "All day" : (day == first ? "All day · continues" : "All day · continuing") }
                else if first == last { time = endTime.map { "\(startTime) – \($0)" } ?? startTime }
                else if day == first { time = startTime + " · continues" }
                else if day == last, let endTime { time = "Continues · until " + endTime }
                else { time = "Continues all day" }
                buckets[day, default: []].append(CalendarAgendaItem(event: event, day: day, timeLabel: time,
                    calendarName: calendar?.name, color: calendar?.color ?? "#00748c"))
            }
        }
        return dates.compactMap { day in
            guard let items = buckets[day], !items.isEmpty else { return nil }
            return CalendarDaySection(day: day, label: Dates.dayLabel(day), items: items.sorted {
                if $0.event.allDay != $1.event.allDay { return $0.event.allDay }
                if $0.event.startAt != $1.event.startAt { return ($0.event.startAt ?? "") < ($1.event.startAt ?? "") }
                return $0.event.id < $1.event.id
            })
        }
    }
}

struct ChoreDeadline {
    enum Urgency: Equatable { case completed, overdue, dueSoon, later }
    let text: String
    let urgency: Urgency
    init?(chore: Chore, day: String, zone: TimeZone, now: Date) {
        guard let time = chore.dueTime, let deadline = Dates.wallTime(time, on: day, in: zone) else { return nil }
        let formatted = Dates.time(deadline, in: zone)
        if chore.completion.completed { text = "Completed · due by " + formatted; urgency = .completed }
        else if now >= deadline { text = "Overdue · due by " + formatted; urgency = .overdue }
        else if deadline.timeIntervalSince(now) <= Double(chore.reminderMinutes ?? 15) * 60 {
            text = "Due soon · by " + formatted; urgency = .dueSoon
        } else { text = "Due by " + formatted; urgency = .later }
    }
}
