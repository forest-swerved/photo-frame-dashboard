import SwiftUI

enum Brand {
    static let primary = Color(hex: "b026ff")
    static let instrument = Color(hex: "071725")
    static let instrumentMuted = Color(hex: "c5ced5")
    static let actionInk = Color(hex: "8400c9")
    static let primaryTint = Color(hex: "f1e7f7")
    static let blue = Color(hex: "b026ff")
    static let blueInk = Color(hex: "202725")
    static let mint = Color(hex: "39ff14")
    static let successInk = Color(hex: "006b49")
    static let coral = Color(hex: "ff5c5c")
    static let attentionInk = Color(hex: "a32929")
    static let attentionTint = Color(hex: "fff0f0")
    static let danger = Color(hex: "c62839")
    static let red = danger
    static let cyan = blue
    static let cyanInk = blueInk
    static let lime = mint
    static let magenta = coral
    static let magentaInk = attentionInk
    static let ink = Color(hex: "202725")
    static let muted = Color(hex: "626963")
    static let background = Color(hex: "f6f5f1")
    static let line = Color(hex: "d8dbd5")
    @MainActor static func webSettings(_ section: String) -> URL {
        var parts = URLComponents(url: APIClient.configuredURL, resolvingAgainstBaseURL: false)!
        parts.path = "/family.html"
        parts.queryItems = [URLQueryItem(name: "settings", value: section)]
        parts.fragment = "setup"
        return parts.url ?? APIClient.configuredURL
    }
}

extension Color {
    init(hex: String) {
        let string = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let value = UInt64(string, radix: 16) ?? 0x00748c
        self.init(.sRGB, red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255, opacity: 1)
    }
}

struct BrandMark: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 11).fill(Brand.primary)
            RoundedRectangle(cornerRadius: 3).stroke(.white, lineWidth: 3).frame(width: 22, height: 27).rotationEffect(.degrees(-9)).offset(x: -3, y: 1)
            RoundedRectangle(cornerRadius: 3).stroke(Brand.cyan, lineWidth: 3).frame(width: 22, height: 27).rotationEffect(.degrees(10)).offset(x: 4, y: -1)
        }.frame(width: 48, height: 48).accessibilityHidden(true)
    }
}
struct FrameCard<Content: View>: View {
    var accent: Color = Brand.primary
    var instrument = false
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 16) { content }
            .frame(maxWidth: .infinity, alignment: .leading).padding(20)
            .background(instrument ? Brand.instrument : Brand.background, in: RoundedRectangle(cornerRadius: 6))
            .overlay(alignment: .top) { if instrument { Rectangle().fill(Brand.primary).frame(height: 3) } }
            .overlay { RoundedRectangle(cornerRadius: 6).stroke(instrument ? Color.white.opacity(0.15) : Brand.line, lineWidth: 1) }
            .foregroundStyle(instrument ? Color.white : Brand.ink)
            .tint(instrument ? Color.white : Brand.actionInk)
    }
}
struct PrimaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.headline).foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 15)
            .background(Brand.primary.opacity(configuration.isPressed ? 0.75 : 1), in: RoundedRectangle(cornerRadius: 6))
            .opacity(isEnabled ? 1 : 0.45)
    }
}
struct EmptyState: View {
    let symbol: String
    let title: String
    let detail: String
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 32, weight: .light)).foregroundStyle(Brand.cyanInk).accessibilityHidden(true)
            Text(title).font(.headline)
            Text(detail).font(.subheadline).foregroundStyle(Brand.muted).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(.vertical, 24)
    }
}
struct StaleBanner: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        if model.isStale {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "wifi.exclamationmark")
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.snapshot == nil ? "Waiting for current data" : "Offline copy · changes paused").font(.subheadline.weight(.semibold))
                    if let issue = model.refreshIssue { Text(issue).font(.caption) }
                    if let date = model.lastUpdated { Text("Last updated \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption) }
                    Button("Refresh current status") { Task { await model.refresh() } }.font(.subheadline.weight(.semibold)).disabled(model.isLoading)
                }
                Spacer(minLength: 0)
            }.foregroundStyle(Brand.attentionInk).padding(14).frame(maxWidth: .infinity)
                .background(Brand.attentionTint, in: RoundedRectangle(cornerRadius: 12)).accessibilityElement(children: .contain)
        }
    }
}

// A consistent escape route for editors; a dirty draft remains in memory only.
struct DraftCancelButton: View {
    var dirty: Bool
    var saving = false
    var label = "Cancel"
    let discard: () -> Void
    @State private var confirming = false
    var body: some View {
        Button(label) { if dirty { confirming = true } else { discard() } }
            .disabled(saving)
            .confirmationDialog("Discard unsaved changes?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive, action: discard)
                Button("Keep editing", role: .cancel) { }
            }
    }
}
func draftFingerprint<T: Encodable>(_ value: T) -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
    return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
}
