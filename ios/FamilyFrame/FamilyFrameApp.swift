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
    @State private var creating = false
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var confirmationCode = ""
    @State private var invitation = ""
    @State private var confirmationNotice: String?
    @FocusState private var focus: Field?
    enum Field { case name, email, password, confirmPassword, code, invitation }
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
                FrameCard(accent: creating ? Brand.magenta : Brand.cyan) {
                    switch model.accountStage {
                    case .entry: accountEntry
                    case .confirmEmail(let accountEmail): confirmationEntry(email: accountEmail)
                    case .joinFamily(let accountEmail): joinEntry(email: accountEmail)
                    }
                }
                Text("Parents and kids each use their own email and password. Your household role controls what you can see and change.").font(.footnote).foregroundStyle(Brand.muted)
            }.padding(24).frame(maxWidth: 560).frame(maxWidth: .infinity)
        }
        .background(Brand.background).scrollDismissesKeyboard(.interactively)
        .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focus = nil } } }
    }
    private var accountEntry: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Account access", selection: $creating) { Text("Sign in").tag(false); Text("Create account").tag(true) }.pickerStyle(.segmented).disabled(model.isSigningIn)
            Text(creating ? "Your own account." : "Welcome home.").font(.title2.bold())
            Text(creating ? "Create an account with your own email. A parent invitation connects a child's account to their chores." : "Parents and kids sign in here with their own email and password.").font(.subheadline).foregroundStyle(Brand.muted)
            if creating {
                TextField("Name", text: $name).textContentType(.name).focused($focus, equals: .name).textFieldStyle(.roundedBorder).accessibilityLabel("Your name")
            }
            TextField("Email", text: $email).keyboardType(.emailAddress).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .email).submitLabel(.next).onSubmit { focus = .password }.textFieldStyle(.roundedBorder).accessibilityLabel("Account email")
            SecureField("Password", text: $password).textContentType(creating ? .newPassword : .password).focused($focus, equals: .password).submitLabel(creating ? .next : .go).textFieldStyle(.roundedBorder).accessibilityLabel("Account password").onSubmit { if creating { focus = .confirmPassword } else { submitAccount() } }
            if creating {
                SecureField("Confirm password", text: $confirmPassword).textContentType(.newPassword).focused($focus, equals: .confirmPassword).textFieldStyle(.roundedBorder).accessibilityLabel("Confirm account password")
                Text("Use at least 12 characters. Keep your password private.").font(.caption).foregroundStyle(Brand.muted)
                if !confirmPassword.isEmpty && password != confirmPassword { Text("The passwords must match.").font(.caption).foregroundStyle(Brand.red) }
            }
            DisclosureGroup("Have a family invitation?") { invitationField.padding(.top, 8) }.font(.subheadline)
            Button { submitAccount() } label: {
                if model.isSigningIn { ProgressView().tint(.white) } else { Text(creating ? "Create my account" : "Sign in to Family Frame") }
            }.buttonStyle(PrimaryButton()).disabled(!entryValid || model.isSigningIn)
            Link("Open the web dashboard", destination: APIClient.configuredURL).font(.footnote).foregroundStyle(Brand.cyanInk)
        }
    }
    private func confirmationEntry(email: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "envelope.badge").font(.title).foregroundStyle(Brand.cyanInk).accessibilityHidden(true)
            Text("Check your email.").font(.title2.bold())
            Text("Enter the confirmation code sent to \(email). This confirms the account belongs to you.").font(.subheadline).foregroundStyle(Brand.muted)
            TextField("Email confirmation code", text: $confirmationCode).keyboardType(.numberPad).textContentType(.oneTimeCode).focused($focus, equals: .code).textFieldStyle(.roundedBorder).font(.title2.monospacedDigit())
                .onChange(of: confirmationCode) { _, value in confirmationCode = String(value.filter(\.isNumber).prefix(10)) }.accessibilityLabel("Email confirmation code")
            Button { focus = nil; Task { if await model.confirmAccount(code: confirmationCode, invitation: invitation) { confirmationCode = "" } } } label: {
                if model.isSigningIn { ProgressView().tint(.white) } else { Text("Confirm my email") }
            }.buttonStyle(PrimaryButton()).disabled(!(6...10).contains(confirmationCode.count) || model.isSigningIn)
            Button("Resend confirmation email") { Task { if await model.resendConfirmation() { confirmationNotice = "A new confirmation email was requested. Check your inbox and junk folder." } } }.disabled(model.isSigningIn)
            if let confirmationNotice { Text(confirmationNotice).font(.caption).foregroundStyle(Brand.muted) }
            backToSignIn
        }
    }
    private func joinEntry(email: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Join your family.").font(.title2.bold())
            Text("You're signed in as \(email). Ask a parent for the invitation assigned to your email and paste its token below. It connects your account to the right profile.").font(.subheadline).foregroundStyle(Brand.muted)
            invitationField
            Button { focus = nil; Task { _ = await model.joinFamily(invitation: invitation) } } label: {
                if model.isSigningIn { ProgressView().tint(.white) } else { Text("Accept family invitation") }
            }.buttonStyle(PrimaryButton()).disabled(invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSigningIn)
            Text("An account without an accepted invitation has no access to household data.").font(.caption).foregroundStyle(Brand.muted)
            backToSignIn
        }
    }
    private var invitationField: some View {
        TextField("Invitation token", text: $invitation, axis: .vertical).lineLimit(2...4).keyboardType(.asciiCapable).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .invitation).textFieldStyle(.roundedBorder).accessibilityLabel("Family invitation token").privacySensitive()
    }
    private var backToSignIn: some View {
        Button("Use a different account") { focus = nil; Task { await model.cancelAccountOnboarding(); email = ""; name = ""; password = ""; confirmPassword = ""; confirmationCode = ""; invitation = ""; confirmationNotice = nil } }.font(.subheadline).disabled(model.isSigningIn)
    }
    private var entryValid: Bool {
        let validEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).contains("@")
        return validEmail && !password.isEmpty && (!creating || (!name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 120 && password.count >= 12 && password == confirmPassword))
    }
    private func submitAccount() {
        guard entryValid else { return }; focus = nil
        Task {
            let progressed = creating ? await model.createAccount(name: name, email: email, password: password, invitation: invitation) : await model.signIn(email: email, password: password, invitation: invitation)
            if progressed { password = ""; confirmPassword = "" }
        }
    }
}
