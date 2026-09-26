package app.zen.chromium.ext

import app.zen.chromium.PageFonts
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `chrome.fontSettings`' layer as `ext.fonts.apply` carries it and as a tab lays it over the user's
 * page fonts (compat round 20, the WebView fontSettings bridge).
 */
class ExtensionFontLayerTest {
    @Test
    fun `the core's payload is read, the families cleaned, the sizes rounded and held to what WebView takes`() {
        val layer = ExtensionFontLayer.fromJson(
            JSONObject(
                """{"standard":" Noto  Serif ","serif":null,"sansSerif":"Roboto<script>","fixed":"Droid Sans Mono",
                   "cursive":"Dancing Script","fantasy":null,"size":20.4,"fixedSize":200,"minimumSize":0,
                   "css":"@layer zen-ext-fonts {}","script":"(() => {})()"}"""
            )
        )
        assertEquals("Noto Serif", layer.standard)
        assertNull(layer.serif)
        assertEquals("Robotoscript", layer.sansSerif)
        assertEquals("Droid Sans Mono", layer.fixed)
        assertEquals("Dancing Script", layer.cursive)
        assertNull(layer.fantasy)
        assertEquals(20, layer.size)
        assertEquals(PageFonts.SIZE_MAX, layer.fixedSize)
        assertEquals(0, layer.minimumSize)
        assertEquals("@layer zen-ext-fonts {}", layer.css)
        assertEquals("(() => {})()", layer.script)
        assertFalse(layer.isEmpty)

        // A missing key, a null and a blank family are all "not held"; a size below its floor is lifted to it.
        val sparse = ExtensionFontLayer.fromJson(JSONObject("""{"standard":"  ","size":null,"fixedSize":0}"""))
        assertNull(sparse.standard)
        assertNull(sparse.size)
        assertEquals(1, sparse.fixedSize)
        assertEquals("", sparse.css)
        assertEquals("", sparse.script)
        assertFalse(sparse.isEmpty)

        val empty = ExtensionFontLayer.fromJson(JSONObject("{}"))
        assertTrue(empty.isEmpty)
        assertEquals(ExtensionFontLayer.EMPTY, empty)
        // The script alone (the empty layer's take-the-sheet-out script) does not make a layer.
        assertTrue(ExtensionFontLayer.EMPTY.copy(script = "(() => {})()").isEmpty)
        assertFalse(ExtensionFontLayer.EMPTY.copy(css = "@layer zen-ext-fonts { math { font-family: X; } }").isEmpty)
    }

    @Test
    fun `the layer over the user's document takes the held values and leaves the user's for the rest`() {
        val user = PageFonts("sans-serif", null, "casual", null, 18, 8)
        assertSame(user, ExtensionFontLayer.EMPTY.over(user))

        val held = ExtensionFontLayer.EMPTY.copy(standard = "Noto Serif", fixed = "Droid Sans Mono", size = 24, cursive = "Dancing Script", fixedSize = 15)
        val laid = held.over(user)
        assertEquals("Noto Serif", laid.standard)
        assertNull(laid.serif)
        assertEquals("casual", laid.sansSerif)
        assertEquals("Droid Sans Mono", laid.fixed)
        assertEquals(24, laid.size)
        assertEquals(8, laid.minimumSize)
        assertEquals("Dancing Script", laid.cursiveFamily)
        assertEquals(PageFonts.DEFAULT_FANTASY, laid.fantasyFamily)
        // An extension's fixed size stands in for the size's companion; without one the ratio does.
        assertEquals(15, laid.fixedSize)
        assertEquals(PageFonts.fixedSizeFor(24), held.copy(fixedSize = null).over(user).fixedSize)
        // The user's document is untouched, and what it persists has no room for the layer's extras.
        assertEquals(PageFonts("sans-serif", null, "casual", null, 18, 8), user)
        assertFalse(laid.toJson().has("cursive"))
        assertFalse(laid.toJson().has("fixedSizeOverride"))
        assertEquals(user, PageFonts.fromJson(JSONObject(user.toJson().toString())))
    }

    @Test
    fun `the log line names what is held`() {
        assertEquals("none", ExtensionFontLayer.EMPTY.summary())
        val css = "@layer zen-ext-fonts { math { font-family: X; } }"
        val layer = ExtensionFontLayer.EMPTY.copy(standard = "Noto Serif", size = 20, css = css)
        assertEquals("standard=Noto Serif size=20px stylesheet ${css.length} chars", layer.summary())
    }
}
