// AascLiveActivityWidget.swift — draws the Live Activity the app starts (LiveActivityBridge.swift). Lock screen and
// expanded island: the Mac's name and task count, the lead session (bold title, timer, a preview line), then the
// rest by urgency. Compact island (also the Mac menu bar): the glyph, ringed amber when a session needs you, and then (Nov 18
// 2026) the waiting kind's icon (✋ approval, 💬 question, ▶ proceed) with a count when more than one waits. Timers are `Text(timerInterval:)`, which iOS keeps
// counting while the app is suspended; everything else is what the content state holds (LiveActivityRules clamped it).
import ActivityKit
import SwiftUI
import WidgetKit

private enum Palette {
    static let needs = Color(red: 1.0, green: 0.72, blue: 0.2)
    static let working = Color(red: 0.25, green: 0.85, blue: 1.0)
    static let done = Color.white.opacity(0.6)
    static let idle = Color.white.opacity(0.45)
}

private struct Mark: View {
    let mark: String

    var body: some View {
        switch mark {
        case "needs":
            Image(systemName: "exclamationmark").font(.system(size: 15, weight: .heavy)).foregroundStyle(Palette.needs)
        case "approval":
            // A tool waits for Allow / Deny (Nov 18 2026; "!" before, which an older Mac's rows still get).
            Image(systemName: "hand.raised.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.needs)
        case "input":
            // A question waits for an answer.
            Image(systemName: "questionmark.bubble.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.needs)
        case "working":
            Image(systemName: "circle.fill").font(.system(size: 9)).foregroundStyle(Palette.working)
        case "proceed":
            // An amber ▶ ("go on") on a session whose answer asks the user to reply "proceed" (the app's amber P;
            // the island drew it as a letter until Nov 15 2026, which read as "paused" / "parking").
            Image(systemName: "play.fill").font(.system(size: 12, weight: .heavy)).foregroundStyle(Palette.needs)
        case "idle":
            Image(systemName: "moon.zzz").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.idle)
        default:
            Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.done)
        }
    }
}

private struct AppGlyph: View {
    var size: CGFloat = 30
    /// Amber ring: a session waits on you (the compact island's only cue since it lost its timer).
    var needsYou = false

    var body: some View {
        Image(systemName: "apple.terminal")
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white.opacity(0.85))
            .frame(width: size, height: size)
            .background(Circle().strokeBorder(needsYou ? Palette.needs : .white.opacity(0.5), lineWidth: needsYou ? 2 : 1.5))
    }
}

/// "1 task" / "2 tasks" (working), "1 needs you" (waiting, which wins), "Idle" (every session idle) or "Finished".
private func headerText(_ card: LiveActivityCard) -> String {
    if card.needs > 0 { return "\(card.needs) needs you" }
    if card.working > 0 { return card.working == 1 ? "1 task" : "\(card.working) tasks" }
    return card.headline == "idle" ? "Idle" : "Finished"
}

/// A row that waits on you: a request (of a known kind or not) or a "proceed" owed. Drawn amber, timer included.
private func waitsOnYou(_ mark: String) -> Bool {
    ["needs", "approval", "input", "proceed"].contains(mark)
}

/// The island's mark: what the lead waits for if anything waits on you (✋ / 💬 / ! / ▶; the Mac puts requests first,
/// then "proceed" asks, so the lead is the most urgent), else working, else idle or done.
private func restingMark(_ card: LiveActivityCard) -> String {
    if card.needs > 0 {
        guard let lead = card.rows.first?.mark, waitsOnYou(lead) else { return "needs" }
        return lead
    }
    if card.working > 0 { return "working" }
    return card.headline == "idle" ? "idle" : "done"
}

private func headerColor(_ card: LiveActivityCard) -> Color {
    card.needs > 0 ? Palette.needs : .white.opacity(0.6)
}

/// Elapsed time since `start`, ticking on its own: "0:12", "1:40", "1:02:03".
private struct Elapsed: View {
    let start: Date
    var color: Color = .white.opacity(0.6)

    var body: some View {
        Text(timerInterval: start...Date.distantFuture, countsDown: false)
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
            .foregroundStyle(color)
    }
}

/// How tightly the card is drawn. The lock screen (Nov 28 2026) packs more sessions into iOS's 160 pt cap: the lead
/// plus four rows under a lead with a preview line, plus five without one (measured: 152 pt and 151 pt; the lead plus
/// five under a preview line is 169 pt, which iOS clips). The expanded island, with less room under its header
/// regions, keeps the roomier look and the lead plus three.
private struct Density {
    let restLimit: Int
    let restLimitNoDetail: Int
    let rowFont: CGFloat
    let rowSpacing: CGFloat
    let leadGap: CGFloat

    /// 5 = LiveActivityRules.maxRows − 1 (that file is the app's, not this extension's).
    static let lockScreen = Density(restLimit: 4, restLimitNoDetail: 5, rowFont: 13, rowSpacing: 1, leadGap: 4)
    static let island = Density(restLimit: 3, restLimitNoDetail: 3, rowFont: 14, rowSpacing: 4, leadGap: 6)

    func rest(_ card: LiveActivityCard) -> Int { card.rows.first?.detail == nil ? restLimitNoDetail : restLimit }
}

private struct Header: View {
    let card: LiveActivityCard

    var body: some View {
        HStack(spacing: 10) {
            AppGlyph(size: 22)
            Text(card.mac).font(.system(size: 15, weight: .medium)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
            Spacer(minLength: 8)
            Text(headerText(card))
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(headerColor(card))
                .lineLimit(1)
        }
    }
}

/// The lead session: bold title with its timer, then a grey preview line. A working lead has no mark, like the
/// title of a running task; one that waits on you keeps its "!" (or ▶), a finished one its ✓, an idle one its moon.
private struct Lead: View {
    let row: LiveActivityRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Mark(mark: row.mark).opacity(row.mark == "working" ? 0 : 1).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(row.title)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    if let start = row.startedAt {
                        Elapsed(start: start, color: waitsOnYou(row.mark) ? Palette.needs : .white.opacity(0.6))
                            .font(.system(size: 15, weight: .semibold))
                            .frame(maxWidth: 70, alignment: .trailing)
                    }
                }
                if let detail = row.detail {
                    Text(detail)
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
        }
    }
}

/// The rows after the lead, as many as `density` allows; "+N more" rides on the last one (it also counts the rows
/// this view leaves out), because the lock screen caps an activity at 160 pt.
private struct Rows: View {
    let card: LiveActivityCard
    let density: Density

    private var rest: [LiveActivityRow] { Array(card.rows.dropFirst().prefix(density.rest(card))) }
    private var more: Int { card.more + max(0, card.rows.count - 1 - density.rest(card)) }

    var body: some View {
        VStack(alignment: .leading, spacing: density.rowSpacing) {
            ForEach(Array(rest.enumerated()), id: \.offset) { index, row in
                HStack(spacing: 10) {
                    // A fixed height, so a tall mark (the 15 pt "!") can't make one row taller than the others.
                    Mark(mark: row.mark).frame(width: 24, height: density.rowFont + 3)
                    Text(row.title)
                        .font(.system(size: density.rowFont))
                        .foregroundStyle(.white.opacity(row.mark == "idle" ? 0.5 : row.mark == "done" ? 0.65 : 0.9))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 6)
                    if let start = row.startedAt {
                        Elapsed(start: start).font(.system(size: 13)).frame(maxWidth: 64, alignment: .trailing)
                    }
                    if index == rest.count - 1 && more > 0 {
                        Text("+\(more) more").font(.system(size: 13)).foregroundStyle(.white.opacity(0.5)).fixedSize()
                    }
                }
            }
        }
    }
}

private struct CardBody: View {
    let card: LiveActivityCard
    let density: Density

    var body: some View {
        VStack(alignment: .leading, spacing: density.leadGap) {
            if let lead = card.rows.first { Lead(row: lead) }
            Rows(card: card, density: density)
        }
    }
}

private struct LockScreenCard: View {
    let card: LiveActivityCard

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Header(card: card)
            CardBody(card: card, density: .lockScreen)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}

struct AascLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AascActivityAttributes.self) { context in
            LockScreenCard(card: context.state)
                .activityBackgroundTint(Color.black.opacity(0.45))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        AppGlyph(size: 24)
                        Text(context.state.mac).font(.system(size: 15, weight: .medium)).foregroundStyle(.white.opacity(0.7))
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(headerText(context.state))
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(headerColor(context.state))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    CardBody(card: context.state, density: .island).padding(.top, 6)
                }
            } compactLeading: {
                AppGlyph(size: 22, needsYou: context.state.needs > 0)
            } compactTrailing: {
                // No timer (Nov 2 2026): macOS 26 mirrors this compact island in the menu bar, where "glyph + 15:43"
                // was too wide; the expanded view still shows every timer. When something waits on you (Nov 18 2026),
                // the waiting kind's icon and, past one, how many: one glyph and a digit stay narrow.
                if context.state.needs > 0 {
                    HStack(spacing: 2) {
                        Mark(mark: restingMark(context.state))
                        if context.state.needs > 1 {
                            Text("\(min(context.state.needs, 99))")
                                .font(.system(size: 13, weight: .bold)).monospacedDigit().foregroundStyle(Palette.needs)
                        }
                    }
                } else {
                    EmptyView()
                }
            } minimal: {
                Mark(mark: restingMark(context.state))
            }
        }
    }
}
