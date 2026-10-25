// RulesTests/main.swift — ShellRules.swift checked on a Mac without Xcode (no XCTest needed).
// Mirrors android/app/src/test/.../ShellRulesTest.kt case for case. Run:
//   swiftc -o /tmp/aasc-rules ios/App/App/ShellRules.swift ios/App/App/LockRules.swift ios/RulesTests/main.swift && /tmp/aasc-rules
import Foundation

var failures = 0
var checks = 0
func expect(_ ok: Bool, _ what: String, line: Int = #line) {
    checks += 1
    if !ok { failures += 1; print("FAIL line \(line): \(what)") }
}

let shell = "https://localhost"

// onlyTheBundledShellPageIsTheShell
expect(ShellRules.isShellPage("https://localhost/", shell), "shell root")
expect(ShellRules.isShellPage("https://localhost/?reauth=1&back=%2Fqueue", shell), "shell with query")
expect(!ShellRules.isShellPage("http://100.101.102.103:3333/", shell), "a Mac page")
expect(!ShellRules.isShellPage("http://localhost/", shell), "http localhost")
expect(!ShellRules.isShellPage("https://localhost:8443/", shell), "other port")
expect(!ShellRules.isShellPage("https://localhost.evil.example/", shell), "lookalike host")
expect(!ShellRules.isShellPage("https://mac-kason.aasc.work/", shell), "aasc.work")
expect(!ShellRules.isShellPage(nil, shell), "nil")
expect(!ShellRules.isShellPage("about:blank", shell), "about:blank")

// iOS: the bundled shell is capacitor://localhost (no port)
let iosShell = "capacitor://localhost"
expect(ShellRules.isShellPage("capacitor://localhost/", iosShell), "ios shell root")
expect(ShellRules.isShellPage("capacitor://localhost/?reauth=1", iosShell), "ios shell with query")
expect(!ShellRules.isShellPage("capacitor://evil.example/", iosShell), "other capacitor host")
expect(!ShellRules.isShellPage("http://localhost/", iosShell), "http localhost is not the ios shell")
expect(!ShellRules.isShellPage("http://100.101.102.103:3333/", iosShell), "a Mac page is not the ios shell")

// acceptsOnlyPairedStyleMacOrigins
expect(ShellRules.macOrigin("http://100.101.102.103:3333") == "http://100.101.102.103:3333", "tailnet")
expect(ShellRules.macOrigin("http://192.168.1.20:3333/") == "http://192.168.1.20:3333", "lan with slash")
expect(ShellRules.macOrigin("http://8.8.8.8:3333") == nil, "public ip")
expect(ShellRules.macOrigin("https://100.101.102.103:3333") == nil, "https")
expect(ShellRules.macOrigin("http://100.101.102.103") == nil, "no port")
expect(ShellRules.macOrigin("http://100.200.1.1:3333") == nil, "outside tailnet range")
expect(ShellRules.macOrigin("http://user@192.168.1.20:3333") == nil, "user info")
expect(ShellRules.macOrigin("http://192.168.1.20:3333/api") == nil, "path")
expect(ShellRules.macOrigin("http://192.168.1.20:3333/?x=1") == nil, "query")
expect(ShellRules.macOrigin("http://example.com:3333") == nil, "hostname")
expect(ShellRules.macOrigin(nil) == nil, "nil")

// macOriginRefusesLeadingZeroOctets
expect(ShellRules.macOrigin("http://010.1.1.1:3333") == nil, "010 is octal 8")
expect(ShellRules.macOrigin("http://100.064.001.001:3333") == nil, "padded tailnet octets")
expect(ShellRules.macOrigin("http://192.168.001.010:3333") == nil, "padded lan octets")
expect(ShellRules.macOrigin("http://10.0.0.08:3333") == nil, "08")
expect(ShellRules.macOrigin("http://00.0.0.0:3333") == nil, "00.0.0.0")
// iOS only: java.net.URI refuses this host, so ShellRulesTest.kt cannot mirror it (URLComponents percent-decodes it to 010.1.1.1).
expect(ShellRules.macOrigin("http://%30%31%30.1.1.1:3333") == nil, "percent-encoded 010 (iOS only)")

// pairableHostsAreCanonical
expect(!ShellRules.isPairableHost("010.1.1.1"), "010.1.1.1")
expect(!ShellRules.isPairableHost("100.064.001.001"), "100.064.001.001")
expect(!ShellRules.isPairableHost("100.64.01.1"), "100.64.01.1")
expect(!ShellRules.isPairableHost("100.64.1.256"), "octet over 255")
expect(!ShellRules.isPairableHost("100.64.1"), "three octets")
expect(ShellRules.isPairableHost("10.0.0.1"), "10/8")
expect(ShellRules.isPairableHost("172.16.0.1"), "172.16/12")
expect(ShellRules.isPairableHost("192.168.7.231"), "192.168/16")
expect(ShellRules.isPairableHost("169.254.1.1"), "link-local")
expect(ShellRules.isPairableHost("100.64.0.0"), "tailnet low edge, single zeros")
expect(ShellRules.isPairableHost("100.127.255.255"), "tailnet high edge")
expect(ShellRules.isPairableHost("100.101.102.103"), "tailnet")

// pairableHostsAreAsciiDigitsOnly
expect(!ShellRules.isPairableHost("\u{FF11}\u{FF10}.0.0.1"), "fullwidth 10")
expect(!ShellRules.isPairableHost("10.0.0.\u{FF11}"), "fullwidth last octet")
expect(!ShellRules.isPairableHost("\u{0661}\u{0660}.0.0.1"), "arabic-indic 10")
expect(!ShellRules.isPairableHost("192.168.\u{0661}.\u{0662}"), "arabic-indic octets")

// originsCompareWithDefaultPortsWrittenOut
expect(ShellRules.originOf("http://192.168.1.20:3333/queue?x=1") == "http://192.168.1.20:3333", "explicit port")
expect(ShellRules.originOf("https://AASC.work/pair") == "https://aasc.work:443", "default https port, lowercased")
expect(ShellRules.originOf("javascript:alert(1)") == nil, "javascript:")

// sessionTokensCantCarryCookieAttributes
expect(ShellRules.isSessionToken("abc.DEF_123-~+/="), "token charset")
expect(!ShellRules.isSessionToken("abc; Domain=evil.example"), "attribute injection")
expect(!ShellRules.isSessionToken("abc def"), "space")
expect(!ShellRules.isSessionToken(""), "empty")
expect(!ShellRules.isSessionToken(nil), "nil")

// vaultKeysAreSimpleNames
expect(ShellRules.isVaultKey("mac.6f1c2a10-0000-4000-8000-000000000001"), "mac key")
expect(!ShellRules.isVaultKey("../x"), "path")
expect(!ShellRules.isVaultKey(""), "empty")
expect(!ShellRules.isVaultKey(String(repeating: "a", count: 129)), "too long")

// LockRules (mirrors LockRulesTest in ExtrasRulesTest.kt, with the iOS shell origin)
let on5 = #"{"enabled":true,"relockAfterMinutes":5}"#
let mac = "http://100.101.102.103:3333/queue?session=abc"
expect(LockRules.settings(on5) == LockSettings(enabled: true, minutes: 5), "settings on/5")
expect(LockRules.settings(#"{"enabled":true,"relockAfterMinutes":7}"#) == LockSettings(enabled: true, minutes: 5), "odd minutes -> 5")
expect(LockRules.settings(#"{"enabled":"yes"}"#) == LockSettings(enabled: false, minutes: 5), "non-bool enabled -> off")
expect(LockRules.settings("garbage") == LockSettings(enabled: false, minutes: 5), "garbage -> off")
expect(LockRules.settings(nil) == LockSettings(enabled: false, minutes: 5), "nil -> off")
expect(LockRules.resumeUrl(on5, shell: iosShell, current: mac, pausedAt: 1_000, now: 1_000 + 6 * 60_000)
       == "capacitor://localhost/?resume=1&away=1000&back=%2Fqueue%3Fsession%3Dabc", "after grace -> shell with path")
expect(LockRules.resumeUrl(on5, shell: iosShell, current: mac, pausedAt: 1_000, now: 1_000 + 60_000) == nil, "within grace")
expect(LockRules.resumeUrl(#"{"enabled":false}"#, shell: iosShell, current: mac, pausedAt: 1_000, now: 10_000_000) == nil, "lock off")
expect(LockRules.resumeUrl(on5, shell: iosShell, current: "capacitor://localhost/?x=1", pausedAt: 1_000, now: 10_000_000) == nil, "shell decides itself")
expect(LockRules.resumeUrl(on5, shell: iosShell, current: "https://evil.example/", pausedAt: 1_000, now: 10_000_000) == nil, "not a Mac page")
expect(LockRules.resumeUrl(on5, shell: iosShell, current: mac, pausedAt: 0, now: 10_000_000) == nil, "never paused")
expect(LockRules.resumeUrl(on5, shell: iosShell, current: mac, pausedAt: 10_000, now: 5_000) != nil, "clock moved back")
expect(LockRules.resumeUrl(#"{"enabled":true,"relockAfterMinutes":0}"#, shell: iosShell, current: mac, pausedAt: 1_000, now: 1_001) != nil, "every time")

// PromptRules
expect(PromptRules.title("Unlock to open Fix the build") == "Unlock to open Fix the build", "plain title kept")
expect(PromptRules.title("  ") == "Unlock AASC", "blank -> default")
expect(PromptRules.title(nil) == "Unlock AASC", "nil -> default")
expect(PromptRules.title("a\u{0007}b\nc") == "abc", "control characters dropped")
expect(PromptRules.title(String(repeating: "x", count: 80)).count == 60, "at most 60")

print("\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
