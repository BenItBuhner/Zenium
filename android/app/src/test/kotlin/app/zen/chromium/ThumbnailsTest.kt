package app.zen.chromium

import app.zen.chromium.ext.ZipFixtures
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The tab cards' pictures on disk (`cacheDir/zen-thumbs/<tabId>.jpg`): one file per tab, replaced
 * whole, dropped on the chrome's word, swept at boot for the tabs that did not come back – and
 * the arithmetic a capture is scaled by. The bitmap work itself runs on a device.
 */
class ThumbnailsTest {
    private val dir = File(ZipFixtures.tempDir("zen-thumbs-test"), Thumbnails.DIR)
    private val thumbnails = Thumbnails(dir)
    private val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 1, 2, 3)

    @After
    fun cleanUp() {
        dir.parentFile?.deleteRecursively()
    }

    @Test
    fun aPictureRoundTripsUnderItsTabAndLeavesNoTempFile() {
        assertNull(thumbnails.load("tab-1"))
        assertTrue(thumbnails.save("tab-1", jpeg))
        assertArrayEquals(jpeg, thumbnails.load("tab-1"))
        assertEquals(listOf("tab-1.jpg"), dir.list()!!.toList())
        assertEquals(listOf("tab-1"), thumbnails.ids())
    }

    @Test
    fun aNewerPictureReplacesTheOldWhole() {
        thumbnails.save("tab-1", jpeg)
        val next = byteArrayOf(9, 8, 7)
        assertTrue(thumbnails.save("tab-1", next))
        assertArrayEquals(next, thumbnails.load("tab-1"))
        assertEquals(1, dir.list()!!.size)
    }

    @Test
    fun aDropForgetsThePictureAndAnUnfinishedWrite() {
        thumbnails.save("tab-1", jpeg)
        File(dir, "tab-1.jpg.tmp").writeBytes(jpeg)
        assertTrue(thumbnails.drop("tab-1"))
        assertNull(thumbnails.load("tab-1"))
        assertEquals(emptyList<String>(), dir.list()!!.toList())
        // Nothing there is nothing to do, not a failure.
        assertTrue(thumbnails.drop("tab-1"))
    }

    @Test
    fun aSweepKeepsTheSessionsTabsOnly() {
        for (id in listOf("kept-1", "kept-2", "gone-1", "gone-2")) thumbnails.save(id, jpeg)
        File(dir, "half-written.jpg.tmp").writeBytes(jpeg)
        File(dir, "stray.txt").writeText("x")
        assertEquals(4, thumbnails.sweep(setOf("kept-1", "kept-2", "never-had-one")))
        assertEquals(listOf("kept-1", "kept-2"), thumbnails.ids())
        assertEquals(setOf("kept-1.jpg", "kept-2.jpg"), dir.list()!!.toSet())
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
        assertFalse(thumbnails.save("", jpeg))
        val file = thumbnails.fileFor("a/b")
        assertNotNull(file)
        assertEquals(dir, file!!.parentFile)
        assertTrue(thumbnails.save("a/b", jpeg))
        assertArrayEquals(jpeg, thumbnails.load("a/b"))
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
