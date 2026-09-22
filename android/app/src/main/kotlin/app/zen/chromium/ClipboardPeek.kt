package app.zen.chromium

import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.view.textclassifier.TextClassifier

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
    fun read(context: Context): String {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        return runCatching {
            manager.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
        }.getOrNull() ?: ""
    }

    const val URL = "url"
    const val TEXT = "text"
    const val IMAGE = "image"
    const val NONE = "none"
}
