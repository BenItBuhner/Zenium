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
        data class Fail(val reason: InterruptReason) : Continuation()
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
                range == null -> Continuation.Fail(InterruptReason.SERVER_BAD_CONTENT)
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

    // --- automatic retries -----------------------------------------------------------------------

    /** Consecutive network failures retried without telling the user (Chromium's `kMaxAutoResumeAttempts`). */
    const val MAX_AUTO_RESUMES = 5

    /**
     * Whether a failed transfer should quietly try again: only network-class failures of a
     * resumable transfer, a bounded number of times in a row, and never over a user's pause or
     * cancel. Anything else surfaces as interrupted.
     */
    fun shouldAutoResume(reason: InterruptReason, resumable: Boolean, attemptsSoFar: Int, userStopped: Boolean): Boolean =
        resumable && !userStopped && reason.isNetwork && attemptsSoFar < MAX_AUTO_RESUMES

    /** Back-off before automatic retry number [attempt] (1-based): 1 s, 2 s, 4 s, then 8 s. */
    fun autoResumeDelayMs(attempt: Int): Long = 1000L shl (attempt - 1).coerceIn(0, 3)

    // --- naming ----------------------------------------------------------------------------------

    /**
     * Key under which the page script remembers an anchor's `download` attribute
     * (`window.__zeniumDownloadNames`, see src/android/downloadNames.ts): the first 200 characters
     * of the href and its length, so multi-megabyte `data:` URLs never travel twice.
     */
    fun downloadNameKey(href: String): String = "${href.take(200)}#${href.length}"

    /** Same scheme, host and port (the `download` attribute of a cross-origin http link is ignored, as in Blink). */
    fun sameOrigin(a: String, b: String): Boolean {
        val ua = runCatching { java.net.URI(a) }.getOrNull() ?: return false
        val ub = runCatching { java.net.URI(b) }.getOrNull() ?: return false
        if (ua.scheme == null || ua.host == null || ub.scheme == null || ub.host == null) return false
        fun port(u: java.net.URI) = if (u.port >= 0) u.port else if (u.scheme.equals("https", true)) 443 else 80
        return ua.scheme.equals(ub.scheme, true) && ua.host.equals(ub.host, true) && port(ua) == port(ub)
    }

    /**
     * The file name Chromium would pick: the Content-Disposition name (RFC 6266, `filename*`
     * first), else the anchor's `download` attribute when the page remembered one, else the last
     * URL path segment; sanitised, and given an extension for its MIME type when it has none.
     */
    fun filenameFor(
        url: String,
        contentDisposition: String?,
        mimeType: String?,
        extensionFor: (String) -> String?,
        suggestedName: String? = null
    ): String {
        var name = dispositionFilename(contentDisposition)
        if (name.isNullOrEmpty() && !suggestedName.isNullOrBlank()) name = suggestedName
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

    // --- the file behind a savePath --------------------------------------------------------------

    /** Which store a persisted `savePath` names; `DownloadSink.reopen` builds the matching sink. */
    enum class SinkKind { MEDIA_STORE, DOCUMENT, FILE, NONE }

    /**
     * `content://media/…` is a MediaStore.Downloads row (this app's own on API 29+; below that the
     * public directory was used, so such a uri can only be a document another app handed over),
     * any other `content:` uri a SAF document, anything else a path on disk.
     */
    fun sinkKind(savePath: String, sdk: Int): SinkKind = when {
        savePath.isBlank() -> SinkKind.NONE
        savePath.startsWith("content://media/") && sdk >= 29 -> SinkKind.MEDIA_STORE
        savePath.startsWith("content:") -> SinkKind.DOCUMENT
        else -> SinkKind.FILE
    }

    /**
     * What `download.deleteFile` answers, from whether the file was there before the attempt and
     * after it: `missing` when there was nothing to delete (the row is marked all the same),
     * `failed` when it is still there, `deleted` otherwise. The core's `DownloadDeleteFileResult`.
     */
    fun deleteResult(existedBefore: Boolean, existsAfter: Boolean): String = when {
        !existedBefore -> "missing"
        existsAfter -> "failed"
        else -> "deleted"
    }

    // --- failures --------------------------------------------------------------------------------

    /**
     * Why a download stopped, in the core's words (`DownloadInterruptReason` in src/shared/types.ts,
     * Chromium's `download_interrupt_reasons.h` in kebab case). `wire` is what crosses the bridge
     * in `download.progress` / `download.done`; `message` is Chrome's download-bubble wording, kept
     * here so the notification and the core's row say the same thing.
     */
    enum class InterruptReason(val wire: String, val message: String) {
        NETWORK_FAILED("network-failed", "Check internet connection"),
        NETWORK_TIMEOUT("network-timeout", "Check internet connection"),
        NETWORK_DISCONNECTED("network-disconnected", "Check internet connection"),
        NETWORK_SERVER_DOWN("network-server-down", "Site wasn’t available"),
        SERVER_FAILED("server-failed", "Site wasn’t available"),
        SERVER_NO_RANGE("server-no-range", "Something went wrong"),
        SERVER_BAD_CONTENT("server-bad-content", "File wasn’t available on site"),
        SERVER_UNAUTHORIZED("server-unauthorized", "File wasn’t available on site"),
        SERVER_FORBIDDEN("server-forbidden", "File wasn’t available on site"),
        SERVER_UNREACHABLE("server-unreachable", "Site wasn’t available"),
        FILE_FAILED("file-failed", "Something went wrong"),
        FILE_ACCESS_DENIED("file-access-denied", "Needs permission to download"),
        FILE_NO_SPACE("file-no-space", "Out of storage space"),
        FILE_NAME_TOO_LONG("file-name-too-long", "File name or location is too long"),
        FILE_TOO_LARGE("file-too-large", "File is too big for this device"),
        FILE_VIRUS_INFECTED("file-virus-infected", "Virus detected"),
        FILE_BLOCKED("file-blocked", "Blocked by your organization"),
        FILE_SECURITY_CHECK_FAILED("file-security-check-failed", "Virus scan failed"),
        FILE_SAME_AS_SOURCE("file-same-as-source", "Already downloaded"),
        USER_CANCELED("user-canceled", "Cancelled"),
        USER_SHUTDOWN("user-shutdown", "Couldn’t finish download"),
        CRASH("crash", "Couldn’t finish download");

        /** Network-class failures are the ones the downloader retries on its own (`shouldAutoResume`). */
        val isNetwork: Boolean get() = wire.startsWith("network-")

        companion object {
            /** The member behind a wire name; null for anything not in the set. */
            fun fromWire(wire: String?): InterruptReason? = wire?.trim()?.let { w -> entries.firstOrNull { it.wire == w } }
        }
    }

    /**
     * What an HTTP status says about a download, the way Chromium's download core reads one
     * (`HandleSuccessfulServerResponse`): 401/407 want credentials, 403 refuses, 404 has nothing,
     * 416 cannot resume there, a 204/205 has no body to save, everything else 4xx/5xx failed.
     */
    fun serverReason(status: Int): InterruptReason = when (status) {
        204, 205, 404 -> InterruptReason.SERVER_BAD_CONTENT
        401, 407 -> InterruptReason.SERVER_UNAUTHORIZED
        403 -> InterruptReason.SERVER_FORBIDDEN
        416 -> InterruptReason.SERVER_NO_RANGE
        else -> InterruptReason.SERVER_FAILED
    }

    /**
     * The reason behind an exception out of the transfer, read the way Chromium's download core
     * reads the `net::` error the same condition raises (`ConvertNetErrorToInterruptReason`): a
     * timeout is `NETWORK_TIMEOUT`, the network being down (ENETDOWN, `ERR_INTERNET_DISCONNECTED`)
     * `NETWORK_DISCONNECTED`, a certificate or TLS failure the site not being available, and a
     * refused or reset connection, an unresolved name or an unreachable route the plain
     * `NETWORK_FAILED` Chromium leaves them at. The file side is errno text on the IOExceptions
     * the sinks throw (ENOSPC, EACCES, ENAMETOOLONG, EFBIG) and `SecurityException` for a
     * document whose permission is gone; anything else IO is the network giving up, anything else
     * at all the file side.
     */
    fun failureReason(e: Throwable): InterruptReason {
        val text = e.message.orEmpty()
        fun mentions(vararg needles: String) = needles.any { text.contains(it, ignoreCase = true) }
        return when {
            e is SocketTimeoutException -> InterruptReason.NETWORK_TIMEOUT
            e is UnknownHostException || e is ConnectException || e is java.net.NoRouteToHostException -> InterruptReason.NETWORK_FAILED
            e is javax.net.ssl.SSLException -> InterruptReason.SERVER_FAILED
            e is SecurityException -> InterruptReason.FILE_ACCESS_DENIED
            e is IOException && mentions("ENOSPC", "No space") -> InterruptReason.FILE_NO_SPACE
            e is IOException && mentions("EACCES", "EPERM", "EROFS", "Permission denied", "Read-only") -> InterruptReason.FILE_ACCESS_DENIED
            e is IOException && mentions("ENAMETOOLONG", "name too long") -> InterruptReason.FILE_NAME_TOO_LONG
            e is IOException && mentions("EFBIG", "File too large") -> InterruptReason.FILE_TOO_LARGE
            e is IOException && mentions("ENETDOWN", "Network is down") -> InterruptReason.NETWORK_DISCONNECTED
            e is java.io.FileNotFoundException -> InterruptReason.FILE_FAILED
            e is IOException -> InterruptReason.NETWORK_FAILED
            else -> InterruptReason.FILE_FAILED
        }
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
