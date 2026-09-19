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
 * reveals or picks the row; the toast then is the system's honest word about that read.
 */
object ClipboardPeek {
    /** A copy older than this is not offered (Chrome's clipboard suggestions age out the same way). */
    const val MAX_AGE_MS = 10 * 60 * 1000L

    /** Below this the system's URL classification is not trusted over "text". */
    private const val URL_CONFIDENCE = 0.9f

    /** `url`, `text`, `image` or `none`: what the clipboard holds, from its description alone. */
    fun peek(context: Context, now: Long = System.currentTimeMillis()): String {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        // Android 10+ hides the clipboard from an app that is not in the foreground: then nothing.
        val description = runCatching { manager.primaryClipDescription }.getOrNull() ?: return NONE
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
        return classify(mimeTypes, description.timestamp, sensitive, urlConfidence, now)
    }

    /**
     * The decision, pure for the unit tests. `timestamp` 0 means the system did not say when the
     * clip was set (kept); `urlConfidence` null means it did not classify the text (read as text:
     * the core tells a link from text when the content is read).
     */
    fun classify(
        mimeTypes: List<String>,
        timestamp: Long,
        sensitive: Boolean,
        urlConfidence: Float?,
        now: Long
    ): String {
        if (mimeTypes.isEmpty() || sensitive) return NONE
        if (timestamp > 0 && now - timestamp > MAX_AGE_MS) return NONE
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
