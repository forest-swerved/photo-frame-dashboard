import SwiftUI
import UserNotifications

struct ChoreEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let routine: ChoreRoutine?
    @State private var title: String
    @State private var personID: String
    @State private var days: Set<Int>
    @State private var hasDeadline: Bool
    @State private var dueDate = Date()
    @State private var reminder: Int
    @State private var required: Bool
    @State private var requiresApproval: Bool
    @State private var instructions: String
    @State private var subtasks: [ChoreStep]
    @State private var scheduleType: String
    @State private var scheduledDate = Date()
    @State private var saving = false
    @State private var confirmDelete = false
    @State private var saveBlocked = false
    @State private var saveMessage: String?
    init(routine: ChoreRoutine?) {
        self.routine = routine
        _title = State(initialValue: routine?.title ?? ""); _personID = State(initialValue: routine?.personId ?? "")
        _days = State(initialValue: Set(routine?.weekdays ?? Array(0...6))); _hasDeadline = State(initialValue: routine?.dueTime != nil)
        _reminder = State(initialValue: routine?.reminderMinutes ?? 15); _required = State(initialValue: routine?.required ?? true)
        _requiresApproval = State(initialValue: routine?.requiresApproval ?? false); _instructions = State(initialValue: routine?.instructions ?? "")
        _subtasks = State(initialValue: routine?.subtasks ?? []); _scheduleType = State(initialValue: routine?.scheduleType ?? "weekly")
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("The chore") {
                    TextField("What needs doing?", text: $title).textInputAutocapitalization(.sentences).accessibilityLabel("Chore title")
                    Picker("Assigned to", selection: $personID) {
                        Text("Family / unassigned").tag(""); ForEach(model.snapshot?.people ?? []) { Text($0.name).tag($0.id) }
                    }
                    Toggle("Required chore", isOn: $required)
                    Toggle("Parent approval required", isOn: $requiresApproval)
                }
                Section("Schedule") {
                    Picker("Frequency", selection: $scheduleType) { Text("Repeating weekdays").tag("weekly"); Text("One time").tag("one_off") }
                    if scheduleType == "one_off" {
                        DatePicker("On", selection: $scheduledDate, displayedComponents: .date).environment(\.timeZone, model.zone)
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 64))], spacing: 12) {
                            ForEach(0..<7) { day in
                                Button { if days.contains(day) { days.remove(day) } else { days.insert(day) } } label: {
                                    Text(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44).background(days.contains(day) ? Brand.lime : Brand.background, in: RoundedRectangle(cornerRadius: 10)).foregroundStyle(Brand.ink)
                                }.buttonStyle(.plain).accessibilityAddTraits(days.contains(day) ? .isSelected : [])
                            }
                        }
                        if days.isEmpty { Text("Choose at least one day.").font(.caption).foregroundStyle(Brand.red) }
                    }
                }
                Section {
                    Toggle("Set a deadline", isOn: $hasDeadline)
                    if hasDeadline {
                        DatePicker("Due by", selection: $dueDate, displayedComponents: .hourAndMinute).environment(\.timeZone, model.zone)
                        Stepper("Remind \(reminder) minutes before", value: $reminder, in: 0...1440, step: 5)
                    }
                } header: { Text("Timing") } footer: { Text("Dates and deadlines follow \(model.session?.household.timezone ?? "the household timezone"), even when a phone travels.") }
                Section("Instructions") { TextField("Explain what a good job looks like", text: $instructions, axis: .vertical).lineLimit(3...8) }
                Section {
                    ForEach($subtasks) { $step in
                        HStack {
                            TextField("Step", text: $step.title)
                            Button(role: .destructive) { subtasks.removeAll { $0.id == step.id } } label: { Image(systemName: "minus.circle").frame(width: 44, height: 44) }.accessibilityLabel("Remove step")
                        }
                    }
                    Button("Add a step") { subtasks.append(ChoreStep(title: "")) }.disabled(subtasks.count >= 20)
                } header: { Text("Checklist") } footer: { Text("Up to 20 steps, each at most 160 characters.") }
                Section { Text("Changes apply to newly generated days. Today's saved chores keep their instructions, assignment, and approval rules.").font(.footnote).foregroundStyle(Brand.muted) }
                if let saveMessage { Section { Text(saveMessage).font(.subheadline).foregroundStyle(Brand.red) } }
                if routine != nil { Section { Button("Delete routine", role: .destructive) { confirmDelete = true }.disabled(saving || !model.canChange) } }
            }.navigationTitle(routine == nil ? "Add a chore" : "Edit routine").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) { Button { Task { await save() } } label: { if saving { ProgressView() } else { Text("Save").bold() } }.disabled(!valid || saving || saveBlocked || !model.canChange) }
                }
                .task {
                    dueDate = Dates.wallTime(routine?.dueTime ?? "18:00", on: model.today, in: model.zone) ?? Date()
                    scheduledDate = Dates.wallTime("12:00", on: routine?.scheduledDate ?? model.today, in: model.zone) ?? Date()
                }
                .confirmationDialog("Delete this routine?", isPresented: $confirmDelete, titleVisibility: .visible) {
                    Button("Delete routine", role: .destructive) { Task { saving = true; if let routine, await model.deleteRoutine(routine) { dismiss() }; saving = false } }
                    Button("Cancel", role: .cancel) { }
                } message: { Text("Saved daily chores and history remain. No new days will be generated from this routine.") }
        }.interactiveDismissDisabled(saving)
    }
    private var valid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.count <= 100 && instructions.count <= 3000 && (scheduleType == "one_off" || !days.isEmpty) && subtasks.allSatisfy { !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.title.count <= 160 }
    }
    private func save() async {
        saving = true; defer { saving = false }
        var draft = ChoreDraft(title: title.trimmingCharacters(in: .whitespacesAndNewlines), personId: personID.isEmpty ? nil : personID, weekdays: scheduleType == "one_off" ? Array(0...6) : days.sorted(), dueTime: hasDeadline ? Dates.wallTimeString(dueDate, in: model.zone) : nil, reminderMinutes: reminder, expectedVersion: routine?.version)
        draft.required = required; draft.requiresApproval = requiresApproval; draft.instructions = instructions
        draft.subtasks = subtasks; draft.scheduleType = scheduleType; draft.scheduledDate = scheduleType == "one_off" ? Dates.day(scheduledDate, in: model.zone) : nil
        if await model.saveChore(draft, id: routine?.id) { dismiss() }
        else { saveBlocked = model.lastMutationNeedsReview; saveMessage = model.message }
    }
}

struct SettingsScreen: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var notifications = NotificationController.shared
    @State private var confirmSignOut = false
    @State private var signingOut = false
    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    BrandMark()
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.session?.user.name ?? "Family member").font(.headline)
                        Text(model.session?.isChild == true ? "Child account" : model.isAdmin ? "Parent administrator" : "Family member").font(.caption).foregroundStyle(Brand.muted)
                        Text(model.session?.household.title ?? "").font(.subheadline).foregroundStyle(Brand.muted)
                    }
                }.padding(.vertical, 10)
            }
            Section {
                HStack { Text("iOS notifications"); Spacer(); Text(notifications.permissionDescription).font(.subheadline).foregroundStyle(Brand.muted).multilineTextAlignment(.trailing) }
                if notifications.authorizationStatus == .notDetermined {
                    Button("Enable notifications") { Task { await notifications.requestPermission() } }
                } else if notifications.authorizationStatus == .denied {
                    Button("Open notification settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                }
                if let prefs = model.preferences { NavigationLink("Choose notifications and quiet hours") { NotificationPreferencesScreen(initial: prefs) } }
                else { Button("Load notification preferences") { Task { await model.refresh(includePreferences: true, includeStatus: true) } }.disabled(model.isLoading) }
                if let server = model.deliveryStatus {
                    Label(server.pushConfigured ? "Apple push service configured" : "Push delivery awaits Apple developer configuration", systemImage: server.pushConfigured ? "checkmark.shield" : "clock").font(.caption).foregroundStyle(server.pushConfigured ? Brand.cyanInk : Brand.muted)
                    if !server.schedulingConfigured { Text("Scheduled reminders await server scheduling configuration.").font(.caption).foregroundStyle(Brand.muted) }
                } else { Text("Push service readiness has not been verified. Refresh while online.").font(.caption).foregroundStyle(Brand.muted) }
                if let status = notifications.registrationMessage { Text(status).font(.caption).foregroundStyle(Brand.muted) }
            } header: { Text("Notifications") } footer: {
                Text("Push notifications use private lock-screen messages. Open the app to see details. iOS notification settings, Focus, network access, and quiet hours can affect when alerts appear.")
            }
            if model.isAdmin {
                Section("Family access") {
                    NavigationLink("Invite a child account") { ChildInvitationScreen() }
                    NavigationLink("Caregiver permissions") { CaregiverAccessScreen() }
                    NavigationLink("Signed-in phones and tablets") { MobileDevicesScreen() }
                    Link("Parent invitations and frame setup", destination: APIClient.configuredURL)
                }
            }
            if model.canManageChores { Section("Chore routines") { NavigationLink("Holidays and chore breaks") { ChoreBreaksScreen() } } }
            if model.canManageInternet || model.session?.isChild == true { Section("Shared frame") { NavigationLink("Create a frame unlock code") { FrameAccessScreen() } } }
            Section("Your household") {
                LabeledContent("Timezone", value: model.session?.household.timezone ?? "")
                if let last = model.lastUpdated { LabeledContent("Last refreshed", value: last.formatted(date: .abbreviated, time: .shortened)) }
                Button("Refresh current data") { Task { await model.refresh(includePreferences: true, includeStatus: true) } }.disabled(model.isLoading)
                if model.isStale { Text("An offline copy is visible. Changes stay paused until a successful refresh.").font(.caption).foregroundStyle(.orange) }
            }
            Section {
                Button(role: .destructive) { confirmSignOut = true } label: { if signingOut { ProgressView() } else { Text("Sign out this device") } }.disabled(signingOut)
            } footer: { Text("Signing out requests server revocation and removes this app's saved session and household cache.") }
            Section { Text("Family Frame · \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")").font(.caption).foregroundStyle(Brand.muted) }
        }.navigationTitle("Settings").scrollContentBackground(.hidden).background(Brand.background)
            .task { await notifications.refreshStatus() }
            .confirmationDialog("Sign out this device?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { signingOut = true; await model.signOut(); signingOut = false } }
                Button("Cancel", role: .cancel) { }
            }
    }
}

struct NotificationPreferencesScreen: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var value: NotificationPreferences
    @State private var quiet: Bool
    @State private var start: Date
    @State private var end: Date
    @State private var saving = false
    init(initial: NotificationPreferences) {
        _value = State(initialValue: initial); _quiet = State(initialValue: initial.quietStart != nil && initial.quietEnd != nil)
        let zone = TimeZone(identifier: initial.timezone) ?? TimeZone(secondsFromGMT: 0)!
        let day = Dates.day(in: zone)
        _start = State(initialValue: Dates.wallTime(initial.quietStart ?? "21:00", on: day, in: zone) ?? Date())
        _end = State(initialValue: Dates.wallTime(initial.quietEnd ?? "07:00", on: day, in: zone) ?? Date())
    }
    var body: some View {
        Form {
            Section { Toggle("Send push notifications", isOn: $value.pushEnabled) }
            Section("Chores") {
                Toggle("Marked complete", isOn: $value.choreCompleted)
                Toggle("Reopened", isOn: $value.choreReopened)
                Toggle("Due soon", isOn: $value.choreDueSoon)
                Toggle("Overdue", isOn: $value.choreOverdue)
            }
            Section("Internet time") {
                Toggle("Earned rewards", isOn: $value.rewards)
                Toggle("Session updates and warnings", isOn: $value.internetSessions)
            }
            if model.canViewChildSettings {
                Section("Around the house") {
                    Toggle("Calendar reminders", isOn: $value.calendarEvents)
                    Toggle("Frame offline / reconnected", isOn: $value.frameStatus)
                }
            }
            Section {
                Toggle("Enable quiet hours", isOn: $quiet)
                if quiet {
                    DatePicker("Start", selection: $start, displayedComponents: .hourAndMinute).environment(\.timeZone, model.zone)
                    DatePicker("End", selection: $end, displayedComponents: .hourAndMinute).environment(\.timeZone, model.zone)
                    if !valid { Text("Choose different start and end times.").font(.caption).foregroundStyle(Brand.red) }
                }
            } header: { Text("Quiet hours") } footer: { Text("Quiet hours use \(value.timezone). Your Activity inbox remains available.") }
        }.navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button { Task { saving = true; value.quietStart = quiet ? Dates.wallTimeString(start, in: model.zone) : nil; value.quietEnd = quiet ? Dates.wallTimeString(end, in: model.zone) : nil; if await model.savePreferences(value) { dismiss() }; saving = false } } label: { if saving { ProgressView() } else { Text("Save").bold() } }.disabled(!valid || saving || model.isStale) } }
    }
    private var valid: Bool { !quiet || Dates.wallTimeString(start, in: model.zone) != Dates.wallTimeString(end, in: model.zone) }
}

struct ChildInvitationScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var personID = ""
    @State private var email = ""
    @State private var result: ChildInvitation?
    @State private var generating = false
    @State private var error: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                FrameCard(accent: Brand.magenta) {
                    Text("Their account. Their chores.").font(.title2.bold())
                    Text("Choose a child profile and enter that child's real email. They create or sign into their own account, confirm their email, then accept this invitation. The server links them only to the chosen profile.").font(.subheadline).foregroundStyle(Brand.muted)
                    Picker("Child profile", selection: $personID) {
                        Text("Choose a person").tag("")
                        ForEach(model.snapshot?.people ?? []) { person in Text(person.name).tag(person.id) }
                    }.pickerStyle(.menu)
                    TextField("Child's email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.emailAddress).textFieldStyle(.roundedBorder).accessibilityLabel("Invited child's email")
                    Button { Task { await generate() } } label: { if generating { ProgressView().tint(.white) } else { Text("Create child invitation") } }.buttonStyle(PrimaryButton()).disabled(personID.isEmpty || !email.contains("@") || generating || model.isStale)
                }
                if let result {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        let valid = (Dates.instant(result.expiresAt) ?? .distantPast) > context.date
                        FrameCard(accent: Brand.lime) {
                            Text(valid ? "Share privately with your child" : "This invitation has expired").font(.headline)
                            Text(result.email).font(.subheadline.weight(.semibold)).textSelection(.enabled)
                            if valid {
                                Text(result.token).font(.caption.monospaced()).textSelection(.enabled).privacySensitive()
                                ShareLink(item: invitationMessage(result)) { Label("Share invitation", systemImage: "square.and.arrow.up") }.font(.headline)
                                Text("One use. Expires \(Dates.relative(result.expiresAt)). The child must confirm this same email; possession of the token alone does not grant access.").font(.caption).foregroundStyle(Brand.muted)
                            } else { Text("Create a new invitation to connect the account.").font(.caption).foregroundStyle(Brand.muted) }
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(Brand.red).font(.subheadline) }
            }.padding(20).frame(maxWidth: 650).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("Invite a child account").navigationBarTitleDisplayMode(.inline)
            .onChange(of: personID) { _, _ in result = nil }.onChange(of: email) { _, _ in result = nil }
    }
    private func invitationMessage(_ invitation: ChildInvitation) -> String {
        "Join our Family Frame household using your own account with \(invitation.email). Create an account in the Family Frame iPhone/iPad app, confirm your email, and paste this family invitation token: \(invitation.token). The invitation expires \(Dates.relative(invitation.expiresAt))."
    }
    private func generate() async {
        guard let person = model.snapshot?.people.first(where: { $0.id == personID }) else { return }
        generating = true; error = nil; defer { generating = false }
        do { result = try await model.inviteChild(person, email: email) } catch { self.error = error.localizedDescription }
    }
}

struct MobileDevicesScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var devices: [MobileDevice] = []
    @State private var error: String?
    @State private var loading = false
    @State private var revokeID: String?
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(Brand.red) }
            if loading && devices.isEmpty { ProgressView("Loading devices…") }
            ForEach(devices) { device in
                VStack(alignment: .leading, spacing: 8) {
                    Text(device.label ?? "Family device").font(.headline)
                    if let personID = device.personId, let person = model.snapshot?.people.first(where: { $0.id == personID }) { Text(person.name).font(.subheadline) }
                    Text("Last active \(Dates.relative(device.lastSeenAt))").font(.caption).foregroundStyle(Brand.muted)
                    if device.revokedAt != nil { Text("Access revoked").font(.caption).foregroundStyle(Brand.muted) }
                    else { Button("Revoke access", role: .destructive) { revokeID = device.id }.font(.subheadline).disabled(loading) }
                }.padding(.vertical, 6)
            }
            if !loading && devices.isEmpty && error == nil { Text("No mobile devices are registered.").foregroundStyle(Brand.muted) }
        }.navigationTitle("Mobile devices").task { await load() }.refreshable { await load() }
            .confirmationDialog("Revoke this device's Family Frame access?", isPresented: Binding(get: { revokeID != nil }, set: { if !$0 { revokeID = nil } }), titleVisibility: .visible) {
                Button("Revoke access", role: .destructive) { if let id = revokeID { Task { do { try await model.revoke(id); revokeID = nil; await load() } catch { self.error = error.localizedDescription } } } }
                Button("Cancel", role: .cancel) { revokeID = nil }
            }
    }
    private func load() async {
        loading = true; defer { loading = false }
        do { devices = try await model.devices(); error = nil } catch { self.error = error.localizedDescription }
    }
}
