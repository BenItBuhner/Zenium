package app.zen.chromium

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Base64

/**
 * The type `Host.copyImage` names the copied file and types the clip by (PUI-38): read from the
 * bytes' header, never from a name or a declared type alone. Fixtures are each format's header
 * (the magic numbers, then filler), since the sniff reads nothing past them; the GIF and the
 * data-URL PNG are whole, minimal, decodable files.
 */
class ImageBytesTest {
    @get:Rule
    val folder = TemporaryFolder()

    private fun header(vararg bytes: Int, filler: Int = 64): ByteArray =
        ByteArray(bytes.size + filler) { i -> if (i < bytes.size) bytes[i].toByte() else 0x2A }

    private val png = header(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52)
    private val jpeg = header(0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00)
    private val jpegExif = header(0xFF, 0xD8, 0xFF, 0xE1, 0x12, 0x34, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00)
    private val gif89 = ("GIF89a".toByteArray(Charsets.US_ASCII) + byteArrayOf(0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00)).padded()
    private val gif87 = ("GIF87a".toByteArray(Charsets.US_ASCII)).padded()
    private val webp = ("RIFF".toByteArray(Charsets.US_ASCII) + byteArrayOf(0x24, 0x00, 0x00, 0x00) + "WEBPVP8 ".toByteArray(Charsets.US_ASCII)).padded()
    private val bmp = ("BM".toByteArray(Charsets.US_ASCII) + byteArrayOf(0x46, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0x36, 0, 0, 0)).padded()
    private val ico = header(0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10)
    private val avif = ftyp("avif", "avif", "mif1", "miaf", "MA1B")
    private val avifSequence = ftyp("avis", "avis", "msf1", "miaf", "MA1B")
    private val heic = ftyp("heic", "mif1", "heic")
    private val heif = ftyp("mif1", "mif1", "miaf")
    private val svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><rect width=\"8\" height=\"8\"/></svg>".toByteArray()
    private val svgWithProlog = (
        "\uFEFF<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- a comment -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" " +
            "\"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n  <svg\n xmlns=\"http://www.w3.org/2000/svg\"/>"
        ).toByteArray()
    private val html = "<!DOCTYPE html>\n<html><head><title>403 Forbidden</title></head><body>Hotlinking is not allowed</body></html>".toByteArray()

    private fun ByteArray.padded(to: Int = 64): ByteArray = this + ByteArray(maxOf(0, to - size)) { 0x2A }

    /** An ISO-BMFF `ftyp` box: size, `ftyp`, the major brand, a minor version, the compatible brands; then filler. */
    private fun ftyp(major: String, vararg compatible: String): ByteArray {
        val size = 16 + compatible.size * 4
        val box = byteArrayOf(0, 0, (size shr 8).toByte(), size.toByte()) +
            "ftyp".toByteArray(Charsets.US_ASCII) + major.toByteArray(Charsets.US_ASCII) + byteArrayOf(0, 0, 0, 0) +
            compatible.joinToString("").toByteArray(Charsets.US_ASCII)
        return box.padded(size + 32)
    }

    @Test
    fun everyTypeIsPlacedByItsSignature() {
        assertEquals(ImageBytes.PNG, ImageBytes.sniff(png))
        assertEquals(ImageBytes.JPEG, ImageBytes.sniff(jpeg))
        assertEquals(ImageBytes.JPEG, ImageBytes.sniff(jpegExif))
        assertEquals(ImageBytes.GIF, ImageBytes.sniff(gif89))
        assertEquals(ImageBytes.GIF, ImageBytes.sniff(gif87))
        assertEquals(ImageBytes.WEBP, ImageBytes.sniff(webp))
        assertEquals(ImageBytes.BMP, ImageBytes.sniff(bmp))
        assertEquals(ImageBytes.ICO, ImageBytes.sniff(ico))
        assertEquals(ImageBytes.AVIF, ImageBytes.sniff(avif))
        assertEquals(ImageBytes.AVIF, ImageBytes.sniff(avifSequence))
        assertEquals(ImageBytes.HEIC, ImageBytes.sniff(heic))
        assertEquals(ImageBytes.HEIF, ImageBytes.sniff(heif))
        assertEquals(ImageBytes.SVG, ImageBytes.sniff(svg))
        assertEquals(ImageBytes.SVG, ImageBytes.sniff(svgWithProlog))
    }

    @Test
    fun theMimeAndTheExtensionGoTogether() {
        assertEquals("image/png" to "png", ImageBytes.PNG.mime to ImageBytes.PNG.extension)
        assertEquals("image/jpeg" to "jpg", ImageBytes.JPEG.mime to ImageBytes.JPEG.extension)
        assertEquals("image/gif" to "gif", ImageBytes.GIF.mime to ImageBytes.GIF.extension)
        assertEquals("image/webp" to "webp", ImageBytes.WEBP.mime to ImageBytes.WEBP.extension)
        assertEquals("image/bmp" to "bmp", ImageBytes.BMP.mime to ImageBytes.BMP.extension)
        assertEquals("image/x-icon" to "ico", ImageBytes.ICO.mime to ImageBytes.ICO.extension)
        assertEquals("image/avif" to "avif", ImageBytes.AVIF.mime to ImageBytes.AVIF.extension)
        assertEquals("image/heic" to "heic", ImageBytes.HEIC.mime to ImageBytes.HEIC.extension)
        assertEquals("image/heif" to "heif", ImageBytes.HEIF.mime to ImageBytes.HEIF.extension)
        assertEquals("image/svg+xml" to "svg", ImageBytes.SVG.mime to ImageBytes.SVG.extension)
    }

    @Test
    fun whatIsNoImagePlacesNothing() {
        assertNull(ImageBytes.sniff(ByteArray(0)))
        assertNull(ImageBytes.sniff(byteArrayOf(0x89.toByte(), 0x50)))
        assertNull(ImageBytes.sniff(html))
        assertNull(ImageBytes.sniff("%PDF-1.7 ...".toByteArray()))
        assertNull(ImageBytes.sniff("RIFF....WAVEfmt ".toByteArray(Charsets.US_ASCII).padded()))
        // A `BM` that opens a text, not a 14-byte header, is no bitmap; an `<svgfoo>` is no SVG root.
        assertNull(ImageBytes.sniff("BM".toByteArray()))
        assertNull(ImageBytes.sniff("<svgfoo xmlns=\"x\"/>".toByteArray()))
        assertNull(ImageBytes.sniff("<!-- never closed <svg".toByteArray()))
        assertNull(ImageBytes.sniff(ftyp("mp42", "isom", "mp42")))
    }

    @Test
    fun theSniffWinsOverTheDeclaredTypeAndTheDeclaredTypeIsTheFallback() {
        // A server that says JPEG for a PNG, a data URL that says PNG for a JPEG: the bytes decide.
        assertEquals(ImageBytes.PNG, ImageBytes.decide(png, "image/jpeg"))
        assertEquals(ImageBytes.JPEG, ImageBytes.decide(jpeg, "image/png"))
        assertEquals(ImageBytes.WEBP, ImageBytes.decide(webp, "text/html; charset=utf-8"))
        // Bytes the sniff does not place keep the declared image type.
        val svgLongProlog = ("<!--" + "x".repeat(2000) + "--><svg/>").toByteArray()
        assertNull(ImageBytes.sniff(svgLongProlog))
        assertEquals(ImageBytes.SVG, ImageBytes.decide(svgLongProlog, "image/svg+xml"))
        val truncated = byteArrayOf(0xFF.toByte(), 0xD8.toByte())
        assertNull(ImageBytes.sniff(truncated))
        assertEquals(ImageBytes.JPEG, ImageBytes.decide(truncated, "image/jpeg; charset=binary"))
        // Neither names an image: nothing, for the copy to fail.
        assertNull(ImageBytes.decide(html, "text/html"))
        assertNull(ImageBytes.decide(html, null))
        assertNull(ImageBytes.decide(truncated, "application/octet-stream"))
        assertNull(ImageBytes.decide(truncated, "image/tiff"))
    }

    @Test
    fun anEmptyBodyIsNoImageWhateverItDeclares() {
        // A `data:image/jpeg;base64,` with nothing after the comma, a 200 with an image Content-Type
        // and no body: before, a 0-byte file went on the clipboard typed image/jpeg and the copy said true.
        assertNull(ImageBytes.decide(ByteArray(0), "image/jpeg"))
        assertNull(ImageBytes.decide(ByteArray(0), "image/png"))
        assertNull(ImageBytes.decide(ByteArray(0), "image/svg+xml"))
        assertNull(ImageBytes.decide(ByteArray(0), null))
        val emptyBase64 = ImageBytes.decodeDataUrl("data:image/jpeg;base64,")!!
        assertEquals(0, emptyBase64.bytes.size)
        assertEquals("image/jpeg", emptyBase64.mediaType)
        assertNull(ImageBytes.decide(emptyBase64.bytes, emptyBase64.mediaType))
        val emptyText = ImageBytes.decodeDataUrl("data:image/svg+xml,")!!
        assertEquals(0, emptyText.bytes.size)
        assertNull(ImageBytes.decide(emptyText.bytes, emptyText.mediaType))
        // Padding alone is an empty body too.
        assertNull(ImageBytes.decide(ImageBytes.decodeDataUrl("data:image/png;base64,====")!!.bytes, "image/png"))
    }

    @Test
    fun declaredTypesFoldTheirAliasesAndParameters() {
        assertEquals(ImageBytes.JPEG, ImageBytes.fromMime("image/jpg"))
        assertEquals(ImageBytes.JPEG, ImageBytes.fromMime("IMAGE/JPEG"))
        assertEquals(ImageBytes.JPEG, ImageBytes.fromMime(" image/pjpeg ; q=1"))
        assertEquals(ImageBytes.BMP, ImageBytes.fromMime("image/x-ms-bmp"))
        assertEquals(ImageBytes.ICO, ImageBytes.fromMime("image/vnd.microsoft.icon"))
        assertEquals(ImageBytes.SVG, ImageBytes.fromMime("image/svg+xml;charset=utf-8"))
        assertEquals(ImageBytes.AVIF, ImageBytes.fromMime("image/avif"))
        assertEquals(ImageBytes.HEIC, ImageBytes.fromMime("image/heic"))
        assertEquals(ImageBytes.HEIF, ImageBytes.fromMime("image/heif"))
        assertEquals(ImageBytes.WEBP, ImageBytes.fromMime("image/webp"))
        assertEquals(ImageBytes.GIF, ImageBytes.fromMime("image/gif"))
        assertEquals(ImageBytes.PNG, ImageBytes.fromMime("image/png"))
        assertNull(ImageBytes.fromMime(null))
        assertNull(ImageBytes.fromMime(""))
        assertNull(ImageBytes.fromMime("text/plain"))
        assertNull(ImageBytes.fromMime("image/"))
    }

    @Test
    fun aBase64DataUrlDecodesWithItsDeclaredType() {
        val encoded = Base64.getEncoder().encodeToString(jpeg)
        val decoded = ImageBytes.decodeDataUrl("data:image/jpeg;base64,$encoded")!!
        assertArrayEquals(jpeg, decoded.bytes)
        assertEquals("image/jpeg", decoded.mediaType)
        assertEquals(ImageBytes.JPEG, ImageBytes.decide(decoded.bytes, decoded.mediaType))
        // The media type is a declaration: a PNG that calls itself a JPEG is still a PNG.
        val lying = ImageBytes.decodeDataUrl("data:image/jpeg;base64," + Base64.getEncoder().encodeToString(png))!!
        assertEquals(ImageBytes.PNG, ImageBytes.decide(lying.bytes, lying.mediaType))
    }

    @Test
    fun dataUrlsAreReadForgivingly() {
        val encoded = Base64.getEncoder().encodeToString(png)
        // Whitespace and line breaks in the base64, the padding missing, the padding percent-encoded, no media type, a parameter before base64.
        assertArrayEquals(png, ImageBytes.decodeDataUrl("data:image/png;base64, ${encoded.chunked(8).joinToString("\n ")}")!!.bytes)
        assertArrayEquals(png, ImageBytes.decodeDataUrl("data:image/png;base64,${encoded.trimEnd('=')}")!!.bytes)
        assertArrayEquals(png, ImageBytes.decodeDataUrl("data:image/png;base64,${encoded.replace("=", "%3D")}")!!.bytes)
        val untyped = ImageBytes.decodeDataUrl("data:;base64,$encoded")!!
        assertArrayEquals(png, untyped.bytes)
        assertNull(untyped.mediaType)
        assertEquals("image/png", ImageBytes.decodeDataUrl("data:image/png;charset=binary;base64,$encoded")!!.mediaType)
        assertEquals("image/png", ImageBytes.decodeDataUrl("DATA:IMAGE/PNG;BASE64,$encoded")!!.mediaType)
    }

    @Test
    fun aPercentEncodedSvgDataUrlIsItsText() {
        val decoded = ImageBytes.decodeDataUrl("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E")!!
        assertEquals("<svg xmlns=\"http://www.w3.org/2000/svg\"/>", String(decoded.bytes, Charsets.UTF_8))
        assertEquals("image/svg+xml", decoded.mediaType)
        assertEquals(ImageBytes.SVG, ImageBytes.decide(decoded.bytes, decoded.mediaType))
        // Literal text with a `+` and a stray `%` that is no escape stays as it is; non-ASCII is UTF-8.
        assertEquals("a+b %zz é", String(ImageBytes.decodeDataUrl("data:text/plain,a+b %zz é")!!.bytes, Charsets.UTF_8))
    }

    @Test
    fun aPercentEncodedBodyKeepsACharacterPastTheBmpAndDecodesEscapesToBytes() {
        // U+1F600 is two UTF-16 surrogates; beside an escape it used to come out as `3F 3F` (each half encoded alone).
        val smile = "\uD83D\uDE00"
        assertArrayEquals(
            byteArrayOf(0x20, 0xF0.toByte(), 0x9F.toByte(), 0x98.toByte(), 0x80.toByte()),
            ImageBytes.decodeDataUrl("data:text/plain,%20$smile")!!.bytes
        )
        assertEquals("<svg>$smile é</svg>", String(ImageBytes.decodeDataUrl("data:image/svg+xml,%3Csvg%3E$smile%20é%3C/svg%3E")!!.bytes, Charsets.UTF_8))
        // An escape is the byte it spells, any byte – not a character re-encoded; a `%` short of two hex digits is literal.
        assertArrayEquals(byteArrayOf(0xFF.toByte(), 0x00, 0x41, 0x25, 0x34), ImageBytes.decodeDataUrl("data:application/octet-stream,%FF%00A%4")!!.bytes)
        assertArrayEquals(byteArrayOf(0x25, 0x7A, 0x7A, 0x25), ImageBytes.decodeDataUrl("data:text/plain,%zz%")!!.bytes)
    }

    @Test
    fun aDataUrlThatIsNoneDecodesToNothing() {
        assertNull(ImageBytes.decodeDataUrl("https://example.com/a.png"))
        assertNull(ImageBytes.decodeDataUrl("data:image/png;base64"))
        assertNull(ImageBytes.decodeDataUrl("data:image/png;base64,!!!!"))
        assertNull(ImageBytes.decodeDataUrl("data:image/png;base64,QUJDR"))
    }

    @Test
    fun theCacheKeepsItsNewestCopiesOnly() {
        val dir = folder.newFolder("clipboard")
        val files = (1..12).map { i ->
            File(dir, "image-${1_000_000L + i}.jpg").apply { writeBytes(jpeg); setLastModified(1_700_000_000_000L + i * 1000) }
        }
        val other = File(dir, "other.txt").apply { writeText("kept") }
        ImageBytes.prune(dir, keep = 8)
        val keptImages = dir.listFiles()!!.filter { it.name.startsWith("image-") }.map { it.name }.sorted()
        assertEquals(files.drop(4).map { it.name }.sorted(), keptImages)
        assertTrue(other.exists())
        assertFalse(files[0].exists())
        assertTrue(files[11].exists())
        // Under the cap nothing goes; a missing dir is nothing to do.
        ImageBytes.prune(dir, keep = 8)
        assertEquals(9, dir.listFiles()!!.size)
        ImageBytes.prune(File(dir, "missing"), keep = 8)
    }

    @Test
    fun theDefaultCapIsSmallAndPositive() {
        assertTrue(ImageBytes.CACHE_KEPT in 2..32)
    }
}
