// ShellBridgePlugin.kt — the shell's other native needs (AASC-17):
//   setSessionCookie / clearSessionCookie  the Mac's session cookie, HttpOnly, so the page can't read it
//   allowOrigins                           which paired-Mac http origins the WebView may load
//   scanQr                                 Google's code scanner (Play services): no camera
//                                          permission, the app only receives the decoded text
// Serves the bundled shell page only (ShellOnly.kt).
package work.aasc.mobile

import android.net.Uri
import android.webkit.CookieManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

@CapacitorPlugin(name = "ShellBridge")
class ShellBridgePlugin : Plugin() {
    /** The http origins of the paired Macs' paths, as the shell last listed them. */
    @Volatile
    private var allowed: Set<String> = emptySet()

    @PluginMethod
    fun setSessionCookie(call: PluginCall) = fromShellOnly(call) {
        val origin = ShellRules.macOrigin(call.getString("origin"))
        val token = call.getString("token")
        val maxAge = call.getInt("maxAgeSeconds") ?: 0
        if (origin == null || !ShellRules.isSessionToken(token) || maxAge !in 1..ShellRules.COOKIE_MAX_AGE_MAX) {
            call.reject("Bad session cookie", "BAD_COOKIE")
            return@fromShellOnly
        }
        // Same attributes as the Mac's own Set-Cookie (mobileRouter.ts), no Secure: plain http.
        writeCookie(call, origin, "auth_token=$token; Path=/; Max-Age=$maxAge; HttpOnly; SameSite=Strict")
    }

    @PluginMethod
    fun clearSessionCookie(call: PluginCall) = fromShellOnly(call) {
        val origin = ShellRules.macOrigin(call.getString("origin"))
        if (origin == null) {
            call.reject("Bad origin", "BAD_COOKIE")
            return@fromShellOnly
        }
        writeCookie(call, origin, "auth_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
    }

    private fun writeCookie(call: PluginCall, origin: String, cookie: String) {
        val cookies = CookieManager.getInstance()
        cookies.setCookie(origin, cookie) { ok ->
            cookies.flush()
            if (ok) call.resolve() else call.reject("The cookie wasn't stored", "FAILED")
        }
    }

    @PluginMethod
    fun allowOrigins(call: PluginCall) = fromShellOnly(call) {
        val raw = call.getArray("origins")?.toList<Any>() ?: emptyList()
        val origins = raw.map { ShellRules.macOrigin(it as? String) }
        if (origins.any { it == null }) {
            call.reject("Bad origin", "BAD_ORIGIN")
            return@fromShellOnly
        }
        allowed = origins.filterNotNull().toSet()
        call.resolve()
    }

    @PluginMethod
    fun scanQr(call: PluginCall) = fromShellOnly(call) {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(activity, options).startScan()
            .addOnSuccessListener { code -> call.resolve(JSObject().put("value", code.rawValue)) }
            .addOnCanceledListener { call.resolve(JSObject()) }
            .addOnFailureListener { call.reject("The scanner isn't available on this phone.", "SCANNER_UNAVAILABLE") }
    }

    /**
     * Capacitor asks every plugin before it decides where a navigation goes. A paired Mac's
     * http origin stays in the WebView (false); anything else gets Capacitor's default: the
     * app's own origin and *.aasc.work stay, everything else opens in the system browser.
     */
    override fun shouldOverrideLoad(url: Uri): Boolean? {
        if (url.scheme != "http") return null
        return if (ShellRules.originOf(url.toString()) in allowed) false else null
    }
}
