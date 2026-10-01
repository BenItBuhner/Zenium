package app.zen.chromium

import java.io.File
import java.util.Base64

/**
 * What an image's bytes really are, for `Host.copyImage` (PUI-38, the Copy Image row, a shared
 * picture's Copy image, a capture's copy): the type is read from the BYTES by their magic
 * numbers, never from the URL's extension or a declared type alone – a page's `<img>` is
 * whatever the server sent, whatever its name says – and the copied file is named and the clip
 * typed by that. Before this every copied image was written as `.png`: the `FileProvider` typed
 * the URI `image/png` by the name, `ClipData.newUri` copied that into the clip's description,
 * and WebView's `ClipboardImpl.getPng()` – which hands a `content://` image to Blink's paste as
 * the bytes it finds when `ContentResolver.getType` says `image/png`, and decodes and
 * PNG-encodes it when it says anything else – passed a JPEG's bytes to the page as a `File`
 * `image.png` of type `image/png`. With the real type on the file and the clip, the engine
 * makes the PNG it promises, and every other reader of the clipboard gets the bytes as they
 * are with an honest type.
 *
 * The declared type (a `data:` URL's media type, a response's `Content-Type`) is the FALLBACK
 * for bytes the sniff does not place ([decide]): an SVG with a long prolog, a truncated header.
 * Bytes that are no image the sniff knows and carry no known declared image type are refused,
 * and so is an empty body whatever type it declares – the copy fails and the chrome says
 * "Could not copy image" – where before a hot-link protected server's HTML page went on the
 * clipboard as `image.png`.
 *
 * Pure (no Android class): the unit tests run the sniff over the fixtures of every type.
 */
object ImageBytes {
    /** An image type the sniff knows: its MIME type and the extension the `FileProvider` names the file by. */
    class ImageType(val mime: String, val extension: String) {
        override fun toString(): String = mime
        override fun equals(other: Any?): Boolean = other is ImageType && other.mime == mime && other.extension == extension
        override fun hashCode(): Int = mime.hashCode() * 31 + extension.hashCode()
    }

    val PNG = ImageType("image/png", "png")
    val JPEG = ImageType("image/jpeg", "jpg")
    val GIF = ImageType("image/gif", "gif")
    val WEBP = ImageType("image/webp", "webp")
    val BMP = ImageType("image/bmp", "bmp")
    val ICO = ImageType("image/x-icon", "ico")
    val AVIF = ImageType("image/avif", "avif")
    val HEIC = ImageType("image/heic", "heic")
    val HEIF = ImageType("image/heif", "heif")
    val SVG = ImageType("image/svg+xml", "svg")

    /** How far into the bytes the text sniff for an SVG's root element looks. */
    const val SVG_SNIFF_BYTES = 1024

    /** How many copied images the clipboard cache keeps ([prune]); the newest is the clip's, the rest are stale. */
    const val CACHE_KEPT = 8

    private val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    private val JPEG_SIGNATURE = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte())
    private val GIF87 = "GIF87a".toByteArray(Charsets.US_ASCII)
    private val GIF89 = "GIF89a".toByteArray(Charsets.US_ASCII)
    private val RIFF = "RIFF".toByteArray(Charsets.US_ASCII)
    private val WEBP_FORM = "WEBP".toByteArray(Charsets.US_ASCII)
    private val BMP_SIGNATURE = "BM".toByteArray(Charsets.US_ASCII)
    private val ICO_SIGNATURE = byteArrayOf(0x00, 0x00, 0x01, 0x00)
    private val FTYP = "ftyp".toByteArray(Charsets.US_ASCII)

    private val AVIF_BRANDS = setOf("avif", "avis")
    private val HEIC_BRANDS = setOf("heic", "heix", "hevc", "hevx")
    private val HEIF_BRANDS = setOf("mif1", "msf1", "heim", "heis", "hevm", "hevs")

    /**
     * The type the bytes' header says, or null when no signature the sniff knows is there (a
     * text file, an HTML page, an empty body, a format the engine does not decode). The
     * signatures are the image sniffing rules of the MIME sniffing standard plus the ISO-BMFF
     * brands (AVIF, HEIC, HEIF) and a text check for an SVG document's root element.
     */
    fun sniff(bytes: ByteArray): ImageType? {
        if (bytes.startsWith(PNG_SIGNATURE)) return PNG
        if (bytes.startsWith(JPEG_SIGNATURE)) return JPEG
        if (bytes.startsWith(GIF87) || bytes.startsWith(GIF89)) return GIF
        if (bytes.size >= 12 && bytes.startsWith(RIFF) && bytes.matchesAt(8, WEBP_FORM)) return WEBP
        if (bytes.startsWith(ICO_SIGNATURE) && bytes.size >= 6) return ICO
        isoBmff(bytes)?.let { return it }
        if (bytes.startsWith(BMP_SIGNATURE) && bytes.size >= 14) return BMP
        if (isSvgText(bytes)) return SVG
        return null
    }

    /**
     * The type for a known declared MIME type (`image/jpeg`, a `data:` URL's `image/svg+xml`,
     * a response's `Content-Type: image/webp; charset=binary` – parameters dropped, case
     * ignored, the common aliases folded: `image/jpg`, `image/pjpeg`, `image/x-ms-bmp`,
     * `image/vnd.microsoft.icon`); null for none, for a type that is no image, or for an image
     * type the engine does not decode and this sniff does not name.
     */
    fun fromMime(mime: String?): ImageType? {
        val type = mime?.substringBefore(';')?.trim()?.lowercase() ?: return null
        return when (type) {
            "image/png", "image/x-png", "image/apng" -> PNG
            "image/jpeg", "image/jpg", "image/pjpeg" -> JPEG
            "image/gif" -> GIF
            "image/webp" -> WEBP
            "image/bmp", "image/x-ms-bmp", "image/x-bmp", "image/x-windows-bmp" -> BMP
            "image/x-icon", "image/vnd.microsoft.icon", "image/ico", "image/icon" -> ICO
            "image/avif" -> AVIF
            "image/heic", "image/heic-sequence" -> HEIC
            "image/heif", "image/heif-sequence" -> HEIF
            "image/svg+xml", "image/svg" -> SVG
            else -> null
        }
    }

    /**
     * The type the copied file is named and the clip typed by: what the bytes say ([sniff])
     * first – a server's `Content-Type` and a `data:` URL's media type are often wrong, the
     * bytes never – and the declared type ([fromMime]) only when the sniff places nothing; null
     * when neither names an image, for the copy to fail. No bytes at all are no image whatever
     * they declare – a `data:image/jpeg;base64,` with nothing after the comma, a 200 with an
     * image `Content-Type` and no body – since an empty file on the clipboard typed as a
     * picture is the same lie this guards against (`Share.cacheImage` refuses the same).
     */
    fun decide(bytes: ByteArray, declared: String?): ImageType? =
        if (bytes.isEmpty()) null else sniff(bytes) ?: fromMime(declared)

    /** A `data:` URL's bytes with its declared media type (null for a URL that declares none). */
    class DataUrlBytes(val bytes: ByteArray, val mediaType: String?)

    /**
     * The bytes of a `data:` URL – `data:[<mediatype>][;base64],<data>` – decoded the way the
     * fetch standard reads one: the body percent-decoded to bytes (an escape is the byte it
     * spells, every other character its UTF-8), then forgiving-base64 decoded when `;base64` is
     * in the header (ASCII whitespace dropped, missing padding added), else those bytes as they
     * are (an `<img src="data:image/svg+xml,%3Csvg...">`); the media type is the header's first
     * part, parameters dropped. Null for a URL that is no `data:` URL, has no comma, or whose
     * base64 does not decode. An empty body decodes to no bytes; [decide] refuses those.
     */
    fun decodeDataUrl(url: String): DataUrlBytes? {
        if (!url.startsWith("data:", ignoreCase = true)) return null
        val comma = url.indexOf(',')
        if (comma < 0) return null
        val header = url.substring(5, comma)
        val params = header.split(';')
        val mediaType = params.firstOrNull()?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
        val base64 = params.drop(1).any { it.trim().equals("base64", ignoreCase = true) }
        val body = percentDecode(url.substring(comma + 1))
        val bytes = if (base64) forgivingBase64(String(body, Charsets.ISO_8859_1)) ?: return null else body
        return DataUrlBytes(bytes, mediaType)
    }

    /**
     * The clipboard cache dir kept to its newest [keep] copied images (`image-*`, by their
     * modification time, then name): the newest is the clip on the clipboard, the rest are
     * copies the clipboard has since replaced, which nothing read again. Without this every
     * copy left its file until the system cleared the app's cache. The dir itself and files of
     * other names are left alone.
     */
    fun prune(dir: File, keep: Int = CACHE_KEPT) {
        val images = dir.listFiles { f -> f.isFile && f.name.startsWith("image-") } ?: return
        images.sortedWith(compareByDescending<File> { it.lastModified() }.thenByDescending { it.name })
            .drop(keep)
            .forEach { it.delete() }
    }

    private fun ByteArray.startsWith(prefix: ByteArray): Boolean = matchesAt(0, prefix)

    private fun ByteArray.matchesAt(offset: Int, pattern: ByteArray): Boolean {
        if (size < offset + pattern.size) return false
        for (i in pattern.indices) if (this[offset + i] != pattern[i]) return false
        return true
    }

    /**
     * An ISO base media file (`ftyp` box at offset 4) by its brands: the major brand first,
     * then the compatible brands up to the box's size; AVIF before HEIC before HEIF, since an
     * AVIF lists `mif1` among its compatible brands too.
     */
    private fun isoBmff(bytes: ByteArray): ImageType? {
        if (bytes.size < 12 || !bytes.matchesAt(4, FTYP)) return null
        val boxSize = ((bytes[0].toInt() and 0xFF) shl 24) or ((bytes[1].toInt() and 0xFF) shl 16) or
            ((bytes[2].toInt() and 0xFF) shl 8) or (bytes[3].toInt() and 0xFF)
        val end = minOf(bytes.size, if (boxSize in 16..256) boxSize else 256)
        val brands = ArrayList<String>()
        brands.add(String(bytes, 8, 4, Charsets.ISO_8859_1))
        var at = 16
        while (at + 4 <= end) {
            brands.add(String(bytes, at, 4, Charsets.ISO_8859_1))
            at += 4
        }
        if (brands.any { it in AVIF_BRANDS }) return AVIF
        if (brands.any { it in HEIC_BRANDS }) return HEIC
        if (brands.any { it in HEIF_BRANDS }) return HEIF
        return null
    }

    /**
     * An SVG document's text: after a UTF-8 byte-order mark, whitespace, an XML declaration,
     * comments and a DOCTYPE, the root element `<svg` (followed by whitespace, `>`, `/` or a
     * namespace prefix's `:`), within the first [SVG_SNIFF_BYTES].
     */
    private fun isSvgText(bytes: ByteArray): Boolean {
        var start = 0
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) start = 3
        val text = String(bytes, start, minOf(bytes.size, SVG_SNIFF_BYTES) - start, Charsets.UTF_8)
        var at = 0
        while (true) {
            while (at < text.length && text[at].isWhitespace()) at++
            if (at >= text.length) return false
            when {
                text.startsWith("<?", at) -> { val close = text.indexOf("?>", at); if (close < 0) return false; at = close + 2 }
                text.startsWith("<!--", at) -> { val close = text.indexOf("-->", at); if (close < 0) return false; at = close + 3 }
                text.startsWith("<!", at) -> { val close = text.indexOf('>', at); if (close < 0) return false; at = close + 1 }
                text.startsWith("<svg", at) -> {
                    val next = text.getOrNull(at + 4) ?: return false
                    return next.isWhitespace() || next == '>' || next == '/' || next == ':'
                }
                else -> return false
            }
        }
    }

    /**
     * The percent-decoding of the URL standard, over the text's UTF-8: a `%XX` is the byte it
     * spells (any byte, `%FF` included), every other character its own UTF-8 bytes – the two
     * UTF-16 halves of a character past the BMP go through together, as the four bytes they
     * spell, not one half at a time; a `%` that opens no escape and a `+` stay as they are (a
     * URL body, not a form).
     */
    private fun percentDecode(text: String): ByteArray {
        val src = text.toByteArray(Charsets.UTF_8)
        if (text.indexOf('%') < 0) return src
        val out = java.io.ByteArrayOutputStream(src.size)
        var i = 0
        while (i < src.size) {
            val b = src[i].toInt() and 0xFF
            if (b == '%'.code && i + 2 < src.size && hex(src[i + 1]) >= 0 && hex(src[i + 2]) >= 0) {
                out.write(hex(src[i + 1]) * 16 + hex(src[i + 2]))
                i += 3
            } else {
                out.write(b)
                i++
            }
        }
        return out.toByteArray()
    }

    private fun hex(b: Byte): Int = when (val c = (b.toInt() and 0xFF).toChar()) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> -1
    }

    /**
     * The forgiving-base64 decode of the infra standard: ASCII whitespace removed, trailing
     * `=` padding dropped and re-added to a multiple of four; null for a length that cannot be
     * base64 (one char over a group) or a character outside the alphabet.
     */
    private fun forgivingBase64(text: String): ByteArray? {
        val stripped = text.filterNot { it == ' ' || it == '\t' || it == '\n' || it == '\r' || it == '\u000C' }.trimEnd('=')
        if (stripped.length % 4 == 1) return null
        val padded = stripped + "=".repeat((4 - stripped.length % 4) % 4)
        return runCatching { Base64.getDecoder().decode(padded) }.getOrNull()
    }
}
