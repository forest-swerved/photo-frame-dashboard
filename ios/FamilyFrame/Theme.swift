import SwiftUI

enum Brand {
    static let red = Color(hex: "de1f26")
    static let cyan = Color(hex: "00cfff")
    static let cyanInk = Color(hex: "00748c")
    static let lime = Color(hex: "c8ff00")
    static let magenta = Color(hex: "ff2ebc")
    static let magentaInk = Color(hex: "a91675")
    static let ink = Color(hex: "111111")
    static let muted = Color(hex: "63636b")
    static let background = Color(hex: "f5f5f7")
    static let line = Color(hex: "dcdce2")
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
            RoundedRectangle(cornerRadius: 11).fill(Brand.red)
            RoundedRectangle(cornerRadius: 3).stroke(.white, lineWidth: 3).frame(width: 22, height: 27).rotationEffect(.degrees(-9)).offset(x: -3, y: 1)
            RoundedRectangle(cornerRadius: 3).stroke(Brand.cyan, lineWidth: 3).frame(width: 22, height: 27).rotationEffect(.degrees(10)).offset(x: 4, y: -1)
        }.frame(width: 48, height: 48).accessibilityHidden(true)
    }
}
struct FrameCard<Content: View>: View {
    var accent: Color = Brand.cyan
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 16) { content }
            .frame(maxWidth: .infinity, alignment: .leading).padding(20)
            .background(.white, in: RoundedRectangle(cornerRadius: 20))
            .overlay(alignment: .top) { Capsule().fill(accent).frame(height: 4).padding(.horizontal, 16) }
            .overlay { RoundedRectangle(cornerRadius: 20).stroke(Brand.line, lineWidth: 1) }
    }
}
struct PrimaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.headline).foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 15)
            .background(Brand.red.opacity(configuration.isPressed ? 0.75 : 1), in: RoundedRectangle(cornerRadius: 13))
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
            }.foregroundStyle(Color(hex: "92400e")).padding(14).frame(maxWidth: .infinity)
                .background(Color(hex: "fffbeb"), in: RoundedRectangle(cornerRadius: 12)).accessibilityElement(children: .contain)
        }
    }
}
