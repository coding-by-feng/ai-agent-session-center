// FileSaveRules.swift — what the Download button's message handler accepts (Nov 7 2026). The Mac page posts
// `{ id, url, name }` to `aascSaveFile` (src/lib/phoneDownload.ts); FileSaveBridge downloads only a paired Mac's
// own file route (`/api/files/stream?…&download=1`, same origin as the page) and saves it under a clean name.
// Foundation only, so RulesTests checks it without Xcode.
import Foundation

struct FileSaveRequest: Equatable {
    let id: String
    let url: URL
    let name: String
}

enum FileSaveRules {
    static let routePrefix = "/api/files/stream?"
    static let urlMax = 8_192
    /// UTF-8 bytes: a file name on disk is at most 255 bytes, and a CJK character takes three.
    static let nameMaxBytes = 200

    /// The posted id when it is well formed: a refused request is still answered, or the page's button waits.
    static func postedId(_ body: Any?) -> String? {
        guard let id = (body as? [String: Any])?["id"] as? String,
              id.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil else { return nil }
        return id
    }

    /// The request out of a posted body, for the page at `page` (scheme://host:port); nil for anything else.
    static func request(_ body: Any?, page: String) -> FileSaveRequest? {
        guard let body = body as? [String: Any], let id = postedId(body),
              let path = body["url"] as? String, path.hasPrefix(routePrefix), path.count <= urlMax,
              let query = URLComponents(string: path)?.queryItems,
              query.contains(where: { $0.name == "download" && $0.value == "1" }),
              let name = fileName(body["name"]),
              let url = URL(string: page + path),
              ShellRules.originOf(url.absoluteString) == ShellRules.originOf(page) else { return nil }
        return FileSaveRequest(id: id, url: url, name: name)
    }

    /// A file name that stays one file in its folder: no path separators, control characters or leading dots;
    /// at most `nameMaxBytes` UTF-8 bytes (whole characters), keeping the extension. Nil when nothing is left.
    static func fileName(_ raw: Any?) -> String? {
        guard let raw = raw as? String else { return nil }
        let flat = String(raw.unicodeScalars.map { scalar -> Character in
            if scalar.value < 0x20 || scalar.value == 0x7F || scalar == "/" || scalar == "\\" || scalar == ":" { return "_" }
            return Character(scalar)
        })
        var name = flat.trimmingCharacters(in: .whitespaces)
        while name.hasPrefix(".") { name.removeFirst() }
        guard !name.isEmpty else { return nil }
        if name.utf8.count > nameMaxBytes {
            let ext = (name as NSString).pathExtension
            let keep = ext.isEmpty || ext.utf8.count > 16 ? "" : "." + ext
            var stem = keep.isEmpty ? name : String(name.dropLast(keep.count))
            while stem.utf8.count + keep.utf8.count > nameMaxBytes { stem.removeLast() }
            name = stem + keep
        }
        return name
    }

    /// The `aasc-save-file` window event's script for one outcome. The detail is JSON-encoded, never spliced.
    static func outcomeScript(id: String, state: String, message: String? = nil) -> String? {
        var detail: [String: String] = ["id": id, "state": state]
        if let message { detail["message"] = message }
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return "window.dispatchEvent(new CustomEvent('aasc-save-file', { detail: \(json) }))"
    }
}
