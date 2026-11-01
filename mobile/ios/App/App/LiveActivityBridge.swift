// LiveActivityBridge.swift — the lock-screen Live Activity's app half (Oct 31 2026). The Mac page posts its card to
// `window.webkit.messageHandlers.aascLiveActivity` (useLiveActivityFeed.ts); this checks the poster is a paired Mac's
// main frame (LiveActivityRules) and starts, updates or ends the one activity. Updates are local only: once iOS
// suspends the app nothing feeds the card, so each update carries a stale date and iOS dims it after that. Updates
// while the app is suspended would need ActivityKit push through APNs (the paid Apple Developer Program).
import ActivityKit
import Foundation
import WebKit

final class LiveActivityBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "aascLiveActivity"
    /// How long a card is current without a newer one before iOS shows it as stale.
    static let staleAfter: TimeInterval = 15 * 60

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        let origin = message.frameInfo.securityOrigin
        let page = "\(origin.protocol)://\(origin.host):\(origin.port)"
        let saved = UserDefaults.standard.string(forKey: LiveActivityRules.macsDefaultsKey)
        guard let mac = LiveActivityRules.macName(origin: page, savedMacs: saved),
              let card = LiveActivityRules.card(message.body, mac: mac) else { return }
        // WebKit delivers script messages on the main thread.
        if #available(iOS 16.2, *) { MainActor.assumeIsolated { LiveActivityController.show(card) } }
    }
}

@available(iOS 16.2, *)
@MainActor
enum LiveActivityController {
    /// The change in flight: each one waits for the one before, so cards land in the order they were posted.
    private static var last: Task<Void, Never>?

    /// No rows ends every running activity; otherwise the first one is updated, or one is started.
    static func show(_ card: LiveActivityCard) {
        let previous = last
        last = Task {
            await previous?.value
            await apply(card)
        }
    }

    private static func apply(_ card: LiveActivityCard) async {
        // `activities` still lists ones iOS has ended (the 8-hour limit) while they linger on the lock screen.
        let running = Activity<AascActivityAttributes>.activities
            .filter { $0.activityState == .active || $0.activityState == .stale }
        if card.rows.isEmpty {
            for activity in running { await activity.end(nil, dismissalPolicy: .immediate) }
            return
        }
        let content = ActivityContent(state: card, staleDate: Date().addingTimeInterval(LiveActivityBridge.staleAfter))
        if let current = running.first {
            await current.update(content)
            for extra in running.dropFirst() { await extra.end(nil, dismissalPolicy: .immediate) }
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        do {
            let started = try Activity.request(attributes: AascActivityAttributes(), content: content, pushType: nil)
            #if DEBUG
            NSLog("AASC Live Activity started: %@", started.id)
            #endif
        } catch {
            NSLog("AASC Live Activity not started: %@", error.localizedDescription)
        }
    }

    #if DEBUG
    /// `-AASCLiveActivityDemo` (Xcode scheme or `simctl launch`): a sample card, to check the drawing without a Mac;
    /// `-AASCLiveActivityDemoIdle`: one where every session is idle.
    static func showDemoIfAsked() {
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains("-AASCLiveActivityDemo") || arguments.contains("-AASCLiveActivityDemoIdle") else { return }
        NSLog("AASC Live Activity demo: enabled=%d running=%d", ActivityAuthorizationInfo().areActivitiesEnabled ? 1 : 0,
              Activity<AascActivityAttributes>.activities.count)
        if arguments.contains("-AASCLiveActivityDemoIdle") {
            show(LiveActivityCard(
                mac: "kason-mac.local", headline: "idle",
                rows: [
                    LiveActivityRow(mark: "idle", title: "Compare Claude and Vultr pricing",
                                    detail: "Vultr is cheaper for the 4 GB tier; Claude's plan covers the rest"),
                    LiveActivityRow(mark: "idle", title: "Write xclaude RedNote bio"),
                    LiveActivityRow(mark: "idle", title: "Remove Word Duel History"),
                ],
                more: 2, needs: 0, working: 0))
            return
        }
        let now = Date()
        show(LiveActivityCard(
            mac: "kason-mac.local", headline: "working",
            rows: [
                LiveActivityRow(mark: "working", title: "Add Auckland Regions Learning Game",
                                startedAt: now.addingTimeInterval(-96),
                                detail: "The main interaction will be selecting a place, reading its story"),
                LiveActivityRow(mark: "working", title: "Compare Claude and Vultr pricing", startedAt: now.addingTimeInterval(-48)),
                LiveActivityRow(mark: "done", title: "Write xclaude RedNote bio"),
                LiveActivityRow(mark: "idle", title: "Remove Word Duel History"),
            ],
            more: 3, needs: 0, working: 2))
    }
    #endif
}
