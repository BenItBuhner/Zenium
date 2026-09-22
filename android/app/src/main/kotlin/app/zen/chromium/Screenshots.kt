package app.zen.chromium

import android.Manifest
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Outline
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executor

/**
 * Screenshots to the device's gallery (SH-07, SH-08; the core's `ScreenshotHost`). Take
 * Screenshot copies the visible area of the page ([TabWebView.copyViewport], before the flash so
 * the flash is not in it), flashes the page – a white view over the tab's frame that goes clear
 * in 120 ms, opacity alone (v2 §9.33) – and writes the picture to `MediaStore.Images` under
 * Pictures/Zenium, answering with the row's `content:` URI, a JPEG thumbnail for the preview
 * card, the picture's size and the file's. The card's Share puts the row on the system sheet,
 * Delete takes it out of the gallery, a tap on the thumbnail opens it in the system's viewer.
 *
 * Capture more: the whole page from the top ([TabWebView.captureLong], cut at about ten screens)
 * is held here under an id while the editor shows a scaled preview of it; Save crops the
 * full-resolution picture to the editor's rows and writes it the same way (and shares it, for
 * the editor's Share). A closed editor lets the capture go.
 */
class Screenshots(private val host: Host, private val io: Executor) {
    private val activity get() = host.activity
    private val main = Handler(Looper.getMainLooper())
    /** Long captures held for the editor, by id (one editor at a time; a stale one is dropped by `discardLong`). */
    private val held = HashMap<String, PageCapture.Capture>()
    private var seq = 0

    // --- Take Screenshot ---------------------------------------------------------------------------

    /** The visible area to the gallery; null when the page could not be drawn or the write failed. */
    fun capture(tabId: String, reply: (Any?) -> Unit) {
        val tab = host.tabs.get(tabId)
        if (tab == null) {
            reply(null)
            return
        }
        tab.copyViewport { bitmap ->
            if (bitmap == null) {
                reply(null)
                return@copyViewport
            }
            flash(tab)
            withStorage { granted ->
                if (!granted) {
                    bitmap.recycle()
                    reply(null)
                    return@withStorage
                }
                io.execute {
                    val saved = runCatching { save(bitmap) }.getOrNull()
                    bitmap.recycle()
                    main.post { reply(saved) }
                }
            }
        }
    }

    /**
     * The flash (v2 §9.33): a white view laid over the tab's frame – its bounds, its translation
     * during a pull, its rounded corners – fading from opaque to clear in [FLASH_MS], linear,
     * opacity alone; nothing moves or scales. Gone from the tree when it has cleared.
     */
    private fun flash(tab: TabWebView) {
        val parent = tab.parent as? ViewGroup ?: return
        if (tab.width <= 0 || tab.height <= 0) return
        val radius = tab.radiusPx
        val overlay = View(activity).apply {
            setBackgroundColor(Color.WHITE)
            isClickable = false
            isFocusable = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setRoundRect(0, 0, view.width, view.height, radius)
                }
            }
            translationY = tab.translationY
        }
        val lp = FrameLayout.LayoutParams(tab.width, tab.height).apply {
            leftMargin = tab.left
            topMargin = tab.top
        }
        parent.addView(overlay, parent.indexOfChild(tab) + 1, lp)
        overlay.alpha = 1f
        overlay.animate()
            .alpha(0f)
            .setDuration(FLASH_MS)
            .setInterpolator(LinearInterpolator())
            .withEndAction { parent.removeView(overlay) }
            .start()
    }

    // --- Capture more (the long screenshot) ------------------------------------------------------

    /** The whole page from the top, held for the editor; null when the page could not be drawn. */
    fun captureLong(tabId: String, reply: (Any?) -> Unit) {
        val tab = host.tabs.get(tabId)
        if (tab == null) {
            reply(null)
            return
        }
        tab.captureLong { capture ->
            if (capture == null) {
                reply(null)
                return@captureLong
            }
            val id = "long-${++seq}"
            held[id] = capture
            val bitmap = capture.bitmap
            io.execute {
                val preview = runCatching { dataUrl(bitmap, PREVIEW_MAX_WIDTH, Int.MAX_VALUE, PREVIEW_QUALITY) }.getOrNull()
                main.post {
                    if (preview == null || held[id] !== capture) {
                        if (held.remove(id) === capture) bitmap.recycle()
                        reply(null)
                        return@post
                    }
                    reply(
                        json(
                            "id" to id,
                            "preview" to preview,
                            "width" to bitmap.width,
                            "height" to bitmap.height,
                            "viewportHeight" to capture.viewportHeightPx
                        )
                    )
                }
            }
        }
    }

    /**
     * The held capture cropped to the rows `[top, bottom)` of the picture, to the gallery – and
     * with `share`, onto the system sheet. Null when the capture is gone or the write failed.
     */
    fun saveLong(id: String, top: Int, bottom: Int, share: Boolean, reply: (Any?) -> Unit) {
        val capture = held.remove(id)
        if (capture == null) {
            reply(null)
            return
        }
        val bitmap = capture.bitmap
        val rows = cropRows(top, bottom, bitmap.height)
        withStorage { granted ->
            if (!granted) {
                bitmap.recycle()
                reply(null)
                return@withStorage
            }
            io.execute {
                val cropped = if (rows.first == 0 && rows.last + 1 == bitmap.height) bitmap
                else Bitmap.createBitmap(bitmap, 0, rows.first, bitmap.width, rows.last + 1 - rows.first)
                val saved = runCatching { save(cropped) }.getOrNull()
                if (cropped !== bitmap) cropped.recycle()
                bitmap.recycle()
                main.post {
                    reply(saved)
                    if (saved != null && share) share(saved.str("uri")) {}
                }
            }
        }
    }

    /** The editor closed without saving. */
    fun discardLong(id: String) {
        held.remove(id)?.bitmap?.recycle()
    }

    // --- the card's actions -------------------------------------------------------------------------

    /** The gallery row on the system share sheet (Zenium's own actions have no link here, so none). */
    fun share(uri: String, reply: (Any?) -> Unit) {
        val content = Uri.parse(uri)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = activity.contentResolver.getType(content) ?: "image/png"
            putExtra(Intent.EXTRA_STREAM, content)
            clipData = ClipData.newUri(activity.contentResolver, "Screenshot", content)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        host.share.launchChooser(send, null, null, reply)
    }

    /** The row out of the gallery (the app owns it, so no consent prompt); false when it could not go. */
    fun delete(uri: String, reply: (Any?) -> Unit) {
        val content = Uri.parse(uri)
        io.execute {
            val gone = runCatching { activity.contentResolver.delete(content, null, null) > 0 }.getOrDefault(false)
            main.post { reply(gone) }
        }
    }

    /** The picture in the system's viewer (Photos, or whatever handles images). */
    fun open(uri: String, reply: (Any?) -> Unit) {
        val content = Uri.parse(uri)
        val view = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(content, activity.contentResolver.getType(content) ?: "image/*")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            activity.startActivity(view)
            reply(null)
        } catch (e: Exception) {
            reply(Host.Rejection(e.message ?: "no app can show the picture"))
        }
    }

    // --- writing ---------------------------------------------------------------------------------------

    /**
     * Android 10+ writes to the gallery through MediaStore with no permission; before it, the
     * public Pictures folder wants `WRITE_EXTERNAL_STORAGE`, asked for here on the first
     * screenshot (Downloads asks the same way).
     */
    private fun withStorage(then: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            then(true)
            return
        }
        val permission = Manifest.permission.WRITE_EXTERNAL_STORAGE
        if (ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED) {
            then(true)
            return
        }
        activity.requestRuntimePermissions(listOf(permission)) {
            then(ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED)
        }
    }

    /**
     * The picture as a PNG in the gallery under Pictures/Zenium, and what the card shows of it.
     * Off the main thread. `MediaStore.Images` on Android 10+ (the row pending while the bytes
     * are written, so the gallery never shows a half file); before it the file under the public
     * Pictures folder and a row pointing at it.
     */
    private fun save(bitmap: Bitmap): JSONObject? {
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        val bytes = out.toByteArray()
        val name = fileName(System.currentTimeMillis())
        val resolver = activity.contentResolver
        val uri: Uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, name)
                put(MediaStore.Images.Media.MIME_TYPE, MIME)
                put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$FOLDER")
                put(MediaStore.Images.Media.WIDTH, bitmap.width)
                put(MediaStore.Images.Media.HEIGHT, bitmap.height)
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
            val row = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
            try {
                resolver.openOutputStream(row)?.use { it.write(bytes) } ?: throw IllegalStateException("no stream")
            } catch (e: Exception) {
                resolver.delete(row, null, null)
                throw e
            }
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            resolver.update(row, values, null, null)
            row
        } else {
            @Suppress("DEPRECATION")
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), FOLDER).apply { mkdirs() }
            val file = File(dir, name)
            file.writeBytes(bytes)
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, name)
                put(MediaStore.Images.Media.MIME_TYPE, MIME)
                @Suppress("DEPRECATION")
                put(MediaStore.Images.Media.DATA, file.absolutePath)
                put(MediaStore.Images.Media.WIDTH, bitmap.width)
                put(MediaStore.Images.Media.HEIGHT, bitmap.height)
            }
            resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: Uri.fromFile(file)
        }
        val thumbnail = dataUrl(bitmap, THUMBNAIL_MAX_SIDE, THUMBNAIL_MAX_SIDE, THUMBNAIL_QUALITY)
        return json(
            "uri" to uri.toString(),
            "thumbnail" to thumbnail,
            "width" to bitmap.width,
            "height" to bitmap.height,
            "bytes" to bytes.size
        )
    }

    /**
     * `bitmap` as a JPEG data URL at up to `maxWidth` × `maxHeight` (scaled down only). The
     * original is left as it was – encoded as it is when it already fits, so a long capture no
     * wider than the preview is not copied whole (a second 13 MB bitmap) just to be encoded.
     */
    private fun dataUrl(bitmap: Bitmap, maxWidth: Int, maxHeight: Int, quality: Int): String {
        val small = scaled(bitmap, maxWidth, maxHeight)
        val out = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.JPEG, quality, out)
        if (small !== bitmap) small.recycle()
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    companion object {
        /** The flash's length (v2 §9.33): white to clear. */
        const val FLASH_MS = 120L
        /** The gallery folder under Pictures. */
        const val FOLDER = "Zenium"
        const val MIME = "image/png"
        /** The card's thumbnail fits this square (the card draws it at up to 96 CSS px). */
        const val THUMBNAIL_MAX_SIDE = 320
        const val THUMBNAIL_QUALITY = 82
        /** The editor's preview is a phone's width at most; the crop is cut from the full picture. */
        const val PREVIEW_MAX_WIDTH = 720
        const val PREVIEW_QUALITY = 72

        private val STAMP = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)

        /** `Zenium_20260922-102300.png`: the system's own screenshot names, under the app's. */
        fun fileName(nowMs: Long): String = "Zenium_${STAMP.format(Date(nowMs))}.png"

        /**
         * The rows `[top, bottom)` of a picture `height` tall as the editor asked, made sane: within
         * the picture, in order, at least one row – a crop that names nothing keeps the whole.
         */
        fun cropRows(top: Int, bottom: Int, height: Int): IntRange {
            if (height <= 0) return 0..0
            val from = top.coerceIn(0, height - 1)
            val to = bottom.coerceIn(from + 1, height)
            return from until to
        }

        /**
         * `bitmap` scaled (down only) to fit `maxWidth` × `maxHeight`: a new bitmap, the caller's
         * to recycle, or `bitmap` itself when it already fits (no copy is made of it).
         */
        fun scaled(bitmap: Bitmap, maxWidth: Int, maxHeight: Int = Int.MAX_VALUE): Bitmap {
            val (w, h) = fitted(bitmap.width, bitmap.height, maxWidth, maxHeight)
            if (w == bitmap.width && h == bitmap.height) return bitmap
            return Bitmap.createScaledBitmap(bitmap, w, h, true)
        }

        /** The size a picture `width` × `height` scales to within `maxWidth` × `maxHeight` (down only, the ratio kept). */
        fun fitted(width: Int, height: Int, maxWidth: Int, maxHeight: Int): Pair<Int, Int> {
            if (width <= 0 || height <= 0) return 1 to 1
            val scale = minOf(1.0, maxWidth.toDouble() / width, maxHeight.toDouble() / height)
            return (width * scale).toInt().coerceAtLeast(1) to (height * scale).toInt().coerceAtLeast(1)
        }
    }
}
