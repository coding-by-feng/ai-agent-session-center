// ShellOnly.kt — the app's plugins answer the bundled shell page and nothing else (AASC-17, plan 08 §2).
//
// Capacitor's bridge has no per-plugin origin control. On current WebViews it only reaches
// the app origin and allowNavigation hosts (*.aasc.work); on old ones (no WebMessageListener)
// any page could post to it. So each call checks the WebView's current page on the main
// thread: if it isn't https://localhost (the shell), the call is refused. A page that starts
// navigating to the shell and calls in the same breath is still the old page here, and an
// answer delivered after the shell loaded lands in the shell, never in the caller.
package work.aasc.mobile

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall

internal fun Plugin.fromShellOnly(call: PluginCall, work: () -> Unit) {
    bridge.executeOnMainThread {
        if (!ShellRules.isShellPage(bridge.webView?.url, bridge.localUrl)) {
            call.reject("Only the AASC app's own page may use this.", "ORIGIN_REFUSED")
            return@executeOnMainThread
        }
        try {
            work()
        } catch (e: Exception) {
            // The message never carries a value or a token.
            call.reject("The phone couldn't do that.", "FAILED")
        }
    }
}
