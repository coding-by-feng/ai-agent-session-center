// LiveActivityCard.swift — the Live Activity's content (= src/lib/liveActivityCard.ts plus the Mac's saved name):
// ActivityKit's ContentState (AascActivityAttributes.swift). Compiled into the app and the AascLiveActivity extension;
// Foundation only, so RulesTests uses it without Xcode.
import Foundation

/// One session line on the card.
struct LiveActivityRow: Codable, Hashable {
    /// "needs" (approval / input), "working" (prompting / working), "done" (waiting), "idle" (idle) or "proceed" (its
    /// answer asks the user to reply "proceed"); LiveActivityRules turns the Mac's flagged done rows into the last two.
    let mark: String
    let title: String
    /// When the turn (working), request (needs) or "proceed" ask (proceed) began: the widget draws a timer from it, which iOS keeps counting
    /// while the app is suspended. Nil on done rows and on cards from a Mac that predates it.
    var startedAt: Date? = nil
    /// The lead (first) row only: its latest response, tool call or question, one line.
    var detail: String? = nil
}

/// The card's content: ActivityKit's ContentState (AascActivityAttributes.swift).
struct LiveActivityCard: Codable, Hashable {
    let mac: String
    /// "needs", "working", "finished" or "idle" (every live session idle; LiveActivityRules derives it).
    let headline: String
    /// The lead row (waiting on you, else working, else the last to finish) first, then the latest others.
    let rows: [LiveActivityRow]
    let more: Int
    let needs: Int
    let working: Int
}
