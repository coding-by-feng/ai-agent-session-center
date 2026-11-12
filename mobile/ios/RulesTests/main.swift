// RulesTests/main.swift — ShellRules.swift checked on a Mac without Xcode (no XCTest needed).
// Mirrors android/app/src/test/.../ShellRulesTest.kt case for case. Run:
//   swiftc -o /tmp/aasc-rules ios/App/App/ShellRules.swift ios/App/App/LockRules.swift ios/App/App/LiveActivityCard.swift ios/App/App/LiveActivityRules.swift ios/App/App/FileSaveRules.swift ios/App/App/AuthSessionRules.swift ios/RulesTests/main.swift && /tmp/aasc-rules
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

// LiveActivityRules: the card is drawn only for a saved Mac's origin, under its saved name, clamped
let savedMacs = """
[{"id":"m1","name":"kason-mac","port":3333,"lan":"192.168.4.20","tailnet":"100.101.102.103","lanAllowed":true},
 {"id":"m2","name":"studio","port":4444,"lan":"192.168.4.30","tailnet":null,"lanAllowed":false}]
"""
expect(LiveActivityRules.macName(origin: "http://192.168.4.20:3333", savedMacs: savedMacs) == "kason-mac", "LAN origin")
expect(LiveActivityRules.macName(origin: "http://100.101.102.103:3333", savedMacs: savedMacs) == "kason-mac", "tailnet origin")
expect(LiveActivityRules.macName(origin: "http://192.168.4.20:3334", savedMacs: savedMacs) == nil, "other port")
expect(LiveActivityRules.macName(origin: "http://192.168.4.30:4444", savedMacs: savedMacs) == nil, "LAN not allowed")
expect(LiveActivityRules.macName(origin: "http://192.168.4.99:3333", savedMacs: savedMacs) == nil, "unknown host")
expect(LiveActivityRules.macName(origin: "capacitor://localhost", savedMacs: savedMacs) == nil, "the shell")
expect(LiveActivityRules.macName(origin: "https://evil.example", savedMacs: savedMacs) == nil, "a web page")
expect(LiveActivityRules.macName(origin: "http://192.168.4.20:3333", savedMacs: nil) == nil, "nothing saved")
expect(LiveActivityRules.macName(origin: "http://192.168.4.20:3333", savedMacs: "{oops") == nil, "bad JSON")

let goodCard: [String: Any] = [
    "v": 1, "headline": "working", "more": 2, "needs": 0, "working": 1,
    "rows": [["mark": "working", "title": "Fix\nthe build"], ["mark": "bogus", "title": "x"], ["mark": "done", "title": "  "],
             ["mark": "done", "title": String(repeating: "y", count: 90)]],
]
let parsedCard = LiveActivityRules.card(goodCard, mac: "kason-mac")
expect(parsedCard?.rows.count == 2, "bad mark and blank title dropped")
expect(parsedCard?.rows.first?.title == "Fix the build", "control characters flattened")
expect(parsedCard?.rows.last?.title.count == 60, "title clipped to 60")
expect(parsedCard?.mac == "kason-mac" && parsedCard?.headline == "working" && parsedCard?.more == 2, "fields kept")
let manyRows: [String: Any] = ["v": 1, "headline": "finished", "more": 0,
                               "rows": (1...6).map { ["mark": "done", "title": "s\($0)"] }]
expect(LiveActivityRules.card(manyRows, mac: "m")?.rows.count == 4, "at most 4 rows")
expect(LiveActivityRules.card(manyRows, mac: "m")?.more == 2, "extra rows counted in more")
expect(LiveActivityRules.card(["v": 2, "headline": "working"], mac: "m") == nil, "other version")
expect(LiveActivityRules.card(["v": 1, "headline": "party"], mac: "m") == nil, "unknown headline")
expect(LiveActivityRules.card("nope", mac: "m") == nil, "not an object")
expect(LiveActivityRules.card(["v": 1, "headline": "needs", "needs": -5, "working": 5000], mac: "m").map { [$0.needs, $0.working] } == [0, 999], "counts clamped")

// The timer's start time and the lead row's preview line
let clock = Date(timeIntervalSince1970: 1_800_000_000)
let clockMs = 1_800_000_000_000.0
let timedCard: [String: Any] = [
    "v": 1, "headline": "working", "working": 1,
    "rows": [["mark": "working", "title": "lead", "startedAt": clockMs - 100_000, "detail": "Reading\nthe map " + String(repeating: "z", count: 120)],
             ["mark": "needs", "title": "asks", "startedAt": clockMs - 5_000, "detail": "not the lead"],
             ["mark": "done", "title": "done", "startedAt": clockMs - 5_000]],
]
let timed = LiveActivityRules.card(timedCard, mac: "m", now: clock)
expect(timed?.rows[0].startedAt == clock.addingTimeInterval(-100), "lead start time kept")
expect(timed?.rows[0].detail?.hasPrefix("Reading the map z") == true, "preview flattened")
expect(timed?.rows[0].detail?.count == 80, "preview clipped to 80")
expect(timed?.rows[1].startedAt == clock.addingTimeInterval(-5) && timed?.rows[1].detail == nil, "preview on the lead row only")
expect(timed?.rows[2].startedAt == nil, "done rows have no timer")
func startOf(_ raw: Any) -> Date? {
    LiveActivityRules.card(["v": 1, "headline": "working", "rows": [["mark": "working", "title": "t", "startedAt": raw]]],
                           mac: "m", now: clock)?.rows.first?.startedAt
}
expect(startOf(clockMs + 60_000) == clock, "a fast Mac clock never counts negative")
expect(startOf(clockMs - 25 * 3_600_000) == nil, "over a day old: no timer")
expect(startOf("123") == nil && startOf(true) == nil && startOf(-5) == nil, "not a time: no timer")
expect(startOf(Int(clockMs) - 1_000) == clock.addingTimeInterval(-1), "an integer ms value works")

// Idle sessions: a done row flagged idle becomes the idle mark; every live session idle makes the headline idle
let idleRows: [[String: Any]] = [["mark": "done", "title": "a", "idle": true], ["mark": "done", "title": "b"],
                                 ["mark": "working", "title": "c", "idle": true]]
let someIdle = LiveActivityRules.card(["v": 1, "headline": "finished", "idle": 1, "rows": idleRows], mac: "m")
expect(someIdle?.rows.map(\.mark) == ["idle", "done", "working"], "idle flag only turns a done row idle")
expect(someIdle?.headline == "finished", "not every session idle: still finished")
let allIdle = LiveActivityRules.card(["v": 1, "headline": "finished", "idle": 3, "more": 1,
                                      "rows": [["mark": "done", "title": "a", "idle": true], ["mark": "done", "title": "b", "idle": true]]],
                                     mac: "m")
expect(allIdle?.headline == "idle" && allIdle?.rows.map(\.mark) == ["idle", "idle"], "every live session idle: headline idle")
expect(LiveActivityRules.card(["v": 1, "headline": "finished", "idle": 3, "rows": [["mark": "done", "title": "a"]]], mac: "m")?.headline == "finished",
       "idle count covers the card but no row is flagged: finished")
expect(LiveActivityRules.card(["v": 1, "headline": "working", "idle": 9, "working": 1, "rows": [["mark": "working", "title": "w"]]], mac: "m")?.headline == "working",
       "only a finished card turns idle")
expect(LiveActivityRules.card(["v": 1, "headline": "finished", "idle": 1,
                                "rows": [["mark": "done", "title": "a", "idle": true], ["mark": "done", "title": "\u{1B}"]]], mac: "m")?.headline == "finished",
       "a finished row dropped here (blank title) still counts against all-idle")
expect(LiveActivityRules.card(["v": 1, "headline": "idle", "rows": [["mark": "idle", "title": "x"]]], mac: "m") == nil,
       "the Mac never posts idle as a headline")
expect(LiveActivityRules.card(["v": 1, "headline": "finished", "rows": [["mark": "idle", "title": "x"]]], mac: "m")?.rows.isEmpty == true,
       "nor as a mark")
expect(LiveActivityRules.card(["v": 1, "headline": "finished", "rows": [["mark": "done", "title": "x", "idle": "yes"]]], mac: "m")?.rows.first?.mark == "done",
       "a non-boolean idle flag is ignored")

// A "proceed" owed (Nov 8 2026): a done row flagged proceed becomes the proceed mark and keeps its timer
let askedAt = Date().timeIntervalSince1970 * 1000 - 60_000
let proceedCard = LiveActivityRules.card(["v": 1, "headline": "needs", "needs": 1, "rows": [
    ["mark": "done", "title": "p", "proceed": true, "startedAt": askedAt], ["mark": "done", "title": "d", "startedAt": askedAt],
    ["mark": "done", "title": "both", "proceed": true, "idle": true]]], mac: "m")
expect(proceedCard?.rows.map(\.mark) == ["proceed", "done", "proceed"], "proceed flag turns a done row proceed, and beats idle")
expect(proceedCard?.rows.first?.startedAt != nil, "a proceed row keeps when it asked")
expect(proceedCard?.rows[1].startedAt == nil, "a plain done row still has no timer")
expect(LiveActivityRules.card(["v": 1, "headline": "working", "rows": [["mark": "working", "title": "w", "proceed": true]]], mac: "m")?.rows.first?.mark == "working",
       "proceed only turns a done row")
expect(LiveActivityRules.card(["v": 1, "headline": "finished", "rows": [["mark": "proceed", "title": "x"]]], mac: "m")?.rows.isEmpty == true,
       "the Mac never posts proceed as a mark")

// FileSaveRules: the Download button downloads only the page's own file route, under a clean name (Nov 7 2026)
let macPage = "http://192.168.4.20:3333"
let goodPath = "/api/files/stream?root=%2FUsers%2Fk%2Fp&path=a%2Fv.mp4&download=1"
let saveReq = FileSaveRules.request(["id": "lx2-1", "url": goodPath, "name": "v.mp4"], page: macPage)
expect(saveReq?.url.absoluteString == macPage + goodPath && saveReq?.name == "v.mp4" && saveReq?.id == "lx2-1", "good request")
expect(FileSaveRules.request(["id": "a", "url": "/api/files/stream?root=x&path=y", "name": "v"], page: macPage) == nil, "no download=1")
expect(FileSaveRules.request(["id": "a", "url": "/api/sessions?download=1", "name": "v"], page: macPage) == nil, "another route")
expect(FileSaveRules.request(["id": "a", "url": "//evil.example/api/files/stream?download=1", "name": "v"], page: macPage) == nil, "another host")
expect(FileSaveRules.request(["id": "a", "url": "https://evil.example/api/files/stream?download=1", "name": "v"], page: macPage) == nil, "absolute url")
expect(FileSaveRules.request(["id": "a b", "url": goodPath, "name": "v"], page: macPage) == nil, "bad id")
expect(FileSaveRules.request(["id": "a", "url": goodPath, "name": "..."], page: macPage) == nil, "name of dots")
expect(FileSaveRules.request("nope", page: macPage) == nil, "not an object")
expect(FileSaveRules.fileName("../../etc/passwd") == "_.._etc_passwd", "separators replaced, leading dots dropped")
expect(FileSaveRules.fileName("笔记 1.md") == "笔记 1.md", "unicode kept")
expect(FileSaveRules.fileName("a\nb.txt") == "a_b.txt", "control characters replaced")
let longName = FileSaveRules.fileName(String(repeating: "x", count: 300) + ".mp4")
expect(longName?.utf8.count == FileSaveRules.nameMaxBytes && longName?.hasSuffix(".mp4") == true, "long name keeps its extension")
let longCjk = FileSaveRules.fileName(String(repeating: "笔", count: 100) + ".md")
expect((longCjk?.utf8.count ?? 999) <= FileSaveRules.nameMaxBytes && longCjk?.hasSuffix("笔.md") == true, "a CJK name is cut by bytes, whole characters")
expect(FileSaveRules.postedId(["id": "a-1", "url": "x"]) == "a-1" && FileSaveRules.postedId(["id": "a b"]) == nil, "a refused request is still answered by id")
let script = FileSaveRules.outcomeScript(id: "a", state: "failed", message: "x')); alert(1); ('")
expect(script?.contains("\"message\":\"x')); alert(1); ('\"") == true, "message JSON-encoded inside the detail")

// AuthSessionRules: Google sign-in opens only api.aasc.work and returns only work.aasc.mobile://auth/google (plan 17)
expect(AuthSessionRules.startUrl("https://api.aasc.work/v1/auth/google/start?return=x&challenge=abc")?.host == "api.aasc.work", "backend start page")
expect(AuthSessionRules.startUrl("https://API.aasc.work/v1/x") == nil, "uppercase host (the backend sends it lowercase)")
expect(AuthSessionRules.startUrl("http://api.aasc.work/v1/x") == nil, "http")
expect(AuthSessionRules.startUrl("https://aasc.work/v1/x") == nil, "other host")
expect(AuthSessionRules.startUrl("https://api.aasc.work.evil.example/v1/x") == nil, "lookalike host")
expect(AuthSessionRules.startUrl("https://api.aasc.work@evil.example/v1/x") == nil, "userinfo trick")
expect(AuthSessionRules.startUrl("https://user@api.aasc.work/v1/x") == nil, "userinfo")
expect(AuthSessionRules.startUrl("https://api.aasc.work:8443/v1/x") == nil, "port")
expect(AuthSessionRules.startUrl("https://api.aasc.work") == nil, "no path")
expect(AuthSessionRules.startUrl("https://api.aasc.work/a b") == nil, "space")
expect(AuthSessionRules.startUrl("https://api.aasc.work/" + String(repeating: "a", count: 5000)) == nil, "too long")
expect(AuthSessionRules.startUrl(nil) == nil && AuthSessionRules.startUrl("") == nil, "empty")
expect(AuthSessionRules.startUrl("javascript:alert(1)") == nil, "javascript")
expect(AuthSessionRules.scheme(nil) == "work.aasc.mobile" && AuthSessionRules.scheme("work.aasc.mobile") == "work.aasc.mobile", "own scheme")
expect(AuthSessionRules.scheme("https") == nil && AuthSessionRules.scheme("work.aasc.mobile.evil") == nil, "other scheme")
expect(AuthSessionRules.prefix(nil) == "work.aasc.mobile://auth/google", "default prefix")
expect(AuthSessionRules.prefix("work.aasc.mobile://auth/google?") == "work.aasc.mobile://auth/google?", "narrower prefix")
expect(AuthSessionRules.prefix("work.aasc.mobile://") == nil, "wider prefix")
expect(AuthSessionRules.prefix("https://aasc.work/auth/google") == nil, "android prefix on ios")
expect(AuthSessionRules.prefix("work.aasc.mobile://auth/googlex") == nil, "prefix past the boundary")
let cbPrefix = AuthSessionRules.defaultCallbackPrefix
expect(AuthSessionRules.callbackMatches("work.aasc.mobile://auth/google?code=abc&state=x", prefix: cbPrefix), "callback with code")
expect(AuthSessionRules.callbackMatches("work.aasc.mobile://auth/google", prefix: cbPrefix), "bare callback")
expect(AuthSessionRules.callbackMatches("work.aasc.mobile://auth/google#x", prefix: cbPrefix), "fragment")
expect(!AuthSessionRules.callbackMatches("work.aasc.mobile://auth/googlex?code=a", prefix: cbPrefix), "past the boundary")
expect(!AuthSessionRules.callbackMatches("work.aasc.mobile://pair?code=a", prefix: cbPrefix), "other path")
expect(!AuthSessionRules.callbackMatches("WORK.aasc.mobile://auth/google?code=a", prefix: cbPrefix), "byte-wise")
expect(!AuthSessionRules.callbackMatches(nil, prefix: cbPrefix), "nil callback")
expect(AuthSessionRules.callbackMatches("work.aasc.mobile://auth/google?code=a", prefix: "work.aasc.mobile://auth/google?"), "prefix ending in ?")

print("\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
