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
}
