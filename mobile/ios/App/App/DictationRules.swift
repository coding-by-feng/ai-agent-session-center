// DictationRules.swift — what the hold-to-talk mic's message handler accepts and answers (Nov 16 2026). The Mac
// page posts `{ id, action }` (`start` / `stop` / `cancel`) to `aascDictation` (src/lib/phoneDictation.ts);
// DictationBridge records one clip at a time for a paired Mac's main frame and answers with an `aasc-dictation`
// window event. Foundation only, so RulesTests checks it without Xcode.
import Foundation

enum DictationAction: String {
    case start, stop, cancel
}

struct DictationRequest: Equatable {
    let id: String
    let action: DictationAction
}

enum DictationRules {
    /// The longest clip: recording stops by itself and the clip is handed over.
    static let maxSeconds: TimeInterval = 120
    /// A shorter hold is a tap, not speech: nothing is handed over.
    static let minSeconds: TimeInterval = 0.4
    /// A clip is about 4 kB a second; one far above two minutes' worth is not handed to the page.
    static let maxBytes = 1_500_000
    static let mime = "audio/mp4"
    /// A recording starts only this soon after a finger went down on the screen. The Mac's page is plain http,
    /// so a script put into it could post `start` by itself; it can't put a finger on the glass.
    static let touchGraceSeconds: TimeInterval = 1.5

    /// The posted id when it is well formed: a refused request is still answered, or the page's button waits.
    static func postedId(_ body: Any?) -> String? {
        guard let id = (body as? [String: Any])?["id"] as? String,
              id.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil else { return nil }
        return id
    }

    /// The request out of a posted body; nil for anything else.
    static func request(_ body: Any?) -> DictationRequest? {
        guard let object = body as? [String: Any], let id = postedId(object),
              let raw = object["action"] as? String, let action = DictationAction(rawValue: raw) else { return nil }
        return DictationRequest(id: id, action: action)
    }

    /// Did a finger go down recently enough for a `start` to be the person's own? Times are uptime seconds.
    static func touched(lastDown: TimeInterval?, now: TimeInterval) -> Bool {
        guard let lastDown, lastDown.isFinite, now.isFinite else { return false }
        let since = now - lastDown
        return since >= 0 && since <= touchGraceSeconds
    }

    /// Is a hold of `seconds` long enough to hold speech?
    static func longEnough(_ seconds: TimeInterval) -> Bool {
        seconds.isFinite && seconds >= minSeconds
    }

    /// May a clip of `bytes` be handed to the page?
    static func fits(_ bytes: Int) -> Bool {
        bytes > 0 && bytes <= maxBytes
    }

    /// The `aasc-dictation` window event's script for one outcome. The detail is JSON-encoded, never spliced.
    static func outcomeScript(id: String, state: String, fields: [String: Any] = [:]) -> String? {
        var detail: [String: Any] = fields
        detail["id"] = id
        detail["state"] = state
        guard JSONSerialization.isValidJSONObject(detail),
              let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return "window.dispatchEvent(new CustomEvent('aasc-dictation', { detail: \(json) }))"
    }
}
