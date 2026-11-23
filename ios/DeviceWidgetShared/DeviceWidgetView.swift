import SwiftUI
import WidgetKit

struct DeviceStatusEntry: TimelineEntry {
    let date: Date
    let snapshot: DeviceWidgetSnapshot?
    var message: String? = nil
    var stale: Bool { snapshot.map { date.timeIntervalSince($0.checkedAt) >= 900 } ?? true }
}
struct DeviceStatusWidgetView: View {
    let entry: DeviceStatusEntry
    var inline = false
    private var items: [DeviceWidgetItem] { entry.snapshot?.items ?? [] }
    var body: some View {
        Group {
            if inline {
                Label(entry.message ?? (entry.stale ? "Device status needs refresh" : items.isEmpty ? "No device time or overrides" : "\(items.count) devices · \(items.first?.person ?? "")"), systemImage: "gamecontroller")
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Label("Device access", systemImage: "gamecontroller.fill").font(.headline)
                        Spacer(minLength: 0)
                        if items.count > 2 { Text("+\(items.count - 2)").font(.caption) }
                    }
                    if let message = entry.message { Text(message).font(.caption) }
                    else if entry.stale { Text("Status needs refresh").font(.caption) }
                    else if items.isEmpty { Text("No active time or overrides").font(.caption) }
                    else {
                        ForEach(items.prefix(2)) { item in
                            HStack(spacing: 4) {
                                Text(item.person.isEmpty ? item.device : "\(item.person) · \(item.device)").lineLimit(1)
                                Spacer(minLength: 0)
                                if let end = item.endsAt, end > entry.date {
                                    Text(timerInterval: entry.date...end, countsDown: true).monospacedDigit().multilineTextAlignment(.trailing).frame(maxWidth: 62)
                                } else { Text(item.label(at: entry.date)).lineLimit(1) }
                            }.font(.caption).accessibilityElement(children: .combine)
                        }
                    }
                    if let checked = entry.snapshot?.checkedAt {
                        HStack(spacing: 3) { Text("Checked"); Text(checked, style: .time) }.font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .privacySensitive()
        .containerBackground(.fill.tertiary, for: .widget)
        .widgetURL(URL(string: "familyframe://devices"))
    }
}
