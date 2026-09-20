package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaControlsTest {
    private fun session(
        playing: Boolean = true,
        video: Boolean = false,
        actions: Set<String> = emptySet(),
        duration: Double = 300.0,
        hasPosition: Boolean = true,
        fullscreen: Boolean = false,
        private: Boolean = false,
        title: String = "Song",
        artist: String = "Band",
        position: Double = 30.0,
        playbackRate: Double = 1.0,
        positionAt: Long = 1_000_000L,
        width: Int = 0,
        height: Int = 0
    ) = MediaSessionInfo(
        tabId = "t1",
        title = title,
        artist = artist,
        album = "",
        artwork = null,
        playing = playing,
        video = video,
        width = width,
        height = height,
        duration = duration,
        position = position,
        playbackRate = playbackRate,
        hasPosition = hasPosition,
        positionAt = positionAt,
        actions = actions,
        fullscreen = fullscreen,
        private = private
    )

    // --- parsing what the core sends -------------------------------------------------------------

    @Test
    fun parsesTheCoresSession() {
        val json = JSONObject()
            .put("tabId", "tab-9")
            .put("title", "Track")
            .put("artist", "Artist")
            .put("album", "Album")
            .put("artwork", "https://a.example/cover.png")
            .put("playing", true)
            .put("video", true)
            .put("width", 1920)
            .put("height", 1080)
            .put("position", JSONObject().put("duration", 120.5).put("position", 10.0).put("playbackRate", 1.5))
            .put("positionAt", 1234L)
            .put("actions", JSONArray().put("play").put("nexttrack").put(""))
            .put("fullscreen", true)
            .put("private", false)
        val info = MediaSessionInfo.parse(json)!!
        assertEquals("tab-9", info.tabId)
        assertEquals("Track", info.title)
        assertEquals("Artist", info.artist)
        assertEquals("Album", info.album)
        assertEquals("https://a.example/cover.png", info.artwork)
        assertTrue(info.playing)
        assertTrue(info.video)
        assertEquals(1920, info.width)
        assertEquals(1080, info.height)
        assertEquals(120.5, info.duration, 0.0)
        assertEquals(10.0, info.position, 0.0)
        assertEquals(1.5, info.playbackRate, 0.0)
        assertTrue(info.hasPosition)
        assertEquals(1234L, info.positionAt)
        assertEquals(setOf("play", "nexttrack"), info.actions)
        assertTrue(info.fullscreen)
        assertFalse(info.private)
        assertTrue(info.seekable)
    }

    @Test
    fun parseNeedsATabIdAndFillsTheRestIn() {
        assertNull(MediaSessionInfo.parse(null))
        assertNull(MediaSessionInfo.parse(JSONObject().put("title", "no tab")))
        val bare = MediaSessionInfo.parse(JSONObject().put("tabId", "t"))!!
        assertEquals("", bare.title)
        assertNull(bare.artwork)
        assertFalse(bare.playing)
        assertFalse(bare.hasPosition)
        assertEquals(0.0, bare.duration, 0.0)
        assertEquals(1.0, bare.playbackRate, 0.0)
        assertTrue(bare.actions.isEmpty())
        assertFalse(bare.seekable)
        // An empty artwork string is no artwork.
        assertNull(MediaSessionInfo.parse(JSONObject().put("tabId", "t").put("artwork", ""))!!.artwork)
    }

    @Test
    fun aLiveStreamIsNotSeekable() {
        // Duration 0 (unknown) or absent: no seek bar, no seek buttons from the state alone.
        assertFalse(session(duration = 0.0).seekable)
        assertFalse(session(hasPosition = false).seekable)
        assertTrue(session(duration = 10.0).seekable)
    }

    @Test
    fun thePositionMovesOnWhilePlayingAndStopsAtTheEnd() {
        val s = session(position = 30.0, playbackRate = 2.0, positionAt = 1_000_000L, duration = 100.0)
        assertEquals(30_000L, s.positionMs(1_000_000L))
        // 5 s later at 2x: 40 s.
        assertEquals(40_000L, s.positionMs(1_005_000L))
        // Long past the end: clamped to the duration.
        assertEquals(100_000L, s.positionMs(9_000_000L))
        // A clock that went backwards moves nothing.
        assertEquals(30_000L, s.positionMs(900_000L))
        // Paused: it stands where the page said.
        assertEquals(30_000L, session(playing = false, position = 30.0).positionMs(5_000_000L))
        // No position at all: 0.
        assertEquals(0L, session(hasPosition = false).positionMs(5_000_000L))
    }

    // --- which buttons the notification carries ----------------------------------------------------

    @Test
    fun aPlayingSeekableTrackCarriesSeekButtonsAroundPause() {
        assertEquals(
            listOf(MediaControl.SEEK_BACKWARD, MediaControl.PAUSE, MediaControl.SEEK_FORWARD),
            MediaControls.controls(session(playing = true))
        )
    }

    @Test
    fun aPausedSessionCarriesPlayAndChromesDismiss() {
        assertEquals(
            listOf(MediaControl.SEEK_BACKWARD, MediaControl.PLAY, MediaControl.SEEK_FORWARD, MediaControl.STOP),
            MediaControls.controls(session(playing = false))
        )
    }

    @Test
    fun trackButtonsComeFromThePagesHandlersInChromesOrder() {
        val playing = session(playing = true, actions = setOf("previoustrack", "nexttrack"))
        assertEquals(
            listOf(MediaControl.PREVIOUS, MediaControl.SEEK_BACKWARD, MediaControl.PAUSE, MediaControl.SEEK_FORWARD, MediaControl.NEXT),
            MediaControls.controls(playing)
        )
        // Five buttons already: the paused dismiss finds no room.
        val paused = session(playing = false, actions = setOf("previoustrack", "nexttrack"))
        assertEquals(
            listOf(MediaControl.PREVIOUS, MediaControl.SEEK_BACKWARD, MediaControl.PLAY, MediaControl.SEEK_FORWARD, MediaControl.NEXT),
            MediaControls.controls(paused)
        )
        assertEquals(MediaControls.MAX_ACTIONS, MediaControls.controls(paused).size)
    }

    @Test
    fun aLiveStreamGetsSeekButtonsOnlyWhenThePageHandlesSeeking() {
        assertEquals(listOf(MediaControl.PAUSE), MediaControls.controls(session(duration = 0.0)))
        assertEquals(
            listOf(MediaControl.SEEK_BACKWARD, MediaControl.PAUSE, MediaControl.SEEK_FORWARD),
            MediaControls.controls(session(duration = 0.0, actions = setOf("seekforward")))
        )
        assertEquals(listOf(MediaControl.PLAY, MediaControl.STOP), MediaControls.controls(session(playing = false, duration = 0.0)))
    }

    @Test
    fun theCollapsedNotificationKeepsThreeAroundPlayPause() {
        // Track buttons win over the seek buttons when the page has them.
        val full = listOf(MediaControl.PREVIOUS, MediaControl.SEEK_BACKWARD, MediaControl.PAUSE, MediaControl.SEEK_FORWARD, MediaControl.NEXT)
        assertArrayEquals(intArrayOf(0, 2, 4), MediaControls.compact(full))
        // Without them the seek buttons frame play / pause.
        val seeks = listOf(MediaControl.SEEK_BACKWARD, MediaControl.PLAY, MediaControl.SEEK_FORWARD, MediaControl.STOP)
        assertArrayEquals(intArrayOf(0, 1, 2), MediaControls.compact(seeks))
        // A lone next track and pause.
        val one = listOf(MediaControl.PAUSE, MediaControl.NEXT)
        assertArrayEquals(intArrayOf(0, 1), MediaControls.compact(one))
        // Only play and dismiss: play alone in the collapsed view.
        assertArrayEquals(intArrayOf(0), MediaControls.compact(listOf(MediaControl.PLAY, MediaControl.STOP)))
        assertArrayEquals(intArrayOf(), MediaControls.compact(emptyList()))
    }

    @Test
    fun pictureInPictureShowsPlayPauseAndTheTrackButtonsOnly() {
        val s = session(playing = true, video = true, actions = setOf("previoustrack", "nexttrack"))
        assertEquals(listOf(MediaControl.PREVIOUS, MediaControl.PAUSE, MediaControl.NEXT), MediaControls.pictureInPictureControls(s))
        assertEquals(listOf(MediaControl.PLAY), MediaControls.pictureInPictureControls(session(playing = false, video = true)))
    }

    @Test
    fun aControlsPayloadNamesTheActionAndSeeksCarryTheOffset() {
        val seek = MediaControls.payload("t1", MediaControl.SEEK_FORWARD)
        assertEquals("t1", seek.getString("tabId"))
        assertEquals("seekforward", seek.getString("action"))
        assertEquals(MediaControls.SEEK_OFFSET_S, seek.getDouble("seekOffset"), 0.0)
        assertEquals(10.0, MediaControls.SEEK_OFFSET_S, 0.0)
        val pause = MediaControls.payload("t1", MediaControl.PAUSE)
        assertEquals("pause", pause.getString("action"))
        assertFalse(pause.has("seekOffset"))
        assertEquals("stop", MediaControls.payload("t1", MediaControl.STOP).getString("action"))
    }

    // --- what the notification says ----------------------------------------------------------------

    @Test
    fun theTitleIsThePagesAndTheTextTheArtist() {
        assertEquals("Song", MediaControls.title(session()))
        assertEquals("Band", MediaControls.text(session()))
        // A page with no title: the site (the artist slot) stands as the title, nothing under it.
        assertEquals("Band", MediaControls.title(session(title = "")))
        assertEquals("", MediaControls.text(session(title = "")))
    }

    @Test
    fun aPrivateTabShowsChromesStandInAndNothingElse() {
        val s = session(private = true, title = "Secret song", artist = "Secret band")
        assertEquals("A site is playing media", MediaControls.title(s))
        assertEquals("", MediaControls.text(s))
    }

    // --- picture-in-picture rules -------------------------------------------------------------------

    @Test
    fun onlyAFullscreenPlayingVideoEntersPictureInPictureOnHome() {
        assertTrue(MediaControls.autoEnterPictureInPicture(session(video = true, playing = true, fullscreen = true)))
        assertFalse(MediaControls.autoEnterPictureInPicture(session(video = true, playing = true, fullscreen = false)))
        assertFalse(MediaControls.autoEnterPictureInPicture(session(video = true, playing = false, fullscreen = true)))
        assertFalse(MediaControls.autoEnterPictureInPicture(session(video = false, playing = true, fullscreen = true)))
        assertFalse(MediaControls.autoEnterPictureInPicture(null))
    }

    @Test
    fun theAspectRatioIsTheVideosWithinAndroidsBounds() {
        assertEquals(1920 to 1080, MediaControls.aspectRatio(1920, 1080))
        assertEquals(1080 to 1920, MediaControls.aspectRatio(1080, 1920))
        // Wider than 2.39:1 or taller than 1:2.39: clamped to Android's limits.
        assertEquals(239 to 100, MediaControls.aspectRatio(4000, 1000))
        assertEquals(100 to 239, MediaControls.aspectRatio(1000, 4000))
        // No picture yet: 16:9.
        assertEquals(16 to 9, MediaControls.aspectRatio(0, 0))
        assertEquals(16 to 9, MediaControls.aspectRatio(100, 0))
    }

    @Test
    fun everyControlHasALabelAndAnAction() {
        for (control in MediaControl.values()) {
            assertTrue(control.label.isNotEmpty())
            assertTrue(control.action.isNotEmpty())
        }
        assertEquals("Dismiss", MediaControl.STOP.label)
        assertEquals("previoustrack", MediaControl.PREVIOUS.action)
    }
}
