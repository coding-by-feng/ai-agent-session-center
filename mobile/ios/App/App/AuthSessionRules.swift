// AuthSessionRules.swift — what the AuthSession plugin may open and which callback it hands back (plan 17,
// security rule 6). Foundation only, so mobile/ios/RulesTests checks it without Xcode. The Kotlin twin is
// AuthSessionRules.kt.
//
// The session opens only the backend's own https pages (Google sign-in start on api.aasc.work), and the
// callback scheme is the app's bundle id, which is deliberately NOT registered in Info.plist: only the
// ASWebAuthenticationSession sees it, so no other app can claim it (plan 08 §5).
import Foundation

enum AuthSessionRules {
    static let callbackScheme = "work.aasc.mobile"
    static let defaultCallbackPrefix = "work.aasc.mobile://auth/google"
    static let urlMax = 4096
    private static let host = "api.aasc.work"

    /// The page to open: `https://api.aasc.work/<path>` with no userinfo or port. Returns the URL or nil.
    static func startUrl(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty, raw.utf8.count <= urlMax,
              !raw.unicodeScalars.contains(where: { $0.value <= 0x20 || $0.value == 0x7F }),
              let parts = URLComponents(string: raw),
              parts.scheme == "https", parts.host == host,
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.percentEncodedPath.hasPrefix("/"),
              let url = parts.url else { return nil }
        // The text itself must name the host right after the scheme (no `https://api.aasc.work@…` games).
        guard raw.hasPrefix("https://\(host)/") else { return nil }
        return url
    }

    /// The scheme the session listens for: only the app's own, and the default when omitted.
    static func scheme(_ raw: String?) -> String? {
        guard let raw else { return callbackScheme }
        return raw == callbackScheme ? raw : nil
    }

    /// The prefix a callback must start with: under `work.aasc.mobile://auth/google`, the default when omitted.
    static func prefix(_ raw: String?) -> String? {
        guard let raw else { return defaultCallbackPrefix }
        guard raw.utf8.count <= urlMax, isUnder(raw, defaultCallbackPrefix) else { return nil }
        return raw
    }

    /// Does the callback URL fall under the prefix? startsWith, plus a boundary: the prefix ends the URL,
    /// or the next character is `?`, `#` or `/` (so `…/auth/google` doesn't accept `…/auth/googlex`).
    static func callbackMatches(_ url: String?, prefix: String) -> Bool {
        guard let url, url.utf8.count <= urlMax else { return false }
        return isUnder(url, prefix)
    }

    private static func isUnder(_ text: String, _ prefix: String) -> Bool {
        // Byte-wise, like the Kotlin twin: no Unicode equivalence between what was asked and what came back.
        let t = Array(text.utf8), p = Array(prefix.utf8)
        guard !p.isEmpty, t.count >= p.count, Array(t[0..<p.count]) == p else { return false }
        if t.count == p.count { return true }
        let boundary: Set<UInt8> = [UInt8(ascii: "?"), UInt8(ascii: "#"), UInt8(ascii: "/")]
        if boundary.contains(p[p.count - 1]) || p[p.count - 1] == UInt8(ascii: "&") { return true }
        return boundary.contains(t[p.count])
    }
}
