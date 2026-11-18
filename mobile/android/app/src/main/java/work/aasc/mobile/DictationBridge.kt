// DictationBridge.kt — the phone app's hold-to-talk mic, app half (Nov 16 2026). The Mac's page is plain http, so
// it has no microphone of its own: it posts `{"id":…,"action":…}` to `window.aascDictation`, a WebMessageListener
// (src/lib/phoneDictation.ts), and this records for it. For the main frame of a paired Mac's page (DictationRules):
//   start   asks for RECORD_AUDIO the first time (answer: `permission`), else records AAC into a cache .m4a
//           (answer: `recording`), for at most DictationRules.MAX_MS
//   stop    ends the clip and hands it to the page as base64 (answer: `audio`); a hold too short to hold speech
//           is dropped (answer: `cancelled`, short)
//   cancel  drops it (answer: `cancelled`)
// A `start` is taken only just after a finger went down on the screen (MainActivity passes every touch to
// onTouchDown, DictationRules.touched): the page is plain http, and a script put into it must not be able to turn
// the microphone on by itself. A clip is dropped when the app leaves the screen and when the page reloads.
// Answers go back through the message's own reply proxy, so only the frame that asked hears them. The page sends
// the clip to its own Mac, which turns it into text. Nothing is kept on the phone: the file is removed as soon as
// it is read, and the whole folder at the next launch.
package work.aasc.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.Bridge
import com.getcapacitor.WebViewListener
import java.io.File
import java.util.UUID

/** Create in the activity's onCreate (the permission launcher must be registered before it starts). */
class DictationBridge(private val activity: ComponentActivity) {
    private class Clip(
        val id: String,
        val reply: JavaScriptReplyProxy,
        val file: File,
        val recorder: MediaRecorder,
        val startedAt: Long,
    )

    private class Ask(val id: String, val reply: JavaScriptReplyProxy)

    private var clip: Clip? = null
    private var asking: Ask? = null

    /** elapsedRealtime of the last finger down anywhere in the app; null before the first. */
    private var lastTouchDownAt: Long? = null

    /** MainActivity's dispatchTouchEvent calls this for each ACTION_DOWN. */
    fun onTouchDown() {
        lastTouchDownAt = SystemClock.elapsedRealtime()
    }

    private val permission: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val ask = asking ?: return@registerForActivityResult
            asking = null
            answer(ask.reply, ask.id, "permission", mapOf("granted" to granted))
        }

    private fun root(): File = File(activity.cacheDir, "aasc-dictation")

    /** Offer `window.aascDictation` to the pages loaded from now on. Without the WebView feature there is no mic. */
    fun install(bridge: Bridge) {
        val webView = bridge.webView ?: return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        // Clips left by a recording the app was killed under.
        root().deleteRecursively()
        // "*": a paired Mac's address is not known when the app starts, so every message is checked as it arrives.
        WebViewCompat.addWebMessageListener(webView, DictationRules.HANDLER, setOf("*")) { view, message, sourceOrigin, isMainFrame, reply ->
            onMessage(bridge, view, message, sourceOrigin, isMainFrame, reply)
        }
        // A reload or a move to another page leaves no one to hand the clip to: stop recording at once.
        bridge.addWebViewListener(object : WebViewListener() {
            override fun onPageStarted(webView: WebView) {
                clip?.let {
                    clip = null
                    release(it)
                    it.file.delete()
                }
            }
        })
    }

    /** The app is leaving the screen: a clip still recording is dropped. */
    fun onPause() {
        val current = clip ?: return
        clip = null
        release(current)
        current.file.delete()
        answer(current.reply, current.id, "failed", mapOf("message" to "The recording was interrupted. Try again."))
    }

    private fun onMessage(
        bridge: Bridge,
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        reply: JavaScriptReplyProxy,
    ) {
        if (!isMainFrame) return
        val text = message.data
        val paired: (String) -> Boolean = { origin ->
            (bridge.getPlugin("ShellBridge")?.instance as? ShellBridgePlugin)?.allows(origin) == true
        }
        val request = if (DictationRules.accepts(true, sourceOrigin.toString(), view.url, paired)) DictationRules.request(text) else null
        if (request == null) {
            // Answer a refusal too, or the page's button stays busy.
            DictationRules.postedId(text)?.let { answer(reply, it, "failed", mapOf("message" to "This page can't use the microphone.")) }
            return
        }
        when (request.action) {
            DictationRules.Action.START -> start(request.id, reply)
            DictationRules.Action.STOP -> finish(request.id, reply, keep = true)
            DictationRules.Action.CANCEL -> finish(request.id, reply, keep = false)
        }
    }

    private fun start(id: String, reply: JavaScriptReplyProxy) {
        // One clip at a time: a new hold drops whatever was still recording.
        clip?.let { end(it, keep = false, limit = false) }
        // Only a finger on the screen starts the microphone, never the page by itself.
        if (!DictationRules.touched(lastTouchDownAt, SystemClock.elapsedRealtime())) {
            answer(reply, id, "failed", mapOf("message" to "Hold the mic with a finger to record."))
            return
        }
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            record(id, reply)
            return
        }
        // The system dialog takes the touch, so nothing is recorded this time: the page says to hold again.
        asking?.let { answer(it.reply, it.id, "cancelled") }
        asking = Ask(id, reply)
        try {
            permission.launch(Manifest.permission.RECORD_AUDIO)
        } catch (_: Exception) {
            asking = null
            answer(reply, id, "failed", mapOf("message" to "The phone couldn't ask for the microphone."))
        }
    }

    private fun record(id: String, reply: JavaScriptReplyProxy) {
        val folder = root()
        folder.mkdirs()
        val file = File(folder, "${UUID.randomUUID()}.m4a")
        @Suppress("DEPRECATION")
        val recorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(activity) else MediaRecorder()
        try {
            // Speech-sized AAC: 16 kHz mono, from the source tuned for recognition (no gain riding).
            recorder.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioSamplingRate(16_000)
            recorder.setAudioChannels(1)
            recorder.setAudioEncodingBitRate(32_000)
            recorder.setMaxDuration(DictationRules.MAX_MS)
            recorder.setOutputFile(file.absolutePath)
            recorder.setOnInfoListener { _, what, _ ->
                // The two-minute limit: hand over what there is.
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) {
                    clip?.takeIf { it.recorder === recorder }?.let { end(it, keep = true, limit = true) }
                }
            }
            recorder.setOnErrorListener { _, _, _ ->
                clip?.takeIf { it.recorder === recorder }?.let {
                    clip = null
                    release(it)
                    it.file.delete()
                    answer(it.reply, it.id, "failed", mapOf("message" to "The recording failed. Try again."))
                }
            }
            recorder.prepare()
            recorder.start()
        } catch (_: Exception) {
            try { recorder.release() } catch (_: Exception) { /* already gone */ }
            file.delete()
            answer(reply, id, "failed", mapOf("message" to "The microphone couldn't start. Try again."))
            return
        }
        clip = Clip(id, reply, file, recorder, SystemClock.elapsedRealtime())
        answer(reply, id, "recording")
    }

    private fun finish(id: String, reply: JavaScriptReplyProxy, keep: Boolean) {
        val current = clip
        if (current == null || current.id != id) {
            // No such recording (the phone is still asking for the microphone, or it already ended): say so, the
            // page may be waiting. The permission answer still follows on its own.
            answer(reply, id, "cancelled")
            return
        }
        end(current, keep, limit = false)
    }

    /** Stop the recorder and drop its file, with no answer. */
    private fun release(current: Clip): Boolean {
        // stop() throws when nothing was recorded yet (a hold of a few milliseconds).
        val stopped = try { current.recorder.stop(); true } catch (_: RuntimeException) { false }
        try { current.recorder.release() } catch (_: Exception) { /* already gone */ }
        if (!stopped) current.file.delete()
        return stopped
    }

    /** Stop the recorder, answer the page, and leave nothing behind. `limit`: the recorder stopped by itself. */
    private fun end(current: Clip, keep: Boolean, limit: Boolean) {
        clip = null
        val ms = if (limit) DictationRules.MAX_MS.toLong() else SystemClock.elapsedRealtime() - current.startedAt
        val stopped = release(current)
        try {
            if (!keep) {
                answer(current.reply, current.id, "cancelled")
                return
            }
            if (!stopped || !DictationRules.longEnough(ms)) {
                answer(current.reply, current.id, "cancelled", mapOf("short" to true))
                return
            }
            if (!DictationRules.fits(current.file.length())) {
                answer(current.reply, current.id, "failed", mapOf("message" to "The recording couldn't be read. Try again."))
                return
            }
            val audio = Base64.encodeToString(current.file.readBytes(), Base64.NO_WRAP)
            answer(current.reply, current.id, "audio", mapOf("audio" to audio, "mime" to DictationRules.MIME, "ms" to ms))
        } catch (_: Exception) {
            answer(current.reply, current.id, "failed", mapOf("message" to "The recording couldn't be read. Try again."))
        } finally {
            current.file.delete()
        }
    }

    /** Tell the frame that asked. A page that has gone away hears nothing. */
    private fun answer(reply: JavaScriptReplyProxy, id: String, state: String, fields: Map<String, Any?> = emptyMap()) {
        try {
            reply.postMessage(DictationRules.outcome(id, state, fields))
        } catch (_: Exception) {
            // The frame is gone.
        }
    }
}
