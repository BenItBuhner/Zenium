package app.zen.chromium

import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.net.UnknownHostException
import java.util.Base64
import java.util.Locale

/**
 * The decisions of the Zenium downloader that need no Android: how a Range response continues a
 * partial file, what a download is called, what a `data:` URL holds, and how a failure is named
 * for the core. `Downloads` drives the transfers with these; the JUnit tests pin them down.
 */
object DownloadLogic {
    /** In-flight files on the public directory (API 26–28) end in this, like Chrome's `.crdownload`. */
    const val PARTIAL_SUFFIX = ".zeniumdownload"

    // --- resuming --------------------------------------------------------------------------------

    /** `Content-Range: bytes 100-999/1000` → start 100, end 999, total 1000 (`*` → -1). */
    data class ContentRange(val start: Long, val end: Long, val total: Long)

    fun parseContentRange(header: String?): ContentRange? {
        val m = CONTENT_RANGE.matchEntire(header?.trim() ?: return null) ?: return null
        val (range, totalText) = m.destructured
        val total = if (totalText == "*") -1L else totalText.toLongOrNull() ?: return null
        if (range == "*") return ContentRange(-1, -1, total)
        val dash = range.indexOf('-')
        val start = range.substring(0, dash).toLongOrNull() ?: return null
        val end = range.substring(dash + 1).toLongOrNull() ?: return null
        return ContentRange(start, end, total)
    }

    /** What to do with the response to a Range request for the bytes from `offset` on. */
    sealed class Continuation {
        /** 206 with the range we asked for: append to the partial file. */
        object Append : Continuation()
        /** The server ignored the range (200) or the file changed: start over from zero. */
        object Restart : Continuation()
        /** 416 whose `Content-Range` total (`bytes star/N`) matches what is on disk: nothing left to fetch. */
        object AlreadyComplete : Continuation()
        data class Fail(val reason: String) : Continuation()
    }

    /**
     * Chromium's rules (download_item_impl.cc): a 206 must start exactly at the offset we asked
     * for, a 200 to a range request means the server does not do ranges (or the validator did
     * not match) so the partial file is worthless, a 416 is only fine when the file is already
     * whole, and anything else is the server refusing.
     */
    fun continuation(status: Int, contentRange: String?, offset: Long, knownTotal: Long): Continuation = when {
        offset <= 0 && status in 200..299 -> Continuation.Restart
        status == 206 -> {
            val range = parseContentRange(contentRange)
            when {
                range == null -> Continuation.Fail("server-bad-content")
                range.start != offset -> Continuation.Restart
                knownTotal > 0 && range.total > 0 && range.total != knownTotal -> Continuation.Restart
                else -> Continuation.Append
            }
        }
        status in 200..299 -> Continuation.Restart
        status == 416 -> {
            val total = parseContentRange(contentRange)?.total ?: -1L
            if (total > 0 && total == offset) Continuation.AlreadyComplete else Continuation.Restart
        }
        else -> Continuation.Fail(serverReason(status))
    }

    /**
     * Whether a paused or interrupted transfer can continue where it stopped. Chromium wants a
     * validator (a strong ETag or a Last-Modified date) so `If-Range` can catch a changed file;
     * `Accept-Ranges: bytes` alone is enough to try, the 200 path above restarts when it goes wrong.
     */
    fun canResume(acceptRanges: String?, etag: String?, lastModified: String?): Boolean {
        if (acceptRanges?.trim()?.equals("none", ignoreCase = true) == true) return false
        if (acceptRanges?.trim()?.equals("bytes", ignoreCase = true) == true) return true
        return !strongValidator(etag, lastModified).isNullOrEmpty()
    }

    /** The `If-Range` value: a strong ETag, else the Last-Modified date; weak ETags are not allowed there. */
    fun strongValidator(etag: String?, lastModified: String?): String? {
        val tag = etag?.trim().orEmpty()
        if (tag.isNotEmpty() && !tag.startsWith("W/", ignoreCase = true)) return tag
        val date = lastModified?.trim().orEmpty()
        return date.ifEmpty { null }
    }

    // --- naming ----------------------------------------------------------------------------------

    /**
     * The file name for a download, in Chromium's order: the `Content-Disposition` header
     * (`filename*` first, then `filename`), the last path segment of the URL, then `download`.
     * A name without an extension gets one from the MIME type (`extensionFor`), and every name is
     * made safe for a file system.
     */
    fun filenameFor(url: String, contentDisposition: String?, mimeType: String?, extensionFor: (String) -> String?): String {
        var name = dispositionFilename(contentDisposition)
        if (name.isNullOrEmpty() && (url.startsWith("http:") || url.startsWith("https:") || url.startsWith("ftp:"))) {
            name = urlFilename(url)
        }
        var safe = sanitizeFilename(name ?: "")
        if (safe.isEmpty() || safe == "download" || !safe.contains('.')) {
            val ext = mimeType?.let { extensionFor(mimeBase(it)) }
            if (safe.isEmpty()) safe = "download"
            if (!ext.isNullOrEmpty() && !safe.lowercase(Locale.ROOT).endsWith(".$ext")) safe = "$safe.$ext"
        }
        return safe
    }

    /** `attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf; filename="fallback.pdf"` → `résumé.pdf`. */
    fun dispositionFilename(header: String?): String? {
        if (header.isNullOrBlank()) return null
        var plain: String? = null
        for (raw in splitParameters(header)) {
            val eq = raw.indexOf('=')
            if (eq <= 0) continue
            val key = raw.substring(0, eq).trim().lowercase(Locale.ROOT)
            val value = raw.substring(eq + 1).trim()
            when (key) {
                "filename*" -> decodeExtValue(value)?.let { return it }
                "filename" -> plain = unquote(value)
            }
        }
        return plain?.takeIf { it.isNotEmpty() }
    }

    private fun splitParameters(header: String): List<String> {
        val parts = ArrayList<String>()
        val current = StringBuilder()
        var quoted = false
        var i = 0
        while (i < header.length) {
            val c = header[i]
            when {
                c == '"' -> { quoted = !quoted; current.append(c) }
                c == '\\' && quoted && i + 1 < header.length -> { current.append(c).append(header[i + 1]); i++ }
                c == ';' && !quoted -> { parts.add(current.toString()); current.setLength(0) }
                else -> current.append(c)
            }
            i++
        }
        parts.add(current.toString())
        return parts
    }

    private fun unquote(value: String): String {
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
            return value.substring(1, value.length - 1).replace(Regex("\\\\(.)"), "$1")
        }
        return value
    }

    /** RFC 8187 `charset'language'percent-encoded`. */
    private fun decodeExtValue(value: String): String? {
        val first = value.indexOf('\'')
        val second = if (first >= 0) value.indexOf('\'', first + 1) else -1
        if (first < 0 || second < 0) return null
        val charset = value.substring(0, first).ifEmpty { "UTF-8" }
        val encoded = value.substring(second + 1)
        return runCatching { URLDecoder.decode(encoded.replace("+", "%2B"), charset) }.getOrNull()?.takeIf { it.isNotEmpty() }
    }

    private fun urlFilename(url: String): String? {
        val noFragment = url.substringBefore('#')
        val noQuery = noFragment.substringBefore('?')
        val afterScheme = noQuery.substringAfter("://", "")
        val path = afterScheme.substringAfter('/', "")
        val last = path.substringAfterLast('/')
        if (last.isEmpty()) return null
        return runCatching { URLDecoder.decode(last.replace("+", "%2B"), "UTF-8") }.getOrDefault(last)
    }

    /**
     * Characters no file system takes, control characters and path tricks become `_`; a leading
     * dot would hide the file; Windows reserved device names get a suffix; 200 characters is
     * comfortably under every limit and leaves room for ` (12)` and the partial suffix.
     */
    fun sanitizeFilename(name: String): String {
        var s = name.replace(Regex("\\p{Cntrl}"), "").trim().replace(Regex("[\\\\/:*?\"<>|]"), "_")
        s = s.replace(Regex("\\s+"), " ").trim().trimEnd('.', ' ')
        s = s.trimStart('.')
        if (s.isEmpty()) return ""
        val stem = s.substringBeforeLast('.', s)
        if (stem.uppercase(Locale.ROOT) in RESERVED_NAMES) s = "${stem}_${s.substring(stem.length)}"
        if (s.length > 200) {
            val ext = extensionOf(s)
            val keep = if (ext.isEmpty()) 200 else (200 - ext.length - 1).coerceAtLeast(1)
            s = s.substring(0, keep).trimEnd('.', ' ') + (if (ext.isEmpty()) "" else ".$ext")
        }
        return s
    }

    /** `report.pdf` → `pdf`; `archive.tar.gz` → `gz`; no extension → `""`. */
    fun extensionOf(name: String): String {
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return ""
        val ext = name.substring(dot + 1)
        return if (ext.length <= 10 && ext.all { it.isLetterOrDigit() }) ext else ""
    }

    /** `file.txt` → `file (1).txt`, `file (2).txt`, … until `taken` says no (Chrome and Android style). */
    fun uniqueName(name: String, taken: (String) -> Boolean): String {
        if (!taken(name)) return name
        val ext = extensionOf(name)
        val stem = if (ext.isEmpty()) name else name.substring(0, name.length - ext.length - 1)
        var n = 1
        while (true) {
            val candidate = if (ext.isEmpty()) "$stem ($n)" else "$stem ($n).$ext"
            if (!taken(candidate)) return candidate
            n++
        }
    }

    /** `text/html; charset=utf-8` → `text/html`. */
    fun mimeBase(contentType: String): String = contentType.substringBefore(';').trim().lowercase(Locale.ROOT)

    /** A small table for when the platform's map has nothing; the runtime asks `MimeTypeMap` first. */
    fun fallbackExtension(mimeType: String): String? = FALLBACK_EXTENSIONS[mimeBase(mimeType)]

    // --- data: URLs ------------------------------------------------------------------------------

    data class DataUrl(val mimeType: String, val bytes: ByteArray)

    /** `data:[<mediatype>][;base64],<data>`; the media type defaults to `text/plain` as the RFC says. */
    fun parseDataUrl(url: String): DataUrl? {
        if (!url.startsWith("data:", ignoreCase = true)) return null
        val comma = url.indexOf(',')
        if (comma < 0) return null
        val header = url.substring(5, comma)
        val payload = url.substring(comma + 1)
        val params = header.split(';').map { it.trim() }
        val base64 = params.any { it.equals("base64", ignoreCase = true) }
        val mime = params.firstOrNull()?.takeIf { it.contains('/') }?.lowercase(Locale.ROOT) ?: "text/plain"
        val bytes = runCatching {
            if (base64) {
                Base64.getMimeDecoder().decode(payload.replace(Regex("\\s"), "").replace('-', '+').replace('_', '/').let(::padBase64))
            } else {
                percentDecode(payload)
            }
        }.getOrNull() ?: return null
        return DataUrl(mime, bytes)
    }

    private fun padBase64(s: String): String = if (s.length % 4 == 0) s else s + "=".repeat(4 - s.length % 4)

    private fun percentDecode(s: String): ByteArray {
        val out = java.io.ByteArrayOutputStream(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%' && i + 2 < s.length) {
                val hex = s.substring(i + 1, i + 3)
                val v = hex.toIntOrNull(16)
                if (v != null) {
                    out.write(v)
                    i += 3
                    continue
                }
            }
            val encoded = c.toString().toByteArray(Charsets.UTF_8)
            out.write(encoded, 0, encoded.size)
            i++
        }
        return out.toByteArray()
    }

    // --- failures --------------------------------------------------------------------------------

    /** Chromium's interrupt reasons, in the short form the core and the panel understand. */
    fun serverReason(status: Int): String = when (status) {
        401 -> "server-unauthorized"
        403 -> "server-forbidden"
        404, 410 -> "server-bad-content"
        416 -> "server-no-range"
        in 500..599 -> "server-failed"
        else -> "server-failed"
    }

    fun failureReason(e: Throwable): String = when {
        e is UnknownHostException -> "network-disconnected"
        e is SocketTimeoutException -> "network-timeout"
        e is ConnectException -> "network-failed"
        e is IOException && (e.message?.contains("ENOSPC") == true || e.message?.contains("No space", ignoreCase = true) == true) -> "file-no-space"
        e is IOException && (e.message?.contains("EACCES") == true || e.message?.contains("Permission denied", ignoreCase = true) == true) -> "file-access-denied"
        e is java.io.FileNotFoundException -> "file-failed"
        e is IOException -> "network-failed"
        else -> "file-failed"
    }

    private val CONTENT_RANGE = Regex("bytes\\s+(\\*|\\d+-\\d+)/(\\*|\\d+)", RegexOption.IGNORE_CASE)

    private val RESERVED_NAMES = setOf(
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    )

    private val FALLBACK_EXTENSIONS = mapOf(
        "text/plain" to "txt", "text/html" to "html", "text/css" to "css", "text/csv" to "csv",
        "text/javascript" to "js", "application/javascript" to "js", "application/json" to "json",
        "application/pdf" to "pdf", "application/zip" to "zip", "application/gzip" to "gz",
        "application/x-tar" to "tar", "application/octet-stream" to "bin", "application/xml" to "xml",
        "application/vnd.android.package-archive" to "apk", "application/msword" to "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to "docx",
        "application/vnd.ms-excel" to "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to "xlsx",
        "image/png" to "png", "image/jpeg" to "jpg", "image/gif" to "gif", "image/webp" to "webp",
        "image/svg+xml" to "svg", "image/bmp" to "bmp", "image/avif" to "avif",
        "audio/mpeg" to "mp3", "audio/ogg" to "ogg", "audio/wav" to "wav", "audio/webm" to "weba",
        "video/mp4" to "mp4", "video/webm" to "webm", "video/quicktime" to "mov"
    )
}
