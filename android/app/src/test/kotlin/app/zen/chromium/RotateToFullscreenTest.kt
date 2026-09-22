package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** MED-02: rotate-to-fullscreen's rules, Chrome's for Android – the video, the device, the lock's way to "any". */
class RotateToFullscreenTest {
    @Test
    fun aVideoIsLandscapeWhenAtLeastAsWideAsTallSquaresIncluded() {
        assertEquals(true, RotateToFullscreen.videoLandscape(1920, 1080))
        assertEquals(false, RotateToFullscreen.videoLandscape(1080, 1920))
        assertEquals(true, RotateToFullscreen.videoLandscape(720, 720))
    }

    @Test
    fun aSmallOrUnknownVideoIsLeftAlone() {
        assertNull(RotateToFullscreen.videoLandscape(199, 1080))
        assertNull(RotateToFullscreen.videoLandscape(1920, 199))
        assertNull(RotateToFullscreen.videoLandscape(0, 0))
        assertEquals(true, RotateToFullscreen.videoLandscape(200, 200))
    }

    @Test
    fun aFullscreenVideoLeavesWhenTheScreenTurnsToTheOtherOrientation() {
        assertTrue(RotateToFullscreen.exitsOnTurn(videoLandscape = true, screenLandscape = false))
        assertTrue(RotateToFullscreen.exitsOnTurn(videoLandscape = false, screenLandscape = true))
        assertFalse(RotateToFullscreen.exitsOnTurn(videoLandscape = true, screenLandscape = true))
        assertFalse(RotateToFullscreen.exitsOnTurn(videoLandscape = false, screenLandscape = false))
    }

    @Test
    fun theDeviceIsReadWithinTwentyThreeDegreesOfAQuarterTurn() {
        // A phone: portrait is its natural orientation.
        assertEquals(false, RotateToFullscreen.deviceLandscape(0, naturalPortrait = true))
        assertEquals(false, RotateToFullscreen.deviceLandscape(180, naturalPortrait = true))
        assertEquals(true, RotateToFullscreen.deviceLandscape(90, naturalPortrait = true))
        assertEquals(true, RotateToFullscreen.deviceLandscape(270, naturalPortrait = true))
        assertEquals(true, RotateToFullscreen.deviceLandscape(90 + RotateToFullscreen.TOLERANCE_DEG, naturalPortrait = true))
        assertEquals(false, RotateToFullscreen.deviceLandscape(360 - RotateToFullscreen.TOLERANCE_DEG, naturalPortrait = true))
        // The diagonal zones decide nothing, so the reading cannot flicker; nor does a flat device.
        assertNull(RotateToFullscreen.deviceLandscape(45, naturalPortrait = true))
        assertNull(RotateToFullscreen.deviceLandscape(90 + RotateToFullscreen.TOLERANCE_DEG + 1, naturalPortrait = true))
        assertNull(RotateToFullscreen.deviceLandscape(-1, naturalPortrait = true))
        // A tablet whose natural orientation is landscape reads the quarter turns the other way.
        assertEquals(true, RotateToFullscreen.deviceLandscape(0, naturalPortrait = false))
        assertEquals(false, RotateToFullscreen.deviceLandscape(90, naturalPortrait = false))
    }

    @Test
    fun theLockGivesWayADelayAfterTheFirstMatchingReadingWithAutoRotateOn() {
        val unlock = RotateUnlock()
        assertFalse(unlock.watching)
        assertEquals(-1L, unlock.onDeviceAngle(90, naturalPortrait = true, autoRotate = true, now = 1_000))
        unlock.lock(landscape = true)
        assertTrue(unlock.watching)
        // Held portrait still: nothing decided.
        assertEquals(-1L, unlock.onDeviceAngle(0, naturalPortrait = true, autoRotate = true, now = 1_000))
        assertTrue(unlock.watching)
        // Turned to the video's landscape: the lock gives way the delay on.
        val at = unlock.onDeviceAngle(88, naturalPortrait = true, autoRotate = true, now = 2_000)
        assertEquals(2_000 + RotateToFullscreen.UNLOCK_DELAY_MS, at)
        assertEquals(at, unlock.unlockAt)
        assertFalse(unlock.watching)
        // Later readings change nothing (the device turned back before the delay ran included).
        assertEquals(at, unlock.onDeviceAngle(0, naturalPortrait = true, autoRotate = true, now = 2_500))
        unlock.release()
        assertEquals(-1L, unlock.unlockAt)
        assertFalse(unlock.watching)
    }

    @Test
    fun theLockNeverGivesWayWhileAutoRotateIsOff() {
        val unlock = RotateUnlock()
        unlock.lock(landscape = true)
        assertEquals(-1L, unlock.onDeviceAngle(90, naturalPortrait = true, autoRotate = false, now = 1_000))
        assertTrue(unlock.watching)
        // Auto-rotate turned on with the device still landscape: the next reading decides.
        assertEquals(1_000 + RotateToFullscreen.UNLOCK_DELAY_MS, unlock.onDeviceAngle(270, naturalPortrait = true, autoRotate = true, now = 1_000))
    }
}
