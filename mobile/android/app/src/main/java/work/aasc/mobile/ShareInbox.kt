// ShareInbox.kt — text or images shared into AASC from another app (AASC-21 M5).
//
// ACTION_SEND / ACTION_SEND_MULTIPLE only hand the item to the app: it waits here, in memory
// (never on disk: shared text can be anything), until the shell takes it with
// ShellBridge.takeShare and lets the user pick a session. Everything else (cleaning the text,
// stripping image metadata, the 64 KB / 4-image / 2 MB limits, arriving paused) is the
// shell's shareToQueue.ts. Here: at most 4 images, each read only up to the size limit,
// HEIC/HEIF turned into JPEG, other types refused.
package work.aasc.mobile

import android.content.ContentResolver
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.io.ByteArrayOutputStream

/** What the share sheet handed over, before anything is read. */
internal data class PendingShare(val text: String?, val textTooLong: Boolean, val images: List<Uri>, val tooMany: Boolean)

internal object ShareInbox {
    @Volatile
    private var pending: PendingShare? = null

    /** Keep a share intent; true when it was one. A newer share replaces an untaken one. */
    fun accept(intent: Intent?, ownPackage: String): Boolean {
        val action = intent?.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return false
        val rawText = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
        val uris = streams(intent, ownPackage)
        val share = PendingShare(
            text = ShareRules.carriedText(rawText),
            textTooLong = rawText != null && ShareRules.carriedText(rawText) == null,
            images = uris.take(ShareRules.MAX_IMAGES),
            tooMany = uris.size > ShareRules.MAX_IMAGES,
        )
        if (share.text == null && !share.textTooLong && share.images.isEmpty()) return false
        pending = share
        return true
    }

    @Suppress("DEPRECATION")
    private fun streams(intent: Intent, ownPackage: String): List<Uri> {
        val list = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        } else {
            val one = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableExtra(Intent.EXTRA_STREAM)
            listOfNotNull(one)
        }
        // Only content: URIs from another app; never a file: path or a link into this app's own storage.
        return list.orEmpty().filter { it.scheme == ContentResolver.SCHEME_CONTENT && !ShareRules.isOwnAuthority(it.authority, ownPackage) }
    }

    /** Hand the share to the shell once (then it is gone), reading the images now. Off the main thread. */
    fun take(resolver: ContentResolver): JSObject? {
        val share = pending ?: return null
        pending = null
        val out = JSObject()
        share.text?.let { out.put("text", it) }
        var problem: String? = when {
            share.tooMany -> "too-many"
            share.textTooLong -> "text-too-long"
            else -> null
        }
        val images = JSArray()
        if (problem == null) {
            for ((i, uri) in share.images.withIndex()) {
                val read = readImage(resolver, uri, i)
                if (read is ImageRead.Refused) {
                    problem = read.reason
                    break
                }
                images.put((read as ImageRead.Ok).json)
            }
        }
        out.put("images", if (problem == null) images else JSArray())
        problem?.let { out.put("problem", it) }
        return out
    }

    private sealed interface ImageRead {
        data class Ok(val json: JSObject) : ImageRead
        data class Refused(val reason: String) : ImageRead
    }

    private fun readImage(resolver: ContentResolver, uri: Uri, index: Int): ImageRead {
        val mime = resolver.getType(uri)?.lowercase()
        val convert = ShareRules.needsJpeg(mime)
        if (!ShareRules.isAcceptedImage(mime) && !convert) return ImageRead.Refused("unsupported")
        // A HEIC can be larger than its JPEG; read it up to a looser cap and check after converting.
        val raw = readCapped(resolver, uri, if (convert) ShareRules.MAX_IMAGE_BYTES * 3 else ShareRules.MAX_IMAGE_BYTES)
            ?: return ImageRead.Refused("too-large")
        val (bytes, type) = if (convert) (toJpeg(raw) ?: return ImageRead.Refused("unreadable")) to "image/jpeg" else raw to mime!!
        if (bytes.size > ShareRules.MAX_IMAGE_BYTES) return ImageRead.Refused("too-large")
        val json = JSObject()
            .put("name", ShareRules.safeName(displayName(resolver, uri), index))
            .put("mimeType", type)
            .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        return ImageRead.Ok(json)
    }

    /** The whole file, or null when it is longer than `max` (or can't be opened). */
    private fun readCapped(resolver: ContentResolver, uri: Uri, max: Int): ByteArray? = try {
        resolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > max) return null
            }
            out.toByteArray()
        }
    } catch (_: Exception) {
        null
    }

    private fun toJpeg(bytes: ByteArray): ByteArray? {
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        return ByteArrayOutputStream().use { out ->
            // A fresh JPEG carries no EXIF; the shell strips metadata again anyway.
            if (bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)) out.toByteArray() else null
        }.also { bitmap.recycle() }
    }

    private fun displayName(resolver: ContentResolver, uri: Uri): String? = try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }
}
