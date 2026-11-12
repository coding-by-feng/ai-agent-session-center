// AuthSessionPlugin.kt — Google sign-in for the phone (plan 17, security rule 6).
//   start({ url, callbackScheme?, callbackPrefix? })  → { url } on the callback, { cancelled: true } when closed
//
// A Custom Tab opens the backend's sign-in page (https://api.aasc.work/… only, AuthSessionRules). The answer
// is the verified App Link https://aasc.work/auth/google?… (AndroidManifest's autoVerify filter), carrying a
// one-use PKCE code useless without the verifier the shell holds. MainActivity is singleTask, so the link
// brings it back (clearing the tab above it) and Capacitor hands the intent to handleOnNewIntent here.
//
// Cancel: coming back with no callback means the user closed the tab. The link's intent normally arrives
// before onResume, but not always, so the resume only schedules a check CANCEL_DELAY_MS later and a real
// callback in the meantime wins. One session at a time; serves the bundled shell page only (ShellOnly.kt).
// `callbackScheme` is iOS's and ignored here. A callback after the process died has no call to answer.
package work.aasc.mobile

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.browser.customtabs.CustomTabsIntent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "AuthSession")
class AuthSessionPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())

    // All main thread: plugin calls run there (fromShellOnly), and so do Capacitor's lifecycle hooks.
    private var pending: PluginCall? = null
    private var prefix: String = AuthSessionRules.DEFAULT_CALLBACK_PREFIX
    /** The activity went to the background after the tab was opened (so a resume means it came back). */
    private var away = false
    /** Bumped per session, so a delayed cancel check never answers a later session. */
    private var generation = 0

    @PluginMethod
    fun start(call: PluginCall) = fromShellOnly(call) {
        val url = AuthSessionRules.startUrl(call.getString("url"))
        val callbackPrefix = AuthSessionRules.prefix(call.getString("callbackPrefix"))
        if (url == null || callbackPrefix == null) {
            call.reject("Bad sign-in address", "BAD_URL")
            return@fromShellOnly
        }
        if (pending != null) {
            call.reject("busy", "BUSY")
            return@fromShellOnly
        }
        pending = call
        prefix = callbackPrefix
        away = false
        generation += 1
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, Uri.parse(url))
        } catch (e: ActivityNotFoundException) {
            pending = null
            call.reject("No browser to sign in with.", "FAILED")
        }
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        val call = pending ?: return
        if (intent.action != Intent.ACTION_VIEW) return
        val url = intent.dataString
        // Another link (a pairing link, say) isn't the answer: the session stays open until a resume cancels it.
        if (!AuthSessionRules.callbackMatches(url, prefix)) return
        pending = null
        // Never logged: it carries the code.
        call.resolve(JSObject().put("url", url))
    }

    override fun handleOnPause() {
        super.handleOnPause()
        if (pending != null) away = true
    }

    override fun handleOnResume() {
        super.handleOnResume()
        if (pending == null || !away) return
        away = false
        val session = generation
        main.postDelayed({
            val call = pending
            if (call != null && session == generation && !away) {
                pending = null
                call.resolve(JSObject().put("cancelled", true))
            }
        }, CANCEL_DELAY_MS)
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        main.removeCallbacksAndMessages(null)
    }

    private companion object {
        /** How long a resume waits for the App Link before it counts as the tab being closed. */
        const val CANCEL_DELAY_MS = 800L
    }
}
