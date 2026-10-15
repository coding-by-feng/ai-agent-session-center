// RulesTests/main.swift — ShellRules.swift checked on a Mac without Xcode (no XCTest needed).
// Mirrors android/app/src/test/.../ShellRulesTest.kt case for case. Run:
//   swiftc -o /tmp/aasc-rules ios/App/App/ShellRules.swift ios/RulesTests/main.swift && /tmp/aasc-rules
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

print("\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
