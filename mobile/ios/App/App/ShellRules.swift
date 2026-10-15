// ShellRules.swift — what the app's own iOS plugins accept (AASC-17). The Swift twin of
// android/.../ShellRules.kt: same rules, same cases (RulesTests/main.swift mirrors
// ShellRulesTest.kt). Foundation only, so it compiles and is tested on a Mac without Xcode.
import Foundation

enum ShellRules {
    static let vaultValueMax = 16_384
    static let cookieMaxAgeMax = 86_400

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    static func isVaultKey(_ key: String?) -> Bool {
        guard let key else { return false }
        return matches(key, "^[A-Za-z0-9._-]{1,128}$")
    }

    /// Cookie-safe: no ';', ',', spaces or control characters can sneak in another attribute.
    static func isSessionToken(_ token: String?) -> Bool {
        guard let token else { return false }
        return matches(token, "^[A-Za-z0-9._~+/=-]{1,4096}$")
    }

    /// scheme://host:port, with the scheme's default port written out; nil for anything without a host.
    static func originOf(_ raw: String?) -> String? {
        guard let raw, let url = URLComponents(string: raw),
              let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let port: Int
        if let explicit = url.port {
            port = explicit
        } else if scheme == "https" {
            port = 443
        } else if scheme == "http" {
            port = 80
        } else if scheme == "capacitor" {
            // The iOS shell's own scheme (capacitor://localhost) has no port at all.
            return "\(scheme)://\(host)"
        } else {
            return nil
        }
        return "\(scheme)://\(host):\(port)"
    }

    /// Is `current` (the WebView's page) the bundled shell at `shell`? Same scheme, host and port.
    static func isShellPage(_ current: String?, _ shell: String?) -> Bool {
        guard let page = originOf(current) else { return false }
        return page == originOf(shell)
    }

    private static func ipv4(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var nums: [Int] = []
        for part in parts {
            guard (1...3).contains(part.count), part.allSatisfy(\.isASCII), part.allSatisfy(\.isNumber),
                  let n = Int(part), (0...255).contains(n) else { return nil }
            nums.append(n)
        }
        return nums
    }

    /// = shell/src/pairingLink.ts isPrivateLanAddress / isTailnetAddress.
    static func isPairableHost(_ host: String) -> Bool {
        guard let ip = ipv4(host) else { return false }
        let (a, b) = (ip[0], ip[1])
        let lan = a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 169 && b == 254)
        let tailnet = a == 100 && (64...127).contains(b)
        return lan || tailnet
    }

    /// A paired Mac's origin as the shell sends it: http://<private or tailnet IPv4>:<port>, nothing else.
    static func macOrigin(_ raw: String?) -> String? {
        guard let raw, let url = URLComponents(string: raw), url.scheme == "http",
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.percentEncodedPath.isEmpty || url.percentEncodedPath == "/",
              let host = url.host, let port = url.port, (1...65535).contains(port), isPairableHost(host) else { return nil }
        return "http://\(host):\(port)"
    }
}
