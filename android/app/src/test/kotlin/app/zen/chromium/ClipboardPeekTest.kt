package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The decision behind `clipboard.peek`: what the URL bar's clipboard row offers, from the clip's
 * description alone. The content is never part of it. And the same look for the omnibox field's
 * floating toolbar (`pasteAction`): Paste and go, Paste and search, or nothing.
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

    @Test
    fun theClipTheUserOpenedIsNotOfferedAgainUntilTheClipboardChanges() {
        val copied = now - 5_000
        // Opened through the row (`markUsed` remembered its time): none, whatever its kind.
        assertEquals("none", ClipboardPeek.classify(plain, copied, false, 0.99f, now, used = copied))
        assertEquals("none", ClipboardPeek.classify(plain, copied, false, null, now, used = copied))
        assertEquals("none", ClipboardPeek.classify(listOf("image/png"), copied, false, null, now, used = copied))
        // A new copy carries a new time and is offered, even of the same text; an older mark is no bar.
        assertEquals("url", ClipboardPeek.classify(plain, copied + 1, false, 0.99f, now, used = copied))
        assertEquals("text", ClipboardPeek.classify(plain, copied, false, null, now, used = copied - 60_000))
        // A clip the system gave no time for cannot be told from the next one: offered, not marked.
        assertEquals("text", ClipboardPeek.classify(plain, 0L, false, null, now, used = 0L))
        assertEquals("text", ClipboardPeek.classify(plain, 0L, false, null, now, used = copied))
    }

    // --- the omnibox field's floating toolbar (OMN-23, FieldToolbar) -------------------------------

    @Test
    fun aLinkOnTheClipboardIsPasteAndGo() {
        assertEquals(FieldToolbar.GO, ClipboardPeek.classifyPaste(plain, sensitive = false, urlConfidence = 0.97f))
        assertEquals(FieldToolbar.GO, ClipboardPeek.classifyPaste(listOf("text/html", "text/plain"), false, 1f))
    }

    @Test
    fun textTheSystemReadAsNoLinkIsPasteAndSearch() {
        assertEquals(FieldToolbar.SEARCH, ClipboardPeek.classifyPaste(plain, false, 0f))
        assertEquals(FieldToolbar.SEARCH, ClipboardPeek.classifyPaste(plain, false, 0.6f))
    }

    @Test
    fun textNobodyClassifiedIsPasteAndGoSinceTheTypedRuleSortsIt() {
        // Android 11 and below, or a clip the classifier has not reached: go takes an address to
        // the page and searches anything else; search would send an address to the engine.
        assertEquals(FieldToolbar.GO, ClipboardPeek.classifyPaste(plain, false, null))
    }

    @Test
    fun nothingToPasteForAnEmptyImageNonTextOrSensitiveClip() {
        assertNull(ClipboardPeek.classifyPaste(emptyList(), false, null))
        assertNull(ClipboardPeek.classifyPaste(listOf("image/png"), false, null))
        assertNull(ClipboardPeek.classifyPaste(listOf("text/plain", "image/jpeg"), false, 0.99f))
        assertNull(ClipboardPeek.classifyPaste(listOf("text/uri-list"), false, null))
        assertNull(ClipboardPeek.classifyPaste(listOf("text/vnd.android.intent"), false, null))
        assertNull(ClipboardPeek.classifyPaste(plain, sensitive = true, urlConfidence = 0.99f))
    }
}
