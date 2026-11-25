import SwiftUI

struct ChildPinStatus: Decodable { let personId: String; let configured: Bool; let updatedAt: String? }
extension FamilyAPI {
    func childPin(personID: String, pin: String?) async throws -> ChildPinStatus { throw APIError(status: 503, code: "unsupported", message: "Child PIN settings are unavailable.") }
    func snoozeTaskAlarm(occurrenceID: String) async throws -> ChoreOccurrence { throw APIError(status: 503, code: "unsupported", message: "Alarm snooze is unavailable.") }
}

/// A parent sets each child's own four-digit PIN. The child types it on the
/// family frame to use saved time and to confirm alarm tasks.
struct ChildPinScreen: View {
    @EnvironmentObject var model: AppModel
    let person: Person
    @State private var pin = ""
    @State private var confirm = ""
    @State private var saving = false
    @State private var message: String?
    private var configured: Bool { model.snapshot?.people.first { $0.id == person.id }?.pinConfigured == true }
    private var valid: Bool { pin.count == 4 && pin.allSatisfy { $0.isASCII && $0.isNumber } && pin == confirm }
    var body: some View {
        Form {
            Section {
                Text("\(person.name) types this PIN on the family frame to use saved time and to confirm alarm tasks. On their own phone they are already signed in and never need it.")
                Text(configured ? "\(person.name) has a PIN set." : "\(person.name) has no PIN yet.").font(.subheadline.weight(.semibold))
            }
            Section(configured ? "Change the PIN" : "Set the PIN") {
                SecureField("Four-digit PIN", text: $pin).keyboardType(.numberPad).textContentType(nil)
                SecureField("Confirm PIN", text: $confirm).keyboardType(.numberPad).textContentType(nil)
                Button("Save \(person.name)'s PIN") { Task { await save(pin) } }.disabled(saving || !valid || model.isStale)
                if saving { ProgressView("Saving…") }
            }
            if configured {
                Section { Button("Remove PIN", role: .destructive) { Task { await save(nil) } }.disabled(saving || model.isStale) }
                    footer: { Text("Without a PIN, \(person.name) unlocks the frame with a code from their own phone.") }
            }
            if let message { Section { Text(message) } }
        }.navigationTitle("\(person.name)'s frame PIN").navigationBarTitleDisplayMode(.inline)
            .onDisappear { pin = ""; confirm = "" }
    }
    private func save(_ value: String?) async {
        saving = true; message = nil; defer { saving = false; pin = ""; confirm = "" }
        do {
            _ = try await model.childPin(person: person, pin: value)
            message = value == nil ? "The PIN was removed." : "\(person.name)'s PIN was saved."
        } catch { message = (error as? APIError)?.status == 422 ? error.localizedDescription : "The PIN change was not confirmed. Refresh and try again." }
    }
}
