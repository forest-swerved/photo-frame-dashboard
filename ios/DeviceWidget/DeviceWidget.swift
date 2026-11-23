import SwiftUI
import WidgetKit

final class WidgetRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct DeviceStatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> DeviceStatusEntry { preview }
    private var preview: DeviceStatusEntry {
        DeviceStatusEntry(date: .now, snapshot: DeviceWidgetSnapshot(checkedAt: .now, items: [DeviceWidgetItem(id: "preview", device: "Game console", person: "Device time", status: "Time running", defaultOffOn: true, endsAt: .now.addingTimeInterval(1800), preparationEndsAt: nil)]))
    }
    func getSnapshot(in context: Context, completion: @escaping (DeviceStatusEntry) -> Void) {
        if context.isPreview { completion(preview) } else { Task { completion(await fetch()) } }
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<DeviceStatusEntry>) -> Void) {
        Task {
            let entry = await fetch()
            let next = Date().addingTimeInterval(900)
            var entries = [entry]
            // Scheduled transitions stop the timer at zero; zero never means blocking.
            let transitions = (entry.snapshot?.items ?? []).flatMap { [$0.endsAt, $0.preparationEndsAt].compactMap { $0 } }
            for date in Set(transitions + [next]).sorted() where date > entry.date && date <= next {
                entries.append(DeviceStatusEntry(date: date, snapshot: entry.snapshot, message: entry.message))
            }
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }
    private func fetch() async -> DeviceStatusEntry {
        guard let credential = DeviceWidgetStore.load(),
              let base = Bundle.main.object(forInfoDictionaryKey: "FamilyAPIBaseURL") as? String,
              let url = URL(string: base + "/api/widget/devices"), url.scheme == "https" else {
            return DeviceStatusEntry(date: .now, snapshot: nil, message: "Open Family Frame")
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 12; config.timeoutIntervalForResource = 15
        config.urlCache = nil; config.httpCookieStorage = nil
        let session = URLSession(configuration: config, delegate: WidgetRedirectGuard(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.setValue("FamilyWidget \(credential.token)", forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await session.data(for: request)
            guard DeviceWidgetStore.load() == credential else { return DeviceStatusEntry(date: .now, snapshot: nil, message: "Open Family Frame") }
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            if [401, 403].contains(http.statusCode) { return DeviceStatusEntry(date: .now, snapshot: nil, message: "Open app to reconnect") }
            guard http.statusCode == 200, data.count < 250_000 else { throw URLError(.badServerResponse) }
            struct Envelope: Decodable { let data: DeviceWidgetSnapshot }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .custom { decoder in
                let value = try decoder.singleValueContainer().decode(String.self)
                let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                guard let date = format.date(from: value) else { throw URLError(.cannotParseResponse) }
                return date
            }
            let snapshot = try decoder.decode(Envelope.self, from: data).data
            // Adjust server deadlines to this device's clock rather than assuming clock agreement.
            let received = Date(), offset = received.timeIntervalSince(snapshot.checkedAt)
            let adjusted = DeviceWidgetSnapshot(checkedAt: received, items: snapshot.items.map {
                DeviceWidgetItem(id: $0.id, device: $0.device, person: $0.person, status: $0.status, defaultOffOn: $0.defaultOffOn,
                                 endsAt: $0.endsAt?.addingTimeInterval(offset), preparationEndsAt: $0.preparationEndsAt?.addingTimeInterval(offset))
            })
            return DeviceStatusEntry(date: received, snapshot: adjusted)
        } catch { return DeviceStatusEntry(date: .now, snapshot: nil, message: "Status unavailable · open app") }
    }
}
struct DeviceStatusContainer: View {
    @Environment(\.widgetFamily) private var family
    let entry: DeviceStatusEntry
    var body: some View { DeviceStatusWidgetView(entry: entry, inline: family == .accessoryInline) }
}
struct FamilyDeviceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: DeviceWidgetStore.kind, provider: DeviceStatusProvider()) { DeviceStatusContainer(entry: $0) }
            .configurationDisplayName("Device access")
            .description("Kids’ device timers and default-off devices with Internet on. Tap to view current status.")
            .supportedFamilies([.accessoryRectangular, .accessoryInline, .systemSmall])
    }
}

@main
struct FamilyDeviceWidgets: WidgetBundle {
    var body: some Widget { DeviceLiveActivity(); FamilyDeviceWidget() }
}
