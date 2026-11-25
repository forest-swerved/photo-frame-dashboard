import SwiftUI

/// A parent marks a task with a deadline as an alarm. The alarm itself rings
/// only on the paired family frame; this app sets the option and never rings.
struct TaskAlarmToggle: View {
    @Binding var isOn: Bool
    var body: some View {
        Toggle("Sound an alarm on the frame until it is done", isOn: $isOn)
        if isOn {
            Text("The family frame rings from the due time until the child confirms the task there. Snooze lasts 10 minutes. Excusing the task for the day also stops it.")
                .font(.caption).foregroundStyle(Brand.muted)
        }
    }
}
