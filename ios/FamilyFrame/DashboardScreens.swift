import SwiftUI

struct TodayScreen: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                StaleBanner()
                FrameCard(accent: Brand.cyan) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(Dates.dayLabel(model.snapshot?.date ?? model.today).uppercased()).font(.caption.weight(.bold)).tracking(1).foregroundStyle(Brand.cyanInk)
                            Text(model.session?.household.title ?? "Our family").font(.largeTitle.bold())
                            Text("Good things happen together.").foregroundStyle(Brand.muted)
                        }
                        Spacer(); BrandMark()
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(model.completedCount)").font(.largeTitle.bold())
                        Text("of \(model.visibleChores.count) chores done today").font(.subheadline).foregroundStyle(Brand.muted)
                    }
                    ProgressView(value: Double(model.completedCount), total: Double(max(model.visibleChores.count, 1))).tint(Color(hex: "4a6400")).padding(10).background(Brand.lime, in: Capsule())
                }
                if let snapshot = model.snapshot {
                    ForEach(visiblePeople(snapshot)) { person in
                        PersonChoresCard(person: person, chores: snapshot.todaysChores.filter { $0.personId == person.id })
                    }
                    let shared = snapshot.todaysChores.filter { $0.personId == nil }
                    if !shared.isEmpty { PersonChoresCard(person: nil, chores: shared) }
                    if snapshot.people.isEmpty && shared.isEmpty {
                        FrameCard(accent: Brand.lime) { EmptyState(symbol: "checklist", title: "Room for good habits", detail: model.isAdmin ? "Create a chore from the Chores tab to get started." : "Your household hasn't added any chores yet.") }
                    }
                } else if model.isLoading { ProgressView("Loading your household…").frame(maxWidth: .infinity).padding() }
                FrameCard(accent: Brand.magenta) {
                    HStack { Text("On the calendar").font(.title2.bold()); Spacer(); Button("View all") { model.selectedTab = 2 }.font(.subheadline.weight(.semibold)) }
                    if let warning = model.calendarMessage ?? model.calendar?.error?.message { Text(warning).font(.caption).foregroundStyle(.orange) }
                    let events = model.calendarAgenda.first(where: { $0.day == model.today })?.items ?? []
                    if events.isEmpty {
                        Text(todayCalendarMessage).foregroundStyle(Brand.muted)
                    } else { ForEach(Array(events.prefix(5))) { EventRow(item: $0) } }
                }
            }.padding(20).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("Today")
            .refreshable { await model.refresh() }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { refreshButton } }
    }
    private var todayCalendarMessage: String {
        guard let calendar = model.calendar else { return "Calendar availability is not confirmed yet." }
        if calendar.status == "not_configured" { return "Connect Apple Calendar in the web dashboard's Setup." }
        return model.confirmsCalendarAvailability(from: model.today, to: Dates.shiftedDay(model.today, by: 1)) ? "No events today." : calendar.availabilityMessage
    }
    private func visiblePeople(_ snapshot: HouseholdSnapshot) -> [Person] { snapshot.people.filter { model.session?.isChild != true || $0.id == model.session?.personId } }
    private var refreshButton: some View { Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.disabled(model.isLoading).accessibilityLabel("Refresh family dashboard") }
}

struct PersonChoresCard: View {
    let person: Person?
    let chores: [Chore]
    var body: some View {
        FrameCard(accent: person.map { Color(hex: $0.color) } ?? Brand.lime) {
            HStack {
                Text(person?.name ?? "Family chores").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                Text("\(chores.filter { $0.completion.completed }.count)/\(chores.count)").font(.subheadline.weight(.semibold)).monospacedDigit().padding(.horizontal, 12).padding(.vertical, 6).background(Brand.lime, in: Capsule())
            }
            if chores.isEmpty { Text("Nothing scheduled today.").font(.subheadline).foregroundStyle(Brand.muted) }
            ForEach(chores) { ChoreRow(chore: $0) }
        }
    }
}

struct ChoreRow: View {
    @EnvironmentObject var model: AppModel
    let chore: Chore
    var allowCompletion = true
    var body: some View {
        HStack(spacing: 12) {
            Button { Task { await model.toggle(chore) } } label: {
                Group {
                    if model.changingChores.contains(chore.id) { ProgressView() }
                    else { Image(systemName: chore.completion.completed ? "checkmark.circle.fill" : "circle").font(.system(size: 28)).foregroundStyle(chore.completion.completed ? Color(hex: "15803d") : Brand.muted) }
                }.frame(width: 44, height: 44)
            }.buttonStyle(.plain).disabled(!allowCompletion || !model.canChange || model.changingChores.contains(chore.id))
                .accessibilityLabel(chore.completion.completed ? "Reopen \(chore.title)" : "Complete \(chore.title)")
                .accessibilityValue(chore.completion.completed ? "Completed" : "Not completed")
            VStack(alignment: .leading, spacing: 4) {
                Text(chore.title).font(.body.weight(.medium)).strikethrough(chore.completion.completed).foregroundStyle(Brand.ink)
                if allowCompletion {
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        if let deadline = ChoreDeadline(chore: chore, day: model.snapshot?.date ?? model.today, zone: model.zone, now: context.date) {
                            Label(deadline.text, systemImage: deadline.urgency == .overdue ? "exclamationmark.circle.fill" : "clock")
                                .font(.subheadline).foregroundStyle(deadline.urgency == .overdue ? Brand.red : deadline.urgency == .dueSoon ? Brand.cyanInk : Brand.muted)
                        }
                    }
                }
                if !allowCompletion { Text("Not scheduled today").font(.caption).foregroundStyle(Brand.muted) }
            }
            Spacer(minLength: 0)
        }.padding(.vertical, 3)
    }
}

struct ChoresScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var editing: Chore?
    @State private var adding = false
    @State private var selectedPerson: String? = nil
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                StaleBanner()
                if let snapshot = model.snapshot {
                    if model.session?.isChild != true {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                filterPill("Everyone", id: nil)
                                ForEach(snapshot.people) { person in filterPill(person.name, id: person.id) }
                            }
                        }
                    }
                    ForEach(snapshot.people.filter { (selectedPerson == nil || $0.id == selectedPerson) && (model.session?.isChild != true || $0.id == model.session?.personId) }) { person in
                        choreSection(person.name, accent: Color(hex: person.color), chores: snapshot.chores.filter { $0.personId == person.id })
                    }
                    let unassigned = snapshot.chores.filter { $0.personId == nil }
                    if selectedPerson == nil && !unassigned.isEmpty { choreSection("Family chores", accent: Brand.lime, chores: unassigned) }
                    if snapshot.chores.isEmpty && snapshot.people.isEmpty {
                        FrameCard(accent: Brand.lime) { EmptyState(symbol: "checklist", title: "Your household's routines", detail: "A parent can add chores and assign them to each person.") }
                    }
                }
            }.padding(20).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle(model.session?.isChild == true ? "My chores" : "Chores")
            .refreshable { await model.refresh() }
            .toolbar { if model.isAdmin { ToolbarItem(placement: .topBarTrailing) { Button { adding = true } label: { Label("Add chore", systemImage: "plus") }.disabled(!model.canChange) } } }
            .sheet(isPresented: $adding) { ChoreEditor(chore: nil) }
            .sheet(item: $editing) { ChoreEditor(chore: $0) }
    }
    private func filterPill(_ name: String, id: String?) -> some View {
        Button { selectedPerson = id } label: { Text(name).font(.subheadline.weight(.semibold)).padding(.horizontal, 18).padding(.vertical, 11).background(selectedPerson == id ? Brand.lime : Color.white, in: Capsule()).foregroundStyle(Brand.ink).overlay { Capsule().stroke(Brand.line, lineWidth: 1) } }.buttonStyle(.plain).accessibilityAddTraits(selectedPerson == id ? .isSelected : []).accessibilityValue(selectedPerson == id ? "Selected" : "Not selected")
    }
    private func choreSection(_ name: String, accent: Color, chores: [Chore]) -> some View {
        FrameCard(accent: accent) {
            Text(name).font(.title2.bold()).accessibilityAddTraits(.isHeader)
            if chores.isEmpty { Text("No chores assigned yet.").foregroundStyle(Brand.muted) }
            ForEach(chores) { chore in
                HStack {
                    ChoreRow(chore: chore, allowCompletion: chore.applies(on: model.snapshot?.date ?? model.today))
                    if model.isAdmin { Button { editing = chore } label: { Image(systemName: "pencil").frame(width: 44, height: 44) }.accessibilityLabel("Edit \(chore.title)").disabled(!model.canChange) }
                }
                Text(chore.weekdays.sorted().map { ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][$0] }.joined(separator: " · ")).font(.caption).foregroundStyle(Brand.muted).padding(.leading, 56)
                if chore.id != chores.last?.id { Divider() }
            }
        }
    }
}

struct CalendarScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var selectedCalendar: String?
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                StaleBanner()
                Text("The next two weeks").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Text(model.session?.household.timezone ?? "Household time").font(.subheadline).foregroundStyle(Brand.muted)
                if let calendars = model.calendar?.calendars, !calendars.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            calendarFilter("All calendars", id: nil, color: Brand.ink)
                            ForEach(calendars) { calendar in calendarFilter(calendar.name, id: calendar.id, color: Color(hex: calendar.color)) }
                        }
                    }
                }
                if let warning = model.calendarMessage ?? model.calendar?.error?.message { Label(warning, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(Brand.red) }
                if model.calendar?.isStale == true { Label("Showing the last calendar sync", systemImage: "clock.arrow.circlepath").font(.subheadline).foregroundStyle(Brand.muted) }
                if model.calendar?.status == "not_configured" {
                    FrameCard { EmptyState(symbol: "calendar.badge.plus", title: "Connect your family calendar", detail: "A parent can connect Apple Calendar in the web dashboard's Setup.") }
                } else if model.calendarAgenda.isEmpty {
                    FrameCard {
                        let confirmed = model.confirmsCalendarAvailability(from: model.today, to: Dates.shiftedDay(model.today, by: 14))
                        EmptyState(symbol: confirmed ? "calendar" : "calendar.badge.clock", title: confirmed ? "A little breathing room" : "Checking your calendar", detail: confirmed ? "No events in the next two weeks." : (model.calendar?.availabilityMessage ?? "Calendar availability is not confirmed yet."))
                    }
                } else {
                    ForEach(model.calendarAgenda) { section in
                        let items = section.items.filter { selectedCalendar == nil || $0.event.calendarId == selectedCalendar }
                        if !items.isEmpty {
                            FrameCard(accent: Brand.cyan) {
                                Text(section.label).font(.headline).accessibilityAddTraits(.isHeader)
                                ForEach(items) { EventRow(item: $0) }
                            }
                        }
                    }
                }
                if let synced = model.calendar?.lastSuccessfulSyncAt { Text("Calendar synced \(Dates.relative(synced))").font(.caption).foregroundStyle(Brand.muted) }
            }.padding(20).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("Calendar").refreshable { await model.refresh() }
            .onChange(of: model.calendar?.calendars.map(\.id)) { _, ids in
                if let selectedCalendar, ids?.contains(selectedCalendar) != true { self.selectedCalendar = nil }
            }
    }
    private func calendarFilter(_ name: String, id: String?, color: Color) -> some View {
        Button { selectedCalendar = id } label: {
            Label { Text(name).font(.subheadline.weight(.semibold)) } icon: { Circle().fill(color).frame(width: 9, height: 9) }
                .padding(.horizontal, 16).frame(minHeight: 44).background(selectedCalendar == id ? Brand.lime : .white, in: Capsule())
                .foregroundStyle(Brand.ink).overlay { Capsule().stroke(Brand.line, lineWidth: 1) }
        }.buttonStyle(.plain).accessibilityAddTraits(selectedCalendar == id ? .isSelected : []).accessibilityValue(selectedCalendar == id ? "Selected" : "Not selected")
    }
}

// Multi-day all-day and overnight events remain visible on every covered day.
func eventOccurs(_ event: CalendarEvent, on day: String, zone: TimeZone) -> Bool {
    if event.allDay { return (event.startDate ?? "9999") <= day && (event.endDateExclusive ?? "0000") > day }
    guard let start = event.startAt.flatMap(Dates.instant) else { return false }
    let startDay = Dates.day(start, in: zone)
    guard let end = event.endAt.flatMap(Dates.instant), end > start else { return startDay == day }
    let endDay = Dates.day(end.addingTimeInterval(-0.001), in: zone)
    return startDay <= day && endDay >= day
}

struct EventRow: View {
    @EnvironmentObject var model: AppModel
    let item: CalendarAgendaItem
    @State private var details = false
    var body: some View {
        Button { details = true } label: {
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 3).fill(Color(hex: item.color)).frame(width: 4)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.event.title).font(.body.weight(.medium)).foregroundStyle(Brand.ink)
                    Text(item.timeLabel).font(.subheadline).foregroundStyle(Brand.cyanInk)
                    if let name = item.calendarName { Text(name).font(.caption).foregroundStyle(Brand.muted) }
                    if let location = item.event.location, !location.isEmpty { Label(location, systemImage: "mappin.and.ellipse").font(.caption).foregroundStyle(Brand.muted) }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Brand.muted).accessibilityHidden(true)
            }.fixedSize(horizontal: false, vertical: true).frame(minHeight: 44).padding(.vertical, 4)
        }.buttonStyle(.plain).accessibilityHint("Opens calendar event details")
            .sheet(isPresented: $details) {
                NavigationStack {
                    List {
                        Section {
                            Text(item.event.title).font(.title2.bold()).textSelection(.enabled)
                            Text(Dates.dayLabel(item.day))
                            Text(item.timeLabel).foregroundStyle(Brand.cyanInk)
                            if let start = item.event.startAt.flatMap(Dates.instant), let end = item.event.endAt.flatMap(Dates.instant), Dates.day(start, in: model.zone) != Dates.day(end.addingTimeInterval(-0.001), in: model.zone) {
                                Text("Starts \(Dates.dayLabel(Dates.day(start, in: model.zone))) at \(Dates.time(start, in: model.zone))")
                                Text("Ends \(Dates.dayLabel(Dates.day(end, in: model.zone))) at \(Dates.time(end, in: model.zone))")
                            }
                            Text(model.session?.household.timezone ?? "Household time").font(.caption).foregroundStyle(Brand.muted)
                        }
                        if let name = item.calendarName { Section("Calendar") { Text(name) } }
                        if let location = item.event.location, !location.isEmpty { Section("Location") { Text(location).textSelection(.enabled) } }
                        Section { Text("Edit this event in Apple Calendar.").font(.footnote).foregroundStyle(Brand.muted) }
                    }.navigationTitle("Event").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { details = false } } }
                }
            }
    }
}

struct ActivityScreen: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                StaleBanner()
                if let message = model.activityMessage { Text(message).font(.subheadline).foregroundStyle(.orange).frame(maxWidth: .infinity, alignment: .leading) }
                if model.notifications.isEmpty {
                    FrameCard(accent: Brand.magenta) { EmptyState(symbol: "bell.badge", title: "You're all caught up", detail: "Chore updates and reminders will appear here. You can choose which ones reach your phone in Settings.") }
                }
                ForEach(model.notifications) { item in
                    Button { Task { await model.markRead(item) } } label: {
                        FrameCard(accent: item.readAt == nil ? Brand.magenta : Brand.line) {
                            HStack(alignment: .top) {
                                Image(systemName: item.kind.contains("chore") ? "checklist" : "bell").foregroundStyle(Brand.cyanInk).frame(width: 24)
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack { Text(item.title).font(.headline); Spacer(); if item.readAt == nil { Circle().fill(Brand.magenta).frame(width: 8, height: 8).accessibilityLabel("Unread") } }
                                    Text(item.body).font(.subheadline).foregroundStyle(Brand.muted)
                                    Text(Dates.relative(item.createdAt)).font(.caption).foregroundStyle(Brand.muted)
                                }
                            }
                        }
                    }.buttonStyle(.plain).accessibilityHint(item.readAt == nil ? "Marks this activity as read" : "Read activity")
                }
            }.padding(20).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("Activity").refreshable { await model.refresh() }
    }
}
