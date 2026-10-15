// LockRules.swift — the biometric lock's native resume path on iOS (AASC-21 M4). The Swift twin of
// LockRules in android/.../ExtrasRules.kt. The policy lives in the shell (biometricLock.ts), which isn't
// loaded while a Mac's page shows; so on return the app sends the WebView back to the shell with the
// pause time, and the shell decides. Decided here: skip that reload when the policy certainly says
// "within grace". Foundation only, so RulesTests checks it without Xcode.
import Foundation

struct LockSettings: Equatable {
    let enabled: Bool
    let minutes: Int
}

enum LockRules {
    /// Capacitor Preferences keeps the shell's values in UserDefaults under this prefix (lockGate.ts key).
    static let settingsDefaultsKey = "CapacitorStorage.aasc.lock.settings"
    private static let relock: Set<Int> = [0, 1, 5, 15, 60]

    /// (enabled, relock minutes) from the stored settings; anything odd reads as off.
    static func settings(_ json: String?) -> LockSettings {
        guard let json, let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return LockSettings(enabled: false, minutes: 5)
        }
        let raw = object["relockAfterMinutes"] as? Int ?? 5
        let enabled = (object["enabled"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
        return LockSettings(enabled: enabled, minutes: relock.contains(raw) ? raw : 5)
    }

    /// Like java.net.URLEncoder: letters, digits and -._* stay, everything else is %XX.
    private static let formSafe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._*")

    /// Where to send the WebView on return, or nil to leave the page alone. Times are milliseconds.
    static func resumeUrl(_ json: String?, shell: String, current: String?, pausedAt: Int64, now: Int64) -> String? {
        let s = settings(json)
        guard s.enabled, pausedAt > 0, !ShellRules.isShellPage(current, shell),
              let current, let page = URLComponents(string: current),
              let scheme = page.scheme, let host = page.host, let port = page.port,
              ShellRules.macOrigin("\(scheme)://\(host):\(port)") != nil else { return nil }
        let away = now - pausedAt
        if s.minutes > 0 && away >= 0 && away < Int64(s.minutes) * 60_000 { return nil }
        let path = page.percentEncodedPath.isEmpty ? "/" : page.percentEncodedPath
        let back = path + (page.percentEncodedQuery.map { "?\($0)" } ?? "")
        let encoded = back.addingPercentEncoding(withAllowedCharacters: formSafe) ?? ""
        return "\(shell)/?resume=1&away=\(pausedAt)&back=\(encoded)"
    }
}
