// ExtrasRules.kt — what the AASC-19 / AASC-21 native entry points accept (share intake, widget,
// biometric prompt text). Pure (no Android types; org.json only), so the JVM tests cover it.
package work.aasc.mobile

import org.json.JSONObject

internal object ShareRules {
    /** = shell/src/shareToQueue.ts SHARE_MAX_IMAGES. */
    const val MAX_IMAGES = 4

    /**
     * Raw bytes per image. Its data URL (prefix + base64) stays under the shell's
     * SHARE_IMAGE_MAX_CHARS (2,900,000); a bigger file is refused before it is read whole.
     */
    const val MAX_IMAGE_BYTES = 2_170_000

    /** The shell refuses more than 64 KB of UTF-8; anything past this many chars can't pass, so it isn't carried. */
    const val MAX_TEXT_CHARS = 70_000

    /** = the shell's accepted types (PNG, JPEG, WebP, GIF). */
    private val IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

    /** Converted to JPEG on the phone, as the shell expects (README Decisions 5). */
    private val CONVERT_TYPES = setOf("image/heic", "image/heif")

    fun isAcceptedImage(mime: String?): Boolean = mime?.lowercase() in IMAGE_TYPES

    fun needsJpeg(mime: String?): Boolean = mime?.lowercase() in CONVERT_TYPES

    /** A shown file name: no controls or path separators, at most 120 characters. */
    fun safeName(raw: String?, index: Int): String {
        val clean = raw.orEmpty().filter { it >= ' ' && it != '\u007F' && it != '/' && it != '\\' }.trim().take(120)
        return clean.ifEmpty { "shared-image-${index + 1}" }
    }

    /**
     * Does a shared content: URI point into this app's own providers (its FileProvider serves its
     * own cache and external files)? Then reading it would hand AASC's own files to the share flow.
     * Android resolves `<userId>@<authority>`, so the user prefix is dropped first; no authority
     * at all counts as ours (refused).
     */
    fun isOwnAuthority(authority: String?, ownPackage: String): Boolean {
        val bare = authority?.substringAfterLast('@')?.lowercase() ?: return true
        val own = ownPackage.lowercase()
        return bare == own || bare.startsWith("$own.")
    }

    /** Text the shell may still accept, or null when it is certainly too long. */
    fun carriedText(raw: CharSequence?): String? = raw?.takeIf { it.length <= MAX_TEXT_CHARS }?.toString()
}

/** What the widget draws: the shell's widgetModel already decided every word. */
internal data class WidgetView(val headline: String, val title: String?, val label: String?, val updatedAt: Long)

internal object WidgetRules {
    /** = shell/src/widgetModel.ts WIDGET_MAX_BYTES. */
    const val MAX_CHARS = 16 * 1024
    const val PREFS = "aasc_widget"
    const val KEY = "aasc.widget.v1"

    private fun line(raw: Any?, max: Int): String? =
        (raw as? String)?.filter { it >= ' ' && it !in '\u007F'..'\u009F' && it !in '‪'..'‮' && it !in '⁦'..'⁩' }
            ?.trim()?.take(max)?.ifEmpty { null }

    /** The stored JSON as widget lines, or null when it isn't a v1 model (then the widget shows nothing stale). */
    fun parse(json: String?): WidgetView? {
        if (json == null || json.length > MAX_CHARS) return null
        return try {
            val o = JSONObject(json)
            if (o.optInt("v") != 1) return null
            val headline = line(o.opt("headline"), 80) ?: return null
            val top = o.optJSONObject("top")
            WidgetView(headline, line(top?.opt("title"), 32), line(top?.opt("label"), 40), o.optLong("updatedAt", 0L))
        } catch (_: Exception) {
            null
        }
    }
}

internal object PromptRules {
    const val DEFAULT_TITLE = "Unlock AASC"

    /** The biometric prompt's title: one line from the shell, at most 60 characters. */
    fun title(raw: String?): String =
        raw.orEmpty().filter { it >= ' ' && it != '\u007F' }.trim().take(60).ifEmpty { DEFAULT_TITLE }
}

/**
 * The biometric lock's native resume path (AASC-21 M4). The policy lives in the shell
 * (biometricLock.ts), which isn't loaded while a Mac's page is showing; so on resume the app
 * sends the WebView back to the shell with the pause time, and the shell decides. The only
 * thing decided here: skip that reload when the policy certainly answers "within grace".
 */
internal object LockRules {
    /** Capacitor Preferences' SharedPreferences file and the shell's key (lockGate.ts LOCK_SETTINGS_KEY). */
    const val PREFS = "CapacitorStorage"
    const val SETTINGS_KEY = "aasc.lock.settings"
    private val RELOCK = setOf(0, 1, 5, 15, 60)

    /** (enabled, relock minutes) from the stored settings; anything odd reads as off. */
    fun settings(json: String?): Pair<Boolean, Int> = try {
        val o = JSONObject(json ?: "")
        val minutes = o.optInt("relockAfterMinutes", 5).takeIf { it in RELOCK } ?: 5
        (o.optBoolean("enabled", false)) to minutes
    } catch (_: Exception) {
        false to 5
    }

    /**
     * Where to send the WebView on resume, or null to leave the page alone. Only when the lock is on,
     * a paired-style Mac page is showing, and the time away isn't certainly inside the grace period
     * (a clock that moved back always goes to the shell, which then locks).
     */
    fun resumeUrl(json: String?, shellUrl: String, currentUrl: String?, pausedAt: Long, now: Long): String? {
        val (enabled, minutes) = settings(json)
        if (!enabled || pausedAt <= 0) return null
        if (ShellRules.isShellPage(currentUrl, shellUrl)) return null
        val page = try {
            java.net.URI(currentUrl ?: return null)
        } catch (_: Exception) {
            return null
        }
        ShellRules.macOrigin("${page.scheme}://${page.host}:${page.port}") ?: return null
        val away = now - pausedAt
        if (minutes > 0 && away >= 0 && away < minutes * 60_000L) return null
        val back = (page.rawPath?.ifEmpty { "/" } ?: "/") + (page.rawQuery?.let { "?$it" } ?: "")
        return "$shellUrl/?resume=1&away=$pausedAt&back=${java.net.URLEncoder.encode(back, "UTF-8")}"
    }
}

/**
 * A notification tap while a Mac's page is showing (AASC-19). The push plugin holds the tap
 * until something listens, and only the shell listens; so the app goes back to the shell, with
 * ?tap=1 so the shell doesn't open a Mac's home page in the meantime.
 */
internal object PushRules {
    /** Firebase puts its message id in the extras of the intent a notification tap opens. */
    fun isTap(keys: Set<String>?): Boolean = keys?.contains("google.message_id") == true

    /** Where to send the WebView for a tap, or null when the shell is (or is about to be) showing. */
    fun tapUrl(shellUrl: String, currentUrl: String?): String? {
        if (currentUrl == null || ShellRules.isShellPage(currentUrl, shellUrl)) return null
        return "$shellUrl/?tap=1"
    }
}
