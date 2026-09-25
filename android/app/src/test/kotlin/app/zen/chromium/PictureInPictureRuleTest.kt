package app.zen.chromium

import app.zen.chromium.PictureInPictureRule.End
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PictureInPictureRuleTest {
    private val pip = "t1"

    // --- endings by themselves (Chrome's dismissals) ---

    @Test
    fun closingTheWindowsTabEndsIt() {
        assertEquals(End.TAB_CLOSED, PictureInPictureRule.onTabRemoved(pip, "t1"))
    }

    @Test
    fun closingAnotherTabLeavesTheWindowAlone() {
        assertNull(PictureInPictureRule.onTabRemoved(pip, "t2"))
    }

    @Test
    fun theWindowsRendererGoingEndsIt() {
        assertEquals(End.RENDERER_GONE, PictureInPictureRule.onRendererGone(pip, "t1"))
        assertNull(PictureInPictureRule.onRendererGone(pip, "t2"))
    }

    @Test
    fun anotherTabBecomingActiveEndsTheWindow() {
        assertEquals(End.TAB_CHANGED, PictureInPictureRule.onActiveTabChanged(pip, "t2"))
    }

    @Test
    fun theWindowsOwnTabBecomingActiveAgainIsNoChange() {
        assertNull(PictureInPictureRule.onActiveTabChanged(pip, "t1"))
        assertNull(PictureInPictureRule.onActiveTabChanged(pip, null))
    }

    @Test
    fun aNewDocumentInTheWindowsTabEndsIt() {
        assertEquals(End.NAVIGATED, PictureInPictureRule.onDocumentStarted(pip, "t1"))
        assertNull(PictureInPictureRule.onDocumentStarted(pip, "t2"))
    }

    @Test
    fun nothingEndsAWindowThatIsNotThere() {
        assertNull(PictureInPictureRule.onTabRemoved(null, "t1"))
        assertNull(PictureInPictureRule.onRendererGone(null, "t1"))
        assertNull(PictureInPictureRule.onActiveTabChanged(null, "t2"))
        assertNull(PictureInPictureRule.onDocumentStarted(null, "t1"))
    }

    @Test
    fun theEventWordsAreStable() {
        assertEquals(listOf("tab-closed", "renderer-gone", "tab-changed", "navigated"), End.entries.map { it.reason })
    }

    // --- Chrome's exit delay ---

    @Test
    fun aDismissalRightAfterTheEntryWaitsOutTheRestOfTheDelay() {
        assertEquals(50L, PictureInPictureRule.exitDelayMs(nowMs = 1_000, enteredAtMs = 1_000))
        assertEquals(20L, PictureInPictureRule.exitDelayMs(nowMs = 1_030, enteredAtMs = 1_000))
    }

    @Test
    fun aDismissalAfterTheDelayGoesAtOnce() {
        assertEquals(0L, PictureInPictureRule.exitDelayMs(nowMs = 1_050, enteredAtMs = 1_000))
        assertEquals(0L, PictureInPictureRule.exitDelayMs(nowMs = 9_000, enteredAtMs = 1_000))
    }

    @Test
    fun aClockThatRanBackwardsNeverWaitsLongerThanTheDelay() {
        assertEquals(50L, PictureInPictureRule.exitDelayMs(nowMs = 500, enteredAtMs = 1_000))
    }

    // --- endings by the user's hand ---

    @Test
    fun expandingResumesThePageAsItWas() {
        val exit = PictureInPictureRule.onLeft(resumed = true, playing = true, fullscreen = true)
        assertFalse(exit.dismissed)
        assertFalse(exit.pause)
        assertFalse(exit.exitFullscreen)
    }

    @Test
    fun closingWithTheXPausesThePlayingVideo() {
        val exit = PictureInPictureRule.onLeft(resumed = false, playing = true, fullscreen = false)
        assertTrue(exit.dismissed)
        assertTrue(exit.pause)
        assertFalse(exit.exitFullscreen)
    }

    @Test
    fun closingWithTheXPausesNothingAlreadyPaused() {
        val exit = PictureInPictureRule.onLeft(resumed = false, playing = false, fullscreen = false)
        assertTrue(exit.dismissed)
        assertFalse(exit.pause)
        assertFalse(exit.exitFullscreen)
    }

    @Test
    fun closingWithTheXLeavesAFullscreenTheTabStillHolds() {
        val exit = PictureInPictureRule.onLeft(resumed = false, playing = true, fullscreen = true)
        assertTrue(exit.dismissed)
        assertTrue(exit.pause)
        assertTrue(exit.exitFullscreen)
    }
}
