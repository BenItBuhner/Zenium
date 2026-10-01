package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundVideoRuleTest {
    private fun session(
        playing: Boolean = true,
        video: Boolean = true,
        backgroundVideo: Boolean = true,
        source: String = MediaSessionInfo.SOURCE_PAGE
    ) = MediaSessionInfo(
        tabId = "t1",
        title = "Clip",
        artist = "video.example",
        album = "",
        artwork = null,
        playing = playing,
        video = video,
        width = 1280,
        height = 720,
        duration = 60.0,
        position = 5.0,
        playbackRate = 1.0,
        hasPosition = true,
        positionAt = 1_000L,
        actions = emptySet(),
        fullscreen = false,
        private = false,
        source = source,
        sourceId = if (source == MediaSessionInfo.SOURCE_CHROME) "read-aloud" else null,
        backgroundVideo = backgroundVideo
    )

    // --- what keeps playing --------------------------------------------------------------------

    @Test
    fun anAllowedSitesPlayingVideoKeepsPlaying() {
        assertTrue(BackgroundVideoRule.keepsPlaying(session()))
    }

    @Test
    fun theDefaultBlockKeepsNothing() {
        assertFalse(BackgroundVideoRule.keepsPlaying(session(backgroundVideo = false)))
    }

    @Test
    fun aPausedSessionAudioAloneAChromePlayerAndNoSessionKeepNothing() {
        // Paused: there is nothing to keep, and a held hide goes through on this word.
        assertFalse(BackgroundVideoRule.keepsPlaying(session(playing = false)))
        // Audio-only elements play hidden by the engine's own rule; no hold is needed.
        assertFalse(BackgroundVideoRule.keepsPlaying(session(video = false)))
        // A chrome player (read aloud) has no picture and plays hidden as audio does.
        assertFalse(BackgroundVideoRule.keepsPlaying(session(source = MediaSessionInfo.SOURCE_CHROME)))
        assertFalse(BackgroundVideoRule.keepsPlaying(null))
    }

    // --- the hold between the system's word and the engine's ------------------------------------

    @Test
    fun forwardsEveryChangeWhileNothingKeepsPlaying() {
        val hold = BackgroundVideoHold()
        assertEquals(false, hold.onWindow(false))
        assertFalse(hold.engineVisible)
        assertFalse(hold.holding)
        assertEquals(true, hold.onWindow(true))
        assertTrue(hold.engineVisible)
    }

    @Test
    fun holdsTheHideWhileTheVideoKeepsPlayingAndLetsTheReturnThrough() {
        val hold = BackgroundVideoHold()
        assertNull(hold.onKeep(true))
        // Home: the system says GONE, the engine hears nothing – the page stays visible and plays on.
        assertNull(hold.onWindow(false))
        assertTrue(hold.holding)
        assertTrue(hold.engineVisible)
        assertFalse(hold.windowVisible)
        // The lock screen's own hide, were one dispatched, is held the same.
        assertNull(hold.onWindow(false))
        // Back: VISIBLE goes through as it always does; the engine's word never changed, so the page hears no change.
        assertEquals(true, hold.onWindow(true))
        assertFalse(hold.holding)
        assertTrue(hold.engineVisible)
    }

    @Test
    fun aHeldHideGoesThroughTheMomentTheVideoStopsKeepingPlaying() {
        val hold = BackgroundVideoHold()
        hold.onKeep(true)
        assertNull(hold.onWindow(false))
        // The user paused it from the notification (or the clip ended): the session says no.
        assertEquals(false, hold.onKeep(false))
        assertFalse(hold.engineVisible)
        assertFalse(hold.holding)
        // Back: the page hears one change, to visible.
        assertEquals(true, hold.onWindow(true))
        assertTrue(hold.engineVisible)
    }

    @Test
    fun theWordChangingWithTheWindowOnScreenForwardsNothing() {
        val hold = BackgroundVideoHold()
        assertNull(hold.onKeep(true))
        assertNull(hold.onKeep(true))
        assertNull(hold.onKeep(false))
        assertTrue(hold.engineVisible)
        // A hide the engine already heard is not repeated when the word turns no afterwards.
        assertEquals(false, hold.onWindow(false))
        assertNull(hold.onKeep(true))
        assertNull(hold.onKeep(false))
        assertFalse(hold.engineVisible)
    }

    @Test
    fun aVideoThatStartsKeepingPlayingWhileAwayLeavesTheEngineHidden() {
        // The engine heard the hide already: turning the word to yes afterwards holds nothing back
        // (the engine's pause stands until the return, as Chrome's does).
        val hold = BackgroundVideoHold()
        assertEquals(false, hold.onWindow(false))
        assertNull(hold.onKeep(true))
        assertFalse(hold.engineVisible)
        assertFalse(hold.holding)
        assertEquals(true, hold.onWindow(true))
    }

    // --- a tab behind another tab on screen (OS-39) ---------------------------------------------

    @Test
    fun aSwitchHidesTheTabLeftBehindAndTheReturnShowsIt() {
        val hold = BackgroundVideoHold()
        // The tab host's pass: behind another tab – GONE to the engine, the page hidden as Chrome's is.
        assertEquals(false, hold.onBackground(true))
        assertTrue(hold.background)
        assertFalse(hold.engineVisible)
        assertFalse(hold.holding)
        // The pass repeating the word forwards nothing.
        assertNull(hold.onBackground(true))
        // Back on screen: VISIBLE, once.
        assertEquals(true, hold.onBackground(false))
        assertTrue(hold.engineVisible)
        assertNull(hold.onBackground(false))
    }

    @Test
    fun theSessionsAllowHoldsASwitchsHideAsItHoldsTheWindows() {
        val hold = BackgroundVideoHold()
        assertNull(hold.onKeep(true))
        // The allowed site's video plays on behind the other tab; the page hears nothing.
        assertNull(hold.onBackground(true))
        assertTrue(hold.holding)
        assertTrue(hold.engineVisible)
        // Paused from the notification while behind: the held hide goes through now.
        assertEquals(false, hold.onKeep(false))
        assertFalse(hold.engineVisible)
        // Back on screen: one change, to visible.
        assertEquals(true, hold.onBackground(false))
    }

    @Test
    fun theWindowsHideAndReturnWhileBehindForwardNothing() {
        val hold = BackgroundVideoHold()
        assertEquals(false, hold.onBackground(true))
        // Home and back with the tab still behind: the engine heard the hide and stays hidden –
        // the system's VISIBLE at the return is not the tab's.
        assertNull(hold.onWindow(false))
        assertNull(hold.onWindow(true))
        assertFalse(hold.engineVisible)
        assertEquals(true, hold.onBackground(false))
    }

    @Test
    fun aViewAttachedWhileItsTabIsBehindKeepsTheGoneItIsOwed() {
        // The replacement of a crashed view behind another tab: the system's VISIBLE at the attach
        // comes to a hold that has nothing behind yet and goes through, then the pass puts the tab
        // behind.
        val hold = BackgroundVideoHold()
        assertEquals(true, hold.onWindow(true))
        assertEquals(false, hold.onBackground(true))
        // Detached and attached again while behind (the window's GONE, then its VISIBLE): the
        // system's VISIBLE is not the tab's, and the engine keeps the GONE.
        assertNull(hold.onWindow(false))
        assertNull(hold.onWindow(true))
        assertFalse(hold.engineVisible)
    }

    @Test
    fun aSwitchWhileTheWindowIsAwayWaitsForTheReturnAndTheShow() {
        val hold = BackgroundVideoHold()
        assertEquals(false, hold.onWindow(false))
        // The core switches tabs under a hidden window (the media notification's tap): still hidden.
        assertNull(hold.onBackground(true))
        assertNull(hold.onBackground(false))
        assertFalse(hold.engineVisible)
        // The window back: the tab on screen is shown with it.
        assertEquals(true, hold.onWindow(true))
        assertTrue(hold.engineVisible)
    }

    @Test
    fun theAllowTurningOnWhileBehindUnhidesNothing() {
        val hold = BackgroundVideoHold()
        assertEquals(false, hold.onBackground(true))
        // The engine's pause stands until the tab is back, as Chrome's does.
        assertNull(hold.onKeep(true))
        assertFalse(hold.engineVisible)
        assertFalse(hold.holding)
        assertEquals(true, hold.onBackground(false))
    }

    // --- an allowed site behind another tab is visible to itself only while it plays video ------

    @Test
    fun aSilentAllowedSiteIsHiddenBehindAnotherTabLikeAnyOther() {
        // The site is allowed but nothing plays (no session, or a paused one): the session's word
        // keeps nothing, and the switch's hide goes to the engine – the page is hidden, its timers
        // throttle, as on any other site.
        val hold = BackgroundVideoHold()
        assertNull(hold.onKeep(BackgroundVideoRule.keepsPlaying(null)))
        assertEquals(false, hold.onBackground(true))
        assertFalse(hold.engineVisible)
        assertFalse(hold.holding)
        assertEquals(true, hold.onBackground(false))
        // Paused before the switch: the same.
        val paused = BackgroundVideoHold()
        assertNull(paused.onKeep(BackgroundVideoRule.keepsPlaying(session(playing = false))))
        assertEquals(false, paused.onBackground(true))
        assertFalse(paused.holding)
    }

    @Test
    fun anAllowedSitesAudioAloneTakesNoHoldBehindAnotherTab() {
        // Audio keeps playing hidden by the engine's own rule, so the allowed site playing audio
        // alone is hidden behind another tab as Chrome hides it, and its audio runs on.
        val hold = BackgroundVideoHold()
        assertNull(hold.onKeep(BackgroundVideoRule.keepsPlaying(session(video = false))))
        assertEquals(false, hold.onBackground(true))
        assertFalse(hold.holding)
    }

    @Test
    fun theVideoStoppingWhileBehindHidesTheAllowedSiteThenAndStartingAgainUnhidesNothing() {
        val hold = BackgroundVideoHold()
        // Playing video on an allowed site: the switch's hide is held, the page plays on visible to itself.
        assertNull(hold.onKeep(BackgroundVideoRule.keepsPlaying(session())))
        assertNull(hold.onBackground(true))
        assertTrue(hold.holding)
        assertTrue(hold.engineVisible)
        // The sound stops while the tab is behind (the clip ended, the site or the notification
        // paused it): the session's word turns, and the page is hidden then.
        assertEquals(false, hold.onKeep(BackgroundVideoRule.keepsPlaying(session(playing = false))))
        assertFalse(hold.engineVisible)
        assertFalse(hold.holding)
        // It starts again while still behind: a hidden page is not un-hidden for it – the engine's
        // pause stands until the tab is shown, when the one VISIBLE goes through.
        assertNull(hold.onKeep(BackgroundVideoRule.keepsPlaying(session())))
        assertFalse(hold.engineVisible)
        assertFalse(hold.holding)
        assertEquals(true, hold.onBackground(false))
        assertTrue(hold.engineVisible)
    }
}
