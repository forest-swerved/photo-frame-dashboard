import SwiftUI

struct ChoreBreaksScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var breaks: [ChoreBreak] = []
    @State private var loading = false
    @State private var error: String?
    @State private var adding = false
    @State private var removing: ChoreBreak?
    @State private var removalReason = ""
    var body: some View {
        List {
            Section { Text("Pause tasks for a holiday, vacation, or a special occasion. Current pending work is excused; completed work keeps its history.").font(.subheadline) }
            if let error { Text(error).foregroundStyle(Brand.red) }
            if loading { ProgressView("Loading task breaks…") }
            ForEach(breaks) { item in
                VStack(alignment: .leading, spacing: 8) {
                    Text(item.reason).font(.headline)
                    Text(scope(item)).font(.subheadline).foregroundStyle(Brand.cyanInk)
                    Text("\(Dates.dayLabel(item.fromDate)) – \(Dates.dayLabel(Dates.shiftedDay(item.toDateExclusive, by: -1)))").font(.subheadline)
                    if item.revokedAt != nil { Text("Removed").font(.caption).foregroundStyle(Brand.muted) }
                    else if item.toDateExclusive <= model.today { Text("Ended").font(.caption).foregroundStyle(Brand.muted) }
                    else { Button("Remove break") { removing = item; removalReason = "" }.frame(minHeight: 44).disabled(loading || !model.canChange) }
                }.padding(.vertical, 6)
            }
            if !loading && breaks.isEmpty && error == nil { Text("No task breaks yet.").foregroundStyle(Brand.muted) }
        }.navigationTitle("Holidays and task breaks").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { adding = true } label: { Label("Add break", systemImage: "plus") }.disabled(!model.canChange) } }
            .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) { ChoreBreakEditor() }
            .alert("Remove this task break?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                TextField("Reason", text: $removalReason)
                Button("Restore current and future work") { if let item = removing { Task { loading = true; if await model.revokeChoreBreak(item, reason: removalReason) { await load() }; loading = false; removing = nil } } }
                    .disabled(removalReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || removalReason.count > 500)
                Button("Cancel", role: .cancel) { removing = nil }
            } message: { Text("Past excused days stay in history. Another overlapping break may still apply.") }
    }
    private func scope(_ item: ChoreBreak) -> String {
        let person = item.personId.flatMap { id in model.snapshot?.people.first(where: { $0.id == id })?.name } ?? "Everyone"
        let routine = item.choreId.flatMap { id in model.routines.first(where: { $0.id == id })?.title }
        return routine.map { person + " · " + $0 } ?? person + " · all tasks"
    }
    private func load() async {
        guard model.canManageChores else { return }; loading = true; error = nil
        defer { loading = false }
        do { let result = try await model.loadChoreBreaks(); guard !Task.isCancelled else { return }; breaks = result }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}

private struct ChoreBreakEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var from = Date()
    @State private var through = Date()
    @State private var personID = ""
    @State private var choreID = ""
    @State private var reason = ""
    @State private var saving = false
    @State private var saveBlocked = false
    @State private var originalDraft: String?
    private var draftSignature: String { draftFingerprint([Dates.day(from, in: model.zone), Dates.day(through, in: model.zone), personID, choreID, reason]) }
    private var hasUnsavedChanges: Bool { originalDraft.map { $0 != draftSignature } ?? false }
    var body: some View {
        NavigationStack {
            Form {
                Section("Who and what") {
                    Picker("Person", selection: $personID) { Text("Everyone").tag(""); ForEach(model.snapshot?.people ?? []) { Text($0.name).tag($0.id) } }
                    Picker("Routine", selection: $choreID) { Text("All tasks").tag(""); ForEach(model.routines.filter { personID.isEmpty || $0.personId == personID }) { Text($0.title).tag($0.id) } }
                }
                Section("Dates") {
                    DatePicker("First day", selection: $from, displayedComponents: .date).environment(\.timeZone, model.zone)
                    DatePicker("Last day", selection: $through, displayedComponents: .date).environment(\.timeZone, model.zone)
                    if !validDates { Text("Choose a break lasting 1 to 366 days.").font(.caption).foregroundStyle(Brand.red) }
                }
                Section("Reason") { TextField("School holiday, vacation…", text: $reason, axis: .vertical).lineLimit(2...5) }
                if saveBlocked { Section { Text("Close this form and review the break list before creating another break.").foregroundStyle(Brand.red) } }
                Section("Before you save") {
                    Text("Pause \(choreID.isEmpty ? "unfinished tasks" : model.routines.first(where: { $0.id == choreID })?.title ?? "this routine") for \(personID.isEmpty ? "everyone" : model.snapshot?.people.first(where: { $0.id == personID })?.name ?? "this person"), from \(Dates.dayLabel(Dates.day(from, in: model.zone))) through \(Dates.dayLabel(Dates.day(through, in: model.zone))), inclusive.").font(.subheadline)
                    Text("Dates use your household timezone. The last day is included. Only pending tasks are excused; submitted and completed work is kept.").font(.footnote).foregroundStyle(Brand.muted) }
            }.navigationTitle("Add a task break").navigationBarTitleDisplayMode(.inline)
            .onAppear { if originalDraft == nil { originalDraft = draftSignature } }
                .onChange(of: personID) { _, _ in choreID = "" }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { DraftCancelButton(dirty: hasUnsavedChanges, saving: saving) { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task {
                            saving = true
                            let draft = ChoreBreakDraft(fromDate: Dates.day(from, in: model.zone), toDateExclusive: Dates.shiftedDay(Dates.day(through, in: model.zone), by: 1), personId: personID.isEmpty ? nil : personID, choreId: choreID.isEmpty ? nil : choreID, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines), mutationId: UUID().uuidString.lowercased())
                            if await model.createChoreBreak(draft) { dismiss() } else { saveBlocked = model.lastMutationNeedsReview }; saving = false
                        } } label: { if saving { ProgressView() } else { Text("Save").bold() } }.disabled(saving || saveBlocked || !model.canChange || !validDates || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reason.count > 500)
                    }
                }
        }.interactiveDismissDisabled(saving || hasUnsavedChanges)
    }
    private var validDates: Bool {
        guard let start = Dates.dayDate(Dates.day(from, in: model.zone)), let end = Dates.dayDate(Dates.day(through, in: model.zone)) else { return false }
        return (0...365).contains(Int(end.timeIntervalSince(start) / 86_400))
    }
}

struct SchoolDayCard: View {
    @EnvironmentObject var model: AppModel
    private var status: SchoolDayStatus? {
        guard let day = model.snapshot?.schoolDay, day.date == model.today else { return nil }
        return day
    }
    var body: some View {
        NavigationLink { SchoolCalendarScreen() } label: {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: status?.type == "non_school_day" ? "sun.max.fill" : "calendar").foregroundStyle(Brand.blueInk).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(status?.label ?? "School calendar not confirmed").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.ink)
                    if status == nil || status?.type != "school_day" { Text(status?.reason ?? "Open the school calendar to review the schedule.").font(.caption).foregroundStyle(Brand.muted) }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Brand.muted).accessibilityHidden(true)
            }.frame(minHeight: 44).padding(.horizontal, 16).padding(.vertical, 8).background(.white, in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).stroke(Brand.line, lineWidth: 1) }
        }.buttonStyle(.plain).accessibilityHint("View school calendar and date changes")
    }
}

struct SchoolCalendarScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var response: SchoolCalendarResponse?
    @State private var chosenDay: String?
    @State private var loading = false
    @State private var error: String?
    @State private var editing = false
    @State private var revision = 0
    private var selectedDay: String { chosenDay ?? model.today }
    private var selectedDate: Binding<Date> {
        Binding(get: { Dates.wallTime("12:00", on: selectedDay, in: model.zone) ?? Date() }, set: { chosenDay = Dates.day($0, in: model.zone) })
    }
    var body: some View {
        List {
            Section {
                DatePicker("Check a date", selection: selectedDate, displayedComponents: .date).environment(\.timeZone, model.zone)
                if loading { ProgressView("Checking school calendar…") }
                else if let day = response?.schoolDay {
                    Label(day.label, systemImage: day.type == "non_school_day" ? "sun.max" : day.isKnown ? "calendar" : "questionmark.circle").font(.headline)
                    Text(day.reason).font(.subheadline).foregroundStyle(Brand.muted)
                }
                if let error { Text(error).font(.subheadline).foregroundStyle(Brand.red) }
                if model.canEditSchoolDate(selectedDay), response?.calendar?.covers(selectedDay) == true {
                    Button("Change this date") { editing = true }.disabled(loading || error != nil || !model.canChange)
                }
            } header: { Text(Dates.dayLabel(selectedDay)) } footer: {
                Text("School days and non-school days choose the matching task routines. An early dismissal is still a school day. Dates follow the household timezone.")
            }
            if let calendar = response?.calendar {
                Section("School year") {
                    Text(calendar.title).font(.headline)
                    LabeledContent("First school day", value: Dates.dayLabel(calendar.termStart))
                    LabeledContent("Last school day", value: Dates.dayLabel(Dates.shiftedDay(calendar.termEndExclusive, by: -1)))
                    Text("Source: " + calendar.sourceName).font(.caption).foregroundStyle(Brand.muted)
                    if let source = calendar.sourceURL { Link("School calendar source", destination: source).font(.subheadline) }
                    Text("Calendar covers " + Dates.dayLabel(calendar.coverageStart) + " through " + Dates.dayLabel(Dates.shiftedDay(calendar.coverageEndExclusive, by: -1)) + ". Dates outside that range are not confirmed.").font(.caption).foregroundStyle(Brand.muted)
                }
                if !calendar.overrides.isEmpty {
                    Section("Parent changes") {
                        ForEach(calendar.overrides.sorted { $0.date < $1.date }) { item in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(Dates.dayLabel(item.date)).font(.headline)
                                Text((item.type == "school_day" ? "School day" : "Non-school day") + " · " + item.reason).font(.subheadline).foregroundStyle(Brand.muted)
                            }
                        }
                    }
                }
                Section("Published days off") {
                    ForEach(calendar.closures) { closure in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(closure.label).font(.headline)
                            Text(closureRange(closure)).font(.subheadline).foregroundStyle(Brand.muted)
                        }
                    }
                }
                Section { Text("The published school calendar selects the matching tasks automatically. Parent changes can set a different school status for a date. Submitted and completed work keeps its history. To excuse tasks for a vacation, use Holidays and task breaks.").font(.footnote).foregroundStyle(Brand.muted) }
            } else if !loading && error == nil {
                Text("No school calendar is configured. School-specific routines need an imported school calendar.").foregroundStyle(Brand.muted)
            }
        }.navigationTitle("School calendar").navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden).background(Brand.background)
            .task(id: selectedDay) { await load() }
            .refreshable { await model.refresh(); await load() }
            .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) {
                if let calendar = response?.calendar { SchoolDayOverrideEditor(date: selectedDay, calendar: calendar, status: response?.schoolDay) }
            }
    }
    private func closureRange(_ closure: SchoolCalendarClosure) -> String {
        let last = Dates.shiftedDay(closure.toDateExclusive, by: -1)
        return Dates.dayLabel(closure.fromDate) + (last == closure.fromDate ? "" : " – " + Dates.dayLabel(last))
    }
    private func load() async {
        revision += 1; let started = revision, day = selectedDay
        loading = true; error = nil; response = nil
        do {
            let value = try await model.loadSchoolCalendar(date: day)
            guard started == revision, selectedDay == day, !Task.isCancelled else { return }
            response = value; loading = false
        } catch {
            guard started == revision, selectedDay == day, !(error is CancellationError), !Task.isCancelled else { return }
            self.error = error.localizedDescription; loading = false
        }
    }
}

private struct SchoolDayOverrideEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let date: String
    let calendar: SchoolCalendarDocument
    @State private var type: String
    @State private var reason = ""
    @State private var saving = false
    @State private var saveBlocked = false
    @State private var error: String?
    private var existing: SchoolDayOverride? { calendar.overrides.first { $0.date == date } }
    init(date: String, calendar: SchoolCalendarDocument, status: SchoolDayStatus?) {
        self.date = date; self.calendar = calendar
        _type = State(initialValue: calendar.overrides.first { $0.date == date }?.type ?? (status?.type == "school_day" ? "school_day" : "non_school_day"))
    }
    @State private var originalDraft: String?
    private var draftSignature: String { draftFingerprint([type, reason]) }
    private var hasUnsavedChanges: Bool { originalDraft.map { $0 != draftSignature } ?? false }
    var body: some View {
        NavigationStack {
            Form {
                Section(Dates.dayLabel(date)) {
                    Picker("This date is", selection: $type) {
                        Text("School day").tag("school_day")
                        Text("Non-school day").tag("non_school_day")
                    }
                    TextField("Reason, such as snow day or makeup day", text: $reason, axis: .vertical).lineLimit(2...5)
                }
                Section { Text("Applies to household task routines on " + Dates.dayLabel(date) + ". Pending tasks switch to the matching routine set. Completed and submitted work stays in history. Task breaks are separate.").font(.footnote).foregroundStyle(Brand.muted) }
                if let existing {
                    Section {
                        Text("Current change: " + existing.reason).font(.subheadline)
                        Button("Use published calendar for this date", role: .destructive) { Task { await save(removing: true) } }.disabled(saving || saveBlocked || !model.canEditSchoolDate(date) || !validReason)
                    } footer: { Text("Enter a reason above to record why this parent change is being removed.") }
                }
                if let error { Section { Text(error).font(.subheadline).foregroundStyle(Brand.red) } }
            }.navigationTitle("Change school date").navigationBarTitleDisplayMode(.inline)
            .onAppear { if originalDraft == nil { originalDraft = draftSignature } }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { DraftCancelButton(dirty: hasUnsavedChanges, saving: saving) { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task { await save(removing: false) } } label: { if saving { ProgressView() } else { Text("Save").bold() } }.disabled(saving || saveBlocked || !model.canEditSchoolDate(date) || !validReason)
                    }
                }
        }.interactiveDismissDisabled(saving || hasUnsavedChanges)
    }
    private var validReason: Bool { !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && reason.count <= 500 }
    private func save(removing: Bool) async {
        saving = true; defer { saving = false }
        let draft = SchoolDayOverrideDraft(expectedVersion: calendar.version, change: .init(date: date, type: removing ? nil : type, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)))
        if await model.changeSchoolDay(draft) { dismiss() }
        else {
            saveBlocked = model.lastMutationNeedsReview
            error = saveBlocked ? "This change could not be confirmed. Close this form, refresh, and review the school calendar before trying again." : model.message ?? "Could not update this school date. Refresh and try again."
        }
    }
}
