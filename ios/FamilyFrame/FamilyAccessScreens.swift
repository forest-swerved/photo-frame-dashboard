import SwiftUI

struct FrameAccessCode: Decodable {
    let code: String
    let scope: String
    let personId: String?
    let expiresAt: String
}
struct FamilyMember: Decodable, Identifiable {
    let id: String
    let name: String
    let email: String
    let role: String
    let personId: String?
    let joinedAt: String?
    let capabilities: ParentCapabilities
}
struct FamilyMemberList: Decodable { let members: [FamilyMember] }
struct MemberCapabilitiesResult: Decodable { let id: String; let capabilities: ParentCapabilities }

struct FrameAccessScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var scope = "child"
    @State private var personID = ""
    @State private var code: FrameAccessCode?
    @State private var generating = false
    @State private var error: String?
    var body: some View {
        List {
            Section {
                Text("Unlock protected controls on the shared frame using a short code from your own account.").font(.subheadline)
                if model.canManageInternet {
                    Picker("Unlock as", selection: $scope) { Text("Child").tag("child"); Text("Parent").tag("parent") }
                    if scope == "child" {
                        Picker("Child", selection: $personID) { Text("Choose a child").tag(""); ForEach(model.snapshot?.people ?? []) { Text($0.name).tag($0.id) } }
                    }
                } else if model.canManageChores { Text("Unlock parent task controls.").foregroundStyle(Brand.cyanInk) }
                else { Text("Unlock your own profile.").foregroundStyle(Brand.cyanInk) }
                Button { Task { await generate() } } label: { if generating { ProgressView() } else { Text("Create one-time unlock code") } }
                    .frame(minHeight: 44).disabled(generating || model.isStale || (scope == "child" && selectedPerson == nil))
            } footer: { Text("Use the code within 5 minutes. It works once and unlocks that scope for 10 minutes. Creating another code replaces your previous code.") }
            if let code {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let valid = Dates.instant(code.expiresAt).map { $0 > context.date } ?? false
                    Section {
                        if valid {
                            Text(code.code).font(.system(.largeTitle, design: .monospaced).weight(.bold)).tracking(6).textSelection(.enabled).privacySensitive().accessibilityLabel("Unlock code, " + code.code.map(String.init).joined(separator: ", "))
                            Text("Enter this code in the frame's unlock screen.").font(.subheadline)
                            Text("Expires \(Dates.relative(code.expiresAt)).").font(.caption).foregroundStyle(Brand.muted)
                        } else { Text("Code expired. Create a new code when you're ready.").foregroundStyle(Brand.muted) }
                    } header: { Text(code.scope == "parent" ? "Parent controls" : "Child profile") }
                }
            }
            if let error { Text(error).foregroundStyle(Brand.red) }
        }.navigationTitle("Unlock the frame").navigationBarTitleDisplayMode(.inline)
            .onAppear { if !model.canManageInternet && model.canManageChores { scope = "parent" } }
            .onChange(of: scope) { _, _ in code = nil }.onChange(of: personID) { _, _ in code = nil }
            .onDisappear { code = nil }
    }
    private var selectedPerson: String? { model.session?.isChild == true ? model.session?.personId : personID.isEmpty ? nil : personID }
    private func generate() async {
        generating = true; error = nil; code = nil; let selectedScope = scope, person = selectedPerson
        defer { generating = false }
        do {
            let result = try await model.frameAccessCode(scope: selectedScope, personID: selectedScope == "child" ? person : nil)
            guard !Task.isCancelled, selectedScope == scope, person == selectedPerson else { return }; code = result
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}

struct CaregiverAccessScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var members: [FamilyMember] = []
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        List {
            Section { Text("Give a caregiver permission to manage tasks or Internet time independently. Only parent administrators can change these permissions.").font(.subheadline) }
            if loading { ProgressView("Loading family access…") }
            if let error { Text(error).foregroundStyle(Brand.red) }
            ForEach(members) { member in
                if member.role == "member" {
                    NavigationLink { CaregiverPermissionEditor(member: member, saved: { Task { await load() } }) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(member.name).font(.headline)
                            Text(member.email).font(.caption).foregroundStyle(Brand.muted)
                            Text([member.capabilities.manageChores ? "Tasks" : nil, member.capabilities.manageInternet ? "Internet time" : nil].compactMap { $0 }.joined(separator: " · ").nilIfEmpty ?? "No management permissions").font(.subheadline).foregroundStyle(Brand.cyanInk)
                        }.padding(.vertical, 6)
                    }
                } else {
                    LabeledContent(member.name, value: member.role == "admin" ? "Parent administrator" : "Child")
                }
            }
        }.navigationTitle("Caregiver permissions").navigationBarTitleDisplayMode(.inline).task { await load() }.refreshable { await load() }
    }
    private func load() async {
        loading = true; error = nil; defer { loading = false }
        do { let result = try await model.familyMembers(); guard !Task.isCancelled else { return }; members = result }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}
private extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

private struct CaregiverPermissionEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let member: FamilyMember
    let saved: () -> Void
    @State private var chores: Bool
    @State private var internet: Bool
    @State private var saving = false
    @State private var uncertain = false
    init(member: FamilyMember, saved: @escaping () -> Void) {
        self.member = member; self.saved = saved
        _chores = State(initialValue: member.capabilities.manageChores); _internet = State(initialValue: member.capabilities.manageInternet)
    }
    var body: some View {
        Form {
            Section(member.name) {
                Toggle("Manage tasks and approvals", isOn: $chores)
                Toggle("Manage Internet access", isOn: $internet)
            }
            if uncertain { Text("Close this page and refresh the caregiver list to check which permissions were saved.").foregroundStyle(Brand.red) }
            Section { Text("Permissions are verified by the server on each protected action.").font(.footnote).foregroundStyle(Brand.muted) }
        }.navigationTitle("Caregiver access").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button { Task {
                saving = true; let success = await model.changeCaregiver(member.id, capabilities: ParentCapabilities(manageChores: chores, manageInternet: internet)); saving = false
                if success { saved(); dismiss() } else { uncertain = true }
            } } label: { if saving { ProgressView() } else { Text("Save").bold() } }.disabled(saving || uncertain || model.isStale || !model.isAdmin) } }
    }
}

struct PasswordRecoveryScreen: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var email: String
    @State private var requested = false
    @State private var code = ""
    @State private var link = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var working = false
    @State private var completed = false
    @FocusState private var focus: Field?
    private enum Field: Hashable { case email, code, link, password, confirmation }
    init(email: String = "") { _email = State(initialValue: email) }
    var body: some View {
        NavigationStack {
            Form {
                if completed {
                    Section { Label("Password updated", systemImage: "checkmark.shield").font(.headline); Text("Sign in with your new password. Other signed-in devices must sign in again.") }
                } else {
                    Section {
                        TextField("Account email", text: $email).textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .email).id(Field.email)
                        Button(requested ? "Request another reset email" : "Send reset email") { focus = nil; Task { working = true; requested = await model.requestPasswordReset(email: email); working = false } }.disabled(working || !email.contains("@"))
                    } footer: { if requested { Text("If this account exists, a recovery email has been requested. Check your inbox and junk folder.") } }
                    if requested {
                        Section("Proof from the recovery email") {
                            TextField("Recovery code", text: $code).textContentType(.oneTimeCode).keyboardType(.numberPad).focused($focus, equals: .code).id(Field.code)
                                .onChange(of: code) { _, value in code = String(value.filter(\.isNumber).prefix(10)) }
                            DisclosureGroup("Use the recovery link instead") {
                                TextField("Paste the complete recovery link", text: $link, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .link).id(Field.link).privacySensitive()
                            }
                        }
                        Section("New password") {
                            SecureField("At least 12 characters", text: $password).textContentType(.newPassword).focused($focus, equals: .password).id(Field.password)
                            SecureField("Confirm new password", text: $confirmation).textContentType(.newPassword).focused($focus, equals: .confirmation).id(Field.confirmation)
                            if !confirmation.isEmpty && password != confirmation { Text("The passwords must match.").font(.caption).foregroundStyle(Brand.red) }
                            Button { focus = nil; Task { working = true; completed = await model.resetPassword(email: email, token: code, recoveryLink: link, password: password); password = ""; confirmation = ""; working = false } } label: { if working { ProgressView() } else { Text("Reset password and sign out devices") } }
                                .disabled(working || password.count < 12 || password != confirmation || (!(6...10).contains(code.count) && link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                        }
                    }
                }
            }.navigationTitle("Reset password").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button(completed ? "Sign in" : "Done") { dismiss() }.disabled(working) }
                    ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focus = nil } }
                }
                .onChange(of: email) { _, _ in requested = false; code = ""; link = "" }
        }.interactiveDismissDisabled(working)
    }
}
