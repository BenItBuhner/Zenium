package app.zen.chromium

import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.view.textclassifier.TextClassifier
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The URL bar's clipboard row (Chrome's "Link you copied" / "Text you copied"), in two reads.
 *
 * `peek` looks at the clip's DESCRIPTION only – `getPrimaryClipDescription()`: the mime types,
 * the time it was set, the sensitive flag, and on Android 12+ the system's own classification of
 * the text – and never at its content, so the row can be offered every time the bar opens without
 * Android 12+'s "pasted from your clipboard" toast. `read` takes the content, once, when the user
 * reveals or picks the row; the toast then is the system's honest word about that read. `markUsed`
 * remembers the clip the user OPENED through the row (the pick, not a reveal), and `peek` answers
 * `none` for it until the clipboard changes – Chrome's `SuppressClipboardContent`.
 *
 * `pasteAction` is the same look at the description for the omnibox field's floating toolbar
 * (OMN-23, `FieldToolbar`): whether its Paste and go / Paste and search item is offered, and
 * which; the read, once more, is the core's when the item is touched.
 *
 * `readClip` + `encodeImage` are the page's `navigator.clipboard.read()` (MW-38; `Host.kt`'s
 * `clipboard.read` with `image: true`, behind the core's `clipboard-read` decision): the same
 * one read of the primary clip, its text as [read] has it and, when the clip carries an image,
 * the image decoded through the content resolver – bounded, PNG-encoded, base64 – for the
 * page's `image/png` representation. Chrome reads an Android clip's image the same way
 * (`ui/android/java/src/org/chromium/ui/base/Clipboard.java`, `getImageUri`: the description's
 * `image/` type, the first item's `Uri`).
 */
object ClipboardPeek {
    /** A copy older than this is not offered (Chrome's clipboard suggestions age out the same way). */
    const val MAX_AGE_MS = 10 * 60 * 1000L

    /** Below this the system's URL classification is not trusted over "text". */
    private const val URL_CONFIDENCE = 0.9f

    /**
     * When the clip the user last opened through the row was set (`ClipDescription.timestamp`);
     * 0 for none. The clipboard's own clock tells one clip from the next without a read: a new
     * copy, even of the same text, carries a new time. Process-lifetime, like Chrome's.
     */
    @Volatile
    private var usedTimestamp = 0L

    /** `url`, `text`, `image` or `none`: what the clipboard holds, from its description alone. */
    fun peek(context: Context, now: Long = System.currentTimeMillis()): String {
        val clip = describe(context) ?: return NONE
        return classify(clip.mimeTypes, clip.timestamp, clip.sensitive, clip.urlConfidence, now, usedTimestamp)
    }

    /**
     * What the omnibox field's floating toolbar offers over the clip (OMN-23, `FieldToolbar`),
     * from the description alone as [peek] reads it: `FieldToolbar.GO` ("Paste and go"),
     * `FieldToolbar.SEARCH` ("Paste and search") or null for nothing to paste ([classifyPaste]).
     */
    fun pasteAction(context: Context): String? {
        val clip = describe(context) ?: return null
        return classifyPaste(clip.mimeTypes, clip.sensitive, clip.urlConfidence)
    }

    /** The clip's description, read: its mime types, when it was set, the sensitive flag, the system's URL confidence (null when it did not classify). */
    private class Description(val mimeTypes: List<String>, val timestamp: Long, val sensitive: Boolean, val urlConfidence: Float?)

    /** The primary clip's description; null for none (Android 10+ hides the clipboard from an app that is not in the foreground). */
    private fun describe(context: Context): Description? {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val description = runCatching { manager.primaryClipDescription }.getOrNull() ?: return null
        val mimeTypes = (0 until description.mimeTypeCount).map { description.getMimeType(it) }
        val sensitive = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            description.extras?.getBoolean(ClipDescription.EXTRA_IS_SENSITIVE, false) == true
        val urlConfidence = if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            description.classificationStatus == ClipDescription.CLASSIFICATION_COMPLETE
        ) {
            description.getConfidenceScore(TextClassifier.TYPE_URL)
        } else {
            null
        }
        return Description(mimeTypes, description.timestamp, sensitive, urlConfidence)
    }

    /**
     * The field toolbar's decision, pure for the unit tests: go for a link (the system's URL
     * classification at [URL_CONFIDENCE] or better), search for text the system read and found
     * no link in, and go again for text nobody classified (`urlConfidence` null: Android 11 and
     * below, a clip the classifier has not reached yet) – the core's typed rule takes an address
     * to the page and searches anything else, as Edge's one item does, where "search" would send
     * an address to the engine. Null for nothing to paste: an empty clipboard, an image, a clip
     * that is not text, a sensitive one (a password manager's copy, which no search box should
     * be handed). Neither the row's age limit nor its used-up clip applies here: the system
     * offers its Paste for as long as the clip is there, and the hold on the field asked for it.
     */
    fun classifyPaste(mimeTypes: List<String>, sensitive: Boolean, urlConfidence: Float?): String? {
        if (mimeTypes.isEmpty() || sensitive) return null
        if (mimeTypes.any { it.startsWith("image/") }) return null
        val text = mimeTypes.any {
            it == ClipDescription.MIMETYPE_TEXT_PLAIN || it == ClipDescription.MIMETYPE_TEXT_HTML
        }
        if (!text) return null
        return if (urlConfidence == null || urlConfidence >= URL_CONFIDENCE) FieldToolbar.GO else FieldToolbar.SEARCH
    }

    /**
     * The clip on the clipboard now is the one the user opened through the row: not offered
     * again until the clipboard changes. A clip the system gave no time for (`timestamp` 0)
     * cannot be told from the next one without a read, so it is not remembered and is offered
     * again; a real copy on API 26+ always carries its time.
     */
    fun markUsed(context: Context) {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val timestamp = runCatching { manager.primaryClipDescription?.timestamp }.getOrNull() ?: 0L
        if (timestamp > 0) usedTimestamp = timestamp
    }

    /**
     * The decision, pure for the unit tests. `timestamp` 0 means the system did not say when the
     * clip was set (kept); `urlConfidence` null means it did not classify the text (read as text:
     * the core tells a link from text when the content is read); `used` is the time of the clip
     * the user last opened through the row (0 for none), which is not offered again.
     */
    fun classify(
        mimeTypes: List<String>,
        timestamp: Long,
        sensitive: Boolean,
        urlConfidence: Float?,
        now: Long,
        used: Long = 0L
    ): String {
        if (mimeTypes.isEmpty() || sensitive) return NONE
        if (timestamp > 0 && now - timestamp > MAX_AGE_MS) return NONE
        if (timestamp > 0 && timestamp == used) return NONE
        if (mimeTypes.any { it.startsWith("image/") }) return IMAGE
        val text = mimeTypes.any {
            it == ClipDescription.MIMETYPE_TEXT_PLAIN || it == ClipDescription.MIMETYPE_TEXT_HTML
        }
        if (!text) return NONE
        return if (urlConfidence != null && urlConfidence >= URL_CONFIDENCE) URL else TEXT
    }

    /** The clipboard's text, read once; empty when it holds none (or the read is refused). */
    fun read(context: Context): String = readClip(context).text

    /**
     * The primary clip's first item, read once: its text (`coerceToText`, as [read] has always
     * had it) and its image's `Uri` when the clip's description carries an `image/` type and
     * the item a `Uri` – Chrome's reading of an Android clip (`Clipboard.java` `getImageUri`);
     * null for a clip without one. The decode is [encodeImage]'s, off the caller's thread.
     */
    class Clip(val text: String, val imageUri: Uri?)

    /** The primary clip; [NO_CLIP] for an empty clipboard or a refused read (Android 10+ hides the clipboard from an app that is not in the foreground). */
    fun readClip(context: Context): Clip {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        return runCatching {
            val clip = manager.primaryClip?.takeIf { it.itemCount > 0 }
            if (clip == null) {
                NO_CLIP
            } else {
                val item = clip.getItemAt(0)
                val imageUri = item.uri?.takeIf { clip.description.hasMimeType("image/*") }
                // `coerceToText` as ever – except for an image item with no text of its own: on
                // API levels before the platform's scheme guard it renders a `content://` URI it
                // cannot open as text as the URI's string, and neither a page's `text/plain` nor
                // the URL bar's row has a use for the image's address ('' there, as on later ones).
                val text = item.text?.toString()
                    ?: (if (imageUri != null) "" else (item.coerceToText(context)?.toString() ?: ""))
                Clip(text, imageUri)
            }
        }.getOrDefault(NO_CLIP)
    }

    /** The longer edge of a clipboard image handed to a page, at most: a bigger one is scaled down to it, never dropped. */
    const val MAX_IMAGE_EDGE = 2048

    /** The encoded PNG handed to a page, at most: over it the bitmap is halved and encoded again. */
    const val MAX_IMAGE_BYTES = 8 * 1024 * 1024

    /**
     * The clip's image ([Clip.imageUri]) as the page's `image/png` representation:
     * `{png, width, height}` – the PNG's bytes base64 (`NO_WRAP`) and the encoded bitmap's size
     * – or null when the URI does not decode (a provider that refuses the open, a type the system
     * cannot read), for the text to go alone. Decoded through the content resolver, bounded at
     * the decode: `ImageDecoder` on API 28+ (every type the system decodes, the EXIF orientation
     * applied) at the exact [fit] within [MAX_IMAGE_EDGE], `BitmapFactory` below it at the
     * power-of-two [sampleSize] that brings the longer edge within the cap – so no bitmap over
     * 2048 px on its longer edge is ever held – then PNG-encoded and halved while the encoding is
     * over [MAX_IMAGE_BYTES] ([encodePng]). Heavy work, for a worker thread and never the UI's;
     * no persistent URI grant is taken, the clipboard's own grant to the reader covering the open.
     */
    fun encodeImage(context: Context, uri: Uri): JSONObject? = runCatching {
        val decoded = decodeBounded(context, uri) ?: return@runCatching null
        val (png, encoded) = encodePng(decoded)
        val result = json(
            "png" to Base64.encodeToString(png, Base64.NO_WRAP),
            "width" to encoded.width,
            "height" to encoded.height
        )
        if (encoded !== decoded) encoded.recycle()
        decoded.recycle()
        result
    }.getOrNull()

    /** The image at [uri] decoded within [MAX_IMAGE_EDGE], as a software bitmap `compress` can read; null for one that does not decode. */
    private fun decodeBounded(context: Context, uri: Uri): Bitmap? {
        val resolver = context.contentResolver
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val (width, height) = fit(info.size.width, info.size.height, MAX_IMAGE_EDGE)
                if (width != info.size.width || height != info.size.height) decoder.setTargetSize(width, height)
            }
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, MAX_IMAGE_EDGE)
        }
        return resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    }

    /**
     * [bitmap] as PNG, halved (both edges) while the encoding is over [MAX_IMAGE_BYTES] – down to
     * a single pixel at the limit, so the loop ends – with the bitmap the bytes encode (the one
     * handed in, or the last halving, for the caller to recycle).
     */
    private fun encodePng(bitmap: Bitmap): Pair<ByteArray, Bitmap> {
        var current = bitmap
        while (true) {
            val out = ByteArrayOutputStream()
            current.compress(Bitmap.CompressFormat.PNG, 100, out)
            val bytes = out.toByteArray()
            if (bytes.size <= MAX_IMAGE_BYTES || (current.width <= 1 && current.height <= 1)) return bytes to current
            val next = Bitmap.createScaledBitmap(current, max(1, current.width / 2), max(1, current.height / 2), true)
            if (current !== bitmap) current.recycle()
            current = next
        }
    }

    /**
     * `BitmapFactory.Options.inSampleSize` for a [width] × [height] image: the smallest power of
     * two that brings the longer edge to at most [maxEdge], the division rounded up as a decoder
     * may round its sampled size up (a 4097 px edge at 2 could come out 2049, so 4 it is); 1 for
     * an image within the cap. Pure, for the unit tests.
     */
    fun sampleSize(width: Int, height: Int, maxEdge: Int): Int {
        val longer = max(width, height)
        var sample = 1
        while ((longer + sample - 1) / sample > maxEdge) sample *= 2
        return sample
    }

    /**
     * [width] × [height] scaled to fit [maxEdge] on the longer edge, the aspect kept and neither
     * edge under one pixel; the size itself for an image within the cap. Pure, for the unit tests.
     */
    fun fit(width: Int, height: Int, maxEdge: Int): Pair<Int, Int> {
        val longer = max(width, height)
        if (longer <= maxEdge) return width to height
        val scale = maxEdge.toDouble() / longer
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }

    private val NO_CLIP = Clip("", null)

    const val URL = "url"
    const val TEXT = "text"
    const val IMAGE = "image"
    const val NONE = "none"
}
