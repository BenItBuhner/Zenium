package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QrCodeLogicTest {
    // --- the code for the chrome's sheet -----------------------------------------------------------

    @Test
    fun aLinkBecomesSquareRowsOfOnesAndZerosWithTheQuietZone() {
        val code = QrCodeLogic.codeFor("https://example.com/")
        assertTrue(code.ok)
        assertNull(code.error)
        // A square of a QR size (21 + 4k modules) plus two modules of quiet zone on every side.
        val n = code.rows.size
        assertTrue("$n modules", n >= 25 && (n - 4 - 21) % 4 == 0)
        assertTrue(code.rows.all { it.length == n })
        assertTrue(code.rows.all { row -> row.all { it == '0' || it == '1' } })
        // The quiet zone is light all round.
        assertTrue(code.rows.take(2).all { it.all { c -> c == '0' } })
        assertTrue(code.rows.takeLast(2).all { it.all { c -> c == '0' } })
        assertTrue(code.rows.all { it.startsWith("00") && it.endsWith("00") })
        // The finder patterns' top edges: seven dark modules in from the quiet zone's corners.
        assertEquals("1111111", code.rows[2].substring(2, 9))
        assertEquals("1111111", code.rows[2].substring(n - 9, n - 2))
    }

    @Test
    fun theRowsAreTheMatrix() {
        val matrix = QrCodeLogic.encode("https://example.com/")
        assertNotNull(matrix)
        val rows = QrCodeLogic.rows(matrix!!)
        for (y in 0 until matrix.height) for (x in 0 until matrix.width) {
            assertEquals("($x,$y)", matrix.get(x, y), rows[y][x] == '1')
        }
    }

    @Test
    fun theSameLinkEncodesTheSameWayTwice() {
        // The sheet's code and Download's picture are two encodes of one link; they must agree.
        assertEquals(QrCodeLogic.codeFor("https://example.com/a?b=c").rows, QrCodeLogic.codeFor("https://example.com/a?b=c").rows)
    }

    @Test
    fun aLinkPastChromesLimitIsTooLongBeforeItIsEncoded() {
        val url = "https://example.com/" + "a".repeat(QrCodeLogic.MAX_URL_LENGTH)
        val code = QrCodeLogic.codeFor(url)
        assertFalse(code.ok)
        assertEquals(QrCodeLogic.ERROR_TOO_LONG, code.error)
        assertTrue(code.rows.isEmpty())
        assertEquals(2331, QrCodeLogic.MAX_URL_LENGTH)
    }

    @Test
    fun aLinkAtTheLimitStillEncodes() {
        // 2331 characters fit a version-40 code at error correction M (2331 is Chrome's limit for
        // that reason: the largest byte-mode payload at M is 2331).
        val url = "https://example.com/" + "a".repeat(QrCodeLogic.MAX_URL_LENGTH - "https://example.com/".length)
        assertEquals(QrCodeLogic.MAX_URL_LENGTH, url.length)
        val code = QrCodeLogic.codeFor(url)
        assertTrue(code.error, code.ok)
        // Version 40 is 177 modules, plus the quiet zone.
        assertEquals(181, code.rows.size)
    }

    @Test
    fun anEmptyPayloadIsRefusedByTheEncoder() {
        val code = QrCodeLogic.codeFor("")
        assertFalse(code.ok)
        assertEquals(QrCodeLogic.ERROR_FAILED, code.error)
        assertTrue(code.rows.isEmpty())
    }

    // --- the picture Download keeps ----------------------------------------------------------------

    @Test
    fun theFileIsThePrefixAndTheMillisAsAPng() {
        assertEquals("zenium_qrcode_1700000000000.png", QrCodeLogic.fileName(1_700_000_000_000L))
        assertEquals("image/png", QrCodeLogic.MIME)
    }

    @Test
    fun theCompositionIsChromesAtDensityOne() {
        // Chrome's addUrlToBitmap: 200 dp code, 50 dp sides, 70 dp above the text, 25 dp between the
        // text and the code, the same band under the code.
        val c = QrCodeLogic.composition(density = 1f, textHeightPx = 40)
        assertEquals(300, c.width)
        assertEquals((70 + 40 + 25) * 2 + 200, c.height)
        assertEquals(50, c.textLeft)
        assertEquals(70, c.textTop)
        assertEquals(200, c.textWidth)
        assertEquals(50, c.codeLeft)
        assertEquals(70 + 40 + 25, c.codeTop)
        assertEquals(200, c.codeSize)
        // The code sits centred: as much white under it as the band above.
        assertEquals(c.codeTop, c.height - (c.codeTop + c.codeSize))
    }

    @Test
    fun theCompositionScalesWithTheDensity() {
        val c = QrCodeLogic.composition(density = 2.625f, textHeightPx = 100)
        assertEquals(525, c.codeSize)
        assertEquals(131, c.sidePadding)
        assertEquals(525 + 131 * 2, c.width)
        assertEquals(184, c.textTop)
        assertEquals(184 + 100 + 66, c.codeTop)
        assertEquals((184 + 100 + 66) * 2 + 525, c.height)
    }
}
