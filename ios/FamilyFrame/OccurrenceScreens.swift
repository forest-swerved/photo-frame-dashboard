import SwiftUI

struct PersonOccurrencesCard: View {
    let person: Person?
    let occurrences: [ChoreOccurrence]
    var body: some View {
        FrameCard(accent: person.map { Color(hex: $0.color) } ?? Brand.lime) {
            HStack {
                Text(person?.name ?? "Family chores").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                let required = occurrences.filter { $0.required && !$0.isSkipped }
                Text("\(required.filter(\.isDone).count)/\(required.count) required").font(.subheadline.weight(.semibold)).monospacedDigit()
                    .padding(.horizontal, 12).padding(.vertical, 6).background(Brand.lime, in: Capsule())
            }
            if occurrences.isEmpty { Text("Nothing scheduled today.").foregroundStyle(Brand.muted) }
            ForEach(occurrences) { occurrence in OccurrenceRow(occurrence: occurrence) }
        }
    }
}

struct OccurrenceRow: View {
    @EnvironmentObject var model: AppModel
    let occurrence: ChoreOccurrence
    @State private var details = false
    private var current: ChoreOccurrence { model.currentOccurrence(occurrence) }
    private var pending: Bool { model.changingChores.contains(current.id) }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button { Task { _ = await model.toggleOccurrence(current) } } label: {
                Group {
                    if pending { ProgressView() }
                    else { Image(systemName: current.isSubmitted ? "clock.fill" : current.isSkipped ? "minus.circle" : current.isDone ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 28)).foregroundStyle(current.isSubmitted ? Brand.magentaInk : current.isDone ? Color(hex: "15803d") : Brand.muted) }
                }.frame(width: 44, height: 44)
            }.buttonStyle(.plain).disabled(!model.canChangeOccurrence(current) || pending || !current.canComplete || (current.isSubmitted && model.canManageChores))
                .accessibilityLabel(current.isSubmitted ? "Withdraw submission for \(current.title)" : current.isDone ? "Reopen \(current.title)" : "Mark \(current.title) done")
                .accessibilityValue(current.statusLabel)
            Button { details = true } label: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(current.title).font(.body.weight(.medium)).strikethrough(current.isDone || current.isSkipped).foregroundStyle(Brand.ink)
                    HStack(spacing: 8) {
                        Text(current.required ? "Required" : "Optional").font(.caption.weight(.semibold))
                        if current.status != "pending" { Text(current.statusLabel).font(.caption.weight(.semibold)).foregroundStyle(current.isSubmitted ? Brand.magentaInk : Brand.muted) }
                    }.foregroundStyle(Brand.cyanInk)
                    if !current.instructions.isEmpty { Text(current.instructions).font(.subheadline).foregroundStyle(Brand.muted).lineLimit(2) }
                    if !current.subtasks.isEmpty { Text("\(current.subtasks.filter { $0.completed == true }.count) of \(current.subtasks.count) steps").font(.caption).foregroundStyle(Brand.muted) }
                    if current.status == "pending" {
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            if let deadline = ChoreDeadline(chore: current.legacy, day: current.date, zone: model.zone, now: context.date) {
                                Text(deadline.text).font(.subheadline).foregroundStyle(deadline.urgency == .overdue ? Brand.red : deadline.urgency == .dueSoon ? Brand.cyanInk : Brand.muted)
                            }
                        }
                    }
                    if let reason = current.skipReason { Text(reason).font(.subheadline).foregroundStyle(Brand.muted) }
                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHint("Opens instructions, checklist and chore actions")
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Brand.muted).padding(.top, 14).accessibilityHidden(true)
        }.padding(.vertical, 6)
            .sheet(isPresented: $details) { OccurrenceDetailScreen(original: current) }
    }
}

struct ApprovalQueue: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        let waiting = model.visibleOccurrences.filter(\.isSubmitted)
        if model.canManageChores && !waiting.isEmpty {
            FrameCard(accent: Brand.magenta) {
                Text("Waiting for approval · \(waiting.count)").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Text("Review the work before it counts as done.").font(.subheadline).foregroundStyle(Brand.muted)
                ForEach(waiting) { item in
                    VStack(alignment: .leading, spacing: 10) {
                        if let name = item.personName { Text(name).font(.caption.weight(.semibold)).foregroundStyle(Brand.cyanInk) }
                        OccurrenceRow(occurrence: item)
                        Button("Approve \(item.title)") { Task { _ = await model.actOnOccurrence(item, action: "approve") } }
                            .font(.headline).frame(minHeight: 44).disabled(!model.canChangeOccurrence(item) || model.changingChores.contains(item.id))
                    }
                    if item.id != waiting.last?.id { Divider() }
                }
            }
        }
    }
}

private enum ChoreActionSheet: String, Identifiable { case reject, skip, reschedule; var id: String { rawValue } }

struct OccurrenceDetailScreen: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let original: ChoreOccurrence
    @State private var action: ChoreActionSheet?
    private var current: ChoreOccurrence { model.currentOccurrence(original) }
    private var enabled: Bool { model.canChangeOccurrence(current) && !model.changingChores.contains(current.id) }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(current.title).font(.title2.bold())
                    Text(current.personName ?? "Family chore").foregroundStyle(Brand.cyanInk)
                    Text(current.statusLabel).font(.headline).foregroundStyle(current.isSubmitted ? Brand.magentaInk : Brand.muted)
                    Text(Dates.dayLabel(current.date)).font(.subheadline)
                    Text(current.required ? "Required chore" : "Optional chore").font(.subheadline)
                    if current.requiresApproval { Text("A parent must approve this chore before it counts as done.").font(.footnote).foregroundStyle(Brand.muted) }
                }
                if !current.instructions.isEmpty { Section("Instructions") { Text(current.instructions).textSelection(.enabled) } }
                RewardHomeCard(network: model.internet)
                if !current.subtasks.isEmpty {
                    Section {
                        ForEach(current.subtasks) { step in
                            Button {
                                var ids = Set(current.subtasks.filter { $0.completed == true }.map(\.id))
                                if ids.contains(step.id) { ids.remove(step.id) } else { ids.insert(step.id) }
                                Task { _ = await model.actOnOccurrence(current, action: "subtasks", steps: ids.sorted()) }
                            } label: { Label(step.title, systemImage: step.completed == true ? "checkmark.circle.fill" : "circle").foregroundStyle(Brand.ink).frame(minHeight: 44) }
                                .disabled(!enabled || current.status != "pending").accessibilityValue(step.completed == true ? "Checked" : "Not checked")
                        }
                    } header: { Text("Checklist") } footer: { Text("Marking this chore done also completes its checklist.") }
                }
                if let reason = current.skipReason { Section("Excused for this day") { Text(reason) } }
                if let from = current.rescheduledFrom { Section { Text("Moved from \(Dates.dayLabel(from)).") } }
                if current.canComplete {
                    Section {
                        if current.isSubmitted && model.canManageChores {
                            Button("Approve this chore") { Task { _ = await model.actOnOccurrence(current, action: "approve") } }.disabled(!enabled)
                            Button("Return it to do") { action = .reject }.disabled(!enabled)
                        } else {
                            Button(current.isSubmitted ? "Withdraw submission" : current.isDone ? "Reopen chore" : current.requiresApproval && !model.canManageChores ? "Submit for approval" : "Mark done") {
                                Task { _ = await model.toggleOccurrence(current) }
                            }.disabled(!enabled)
                        }
                    }
                }
                if model.canManageChores && current.status == "pending" {
                    Section("For this occurrence") {
                        Button("Excuse this chore") { action = .skip }.disabled(!enabled)
                        Button("Move to another day") { action = .reschedule }.disabled(!enabled)
                    }
                }
                Section { Text("This is the saved chore for this date. Routine edits affect newly generated days.").font(.footnote).foregroundStyle(Brand.muted) }
            }.navigationTitle("Chore").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .sheet(item: $action) { OccurrenceActionEditor(occurrence: current, action: $0.rawValue) }
        }
    }
}

private struct OccurrenceActionEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let occurrence: ChoreOccurrence
    let action: String
    @State private var reason = ""
    @State private var target = Date()
    @State private var due = Date()
    @State private var hasDeadline = true
    @State private var saving = false
    @State private var saveBlocked = false
    private var title: String { action == "reschedule" ? "Move this chore" : action == "skip" ? "Excuse this chore" : "Return it to do" }
    var body: some View {
        NavigationStack {
            Form {
                Section { Text(occurrence.title).font(.headline) }
                if action == "reschedule" {
                    Section {
                        DatePicker("New day", selection: $target, in: (Dates.wallTime("00:00", on: model.today, in: model.zone) ?? Date())..., displayedComponents: .date).environment(\.timeZone, model.zone)
                        Toggle("Set a deadline", isOn: $hasDeadline)
                        if hasDeadline { DatePicker("Due by", selection: $due, displayedComponents: .hourAndMinute).environment(\.timeZone, model.zone) }
                    }
                }
                Section("Reason") { TextField("Explain the change", text: $reason, axis: .vertical).lineLimit(3...6) }
                if saveBlocked { Section { Text("Close this form, refresh, and review the chore before making another change.").foregroundStyle(Brand.red) } }
                Section { Text("This changes this occurrence only and appears in its history.").font(.footnote).foregroundStyle(Brand.muted) }
            }.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .task { hasDeadline = occurrence.dueTime != nil; due = Dates.wallTime(occurrence.dueTime ?? "18:00", on: occurrence.date, in: model.zone) ?? Date() }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task {
                            saving = true
                            if await model.actOnOccurrence(occurrence, action: action, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines), toDate: action == "reschedule" ? Dates.day(target, in: model.zone) : nil, dueTime: hasDeadline ? Dates.wallTimeString(due, in: model.zone) : nil) { dismiss() } else { saveBlocked = model.lastMutationNeedsReview }
                            saving = false
                        } } label: { if saving { ProgressView() } else { Text("Save").bold() } }
                            .disabled(saving || saveBlocked || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reason.count > 500 || !model.canChangeOccurrence(occurrence))
                    }
                }
        }.interactiveDismissDisabled(saving)
    }
}

struct ChoreHistoryScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var days = 30
    @State private var personID: String?
    @State private var history: [ChoreHistoryItem] = []
    @State private var loading = false
    @State private var error: String?
    private var selection: String { "\(days)|\(personID ?? "all")" }
    var body: some View {
        List {
            Section {
                Picker("Period", selection: $days) { Text("7 days").tag(7); Text("30 days").tag(30); Text("90 days").tag(90) }
                if model.session?.isChild != true {
                    Picker("Person", selection: $personID) { Text("Everyone").tag(String?.none); ForEach(model.snapshot?.people ?? []) { Text($0.name).tag(Optional($0.id)) } }
                }
            }
            if loading { ProgressView("Loading history…") }
            if let error { Text(error).foregroundStyle(Brand.red) }
            if !loading && history.isEmpty && error == nil { Text("No recorded chore changes in this period.").foregroundStyle(Brand.muted) }
            ForEach(history) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.title).font(.headline)
                    Text(item.actionLabel).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.cyanInk)
                    Text("\(item.actorName) · \(Dates.relative(item.createdAt))").font(.caption).foregroundStyle(Brand.muted)
                    Text("\(item.personName ?? "Family") · \(Dates.dayLabel(item.date))").font(.caption).foregroundStyle(Brand.muted)
                    if let reason = item.reason { Text(reason).font(.subheadline) }
                }.padding(.vertical, 5)
            }
            Section { Text("Shows the latest 100 changes in this period, using the saved chore and household dates.").font(.footnote).foregroundStyle(Brand.muted) }
        }.navigationTitle("Chore history").task(id: selection) { await load() }.refreshable { await load() }
    }
    private func load() async {
        loading = true; error = nil; let selected = selection
        defer { if selected == selection { loading = false } }
        do {
            let result = try await model.loadChoreHistory(from: Dates.shiftedDay(model.today, by: -days + 1), to: Dates.shiftedDay(model.today, by: 1), personID: personID)
            guard !Task.isCancelled, selected == selection else { return }; history = result
        } catch is CancellationError { }
        catch { if selected == selection { history = []; self.error = error.localizedDescription } }
    }
}
