package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShortcutTileTest {
    /** 108 dp at 4× (xxxhdpi). */
    private val canvas = 432

    @Test
    fun maskableIconsLandTheirSafeZoneOnAndroids() {
        // 80 % of the drawn icon must equal 66/108 of the canvas.
        val share = ShortcutTile.maskableShare()
        assertEquals(66f / 108f, share * ShortcutTile.MASKABLE_SAFE_SHARE, 1e-6f)
        val rect = ShortcutTile.maskableRect(canvas, 512, 512)
        assertEquals(canvas * share, rect.width, 1e-3f)
        assertEquals(rect.width, rect.height, 1e-3f)
        // Centred, and wider than the 72 dp the launcher's mask shows, so no background peeks through it.
        assertEquals(canvas / 2f, (rect.left + rect.right) / 2f, 1e-3f)
        assertTrue(rect.width > canvas * ShortcutTile.VISIBLE_DP / ShortcutTile.CANVAS_DP)
    }

    @Test
    fun aWideMaskableIconCoversItsSquare() {
        val rect = ShortcutTile.maskableRect(canvas, 400, 200)
        val square = ShortcutTile.centred(canvas, ShortcutTile.maskableShare())
        // The short side fits the square exactly; the long side spills over on both sides equally.
        assertEquals(square.size, rect.height, 1e-3f)
        assertEquals(square.size * 2, rect.width, 1e-3f)
        assertEquals(canvas / 2f, (rect.left + rect.right) / 2f, 1e-3f)
    }

    @Test
    fun anyIconsStayInsideTheSafeZoneAtTheirOwnAspectRatio() {
        val safe = canvas * ShortcutTile.SAFE_DP / ShortcutTile.CANVAS_DP.toFloat()
        val square = ShortcutTile.anyRect(canvas, 192, 192)
        assertEquals(canvas * ShortcutTile.ANY_SHARE, square.width, 1e-3f)
        assertTrue(square.width < safe)
        assertTrue(square.left > (canvas - safe) / 2f)

        val wide = ShortcutTile.anyRect(canvas, 300, 100)
        assertEquals(canvas * ShortcutTile.ANY_SHARE, wide.width, 1e-3f)
        assertEquals(wide.width / 3f, wide.height, 1e-3f)
        assertEquals(canvas / 2f, (wide.top + wide.bottom) / 2f, 1e-3f)

        val mono = ShortcutTile.monochromeRect(canvas, 100, 100)
        assertTrue(mono.width < square.width)
    }

    @Test
    fun degenerateIconsFillTheirSquareRatherThanDivideByZero() {
        val square = ShortcutTile.centred(canvas, ShortcutTile.ANY_SHARE)
        val rect = ShortcutTile.anyRect(canvas, 0, 0)
        assertEquals(square.left, rect.left, 0f)
        assertEquals(square.size, rect.width, 1e-3f)
    }

    @Test
    fun edgeColorIsTheOpaqueBorderAverage() {
        val w = 4
        val h = 4
        val white = ShortcutTile.argb(0xFF, 0xFF, 0xFF, 0xFF)
        val red = ShortcutTile.argb(0xFF, 0xFF, 0x00, 0x00)
        // A red border around white content.
        val pixels = IntArray(w * h) { i ->
            val x = i % w
            val y = i / w
            if (x == 0 || y == 0 || x == w - 1 || y == h - 1) red else white
        }
        assertEquals(red, ShortcutTile.edgeColor(pixels, w, h))
        // One transparent corner still leaves an opaque edge (11 of the 12 border pixels, 92 %).
        pixels[0] = 0
        assertNotNull(ShortcutTile.edgeColor(pixels, w, h))
        // Two transparent border pixels (10 of 12, 83 %) mean a cut-out icon: no edge colour.
        pixels[w - 1] = 0
        assertNull(ShortcutTile.edgeColor(pixels, w, h))
        assertNull(ShortcutTile.edgeColor(IntArray(0), 0, 0))
        assertNull(ShortcutTile.edgeColor(IntArray(3), 2, 2))
    }

    @Test
    fun edgeColorAveragesMixedBorders() {
        val w = 2
        val h = 1
        val pixels = intArrayOf(ShortcutTile.argb(0xFF, 0x00, 0x00, 0x00), ShortcutTile.argb(0xFF, 0xFF, 0xFF, 0xFF))
        assertEquals(ShortcutTile.argb(0xFF, 0x7F, 0x7F, 0x7F), ShortcutTile.edgeColor(pixels, w, h))
    }

    @Test
    fun onColorIsWhiteOnDarkAndInkOnLight() {
        val white = ShortcutTile.argb(0xFF, 0xFF, 0xFF, 0xFF)
        val ink = ShortcutTile.argb(0xFF, 0x15, 0x14, 0x1A)
        assertEquals(white, ShortcutTile.onColor(ShortcutTile.argb(0xFF, 0x16, 0x16, 0x1B)))
        assertEquals(white, ShortcutTile.onColor(ShortcutTile.argb(0xFF, 0x5B, 0x6C, 0xF9)))
        // The space accent the chrome's preview tile sits on.
        assertEquals(white, ShortcutTile.onColor(ShortcutTile.argb(0xFF, 0x60, 0x6E, 0xEB)))
        assertEquals(ink, ShortcutTile.onColor(white))
        assertEquals(ink, ShortcutTile.onColor(ShortcutTile.argb(0xFF, 0xFF, 0xE0, 0x80)))
        // Mid greys fall the chrome's way (`isDarkColor`: luminance under 0.45 is dark; #adadad is 0.418).
        assertEquals(white, ShortcutTile.onColor(ShortcutTile.argb(0xFF, 0xAD, 0xAD, 0xAD)))
        assertEquals(ink, ShortcutTile.onColor(ShortcutTile.argb(0xFF, 0xB4, 0xB4, 0xB4)))
    }

    @Test
    fun letterForTakesTheFirstLetterOrDigitAsOneCodePoint() {
        assertEquals("S", ShortcutTile.letterFor("  sketch studio"))
        assertEquals("7", ShortcutTile.letterFor("7 Days"))
        assertEquals("É", ShortcutTile.letterFor("école"))
        // A leading symbol is skipped for the first letter; a symbol-only title keeps its symbol whole.
        assertEquals("Z", ShortcutTile.letterFor("→ Zenium"))
        assertEquals("\uD83D\uDE00", ShortcutTile.letterFor("\uD83D\uDE00\uD83D\uDE00"))
        assertEquals("?", ShortcutTile.letterFor("   "))
    }

    @Test
    fun parseHexTakesTheCoreColourFormats() {
        assertEquals(ShortcutTile.argb(0xFF, 0x12, 0x34, 0x56), ShortcutTile.parseHex("#123456"))
        assertEquals(ShortcutTile.argb(0xFF, 0x12, 0x34, 0x56), ShortcutTile.parseHex(" #12345680 "))
        assertEquals(ShortcutTile.argb(0xFF, 0xAA, 0xBB, 0xCC), ShortcutTile.parseHex("#abc"))
        assertNull(ShortcutTile.parseHex("rgb(1, 2, 3)"))
        assertNull(ShortcutTile.parseHex("#12"))
        assertNull(ShortcutTile.parseHex(null))
    }

    @Test
    fun canvasFollowsDensityWithAFloor() {
        assertEquals(432, ShortcutTile.canvasPx(4f))
        assertEquals(284, ShortcutTile.canvasPx(2.625f))
        assertEquals(216, ShortcutTile.canvasPx(1f))
    }
}
