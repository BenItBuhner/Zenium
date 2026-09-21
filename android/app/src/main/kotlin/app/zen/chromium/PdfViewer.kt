package app.zen.chromium

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import app.zen.chromium.blocking.Domains
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * The host side of the inline PDF viewer (`zen://pdf`; `src/shared/pdfPage.ts` writes the
 * document, `src/core/pdf.ts` decides what it shows). The WebView cannot draw a PDF, so the
 * viewer is a page over pdf.js. The tab loads the page with `loadDataWithBaseURL` (the address
 * bar keeps `zen://pdf`) under the PDF's own URL as its base, so the document runs where
 * Chrome's PDF viewer presents its tab – `location.href` is the PDF's address, an extension's
 * content script matching it runs in the document, the tab reads as that URL to `tabs` and
 * `webNavigation` – or, for a PDF with no http(s) address to stand under, under [ORIGIN].
 * Whichever the document runs under, its files come from [ORIGIN]: this answers every request
 * to that origin from the app's assets (`assets/pdf/`: the viewer's script, pdf.js's worker and
 * data) and from the downloaded file, with the CORS headers a document of another origin needs
 * to read them. `.invalid` never resolves: a request that escaped would fail rather than reach
 * a network.
 *
 * The mapping from a request to a file is [requestFor] and [assetMime], the twins of
 * `pdfViewerRequestFor` / `pdfViewerAssetMime`; pure, so `PdfViewerTest` covers them.
 */
object PdfViewer {
    const val ORIGIN = "https://pdf.zenium.invalid"
    /** The base URL of a viewer page whose document has no address of its own (a trailing slash: the origin's root document). */
    const val BASE_URL = "$ORIGIN/"
    const val ASSET_PREFIX = "/viewer/"
    const val DOCUMENT_PATH = "/document.pdf"
    /** Where the build puts the viewer's files (`vite.android.config.ts --mode pdf`). */
    const val ASSETS_DIR = "pdf"

    /** The downloaded file a viewer page shows: where it is (`savePath`) and what it is called. */
    class Document(val path: String, val name: String)

    /**
     * A viewer page a tab shows: its `zen://pdf?id=…` address, the base URL its document runs
     * under (`pdfViewerBaseUrl`: the PDF's own http(s) URL, else [BASE_URL]) and the file behind it.
     */
    class Page(val url: String, val baseUrl: String, val document: Document)

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

    /** The origin a page's document runs under: the PDF's own, or [ORIGIN] for a document without one. */
    fun documentOrigin(page: Page): String = Domains.originOf(page.baseUrl) ?: ORIGIN

    /**
     * Whether a URL a navigation callback reports is the page's own document: WebView reports a
     * `loadDataWithBaseURL` document under its base URL (the PDF's address, or the viewer's
     * origin), and may report anything under the viewer's origin for one that runs there.
     */
    fun isDocumentUrl(url: String?, page: Page): Boolean =
        url != null && (url == page.baseUrl || url.substringBefore('#') == page.baseUrl || isViewerUrl(url))

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
     * Whether a request for the document may be answered: it came from the viewer page's own
     * document – the `Origin` its cross-origin fetch declares, or the referrer of a same-origin
     * one, is the origin the document runs under – not from a web page that learned the address.
     * (A request from another tab never gets here with this tab's page.)
     */
    fun mayServeDocument(origin: String?, referrer: String?, page: Page?): Boolean {
        if (page == null) return false
        val allowed = documentOrigin(page)
        if (origin != null) return origin == allowed
        return referrer != null && (referrer == allowed || referrer.startsWith("$allowed/"))
    }

    /**
     * The answer to a request under the origin, or null for any other request (network thread).
     * A tab showing no viewer page still answers for the assets – they are the app's own static
     * files, readable from any origin – but never for a document, which only the page's own
     * origin may read (the CORS answer names it).
     */
    fun intercept(context: Context, request: WebResourceRequest, page: Page?): WebResourceResponse? {
        val url = request.url.toString()
        if (!isViewerUrl(url)) return null
        val headers = request.requestHeaders
        return when (val what = requestFor(url)) {
            is Request.Asset -> asset(context, what.name)
            Request.Document ->
                if (mayServeDocument(headers?.get("Origin"), headers?.get("Referer"), page)) document(context, page!!)
                else notFound()
            null -> notFound()
        }
    }

    private fun asset(context: Context, name: String): WebResourceResponse {
        val stream = runCatching { context.assets.open("$ASSETS_DIR/$name") }.getOrNull() ?: return notFound()
        val headers = mapOf("Cache-Control" to "no-store", "Access-Control-Allow-Origin" to "*")
        return WebResourceResponse(assetMime(name), null, 200, "OK", headers, stream)
    }

    private fun document(context: Context, page: Page): WebResourceResponse {
        val opened = runCatching { openDocument(context, page.document.path) }.getOrNull() ?: return notFound()
        val headers = HashMap<String, String>()
        headers["Cache-Control"] = "no-store"
        headers["Access-Control-Allow-Origin"] = documentOrigin(page)
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
