// ShellBridgePlugin.kt — the shell's other native needs:
//   setSessionCookie / clearSessionCookie  the Mac's session cookie, HttpOnly, so the page can't read it (AASC-17)
//   allowOrigins                           which paired-Mac http origins the WebView may load (AASC-17)
//   scanQr                                 Google's code scanner (Play services): no camera
//                                          permission, the app only receives the decoded text (AASC-17)
//   pushConfigured                         is the Firebase config built in? Push stays off until it is (AASC-19)
//   takeShare                              the item shared from another app, once (AASC-21, ShareInbox.kt)
//   biometricStatus / authenticate / bootId  the biometric lock's native half (AASC-21, biometricLock.ts decides)
//   writeWidget                            the home-screen widget's model (AASC-21, AascWidgetProvider.kt)
//   discoverMacs                           Bonjour `_aasc._tcp` on this Wi-Fi, for the LAN rescan (LanDiscovery.kt)
// Serves the bundled shell page only (ShellOnly.kt).
package work.aasc.mobile

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.CookieManager
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSArray
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
     * The google-services Gradle plugin turns google-services.json into a `google_app_id`
     * string; without it Firebase can't start and the push plugin's register() would throw.
     */
    @PluginMethod
    fun pushConfigured(call: PluginCall) = fromShellOnly(call) {
        @Suppress("DiscouragedApi")
        val id = context.resources.getIdentifier("google_app_id", "string", context.packageName)
        call.resolve(JSObject().put("configured", id != 0))
    }

    @PluginMethod
    fun takeShare(call: PluginCall) = fromShellOnlyInBackground(call) {
        call.resolve(JSObject().put("share", ShareInbox.take(context.contentResolver)))
    }

    /** API 30+: a strong biometric or the screen lock; older: any enrolled biometric. */
    private fun authenticators(): Int =
        if (Build.VERSION.SDK_INT >= 30) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_WEAK

    @PluginMethod
    fun biometricStatus(call: PluginCall) = fromShellOnly(call) {
        val result = BiometricManager.from(context).canAuthenticate(authenticators())
        call.resolve(JSObject().put("available", result == BiometricManager.BIOMETRIC_SUCCESS))
    }

    @PluginMethod
    fun authenticate(call: PluginCall) = fromShellOnly(call) {
        val host = activity as? FragmentActivity
        if (host == null) {
            call.reject("No screen to ask on", "FAILED")
            return@fromShellOnly
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(PromptRules.title(call.getString("reason")))
            .setAllowedAuthenticators(authenticators())
            .apply { if (Build.VERSION.SDK_INT < 30) setNegativeButtonText("Cancel") }
            .build()
        val prompt = BiometricPrompt(host, ContextCompat.getMainExecutor(context), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                call.resolve(JSObject().put("ok", true))
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                // Cancelled, locked out or no hardware: the app stays locked. The reason is a code, never user data.
                call.resolve(JSObject().put("ok", false).put("code", errorCode))
            }
        })
        prompt.authenticate(info)
    }

    /** Changes on every reboot (biometricLock.ts locks after one). */
    @PluginMethod
    fun bootId(call: PluginCall) = fromShellOnly(call) {
        val count = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
        call.resolve(JSObject().put("bootId", if (count >= 0) count.toString() else null))
    }

    @PluginMethod
    fun writeWidget(call: PluginCall) = fromShellOnly(call) {
        val json = call.getString("json")
        if (WidgetRules.parse(json) == null) {
            call.reject("Bad widget model", "BAD_WIDGET")
            return@fromShellOnly
        }
        context.getSharedPreferences(WidgetRules.PREFS, Context.MODE_PRIVATE).edit().putString(WidgetRules.KEY, json).apply()
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(ComponentName(context, AascWidgetProvider::class.java))
        if (ids.isNotEmpty()) AascWidgetProvider.render(context, manager, ids)
        call.resolve()
    }

    /** The Macs advertising on this Wi-Fi, and the phone's own addresses; the shell checks every address before it uses one. */
    @PluginMethod
    fun discoverMacs(call: PluginCall) = fromShellOnly(call) {
        LanDiscovery(context).browse(DiscoveryRules.browseMs(call.getInt("timeoutMs"))) { found ->
            val services = JSArray()
            found.forEach { services.put(JSObject().put("host", it.host).put("port", it.port)) }
            call.resolve(JSObject().put("services", services).put("local", JSArray(localIpv4())))
        }
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
