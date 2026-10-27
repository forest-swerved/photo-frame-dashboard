import SwiftUI

extension ManagedInternetDevice {
    var artworkName: String {
        let lower = name.lowercased()
        if kind == "console" {
            if lower.range(of: #"\bps\s?5\b|playstation"#, options: .regularExpression) != nil { return "ps5" }
            if lower.contains("switch") { return "switch" }
        }
        if kind == "tablet", lower.range(of: #"\bpro\b"#, options: .regularExpression) != nil { return "tablet-pro" }
        return ["tablet": "tablet", "phone": "phone", "computer": "laptop", "console": "console", "tv": "apple-tv"][kind] ?? "other"
    }
}

struct DeviceArtwork: View {
    let device: ManagedInternetDevice
    var size: CGFloat = 76
    var body: some View {
        Image("Device-" + device.artworkName)
            .resizable().interpolation(.high).scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.19, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: size * 0.19, style: .continuous).strokeBorder(Brand.primary.opacity(0.09), lineWidth: 1))
            .accessibilityHidden(true)
    }
}
