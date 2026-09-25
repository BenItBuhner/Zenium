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

    // --- the hold for the screen and the keyguard (Chrome's mDismissPending) ---

    @Test
    fun anEndingWithTheScreenOnAndNoKeyguardGoesAtOnce() {
        assertFalse(PictureInPictureRule.shouldDeferEnding(interactive = true, keyguardLocked = false))
    }

    @Test
    fun anEndingWithTheScreenOffIsHeldForOnStart() {
        // Chrome's predicate (`PowerManager.isInteractive` false); the keyguard's state makes no difference to it.
        assertTrue(PictureInPictureRule.shouldDeferEnding(interactive = false, keyguardLocked = false))
        assertTrue(PictureInPictureRule.shouldDeferEnding(interactive = false, keyguardLocked = true))
    }

    @Test
    fun anEndingWithTheKeyguardUpIsHeldThoughTheScreenIsOn() {
        // The lock screen showing with the screen on (the power button pressed once more before
        // the unlock): the case Chrome's comment names and its predicate misses.
        assertTrue(PictureInPictureRule.shouldDeferEnding(interactive = true, keyguardLocked = true))
    }

    // --- endings by the user's hand ---

    @Test
    fun expandingResumesThePageAsItWas() {
        val exit = PictureInPictureRule.onLeft(pipTabId = pip, pipPlaying = true, resumed = true, fullscreen = true)
        assertFalse(exit.dismissed)
        assertNull(exit.pauseTabId)
        assertFalse(exit.exitFullscreen)
    }

    @Test
    fun closingWithTheXPausesTheWindowsPlayingVideo() {
        val exit = PictureInPictureRule.onLeft(pipTabId = pip, pipPlaying = true, resumed = false, fullscreen = false)
        assertTrue(exit.dismissed)
        assertEquals("t1", exit.pauseTabId)
        assertFalse(exit.exitFullscreen)
    }

    @Test
    fun closingWithTheXPausesNothingAlreadyPaused() {
        val exit = PictureInPictureRule.onLeft(pipTabId = pip, pipPlaying = false, resumed = false, fullscreen = false)
        assertTrue(exit.dismissed)
        assertNull(exit.pauseTabId)
        assertFalse(exit.exitFullscreen)
    }

    @Test
    fun closingWithTheXLeavesAFullscreenTheTabStillHolds() {
        val exit = PictureInPictureRule.onLeft(pipTabId = pip, pipPlaying = true, resumed = false, fullscreen = true)
        assertTrue(exit.dismissed)
        assertEquals("t1", exit.pauseTabId)
        assertTrue(exit.exitFullscreen)
    }

    // --- the window's tab, not the session's (Chrome's mIsPlaying follows the PiP'd WebContents alone) ---

    @Test
    fun closingWithTheXPausesTheWindowsTabWhileAnotherTabsAudioHoldsTheSession() {
        // t1's video went up playing; then a background tab's audio started and took the OS
        // controls (the core resolves the tab whose media started last). The X pauses t1 – the
        // tab the window is pinned to – and names no other: t2 plays on.
        var playing = PictureInPictureRule.pipPlaying(pip, lastKnown = false, sessionTabId = "t1", sessionPlaying = true)
        playing = PictureInPictureRule.pipPlaying(pip, lastKnown = playing, sessionTabId = "t2", sessionPlaying = true)
        assertTrue(playing)
        val exit = PictureInPictureRule.onLeft(pipTabId = pip, pipPlaying = playing, resumed = false, fullscreen = false)
        assertTrue(exit.dismissed)
        assertEquals("t1", exit.pauseTabId)
    }

    @Test
    fun closingWithTheXPausesNothingWhenTheWindowsTabPausedBeforeAnotherTabsAudioTookTheSession() {
        var playing = PictureInPictureRule.pipPlaying(pip, lastKnown = false, sessionTabId = "t1", sessionPlaying = true)
        playing = PictureInPictureRule.pipPlaying(pip, lastKnown = playing, sessionTabId = "t1", sessionPlaying = false)
        playing = PictureInPictureRule.pipPlaying(pip, lastKnown = playing, sessionTabId = "t2", sessionPlaying = true)
        assertFalse(playing)
        assertNull(PictureInPictureRule.onLeft(pipTabId = pip, pipPlaying = playing, resumed = false, fullscreen = false).pauseTabId)
    }

    @Test
    fun onlyTheWindowsTabsOwnWordMovesItsPlayingState() {
        assertTrue(PictureInPictureRule.pipPlaying(pip, lastKnown = true, sessionTabId = "t2", sessionPlaying = false))
        assertFalse(PictureInPictureRule.pipPlaying(pip, lastKnown = false, sessionTabId = "t2", sessionPlaying = true))
        // No session anywhere (a short video keeps none of its own): the last word stands.
        assertTrue(PictureInPictureRule.pipPlaying(pip, lastKnown = true, sessionTabId = null, sessionPlaying = false))
        assertFalse(PictureInPictureRule.pipPlaying(pip, lastKnown = true, sessionTabId = "t1", sessionPlaying = false))
        assertTrue(PictureInPictureRule.pipPlaying(pip, lastKnown = false, sessionTabId = "t1", sessionPlaying = true))
    }

    @Test
    fun theWindowsButtonsActOnTheWindowsTabTheNotificationsOnTheSessions() {
        assertEquals("t1", PictureInPictureRule.controlTab(shownFor = "t1", sessionTabId = "t2"))
        assertEquals("t2", PictureInPictureRule.controlTab(shownFor = null, sessionTabId = "t2"))
        assertNull(PictureInPictureRule.controlTab(shownFor = null, sessionTabId = null))
    }
}
