package app.zen.chromium

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.net.URI
import java.nio.charset.Charset

/**
 * Documents another app hands the browser to open – "Open with Zenium" on a downloaded page, a
 * PDF, an SVG: the manifest's `VIEW file/content` filter on `LinkDispatchActivity`, the twin of
 * the desktop's file associations (`electron-builder.yml`). The WebView is not let load a
 * `content:` or `file:` address on its own (`allowContentAccess` / `allowFileAccess` are off in
 * `TabWebView`: a page must reach neither), so the host reads the document and puts it in the
 * tab: a page or an SVG straight into the view under its own address (`TabWebView.loadUrl`), a
 * PDF through the download the viewer opens (`Downloads.Kind.CONTENT`), as Chrome's Android flow
 * does for a PDF a tab navigates to (`core/pdf.ts`).
 *
 * What a document is ([kindOf]), whether a `file:` address may be shown ([refused]) and how its
 * bytes read as text ([decode]) are pure; `LocalDocumentsTest` covers them.
 */
object LocalDocuments {
    enum class Kind(val mimeType: String) {
        HTML("text/html"),
        XHTML("application/xhtml+xml"),
        PDF("application/pdf"),
        SVG("image/svg+xml")
    }

    /** The types the manifest's filter names (`LinkDispatchActivity`), one per kind. */
    val MIME_TYPES: List<String> = Kind.values().map { it.mimeType }

    /** The most of a page or an SVG the host reads into memory to show it (a PDF streams to Downloads). */
    const val MAX_TEXT_BYTES = 32L * 1024 * 1024

    /** Whether an address names a local document at all: a `content:` or `file:` URL. */
    fun isLocal(url: String?): Boolean =
        url != null && (url.startsWith("content://", ignoreCase = true) || url.startsWith("file://", ignoreCase = true))

    /**
     * What a document is, from the type the sender or its provider named, else – no type, or a
     * generic one – from its name's extension: null for one the browser does not open.
     */
    fun kindOf(mimeType: String?, name: String?): Kind? {
        val type = mimeType?.substringBefore(';')?.trim()?.lowercase().orEmpty()
        Kind.values().firstOrNull { it.mimeType == type }?.let { return it }
        if (type.isNotEmpty() && type != "application/octet-stream" && type != "*/*") return null
        return when (extensionOf(name)) {
            "html", "htm", "shtml" -> Kind.HTML
            "xhtml", "xht" -> Kind.XHTML
            "svg" -> Kind.SVG
            "pdf" -> Kind.PDF
            else -> null
        }
    }

    /**
     * Whether a `VIEW` intent carries a document the browser opens: a local address of one of
     * the kinds, not a `file:` under the app's own directories. Anything else is not for us.
     */
    fun accepts(context: Context, intent: Intent): Boolean {
        if (intent.action != Intent.ACTION_VIEW) return false
        val uri = intent.data ?: return false
        val url = uri.toString()
        if (!isLocal(url) || refused(url, privateDirs(context))) return false
        return kindOf(intent.resolveType(context), nameOf(context.contentResolver, uri)) != null
    }

    /**
     * Whether a `file:` address is one the browser refuses to show: the app's own files (Chrome
     * refuses its data directory the same way). A `content:` address is never refused here – its
     * provider decides what the app may read.
     */
    fun refused(url: String, privateDirs: List<String>): Boolean {
        if (!url.startsWith("file://", ignoreCase = true)) return false
        val path = runCatching { URI(url).path }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return true
        val canonical = runCatching { File(path).canonicalPath }.getOrDefault(path)
        return privateDirs.any { dir -> canonical == dir || canonical.startsWith("$dir/") }
    }

    /** The directories a `file:` address may not point into: the app's private storage, internal and external. */
    fun privateDirs(context: Context): List<String> {
        val dirs = ArrayList<String>()
        fun add(file: File?) {
            file ?: return
            dirs += runCatching { file.canonicalPath }.getOrDefault(file.path)
        }
        add(File(context.applicationInfo.dataDir))
        add(context.filesDir?.parentFile)
        add(context.cacheDir)
        add(context.getExternalFilesDir(null)?.parentFile)
        add(context.externalCacheDir)
        return dirs.distinct()
    }

    /** The document's name: what its provider calls it, else the last segment of its address. */
    fun nameOf(resolver: ContentResolver, uri: Uri): String {
        if (uri.scheme.equals("content", ignoreCase = true)) {
            runCatching {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (column >= 0) cursor.getString(column)?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
                    }
                }
            }
        }
        return nameFromPath(uri.lastPathSegment)
    }

    /** The document's size in bytes, or -1 when its provider does not say (a stream). */
    fun sizeOf(resolver: ContentResolver, uri: Uri): Long =
        runCatching { resolver.openFileDescriptor(uri, "r")?.use { it.statSize } }.getOrNull()?.takeIf { it >= 0 } ?: -1L

    /** The last segment of an address as a name; "document" for one without. */
    fun nameFromPath(segment: String?): String =
        segment?.substringAfterLast('/')?.trim()?.takeIf { it.isNotEmpty() } ?: "document"

    /**
     * A page's or an SVG's bytes as the text the WebView is given (`loadDataWithBaseURL` takes a
     * string and sniffs nothing): by the byte-order mark, else the `<meta charset>` or
     * `Content-Type` meta or the XML declaration in the first kilobytes, else UTF-8.
     */
    fun decode(bytes: ByteArray): String {
        val (charset, offset) = charsetOf(bytes)
        return String(bytes, offset, bytes.size - offset, charset)
    }

    /** The charset the document declares and the bytes its mark takes up. */
    fun charsetOf(bytes: ByteArray): Pair<Charset, Int> {
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) return Charsets.UTF_8 to 3
        if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) return Charsets.UTF_16BE to 2
        if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) return Charsets.UTF_16LE to 2
        val head = String(bytes, 0, minOf(bytes.size, 4096), Charsets.ISO_8859_1)
        val declared = DECLARED_CHARSET.find(head)?.groupValues?.drop(1)?.firstOrNull { it.isNotEmpty() }
        val charset = declared?.let { runCatching { Charset.forName(it.trim()) }.getOrNull() } ?: Charsets.UTF_8
        return charset to 0
    }

    private fun extensionOf(name: String?): String {
        val base = name?.substringAfterLast('/')?.substringBefore('?')?.substringBefore('#') ?: return ""
        val dot = base.lastIndexOf('.')
        return if (dot <= 0 || dot == base.length - 1) "" else base.substring(dot + 1).lowercase()
    }

    private val DECLARED_CHARSET = Regex(
        """<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)|<\?xml[^>]+encoding\s*=\s*["']([A-Za-z0-9._:-]+)["']""",
        RegexOption.IGNORE_CASE
    )
}
