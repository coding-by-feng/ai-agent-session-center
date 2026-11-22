// CallLayerRules.swift — what the floating call bubble may show (CallLayerPlugin.swift, Nov 22 2026). The Swift twin
// of CallLayerRules in android/.../CallLayerRules.kt. Foundation only, so RulesTests checks it without Xcode.
import Foundation

enum CallLayerRules {
    enum BubbleState: Equatable { case live, paused, muted }

    static let labelMax = 12

    /// The clock ("12:05") or a word ("Paused"): letters, digits, ':' and spaces, at most `labelMax`; else "Call".
    static func label(_ raw: String?) -> String {
        guard let raw else { return "Call" }
        let text = raw.trimmingCharacters(in: .whitespaces)
        let ok = !text.isEmpty && text.count <= labelMax && text.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == ":" || $0 == " "
        }
        return ok ? text : "Call"
    }

    static func state(_ raw: String?) -> BubbleState {
        switch raw {
        case "paused": return .paused
        case "muted": return .muted
        default: return .live
        }
    }
}
