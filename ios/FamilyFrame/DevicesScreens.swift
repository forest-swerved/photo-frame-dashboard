import SwiftUI

// Keep the reward choice visible even when the last chore was near the end of
// a long list. This observes the reward store independently of household reads.
struct RewardAwareScroll<Content: View>: View {
    @ObservedObject var network: InternetModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ViewBuilder let content: Content
    var body: some View {
        ScrollViewReader { reader in
            ScrollView { content }
                .onChange(of: network.earnedReward?.id) { _, id in
                    guard id != nil else { return }
                    Task { @MainActor in await Task.yield(); withAnimation(reduceMotion ? nil : .default) { reader.scrollTo("earned-reward", anchor: .top) } }
                }
        }
    }
}

struct DevicesScreen: View {
    @EnvironmentObject var model: AppModel
    var body: some View { DevicesContent(network: model.internet) }
}

struct InternetHomeSessions: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var network: InternetModel
    var body: some View {
        if !network.liveSessions.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text("Internet time").font(.title2.bold()).accessibilityAddTraits(.isHeader); Spacer(); Button("Devices") { model.selectedTab = 3 }.frame(minHeight: 44) }
                ForEach(network.liveSessions) { HomeInternetSession(network: network, original: $0) }
                if network.isStale { Text("Last known status · refresh Devices to confirm current access.").font(.caption).foregroundStyle(Brand.red) }
            }
        }
    }
}

private struct DevicesContent: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var phase
    @ObservedObject var network: InternetModel
    @State private var adding = false
    @State private var requestDevice: ManagedInternetDevice?
    @State private var grantDevice: ManagedInternetDevice?
    @State private var pickedCredit: RewardCredit?
    var body: some View {
        ScrollView {
            LazyVStack(spacing: 18) {
                NetworkStatusCard(network: network)
                if !network.accessRequests.isEmpty { accessRequests }
                RewardHomeCard(network: network)
                VStack(alignment: .leading, spacing: 14) {
                    HStack { Text("Devices").font(.title2.bold()).accessibilityAddTraits(.isHeader); Spacer(); if network.canManage { Button { adding = true } label: { Label("Add device", systemImage: "plus").frame(minHeight: 44) }.disabled(!network.canChange) } }
                    if network.devices.isEmpty && network.snapshot != nil {
                        FrameCard(accent: Brand.cyan) { EmptyState(symbol: "gamecontroller", title: "No devices added yet", detail: network.canManage ? "Add each child's console, tablet or computer, then complete its network checks." : "A parent can add devices to your profile.") }
                    }
                    ForEach(network.devices) { device in
                        FrameCard(accent: device.isReady ? Brand.cyan : Brand.magenta) {
                            NavigationLink { ManagedDeviceDetail(network: network, original: device) } label: {
                                HStack(alignment: .top, spacing: 14) {
                                    DeviceArtwork(device: device)
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(device.name).font(.headline).foregroundStyle(Brand.ink)

                                        Text(network.internetIsOn(device) && device.observedAccess != "allowed" && device.accessPending != true ? "Internet time in progress" : device.controlLabel).font(.subheadline).foregroundStyle(Brand.muted)
                                        Text(device.personIds.map(personName).joined(separator: " · ")).font(.caption).foregroundStyle(Brand.cyanInk)
                                        if let online = device.online { Text(online ? "Connected to the home network" : "Not currently seen on the home network").font(.caption).foregroundStyle(Brand.muted) }
                                    }; Spacer(minLength: 0); Image(systemName: "chevron.right").font(.caption).foregroundStyle(Brand.muted)
                                }.frame(minHeight: 44)
                            }.buttonStyle(.plain)
                            ForEach(network.liveSessions.filter { $0.deviceId == device.id }) { session in
                                EmbeddedInternetSession(network: network, original: session)
                            }
                            if network.isChild {
                                Button("Request device time") { requestDevice = device }.font(.headline).frame(minHeight: 44)
                                    .disabled(!network.canChange || network.accessRequests.contains { $0.deviceId == device.id && network.requestIsPending($0) })
                            }
                            if network.canManage {
                                Button(network.internetIsOn(device) ? "Turn Internet off" : "Turn Internet on") { Task { _ = await network.controlDevice(device) } }
                                    .font(.headline).frame(minHeight: 44).disabled(!network.canChange || !network.integrationReady || !device.isReady || device.accessPending == true && device.desiredAccess != "allowed")
                                Button("Allow Internet time") { grantDevice = device }.font(.headline).frame(minHeight: 44)
                                    .disabled(!network.canChange || !network.integrationReady || !device.isReady || !device.isBlocked || network.liveSessions.contains { $0.deviceId == device.id })
                                Text("The on/off switch stays set until you change it. A timed allowance ends automatically.").font(.caption).foregroundStyle(Brand.muted)
                            }
                        }
                    }
                }
                if network.isChild { rewards }
                let orphanSessions = network.liveSessions.filter { session in !network.devices.contains { $0.id == session.deviceId } }
                ForEach(orphanSessions) { InternetSessionCard(network: network, original: $0) }
                if network.canManage { parentPolicies }
                NavigationLink { InternetHistoryScreen(network: network) } label: { Label("Internet activity and history", systemImage: "clock.arrow.circlepath").font(.headline).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading) }
            }.padding(20).frame(maxWidth: 1000).frame(maxWidth: .infinity)
        }.background(Brand.background).navigationTitle("Devices").refreshable { await network.refresh() }
            .task(id: phase) {
                guard phase == .active else { return }
                while !Task.isCancelled {
                    await network.refresh()
                    do { try await Task.sleep(for: .seconds(network.hasPendingNetworkWork ? 3 : 15)) } catch { break }
                }
            }
            .sheet(isPresented: $adding) { ManagedDeviceEditor(network: network, device: nil) }
            .sheet(item: $requestDevice) { DeviceAccessRequestEditor(network: network, device: $0) }
            .sheet(item: $grantDevice) { InternetGrantEditor(network: network, device: $0) }
            .sheet(item: $pickedCredit) { RewardDevicePicker(network: network, credit: $0) }
    }
    private var accessRequests: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(network.isChild ? "Your time requests" : "Device time requests").font(.title2.bold()).accessibilityAddTraits(.isHeader)
            ForEach(Array(network.accessRequests.prefix(20))) { item in
                FrameCard(accent: Brand.cyan) {
                    Text("\(personName(item.personId)) · \(network.devices.first(where: { $0.id == item.deviceId })?.name ?? "Device")").font(.headline)
                    Text("\(item.minutes) minutes · \(item.status == "pending" && !network.requestIsPending(item) ? "Expired" : item.status.capitalized)").font(.subheadline)
                    if let reason = item.reason { Text(reason).font(.subheadline).foregroundStyle(Brand.muted) }
                    if network.canManage && network.requestIsPending(item) {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 20) { requestActions(item) }
                            VStack(alignment: .leading) { requestActions(item) }
                        }
                    }
                    if item.status == "approved" { Text("Approved. Check the session above for confirmed device access.").font(.caption).foregroundStyle(Brand.muted) }
                }
            }
        }
    }
    @ViewBuilder private func requestActions(_ item: DeviceAccessRequest) -> some View {
        Button("Approve \(item.minutes) min") { Task { _ = await network.decideAccess(item, approve: true) } }
            .frame(minHeight: 44).disabled(!network.canChange || !network.integrationReady)
        Button("Decline", role: .destructive) { Task { _ = await network.decideAccess(item, approve: false) } }
            .frame(minHeight: 44).disabled(!network.canChange)
    }
    private var rewards: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Your saved rewards").font(.title2.bold()).accessibilityAddTraits(.isHeader)
            if network.availableCredits.isEmpty && network.snapshot != nil { Text("Finish your required tasks to earn Internet time. Tasks needing approval count after a parent approves them.").font(.subheadline).foregroundStyle(Brand.muted) }
            ForEach((network.snapshot?.credits ?? []).filter { $0.personId == network.personID && !["spent", "expired"].contains($0.status) }) { credit in
                FrameCard(accent: Brand.lime) {
                    Text("\(credit.minutes) minutes").font(.title2.bold())
                    Text(credit.statusLabel).font(.headline).foregroundStyle(Brand.cyanInk)
                    Text("Earned \(Dates.dayLabel(credit.earnedDate)) · expires \(Dates.relative(credit.expiresAt))").font(.caption).foregroundStyle(Brand.muted)
                    if credit.status == "available" {
                        Button("Use now") { pickedCredit = credit }.font(.headline).frame(minHeight: 44).disabled(!network.canChange || !network.integrationReady || !network.availableCredits.contains(where: { $0.id == credit.id }) || !network.rewardDevices(for: credit.personId).contains { network.deviceAvailable($0, for: credit.personId) })
                        RewardAvailabilityNote(network: network, credit: credit)
                    }
                    if credit.status == "review" { Text("A parent will review this reward because the network could not confirm whether access started. It will not be charged or restored automatically.").font(.subheadline).foregroundStyle(Brand.muted) }
                }
            }
        }
    }
    private var parentPolicies: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Rewards and limits").font(.title2.bold()).accessibilityAddTraits(.isHeader)
            ForEach(network.snapshot?.policies ?? []) { policy in
                NavigationLink { RewardPolicyEditor(network: network, policy: policy) } label: {
                    FrameCard(accent: Brand.lime) {
                        HStack { Text(personName(policy.personId)).font(.headline); Spacer(); Image(systemName: "chevron.right").font(.caption) }
                        Text(policy.enabled ? "\(policy.rewardMinutes) minutes per task day · \(policy.dailyLimitMinutes) minute daily reward limit" : "Earning rewards is paused").font(.subheadline)
                        if let bedtime = policy.bedtime { Text("Bedtime cutoff \(Dates.wallTime(bedtime, on: model.today, in: model.zone).map { Dates.time($0, in: model.zone) } ?? bedtime)").font(.caption) }
                    }.foregroundStyle(Brand.ink)
                }.buttonStyle(.plain)
            }
            let review = (network.snapshot?.credits ?? []).filter { $0.status == "review" }
            ForEach(review) { credit in
                NavigationLink { CreditReviewScreen(network: network, credit: credit) } label: {
                    FrameCard(accent: Brand.magenta) { Text("Reward needs review").font(.headline); Text("\(personName(credit.personId)) · \(credit.minutes) minutes").font(.subheadline); Text("Decide whether to restore or mark this reward used after reviewing network history.").font(.caption) }.foregroundStyle(Brand.ink)
                }.buttonStyle(.plain)
            }
        }
    }
    private func personName(_ id: String) -> String { model.snapshot?.people.first(where: { $0.id == id })?.name ?? "Family member" }
}

struct NetworkStatusCard: View {
    @ObservedObject var network: InternetModel
    var body: some View {
        if let snapshot = network.snapshot {
            if snapshot.integration.isReady && !network.isStale && network.message == nil && snapshot.integration.error == nil {
                DisclosureGroup("Home network connected") { Text("Controls apply to enrolled devices on your home network. Each device shows its confirmed access state.").font(.caption).foregroundStyle(Brand.muted) }.font(.subheadline).padding(16).background(.white, in: RoundedRectangle(cornerRadius: 12))
            } else {
            FrameCard(accent: snapshot.integration.isReady ? Brand.cyan : Brand.magenta) {
                Label(snapshot.integration.title, systemImage: snapshot.integration.isReady ? "network" : "network.slash").font(.headline)
                if !snapshot.integration.isReady { Text(snapshot.integration.detail).font(.subheadline).foregroundStyle(Brand.muted); Link("Open Family Frame network setup", destination: Brand.webSettings("frames")).font(.subheadline.weight(.semibold)).frame(minHeight: 44) }
                if let message = network.message { Text(message).font(.subheadline).foregroundStyle(Brand.red) }
                if let error = snapshot.integration.error { Text(error).font(.caption).foregroundStyle(Brand.red) }
                if network.isStale { Text("Last known status · controls paused").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.red) }
                if network.isStale || network.message != nil { Button("Refresh network status") { Task { await network.refresh() } }.frame(minHeight: 44).disabled(network.isLoading) }
                if network.isChanging { ProgressView("Requesting change…") }
            }
            }
        } else if network.isLoading { ProgressView("Loading Internet status…").frame(maxWidth: .infinity).padding() }
        else { FrameCard(accent: Brand.magenta) { Text(network.message ?? "Internet status is not available yet.").font(.subheadline); Button("Load network status") { Task { await network.refresh() } }.frame(minHeight: 44) } }
    }
}

struct RewardHomeCard: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var network: InternetModel
    @State private var selected: RewardCredit?
    var body: some View {
        if network.isChild, let reward = network.earnedReward, network.availableCredits.contains(where: { $0.id == reward.id }) {
            FrameCard(accent: Brand.lime) {
                Label("Great job!", systemImage: "star.circle.fill").font(.title2.bold()).foregroundStyle(Brand.ink)
                Text("Your required tasks earned \(reward.minutes) minutes of Internet time.").font(.headline)
                Text("Choose one of your devices now, or save this reward for later.").font(.subheadline).foregroundStyle(Brand.muted)
                Button("Use now") { selected = reward }.buttonStyle(PrimaryButton()).disabled(!network.canChange || !network.integrationReady || !network.rewardDevices(for: reward.personId).contains { network.deviceAvailable($0, for: reward.personId) })
                RewardAvailabilityNote(network: network, credit: reward)
                Button("Save for later") { network.earnedReward = nil }.font(.headline).frame(maxWidth: .infinity, minHeight: 44)
                if !network.integrationReady { Text("A parent needs to finish network setup before you can use this reward.").font(.caption).foregroundStyle(Brand.muted) }
            }.sheet(item: $selected) { RewardDevicePicker(network: network, credit: $0) }
        }
    }
}

struct InternetSessionCard: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var network: InternetModel
    let original: InternetSession
    @State private var details = false
    var body: some View {
        let item = network.currentSession(original)
        FrameCard(accent: item.hasVerifiedAccess ? Brand.lime : Brand.magenta) {
            Button { details = true } label: {
                VStack(alignment: .leading, spacing: 10) {
                    HStack { Text(personName(item.personId)).font(.headline); Spacer(); Image(systemName: "chevron.right").font(.caption) }
                    Text(deviceName(item.deviceId)).font(.title2.bold())
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        let now = network.serverNow
                        Text(item.statusLabel(at: now)).font(.subheadline.weight(.semibold)).foregroundStyle(item.hasVerifiedAccess ? Brand.cyanInk : Brand.magentaInk)
                        if !item.isTerminal {
                            Text(InternetSession.durationLabel(item.remaining(at: now))).font(.system(.largeTitle, design: .rounded).weight(.bold)).monospacedDigit().accessibilityLabel("\(item.remaining(at: now) / 60) minutes, \(item.remaining(at: now) % 60) seconds remaining")
                            Text(item.hasPendingWindow ? "Reserved time · start and end are not confirmed yet" : item.state == "paused" && !item.allDay ? "Paused time is saved; see the network status above." : item.allDay ? "All day · ends at household midnight" : "Time remaining in the scheduled window").font(.caption).foregroundStyle(Brand.muted)
                        }
                    }
                    if let end = item.endsAt.flatMap(Dates.instant), item.state != "paused" || item.allDay { Text("Ends \(Dates.time(end, in: model.zone)) · \(model.session?.household.timezone ?? "")").font(.caption).foregroundStyle(Brand.muted) }
                    if let error = item.lastError { Text(error).font(.caption).foregroundStyle(Brand.red) }
                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).foregroundStyle(Brand.ink).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHint("Opens session details and available controls")
            if network.canManage && !item.isTerminal {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 20) { quickControls(item) }
                    VStack(alignment: .leading, spacing: 8) { quickControls(item) }
                }
            }
        }.sheet(isPresented: $details) { NavigationStack { InternetSessionDetail(network: network, original: item) } }
    }
    @ViewBuilder private func quickControls(_ item: InternetSession) -> some View {
        if item.state == "active" { Button("Pause") { Task { _ = await network.act(item, action: "pause") } }.frame(minHeight: 44).disabled(!network.canChange) }
        if item.state == "paused" { Button("Resume") { Task { _ = await network.act(item, action: "resume") } }.frame(minHeight: 44).disabled(!network.canChange || item.remaining(at: network.serverNow) <= 0) }
        if item.isStable { Button("Add 15 min") { Task { _ = await network.act(item, action: "adjust", deltaMinutes: 15) } }.frame(minHeight: 44).disabled(!network.canChange) }
        Button("More controls") { details = true }.frame(minHeight: 44).disabled(!network.canChange)
    }
    private func personName(_ id: String) -> String { model.snapshot?.people.first(where: { $0.id == id })?.name ?? "Family member" }
    private func deviceName(_ id: String) -> String { network.devices.first(where: { $0.id == id })?.name ?? "Managed device" }
}

struct InternetSessionDetail: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var network: InternetModel
    let original: InternetSession
    @State private var adjustment = false
    @State private var endConfirmation = false
    @State private var allDayConfirmation = false
    var body: some View {
        let item = network.currentSession(original)
        List {
            Section {
                Text(network.devices.first(where: { $0.id == item.deviceId })?.name ?? "Managed device").font(.title2.bold())
                Text(model.snapshot?.people.first(where: { $0.id == item.personId })?.name ?? "Family member").font(.headline).foregroundStyle(Brand.cyanInk)
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text(item.statusLabel(at: network.serverNow)).font(.headline)
                    if !item.isTerminal { Text(InternetSession.durationLabel(item.remaining(at: network.serverNow))).font(.largeTitle.bold()).monospacedDigit() }
                    if item.hasPendingWindow { Text("Reserved time · the access window is not confirmed yet.").font(.caption).foregroundStyle(Brand.muted) }
                }
                Text(item.source == "reward" ? "Earned task reward" : "Parent allowance").font(.subheadline)
                if item.allDay { Text("All day, until household midnight. A paused all-day window still ends at its original midnight.").font(.caption).foregroundStyle(Brand.muted) }
            }
            Section("Times · \(model.session?.household.timezone ?? "household timezone")") {
                timestamp("Requested", item.requestedAt)
                timestamp("Started", item.startedAt)
                timestamp(item.state == "paused" && !item.allDay ? "Previous end" : "Scheduled end", item.endsAt)
                timestamp("Network last confirmed", item.verifiedAt)
                if item.endedAt != nil { timestamp("Ended", item.endedAt) }
            }
            if let reason = item.reason { Section("Reason") { Text(reason) } }
            if let error = item.lastError { Section("Network report") { Text(error).foregroundStyle(Brand.red) } }
            if let message = network.message { Section { Text(message).foregroundStyle(Brand.red) } }
            if network.canManage && !item.isTerminal {
                Section("Parent controls") {
                    if item.state == "active" { Button("Pause Internet access") { Task { _ = await network.act(item, action: "pause") } }.disabled(!network.canChange) }
                    if item.state == "paused" { Button("Resume remaining time") { Task { _ = await network.act(item, action: "resume") } }.disabled(!network.canChange || item.remaining(at: network.serverNow) <= 0) }
                    if item.isStable {
                        Button("Add or remove time") { adjustment = true }.disabled(!network.canChange)
                        if network.supportsAllDay { Button("Allow all day until midnight") { allDayConfirmation = true }.disabled(!network.canChange) }
                    }
                    Button("End session and block Internet", role: .destructive) { endConfirmation = true }.disabled(!network.canChange)
                }
            }
            Section { Text("The server and home network enforce this window. The countdown is informational. A pending change stays pending until the network confirms it.").font(.footnote).foregroundStyle(Brand.muted) }
        }.navigationTitle("Internet session").navigationBarTitleDisplayMode(.inline).refreshable { await network.refresh() }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $adjustment) { InternetTimeEditor(network: network, session: item) }
            .confirmationDialog("End this session?", isPresented: $endConfirmation, titleVisibility: .visible) { Button("End session", role: .destructive) { Task { _ = await network.act(item, action: "end") } }; Button("Cancel", role: .cancel) { } }
            .confirmationDialog("Allow this device until household midnight?", isPresented: $allDayConfirmation, titleVisibility: .visible) { Button("Allow all day") { Task { _ = await network.act(item, action: "all_day") } }; Button("Cancel", role: .cancel) { } }
    }
    @ViewBuilder private func timestamp(_ title: String, _ value: String?) -> some View {
        if let value, let date = Dates.instant(value) { LabeledContent(title, value: "\(Dates.dayLabel(Dates.day(date, in: model.zone))) · \(Dates.time(date, in: model.zone))") }
        else { LabeledContent(title, value: "Not confirmed") }
    }
}

struct InternetHistoryScreen: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var network: InternetModel
    @State private var items: [InternetHistoryItem] = []
    @State private var loading = false
    @State private var error: String?
    @State private var personID = ""
    @State private var period = 0
    private var filtered: [InternetHistoryItem] {
        items.filter { item in
            let date = Dates.instant(item.createdAt).map { Dates.day($0, in: model.zone) }
            return (personID.isEmpty || item.personId == personID) && (period == 0 || date.map { $0 >= Dates.shiftedDay(model.today, by: -period + 1) } == true)
        }
    }
    var body: some View {
        List {
            Section {
                Picker("Period", selection: $period) { Text("All recorded").tag(0); Text("7 days").tag(7); Text("30 days").tag(30); Text("90 days").tag(90) }
                if !network.isChild { Picker("Person", selection: $personID) { Text("Everyone").tag(""); ForEach(model.snapshot?.people ?? []) { Text($0.name).tag($0.id) } } }
            }
            if loading { ProgressView("Loading Internet history…") }
            if let error { Text(error).foregroundStyle(Brand.red) }
            if !loading && filtered.isEmpty && error == nil { Text("No Internet activity in this selection.").foregroundStyle(Brand.muted) }
            ForEach(filtered) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.title).font(.headline)
                    if let person = item.personId.flatMap({ id in model.snapshot?.people.first(where: { $0.id == id })?.name }) { Text(person).foregroundStyle(Brand.cyanInk) }
                    if let device = item.deviceId.flatMap({ id in network.devices.first(where: { $0.id == id })?.name }) { Text(device).font(.subheadline) }
                    if let reason = item.reason { Text(reason).font(.subheadline) }
                    Text(Dates.relative(item.createdAt)).font(.caption).foregroundStyle(Brand.muted)
                    if let sessionID = item.sessionId, let session = network.sessions.first(where: { $0.id == sessionID }) { NavigationLink("Session details") { InternetSessionDetail(network: network, original: session) } }
                }.padding(.vertical, 6)
            }
            Section { Text("Filters apply to the latest 100 recorded events. Requested changes and confirmed network results are recorded separately.").font(.footnote).foregroundStyle(Brand.muted) }
        }.navigationTitle("Internet history").navigationBarTitleDisplayMode(.inline).task { await load() }.refreshable { await load() }
    }
    private func load() async {
        loading = true; error = nil; defer { loading = false }
        do { let result = try await network.history(); guard !Task.isCancelled else { return }; items = result }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}

struct DeviceAccessRequestEditor: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var network: InternetModel
    let device: ManagedInternetDevice
    @State private var minutes = 60
    @State private var reason = ""
    @State private var originalDraft: String?
    private var draftSignature: String { draftFingerprint([String(minutes), reason]) }
    private var hasUnsavedChanges: Bool { originalDraft.map { $0 != draftSignature } ?? false }
    var body: some View {
        NavigationStack {
            Form {
                Section("Request time on \(device.name)") {
                    Stepper("\(minutes) minutes", value: $minutes, in: 1...1439, step: 1)
                    TextField("Reason (optional)", text: $reason, axis: .vertical).lineLimit(3...6)
                    if reason.count > 500 { Text("Keep your reason under 500 characters.").foregroundStyle(Brand.red) }
                }
                Section {
                    Text("Your parents will receive this request. Approval starts a device session once the home network confirms access. Requests expire after 24 hours.").font(.footnote).foregroundStyle(Brand.muted)
                    if let message = network.message { Text(message).foregroundStyle(Brand.red) }
                    Button("Send request") { Task { if await network.requestAccess(device: device, minutes: minutes, reason: reason) { dismiss() } } }
                        .disabled(!network.canChange || reason.count > 500)
                    if network.isChanging { ProgressView("Sending request…") }
                }
            }.navigationTitle("Request device time").navigationBarTitleDisplayMode(.inline)
            .onAppear { if originalDraft == nil { originalDraft = draftSignature } }
                .toolbar { ToolbarItem(placement: .cancellationAction) { DraftCancelButton(dirty: hasUnsavedChanges, saving: network.isChanging) { dismiss() } } }
        }.interactiveDismissDisabled(network.isChanging || hasUnsavedChanges)
    }
}

struct HomeInternetSession: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var network: InternetModel
    let original: InternetSession
    @State private var details = false
    var body: some View {
        let item = network.currentSession(original)
        Button { details = true } label: {
            FrameCard(accent: Brand.blue) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .center, spacing: 14) { description(item); Spacer(minLength: 8); timer(item) }
                    VStack(alignment: .leading, spacing: 10) { description(item); timer(item) }
                }
            }
        }.buttonStyle(.plain).accessibilityHint("View this session and its controls")
            .sheet(isPresented: $details) { NavigationStack { InternetSessionDetail(network: network, original: item) }.environmentObject(model) }
    }
    private func description(_ item: InternetSession) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(network.devices.first(where: { $0.id == item.deviceId })?.name ?? "Internet time").font(.headline).foregroundStyle(Brand.ink)
            Text(item.statusLabel(at: network.serverNow)).font(.caption).foregroundStyle(Brand.blueInk)
            if network.isStale { Text("Last known status · refresh to confirm").font(.caption).foregroundStyle(Brand.attentionInk) }
        }
    }
    private func timer(_ item: InternetSession) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            Text(InternetSession.durationLabel(item.remaining(at: network.serverNow))).font(.title2.bold()).monospacedDigit().foregroundStyle(Brand.blueInk)
        }
    }
}
struct HomeRewardBalance: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var network: InternetModel
    var body: some View {
        if network.isChild && network.earnedReward == nil && !network.availableCredits.isEmpty {
            Button { model.selectedTab = 3 } label: {
                HStack { Label("\(network.availableCredits.reduce(0) { $0 + $1.minutes }) minutes saved", systemImage: "star.circle").font(.subheadline.weight(.semibold)); Spacer(); Text("Rewards").font(.subheadline) }
                    .foregroundStyle(Brand.primary).frame(minHeight: 44).padding(.horizontal, 16).padding(.vertical, 8).background(Brand.primaryTint, in: RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain)
        }
    }
}
struct RewardAvailabilityNote: View {
    @ObservedObject var network: InternetModel
    let credit: RewardCredit
    var body: some View {
        if let session = network.liveSessions.first(where: { $0.personId == credit.personId }) {
            Text(session.endsAt.flatMap(Dates.instant).map { "Internet time is already in use until \(Dates.time($0, in: TimeZone(identifier: network.snapshot?.timezone ?? "UTC") ?? .gmt)). Your reward stays saved." } ?? "Another session is being checked. Your reward stays saved.").font(.caption).foregroundStyle(Brand.muted)
        } else if network.integrationReady && !network.rewardDevices(for: credit.personId).contains(where: { network.deviceAvailable($0, for: credit.personId) }) {
            Text("No earned-time device is currently available. Your reward stays saved.").font(.caption).foregroundStyle(Brand.muted)
        }
    }
}

struct EmbeddedInternetSession: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var network: InternetModel
    let original: InternetSession
    @State private var details = false
    var body: some View {
        let item = network.currentSession(original)
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            ViewThatFits(in: .horizontal) {
                HStack { state(item); Spacer(); timer(item) }
                VStack(alignment: .leading) { state(item); timer(item) }
            }
            if item.hasPendingWindow { Text("Reserved time · access is not confirmed yet").font(.caption).foregroundStyle(Brand.muted) }
            if network.canManage && !item.isTerminal {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 20) { controls(item) }
                    VStack(alignment: .leading, spacing: 8) { controls(item) }
                }
            } else { Button("Session details") { details = true }.frame(minHeight: 44) }
        }.sheet(isPresented: $details) { NavigationStack { InternetSessionDetail(network: network, original: item) }.environmentObject(model) }
    }
    private func state(_ item: InternetSession) -> some View { Text(item.statusLabel(at: network.serverNow)).font(.subheadline.weight(.semibold)).foregroundStyle(item.hasVerifiedAccess ? Brand.blueInk : Brand.attentionInk) }
    private func timer(_ item: InternetSession) -> some View { TimelineView(.periodic(from: .now, by: 1)) { _ in Text(InternetSession.durationLabel(item.remaining(at: network.serverNow))).font(.title2.bold()).monospacedDigit().foregroundStyle(Brand.blueInk) } }
    @ViewBuilder private func controls(_ item: InternetSession) -> some View {
        if item.state == "active" { Button("Pause") { Task { _ = await network.act(item, action: "pause") } }.frame(minHeight: 44).disabled(!network.canChange) }
        if item.state == "paused" { Button("Resume") { Task { _ = await network.act(item, action: "resume") } }.frame(minHeight: 44).disabled(!network.canChange || item.remaining(at: network.serverNow) <= 0) }
        if item.isStable { Button("Add 15 min") { Task { _ = await network.act(item, action: "adjust", deltaMinutes: 15) } }.frame(minHeight: 44).disabled(!network.canChange) }
        Button("More controls") { details = true }.frame(minHeight: 44)
    }
}
