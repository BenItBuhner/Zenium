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
}
