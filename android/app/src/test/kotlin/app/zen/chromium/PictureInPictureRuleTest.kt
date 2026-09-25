package app.zen.chromium

import app.zen.chromium.PictureInPictureRule.End
import app.zen.chromium.PictureInPictureRule.Entry
import app.zen.chromium.PictureInPictureRule.Window
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PictureInPictureRuleTest {
    private val fullscreen = Window("t1", Entry.FULLSCREEN)
    private val inline = Window("t1", Entry.INLINE)

    // --- the way in ---

    @Test
    fun entryIsFullscreenWhenTheRequestingTabsElementIsFullscreen() {
        assertEquals(Entry.FULLSCREEN, PictureInPictureRule.entryOf("t1", fullscreenTabId = "t1"))
    }

    @Test
    fun entryIsInlineWithoutAFullscreenOrWithAnotherTabsFullscreen() {
        assertEquals(Entry.INLINE, PictureInPictureRule.entryOf("t1", fullscreenTabId = null))
        assertEquals(Entry.INLINE, PictureInPictureRule.entryOf("t1", fullscreenTabId = "t2"))
    }

    // --- endings by themselves (Chrome's dismissals) ---

    @Test
    fun closingTheWindowsTabEndsIt() {
        assertEquals(End.TAB_CLOSED, PictureInPictureRule.onTabRemoved(fullscreen, "t1"))
        assertEquals(End.TAB_CLOSED, PictureInPictureRule.onTabRemoved(inline, "t1"))
    }

    @Test
    fun closingAnotherTabLeavesTheWindowAlone() {
        assertNull(PictureInPictureRule.onTabRemoved(fullscreen, "t2"))
        assertNull(PictureInPictureRule.onTabRemoved(inline, "t2"))
    }

    @Test
    fun theWindowsRendererGoingEndsIt() {
        assertEquals(End.RENDERER_GONE, PictureInPictureRule.onRendererGone(fullscreen, "t1"))
        assertNull(PictureInPictureRule.onRendererGone(fullscreen, "t2"))
    }

    @Test
    fun anotherTabBecomingActiveEndsTheWindow() {
        assertEquals(End.TAB_CHANGED, PictureInPictureRule.onActiveTabChanged(fullscreen, "t2"))
        assertEquals(End.TAB_CHANGED, PictureInPictureRule.onActiveTabChanged(inline, "t2"))
    }

    @Test
    fun theWindowsOwnTabBecomingActiveAgainIsNoChange() {
        assertNull(PictureInPictureRule.onActiveTabChanged(fullscreen, "t1"))
        assertNull(PictureInPictureRule.onActiveTabChanged(fullscreen, null))
    }

    @Test
    fun leavingFullscreenEndsAWindowThatCameFromTheFullscreen() {
        assertEquals(End.LEFT_FULLSCREEN, PictureInPictureRule.onFullscreenExited(fullscreen, "t1"))
    }

    @Test
    fun leavingFullscreenLeavesAnInlineVideosWindowAlone() {
        assertNull(PictureInPictureRule.onFullscreenExited(inline, "t1"))
    }

    @Test
    fun anotherTabLeavingFullscreenLeavesTheWindowAlone() {
        assertNull(PictureInPictureRule.onFullscreenExited(fullscreen, "t2"))
    }

    @Test
    fun aNewDocumentInTheWindowsTabEndsItEitherWayIn() {
        assertEquals(End.NAVIGATED, PictureInPictureRule.onDocumentStarted(fullscreen, "t1"))
        assertEquals(End.NAVIGATED, PictureInPictureRule.onDocumentStarted(inline, "t1"))
        assertNull(PictureInPictureRule.onDocumentStarted(inline, "t2"))
    }

    @Test
    fun nothingEndsAWindowThatIsNotThere() {
        assertNull(PictureInPictureRule.onTabRemoved(null, "t1"))
        assertNull(PictureInPictureRule.onRendererGone(null, "t1"))
        assertNull(PictureInPictureRule.onActiveTabChanged(null, "t2"))
        assertNull(PictureInPictureRule.onFullscreenExited(null, "t1"))
        assertNull(PictureInPictureRule.onDocumentStarted(null, "t1"))
    }

    @Test
    fun theEventWordsAreStable() {
        assertEquals(
            listOf("tab-closed", "renderer-gone", "tab-changed", "left-fullscreen", "navigated"),
            End.entries.map { it.reason }
        )
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
    fun closingWithTheXPausesThePlayingVideoAndLeavesFullscreen() {
        val exit = PictureInPictureRule.onLeft(resumed = false, playing = true, fullscreen = true)
        assertTrue(exit.dismissed)
        assertTrue(exit.pause)
        assertTrue(exit.exitFullscreen)
    }

    @Test
    fun closingWithTheXPausesNothingAlreadyPaused() {
        val exit = PictureInPictureRule.onLeft(resumed = false, playing = false, fullscreen = true)
        assertTrue(exit.dismissed)
        assertFalse(exit.pause)
        assertTrue(exit.exitFullscreen)
    }

    @Test
    fun closingAnInlineVideosWindowHasNoFullscreenToLeave() {
        val exit = PictureInPictureRule.onLeft(resumed = false, playing = true, fullscreen = false)
        assertTrue(exit.dismissed)
        assertTrue(exit.pause)
        assertFalse(exit.exitFullscreen)
    }
}
