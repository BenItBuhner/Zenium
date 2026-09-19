package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The decision behind `clipboard.peek`: what the URL bar's clipboard row offers, from the clip's
 * description alone. The content is never part of it.
 */
class ClipboardPeekTest {
    private val now = 1_000_000_000L
    private val plain = listOf("text/plain")

    @Test
    fun textIsOfferedAsText() {
        assertEquals("text", ClipboardPeek.classify(plain, now - 5_000, sensitive = false, urlConfidence = null, now = now))
        assertEquals("text", ClipboardPeek.classify(listOf("text/html", "text/plain"), now, false, 0.2f, now))
    }

    @Test
    fun theSystemsUrlClassificationMakesItALink() {
        assertEquals("url", ClipboardPeek.classify(plain, now, false, 0.97f, now))
        // Below the bar the text may well be one, but the row says text; the read tells.
        assertEquals("text", ClipboardPeek.classify(plain, now, false, 0.6f, now))
    }

    @Test
    fun anImageIsAnImage() {
        assertEquals("image", ClipboardPeek.classify(listOf("image/png"), now, false, null, now))
        assertEquals("image", ClipboardPeek.classify(listOf("text/uri-list", "image/jpeg"), now, false, null, now))
    }

    @Test
    fun nothingForAnEmptyOldOrSensitiveClipOrOneThatIsNotText() {
        assertEquals("none", ClipboardPeek.classify(emptyList(), now, false, null, now))
        assertEquals("none", ClipboardPeek.classify(plain, now - ClipboardPeek.MAX_AGE_MS - 1, false, 0.99f, now))
        assertEquals("none", ClipboardPeek.classify(plain, now, sensitive = true, urlConfidence = 0.99f, now = now))
        assertEquals("none", ClipboardPeek.classify(listOf("text/uri-list"), now, false, null, now))
        assertEquals("none", ClipboardPeek.classify(listOf("text/vnd.android.intent"), now, false, null, now))
    }

    @Test
    fun aClipWithNoTimestampIsKept() {
        assertEquals("text", ClipboardPeek.classify(plain, 0L, false, null, now))
        assertEquals("text", ClipboardPeek.classify(plain, now - ClipboardPeek.MAX_AGE_MS, false, null, now))
    }
}
