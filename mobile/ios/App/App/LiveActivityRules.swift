// LiveActivityRules.swift — the lock-screen Live Activity's native rules (Oct 31 2026). The Mac page posts its card
// (src/lib/liveActivityCard.ts) to the `aascLiveActivity` message handler; it is drawn only when the posting page is
// a paired Mac's (origin matched against the shell's saved Macs), under that Mac's saved name, with every field
// clamped. Foundation only, so RulesTests checks it without Xcode. The card's types are in LiveActivityCard.swift.
import Foundation

enum LiveActivityRules {
    /// The shell's saved Macs (savedMacs.ts MACS_KEY) in Capacitor Preferences' UserDefaults namespace.
    static let macsDefaultsKey = "CapacitorStorage.aasc.macs.v1"
    static let maxRows = 4
    static let titleMax = 60
    static let detailMax = 80
    /// A start time older than this is not a turn still running: no timer.
    static let maxElapsed: TimeInterval = 24 * 60 * 60
    static let macMax = 40
    private static let marks: Set<String> = ["needs", "working", "done"]
    private static let headlines: Set<String> = ["needs", "working", "finished"]

    /// One line, no control characters, at most `max` characters; nil when nothing is left.
    static func clean(_ raw: Any?, max: Int) -> String? {
        guard let raw = raw as? String else { return nil }
        let flat = String(raw.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7F ? " " : Character($0) })
            .split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        guard !flat.isEmpty else { return nil }
        return flat.count > max ? String(flat.prefix(max - 1)) + "…" : flat
    }

    /// The saved name of the paired Mac serving `origin` (its LAN address when allowed, or its tailnet address,
    /// with its port: the same paths savedMacs.ts allowedOrigins lets the WebView load); nil for anything else.
    static func macName(origin: String?, savedMacs json: String?) -> String? {
        guard let origin = ShellRules.macOrigin(origin), let json, let data = json.data(using: .utf8),
              let macs = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        for mac in macs {
            guard let port = mac["port"] as? Int, let name = clean(mac["name"], max: macMax) else { continue }
            var hosts: [String] = []
            if (mac["lanAllowed"] as? Bool) == true, let lan = mac["lan"] as? String { hosts.append(lan) }
            if let tailnet = mac["tailnet"] as? String { hosts.append(tailnet) }
            if hosts.contains(where: { ShellRules.macOrigin("http://\($0):\(port)") == origin }) { return name }
        }
        return nil
    }

    private static func count(_ raw: Any?) -> Int {
        min(max((raw as? Int) ?? 0, 0), 999)
    }

    /// The Mac's epoch-ms start time as a Date; nil when it isn't a number or is over a day old. A time ahead of
    /// `now` (the Mac's clock runs fast) becomes `now`, so the timer never shows a negative count.
    static func startTime(_ raw: Any?, now: Date) -> Date? {
        guard let raw = raw as? NSNumber, CFGetTypeID(raw) != CFBooleanGetTypeID() else { return nil }
        let ms = raw.doubleValue
        guard ms.isFinite, ms > 0 else { return nil }
        let date = Date(timeIntervalSince1970: ms / 1000)
        guard now.timeIntervalSince(date) <= maxElapsed else { return nil }
        return min(date, now)
    }

    /// A JSON `true` (WebKit hands booleans over as NSNumber, so 1 is not one).
    private static func flag(_ raw: Any?) -> Bool {
        guard let raw = raw as? NSNumber, CFGetTypeID(raw) == CFBooleanGetTypeID() else { return false }
        return raw.boolValue
    }

    /// The posted card as drawn: unknown marks and empty titles dropped, at most `maxRows` rows, a preview line on the
    /// first row only; nil when the body isn't a version-1 card or names no known headline. The Mac posts an idle
    /// session as a done row flagged `idle` and counts them in `idle` (Nov 2 2026), so an older app still draws it as
    /// done: here it becomes the "idle" mark, and a finished card whose every live session (rows + more) is idle
    /// becomes the "idle" headline (counted against the rows as posted: one dropped here may be a finished session).
    /// Neither is accepted as posted.
    static func card(_ body: Any?, mac: String, now: Date = Date()) -> LiveActivityCard? {
        guard let object = body as? [String: Any], (object["v"] as? Int) == 1,
              let posted = object["headline"] as? String, headlines.contains(posted) else { return nil }
        let postedRows = (object["rows"] as? [Any]) ?? []
        let rows = postedRows.compactMap { raw -> LiveActivityRow? in
            guard let row = raw as? [String: Any], let posted = row["mark"] as? String, marks.contains(posted),
                  let title = clean(row["title"], max: titleMax) else { return nil }
            let mark = posted == "done" && flag(row["idle"]) ? "idle" : posted
            return LiveActivityRow(mark: mark, title: title, startedAt: posted == "done" ? nil : startTime(row["startedAt"], now: now),
                                   detail: clean(row["detail"], max: detailMax))
        }.enumerated().map { index, row in
            index == 0 ? row : LiveActivityRow(mark: row.mark, title: row.title, startedAt: row.startedAt)
        }
        let more = count(object["more"]) + max(0, rows.count - maxRows)
        let allIdle = !rows.isEmpty && rows.allSatisfy { $0.mark == "idle" } && count(object["idle"]) >= postedRows.count + count(object["more"])
        return LiveActivityCard(
            mac: mac, headline: posted == "finished" && allIdle ? "idle" : posted, rows: Array(rows.prefix(maxRows)),
            more: more,
            needs: count(object["needs"]), working: count(object["working"]))
    }
}
