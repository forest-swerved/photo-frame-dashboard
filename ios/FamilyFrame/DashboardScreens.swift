import SwiftUI

struct TodayScreen: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        RewardAwareScroll(network: model.internet) {
            LazyVStack(alignment: .leading, spacing: 16) {
                StaleBanner()
                VStack(alignment: .leading, spacing: 16) {
                    Text(Dates.dayLabel(model.snapshot?.date ?? model.today)).font(.subheadline).foregroundStyle(Brand.muted)
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: 16) { childProgress }
                        VStack(alignment: .leading, spacing: 16) { childProgress }
                    }
                }.padding(.vertical, 8)
                SchoolDayCard()
                ApprovalQueue()
                RewardHomeCard(network: model.internet).id("earned-reward")
                if model.session?.isChild == true { HomeRewardBalance(network: model.internet) }
                if model.session?.isChild != true { InternetHomeSessions(network: model.internet) }
                if let snapshot = model.snapshot, snapshot.occurrences != nil {
                    ForEach(model.chorePeople.filter { model.session?.isChild != true || $0.id == model.session?.personId }) { person in
                        PersonOccurrencesCard(person: person, occurrences: model.visibleOccurrences.filter { $0.personId == person.id })
                    }
                    let shared = model.visibleOccurrences.filter { $0.personId == nil }
                    if !shared.isEmpty { PersonOccurrencesCard(person: nil, occurrences: shared) }
                    if model.chorePeople.isEmpty && shared.isEmpty { FrameCard(accent: Brand.mint) { EmptyState(symbol: "checklist", title: "Nothing scheduled today", detail: model.canManageChores ? "Add a routine or a one-time task from Tasks." : "Your scheduled tasks will appear here.") } }
                } else if let snapshot = model.snapshot {
                    ForEach(snapshot.people.filter { model.session?.isChild != true || $0.id == model.session?.personId }) { person in
                        PersonChoresCard(person: person, chores: snapshot.todaysChores.filter { $0.personId == person.id })
                    }
                    let shared = snapshot.todaysChores.filter { $0.personId == nil }
                    if !shared.isEmpty { PersonChoresCard(person: nil, chores: shared) }
                    if snapshot.people.isEmpty && shared.isEmpty { FrameCard(accent: Brand.mint) { EmptyState(symbol: "checklist", title: "Room for good habits", detail: "Create a task from the Tasks tab to get started.") } }
                } else if model.isLoading { ProgressView("Loading your household…").frame(maxWidth: .infinity).padding() }
                if model.session?.isChild == true { InternetHomeSessions(network: model.internet) }
                FrameCard(accent: Brand.blue) {
                    HStack { Text("Up next").font(.title2.bold()); Spacer(); Button("Calendar") { model.selectedTab = 2 }.font(.subheadline.weight(.semibold)).frame(minHeight: 44) }
                    if let warning = model.calendarMessage ?? model.calendar?.error?.message { Text(warning).font(.caption).foregroundStyle(Brand.attentionInk) }
                    let events = model.calendarAgenda.first(where: { $0.day == model.today })?.items ?? []
                    let upcoming = events.filter { item in item.event.allDay || (item.event.endAt.flatMap(Dates.instant) ?? item.event.startAt.flatMap(Dates.instant) ?? .distantFuture) >= model.presentationNow }
                    if upcoming.isEmpty { Text(todayCalendarMessage).foregroundStyle(Brand.muted) }
                    else { ForEach(Array(upcoming.prefix(3))) { EventRow(item: $0) } }
                    let earlier = events.filter { item in !upcoming.contains(where: { $0.id == item.id }) }
                    if !earlier.isEmpty { DisclosureGroup("Earlier today · \(earlier.count)") { ForEach(earlier) { EventRow(item: $0) } }.font(.subheadline) }
                }
            }.padding(20).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("Today")
            .refreshable { await model.refresh() }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.disabled(model.isLoading).accessibilityLabel("Refresh family dashboard") } }
    }
    @ViewBuilder private var childProgress: some View {
        ForEach(model.chorePeople.filter { model.session?.isChild != true || $0.id == model.session?.personId }) { person in
            let required = model.visibleOccurrences.filter { $0.personId == person.id && $0.required && !$0.isSkipped && model.isCurrentSchoolSchedule($0) }
            VStack(alignment: .leading, spacing: 8) {
                Text(person.name).font(.title3.weight(.semibold))
                Text("\(required.filter(\.isDone).count) / \(required.count)").font(.system(.title2, design: .monospaced).weight(.semibold))
                Text("required tasks done").font(.caption).foregroundStyle(Brand.muted)
                ProgressView(value: Double(required.filter(\.isDone).count), total: Double(max(1,required.count))).tint(Brand.primary)
            }.frame(minWidth: 100, maxWidth: .infinity, alignment: .leading).padding(14)
                .overlay { RoundedRectangle(cornerRadius: 5).stroke(Brand.line) }
        }
    }
    private var todayCalendarMessage: String {
        guard let calendar = model.calendar else { return "Calendar availability is not confirmed yet." }
        if calendar.status == "not_configured" { return "Connect Apple Calendar in the web dashboard's Settings." }
        return model.confirmsCalendarAvailability(from: model.today, to: Dates.shiftedDay(model.today, by: 1)) ? "The rest of today is clear." : calendar.availabilityMessage
    }
}

struct PersonChoresCard: View {
    @EnvironmentObject var model: AppModel
    let person: Person?
    let chores: [Chore]
    var showEmptySections = false
    var body: some View {
        FrameCard(accent: person.map { Color(hex: $0.color) } ?? Brand.lime) {
            HStack {
                Text(person?.name ?? "Family tasks").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                Text("\(chores.filter { $0.completion.completed }.count)/\(chores.count)").font(.subheadline.weight(.semibold)).monospacedDigit().padding(.horizontal, 12).padding(.vertical, 6).background(Brand.lime, in: Capsule())
            }
            if chores.isEmpty && !showEmptySections { Text("Nothing scheduled today.").font(.subheadline).foregroundStyle(Brand.muted) }
            ForEach(TaskSections.groups(chores, schoolDay: model.isSchoolDay, showEmpty: showEmptySections)) { group in
                Text(group.title).font(.headline).foregroundStyle(Brand.cyanInk).accessibilityAddTraits(.isHeader).padding(.top, 6)
                if group.items.isEmpty { Text("No tasks scheduled.").font(.subheadline).foregroundStyle(Brand.muted) }
                ForEach(group.items.filter { !$0.completion.completed }) { ChoreRow(chore: $0) }
            }
            let completed = chores.filter { $0.completion.completed }
            if !completed.isEmpty { DisclosureGroup("Completed · \(completed.count)") { ForEach(completed) { ChoreRow(chore: $0) } }.font(.subheadline) }
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
                    else { Image(systemName: chore.completion.completed ? "checkmark.circle.fill" : "circle").font(.system(size: 28)).foregroundStyle(chore.completion.completed ? Brand.successInk : Brand.muted) }
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
    @State private var editing: ChoreRoutine?
    @State private var adding = false
    @State private var selectedPerson: String?
    @State private var routinesVisible = false
    @State private var routineQuery = ""
    @State private var routineSchedule = "all"
    var body: some View {
        RewardAwareScroll(network: model.internet) {
            LazyVStack(alignment: .leading, spacing: 20) {
                StaleBanner()
                SchoolDayCard()
                RewardHomeCard(network: model.internet).id("earned-reward")
                if model.session?.isChild != true {
                    Picker("Task view", selection: $routinesVisible) { Text("Today").tag(false); Text("Routines").tag(true) }.pickerStyle(.segmented)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack { filterPill("Everyone", id: nil); ForEach(model.chorePeople) { person in filterPill(person.name, id: person.id) } }
                    }
                }
                if routinesVisible && model.session?.isChild != true {
                    TextField("Find a routine", text: $routineQuery).textFieldStyle(.roundedBorder).accessibilityLabel("Find a routine")
                    Picker("Schedule", selection: $routineSchedule) { Text("All schedules").tag("all"); Text("Weekly").tag("weekly"); Text("One time").tag("one_off") }.pickerStyle(.segmented)
                    routinesList
                }
                else if let snapshot = model.snapshot, snapshot.occurrences != nil {
                    ApprovalQueue(personID: selectedPerson)
                    ForEach(model.chorePeople.filter { (selectedPerson == nil || $0.id == selectedPerson) && (model.session?.isChild != true || $0.id == model.session?.personId) }) { person in
                        PersonOccurrencesCard(person: person, occurrences: model.visibleOccurrences.filter { $0.personId == person.id }, showEmptySections: true)
                    }
                    let shared = model.visibleOccurrences.filter { $0.personId == nil }
                    if selectedPerson == nil && !shared.isEmpty { PersonOccurrencesCard(person: nil, occurrences: shared, showEmptySections: true) }
                    if model.visibleOccurrences.isEmpty && model.chorePeople.isEmpty { FrameCard { EmptyState(symbol: "checklist", title: "Nothing scheduled today", detail: "Your routines generate a saved task list for each day.") } }
                } else if let snapshot = model.snapshot {
                    ForEach(snapshot.people.filter { selectedPerson == nil || $0.id == selectedPerson }) { person in
                        PersonChoresCard(person: person, chores: snapshot.todaysChores.filter { $0.personId == person.id }, showEmptySections: true)
                    }
                    let shared = snapshot.todaysChores.filter { $0.personId == nil }
                    if selectedPerson == nil && !shared.isEmpty { PersonChoresCard(person: nil, chores: shared, showEmptySections: true) }
                }
                DisclosureGroup("History and schedule tools") {
                NavigationLink { ChoreHistoryScreen() } label: { Label("Task history", systemImage: "clock.arrow.circlepath").font(.headline).frame(minHeight: 44) }
                NavigationLink { SchoolCalendarScreen() } label: { Label("School calendar", systemImage: "calendar").font(.headline).frame(minHeight: 44) }
                if model.canManageChores { NavigationLink { ChoreBreaksScreen() } label: { Label("Holidays and task breaks", systemImage: "sun.max").font(.headline).frame(minHeight: 44) } }
                Text("School dates choose routines. Task breaks excuse work during time away.").font(.caption).foregroundStyle(Brand.muted)
                }
            }.padding(20).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle(model.session?.isChild == true ? "My tasks" : "Tasks")
            .refreshable { await model.refresh() }
            .toolbar { if model.canManageChores { ToolbarItem(placement: .topBarTrailing) { Button { adding = true } label: { Label("Add task", systemImage: "plus") }.disabled(!model.canChange) } } }
            .sheet(isPresented: $adding) { ChoreEditor(routine: nil, assignedPersonID: selectedPerson) }
            .sheet(item: $editing) { ChoreEditor(routine: $0) }
    }
    private var routinesList: some View {
        ForEach(model.routines.filter { (selectedPerson == nil || $0.personId == selectedPerson) && (routineSchedule == "all" || $0.scheduleType == routineSchedule) && (routineQuery.isEmpty || $0.title.localizedCaseInsensitiveContains(routineQuery)) }) { routine in
            FrameCard(accent: routine.required ? Brand.cyan : Brand.lime) {
                HStack {
                    Text(routine.title).font(.headline); Spacer()
                    if model.canManageChores { Button { editing = routine } label: { Image(systemName: "pencil").frame(width: 44, height: 44) }.accessibilityLabel("Edit \(routine.title)").disabled(!model.canChange) }
                }
                Text(routine.scheduleType == "one_off" ? "One time · \(routine.scheduledDate.map(Dates.dayLabel) ?? "Date unavailable")" : routine.weekdays.filter { (0...6).contains($0) }.sorted().map { ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][$0] }.joined(separator: " · ")).font(.subheadline).foregroundStyle(Brand.muted)
                Label(SchoolSchedule.filterLabel(routine.schoolDayFilter), systemImage: "calendar").font(.subheadline).foregroundStyle(Brand.cyanInk)
                if routine.schoolDayFilter == "school_day" { Text(TaskSections.label(routine.taskSection)).font(.subheadline).foregroundStyle(Brand.cyanInk) }
                Text((routine.required ? "Required" : "Optional") + (routine.requiresApproval ? " · parent approval" : "")).font(.subheadline).foregroundStyle(Brand.cyanInk)
                if !routine.instructions.isEmpty { Text(routine.instructions).font(.subheadline).foregroundStyle(Brand.muted).lineLimit(3) }
            }
        }
    }
    private func filterPill(_ name: String, id: String?) -> some View {
        Button { selectedPerson = id } label: { Text(name).font(.subheadline.weight(.semibold)).padding(.horizontal, 18).frame(minHeight: 44).background(selectedPerson == id ? Brand.lime : Color.white, in: Capsule()).foregroundStyle(Brand.ink).overlay { Capsule().stroke(Brand.line, lineWidth: 1) } }.buttonStyle(.plain).accessibilityAddTraits(selectedPerson == id ? .isSelected : [])
    }
}

struct CalendarScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var selectedCalendar: String?
    @State private var selectedDay: String?
    private var days: [String] { (0..<14).map { Dates.shiftedDay(model.today, by: $0) } }
    private var visibleAgenda: [CalendarDaySection] {
        model.calendarAgenda.compactMap { section in
            guard selectedDay == nil || selectedDay == section.day else { return nil }
            let items = section.items.filter { selectedCalendar == nil || $0.event.calendarId == selectedCalendar }
            return items.isEmpty ? nil : CalendarDaySection(day: section.day, label: section.label, items: items)
        }
    }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                StaleBanner()
                HStack { Text("The next two weeks").font(.headline); Spacer(); Button("Today") { selectedDay = model.today }.frame(minHeight: 44) }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        dayFilter("All dates", day: nil)
                        ForEach(days, id: \.self) { day in dayFilter(Dates.dayLabel(day), day: day) }
                    }
                }.accessibilityLabel("Choose an agenda date")
                if let calendars = model.calendar?.calendars, !calendars.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack { calendarFilter("All calendars", id: nil, color: Brand.ink); ForEach(calendars) { calendar in calendarFilter(calendar.name, id: calendar.id, color: Color(hex: calendar.color)) } }
                    }
                }
                if let warning = model.calendarMessage ?? model.calendar?.error?.message { Label(warning, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(Brand.attentionInk) }
                if model.calendar?.isStale == true { Label("Showing the last calendar sync", systemImage: "clock.arrow.circlepath").font(.caption).foregroundStyle(Brand.muted) }
                if model.calendar?.status == "not_configured" {
                    FrameCard { EmptyState(symbol: "calendar.badge.plus", title: "Connect your family calendar", detail: "A parent can connect Apple Calendar in web Settings."); Link("Continue in web Settings", destination: Brand.webSettings("calendar")).frame(minHeight: 44) }
                } else if visibleAgenda.isEmpty {
                    FrameCard {
                        let from = selectedDay ?? model.today
                        let through = selectedDay.map { Dates.shiftedDay($0, by: 1) } ?? Dates.shiftedDay(model.today, by: 14)
                        let confirmed = model.confirmsCalendarAvailability(from: from, to: through)
                        EmptyState(symbol: confirmed ? "calendar" : "calendar.badge.clock", title: confirmed ? "A little breathing room" : "Calendar not confirmed", detail: confirmed ? (selectedCalendar == nil ? "No events in this date range." : "No events from this calendar in this date range.") : model.calendar?.availabilityMessage ?? "Calendar availability is not confirmed yet.")
                    }
                } else {
                    ForEach(visibleAgenda) { section in
                        FrameCard(accent: Brand.blue) { Text(section.label).font(.headline).accessibilityAddTraits(.isHeader); ForEach(section.items) { EventRow(item: $0) } }
                    }
                }
                Text("Times follow \(model.session?.household.timezone ?? "the household timezone"). Edit events in Apple Calendar.").font(.caption).foregroundStyle(Brand.muted)
                if let synced = model.calendar?.lastSuccessfulSyncAt { Text("Calendar synced \(Dates.relative(synced))").font(.caption).foregroundStyle(Brand.muted) }
            }.padding(20).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("Calendar").refreshable { await model.refresh() }
            .onChange(of: model.calendar?.calendars.map(\.id)) { _, ids in if let selectedCalendar, ids?.contains(selectedCalendar) != true { self.selectedCalendar = nil } }
            .onChange(of: model.today) { _, _ in if let selectedDay, !days.contains(selectedDay) { self.selectedDay = nil } }
    }
    private func dayFilter(_ title: String, day: String?) -> some View {
        Button { selectedDay = day } label: { Text(title).font(.subheadline.weight(.semibold)).padding(.horizontal, 15).frame(minHeight: 44).background(selectedDay == day ? Brand.primaryTint : .white, in: Capsule()).foregroundStyle(selectedDay == day ? Brand.primary : Brand.ink) }.buttonStyle(.plain).accessibilityAddTraits(selectedDay == day ? .isSelected : [])
    }
    private func calendarFilter(_ name: String, id: String?, color: Color) -> some View {
        Button { selectedCalendar = id } label: {
            Label { Text(name).font(.subheadline.weight(.semibold)) } icon: { Circle().fill(color).frame(width: 9, height: 9) }
                .padding(.horizontal, 16).frame(minHeight: 44).background(selectedCalendar == id ? Brand.primaryTint : .white, in: Capsule()).foregroundStyle(selectedCalendar == id ? Brand.primary : Brand.ink).overlay { Capsule().stroke(Brand.line, lineWidth: 1) }
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
    private var days: [String] { Array(Set(model.notifications.map { $0.createdAt.flatMapDate(in: model.zone) ?? "unknown" })).sorted(by: >) }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                StaleBanner()
                if let message = model.activityMessage { Text(message).font(.subheadline).foregroundStyle(Brand.attentionInk) }
                if model.notifications.isEmpty && !model.hasLoadedActivity && model.activityMessage == nil { ProgressView("Loading Activity…") }
                if model.notifications.isEmpty && model.hasLoadedActivity && model.activityMessage == nil { FrameCard(accent: Brand.coral) { EmptyState(symbol: "bell.badge", title: "You're all caught up", detail: "Task updates and reminders will appear here. Choose which ones reach your phone in Settings.") } }
                ForEach(days, id: \.self) { day in
                    Text(day == model.today ? "Today" : day == Dates.shiftedDay(model.today, by: -1) ? "Yesterday" : (day == "unknown" ? "Earlier activity" : Dates.dayLabel(day))).font(.headline).accessibilityAddTraits(.isHeader)
                    ForEach(model.notifications.filter { ($0.createdAt.flatMapDate(in: model.zone) ?? "unknown") == day }) { item in
                        Button { Task { await model.openNotification(id: item.id) } } label: {
                            FrameCard(accent: item.readAt == nil ? Brand.coral : Brand.line) {
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: item.kind.contains("chore") ? "checklist" : "bell").foregroundStyle(Brand.blueInk).frame(width: 24)
                                    VStack(alignment: .leading, spacing: 7) {
                                        HStack(alignment: .top) { Text(item.title).font(.headline); Spacer(); if item.readAt == nil { Circle().fill(Brand.coral).frame(width: 8, height: 8).accessibilityLabel("Unread") } }
                                        Text(item.body).font(.subheadline).foregroundStyle(Brand.muted)
                                        Text(Dates.relative(item.createdAt)).font(.caption).foregroundStyle(Brand.muted)
                                    }
                                }.foregroundStyle(Brand.ink)
                            }
                        }.buttonStyle(.plain).accessibilityHint("Opens the related update and marks it read")
                    }
                }
            }.padding(20).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("Activity").refreshable { await model.refresh(); await model.activityOpened() }
    }
}
private extension String {
    func flatMapDate(in zone: TimeZone) -> String? { Dates.instant(self).map { Dates.day($0, in: zone) } }
}
