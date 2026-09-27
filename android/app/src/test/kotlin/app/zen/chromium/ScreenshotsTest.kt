package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The gallery write's pure parts (`Screenshots`): the file's name, the editor's crop made sane,
 * the thumbnail's fit – and which tab a saved picture came from ([ScreenshotOrigins]).
 */
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

    // --- which tab a saved picture came from (the card's Share carries it to the sheet) ---------------

    @Test
    fun aSavedPictureRemembersItsTabUntilItIsDeleted() {
        val origins = ScreenshotOrigins()
        origins.record("content://media/external/images/media/41", "tab-1")
        origins.record("content://media/external/images/media/42", "tab-2")
        assertEquals("tab-1", origins.tabOf("content://media/external/images/media/41"))
        assertEquals("tab-2", origins.tabOf("content://media/external/images/media/42"))
        // A picture the session did not save (or one long forgotten) shares with no tab.
        assertNull(origins.tabOf("content://media/external/images/media/7"))
        // Delete on the card takes the origin with the row.
        origins.forget("content://media/external/images/media/41")
        assertNull(origins.tabOf("content://media/external/images/media/41"))
        assertEquals(1, origins.size)
        // Forgetting what was never known is nothing.
        origins.forget("content://media/external/images/media/41")
        assertEquals(1, origins.size)
    }

    @Test
    fun theOriginsKeepTheLatestFewAndDropTheOldestFirst() {
        val origins = ScreenshotOrigins(max = 3)
        for (i in 1..3) origins.record("uri-$i", "tab-$i")
        assertEquals(3, origins.size)
        origins.record("uri-4", "tab-4")
        // The oldest went; the three latest stay.
        assertEquals(3, origins.size)
        assertNull(origins.tabOf("uri-1"))
        assertEquals("tab-2", origins.tabOf("uri-2"))
        assertEquals("tab-4", origins.tabOf("uri-4"))
        // A picture recorded again is the newest, whatever its tab was: it is the last to go.
        origins.record("uri-2", "tab-9")
        origins.record("uri-5", "tab-5")
        assertNull(origins.tabOf("uri-3"))
        assertEquals("tab-9", origins.tabOf("uri-2"))
        assertEquals(3, origins.size)
        // The default cap is a session's worth of cards, not a gallery's.
        assertEquals(32, ScreenshotOrigins.MAX_ORIGINS)
    }
}
