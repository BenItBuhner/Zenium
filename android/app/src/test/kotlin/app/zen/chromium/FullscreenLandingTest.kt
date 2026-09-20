package app.zen.chromium

import app.zen.chromium.FullscreenLanding.Window
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bars' way back from a fullscreen (MED-01, v2 §11.5), on run 4's emulator: a 411 x 914 dp
 * portrait phone with the status bar (48.57 CSS px) at the top and the navigation bar (48) at
 * the bottom; landscape is 914 x 411 with the cutout on the left and the navigation bar on the
 * right.
 */
class FullscreenLandingTest {
    private val portrait = Window(48.57, 0.0, 48.0, 0.0, 411, 914)
    /** The window as the bars hide for the fullscreen (the cutout stays), still portrait. */
    private val portraitBarsHidden = Window(48.57, 0.0, 0.0, 0.0, 411, 914)
    /** Landscape with the bars hidden, the video's own screen. */
    private val landscapeBarsHidden = Window(0.0, 0.0, 0.0, 48.57, 914, 411)
    /** Landscape with the bars shown again, before the turn back. */
    private val landscape = Window(0.0, 48.0, 0.0, 48.57, 914, 411)
    /** Portrait again, the navigation bar's frame not placed yet: run 4's first dispatch after the turn. */
    private val portraitNoNavBar = Window(48.57, 0.0, 0.0, 0.0, 411, 914)

    @Test
    fun nothingSettlesOutsideAnExit() {
        val landing = FullscreenLanding()
        assertFalse(landing.settle(portrait, 0))
        assertFalse(landing.settling)
        assertEquals(-1, landing.nextCheckAt())
        landing.onEnter(portrait)
        assertFalse(landing.settle(landscapeBarsHidden, 500))
    }

    @Test
    fun theLandscapeVideosExitSettlesWhenPortraitHasItsBarsBack() {
        val landing = FullscreenLanding()
        landing.onEnter(portrait)
        landing.onExit(1_000)
        assertTrue(landing.settling)
        // The exit's own word, with the fullscreen's insets still in hand.
        assertTrue(landing.settle(landscapeBarsHidden, 1_000))
        // The bars shown in landscape: another screen than the fullscreen began on, so the quiet runs.
        assertTrue(landing.settle(landscape, 1_100))
        assertEquals(1_100 + FullscreenLanding.QUIET_MS, landing.nextCheckAt())
        // The turn back: the first dispatch has no navigation bar yet. Its screen is the one
        // the fullscreen began on, so the bars are bound to come back: no quiet applies.
        assertTrue(landing.settle(portraitNoNavBar, 1_400))
        assertEquals(1_000 + FullscreenLanding.SAME_SCREEN_DEADLINE_MS, landing.nextCheckAt())
        // A second later (the emulator's pace) the same window is still settling.
        assertTrue(landing.settle(portraitNoNavBar, 2_400))
        // The navigation bar's frame arrives: the window is the one from before.
        assertFalse(landing.settle(portrait, 2_500))
        assertFalse(landing.settling)
        assertEquals(-1, landing.nextCheckAt())
        // Over: the next word is the next exit's.
        assertFalse(landing.settle(portraitNoNavBar, 2_600))
    }

    @Test
    fun aPortraitVideosExitSettlesOnTheFirstWordWithTheBars() {
        val landing = FullscreenLanding()
        landing.onEnter(portrait)
        landing.onExit(1_000)
        assertTrue(landing.settle(portraitBarsHidden, 1_000))
        assertFalse(landing.settle(portrait, 1_050))
    }

    @Test
    fun anImmersiveWindowWhoseBarsStayHiddenSettlesAtOnce() {
        // Zen's own fullscreen (F11's kind) had the bars hidden before the video's fullscreen
        // and keeps them hidden after: the exit's first word is already the window from before.
        val landing = FullscreenLanding()
        landing.onEnter(portraitBarsHidden)
        landing.onExit(1_000)
        assertFalse(landing.settle(portraitBarsHidden, 1_000))
    }

    @Test
    fun aScreenTheUserTurnedMeanwhileSettlesOnceQuiet() {
        // The phone held landscape with rotation on: the system keeps landscape after the
        // exit, and the old portrait insets never come back.
        val landing = FullscreenLanding()
        landing.onEnter(portrait)
        landing.onExit(1_000)
        assertTrue(landing.settle(landscapeBarsHidden, 1_000))
        assertTrue(landing.settle(landscape, 1_200))
        assertEquals(1_700, landing.nextCheckAt())
        assertTrue(landing.settle(landscape, 1_600))
        assertFalse(landing.settle(landscape, 1_700))
        assertFalse(landing.settling)
    }

    @Test
    fun aChangeRestartsTheQuiet() {
        val landing = FullscreenLanding()
        landing.onEnter(portrait)
        landing.onExit(1_000)
        assertTrue(landing.settle(landscapeBarsHidden, 1_000))
        assertTrue(landing.settle(landscape, 1_400))
        // At the quiet's end the window has changed again: the quiet starts over from the change.
        assertTrue(landing.settle(Window(0.0, 48.0, 0.0, 48.57, 900, 411), 1_900))
        assertEquals(1_900 + FullscreenLanding.QUIET_MS, landing.nextCheckAt())
        assertTrue(landing.settle(Window(0.0, 48.0, 0.0, 48.57, 900, 411), 2_300))
        assertFalse(landing.settle(Window(0.0, 48.0, 0.0, 48.57, 900, 411), 2_400))
    }

    @Test
    fun theFullscreensOwnScreenGivesUpOnlyAtTheDeadline() {
        val landing = FullscreenLanding()
        landing.onEnter(portrait)
        landing.onExit(1_000)
        assertTrue(landing.settle(portraitNoNavBar, 1_000))
        assertTrue(landing.settle(portraitNoNavBar, 1_000 + FullscreenLanding.SAME_SCREEN_DEADLINE_MS - 1))
        assertFalse(landing.settle(portraitNoNavBar, 1_000 + FullscreenLanding.SAME_SCREEN_DEADLINE_MS))
    }

    @Test
    fun aFullscreenEnteredAgainWhileSettlingKeepsTheWindowFromBeforeTheFirst() {
        // Home during fullscreen (#223's picture-in-picture) ends it; the window expanding back
        // and the tab going fullscreen again find the bars hidden: not the window to come back to.
        val landing = FullscreenLanding()
        landing.onEnter(portrait)
        landing.onExit(1_000)
        assertTrue(landing.settle(landscapeBarsHidden, 1_000))
        landing.onEnter(landscapeBarsHidden)
        assertFalse(landing.settling)
        assertFalse(landing.settle(landscape, 1_100))
        landing.onExit(2_000)
        assertTrue(landing.settle(portraitNoNavBar, 2_000))
        assertFalse(landing.settle(portrait, 2_100))
    }

    @Test
    fun anExitWithoutAnEntrySettlesNothing() {
        val landing = FullscreenLanding()
        landing.onExit(1_000)
        assertFalse(landing.settling)
        assertFalse(landing.settle(portraitNoNavBar, 1_000))
    }
}
