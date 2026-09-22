package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PageFontsTest {
    @Test
    fun `a profile that never touched the rows takes Chrome's typographic defaults`() {
        val fonts = PageFonts.fromJson(JSONObject())
        assertEquals(PageFonts.DEFAULT, fonts)
        assertEquals("serif", fonts.standardFamily)
        assertEquals("serif", fonts.serifFamily)
        assertEquals("sans-serif", fonts.sansSerifFamily)
        assertEquals("monospace", fonts.fixedFamily)
        assertEquals(16, fonts.size)
        assertEquals(13, fonts.fixedSize)
        // No floor a page can feel: WebView pins the value to 1 and up, Chrome's is 0.
        assertEquals(1, fonts.minimumFontSize)
    }

    @Test
    fun `the core's document lands field by field, null families staying the engine's`() {
        val fonts = PageFonts.fromJson(
            JSONObject(
                """{"standard":"sans-serif","serif":null,"sansSerif":"casual","fixed":"serif-monospace","size":20,"minimumSize":12}"""
            )
        )
        assertEquals("sans-serif", fonts.standard)
        assertNull(fonts.serif)
        assertEquals("serif", fonts.serifFamily)
        assertEquals("casual", fonts.sansSerifFamily)
        assertEquals("serif-monospace", fonts.fixedFamily)
        assertEquals(20, fonts.size)
        assertEquals(16, fonts.fixedSize)
        assertEquals(12, fonts.minimumSize)
        assertEquals(12, fonts.minimumFontSize)
    }

    @Test
    fun `the fixed-width size keeps Chrome's 13 for 16 as the size moves`() {
        assertEquals(13, PageFonts.fixedSizeFor(16))
        assertEquals(7, PageFonts.fixedSizeFor(9))
        assertEquals(20, PageFonts.fixedSizeFor(24))
        assertEquals(59, PageFonts.fixedSizeFor(72))
        assertEquals(1, PageFonts.fixedSizeFor(0))
    }

    @Test
    fun `a document read back from disk is held to Chrome's ranges`() {
        val fonts = PageFonts.fromJson(JSONObject("""{"size":200,"minimumSize":3,"standard":"  \"Noto Serif\"; x  "}"""))
        assertEquals(72, fonts.size)
        // 1–5 px floors are not on Chrome's slider: they round up to its first stop, as the core does.
        assertEquals(6, fonts.minimumSize)
        assertEquals("Noto Serif x", fonts.standard)
        val low = PageFonts.fromJson(JSONObject("""{"size":2,"minimumSize":90,"fixed":"   "}"""))
        assertEquals(9, low.size)
        assertEquals(24, low.minimumSize)
        assertNull(low.fixed)
    }

    @Test
    fun `the document round-trips through the file kept for a custom tab`() {
        val fonts = PageFonts("sans-serif", null, "casual", null, 18, 8)
        assertEquals(fonts, PageFonts.fromJson(JSONObject(fonts.toJson().toString())))
        val defaults = PageFonts.DEFAULT
        assertEquals(defaults, PageFonts.fromJson(JSONObject(defaults.toJson().toString())))
    }
}
