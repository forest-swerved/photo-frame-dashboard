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
            Section { Text("Pause chores for a holiday, vacation, or a special occasion. Current pending work is excused; completed work keeps its history.").font(.subheadline) }
            if let error { Text(error).foregroundStyle(Brand.red) }
            if loading { ProgressView("Loading chore breaks…") }
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
            if !loading && breaks.isEmpty && error == nil { Text("No chore breaks yet.").foregroundStyle(Brand.muted) }
        }.navigationTitle("Holidays and chore breaks").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { adding = true } label: { Label("Add break", systemImage: "plus") }.disabled(!model.canChange) } }
            .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) { ChoreBreakEditor() }
            .alert("Remove this chore break?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                TextField("Reason", text: $removalReason)
                Button("Restore current and future work") { if let item = removing { Task { loading = true; if await model.revokeChoreBreak(item, reason: removalReason) { await load() }; loading = false; removing = nil } } }
                    .disabled(removalReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || removalReason.count > 500)
                Button("Cancel", role: .cancel) { removing = nil }
            } message: { Text("Past excused days stay in history. Another overlapping break may still apply.") }
    }
    private func scope(_ item: ChoreBreak) -> String {
        let person = item.personId.flatMap { id in model.snapshot?.people.first(where: { $0.id == id })?.name } ?? "Everyone"
        let routine = item.choreId.flatMap { id in model.routines.first(where: { $0.id == id })?.title }
        return routine.map { person + " · " + $0 } ?? person + " · all chores"
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
    var body: some View {
        NavigationStack {
            Form {
                Section("Who and what") {
                    Picker("Person", selection: $personID) { Text("Everyone").tag(""); ForEach(model.snapshot?.people ?? []) { Text($0.name).tag($0.id) } }
                    Picker("Routine", selection: $choreID) { Text("All chores").tag(""); ForEach(model.routines.filter { personID.isEmpty || $0.personId == personID }) { Text($0.title).tag($0.id) } }
                }
                Section("Dates") {
                    DatePicker("First day", selection: $from, displayedComponents: .date).environment(\.timeZone, model.zone)
                    DatePicker("Last day", selection: $through, displayedComponents: .date).environment(\.timeZone, model.zone)
                    if !validDates { Text("Choose a break lasting 1 to 366 days.").font(.caption).foregroundStyle(Brand.red) }
                }
                Section("Reason") { TextField("School holiday, vacation…", text: $reason, axis: .vertical).lineLimit(2...5) }
                if saveBlocked { Section { Text("Close this form and review the break list before creating another break.").foregroundStyle(Brand.red) } }
                Section { Text("Dates use your household timezone. The last day is included. Only pending chores are excused; submitted and completed work is kept.").font(.footnote).foregroundStyle(Brand.muted) }
            }.navigationTitle("Add a chore break").navigationBarTitleDisplayMode(.inline)
                .onChange(of: personID) { _, _ in choreID = "" }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task {
                            saving = true
                            let draft = ChoreBreakDraft(fromDate: Dates.day(from, in: model.zone), toDateExclusive: Dates.shiftedDay(Dates.day(through, in: model.zone), by: 1), personId: personID.isEmpty ? nil : personID, choreId: choreID.isEmpty ? nil : choreID, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines), mutationId: UUID().uuidString.lowercased())
                            if await model.createChoreBreak(draft) { dismiss() } else { saveBlocked = model.lastMutationNeedsReview }; saving = false
                        } } label: { if saving { ProgressView() } else { Text("Save").bold() } }.disabled(saving || saveBlocked || !model.canChange || !validDates || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reason.count > 500)
                    }
                }
        }.interactiveDismissDisabled(saving)
    }
    private var validDates: Bool {
        guard let start = Dates.dayDate(Dates.day(from, in: model.zone)), let end = Dates.dayDate(Dates.day(through, in: model.zone)) else { return false }
        return (0...365).contains(Int(end.timeIntervalSince(start) / 86_400))
    }
}
