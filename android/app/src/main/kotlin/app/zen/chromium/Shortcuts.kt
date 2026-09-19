package app.zen.chromium

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executor

/**
 * Home-screen shortcuts ("Add to Home screen", PWA-01/14): the core's `shortcut.pin` becomes a
 * launcher tile – the web app's icon on the adaptive icon canvas, a letter on the app's colour
 * when it has none – and a `ShortcutManagerCompat.requestPinShortcut`, which brings up the
 * system's own pin dialog. The launcher confirms through `ShortcutPinnedReceiver`, which the host
 * turns into the `shortcut.pinned` event (the core toasts and registers the app). Tapping the tile
 * is an ACTION_VIEW of the app's start URL aimed at `MainActivity`, which opens it in a tab.
 */
class Shortcuts(private val activity: MainActivity, private val io: Executor) {
    private val main = Handler(Looper.getMainLooper())
    private val pinned: (String) -> Unit = { id -> main.post { onPinned(id) } }

    init {
        ShortcutPinnedReceiver.listener = pinned
    }

    fun destroy() {
        if (ShortcutPinnedReceiver.listener === pinned) ShortcutPinnedReceiver.listener = null
    }

    /** Whether the launcher takes pinned shortcuts at all (the chrome hides the menu item otherwise). */
    val supported: Boolean
        get() = ShortcutManagerCompat.isRequestPinShortcutSupported(activity)

    /**
     * `{ id, url, title, iconUrl, iconKind, background, iconBackground }`: fetch and draw the icon
     * off the main thread, then hand the request to the launcher. Answers true once the request
     * reached the launcher (its dialog decides the rest), false when it could not be made.
     */
    fun pin(args: JSONObject, reply: (Any?) -> Unit) {
        val id = args.str("id")
        val url = args.str("url")
        val title = args.str("title").ifBlank { "Shortcut" }
        if (!supported || id.isEmpty() || !(url.startsWith("http://") || url.startsWith("https://"))) {
            reply(false)
            return
        }
        val iconUrl = args.strOrNull("iconUrl")
        val iconKind = args.strOrNull("iconKind")
        val background = ShortcutTile.parseHex(args.strOrNull("background")) ?: DEFAULT_BACKGROUND
        val iconBackground = ShortcutTile.parseHex(args.strOrNull("iconBackground"))
        val canvas = ShortcutTile.canvasPx(activity.resources.displayMetrics.density)
        io.execute {
            val icon = iconUrl?.let { fetchBitmap(it) }
            val tile = runCatching { drawTile(canvas, icon, iconKind, title, background, iconBackground) }
                .getOrElse { drawTile(canvas, null, null, title, background, null) }
            main.post {
                val ok = runCatching { request(id, url, title, tile) }.getOrDefault(false)
                reply(ok)
            }
        }
    }

    private fun request(id: String, url: String, title: String, tile: Bitmap): Boolean {
        val open = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .setClass(activity, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val info = ShortcutInfoCompat.Builder(activity, shortcutId(id))
            .setShortLabel(title.take(SHORT_LABEL_MAX))
            .setLongLabel(title)
            .setIcon(IconCompat.createWithAdaptiveBitmap(tile))
            .setIntent(open)
            .build()
        val confirm = Intent(activity, ShortcutPinnedReceiver::class.java)
            .setAction(ShortcutPinnedReceiver.ACTION)
            .putExtra(ShortcutPinnedReceiver.EXTRA_ID, id)
        val callback = PendingIntent.getBroadcast(
            activity, id.hashCode(), confirm, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return ShortcutManagerCompat.requestPinShortcut(activity, info, callback.intentSender)
    }

    /** The launcher accepted a pin: tell the core, which toasts and registers the app. */
    private fun onPinned(id: String) {
        activity.host.chrome.hostEvent("shortcut.pinned", json("id" to id))
    }

    // --- the tile --------------------------------------------------------------------------------

    /**
     * The adaptive icon layer for the shortcut. A maskable icon fills the canvas' maskable square
     * (its safe zone landing on Android's), an `any` icon sits inset on a background – the icon's
     * own edge colour when its edge is opaque, the manifest's background colour, else the app's
     * colour – a monochrome glyph is tinted on the app's colour, and with no icon at all the tile
     * is the title's first letter on that colour.
     */
    private fun drawTile(canvas: Int, icon: Bitmap?, kind: String?, title: String, background: Int, iconBackground: Int?): Bitmap {
        val tile = Bitmap.createBitmap(canvas, canvas, Bitmap.Config.ARGB_8888)
        val c = Canvas(tile)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        if (icon == null) {
            drawLetter(c, canvas, title, background)
            return tile
        }
        val edge = edgeColor(icon)
        when (kind) {
            "maskable" -> {
                c.drawColor(iconBackground ?: edge ?: background)
                c.drawBitmap(icon, null, rectF(ShortcutTile.maskableRect(canvas, icon.width, icon.height)), paint)
            }
            "monochrome" -> {
                c.drawColor(background)
                paint.colorFilter = PorterDuffColorFilter(ShortcutTile.onColor(background), PorterDuff.Mode.SRC_IN)
                c.drawBitmap(icon, null, rectF(ShortcutTile.monochromeRect(canvas, icon.width, icon.height)), paint)
            }
            else -> {
                c.drawColor(iconBackground ?: edge ?: background)
                c.drawBitmap(icon, null, rectF(ShortcutTile.anyRect(canvas, icon.width, icon.height)), paint)
            }
        }
        return tile
    }

    private fun drawLetter(c: Canvas, canvas: Int, title: String, background: Int) {
        c.drawColor(background)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = ShortcutTile.onColor(background)
            textSize = canvas * ShortcutTile.LETTER_SHARE
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            textAlign = Paint.Align.CENTER
        }
        val metrics = paint.fontMetrics
        // Centre the glyph box (ascent to descent), not the baseline.
        val baseline = canvas / 2f - (metrics.ascent + metrics.descent) / 2f
        c.drawText(ShortcutTile.letterFor(title), canvas / 2f, baseline, paint)
    }

    private fun edgeColor(icon: Bitmap): Int? {
        val w = icon.width
        val h = icon.height
        if (w <= 0 || h <= 0 || w.toLong() * h > MAX_EDGE_SAMPLE_PIXELS) return null
        val pixels = IntArray(w * h)
        icon.getPixels(pixels, 0, w, 0, 0, w, h)
        return ShortcutTile.edgeColor(pixels, w, h)
    }

    private fun rectF(r: FloatRect) = RectF(r.left, r.top, r.right, r.bottom)

    // --- the icon bytes ----------------------------------------------------------------------------

    /** The icon at `url` (http(s) or data:) decoded to at most `MAX_ICON_PX` a side; null when it is no raster image. */
    private fun fetchBitmap(url: String): Bitmap? = runCatching {
        val bytes = if (url.startsWith("data:")) {
            val comma = url.indexOf(',')
            if (comma < 0) return@runCatching null
            val payload = url.substring(comma + 1)
            if (url.substring(0, comma).endsWith(";base64")) Base64.decode(payload, Base64.DEFAULT)
            else Uri.decode(payload).toByteArray()
        } else {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = FETCH_TIMEOUT_MS
                readTimeout = FETCH_TIMEOUT_MS
                setRequestProperty("Accept", "image/*")
            }
            if (conn.responseCode !in 200..299) return@runCatching null
            conn.inputStream.use { it.readBytes() }
        }
        if (bytes.isEmpty() || bytes.size > MAX_ICON_BYTES) return@runCatching null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching null
        var sample = 1
        while (bounds.outWidth / sample > MAX_ICON_PX || bounds.outHeight / sample > MAX_ICON_PX) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        })
    }.getOrNull()

    companion object {
        /** A shortcut id the launcher can store: the app id hashed, since manifest ids are URLs. */
        fun shortcutId(id: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(id.toByteArray())
            return "webapp-" + digest.take(12).joinToString("") { "%02x".format(it) }
        }

        private const val SHORT_LABEL_MAX = 25
        private const val FETCH_TIMEOUT_MS = 8000
        private const val MAX_ICON_BYTES = 4 * 1024 * 1024
        private const val MAX_ICON_PX = 1024
        private const val MAX_EDGE_SAMPLE_PIXELS = 1024L * 1024L
        /** The chrome's dark window colour (`Host.applyTheme`), for a request that names no colour. */
        private val DEFAULT_BACKGROUND = ShortcutTile.argb(0xFF, 0x16, 0x16, 0x1B)
    }
}

/** The launcher's confirmation of a pinned shortcut (`Shortcuts.request`'s callback). */
class ShortcutPinnedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        listener?.invoke(id)
    }

    companion object {
        const val ACTION = "app.zen.chromium.SHORTCUT_PINNED"
        const val EXTRA_ID = "id"

        /** The running host, while there is one; a confirmation after the process died has nothing to tell. */
        @Volatile
        var listener: ((String) -> Unit)? = null
    }
}
