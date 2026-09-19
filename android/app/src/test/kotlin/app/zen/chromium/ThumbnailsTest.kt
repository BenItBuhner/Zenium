package app.zen.chromium

import app.zen.chromium.ext.ZipFixtures
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The tab cards' pictures on disk (`cacheDir/zen-thumbs/<tabId>.jpg`): one file per tab, replaced
 * whole, stamped with the document it shows and read for that document alone, dropped on the
 * chrome's word, swept at boot for the tabs that did not come back and down to the newest of too
 * many – and the arithmetic a capture is scaled by, and the freshness rule a hide takes a picture
 * by. The bitmap work itself runs on a device.
 */
class ThumbnailsTest {
    private val dir = File(ZipFixtures.tempDir("zen-thumbs-test"), Thumbnails.DIR)
    private val thumbnails = Thumbnails(dir)
    private val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 1, 2, 3)
    private val page = "https://example.com/a"

    @After
    fun cleanUp() {
        dir.parentFile?.deleteRecursively()
    }

    @Test
    fun aPictureRoundTripsUnderItsTabAndLeavesNoTempFile() {
        assertNull(thumbnails.load("tab-1"))
        assertTrue(thumbnails.save("tab-1", jpeg, page))
        assertArrayEquals(Thumbnails.stamp(jpeg, page), thumbnails.load("tab-1"))
        assertEquals(listOf("tab-1.jpg"), dir.list()!!.toList())
        assertEquals(listOf("tab-1"), thumbnails.ids())
    }

    @Test
    fun aNewerPictureReplacesTheOldWhole() {
        thumbnails.save("tab-1", jpeg, page)
        val next = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 9, 8, 7)
        assertTrue(thumbnails.save("tab-1", next, "https://example.com/b"))
        assertArrayEquals(Thumbnails.stamp(next, "https://example.com/b"), thumbnails.load("tab-1"))
        assertEquals(1, dir.list()!!.size)
    }

    @Test
    fun aDropForgetsThePictureAndAnUnfinishedWrite() {
        thumbnails.save("tab-1", jpeg, page)
        File(dir, "tab-1.jpg.tmp").writeBytes(jpeg)
        assertTrue(thumbnails.drop("tab-1"))
        assertNull(thumbnails.load("tab-1"))
        assertEquals(emptyList<String>(), dir.list()!!.toList())
        // Nothing there is nothing to do, not a failure.
        assertTrue(thumbnails.drop("tab-1"))
    }

    @Test
    fun aDropNamingThePageTheTabLeftSparesAPictureOfTheNextPage() {
        // The chrome's drop for a navigation arrived after the capture of the new page was saved
        // (the two queue on one thread; the drop was the later): the new page's picture stays.
        val next = "https://example.com/b"
        assertTrue(thumbnails.save("tab-1", realJpeg(), next))
        assertFalse(thumbnails.drop("tab-1", document = page))
        assertEquals(Thumbnails.digest(next), Thumbnails.documentOf(thumbnails.load("tab-1")!!))
        // The picture of the page the tab left goes on its name, and a picture of no known page
        // (nothing stamped) goes on any.
        assertTrue(thumbnails.drop("tab-1", document = next))
        assertNull(thumbnails.load("tab-1"))
        thumbnails.fileFor("tab-1")!!.also { dir.mkdirs() }.writeBytes(realJpeg())
        assertTrue(thumbnails.drop("tab-1", document = page))
        assertNull(thumbnails.load("tab-1"))
        // Without a page named the tab is gone for good: whatever is there goes.
        assertTrue(thumbnails.save("tab-1", realJpeg(), next))
        assertTrue(thumbnails.drop("tab-1"))
        assertNull(thumbnails.load("tab-1"))
    }

    @Test
    fun aSweepKeepsTheSessionsTabsOnly() {
        for (id in listOf("kept-1", "kept-2", "gone-1", "gone-2")) thumbnails.save(id, jpeg, page)
        File(dir, "half-written.jpg.tmp").writeBytes(jpeg)
        File(dir, "stray.txt").writeText("x")
        assertEquals(4, thumbnails.sweep(setOf("kept-1", "kept-2", "never-had-one")))
        assertEquals(listOf("kept-1", "kept-2"), thumbnails.ids())
        assertEquals(setOf("kept-1.jpg", "kept-2.jpg"), dir.list()!!.toSet())
    }

    @Test
    fun aSweepKeepsTheNewestOfTooManyPictures() {
        // Three pictures of the session, the disk bounded to two: the oldest goes.
        for ((i, id) in listOf("old", "mid", "new").withIndex()) {
            thumbnails.save(id, jpeg, page)
            assertTrue(thumbnails.fileFor(id)!!.setLastModified(1_700_000_000_000L + i * 60_000L))
        }
        assertEquals(1, thumbnails.sweep(setOf("old", "mid", "new"), max = 2))
        assertEquals(listOf("mid", "new"), thumbnails.ids())
        // Within the bound, a sweep of the same session takes nothing.
        assertEquals(0, thumbnails.sweep(setOf("old", "mid", "new"), max = 2))
    }

    @Test
    fun aSweepOfAMissingDirectoryIsNothing() {
        assertFalse(dir.exists())
        assertEquals(0, thumbnails.sweep(setOf("a")))
        assertEquals(emptyList<String>(), thumbnails.ids())
    }

    @Test
    fun aTabIdIsAFileNameOnlyWhereItIsSafe() {
        assertEquals("tab_1", Thumbnails.fileName("tab/1"))
        assertEquals("_.._x", Thumbnails.fileName("/../x"))
        assertNull(thumbnails.fileFor(""))
        assertNull(thumbnails.fileFor(".."))
        assertFalse(thumbnails.save("", jpeg, page))
        val file = thumbnails.fileFor("a/b")
        assertNotNull(file)
        assertEquals(dir, file!!.parentFile)
        assertTrue(thumbnails.save("a/b", jpeg, page))
        assertArrayEquals(Thumbnails.stamp(jpeg, page), thumbnails.load("a/b"))
    }

    @Test
    fun aPictureCarriesItsDocumentPastTheJfifHeaderAndIsOtherwiseTheSame() {
        val plain = realJpeg()
        val stamped = Thumbnails.stamp(plain, page)
        // Nothing before the stamp: no document. After it: this one, and no other.
        assertNull(Thumbnails.documentOf(plain))
        assertEquals(Thumbnails.digest(page), Thumbnails.documentOf(stamped))
        assertNotEquals(Thumbnails.digest("https://example.com/b"), Thumbnails.documentOf(stamped))
        // JFIF's APP0 stays first, as JFIF asks; the comment follows it, one whole segment among
        // whole segments down to EOI; the picture around it is byte for byte the one encoded.
        assertEquals(listOf(APP0, DQT, SOF0, DHT, SOS, EOI), markers(plain))
        assertEquals(listOf(APP0, COM, DQT, SOF0, DHT, SOS, EOI), markers(stamped))
        assertEquals(stamped.size, plain.size + 4 + "zen-document:".length + 64)
        assertArrayEquals(plain, withoutComment(stamped))
        assertEquals(12 to 20, frameSize(stamped))
        // The URL itself is not in the file, its digest is.
        assertFalse(String(stamped, Charsets.ISO_8859_1).contains("example.com"))
    }

    @Test
    fun aPictureWithoutAnApplicationHeaderTakesTheStampRightAfterSoi() {
        val bare = segment(SOI, byteArrayOf()) + segment(SOF0, frame(12, 20)) + segment(SOS, byteArrayOf(1)) + scan() + segment(EOI, byteArrayOf())
        val stamped = Thumbnails.stamp(bare, page)
        assertEquals(listOf(COM, SOF0, SOS, EOI), markers(stamped))
        assertEquals(Thumbnails.digest(page), Thumbnails.documentOf(stamped))
        assertArrayEquals(bare, withoutComment(stamped))
    }

    @Test
    fun bytesThatAreNoJpegTakeNoStamp() {
        val bytes = byteArrayOf(1, 2, 3, 4, 5)
        assertArrayEquals(bytes, Thumbnails.stamp(bytes, page))
        assertNull(Thumbnails.documentOf(bytes))
        assertNull(Thumbnails.documentOf(byteArrayOf()))
    }

    @Test
    fun aReadForAnotherDocumentThanThePicturesIsNothing() {
        // The tab left the page its picture shows before the picture was written (or the kill
        // came between the two): the file is not the tab's new page, and no card gets it.
        assertTrue(thumbnails.save("tab-1", realJpeg(), page))
        assertNull(thumbnails.loadPicture("tab-1", "https://example.com/b"))
        // The file stays for the next picture to replace (a read is no writer).
        assertNotNull(thumbnails.load("tab-1"))
        // Nothing on disk is nothing, whatever the document.
        assertNull(thumbnails.loadPicture("tab-2", page))
    }

    @Test
    fun aNavigationWithinTheFreshnessWindowMakesTheNextHideTakeAPicture() {
        // A picture taken at T stands for the page for FRESH_MS ...
        thumbnails.taken("tab-1", 1000L)
        assertTrue(thumbnails.fresh("tab-1", 1000L + Thumbnails.FRESH_MS - 1))
        assertFalse(thumbnails.fresh("tab-1", 1000L + Thumbnails.FRESH_MS))
        // ... unless the page changed under it: the tab left within the window and its card
        // would otherwise show the placeholder until the tab was shown and left again.
        thumbnails.taken("tab-1", 5000L)
        thumbnails.stale("tab-1")
        assertFalse(thumbnails.fresh("tab-1", 5001L))
        // One tab's picture says nothing of another's.
        thumbnails.taken("tab-2", 5000L)
        assertTrue(thumbnails.fresh("tab-2", 5001L))
        assertFalse(thumbnails.fresh("tab-3", 5001L))
    }

    /**
     * A 12 x 20 JPEG in the segments an encoder writes them (JFIF's APP0 first, a quantisation
     * table, the frame, a Huffman table, the scan with a stuffed 0xFF00 in its data, EOI), built
     * here byte by byte: the unit tests compile against android.jar, which has no image codec,
     * and what the stamp is tested on is the marker structure, not the pixels.
     */
    private fun realJpeg(): ByteArray =
        segment(SOI, byteArrayOf()) +
            segment(APP0, "JFIF".toByteArray(Charsets.US_ASCII) + byteArrayOf(0, 1, 1, 0, 0, 1, 0, 1, 0, 0)) +
            segment(DQT, byteArrayOf(0) + ByteArray(64) { 1 }) +
            segment(SOF0, frame(12, 20)) +
            segment(DHT, byteArrayOf(0) + ByteArray(16)) +
            segment(SOS, byteArrayOf(3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0)) + scan() +
            segment(EOI, byteArrayOf())

    /** A marker and its segment (a standalone marker for SOI and EOI). */
    private fun segment(marker: Int, payload: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(0xFF)
        out.write(marker)
        if (marker != SOI && marker != EOI) {
            val length = payload.size + 2
            out.write(length shr 8)
            out.write(length and 0xFF)
            out.write(payload)
        }
        return out.toByteArray()
    }

    /** A baseline frame header's payload: 8-bit samples, `height` x `width`, three components. */
    private fun frame(width: Int, height: Int): ByteArray =
        byteArrayOf(8, (height shr 8).toByte(), height.toByte(), (width shr 8).toByte(), width.toByte(), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1)

    /** Entropy-coded data, a stuffed 0xFF00 among it. */
    private fun scan(): ByteArray = byteArrayOf(0x12, 0x34, 0xFF.toByte(), 0x00, 0x56)

    /**
     * The markers after SOI, in order, each read from the segment before it (its length, or the
     * scan's data up to the next marker after SOS) – so one segment out of place or short and
     * the walk reads garbage for a marker.
     */
    private fun markers(jpeg: ByteArray): List<Int> {
        val found = ArrayList<Int>()
        var at = 2
        while (at + 1 < jpeg.size) {
            assertEquals("marker at $at", 0xFF, jpeg[at].toInt() and 0xFF)
            val marker = jpeg[at + 1].toInt() and 0xFF
            found += marker
            if (marker == EOI) return found
            at += 2 + length(jpeg, at)
            if (marker == SOS) {
                while (!(jpeg[at].toInt() and 0xFF == 0xFF && jpeg[at + 1].toInt() and 0xFF != 0)) at++
            }
        }
        return found
    }

    private fun length(jpeg: ByteArray, markerAt: Int): Int =
        ((jpeg[markerAt + 2].toInt() and 0xFF) shl 8) or (jpeg[markerAt + 3].toInt() and 0xFF)

    /** `jpeg` without its first comment segment. */
    private fun withoutComment(jpeg: ByteArray): ByteArray {
        var at = 2
        while (jpeg[at + 1].toInt() and 0xFF != COM) at += 2 + length(jpeg, at)
        return jpeg.copyOfRange(0, at) + jpeg.copyOfRange(at + 2 + length(jpeg, at), jpeg.size)
    }

    /** The width and height the frame header says. */
    private fun frameSize(jpeg: ByteArray): Pair<Int, Int> {
        var at = 2
        while (jpeg[at + 1].toInt() and 0xFF != SOF0) at += 2 + length(jpeg, at)
        val height = ((jpeg[at + 5].toInt() and 0xFF) shl 8) or (jpeg[at + 6].toInt() and 0xFF)
        val width = ((jpeg[at + 7].toInt() and 0xFF) shl 8) or (jpeg[at + 8].toInt() and 0xFF)
        return width to height
    }

    private companion object {
        const val SOI = 0xD8
        const val APP0 = 0xE0
        const val COM = 0xFE
        const val DQT = 0xDB
        const val SOF0 = 0xC0
        const val DHT = 0xC4
        const val SOS = 0xDA
        const val EOI = 0xD9
    }

    @Test
    fun aCaptureIsScaledToTheCardsWidthAndNeverUp() {
        // A 1080 x 2400 page copied at half size (540 x 1200), for a 531 px card.
        assertEquals(531, Thumbnails.targetWidth(540, 531))
        assertEquals(531 to 1180, Thumbnails.sizeFor(540, 1200, 531))
        // A card wider than the copy: the copy's own size, nothing made up.
        assertEquals(540, Thumbnails.targetWidth(540, 900))
        assertEquals(540 to 1200, Thumbnails.sizeFor(540, 1200, 540))
        // Before the chrome has said how wide a card is.
        assertEquals(Thumbnails.DEFAULT_WIDTH, Thumbnails.targetWidth(700, 0))
        assertEquals(1 to 1, Thumbnails.sizeFor(0, 0, 531))
    }

    @Test
    fun aFreshPictureStandsForTheFreshnessWindow() {
        assertFalse(Thumbnails.isFresh(0L, 1000L))
        assertTrue(Thumbnails.isFresh(1000L, 1000L + Thumbnails.FRESH_MS - 1))
        assertFalse(Thumbnails.isFresh(1000L, 1000L + Thumbnails.FRESH_MS))
    }
}

/**
 * One PixelCopy per frame however many ask for the page's pixels: the cover a sheet takes, the
 * card picture a hide takes for the same frame and the history preview join one copy.
 */
class CaptureShareTest {
    private val share = CaptureShare<String>()

    @Test
    fun aSecondRequestWhileACopyIsInFlightJoinsIt() {
        val heard = mutableListOf<String?>()
        val first = share.request(0.5f) { heard += "cover:$it" }
        assertNotNull(first)
        // The card picture, asked for the same frame at the same scale: no copy of its own.
        assertNull(share.request(0.5f) { heard += "card:$it" })
        // Nor for one that needs fewer pixels than the copy under way has.
        assertNull(share.request(0.25f) { heard += "preview:$it" })
        assertEquals(1, share.inFlight)
        share.complete(first!!, "pixels")
        assertEquals(listOf("cover:pixels", "card:pixels", "preview:pixels"), heard)
        assertEquals(0, share.inFlight)
    }

    @Test
    fun aRequestForMorePixelsThanAnyCopyInFlightStartsItsOwn() {
        val heard = mutableListOf<String?>()
        val small = share.request(0.25f) { heard += "small:$it" }
        val big = share.request(0.5f) { heard += "big:$it" }
        assertNotNull(small)
        assertNotNull(big)
        assertEquals(2, share.inFlight)
        // A third at the small scale joins the oldest copy that will do.
        assertNull(share.request(0.25f) { heard += "another:$it" })
        share.complete(big!!, "big-pixels")
        share.complete(small!!, "small-pixels")
        assertEquals(listOf("big:big-pixels", "small:small-pixels", "another:small-pixels"), heard)
    }

    @Test
    fun aCopyThatFailedFailsEveryoneWhoJoinedItOnce() {
        val heard = mutableListOf<String?>()
        val ticket = share.request(0.5f) { heard += it }
        share.request(0.5f) { heard += it }
        share.complete(ticket!!, null)
        share.complete(ticket, "late")
        assertEquals(listOf<String?>(null, null), heard)
        // After it, a new request is a new copy.
        assertNotNull(share.request(0.5f) { heard += it })
    }
}
