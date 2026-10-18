import SwiftUI

struct AccountDeletionScreen: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var confirmation = ""
    @State private var deleting = false
    @State private var confirmDeletion = false
    @State private var deleted = false
    var body: some View {
        NavigationStack {
            Form {
                if deleted {
                    Section { Label("Account deleted", systemImage: "checkmark.shield").font(.headline); Text("This device's saved sign-in and household copy have been removed.") }
                } else {
                    Section {
                        Text("Permanently delete your Family Frame account.").font(.headline)
                        if let email = model.session?.user.email ?? model.accountStage.email { Text(email).font(.subheadline).textSelection(.enabled) }
                        Text("This ends your app access and revokes your signed-in devices. Shared family records may remain without your account identity. This action cannot be undone.").font(.subheadline).foregroundStyle(Brand.muted)
                    }
                    Section {
                        SecureField("Current account password", text: $password).textContentType(.password).accessibilityLabel("Password to confirm account deletion")
                        TextField("DELETE MY ACCOUNT", text: $confirmation).textInputAutocapitalization(.characters).autocorrectionDisabled().accessibilityLabel("Type DELETE MY ACCOUNT")
                    } header: { Text("Confirm your identity") } footer: { Text("Type DELETE MY ACCOUNT exactly and enter your current password. Your email is verified by the server.") }
                    if model.isAdmin {
                        Section {
                            NavigationLink("Transfer household ownership first") { OwnershipTransferScreen() }
                            Text("A sole parent administrator must transfer ownership before leaving other family members behind. An enrolled managed device or an unfinished Internet session also prevents deleting the entire household; finish network cleanup first.").font(.footnote).foregroundStyle(Brand.muted)
                        }
                    }
                    if model.accountDeletionNeedsReview {
                        Section { Text("Deletion was not confirmed. Close this form and sign in again to check your account. If account cleanup already removed family membership, the sign-in screen still lets you retry deletion without joining a family.").foregroundStyle(Brand.red) }
                    }
                    Section {
                        Button(role: .destructive) { confirmDeletion = true } label: { if deleting { ProgressView("Deleting account…") } else { Text("Permanently delete my account").font(.headline) } }
                            .frame(minHeight: 44).disabled(deleting || model.isSigningIn || model.accountDeletionNeedsReview || !model.canDeleteAccount || password.isEmpty || password.count > 1024 || confirmation != "DELETE MY ACCOUNT")
                    }
                }
                Section { Link("Privacy policy", destination: APIClient.configuredURL.appendingPathComponent("privacy.html")) }
            }.navigationTitle(deleted ? "Account deleted" : "Delete my account").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(deleted ? "Done" : "Cancel") { password = ""; dismiss() }.disabled(deleting) } }
                .confirmationDialog("Permanently delete your account?", isPresented: $confirmDeletion, titleVisibility: .visible) {
                    Button("Delete my account permanently", role: .destructive) { Task {
                        deleting = true; deleted = await model.deleteAccount(password: password, confirmation: confirmation); password = ""; deleting = false
                        if deleted { dismiss() }
                    } }
                    Button("Keep my account", role: .cancel) { }
                } message: { Text("Your sign-ins will be revoked and your account will be permanently removed.") }
        }.interactiveDismissDisabled(deleting)
    }
}

struct OwnershipTransferScreen: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var members: [FamilyMember] = []
    @State private var selected = ""
    @State private var loading = false
    @State private var transferring = false
    @State private var confirming = false
    @State private var review = false
    @State private var error: String?
    private var eligible: [FamilyMember] { members.filter { $0.role == "member" && $0.id != model.session?.user.id } }
    var body: some View {
        Form {
            Section {
                Text("Choose an existing adult caregiver to become a parent administrator. Your account becomes a caregiver instead.").font(.subheadline)
                if loading { ProgressView("Loading eligible caregivers…") }
                Picker("New parent administrator", selection: $selected) { Text("Choose a caregiver").tag(""); ForEach(eligible) { Text($0.name).tag($0.id) } }
                if !loading && eligible.isEmpty { Text("There is no eligible adult caregiver. Invite an adult through family setup before transferring ownership.").font(.footnote).foregroundStyle(Brand.muted) }
            }
            if let error { Text(error).foregroundStyle(Brand.red) }
            if review { Text("The transfer was not confirmed. Close this page and refresh Settings to check your current role before trying again.").foregroundStyle(Brand.red) }
            Button("Transfer ownership") { confirming = true }.font(.headline).frame(minHeight: 44).disabled(loading || transferring || review || selected.isEmpty || !model.isAdmin || model.isStale)
        }.navigationTitle("Transfer ownership").navigationBarTitleDisplayMode(.inline).task { await load() }
            .confirmationDialog("Make \(eligible.first(where: { $0.id == selected })?.name ?? "this caregiver") a parent administrator?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Transfer ownership and become a caregiver") { Task {
                    transferring = true; let success = await model.transferOwnership(userID: selected); transferring = false
                    if success { dismiss() } else { review = true }
                } }
                Button("Cancel", role: .cancel) { }
            } message: { Text("You will no longer be a parent administrator. The selected adult will control household membership and administrator actions.") }
            .interactiveDismissDisabled(transferring)
    }
    private func load() async {
        loading = true; defer { loading = false }
        do { let result = try await model.familyMembers(); guard !Task.isCancelled else { return }; members = result }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}
