package app.zen.chromium

import android.content.pm.ActivityInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** MED-01: which fullscreen videos turn the screen, by their natural size. */
class FullscreenOrientationTest {
    @Test
    fun aLandscapeVideoTurnsTheActivityToSensorLandscape() {
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, FullscreenOrientation.forVideo(1920, 1080))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, FullscreenOrientation.forVideo(640, 360))
        // Barely wider than tall still counts: the rule is the aspect, not a threshold.
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, FullscreenOrientation.forVideo(101, 100))
    }

    @Test
    fun aPortraitOrSquareVideoLeavesTheScreenAlone() {
        assertEquals(FullscreenOrientation.RELEASED, FullscreenOrientation.forVideo(1080, 1920))
        assertEquals(FullscreenOrientation.RELEASED, FullscreenOrientation.forVideo(720, 720))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, FullscreenOrientation.RELEASED)
    }

    @Test
    fun anUnknownSizeIsNotLandscape() {
        // No video, or one whose metadata has not arrived: the script reports again when it has.
        assertEquals(FullscreenOrientation.RELEASED, FullscreenOrientation.forVideo(0, 0))
        assertEquals(FullscreenOrientation.RELEASED, FullscreenOrientation.forVideo(1280, 0))
        assertEquals(FullscreenOrientation.RELEASED, FullscreenOrientation.forVideo(0, 720))
        assertFalse(FullscreenOrientation.isLandscape(-1, -2))
        assertTrue(FullscreenOrientation.isLandscape(2, 1))
    }
}
