import SwiftUI

struct RewardDevicePicker: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var network: InternetModel
    let credit: RewardCredit
    @State private var selected = ""
    @State private var starting = false
    @State private var review = false
    var body: some View {
        NavigationStack {
            List {
                Section { Text("Choose one device for your \(credit.minutes)-minute reward.").font(.headline); Text("Your other devices keep their default Internet block.").font(.subheadline).foregroundStyle(Brand.muted) }
                if !network.integrationReady { Section { Text(network.snapshot?.integration.detail ?? "Network setup is not complete.").foregroundStyle(Brand.muted) } }
                ForEach(network.rewardDevices(for: credit.personId)) { device in
                    let available = network.deviceAvailable(device, for: credit.personId)
                    Button { selected = device.id } label: {
                        HStack(spacing: 12) {
                            Image(systemName: device.symbol).frame(width: 28).foregroundStyle(Brand.cyanInk)
                            VStack(alignment: .leading, spacing: 5) { Text(device.name).font(.headline); if !available { Text(device.isReady ? "A session is already using this child or device" : device.controlLabel).font(.caption).foregroundStyle(Brand.muted) } }
                            Spacer(); Image(systemName: selected == device.id ? "checkmark.circle.fill" : "circle").foregroundStyle(Brand.cyanInk)
                        }.foregroundStyle(Brand.ink).frame(minHeight: 44)
                    }.disabled(!available || starting).accessibilityAddTraits(selected == device.id ? .isSelected : [])
                }
                if network.rewardDevices(for: credit.personId).isEmpty { Text("No earned-time devices are currently blocked and available. Your reward stays saved; try again when a device is free.").foregroundStyle(Brand.muted) }
                if let message = network.message { Text(message).foregroundStyle(Brand.red) }
                if review { Text("Close this picker, refresh Devices and review your reward and any session before trying again.").foregroundStyle(Brand.red) }
                Section {
                    Button { Task { await start() } } label: { if starting { ProgressView("Requesting Internet time…") } else { Text("Start my Internet time").font(.headline) } }.frame(minHeight: 44).disabled(!network.canChange || !network.integrationReady || selected.isEmpty || starting || review || !network.availableCredits.contains(where: { $0.id == credit.id }))
                } footer: { Text("Access is requested first, then confirmed by the home network. Your reward is not available for another device while a session is being checked.") }
            }.navigationTitle("Pick your device").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Later") { dismiss() }.disabled(starting) } }
        }.interactiveDismissDisabled(starting)
    }
    private func start() async {
        guard let device = network.devices.first(where: { $0.id == selected }) else { return }
        starting = true; let success = await network.redeem(credit, device: device); starting = false
        if success { dismiss() } else { review = network.mutationNeedsReview }
    }
}

struct InternetGrantEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var network: InternetModel
    let device: ManagedInternetDevice
    @State private var personID = ""
    @State private var minutes = 60
    @State private var allDay = false
    @State private var reason = ""
    @State private var saving = false
    @State private var review = false
    var body: some View {
        NavigationStack {
            Form {
                Section(device.name) {
                    Picker("For", selection: $personID) { Text("Choose a child").tag(""); ForEach((model.snapshot?.people ?? []).filter { device.personIds.contains($0.id) }) { Text($0.name).tag($0.id) } }
                    Toggle("All day until midnight", isOn: $allDay)
                    if !allDay { Stepper("\(minutes) minutes", value: $minutes, in: 1...1439, step: 5) }
                }
                Section { TextField("Optional reason", text: $reason, axis: .vertical).lineLimit(2...5) }
                Section { Text(allDay ? "This allowance ends at the next midnight in \(model.session?.household.timezone ?? "your household timezone"). It does not use a task reward." : "A parent allowance does not spend a task reward. It can be paused, ended or adjusted after the network confirms it.").font(.footnote).foregroundStyle(Brand.muted) }
                if let message = network.message { Text(message).foregroundStyle(Brand.red) }
                if review { Text("Close and refresh Devices to review the outcome before making another allowance.").foregroundStyle(Brand.red) }
            }.navigationTitle("Allow Internet time").navigationBarTitleDisplayMode(.inline)
                .onAppear { if device.personIds.count == 1 { personID = device.personIds[0] } }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) { Button { Task {
                        saving = true; let success = await network.grant(personID: personID, device: device, minutes: minutes, allDay: allDay, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)); saving = false
                        if success { dismiss() } else { review = network.mutationNeedsReview }
                    } } label: { if saving { ProgressView() } else { Text("Allow").bold() } }.disabled(saving || review || reason.count > 500 || !network.canChange || !network.canManage || !network.integrationReady || personID.isEmpty || !network.deviceAvailable(device, for: personID)) }
                }
        }.interactiveDismissDisabled(saving)
    }
}

struct InternetTimeEditor: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var network: InternetModel
    let session: InternetSession
    @State private var remove = false
    @State private var minutes = 15
    @State private var reason = ""
    @State private var saving = false
    @State private var review = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Change", selection: $remove) { Text("Add time").tag(false); Text("Remove time").tag(true) }.pickerStyle(.segmented)
                    Stepper("\(minutes) minutes", value: $minutes, in: 1...1439, step: 5)
                    TextField("Optional reason", text: $reason, axis: .vertical).lineLimit(2...5)
                } footer: { Text("Removing all remaining time ends the session. A timed session must remain shorter than 24 hours. A time change converts an all-day session into a timed window.") }
                if let message = network.message { Text(message).foregroundStyle(Brand.red) }
                if review { Text("Close and review current session status before another change.").foregroundStyle(Brand.red) }
            }.navigationTitle("Adjust session time").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) { Button { Task {
                        saving = true; let success = await network.act(session, action: "adjust", deltaMinutes: remove ? -minutes : minutes, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)); saving = false
                        if success { dismiss() } else { review = network.mutationNeedsReview }
                    } } label: { if saving { ProgressView() } else { Text("Save").bold() } }.disabled(saving || review || !network.canChange || !network.canManage || !network.currentSession(session).isStable || reason.count > 500) }
                }
        }.interactiveDismissDisabled(saving)
    }
}

struct ManagedDeviceDetail: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var network: InternetModel
    let original: ManagedInternetDevice
    @State private var editing = false
    @State private var granting = false
    var body: some View {
        let device = network.devices.first(where: { $0.id == original.id }) ?? original
        List {
            Section {
                Label(device.name, systemImage: device.symbol).font(.title2.bold())
                Text(device.controlLabel).font(.headline).foregroundStyle(Brand.cyanInk)
                Text(device.personIds.map { id in model.snapshot?.people.first(where: { $0.id == id })?.name ?? "Family member" }.joined(separator: " · "))
                if let last = device.lastSeenAt { Text("Last seen \(Dates.relative(last))").font(.caption).foregroundStyle(Brand.muted) }
            }
            if let addresses = device.macAddresses, network.canManage { Section("Device addresses") { ForEach(addresses, id: \.self) { Text($0).font(.body.monospaced()).textSelection(.enabled) } } }
            ForEach(network.liveSessions.filter { $0.deviceId == device.id }) { session in
                NavigationLink { InternetSessionDetail(network: network, original: session) } label: { Text("Current session · \(session.statusLabel(at: network.serverNow))") }
            }
            if network.canManage {
                Section {
                    Button("Allow Internet time") { granting = true }.disabled(!network.canChange || !network.integrationReady || !device.isReady || network.liveSessions.contains { $0.deviceId == device.id })
                    if device.controlState == "unenrolled" { Button("Edit name, assignment and addresses") { editing = true }.disabled(!network.canChange) }
                    else { Text("To change this device's identity or assignment, a parent must first remove its network enrollment and verify its blocking rules.").font(.footnote).foregroundStyle(Brand.muted) }
                }
            }
            Section { Text("The home network controls this device by its saved addresses. Being connected to Wi-Fi does not mean Internet access is allowed.").font(.footnote).foregroundStyle(Brand.muted) }
        }.navigationTitle("Device").navigationBarTitleDisplayMode(.inline).refreshable { await network.refresh() }
            .sheet(isPresented: $editing) { ManagedDeviceEditor(network: network, device: device) }
            .sheet(isPresented: $granting) { InternetGrantEditor(network: network, device: device) }
    }
}

struct ManagedDeviceEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var network: InternetModel
    let device: ManagedInternetDevice?
    @State private var name: String
    @State private var kind: String
    @State private var people: Set<String>
    @State private var addresses: String
    @State private var defaultAccess: String
    @State private var allowApplePush: Bool
    @State private var saving = false
    @State private var review = false
    @State private var removing = false
    init(network: InternetModel, device: ManagedInternetDevice?) {
        self.network = network; self.device = device
        _name = State(initialValue: device?.name ?? ""); _kind = State(initialValue: device?.kind ?? "console")
        _people = State(initialValue: Set(device?.personIds ?? [])); _addresses = State(initialValue: device?.macAddresses?.joined(separator: "\n") ?? "")
        _defaultAccess = State(initialValue: device?.defaultAccess ?? "blocked")
        _allowApplePush = State(initialValue: device?.allowApplePush ?? ["tablet", "phone"].contains(device?.kind ?? "console"))
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Device") {
                    TextField("PS5, Switch 2, iPad…", text: $name).textInputAutocapitalization(.words)
                    Picker("Type", selection: $kind) { Text("Console").tag("console"); Text("Tablet").tag("tablet"); Text("Phone").tag("phone"); Text("Computer").tag("computer"); Text("TV").tag("tv"); Text("Other").tag("other") }
                }
                Section {
                    Picker("Default Internet", selection: $defaultAccess) { Text("Blocked · kids earn time").tag("blocked"); Text("Allowed · parent control").tag("allowed") }
                } footer: { Text("Only blocked-by-default devices enter the earned-time pool. Parent on/off controls work independently of tasks.") }
                Section("Assigned children") {
                    ForEach(model.snapshot?.people ?? []) { person in
                        Toggle(person.name, isOn: Binding(get: { people.contains(person.id) }, set: { enabled in if enabled { people.insert(person.id) } else { people.remove(person.id) } }))
                    }
                }
                if ["tablet", "phone"].contains(kind) {
                    Section { Toggle("Keep Apple notifications available", isOn: $allowApplePush) } footer: { Text("Allows Apple's notification transport while general Internet access is blocked. This transport is shared by installed apps; it does not grant general web access.") }
                }
                Section {
                    TextField("aa:bb:cc:dd:ee:ff", text: $addresses, axis: .vertical).lineLimit(3...9).font(.body.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if !addresses.isEmpty && !validMACs { Text("Enter 1–8 device addresses, one per line, using six pairs of hexadecimal digits.").font(.caption).foregroundStyle(Brand.red) }
                } header: { Text("Wi-Fi / Ethernet addresses") } footer: { Text("Use the device's fixed addresses. A private/randomized Wi-Fi address can change which device the network controls. Saving here does not enroll or block the device; network checks come next.") }
                if let message = network.message { Text(message).foregroundStyle(Brand.red) }
                if review { Text("Close and refresh the device list to review whether the change was saved.").foregroundStyle(Brand.red) }
                if device != nil { Section { Button("Remove device", role: .destructive) { removing = true }.disabled(saving || review || !network.canChange) } }
            }.navigationTitle(device == nil ? "Add device" : "Edit device").navigationBarTitleDisplayMode(.inline)
                .onAppear { if device == nil && people.isEmpty { people = Set((model.snapshot?.people ?? []).map(\.id)) } }
                .onChange(of: kind) { _, value in if device == nil { allowApplePush = ["tablet", "phone"].contains(value) } }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) { Button { Task { await save() } } label: { if saving { ProgressView() } else { Text("Save").bold() } }.disabled(saving || review || !validMACs || people.isEmpty || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 80 || !network.canChange || !network.canManage) }
                }
                .confirmationDialog("Remove this unenrolled device?", isPresented: $removing, titleVisibility: .visible) { Button("Remove device", role: .destructive) { Task { saving = true; if let device, await network.deleteDevice(device) { dismiss() } else { review = network.mutationNeedsReview }; saving = false } }; Button("Cancel", role: .cancel) { } }
        }.interactiveDismissDisabled(saving)
    }
    private var macs: [String] { addresses.split(whereSeparator: { $0.isWhitespace || $0 == "," }).map { String($0).lowercased().replacingOccurrences(of: "-", with: ":") } }
    private var validMACs: Bool { (1...8).contains(macs.count) && Set(macs).count == macs.count && macs.allSatisfy { $0.range(of: "^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$", options: .regularExpression) != nil } }
    private func save() async {
        saving = true; var draft = ManagedDeviceDraft(name: name.trimmingCharacters(in: .whitespacesAndNewlines), kind: kind, personIds: people.sorted(), macAddresses: macs.sorted(), mutationId: UUID().uuidString.lowercased(), expectedVersion: device?.version)
        draft.defaultAccess = defaultAccess
        draft.allowApplePush = ["tablet", "phone"].contains(kind) && allowApplePush
        let success = await network.saveDevice(draft, id: device?.id); saving = false
        if success { dismiss() } else { review = network.mutationNeedsReview }
    }
}

struct RewardPolicyEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var network: InternetModel
    let policy: RewardPolicy
    @State private var enabled: Bool
    @State private var reward: Int
    @State private var carryover: Int
    @State private var limit: Int
    @State private var warning: Int
    @State private var bedtime: Bool
    @State private var cutoff = Date()
    @State private var saving = false
    @State private var review = false
    init(network: InternetModel, policy: RewardPolicy) {
        self.network = network; self.policy = policy
        _enabled = State(initialValue: policy.enabled); _reward = State(initialValue: min(policy.rewardMinutes, 1439)); _carryover = State(initialValue: policy.carryoverDays)
        _limit = State(initialValue: policy.dailyLimitMinutes); _warning = State(initialValue: policy.warningMinutes); _bedtime = State(initialValue: policy.bedtime != nil)
    }
    var body: some View {
        Form {
            Section(model.snapshot?.people.first(where: { $0.id == policy.personId })?.name ?? "Child") {
                Toggle("Earn Internet rewards", isOn: $enabled)
                Stepper("\(reward) minutes per task day", value: $reward, in: 1...1439, step: 5)
                Stepper("Daily reward limit: \(limit) minutes", value: $limit, in: 1...1440, step: 5)
                Stepper(carryover == 0 ? "Use rewards on their earning day" : "Carry rewards for \(carryover) extra days", value: $carryover, in: 0...365)
                Stepper("Warn \(warning) minutes before ending", value: $warning, in: 0...60)
            }
            Section {
                Toggle("Bedtime cutoff", isOn: $bedtime)
                if bedtime { DatePicker("Reward access must end by", selection: $cutoff, displayedComponents: .hourAndMinute).environment(\.timeZone, model.zone) }
            } footer: { Text("Rewards must fit before bedtime and within the daily limit. Times follow \(model.session?.household.timezone ?? "your household timezone"). Parent allowances can override reward limits.") }
            Section { Text("Changes affect newly earned rewards and future redemptions. Existing credits keep their earned minutes and expiry; current sessions keep their existing window. An all-day exception is set per parent allowance.").font(.footnote).foregroundStyle(Brand.muted) }
            if let message = network.message { Text(message).foregroundStyle(Brand.red) }
            if review { Text("Close and refresh reward settings to review the saved policy before editing again.").foregroundStyle(Brand.red) }
        }.navigationTitle("Rewards and limits").navigationBarTitleDisplayMode(.inline)
            .task { cutoff = Dates.wallTime(policy.bedtime ?? "21:00", on: model.today, in: model.zone) ?? Date() }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button { Task {
                saving = true
                let draft = RewardPolicyDraft(expectedVersion: policy.version, rewardMinutes: reward, carryoverDays: carryover, dailyLimitMinutes: limit, bedtime: bedtime ? Dates.wallTimeString(cutoff, in: model.zone) : nil, warningMinutes: warning, enabled: enabled)
                if await network.savePolicy(policy, draft: draft) { dismiss() } else { review = network.mutationNeedsReview }; saving = false
            } } label: { if saving { ProgressView() } else { Text("Save").bold() } }.disabled(saving || review || !network.canChange || !network.canManage) } }
    }
}

struct CreditReviewScreen: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var network: InternetModel
    let credit: RewardCredit
    @State private var action = "restore"
    @State private var reason = ""
    @State private var saving = false
    @State private var review = false
    var body: some View {
        Form {
            Section { Text("The network could not confirm whether this \(credit.minutes)-minute reward started before the session ended. Review the session and network history before deciding.").font(.subheadline) }
            Section {
                Picker("Decision", selection: $action) { Text("Restore reward").tag("restore"); Text("Mark reward used").tag("consume") }
                TextField("Required reason", text: $reason, axis: .vertical).lineLimit(3...6)
            }
            if let message = network.message { Text(message).foregroundStyle(Brand.red) }
            if review { Text("Close and refresh Devices to review this reward's current status.").foregroundStyle(Brand.red) }
            Button { Task { saving = true; if await network.resolve(credit, action: action, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)) { dismiss() } else { review = network.mutationNeedsReview }; saving = false } } label: { if saving { ProgressView() } else { Text("Record parent decision").font(.headline) } }.frame(minHeight: 44).disabled(saving || review || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reason.count > 500 || !network.canChange || !network.canManage)
        }.navigationTitle("Review reward").navigationBarTitleDisplayMode(.inline)
    }
}
