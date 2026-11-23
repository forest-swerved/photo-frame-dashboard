import ActivityKit
import WidgetKit
import SwiftUI

struct DeviceLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DeviceAccessActivityAttributes.self) { context in
            DeviceAccessLiveView(state: context.state, stale: context.isStale)
                .activityBackgroundTint(Color(red: 0.03, green: 0.09, blue: 0.15))
                .activitySystemActionForegroundColor(.white)
                .foregroundStyle(.white)
                .widgetURL(URL(string: "familyframe://devices"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    DeviceAccessLiveView(state: context.state, stale: context.isStale)
                }
            } compactLeading: {
                Image(systemName: "gamecontroller.fill")
            } compactTrailing: {
                if !context.isStale, let end = context.state.items.first?.end, end > Date() {
                    Text(timerInterval: Date()...end, countsDown: true).monospacedDigit().frame(width: 55)
                } else { Text(context.isStale ? "?" : "\(context.state.totalCount)") }
            } minimal: {
                Image(systemName: "gamecontroller.fill")
            }.widgetURL(URL(string: "familyframe://devices"))
        }
    }
}
