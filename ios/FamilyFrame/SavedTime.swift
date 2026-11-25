import SwiftUI

/// A child's earned Internet time. "Saved" time is banked up to the household
/// cap; a reward earned at the cap is use-it-or-lose-it and counted separately.
/// Mirrors `dashboard/family/js/saved-time.js`.
struct SavedTime: Equatable {
    /// Spendable credits, soonest to expire first, so spending never lets an older one lapse.
    let credits: [RewardCredit]
    let capMinutes: Int?
    var next: RewardCredit? { credits.first }
    var savedMinutes: Int { credits.filter { !$0.isUseOrLose }.reduce(0) { $0 + $1.minutes } }
    var todayOnlyMinutes: Int { credits.filter(\.isUseOrLose).reduce(0) { $0 + $1.minutes } }
    var totalMinutes: Int { savedMinutes + todayOnlyMinutes }
    var isFull: Bool { capMinutes.map { savedMinutes >= $0 } ?? false }
    var fraction: Double { capMinutes.map { $0 > 0 ? min(1, Double(savedMinutes) / Double($0)) : 0 } ?? 0 }

    init(credits: [RewardCredit], personID: String, capMinutes: Int?, now: Date) {
        self.credits = credits.filter { $0.personId == personID && $0.status == "available" && (Dates.instant($0.expiresAt) ?? .distantPast) > now }
            .sorted { (Dates.instant($0.expiresAt) ?? .distantFuture) < (Dates.instant($1.expiresAt) ?? .distantFuture) }
        self.capMinutes = capMinutes
    }

    /// "2 h 30 min", "45 min", "10 h".
    static func label(_ minutes: Int) -> String {
        let total = max(0, minutes), hours = total / 60, rest = total % 60
        return [hours > 0 ? "\(hours) h" : nil, rest > 0 || hours == 0 ? "\(rest) min" : nil].compactMap { $0 }.joined(separator: " ")
    }
    /// The sentence a child reads right after earning a reward.
    func earnedMessage(for credit: RewardCredit) -> String {
        if credit.isUseOrLose {
            return "You've maxed out how much time you can save\(capMinutes.map { " (\(Self.label($0)))" } ?? ""). The \(Self.label(credit.minutes)) you just earned is use it or lose it: use it today, or it is gone at midnight."
        }
        return "Use it now, or save it. You have \(Self.label(savedMinutes)) saved\(capMinutes.map { " of \(Self.label($0))" } ?? "")."
    }
}

/// The child's time bank on Today and Devices: the balance, how full the bank
/// is, and one button that goes straight to picking a device.
struct SavedTimeCard: View {
    @ObservedObject var network: InternetModel
    @State private var selected: RewardCredit?
    var body: some View {
        if network.isChild, network.snapshot != nil, let person = network.personID {
            let time = network.savedTime(for: person)
            let canStart = network.canChange && network.integrationReady && !network.rewardDevices(for: person).isEmpty
            VStack(alignment: .leading, spacing: 12) {
                Text("MY SAVED TIME").font(.caption.weight(.bold)).foregroundStyle(Brand.instrumentMuted)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(SavedTime.label(time.savedMinutes)).font(.system(size: 40, weight: .bold, design: .monospaced)).foregroundStyle(.white)
                        .contentTransition(.numericText()).minimumScaleFactor(0.6).lineLimit(1)
                    if let cap = time.capMinutes { Text(time.isFull ? "full · \(SavedTime.label(cap)) max" : "of \(SavedTime.label(cap))").font(.subheadline).foregroundStyle(Brand.instrumentMuted) }
                }
                if time.capMinutes != nil {
                    ProgressView(value: time.fraction).tint(time.isFull ? .orange : Brand.primary).accessibilityLabel("Saved time").accessibilityValue("\(Int(time.fraction * 100)) percent full")
                }
                if time.todayOnlyMinutes > 0 {
                    Label("Plus \(SavedTime.label(time.todayOnlyMinutes)) to use today or lose", systemImage: "hourglass").font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
                }
                if let next = time.next {
                    Button { selected = next } label: { Text("Use time").font(.headline).frame(maxWidth: .infinity, minHeight: 50) }
                        .foregroundStyle(.black).background(Brand.mint.opacity(canStart ? 1 : 0.45), in: RoundedRectangle(cornerRadius: 14)).disabled(!canStart)
                    if !canStart { Text(network.liveSessions.contains { $0.personId == person } ? "Your time is already running." : "No device is free right now. Your time stays saved.").font(.caption).foregroundStyle(Brand.instrumentMuted) }
                } else {
                    Text(network.rewardsPaused(for: person) ? "Rewards are paused by a parent." : "Finish today's tasks to earn \(SavedTime.label(network.rewardMinutes(for: person))).").font(.subheadline).foregroundStyle(Brand.instrumentMuted)
                }
            }
            .padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(Brand.instrument, in: RoundedRectangle(cornerRadius: 16))
            .overlay(alignment: .top) { Rectangle().fill(Brand.primary).frame(height: 3).clipShape(RoundedRectangle(cornerRadius: 2)).padding(.horizontal, 16) }
            .accessibilityElement(children: .contain)
            .sheet(item: $selected) { RewardDevicePicker(network: network, credit: $0) }
        }
    }
}

/// What a parent sees for each child: the balance the child sees.
struct SavedTimeSummaryLine: View {
    @ObservedObject var network: InternetModel
    let personID: String
    var body: some View {
        let time = network.savedTime(for: personID)
        Text("Saved: \(SavedTime.label(time.savedMinutes))\(time.capMinutes.map { " of \(SavedTime.label($0))" } ?? "")\(time.todayOnlyMinutes > 0 ? " · plus \(SavedTime.label(time.todayOnlyMinutes)) to use today" : "")")
            .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.ink)
    }
}
