// CallLayerPlugin.kt — the floating call (Nov 22 2026), the Android twin of CallLayerPlugin.swift. A voice call runs in
// the shell's page (the Mac's plain-http page gets no microphone), so leaving that page would end the call. Minimize
// instead lays a second WebView with the Mac's page over the shell's, plus a small draggable bubble; the call keeps
// running underneath.
//   show({ url, label, state, alert })  load (or show again) the Mac's page at `url` and the bubble → { shown }
//   hide()                              hide both, keeping the page loaded → { url }
//   close()                             drop both → { url }
//   bubble({ label, state, alert })     what the bubble shows: the clock, paused/muted, a red ring when the central needs you
//   event `expand` { url }              the bubble was tapped, Back left the page's first screen, or the page tried to
//                                       open the app's own page (a reauth, Call AASC): the layer hid itself
// The page shares the app's cookies (the shell sets this call's session cookie first) and the shell WebView's user
// agent, and stays on the origin it was opened on: other links open in the browser. No Capacitor bridge, no dictation
// bridge (the call holds the mic). MainActivity sends Back here first (handleBack) and, with the biometric lock on,
// a resume past the relock time hides the page (checkLock) so the shell's lock decides first. Shell page only (ShellOnly.kt).
package work.aasc.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlin.math.abs

@CapacitorPlugin(name = "CallLayer")
class CallLayerPlugin : Plugin() {
    companion object {
        /** The loaded plugin, for MainActivity's Back and resume. Main thread only. */
        @JvmField
        @Volatile
        var active: CallLayerPlugin? = null
    }

    private var page: WebView? = null
    /** The Mac origin the page was opened on (http://host:port); it never leaves it. */
    private var pageOrigin: String? = null
    private var bubble: TextView? = null

    override fun load() {
        active = this
    }

    @PluginMethod
    fun show(call: PluginCall) = fromShellOnly(call) {
        val raw = call.getString("url")
        val origin = CallLayerRules.pageOrigin(raw)
        val main = bridge.webView
        val parent = main?.parent as? ViewGroup
        if (raw == null || origin == null) {
            call.reject("Bad page", "BAD_URL")
            return@fromShellOnly
        }
        if (main == null || parent == null) {
            call.reject("The phone couldn't do that.", "FAILED")
            return@fromShellOnly
        }
        var shown = page
        if (shown == null || pageOrigin != origin) {
            drop()
            shown = makePage(main, parent)
            page = shown
            pageOrigin = origin
            shown.loadUrl(raw)
        }
        shown.visibility = View.VISIBLE
        val b = bubble ?: makeBubble(parent)
        b.visibility = View.VISIBLE
        update(b, call)
        b.bringToFront()
        call.resolve(JSObject().put("shown", true))
    }

    @PluginMethod
    fun hide(call: PluginCall) = fromShellOnly(call) {
        page?.visibility = View.GONE
        bubble?.visibility = View.GONE
        call.resolve(JSObject().put("url", page?.url ?: JSObject.NULL))
    }

    @PluginMethod
    fun close(call: PluginCall) = fromShellOnly(call) {
        val url = page?.url
        drop()
        call.resolve(JSObject().put("url", url ?: JSObject.NULL))
    }

    @PluginMethod
    fun bubble(call: PluginCall) = fromShellOnly(call) {
        bubble?.let { update(it, call) }
        call.resolve()
    }

    // ── The page ─────────────────────────────────────────────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun makePage(main: WebView, parent: ViewGroup): WebView {
        val web = WebView(activity)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // The shell WebView's user agent: the Mac's UI sees the phone app exactly as there.
            userAgentString = main.settings.userAgentString
            setSupportMultipleWindows(false)  // target=_blank and window.open come through shouldOverrideUrlLoading
        }
        web.setBackgroundColor(Color.WHITE)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val url = request.url.toString()
                if (ShellRules.originOf(url) == pageOrigin) return false
                leave(url)
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                // The page's renderer died: drop the page (a dead WebView can't be used) and show the call.
                val wasShown = view.visibility == View.VISIBLE
                if (view === page) drop()
                if (wasShown) notifyListeners("expand", JSObject().put("url", JSObject.NULL))
                return true
            }
        }
        // Same place and size as the shell's WebView, just above it.
        val lp = (main.layoutParams as? ViewGroup.MarginLayoutParams)?.let { ViewGroup.MarginLayoutParams(it) }
            ?: ViewGroup.MarginLayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        parent.addView(web, parent.indexOfChild(main) + 1, lp)
        return web
    }

    private fun drop() {
        page?.let {
            it.stopLoading()
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        page = null
        pageOrigin = null
        bubble?.let { (it.parent as? ViewGroup)?.removeView(it) }
        bubble = null
    }

    /** Back to the call: hide the page and the bubble and tell the shell where the page was. */
    private fun expand() {
        val web = page ?: return
        if (web.visibility != View.VISIBLE) return
        web.visibility = View.GONE
        bubble?.visibility = View.GONE
        notifyListeners("expand", JSObject().put("url", web.url ?: JSObject.NULL))
    }

    /** Where a link that isn't on the page's own origin goes: the app's page → back to the call; the web → a browser. */
    private fun leave(url: String) {
        if (ShellRules.isShellPage(url, bridge.localUrl)) {
            expand()
            return
        }
        val uri = Uri.parse(url)
        if (uri.scheme != "http" && uri.scheme != "https") return
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (e: Exception) {
            // No browser: nothing to open it with.
        }
    }

    /** MainActivity's Back while the page shows: the page's own back (BackRules), else its history, else the call. */
    fun handleBack(): Boolean {
        val web = page ?: return false
        if (web.visibility != View.VISIBLE) return false
        web.evaluateJavascript(BackRules.ASK_PAGE) { result ->
            when (BackRules.answer(result)) {
                BackRules.Answer.HANDLED -> Unit
                BackRules.Answer.LEAVE -> expand()
                BackRules.Answer.NONE -> if (web.canGoBack()) web.goBack() else expand()
            }
        }
        return true
    }

    /** With the lock on and the relock time passed, the shell must decide before the Mac's page shows again. */
    fun checkLock(pausedAt: Long, now: Long) {
        val web = page ?: return
        if (web.visibility != View.VISIBLE) return
        val settings = activity.getSharedPreferences(LockRules.PREFS, Context.MODE_PRIVATE).getString(LockRules.SETTINGS_KEY, null)
        if (LockRules.resumeUrl(settings, bridge.localUrl, web.url, pausedAt, now) != null) expand()
    }

    // ── The bubble ───────────────────────────────────────────────────────────────────────────────────────────────

    private fun dp(v: Float): Float = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, activity.resources.displayMetrics)

    @SuppressLint("ClickableViewAccessibility")
    private fun makeBubble(parent: ViewGroup): TextView {
        val b = TextView(activity)
        b.setTextColor(Color.WHITE)
        b.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 17f)  // dp, not sp: the pill keeps its size
        b.typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
        b.fontFeatureSettings = "tnum"
        b.gravity = Gravity.CENTER
        b.minWidth = dp(88f).toInt()
        b.setPadding(dp(16f).toInt(), 0, dp(18f).toInt(), 0)
        b.elevation = dp(8f)
        b.isClickable = true
        b.isFocusable = true
        parent.addView(b, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48f).toInt()))
        bubble = b
        val slop = ViewConfiguration.get(activity).scaledTouchSlop
        var downX = 0f
        var downY = 0f
        var startX = 0f
        var startY = 0f
        var dragging = false
        b.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = v.x; startY = v.y; dragging = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX
                    val dy = e.rawY - downY
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) dragging = true
                    if (dragging) place(v, startX + dx, startY + dy)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragging) v.performClick()
                    true
                }
                else -> true
            }
        }
        b.setOnClickListener { expand() }
        // Right edge, a third of the way down: clear of the Mac page's top bar and its tab bar.
        b.post { place(b, Float.MAX_VALUE, parent.height / 3f) }
        b.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ -> place(v, v.x, v.y) }
        return b
    }

    /** Puts the bubble at (x, y), kept inside the visible screen: off the status bar, the cutout and the gesture bar. */
    private fun place(v: View, x: Float, y: Float) {
        val parent = v.parent as? View ?: return
        val insets = ViewCompat.getRootWindowInsets(parent)
            ?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val m = dp(8f)
        val minX = (insets?.left ?: 0) + m
        val minY = (insets?.top ?: 0) + m
        val maxX = parent.width - (insets?.right ?: 0) - m - v.width
        val maxY = parent.height - (insets?.bottom ?: 0) - m - v.height
        val nx = x.coerceIn(minX, maxOf(minX, maxX))
        val ny = y.coerceIn(minY, maxOf(minY, maxY))
        if (v.x != nx) v.x = nx
        if (v.y != ny) v.y = ny
    }

    private fun update(b: TextView, call: PluginCall) {
        val label = CallLayerRules.label(call.getString("label"))
        val state = CallLayerRules.state(call.getString("state"))
        val alert = call.getBoolean("alert") ?: false
        val dot = if (state == CallLayerRules.BubbleState.LIVE) Color.rgb(34, 197, 94) else Color.rgb(250, 191, 36)
        val text = SpannableString("●  $label")
        text.setSpan(ForegroundColorSpan(dot), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        b.text = text
        b.background = GradientDrawable().apply {
            cornerRadius = dp(24f)
            setColor(Color.argb(240, 15, 23, 42))
            if (alert) setStroke(dp(3f).toInt(), Color.rgb(239, 68, 68))
        }
        val what = when (state) {
            CallLayerRules.BubbleState.PAUSED -> "paused"
            CallLayerRules.BubbleState.MUTED -> "muted"
            CallLayerRules.BubbleState.LIVE -> label
        }
        b.contentDescription = "Call with AASC, $what${if (alert) ", needs you" else ""}. Opens the call."
    }
}
