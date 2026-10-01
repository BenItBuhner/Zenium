package app.zen.chromium

import android.content.ClipboardManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * PUI-38: Copy Image keeps the image's real type end to end (W6-S26-f). The product's own path
 * (`clipboard.writeImage`, the bridge method behind the menu's Copy Image, → `Host.copyImage`)
 * copies a JPEG, a WebP, a GIF and a PNG from the loopback server; after each the driver reads
 * what the system holds – the clip's MIME types, the `content://` URI's file name, what the
 * resolver's `getType` says for it, what the first bytes really are – then a real finger focuses
 * a `contenteditable` and the selection toolbar's Paste (Ctrl+V through the input pipeline as
 * the fallback) pastes it; the page's `paste` event reports `clipboardData.files[0]`'s name,
 * type and its first bytes, and the check is that the type the page is told and the bytes it
 * gets agree. Before the fix every copied image was `image-<ts>.png`, `image/png` by the
 * provider, whatever the bytes: a JPEG reached the page as `image.png` typed `image/png` with
 * JPEG bytes (S25-c §(3)). Then the lies the sniff has to see through: a JPEG served as `.png`
 * with `Content-Type: image/png`, a data URL declaring `image/png` over JPEG bytes, a data URL
 * whose declared type stands in where the sniff cannot place the bytes (an SVG behind a long
 * prolog), a page's HTML copied as an image (the copy fails, the clipboard untouched); and the
 * cache, pruned to its last `ImageBytes.CACHE_KEPT` files. Every touch a step injects has an
 * assertion on what it did (the rule in [DemoHarness]).
 */
@RunWith(AndroidJUnit4::class)
class CopyImageTypeDemo : MediaDemoBase(PREFIX) {
    override val tag = "CopyImageTypeDemo"
    private var failures = 0
    private var pastes = 0

    private val jpegBytes by lazy { photo(Bitmap.CompressFormat.JPEG, Color.rgb(0xd9, 0x53, 0x2f)) }

    @Test
    fun record() {
        val page = "text/html; charset=utf-8" to readAsset("copy-image-type-page.html").toByteArray()
        @Suppress("DEPRECATION")
        val webpFormat = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
        server = DemoServer(
            PORT,
            mapOf(
                "/copy" to page,
                "/photo.jpg" to ("image/jpeg" to jpegBytes),
                "/photo.webp" to ("image/webp" to photo(webpFormat, Color.rgb(0x2f, 0x9e, 0x4f))),
                "/photo.gif" to ("image/gif" to gif()),
                "/photo.png" to ("image/png" to photo(Bitmap.CompressFormat.PNG, Color.rgb(0x2f, 0x7f, 0xd9))),
                // The lie: a JPEG behind a .png name and an image/png header. The bytes decide.
                "/liar.png" to ("image/png" to jpegBytes)
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        assertEquals("checks that did not hold (see $PREFIX-notes.txt)", 0, failures)
    }

    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val tabs = state.getJSONArray("tabs")
        for (i in 0 until tabs.length()) {
            val tab = tabs.getJSONObject(i)
            if (tab.optString("id") == TAB) {
                tab.put("url", COPY)
                tab.put("title", "Zenium copy image demo")
            }
        }
        state.getJSONObject("settings").put("gestureHintDone", true)
        return state.toString()
    }

    override fun warmUp() {
        notes = File(out, "$PREFIX-notes.txt")
        notes.writeText("Zenium Android Copy Image type demo ($PREFIX)\n\n")
        note("demo server: ${server.selfCheck()}")
        val webView = runCatching { WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull()
        note("webview: ${webView ?: "unknown"}; sdk ${Build.VERSION.SDK_INT}; provider authority ${app.packageName}.files")
        note("clipboard cache before: ${cacheFiles()}")
        shell("cmd uimode night no")
        waitTitle(TAB, 20_000) { it.startsWith("CP|") }
        note("seeded tab: ${describeTab(TAB)}")
    }

    override fun demo() {
        note("\n1. The four formats through the product's Copy Image, each read off the clipboard and pasted into the page")
        round(PHOTO_JPG, "JPEG", "jpeg", "image/jpeg", "jpg", still = "01-pasted-jpeg")
        round(PHOTO_WEBP, "WebP", "webp", "image/webp", "webp", still = "02-pasted-webp")
        round(PHOTO_GIF, "GIF", "gif", "image/gif", "gif", still = "03-pasted-gif")
        round(PHOTO_PNG, "PNG", "png", "image/png", "png", still = "04-pasted-png")

        note("\n2. The lies: the bytes decide, never the name, the header or the declared type alone")
        clipRound(LIAR_PNG, "a JPEG served as liar.png with Content-Type image/png", "jpeg", "image/jpeg", "jpg")
        val base64 = Base64.getEncoder().encodeToString(jpegBytes)
        clipRound("data:image/jpeg;base64,$base64", "a data URL declaring image/jpeg over JPEG bytes", "jpeg", "image/jpeg", "jpg")
        clipRound("data:image/png;base64,$base64", "a data URL declaring image/png over JPEG bytes", "jpeg", "image/jpeg", "jpg")
        val svg = "<!--" + "x".repeat(ImageBytes.SVG_SNIFF_BYTES + 200) + "--><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><rect width=\"8\" height=\"8\"/></svg>"
        clipRound("data:image/svg+xml," + Uri.encode(svg, "<>/=\"-"), "a percent-encoded data URL whose SVG root sits past the sniff's window: the declared type stands in", "other", "image/svg+xml", "svg")

        note("\n3. What is no image is not copied as one")
        val before = describeClip()
        val copied = copyThroughTheProduct("$COPY?n=${SystemClock.uptimeMillis()}")
        val after = describeClip()
        note("  clipboard.writeImage of the page's HTML -> $copied; clipboard before: ${before.summary}; after: ${after.summary}")
        check("3: Copy Image of an HTML page fails (the menu toasts \"Could not copy image\")", copied == "false")
        check("3: the clipboard keeps the image it held", after.uri == before.uri && after.mimes == before.mimes)

        note("\n4. The clipboard cache is pruned to its last ${ImageBytes.CACHE_KEPT} files")
        repeat(3) { copyThroughTheProduct("$PHOTO_PNG?n=$it") }
        val files = cacheFiles()
        note("  after ${8 + 3} copies the cache holds ${files.size}: $files")
        check("4: the cache holds exactly ${ImageBytes.CACHE_KEPT} files after ${8 + 3} copies", files.size == ImageBytes.CACHE_KEPT)
        check("4: every cached file is named image-<timestamp>.<real extension>", files.all { Regex("image-\\d+\\.(jpg|webp|gif|png|svg)").matches(it) })
        check("4: the newest copy (a PNG) is among the kept files", describeClip().name?.let { it in files } == true)
        note("\nend: ${describeClip().summary}")
    }

    /**
     * One format: copied through the product, the clip read off the system, then a real paste
     * into the page and the page's word against the bytes.
     */
    private fun round(url: String, what: String, magic: String, mime: String, extension: String, still: String) {
        val clip = clipRound(url, "a $what (${url.substringAfterLast('/')})", magic, mime, extension)
        frontApp()
        pageJs("resetRound(); setCopied(${JSONObject.quote("${url.substringAfterLast('/')} – a $what, ${clip.size} bytes")})")
        val rect = pageElementRect("ce") ?: run {
            check("1: the contenteditable is on screen for the $what", false)
            return
        }
        val point = touchPoint(rect) ?: run {
            check("1: the contenteditable has a point a finger can reach for the $what", false)
            return
        }
        Finger().tap(point.x, point.y)
        val focused = poll(5_000) { pageJs("document.activeElement&&document.activeElement.id") == "\"ce\"" }
        if (focused) note("  finger on the contenteditable at ${point.x.toInt()},${point.y.toInt()}: it has the focus")
        else {
            touchFault("a touch on the page's contenteditable did not take: no focus (page: ${title()})")
            note("  TOUCH FAULT: the contenteditable did not take the focus (page: ${title()})")
        }
        SystemClock.sleep(600)
        val pasted = pasteInto(pastes + 1)
        if (pasted) pastes++
        val fields = pageFields()
        check("1: the paste of the $what reaches the page's paste event", pasted)
        if (!pasted) return
        poll(5_000) { pageFields()["magic"].let { it != null && it != "reading" && it != "-" } }
        poll(3_000) { pageFields()["ce"] != "none" }
        val got = pageFields()
        val files = got["files"]?.toIntOrNull() ?: 0
        val type = got["type"]?.replace('~', '/') ?: "-"
        val bytes = got["magic"] ?: "-"
        note("  FACT  PUI-38 ($what): clipboardData.types=${got["types"]} items=${got["items"]} files=$files name=${got["name"]} type=$type size=${got["size"]} bytes=$bytes editor=${got["ce"]} image-uri=${got["uri"]}")
        check("1: the $what arrives in clipboardData.files as one image File", files == 1 && type.startsWith("image/"))
        check("1: the type the page is told for the $what and the bytes it gets agree ($type, $bytes bytes)", bytes != "-" && type == "image/$bytes")
        note(
            "  FACT  the engine ${if (bytes == magic) "handed the $what's own bytes over" else "re-encoded the $what to ${bytes.uppercase()} (ClipboardImpl.getPng: a non-PNG type is decoded and compressed to PNG)"}" +
                "; before the fix a $what arrived typed image/png with $magic bytes"
        )
        SystemClock.sleep(800)
        shot(still)
        SystemClock.sleep(400)
    }

    /** The copy and the clip's facts, no paste: what the system's clipboard holds after Copy Image of `url`. */
    private fun clipRound(url: String, what: String, magic: String, mime: String, extension: String): Clip {
        note("\n  Copy Image of $what")
        val copied = copyThroughTheProduct(url)
        val clip = describeClip()
        note("  clipboard.writeImage -> $copied; ${clip.summary}")
        check("Copy Image of $what succeeds and puts one content:// item through the app's FileProvider", copied == "true" && clip.uri?.startsWith("content://${app.packageName}.files/") == true && clip.items == 1)
        check("the clip's MIME types read [$mime]", clip.mimes == listOf(mime))
        check("the resolver's getType for the URI reads $mime (the file is named .$extension)", clip.resolverType == mime && clip.name?.endsWith(".$extension") == true)
        check("the bytes behind the URI are $magic", clip.magic == magic)
        return clip
    }

    // --- the clipboard ----------------------------------------------------------------------------

    private class Clip(val items: Int, val mimes: List<String>, val uri: String?, val name: String?, val resolverType: String?, val magic: String?, val size: Int, val label: String?) {
        val summary get() = "label=$label items=$items mimeTypes=$mimes uri=$uri resolverType=$resolverType bytes=$magic size=$size"
    }

    /** What is on the clipboard as the system has it: the description's types, the item's URI and name, the resolver's type for it, the first bytes. */
    private fun describeClip(): Clip {
        var out = Clip(0, emptyList(), null, null, null, null, 0, null)
        instrumentation.runOnMainSync {
            val cm = app.getSystemService(ClipboardManager::class.java)
            val clip = cm.primaryClip ?: return@runOnMainSync
            val description = clip.description
            val mimes = (0 until description.mimeTypeCount).map { description.getMimeType(it) }
            val uri = clip.getItemAt(0).uri
            val resolverType = uri?.let { runCatching { app.contentResolver.getType(it) }.getOrNull() }
            var size = 0
            val magic = uri?.let {
                runCatching {
                    app.contentResolver.openInputStream(it)?.use { s ->
                        val bytes = s.readBytes()
                        size = bytes.size
                        magic(bytes)
                    }
                }.getOrNull()
            }
            out = Clip(clip.itemCount, mimes, uri?.toString(), uri?.lastPathSegment, resolverType, magic, size, description.label?.toString())
        }
        return out
    }

    /** The driver's own reading of the first bytes, independent of the sniffer under test. */
    private fun magic(bytes: ByteArray): String {
        fun at(i: Int) = bytes[i].toInt() and 0xff
        return when {
            bytes.size >= 8 && at(0) == 0x89 && at(1) == 0x50 && at(2) == 0x4e && at(3) == 0x47 -> "png"
            bytes.size >= 3 && at(0) == 0xff && at(1) == 0xd8 && at(2) == 0xff -> "jpeg"
            bytes.size >= 12 && at(0) == 0x52 && at(1) == 0x49 && at(2) == 0x46 && at(3) == 0x46 && at(8) == 0x57 && at(9) == 0x45 && at(10) == 0x42 && at(11) == 0x50 -> "webp"
            bytes.size >= 6 && at(0) == 0x47 && at(1) == 0x49 && at(2) == 0x46 && at(3) == 0x38 -> "gif"
            else -> "other"
        }
    }

    private fun cacheFiles(): List<String> =
        File(app.cacheDir, "clipboard").listFiles()?.map { it.name }?.sorted() ?: emptyList()

    /** The product's own Copy Image: the bridge method the menu's row calls, with the URL. "true"/"false"/"timeout". */
    private fun copyThroughTheProduct(url: String): String {
        var result = "timeout"
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            host.dispatch("clipboard.writeImage", JSONObject().put("url", url)) { reply ->
                result = reply.toString()
                latch.countDown()
            }
        }
        latch.await(15, TimeUnit.SECONDS)
        return result
    }

    // --- the paste --------------------------------------------------------------------------------

    /**
     * The paste: the selection toolbar's Paste after a long press on the focused editor (a real
     * finger), Ctrl+V through the input pipeline when the toolbar offered none. True once the
     * page's paste count reaches `expectPastes`.
     */
    private fun pasteInto(expectPastes: Int): Boolean {
        val took = { (pageFields()["pastes"]?.toIntOrNull() ?: 0) >= expectPastes }
        val point = pageElementRect("ce")?.let { touchPoint(it) }
        if (point != null) {
            val finger = Finger()
            finger.press(point.x, point.y)
            finger.up()
            val menu = awaitInWindows(4_000) { it.equals("Paste", ignoreCase = true) }
            if (menu != null) {
                if (touchInWindows("Paste", "the page hears the paste", 8_000, { it.equals("Paste", ignoreCase = true) }, took)) return true
            } else {
                note("  the long press lifted no toolbar with Paste; Ctrl+V through the input pipeline")
                dumpWindows("after the long press on the editor")
            }
        }
        ctrlV()
        if (poll(5_000, took)) {
            note("  Ctrl+V: the page hears the paste")
            return true
        }
        return false
    }

    /** Ctrl+V the way a hardware keyboard sends it: the engine's paste command on the focused editor. */
    private fun ctrlV() {
        val downTime = SystemClock.uptimeMillis()
        val meta = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(
                downTime, SystemClock.uptimeMillis(), action, KeyEvent.KEYCODE_V, 0, meta,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD
            )
            ui.injectInputEvent(event, true)
        }
    }

    private fun pageFields(): Map<String, String> =
        title().split('|').drop(1).mapNotNull { part ->
            val at = part.indexOf(':')
            if (at <= 0) null else part.substring(0, at) to part.substring(at + 1)
        }.toMap()

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        note("  ${if (ok) "PASS" else "FAIL"}  $what")
    }

    // --- the fixtures -----------------------------------------------------------------------------

    /** A 640x480 photo-like bitmap in `format`: a tinted field with a white disc, so every copy has a real picture behind it. */
    private fun photo(format: Bitmap.CompressFormat, tint: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(tint)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        canvas.drawCircle(320f, 240f, 150f, paint)
        paint.color = tint
        canvas.drawCircle(320f, 240f, 60f, paint)
        val out = ByteArrayOutputStream()
        bitmap.compress(format, 90, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    /**
     * A GIF89a built by hand, since Android has no GIF encoder: 160x120, a four-colour global
     * table, a checked field with a white disc. The LZW stream uses a minimum code size of 7, so
     * every code is one whole byte (the literals 0..127, clear 128, end 129), and a clear code
     * goes in every 100 pixels so the decoder's table never reaches the 256 entries that would
     * widen the codes – a legal, merely uncompressed GIF that every decoder reads.
     */
    private fun gif(): ByteArray {
        val w = 160
        val h = 120
        val out = ByteArrayOutputStream()
        out.write("GIF89a".toByteArray(Charsets.US_ASCII))
        out.write(byteArrayOf(w.toByte(), (w shr 8).toByte(), h.toByte(), (h shr 8).toByte(), 0x81.toByte(), 0, 0))
        out.write(byteArrayOf(0x2f, 0x9e.toByte(), 0x4f, 0xff.toByte(), 0xff.toByte(), 0xff.toByte(), 0x1f, 0x6e, 0x3f, 0x11, 0x11, 0x11))
        out.write(byteArrayOf(0x2C, 0, 0, 0, 0, w.toByte(), (w shr 8).toByte(), h.toByte(), (h shr 8).toByte(), 0))
        out.write(7)
        val codes = ByteArrayOutputStream()
        codes.write(0x80)
        var since = 0
        for (y in 0 until h) for (x in 0 until w) {
            val dx = x - w / 2
            val dy = y - h / 2
            val index = if (dx * dx + dy * dy < 40 * 40) 1 else if ((x / 20 + y / 20) % 2 == 0) 0 else 2
            codes.write(index)
            if (++since == 100) {
                codes.write(0x80)
                since = 0
            }
        }
        codes.write(0x81)
        val data = codes.toByteArray()
        var at = 0
        while (at < data.size) {
            val n = minOf(255, data.size - at)
            out.write(n)
            out.write(data, at, n)
            at += n
        }
        out.write(0)
        out.write(0x3B)
        return out.toByteArray()
    }

    companion object {
        private const val PREFIX = "w6-s26f-copy-image-type"
        private const val COPY = "http://127.0.0.1:$PORT/copy"
        private const val PHOTO_JPG = "http://127.0.0.1:$PORT/photo.jpg"
        private const val PHOTO_WEBP = "http://127.0.0.1:$PORT/photo.webp"
        private const val PHOTO_GIF = "http://127.0.0.1:$PORT/photo.gif"
        private const val PHOTO_PNG = "http://127.0.0.1:$PORT/photo.png"
        private const val LIAR_PNG = "http://127.0.0.1:$PORT/liar.png"
    }
}
