package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShareTest {
    private fun bytes(vararg values: Int, pad: Int = 16): ByteArray =
        ByteArray(maxOf(pad, values.size)) { i -> if (i < values.size) values[i].toByte() else 0 }

    @Test
    fun sniffsTheCommonImageSignatures() {
        assertEquals("image/png", Share.sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))
        assertEquals("image/jpeg", Share.sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0)))
        assertEquals("image/gif", Share.sniffImageMime("GIF89a".toByteArray() + ByteArray(10)))
        assertEquals("image/webp", Share.sniffImageMime("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray(Charsets.ISO_8859_1)))
        assertEquals("image/bmp", Share.sniffImageMime("BM".toByteArray() + ByteArray(14)))
        assertEquals("image/avif", Share.sniffImageMime(bytes(0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66)))
        assertEquals("image/svg+xml", Share.sniffImageMime("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>".toByteArray()))
    }

    @Test
    fun unknownBytesAreNotAnImage() {
        assertNull(Share.sniffImageMime("<!doctype html><html></html>".toByteArray()))
        assertNull(Share.sniffImageMime(ByteArray(0)))
        assertNull(Share.sniffImageMime(bytes(0x89, 0x50)))
    }

    @Test
    fun extensionsFollowTheImageType() {
        assertEquals("jpg", Share.extensionFor("image/jpeg"))
        assertEquals("gif", Share.extensionFor("image/gif"))
        assertEquals("webp", Share.extensionFor("image/webp"))
        assertEquals("svg", Share.extensionFor("image/svg+xml"))
        assertEquals("png", Share.extensionFor("image/png"))
        assertEquals("png", Share.extensionFor("application/octet-stream"))
    }

    // --- SH-14 / SH-11: the message, a page's files -----------------------------------------------

    @Test
    fun theMessageIsTheTextThenTheLinkOnItsOwnLine() {
        // A page's `navigator.share({ text, url })`, or a selection with its link to the highlight.
        assertEquals("Look at this\nhttps://a.test/p#:~:text=Look", Share.messageBody("Look at this", "https://a.test/p#:~:text=Look"))
        // The browser's own Share… (a link alone), a selection without a link (text alone).
        assertEquals("https://a.test/", Share.messageBody(null, "https://a.test/"))
        assertEquals("just words", Share.messageBody("just words", null))
        // A page that put the link in both fields does not send it twice.
        assertEquals("https://a.test/", Share.messageBody("https://a.test/", "https://a.test/"))
        assertNull(Share.messageBody(null, null))
    }

    @Test
    fun aPagesFileNamesAreMadeSafeAndUnique() {
        val taken = HashSet<String>()
        assertEquals("photo.jpg", Share.safeFileName("photo.jpg", "image/jpeg", taken))
        // The same name again is numbered, the extension kept.
        assertEquals("photo (2).jpg", Share.safeFileName("photo.jpg", "image/jpeg", taken))
        assertEquals("photo (3).jpg", Share.safeFileName("photo.jpg", "image/jpeg", taken))
        // Path separators and control characters cannot climb out of the share folder.
        assertEquals("_.._etc_passwd", Share.safeFileName("/../etc/passwd", "text/plain", HashSet()))
        assertEquals("a_b.txt", Share.safeFileName("a\u0000b.txt", "text/plain", HashSet()))
        // No name, or a dot-name, becomes one from the type.
        assertEquals("file.png", Share.safeFileName(null, "image/png", HashSet()))
        assertEquals("file.jpg", Share.safeFileName("...", "image/jpeg", HashSet()))
        // A long name is cut, its extension kept.
        val long = Share.safeFileName("x".repeat(500) + ".webp", "image/webp", HashSet())
        assertEquals(Share.FILE_NAME_MAX, long.length)
        assertEquals(".webp", long.takeLast(5))
    }

    @Test
    fun theSheetsTypeIsTheFilesCommonOne() {
        assertEquals("image/jpeg", Share.commonMimeType(listOf("image/jpeg")))
        assertEquals("image/jpeg", Share.commonMimeType(listOf("image/jpeg", "image/jpeg")))
        assertEquals("image/*", Share.commonMimeType(listOf("image/jpeg", "image/png")))
        assertEquals("*/*", Share.commonMimeType(listOf("image/jpeg", "text/plain")))
        assertEquals("application/octet-stream", Share.commonMimeType(listOf("")))
    }
}
