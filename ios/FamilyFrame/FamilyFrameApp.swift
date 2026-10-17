import SwiftUI

@main
struct FamilyFrameApp: App {
    @UIApplicationDelegateAdaptor(FamilyAppDelegate.self) var delegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            Group {
                if model.session != nil { DashboardTabs() } else { WelcomeScreen() }
            }
            .environmentObject(model).tint(Brand.red).preferredColorScheme(.light)
            .task { await model.start() }
            .task(id: phase) {
                guard phase == .active else { return }
                await NotificationController.shared.refreshStatus()
                while !Task.isCancelled {
                    if model.session != nil { await model.refresh() }
                    do { try await Task.sleep(for: .seconds(25)) } catch { break }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .familyNotificationReceived)) { _ in Task { await model.refresh() } }
            .onReceive(NotificationCenter.default.publisher(for: .familyNotificationOpened)) { _ in
                model.selectedTab = 3; Task { await model.refresh() }
            }
            .alert("Family Frame", isPresented: Binding(get: { model.message != nil }, set: { if !$0 { model.message = nil } })) {
                Button("OK") { model.message = nil }
            } message: { Text(model.message ?? "") }
            // Hide household information in the system's app-switcher snapshot.
            .overlay { if phase != .active { Color.white.ignoresSafeArea().overlay(BrandMark()) } }
        }
    }
}

struct DashboardTabs: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        TabView(selection: $model.selectedTab) {
            NavigationStack { TodayScreen() }.tabItem { Label("Today", systemImage: "house.fill") }.tag(0)
            NavigationStack { ChoresScreen() }.tabItem { Label("Chores", systemImage: "checklist") }.tag(1)
            NavigationStack { CalendarScreen() }.tabItem { Label("Calendar", systemImage: "calendar") }.tag(2)
            NavigationStack { ActivityScreen() }.tabItem { Label("Activity", systemImage: "bell.fill") }.badge(model.unreadCount).tag(3)
            NavigationStack { SettingsScreen() }.tabItem { Label("Settings", systemImage: "gearshape.fill") }.tag(4)
        }
    }
}

struct WelcomeScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var child = false
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @FocusState private var focus: Field?
    enum Field { case email, password, code }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack(spacing: 14) { BrandMark(); Text("FAMILY FRAME").font(.caption.weight(.heavy)).tracking(2) }.padding(.top, 30)
                VStack(alignment: .leading, spacing: 12) {
                    Text("A little more\ntogether.").font(.system(size: 42, weight: .bold, design: .rounded)).fixedSize(horizontal: false, vertical: true)
                    Text("The family calendar, everyone's chores, and the moments that keep your home moving.").font(.title3).foregroundStyle(Brand.muted)
                }
                HStack(spacing: 8) {
                    Capsule().fill(Brand.cyan).frame(width: 62, height: 6)
                    Capsule().fill(Brand.lime).frame(width: 62, height: 6)
                    Capsule().fill(Brand.magenta).frame(width: 62, height: 6)
                }.accessibilityHidden(true)
                FrameCard(accent: child ? Brand.magenta : Brand.cyan) {
                    Picker("How are you joining?", selection: $child) { Text("Parent sign-in").tag(false); Text("Child pairing").tag(true) }.pickerStyle(.segmented)
                    if child {
                        Text("Your own space.").font(.title2.bold())
                        Text("Ask a parent to create a code in Settings → Pair a child device. Enter it here to open your checklist.").font(.subheadline).foregroundStyle(Brand.muted)
                        TextField("Six-digit pairing code", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                            .focused($focus, equals: .code).textFieldStyle(.roundedBorder).font(.title2.monospacedDigit())
                            .onChange(of: code) { _, value in code = String(value.filter(\.isNumber).prefix(6)) }
                            .accessibilityLabel("Six-digit child pairing code")
                        Button { focus = nil; Task { if await model.pairChild(code: code) { code = "" } } } label: {
                            if model.isSigningIn { ProgressView().tint(.white) } else { Text("Pair my device") }
                        }.buttonStyle(PrimaryButton()).disabled(code.count != 6 || model.isSigningIn)
                    } else {
                        Text("Welcome home.").font(.title2.bold())
                        TextField("Email", text: $email).keyboardType(.emailAddress).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .email).submitLabel(.next).onSubmit { focus = .password }.textFieldStyle(.roundedBorder).accessibilityLabel("Parent email")
                        SecureField("Password", text: $password).textContentType(.password).focused($focus, equals: .password).submitLabel(.go).textFieldStyle(.roundedBorder).accessibilityLabel("Parent password")
                        Button { login() } label: {
                            if model.isSigningIn { ProgressView().tint(.white) } else { Text("Sign in") }
                        }.buttonStyle(PrimaryButton()).disabled(email.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty || model.isSigningIn)
                        Link("Create an account or manage access on the web", destination: APIClient.configuredURL).font(.footnote).foregroundStyle(Brand.cyanInk)
                    }
                }
                Text("Your frame, phone, and family stay in sync. Notifications are optional and can be changed at any time.").font(.footnote).foregroundStyle(Brand.muted)
            }.padding(24).frame(maxWidth: 560).frame(maxWidth: .infinity)
        }
        .background(Brand.background).scrollDismissesKeyboard(.interactively)
        .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focus = nil } } }
        .onSubmit { if !child && focus == .password { login() } }
    }
    private func login() {
        focus = nil
        Task { if await model.signIn(email: email, password: password) { password = "" } }
    }
}
