package app.zen.chromium

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * The host side of the inline PDF viewer (`zen://pdf`; `src/shared/pdfPage.ts` writes the
 * document, `src/core/pdf.ts` decides what it shows). The WebView cannot draw a PDF, so the
 * viewer is a page over pdf.js; a `zen://` document has no origin of its own to fetch from, so
 * the tab loads the page with [ORIGIN] as its base URL (`loadDataWithBaseURL`; the address bar
 * keeps `zen://pdf`) and this answers every request to that origin from the app's assets
 * (`assets/pdf/`: the viewer's script, pdf.js's worker and data) and from the downloaded file.
 * `.invalid` never resolves: a request that escaped would fail rather than reach a network.
 *
 * The mapping from a request to a file is [requestFor] and [assetMime], the twins of
 * `pdfViewerRequestFor` / `pdfViewerAssetMime`; pure, so `PdfViewerTest` covers them.
 */
object PdfViewer {
    const val ORIGIN = "https://pdf.zenium.invalid"
    /** The base URL the viewer page loads with (a trailing slash: the origin's root document). */
    const val BASE_URL = "$ORIGIN/"
    const val ASSET_PREFIX = "/viewer/"
    const val DOCUMENT_PATH = "/document.pdf"
    /** Where the build puts the viewer's files (`vite.android.config.ts --mode pdf`). */
    const val ASSETS_DIR = "pdf"

    /** The downloaded file a viewer page shows: where it is (`savePath`) and what it is called. */
    class Document(val path: String, val name: String)

    /** A viewer page a tab shows: its `zen://pdf?id=…` address and the file behind it. */
    class Page(val url: String, val document: Document)

    sealed class Request {
        class Asset(val name: String) : Request()
        object Document : Request()
    }

    fun documentOf(json: JSONObject): Document? {
        val path = json.strOrNull("path")?.takeIf { it.isNotEmpty() } ?: return null
        return Document(path, json.str("name"))
    }

    /** Whether a URL is under the viewer's origin at all. */
    fun isViewerUrl(url: String?): Boolean = url != null && (url == ORIGIN || url.startsWith(BASE_URL))

    /**
     * Which file a request under the origin asks for: a viewer asset (one folder deep at most,
     * nothing that climbs), the document, or null for anything else (a 404).
     */
    fun requestFor(url: String): Request? {
        if (!isViewerUrl(url)) return null
        val path = url.removePrefix(ORIGIN).substringBefore('?').substringBefore('#')
        if (path == DOCUMENT_PATH) return Request.Document
        if (path.startsWith(ASSET_PREFIX)) {
            val name = path.removePrefix(ASSET_PREFIX)
            if (ASSET_NAME.matches(name)) return Request.Asset(name)
        }
        return null
    }

    fun assetMime(name: String): String = when {
        name.endsWith(".js") || name.endsWith(".mjs") -> "text/javascript"
        name.endsWith(".css") -> "text/css"
        name.endsWith(".json") -> "application/json"
        name.endsWith(".svg") -> "image/svg+xml"
        name.endsWith(".wasm") -> "application/wasm"
        name.endsWith(".ttf") -> "font/ttf"
        name.endsWith(".icc") -> "application/vnd.iccprofile"
        else -> "application/octet-stream"
    }

    /**
     * Whether a request for the document may be answered: it came from the viewer page itself
     * (its origin as the referrer), not from a web page that learned the address.
     */
    fun mayServeDocument(referrer: String?, page: Page?): Boolean = page != null && isViewerUrl(referrer)

    /**
     * The answer to a request under the origin, or null for any other request (network thread).
     * A tab showing no viewer page still answers for the assets – they are the app's own static
     * files – but never for a document.
     */
    fun intercept(context: Context, request: WebResourceRequest, page: Page?): WebResourceResponse? {
        val url = request.url.toString()
        if (!isViewerUrl(url)) return null
        return when (val what = requestFor(url)) {
            is Request.Asset -> asset(context, what.name)
            Request.Document ->
                if (mayServeDocument(request.requestHeaders?.get("Referer"), page)) document(context, page!!.document)
                else notFound()
            null -> notFound()
        }
    }

    private fun asset(context: Context, name: String): WebResourceResponse {
        val stream = runCatching { context.assets.open("$ASSETS_DIR/$name") }.getOrNull() ?: return notFound()
        return WebResourceResponse(assetMime(name), null, 200, "OK", mapOf("Cache-Control" to "no-store"), stream)
    }

    private fun document(context: Context, document: Document): WebResourceResponse {
        val opened = runCatching { openDocument(context, document.path) }.getOrNull() ?: return notFound()
        val headers = HashMap<String, String>()
        headers["Cache-Control"] = "no-store"
        if (opened.second > 0) headers["Content-Length"] = opened.second.toString()
        return WebResourceResponse("application/pdf", null, 200, "OK", headers, opened.first)
    }

    /** The file's bytes and size (-1 unknown): a MediaStore or SAF `content:` uri, a `file:` uri or a path. */
    private fun openDocument(context: Context, savePath: String): Pair<InputStream, Long>? = when {
        savePath.startsWith("content:") -> {
            val uri = Uri.parse(savePath)
            val size = runCatching { context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } }.getOrNull() ?: -1L
            context.contentResolver.openInputStream(uri)?.let { it to size }
        }
        savePath.startsWith("file:") -> Uri.parse(savePath).path?.let { openFile(File(it)) }
        else -> openFile(File(savePath))
    }

    private fun openFile(file: File): Pair<InputStream, Long>? =
        if (file.isFile) FileInputStream(file) to file.length() else null

    private fun notFound(): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private val ASSET_NAME = Regex("^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)?$")
}
