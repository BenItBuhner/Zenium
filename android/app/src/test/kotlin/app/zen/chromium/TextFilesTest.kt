package app.zen.chromium

import java.io.ByteArrayInputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TextFilesTest {
    @Test
    fun asksTheProviderForTheDocumentTypesOfTheExtensions() {
        assertArrayEquals(arrayOf("text/html"), TextFiles.mimeTypesFor(listOf("html", "htm")))
        assertArrayEquals(
            arrayOf("text/csv", "text/comma-separated-values", "text/plain"),
            TextFiles.mimeTypesFor(listOf("csv", "txt"))
        )
        assertArrayEquals(arrayOf("text/css"), TextFiles.mimeTypesFor(listOf("CSS")))
        assertArrayEquals(arrayOf("*/*"), TextFiles.mimeTypesFor(emptyList()))
        assertArrayEquals(arrayOf("*/*"), TextFiles.mimeTypesFor(listOf("xyz")))
    }

    @Test
    fun keepsTheHistoricalCapUnlessTheRequestLiftsIt() {
        assertEquals(512L * 1024, TextFiles.capFor(null))
        assertEquals(512L * 1024, TextFiles.capFor(0.0))
        assertEquals(512L * 1024, TextFiles.capFor(Double.NaN))
        assertEquals(8L * 1024 * 1024, TextFiles.capFor(8.0 * 1024 * 1024))
        // A bookmarks HTML may ask for a lot, never past the hard cap.
        assertEquals(TextFiles.HARD_CAP_BYTES, TextFiles.capFor(1e12))
    }

    @Test
    fun readsADocumentUpToTheCapAndLeavesOutOneThatRunsPast() {
        val html = "<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF=\"https://zenium.app/\">Zenium</A></DL>"
        assertEquals(html, TextFiles.readCapped(ByteArrayInputStream(html.toByteArray()), 1024))
        assertEquals(html, TextFiles.readCapped(ByteArrayInputStream(html.toByteArray()), html.length.toLong()))
        assertNull(TextFiles.readCapped(ByteArrayInputStream(html.toByteArray()), html.length.toLong() - 1))
        // 3 MB of favicons under a lifted cap, over the default one.
        val big = ByteArray(3 * 1024 * 1024) { 'x'.code.toByte() }
        assertEquals(big.size, TextFiles.readCapped(ByteArrayInputStream(big), TextFiles.capFor(4.0 * 1024 * 1024))!!.length)
        assertNull(TextFiles.readCapped(ByteArrayInputStream(big), TextFiles.capFor(null)))
    }

    @Test
    fun dropsAByteOrderMarkAndKeepsUtf8Text() {
        val csv = "name,url,username,password\nZenium,https://zenium.app/,bénnett,pässword\n"
        val withBom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + csv.toByteArray(Charsets.UTF_8)
        assertEquals(csv, TextFiles.readCapped(ByteArrayInputStream(withBom), 1024))
        assertEquals("", TextFiles.readCapped(ByteArrayInputStream(ByteArray(0)), 1024))
    }
}
