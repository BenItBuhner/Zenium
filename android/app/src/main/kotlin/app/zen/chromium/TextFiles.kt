package app.zen.chromium

import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * The text-file picker's rules (`dialog.openText`, the core's `DialogHost.pickTextFiles`): which
 * document types a request's extensions ask the provider for, and how much of a picked document
 * is read. CSS mods and password CSVs stay under the historical 512 KB; a bookmarks HTML with its
 * favicons inline (Chrome's export) runs to tens of megabytes, so the core lifts the cap per
 * request with `maxBytes`, never past [HARD_CAP_BYTES]. A document over its cap is left out of the
 * answer rather than read into memory whole; the desktop host does the same.
 */
object TextFiles {
    const val DEFAULT_CAP_BYTES = 512L * 1024
    const val HARD_CAP_BYTES = 64L * 1024 * 1024

    /** The MIME types `ACTION_OPEN_DOCUMENT` filters by for these extensions; every type when none is known. */
    fun mimeTypesFor(extensions: List<String>): Array<String> {
        val mimes = extensions.flatMap { extension ->
            when (extension.lowercase()) {
                "css" -> listOf("text/css")
                "json" -> listOf("application/json")
                "txt" -> listOf("text/plain")
                "html", "htm" -> listOf("text/html")
                // Password exports: providers label CSV either way (some as plain text).
                "csv" -> listOf("text/csv", "text/comma-separated-values", "text/plain")
                else -> emptyList()
            }
        }.distinct()
        return (if (mimes.isEmpty()) listOf("*/*") else mimes).toTypedArray()
    }

    /** The byte cap for one request: the default, or the request's own, never over the hard cap. */
    fun capFor(maxBytes: Double?): Long {
        if (maxBytes == null || maxBytes.isNaN() || maxBytes <= 0.0) return DEFAULT_CAP_BYTES
        return minOf(maxBytes.toLong(), HARD_CAP_BYTES)
    }

    /**
     * The stream as UTF-8 text, or null once it runs past [cap] bytes (the read stops there). A
     * UTF-8 byte order mark is dropped, as a text editor would.
     */
    fun readCapped(stream: InputStream, cap: Long): String? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = stream.read(buffer)
            if (read == -1) break
            total += read
            if (total > cap) return null
            out.write(buffer, 0, read)
        }
        val bytes = out.toByteArray()
        val start = if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) 3 else 0
        return String(bytes, start, bytes.size - start, Charsets.UTF_8)
    }
}
