import SwiftUI
import UIKit
import AVFoundation

/// A parent-set task alarm. It is active on the task's own household day from
/// its due time until the task leaves "pending", and silent only while snoozed.
/// Mirrors `dashboard/server/task-alarms.js`.
enum TaskAlarm {
    static let snoozeMinutes = 10
    struct State: Equatable {
        var active = false
        var snoozedUntil: Date?
        var ringing: Bool { active && snoozedUntil == nil }
    }
    static func state(of occurrence: ChoreOccurrence, today: String, zone: TimeZone, now: Date) -> State {
        guard occurrence.alarm, occurrence.status == "pending", occurrence.date == today, let time = occurrence.dueTime,
              let due = Dates.wallTime(time, on: occurrence.date, in: zone), due <= now else { return State() }
        let snooze = occurrence.alarmSnoozedUntil.flatMap(Dates.instant)
        return State(active: true, snoozedUntil: snooze.flatMap { $0 > now ? $0 : nil })
    }
}

extension ChoreOccurrence {
    /// A snooze changes without a new version. When two copies share a version, keep the later snooze.
    func keepingLaterSnooze(from other: ChoreOccurrence?) -> ChoreOccurrence {
        guard let other, other.id == id, other.version == version, let theirs = other.alarmSnoozedUntil, theirs > (alarmSnoozedUntil ?? "") else { return self }
        var copy = self; copy.alarmSnoozedUntil = theirs; return copy
    }
}

struct TaskAlarmToggle: View {
    @Binding var isOn: Bool
    var body: some View {
        Toggle("Sound an alarm until it is done", isOn: $isOn)
        if isOn {
            Text("Rings on the family frame and the child's phone from the due time until the child confirms the task. Snooze lasts \(TaskAlarm.snoozeMinutes) minutes. Excusing the task for the day also stops it.")
                .font(.caption).foregroundStyle(Brand.muted)
        }
    }
}

/// Loops the bundled alarm tone while the app is in front. The playback audio
/// session keeps it audible with the ring/silent switch off.
@MainActor
final class TaskAlarmPlayer {
    private var player: AVAudioPlayer?
    var isPlaying: Bool { player?.isPlaying == true }
    func start() {
        guard !isPlaying, let url = Bundle.main.url(forResource: "task-alarm", withExtension: "caf") else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.duckOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            let next = try AVAudioPlayer(contentsOf: url)
            next.numberOfLoops = -1; next.volume = 1; next.play(); player = next
        } catch { player = nil } // A silent alarm still shows; sound must never block the screen.
    }
    func stop() {
        guard player != nil else { return }
        player?.stop(); player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}

/// Shows the alarm in its own window above every sheet, and keeps it there
/// until the child confirms the task or snoozes it.
@MainActor
final class TaskAlarmPresenter {
    static let shared = TaskAlarmPresenter()
    private var window: UIWindow?
    private var shownID: String?
    private let player = TaskAlarmPlayer()
    func sync(_ model: AppModel, active: Bool) {
        guard active, let alarm = model.ringingAlarm() else { hide(); return }
        if shownID != alarm.id { show(alarm, model: model) }
        if model.changingChores.contains(alarm.id) { player.stop() } else { player.start() }
    }
    private func show(_ alarm: ChoreOccurrence, model: AppModel) {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }) else { return }
        let host = UIHostingController(rootView: TaskAlarmScreen(occurrence: alarm).environmentObject(model))
        host.view.backgroundColor = .clear
        let next = window ?? UIWindow(windowScene: scene)
        next.windowLevel = .alert + 1; next.rootViewController = host; next.isHidden = false
        window = next; shownID = alarm.id
        UIAccessibility.post(notification: .screenChanged, argument: "Alarm: \(alarm.title)")
    }
    func hide() {
        player.stop(); shownID = nil
        window?.isHidden = true; window?.rootViewController = nil; window = nil
    }
}

struct TaskAlarmScreen: View {
    @EnvironmentObject var model: AppModel
    let occurrence: ChoreOccurrence
    @State private var note: String?
    private var current: ChoreOccurrence { model.currentOccurrence(occurrence) }
    private var working: Bool { model.changingChores.contains(occurrence.id) }
    var body: some View {
        ZStack {
            Brand.instrument.ignoresSafeArea()
            VStack(spacing: 20) {
                Spacer()
                Image(systemName: "alarm.waves.left.and.right.fill").font(.system(size: 72)).foregroundStyle(Brand.coral)
                    .symbolEffect(.pulse, options: .repeating).accessibilityHidden(true)
                if let time = occurrence.dueTime, let due = Dates.wallTime(time, on: occurrence.date, in: model.zone) {
                    Text(Dates.time(due, in: model.zone)).font(.title3.weight(.semibold)).foregroundStyle(Brand.instrumentMuted)
                }
                Text(occurrence.title).font(.system(size: 44, weight: .bold)).multilineTextAlignment(.center).foregroundStyle(.white)
                    .minimumScaleFactor(0.5).accessibilityAddTraits(.isHeader)
                Text("This alarm keeps ringing until you confirm it is done.").font(.body).multilineTextAlignment(.center).foregroundStyle(Brand.instrumentMuted)
                if let note { Text(note).font(.callout.weight(.semibold)).multilineTextAlignment(.center).foregroundStyle(.black).padding(12).frame(maxWidth: .infinity).background(Color.yellow, in: RoundedRectangle(cornerRadius: 12)) }
                Spacer()
                Button { Task { await done() } } label: {
                    Text(working ? "Saving…" : "Done").font(.title.bold()).frame(maxWidth: .infinity, minHeight: 76)
                }.foregroundStyle(.black).background(Brand.mint, in: RoundedRectangle(cornerRadius: 18)).disabled(working)
                Button { Task { await snooze() } } label: {
                    Text("Snooze \(TaskAlarm.snoozeMinutes) minutes").font(.title3.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 60)
                }.foregroundStyle(.white).background(Color.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 18)).disabled(working)
            }.padding(24)
        }.sensoryFeedback(.warning, trigger: occurrence.id)
    }
    private func done() async {
        note = nil
        if model.isStale || model.snapshot?.date != model.today { await model.refresh() }
        let task = current
        guard task.status == "pending" else { return } // Already confirmed elsewhere; the screen closes by itself.
        if await model.toggleOccurrence(task) { UINotificationFeedbackGenerator().notificationOccurred(.success) }
        else { note = "That did not save. Check your connection and tap Done again."; model.message = nil }
    }
    private func snooze() async {
        note = nil
        if !(await model.snoozeAlarm(current)) { note = "Snooze did not save. Check your connection and try again." }
    }
}
