// BackRules.kt — the Android back button on a Mac's page (AASC-48). Pure (java.net.URI through
// ShellRules), so the JVM unit tests cover it.
//
// The WebView skips history entries a page added without a tap (Chromium's history-manipulation
// intervention): left to walk the history, the button passed the phone frame's screens and its
// "Press back again to leave" warning, or did nothing. So MainActivity asks the page
// (window.__aascNativeBack): it pops its own screen or warns ("handled"), or says "leave" for a
// second back at a tab root. A page without the hook (an older Mac) gets Capacitor's own back.
package work.aasc.mobile

internal object BackRules {
    enum class Answer { HANDLED, LEAVE, NONE }

    /** The page's question, run through evaluateJavascript: its answer, or "none" without the hook. */
    const val ASK_PAGE =
        "(function(){try{return typeof window.__aascNativeBack==='function'?window.__aascNativeBack():'none'}catch(e){return 'none'}})()"

    /** Is the WebView on a Mac's page (anything with an origin that isn't the bundled shell)? */
    fun asksPage(shellUrl: String?, currentUrl: String?): Boolean {
        val page = ShellRules.originOf(currentUrl) ?: return false
        return page != ShellRules.originOf(shellUrl)
    }

    /** evaluateJavascript's result (a JSON value) as an answer. */
    fun answer(result: String?): Answer = when (result) {
        "\"leave\"" -> Answer.LEAVE
        "\"handled\"" -> Answer.HANDLED
        else -> Answer.NONE
    }
}
