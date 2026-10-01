package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The decision behind `clipboard.peek`: what the URL bar's clipboard row offers, from the clip's
 * description alone. The content is never part of it. And the same look for the omnibox field's
 * floating toolbar (`pasteAction`): Paste and go, Paste and search, or nothing. And the bounds a
 * clipboard image is decoded within for a page's `navigator.clipboard.read()` (MW-38): the
 * sample size and the fit, pure; the PNG byte budget under the bridge's message admission and
 * the shrink loop that meets it, pure over a fake image; the decode and the PNG encode
 * themselves have no JVM seam (`ImageDecoder`, `Bitmap.compress`) and are the device's to check.
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

    // --- the clipboard image's bounds for a page's read() (MW-38) ----------------------------------

    @Test
    fun theCapIs2048OnTheLongerEdgeAnd8MiBOfPng() {
        assertEquals(2048, ClipboardPeek.MAX_IMAGE_EDGE)
        assertEquals(8 * 1024 * 1024, ClipboardPeek.MAX_IMAGE_BYTES)
    }

    @Test
    fun anImageWithinTheCapIsDecodedWholeAndKeptAtItsSize() {
        // A 1080p screenshot's longer edge is 1920, within the cap; 2048 itself is within it.
        assertEquals(1, ClipboardPeek.sampleSize(1080, 1920, 2048))
        assertEquals(1, ClipboardPeek.sampleSize(2048, 2048, 2048))
        assertEquals(1080 to 1920, ClipboardPeek.fit(1080, 1920, 2048))
        assertEquals(2048 to 1536, ClipboardPeek.fit(2048, 1536, 2048))
        // A taller phone's 1080 × 2400 is over it: sampled at 2, or fitted to 922 × 2048.
        assertEquals(2, ClipboardPeek.sampleSize(1080, 2400, 2048))
        assertEquals(922 to 2048, ClipboardPeek.fit(1080, 2400, 2048))
    }

    @Test
    fun aBiggerImageIsSampledByThePowerOfTwoThatBringsItsLongerEdgeWithinTheCap() {
        // 4096 at 2 is exactly the cap; 4097 at 2 could come out 2049 (a decoder rounding its sampled size up), so 4.
        assertEquals(2, ClipboardPeek.sampleSize(4096, 3072, 2048))
        assertEquals(4, ClipboardPeek.sampleSize(4097, 100, 2048))
        assertEquals(4, ClipboardPeek.sampleSize(8000, 6000, 2048))
        assertEquals(8, ClipboardPeek.sampleSize(100, 10_000, 2048))
        // The sampled edge is within the cap at every size.
        for (edge in listOf(2049, 3000, 4096, 4097, 12_000, 65_535)) {
            val sample = ClipboardPeek.sampleSize(edge, edge / 3, 2048)
            assert((edge + sample - 1) / sample <= 2048) { "edge $edge at sample $sample" }
        }
    }

    @Test
    fun theFitScalesTheLongerEdgeToTheCapWithTheAspectKeptAndNeitherEdgeUnderAPixel() {
        assertEquals(2048 to 1536, ClipboardPeek.fit(4096, 3072, 2048))
        // A portrait screenshot at twice the phone's size: 2160 × 2048 / 4800 = 921.6, rounded.
        assertEquals(922 to 2048, ClipboardPeek.fit(2160, 4800, 2048))
        assertEquals(2048 to 20, ClipboardPeek.fit(10_000, 100, 2048))
        assertEquals(1 to 2048, ClipboardPeek.fit(1, 100_000, 2048))
    }

    // --- the PNG's byte budget under the bridge's message admission ----------------------------

    private val mib = 1024L * 1024
    private val slack = ClipboardPeek.ENVELOPE_SLACK_CHARS

    @Test
    fun theBudgetIsTheLimitsRoomPastTheEnvelopeAtThreeBytesPerFourCharsCappedOnlyAtTheCeiling() {
        assertEquals(64L * 1024, slack)
        assertEquals(16 * 1024, ClipboardPeek.MIN_IMAGE_BYTES)
        // The admission's floor (2 MiB chars), a 192-MB heap (6 MiB), a 256-MB heap (8 MiB), the ceiling (16 MiB, 512 MB and up).
        assertEquals(1_523_712, ClipboardPeek.imageBudget(2 * mib, 0)) // ≈ 1.45 MiB
        assertEquals(4_669_440, ClipboardPeek.imageBudget(6 * mib, 0)) // ≈ 4.45 MiB
        assertEquals(6_242_304, ClipboardPeek.imageBudget(8 * mib, 0)) // ≈ 5.95 MiB
        assertEquals(ClipboardPeek.MAX_IMAGE_BYTES, ClipboardPeek.imageBudget(16 * mib, 0)) // 8 MiB: the cap binds here alone
        // An admission pinned like BridgeAdmissionTest's phone: the same 6 MiB through the class.
        assertEquals(4_669_440, ClipboardPeek.imageBudget(BridgeAdmission(192L * 1024 * 1024).messageLimitChars, 0))
    }

    @Test
    fun theTextTakesItsShareOfTheBudgetAtThreeBytesPerFourOfItsChars() {
        // A 1 MiB quoted text lowers the 6 MiB budget by 768 KiB.
        assertEquals(4_669_440 - 786_432, ClipboardPeek.imageBudget(6 * mib, (1 * mib).toInt()))
        assertEquals(4_669_440 - 3, ClipboardPeek.imageBudget(6 * mib, 4))
        // The term is the text AS JSON: the quotes and the escapes count, not the raw length.
        assertEquals(2, ClipboardPeek.textQuotedChars(""))
        assertEquals(5, ClipboardPeek.textQuotedChars("abc"))
        assertEquals(12, ClipboardPeek.textQuotedChars("a\"b\\c\nd"))
    }

    @Test
    fun theBudgetsBase64BesideTheEnvelopeAndTheTextNeverPassesTheLimit() {
        val limits = listOf(2 * mib, 6 * mib, 6 * mib + 1, 6 * mib + 2, 6 * mib + 3, 8 * mib, 16 * mib, 87_384L, 100_001L)
        val texts = listOf(0, 1, 2, 3, 5, 1000, 65_537, (1 * mib).toInt(), (5 * mib).toInt())
        var checked = 0
        for (limit in limits) for (text in texts) {
            val budget = ClipboardPeek.imageBudget(limit, text)
            if (budget == 0) continue
            val base64Chars = (budget + 2) / 3 * 4 // ceil(budget / 3) * 4: the encoding's padding included
            assert(base64Chars + slack + text <= limit) { "budget $budget for limit $limit beside $text chars" }
            assert(budget <= ClipboardPeek.MAX_IMAGE_BYTES)
            checked++
        }
        assert(checked >= 40) { "$checked budgets checked" }
    }

    @Test
    fun underTheFloorOrWithNoRoomLeftNoImageGoes() {
        // 21 847 chars of room give 5 461 groups of three bytes, 16 383 – one under the floor; 21 848 give 16 386.
        assertEquals(0, ClipboardPeek.imageBudget(slack + 21_847, 0))
        assertEquals(16_386, ClipboardPeek.imageBudget(slack + 21_848, 0))
        // The text leaves nothing, or less than nothing.
        assertEquals(0, ClipboardPeek.imageBudget(6 * mib, (6 * mib - slack).toInt()))
        assertEquals(0, ClipboardPeek.imageBudget(6 * mib, (6 * mib).toInt()))
        assertEquals(0, ClipboardPeek.imageBudget(0L, 0))
    }

    /** A stand-in for the bitmap in the shrink loop: one byte per pixel when encoded. */
    private data class Fake(val width: Int, val height: Int)

    private fun shrink(image: Fake, maxBytes: Int, recycled: MutableList<Fake> = mutableListOf()): Pair<ByteArray, Fake> =
        ClipboardPeek.shrinkToBudget(
            image,
            maxBytes,
            size = { it.width to it.height },
            encode = { ByteArray(it.width * it.height) },
            halve = { Fake(maxOf(1, it.width / 2), maxOf(1, it.height / 2)) },
            recycle = { recycled += it }
        )

    @Test
    fun anEncodingWithinTheBudgetGoesAsItIsAndNothingIsRecycled() {
        val recycled = mutableListOf<Fake>()
        val image = Fake(100, 100)
        val (bytes, encoded) = shrink(image, 10_000, recycled)
        assertEquals(10_000, bytes.size)
        assert(encoded === image)
        assertEquals(emptyList<Fake>(), recycled)
    }

    @Test
    fun anEncodingOverTheBudgetIsHalvedUntilItFitsAndTheHalvingsLeftBehindAreRecycled() {
        val recycled = mutableListOf<Fake>()
        // 100 × 100 = 10 000 over 2 000; 50 × 50 = 2 500 still over; 25 × 25 = 625 fits.
        val (bytes, encoded) = shrink(Fake(100, 100), 2_000, recycled)
        assertEquals(625, bytes.size)
        assertEquals(Fake(25, 25), encoded)
        // The 50 × 50 alone: the image handed in is the caller's, the 25 × 25 is returned.
        assertEquals(listOf(Fake(50, 50)), recycled)
    }

    @Test
    fun theLoopEndsAtOnePixelWhenNothingFits() {
        val recycled = mutableListOf<Fake>()
        val (bytes, encoded) = shrink(Fake(4, 4), 0, recycled)
        assertEquals(1, bytes.size)
        assertEquals(Fake(1, 1), encoded)
        assertEquals(listOf(Fake(2, 2)), recycled)
        // Neither edge under a pixel on the way down.
        assertEquals(Fake(1, 1), shrink(Fake(1, 8), 0).second)
    }
}
