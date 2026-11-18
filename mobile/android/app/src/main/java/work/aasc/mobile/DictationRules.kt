// DictationRules.kt — what the hold-to-talk mic's message listener accepts and answers (Nov 16 2026). The Mac page
// posts `{"id":…,"action":"start"|"stop"|"cancel"}` to `window.aascDictation` (src/lib/phoneDictation.ts);
// DictationBridge records one clip at a time, and only for the main frame of a paired Mac's page that the WebView
// is showing. Pure (org.json and java.net.URI through ShellRules), so the JVM unit tests cover it.
package work.aasc.mobile

import org.json.JSONObject

internal object DictationRules {
    /** The JavaScript object's name on the page. */
    const val HANDLER = "aascDictation"
    /** The longest clip: recording stops by itself and the clip is handed over. */
    const val MAX_MS = 120_000
    /** A shorter hold is a tap, not speech: nothing is handed over. */
    const val MIN_MS = 400L
    /** A clip is about 4 kB a second; one far above two minutes' worth is not handed to the page. */
    const val MAX_BYTES = 1_500_000
    /** A request is a few dozen characters. */
    const val MESSAGE_MAX = 512
    const val MIME = "audio/mp4"
    /**
     * A recording starts only this soon after a finger went down on the screen. The Mac's page is plain http, so
     * a script put into it could post `start` by itself; it can't put a finger on the glass.
     */
    const val TOUCH_GRACE_MS = 1_500L

    enum class Action { START, STOP, CANCEL }

    data class Request(val id: String, val action: Action)

    private val ID = Regex("^[A-Za-z0-9-]{1,64}$")

    private fun parse(json: String?): JSONObject? {
        if (json == null || json.length > MESSAGE_MAX) return null
        return try { JSONObject(json) } catch (_: Exception) { null }
    }

    private fun idOf(o: JSONObject): String? = (o.opt("id") as? String)?.takeIf { ID.matches(it) }

    /** The posted id when it is well formed: a refused request is still answered, or the page's button waits. */
    fun postedId(json: String?): String? = parse(json)?.let(::idOf)

    /** The request out of a posted message; null for anything else. */
    fun request(json: String?): Request? {
        val o = parse(json) ?: return null
        val id = idOf(o) ?: return null
        val action = when (o.opt("action") as? String) {
            "start" -> Action.START
            "stop" -> Action.STOP
            "cancel" -> Action.CANCEL
            else -> return null
        }
        return Request(id, action)
    }

    /**
     * May this frame use the microphone? Only the main frame of a paired Mac's page (`paired`: the origins the
     * shell last allowed), and only while the WebView still shows that page.
     */
    fun accepts(isMainFrame: Boolean, sourceOrigin: String?, pageUrl: String?, paired: (String) -> Boolean): Boolean {
        if (!isMainFrame) return false
        val origin = ShellRules.macOrigin(sourceOrigin) ?: return false
        if (origin != ShellRules.originOf(pageUrl)) return false
        return paired(origin)
    }

    /** Did a finger go down recently enough for a `start` to be the person's own? Times are elapsedRealtime. */
    fun touched(lastDownAt: Long?, now: Long): Boolean {
        if (lastDownAt == null) return false
        return now - lastDownAt in 0..TOUCH_GRACE_MS
    }

    /** Is a hold of `ms` long enough to hold speech? */
    fun longEnough(ms: Long): Boolean = ms >= MIN_MS

    /** May a clip of `bytes` be handed to the page? */
    fun fits(bytes: Long): Boolean = bytes in 1..MAX_BYTES

    /** One answer to the page, as JSON. `fields` never replace the id or the state. */
    fun outcome(id: String, state: String, fields: Map<String, Any?> = emptyMap()): String {
        val o = JSONObject()
        for ((key, value) in fields) o.put(key, value)
        o.put("id", id)
        o.put("state", state)
        return o.toString()
    }
}
