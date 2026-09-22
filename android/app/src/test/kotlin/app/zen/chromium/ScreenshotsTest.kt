package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The gallery write's pure parts (`Screenshots`): the file's name, the editor's crop made sane, the thumbnail's fit. */
class ScreenshotsTest {
    @Test
    fun fileNamesCarryTheAppAndTheMoment() {
        val name = Screenshots.fileName(0L)
        assertTrue(name, name.startsWith("Zenium_"))
        assertTrue(name, name.endsWith(".png"))
        // yyyyMMdd-HHmmss between the two.
        assertTrue(name, Regex("Zenium_\\d{8}-\\d{6}\\.png").matches(name))
        // Two moments a second apart never share a name (the gallery would otherwise number one).
        assertTrue(Screenshots.fileName(1_000L) != Screenshots.fileName(2_000L))
    }

    @Test
    fun cropRowsKeepTheEditorsRowsWithinThePicture() {
        // The editor's first crop: the first screen of a 5000-row capture.
        assertEquals(0 until 2200, Screenshots.cropRows(0, 2200, 5000))
        // Handles dragged past the edges come back inside.
        assertEquals(0 until 5000, Screenshots.cropRows(-40, 9000, 5000))
        // A crop that names nothing (bottom above top) keeps one row rather than none or a negative height.
        assertEquals(300 until 301, Screenshots.cropRows(300, 100, 5000))
        // The last row alone.
        assertEquals(4999 until 5000, Screenshots.cropRows(4999, 5000, 5000))
        // A picture without rows never asks for any.
        assertEquals(0..0, Screenshots.cropRows(0, 10, 0))
    }

    @Test
    fun thumbnailsFitTheCardSquareWithTheRatioKept() {
        // A portrait phone viewport into the 320 square: the height rules.
        assertEquals(147 to 320, Screenshots.fitted(1080, 2340, Screenshots.THUMBNAIL_MAX_SIDE, Screenshots.THUMBNAIL_MAX_SIDE))
        // A small picture is not scaled up.
        assertEquals(200 to 100, Screenshots.fitted(200, 100, 320, 320))
        // The editor's preview: a phone's width, however tall the capture.
        assertEquals(720 to 8000, Screenshots.fitted(1440, 16000, Screenshots.PREVIEW_MAX_WIDTH, Int.MAX_VALUE))
        // Nothing to scale is one pixel, not a division by zero.
        assertEquals(1 to 1, Screenshots.fitted(0, 0, 320, 320))
    }
}
