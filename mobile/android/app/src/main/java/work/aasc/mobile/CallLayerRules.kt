// CallLayerRules.kt — what the floating call bubble may show (CallLayerPlugin.kt, Nov 22 2026). The Kotlin twin of
// CallLayerRules.swift. Pure, so the JVM unit tests cover it.
package work.aasc.mobile

internal object CallLayerRules {
    enum class BubbleState { LIVE, PAUSED, MUTED }

    const val LABEL_MAX = 12

    /** The clock ("12:05") or a word ("Paused"): letters, digits, ':' and spaces, at most [LABEL_MAX]; else "Call". */
    fun label(raw: String?): String {
        val text = raw?.trim() ?: return "Call"
        val ok = text.isNotEmpty() && text.length <= LABEL_MAX && text.all { it.isLetterOrDigit() || it == ':' || it == ' ' }
        return if (ok) text else "Call"
    }

    fun state(raw: String?): BubbleState = when (raw) {
        "paused" -> BubbleState.PAUSED
        "muted" -> BubbleState.MUTED
        else -> BubbleState.LIVE
    }

    /** A page the layer may open: a paired-Mac-shaped http origin (ShellRules.macOrigin), no user info. */
    fun pageOrigin(raw: String?): String? {
        if (raw == null || !raw.startsWith("http://")) return null
        val origin = ShellRules.originOf(raw) ?: return null
        if (raw.substringAfter("http://").substringBefore('/').contains('@')) return null
        return ShellRules.macOrigin(origin)
    }
}
