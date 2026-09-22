package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The cover's hold for a long capture (SH-08): a message strip that stays – a banner at rest
 * above the page – must not be stitched into every strip of the page, so the capture holds
 * the strips at 0 (the page draws over the banner) and the release puts them back where the
 * chrome last asked. The springs are never run here: at rest and under a snap, nothing animates.
 */
class ContentCoverTest {
    private var changes = 0
    private val density = 2.625f
    private val cover = ContentCover({ density }) { changes++ }

    /** A default-browser banner at rest across the top of the page: 56 CSS px, on a 2.625 screen. */
    private fun bannerAtRest() {
        cover.set(56f, 0f, snap = true)
        changes = 0
    }

    @Test
    fun aBannerAtRestClipsThePageAndIsActive() {
        bannerAtRest()
        assertEquals(56f, cover.top)
        assertEquals(147, cover.topPx)
        assertTrue(cover.active)
    }

    @Test
    fun theHoldPutsTheStripsAtZeroSoACopyOfTheFrameIsThePageAlone() {
        bannerAtRest()
        cover.hold()
        assertTrue(cover.held)
        assertEquals(0f, cover.top)
        assertEquals(0, cover.topPx)
        assertEquals(0, cover.bottomPx)
        // No strip: touches on the frame are the page's, and the capture need not wait.
        assertFalse(cover.active)
        // The chrome's value is kept for the release.
        assertEquals(56f, cover.topTarget)
        assertEquals(1, changes)
    }

    @Test
    fun theReleasePutsTheBannerBackAtOnce() {
        bannerAtRest()
        cover.hold()
        cover.release()
        assertFalse(cover.held)
        assertEquals(56f, cover.top)
        assertEquals(147, cover.topPx)
        assertTrue(cover.active)
        assertEquals(2, changes)
    }

    @Test
    fun aCoverChangeDuringTheHoldWaitsForTheRelease() {
        bannerAtRest()
        cover.hold()
        // A toast arrives under the banner while the page is being stitched: its strip is noted...
        cover.set(56f, 72f)
        assertEquals(0f, cover.top)
        assertEquals(0f, cover.bottom)
        assertEquals(72f, cover.bottomTarget)
        assertFalse(cover.active)
        // ...and the banner is dismissed: noted too, the strips still at 0.
        cover.set(0f, 72f, snap = true)
        assertEquals(0f, cover.top)
        assertEquals(0f, cover.topTarget)
        // The release lands on what the chrome last asked, not on what the hold began with.
        cover.release()
        assertEquals(0f, cover.top)
        assertEquals(72f, cover.bottom)
        assertEquals(189, cover.bottomPx)
        assertTrue(cover.active)
    }

    @Test
    fun aHoldWithNoStripsChangesNothingButIsStillReleasedCleanly() {
        cover.hold()
        assertFalse(cover.active)
        cover.release()
        assertFalse(cover.active)
        assertEquals(0f, cover.top)
        assertEquals(0f, cover.bottom)
        assertEquals(2, changes)
    }

    @Test
    fun aSecondHoldOrReleaseIsANoOp() {
        bannerAtRest()
        cover.hold()
        cover.hold()
        assertEquals(1, changes)
        cover.release()
        cover.release()
        assertEquals(2, changes)
        assertEquals(56f, cover.top)
    }

    @Test
    fun resetEndsAHold() {
        bannerAtRest()
        cover.hold()
        cover.reset()
        assertFalse(cover.held)
        assertEquals(0f, cover.topTarget)
        // A late release (the view was replaced under the capture) has nothing to put back.
        cover.release()
        assertEquals(0f, cover.top)
        assertFalse(cover.active)
    }
}
