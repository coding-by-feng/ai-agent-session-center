// ShellRules.kt — what the app's own plugins accept (AASC-17). Pure (java.net.URI, no
// Android types), so the JVM unit tests cover it.
package work.aasc.mobile

import java.net.URI

internal object ShellRules {
    private val VAULT_KEY = Regex("^[A-Za-z0-9._-]{1,128}$")
    const val VAULT_VALUE_MAX = 16_384

    /** Cookie-safe: no ';', ',', spaces or control characters can sneak in another attribute. */
    private val SESSION_TOKEN = Regex("^[A-Za-z0-9._~+/=-]{1,4096}$")
    const val COOKIE_MAX_AGE_MAX = 86_400

    fun isVaultKey(key: String?): Boolean = key != null && VAULT_KEY.matches(key)

    fun isSessionToken(token: String?): Boolean = token != null && SESSION_TOKEN.matches(token)

    private fun uri(raw: String?): URI? = try {
        raw?.let(::URI)
    } catch (_: Exception) {
        null
    }

    /** scheme://host:port, with the scheme's default port written out; null for anything without a host. */
    fun originOf(raw: String?): String? {
        val u = uri(raw) ?: return null
        val scheme = u.scheme?.lowercase() ?: return null
        val host = u.host?.lowercase() ?: return null
        val port = when {
            u.port != -1 -> u.port
            scheme == "https" -> 443
            scheme == "http" -> 80
            else -> return null
        }
        return "$scheme://$host:$port"
    }

    /**
     * Is `current` (the WebView's page) the bundled shell at `shell` (the bridge's local URL)?
     * Same scheme, host and port: a Mac page, aasc.work or anything else is refused.
     */
    fun isShellPage(current: String?, shell: String?): Boolean {
        val page = originOf(current) ?: return false
        return page == originOf(shell)
    }

    private fun ipv4(host: String): IntArray? {
        val parts = host.split('.')
        if (parts.size != 4) return null
        val nums = parts.map { p -> if (p.length in 1..3 && p.all(Char::isDigit)) p.toInt() else return null }
        return if (nums.all { it in 0..255 }) nums.toIntArray() else null
    }

    /** = shell/src/pairingLink.ts isPrivateLanAddress / isTailnetAddress. */
    fun isPairableHost(host: String): Boolean {
        val ip = ipv4(host) ?: return false
        val (a, b) = ip[0] to ip[1]
        val lan = a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
        val tailnet = a == 100 && b in 64..127
        return lan || tailnet
    }

    /**
     * A paired Mac's origin as the shell sends it: http://<private or tailnet IPv4>:<port>,
     * nothing else (no path, query, fragment or user info). Returns it normalised, or null.
     */
    fun macOrigin(raw: String?): String? {
        val u = uri(raw) ?: return null
        if (u.scheme != "http" || u.rawUserInfo != null || u.rawQuery != null || u.rawFragment != null) return null
        if (!(u.rawPath.isNullOrEmpty() || u.rawPath == "/")) return null
        val host = u.host ?: return null
        if (u.port !in 1..65535 || !isPairableHost(host)) return null
        return "http://$host:${u.port}"
    }
}
