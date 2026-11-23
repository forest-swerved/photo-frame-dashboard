import ActivityKit
import SwiftUI

struct DeviceAccessActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let items: [LiveDeviceItem]
        let totalCount: Int
        let checkedAt: Double
    }
    let registrationId: String
    let runId: String
}
struct LiveDeviceItem: Codable, Hashable, Identifiable {
    let id: String
    let person: String
    let device: String
    let status: String
    let endsAt: Double?
    let preparationEndsAt: Double?
    var end: Date? { endsAt.map(Date.init(timeIntervalSince1970:)) }
}
struct DeviceAccessLiveView: View {
    let state: DeviceAccessActivityAttributes.ContentState
    var stale = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Device access", systemImage: "gamecontroller.fill").font(.headline)
                Spacer()
                if state.totalCount > state.items.count { Text("+\(state.totalCount - state.items.count)").font(.caption) }
            }
            if state.items.isEmpty { Text("Device access ended").font(.subheadline) }
            else {
                ForEach(state.items) { item in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.person.isEmpty ? item.device : item.person).font(.subheadline.weight(.semibold))
                            if !item.person.isEmpty { Text(item.device).font(.caption).foregroundStyle(.secondary) }
                        }.lineLimit(1)
                        Spacer()
                        if !stale, let end = item.end, end > Date() {
                            Text(timerInterval: Date()...end, countsDown: true).font(.title3.bold()).monospacedDigit().multilineTextAlignment(.trailing).frame(maxWidth: 100)
                        } else { Text(stale ? "Last known" : item.end != nil ? "Confirming block" : item.status).font(.caption.weight(.semibold)) }
                    }.accessibilityElement(children: .combine)
                }
            }
            if stale { Label("Waiting for a network update", systemImage: "arrow.clockwise").font(.caption).foregroundStyle(.secondary) }
        }.padding(16).privacySensitive()
    }
}
