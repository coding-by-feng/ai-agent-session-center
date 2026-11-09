// DownloadRules.kt — the phone file view's Download button on Android (Nov 7 2026). The Mac page clicks an
// `<a download>` to `/api/files/stream?…&download=1` (src/lib/phoneDownload.ts); MainActivity's DownloadListener
// hands it to DownloadManager only when it is that route on the page's own origin, on a Mac's page (never the
// shell), and saves it in Downloads under the name the Mac sent. Pure (java.net.URI through ShellRules), so the
// JVM unit tests cover it.
package work.aasc.mobile

import java.net.URI
import java.net.URLDecoder

internal object DownloadRules {
    const val ROUTE = "/api/files/stream"
    /** UTF-8 bytes: a file name on disk is at most 255 bytes, and a CJK character takes three. */
    const val NAME_MAX_BYTES = 200

    /** Is `url` the page's own file route asking for a download, from a Mac's page? */
    fun accepts(url: String?, pageUrl: String?, shellUrl: String?): Boolean {
        if (!BackRules.asksPage(shellUrl, pageUrl)) return false
        val origin = ShellRules.originOf(url) ?: return false
        if (origin != ShellRules.originOf(pageUrl)) return false
        val u = try { URI(url) } catch (_: Exception) { return false }
        if (u.rawPath != ROUTE) return false
        return (u.rawQuery ?: "").split('&').any { it == "download=1" }
    }

    private val STAR = Regex("""filename\*\s*=\s*UTF-8''([^;\s]+)""", RegexOption.IGNORE_CASE)
    private val PLAIN = Regex("""filename\s*=\s*"([^"]*)"""", RegexOption.IGNORE_CASE)

    /** The file's name from the Mac's Content-Disposition (the UTF-8 `filename*` first), cleaned. */
    fun fileName(contentDisposition: String?, fallback: String): String {
        val header = contentDisposition ?: ""
        val star = STAR.find(header)?.groupValues?.get(1)?.let {
            try { URLDecoder.decode(it.replace("+", "%2B"), "UTF-8") } catch (_: Exception) { null }
        }
        return clean(star) ?: clean(PLAIN.find(header)?.groupValues?.get(1)) ?: fallback
    }

    /** One file in Downloads: no separators or controls, no leading dots, at most NAME_MAX_BYTES (whole characters). */
    private fun bytes(s: String): Int = s.toByteArray(Charsets.UTF_8).size

    fun clean(raw: String?): String? {
        if (raw == null) return null
        var name = raw.map { c -> if (c < ' ' || c == '\u007F' || c == '/' || c == '\\' || c == ':') '_' else c }
            .joinToString("").trim().trimStart('.')
        if (name.isEmpty()) return null
        if (bytes(name) > NAME_MAX_BYTES) {
            val dot = name.lastIndexOf('.')
            val ext = if (dot > 0 && name.length - dot <= 16) name.substring(dot) else ""
            var stem = name.substring(0, name.length - ext.length)
            while (stem.isNotEmpty() && bytes(stem) + bytes(ext) > NAME_MAX_BYTES) {
                // Drop a whole code point (a surrogate pair stays together).
                stem = stem.substring(0, stem.offsetByCodePoints(stem.length, -1))
            }
            name = stem + ext
        }
        return name
    }
}
