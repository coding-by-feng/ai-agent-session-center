// AuthSessionRules.kt — what the AuthSession plugin may open and which callback it hands back (plan 17,
// security rule 6). Pure (java.net.URI only), so the JVM tests cover it. The Swift twin is AuthSessionRules.swift.
//
// The Custom Tab opens only the backend's own https pages (Google sign-in start on api.aasc.work); the answer
// comes back as the verified App Link https://aasc.work/auth/google (assetlinks.json on aasc.work), never a
// custom scheme another app could claim (plan 08 §5).
package work.aasc.mobile

import java.net.URI

internal object AuthSessionRules {
    const val DEFAULT_CALLBACK_PREFIX = "https://aasc.work/auth/google"
    const val URL_MAX = 4096
    private const val HOST = "api.aasc.work"

    /** The page to open: `https://api.aasc.work/<path>` with no userinfo or port, or null. */
    fun startUrl(raw: String?): String? {
        if (raw.isNullOrEmpty() || raw.length > URL_MAX) return null
        if (raw.any { it <= ' ' || it == '\u007F' }) return null
        if (!raw.startsWith("https://$HOST/")) return null
        val uri = try { URI(raw) } catch (e: Exception) { return null }
        if (uri.scheme != "https" || uri.host != HOST || uri.rawUserInfo != null || uri.port != -1) return null
        if (uri.rawPath.isNullOrEmpty() || !uri.rawPath.startsWith("/")) return null
        return raw
    }

    /** The prefix a callback must start with: under https://aasc.work/auth/google, the default when omitted. */
    fun prefix(raw: String?): String? {
        if (raw == null) return DEFAULT_CALLBACK_PREFIX
        if (raw.length > URL_MAX || !isUnder(raw, DEFAULT_CALLBACK_PREFIX)) return null
        return raw
    }

    /**
     * Does the callback URL fall under the prefix? startsWith, plus a boundary: the prefix ends the URL, or
     * the next character is `?`, `#` or `/` (so `…/auth/google` doesn't accept `…/auth/googlex`).
     */
    fun callbackMatches(url: String?, prefix: String): Boolean =
        url != null && url.length <= URL_MAX && isUnder(url, prefix)

    private fun isUnder(text: String, prefix: String): Boolean {
        if (prefix.isEmpty() || !text.startsWith(prefix)) return false
        if (text.length == prefix.length) return true
        if (prefix.last() in "?#/&") return true
        return text[prefix.length] in "?#/"
    }
}
