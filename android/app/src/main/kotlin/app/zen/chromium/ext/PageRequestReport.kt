package app.zen.chromium.ext

import app.zen.chromium.blocking.HeaderStage
import app.zen.chromium.blocking.ResourceType
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.URL
import java.util.Locale

/**
 * The `webRequest` report of an EXTENSION PAGE's own subresource loads (compat round 27, R27-2).
 *
 * Chrome reports a request a popup, an options page or the worker made – the `<img>` a popup
 * draws, the worker's `fetch` – to the extension that made it, `initiator` the extension's
 * origin and `tabId` -1 (`web_request_permissions.cc`: `GetHostAccessForURL` allows a URL
 * same-origin with the extension's own, so the initiator check passes for the extension's own
 * pages and fails for every other extension's, whose origin no host permission covers;
 * `HideRequest` hides nothing of the scheme). On the phone the events are the engine's
 * decisions on a TAB's requests ([Extensions.onDecision]) and the relays of a tab's media
 * ([Extensions.onResponse]); an extension WebView's loads pass [Extensions.intercept] alone,
 * which the engine never sees – Image Downloader's worker listened on `onCompleted` for
 * `initiator === location.origin` and heard nothing. So the extension view's
 * `shouldInterceptRequest` reports them from here ([Extensions.interceptPageRequest]) while an
 * extension listens (`ext.observeRequests`):
 *
 * - the REQUEST STAGE as `ext.request` ([request]): `tabId` null (the runtime's -1),
 *   `initiator` the served origin `https://<id>.ext.zenium.invalid` – what the extension's own
 *   `location.origin` reads as on the phone, so a filter on it holds – and `type` guessed as
 *   the engine guesses a tab's (`ResourceType.guess`: the `Accept` header, then the extension),
 *   `action` allow and no rule (Chrome exempts an extension's own requests from its rules);
 * - the RESPONSE STAGE as `ext.response` while a response-stage listener exists
 *   (`ext.observeResponses`): whole and at once where the host had the answer – the file it
 *   served, the CORS proxy's reply, a refusal ([answered]: the status and the headers as
 *   re-served, a refusal's net error as `onErrorOccurred`) – and from a RELAY of the load the
 *   host would otherwise leave to WebView ([relay]), which offers no response hook of its own
 *   (`onReceivedHttpError` speaks for 4xx and 5xx alone, `onLoadResource` names the URL): the
 *   load is fetched here as the tab path's media relay fetches (`HeaderStage.relayMedia`,
 *   contract 7.3 / 7.4), the headers reported at `headers`, the body streamed to WebView
 *   through the same [HeaderStage.ObservedStream] that reports `complete` at its end and
 *   `error` when WebView closed it early. A `3xx` with a `Location` is reported at `headers` –
 *   the runtime makes `onBeforeRedirect` of it and marks the target – and followed HERE, the
 *   target's own request stage reported under a fresh id the runtime's ledger continues under
 *   the chain's (`onBeforeRequest` again, as Chrome fires it), up to [MAX_HOPS]. Without a
 *   response-stage listener nothing is relayed and WebView loads the request itself,
 *   unobserved.
 *
 * What goes out is what the view would have sent, less what Chrome does not send from an
 * extension page: the page's headers without `Referer` (none comes from `chrome-extension://`),
 * `Accept-Encoding: identity` so the `Content-Length` reported is the body served, and no
 * `Cookie` – the extension view is a third party to the site in WebView (third-party cookies
 * off), so its own load would carry none; a response's `Set-Cookie` lines stay in the report
 * (a listener's `extraHeaders` decides who sees them) and are not stored. Only a `GET` / `HEAD`
 * is relayed (the intercept has no body; a bodied request of an extension page is the CORS
 * proxy's by ticket); a `304` or a `3xx` without a target ends the relay's observation and the
 * request goes back to WebView, as a fetch that could not be made does (the report says
 * `net::ERR_CONNECTION_FAILED`; WebView's own try is not observed). The extension's own
 * document and a CORS preflight (the proxy answers it on the spot) are not reported.
 *
 * Plain JVM: the fetch comes in as a [HeaderStage.Fetcher]; what is Android comes in as values.
 */
class PageRequestReport(
    private val fetcher: HeaderStage.Fetcher = HeaderStage.HttpFetcher(CorsProxy.CONNECT_TIMEOUT_MS, CorsProxy.READ_TIMEOUT_MS)
) {
    /** The load as the intercept sees it (a `WebResourceRequest`, as values). */
    class Load(val url: String, val method: String, val isForMainFrame: Boolean, val headers: Map<String, String>) {
        fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
    }

    /** What the intercept hands WebView for a relayed load. */
    class Relayed(
        val status: Int,
        val reason: String,
        val mime: String,
        val charset: String?,
        val headers: Map<String, String>,
        val body: InputStream
    )

    /** Where the report's events go, in the order they happened: `ext.request` / `ext.response` payloads. */
    fun interface Sink {
        fun event(name: String, payload: JSONObject)
    }

    /**
     * Relay `load` for its response stage: the request stage ([request] under [requestId]) has
     * been reported already. Returns what WebView is handed, or null when WebView should load
     * the request itself – the report then said why (a fetch that could not be made, a status
     * WebView cannot carry, a `3xx` without a target, a chain past [MAX_HOPS]) or the method
     * is not one the relay performs. `nextId` names a redirect target's own request.
     */
    fun relay(
        load: Load,
        extensionOrigin: String,
        type: String,
        requestId: String,
        nextId: () -> String,
        userAgent: String?,
        sink: Sink
    ): Relayed? {
        val method = load.method.uppercase(Locale.ROOT)
        if (method != "GET" && method != "HEAD") return null
        val headers = LinkedHashMap<String, String>()
        for ((name, value) in load.headers) {
            if (name.lowercase(Locale.ROOT) in DROPPED_REQUEST_HEADERS) continue
            headers[name] = value
        }
        headers["Accept-Encoding"] = "identity"
        if (userAgent != null && headers.keys.none { it.equals("User-Agent", ignoreCase = true) }) headers["User-Agent"] = userAgent
        var url = load.url
        var id = requestId
        var hops = 0
        while (true) {
            val fetched = fetcher.fetch(url, method, headers)
            if (fetched == null) {
                sink.event(RESPONSE, response(id, url, type, method, 0, "", emptyList(), ERROR, HeaderStage.ERR_CONNECTION_FAILED))
                return null
            }
            val statusLine = HeaderStage.statusLineOf(fetched)
            val lines = HeaderStage.headerLines(fetched)
            val at = url
            val under = id
            val report = { stage: String, error: String? ->
                sink.event(RESPONSE, response(under, at, type, method, fetched.status, statusLine, lines, stage, error))
            }
            if (fetched.status < 200 || fetched.status > 599) {
                fetched.body?.close()
                report(ERROR, HeaderStage.ERR_INVALID_RESPONSE)
                return null
            }
            if (fetched.status in 300..399) {
                fetched.body?.close()
                val target = fetched.header("Location")?.let { runCatching { URL(URL(url), it).toString() }.getOrNull() }
                if (target == null) {
                    // A 304 of a conditional request the page itself made (the intercept runs
                    // ahead of the network cache, so no validator of WebView's is in the headers),
                    // or a 3xx naming no target: the response as relayed ended here (the runtime
                    // closes the request on it); the request goes back to WebView's own load.
                    report(HEADERS, null)
                    return null
                }
                if (hops >= MAX_HOPS) {
                    report(ERROR, ERR_TOO_MANY_REDIRECTS)
                    return null
                }
                report(HEADERS, null)
                hops++
                url = target
                id = nextId()
                sink.event(REQUEST, request(load, url, extensionOrigin, id, type))
                continue
            }
            report(HEADERS, null)
            val contentType = fetched.header("Content-Type") ?: "application/octet-stream"
            val mime = contentType.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
            val charset = contentType.substringAfter("charset=", "").substringBefore(';').trim().trim('"').ifEmpty { null }
            val served = LinkedHashMap<String, String>()
            for ((name, values) in fetched.headers) {
                if (name == null || values.isNullOrEmpty()) continue
                val lower = name.lowercase(Locale.ROOT)
                // WebView writes the Content-Type line itself from the mime and the charset (one
                // in the map as well comes out doubled, as the CORS proxy measured).
                if (lower == "content-type" || lower in HeaderStage.DROPPED_MEDIA_RESPONSE_HEADERS) continue
                served[name] = values.joinToString(", ")
            }
            val reason = fetched.reason.ifEmpty { HeaderStage.reasonOf(fetched.status) }
            val body = fetched.body
            if (body == null) {
                // Nothing to stream (a 204, a HEAD): the response is complete as it stands.
                report(COMPLETE, null)
                return Relayed(fetched.status, reason, mime, charset, served, ByteArrayInputStream(ByteArray(0)))
            }
            val stream = HeaderStage.ObservedStream(body, onComplete = { report(COMPLETE, null) }, onError = { report(ERROR, it) })
            return Relayed(fetched.status, reason, mime, charset, served, stream)
        }
    }

    companion object {
        const val REQUEST = "ext.request"
        const val RESPONSE = "ext.response"
        const val HEADERS = "headers"
        const val COMPLETE = "complete"
        const val ERROR = "error"
        /** Chrome's limit on a chain (`net::URLRequest::kMaxRedirects`), and its name for the chain past it. */
        const val MAX_HOPS = 20
        const val ERR_TOO_MANY_REDIRECTS = "net::ERR_TOO_MANY_REDIRECTS"

        /**
         * Request headers the relay does not forward: the media relay's (`Host`, the framing,
         * `Accept-Encoding` replaced by `identity`), the `Referer` Chrome never sends from an
         * extension page, and a `Cookie` the view would not have sent as a third party.
         */
        val DROPPED_REQUEST_HEADERS = HeaderStage.DROPPED_MEDIA_REQUEST_HEADERS + setOf("referer", "cookie")

        /**
         * Whether the load is one the report covers: a subresource of the extension's page over
         * http(s) – its own served files included – and not a CORS preflight.
         */
        fun reports(load: Load): Boolean {
            if (load.isForMainFrame) return false
            val lower = load.url.lowercase(Locale.ROOT)
            if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false
            if (load.method.equals("OPTIONS", ignoreCase = true) && load.header("Access-Control-Request-Method") != null) return false
            return true
        }

        /** The `declarativeNetRequest` type name the engine would guess for the load (`xmlhttprequest` for the ambiguous one). */
        fun typeOf(load: Load): String = ResourceType.guess(load.url, false, load.header("Accept")).dnrName

        /** The `ext.request` payload of the load at `url` (the load's own, or a redirect target's) under `requestId`. */
        fun request(load: Load, url: String, extensionOrigin: String, requestId: String, type: String): JSONObject =
            JSONObject()
                .put("tabId", JSONObject.NULL)
                .put("requestId", requestId)
                .put("url", url)
                .put("type", type)
                .put("method", load.method.uppercase(Locale.ROOT))
                .put("initiator", extensionOrigin)
                .put("mainFrame", false)
                .put("document", 0)
                .put("redirectedFrom", JSONObject.NULL)
                .put("action", "allow")
                .put("matchedSet", JSONObject.NULL)
                .put("matchedRule", JSONObject.NULL)
                .put("micros", 0)
                .put("cpuMicros", JSONObject.NULL)

        /** The `ext.response` payload of one stage ([HEADERS], [COMPLETE], [ERROR] with the `net::ERR_*` name). */
        fun response(
            requestId: String,
            url: String,
            type: String,
            method: String,
            statusCode: Int,
            statusLine: String,
            headers: List<Pair<String, String>>,
            at: String,
            error: String? = null
        ): JSONObject {
            val list = JSONArray()
            for ((name, value) in headers) list.put(JSONObject().put("name", name).put("value", value))
            val payload = JSONObject()
                .put("tabId", JSONObject.NULL)
                .put("requestId", requestId)
                .put("url", url)
                .put("type", type)
                .put("method", method)
                .put("statusCode", statusCode)
                .put("statusLine", statusLine)
                .put("responseHeaders", list)
                .put("at", at)
                .put("relayed", true)
            if (error != null) payload.put("error", error)
            return payload
        }

        /**
         * The response stage of a load the host answered itself (the extension's file served,
         * the CORS proxy's reply, a refusal), as the `ext.response` payloads in order: `headers`
         * then `complete` with the status and the headers as re-served (the content type
         * composed as WebView writes it from the mime and the charset; a proxied reply's
         * `Content-Length` is gone with its re-framing), or the one `error` of a refusal that
         * carries a net error ([NetErrorAnswer.HEADER]) – Chrome's `onErrorOccurred` for a file
         * the extension has not (`net::ERR_FILE_NOT_FOUND`) or a load it blocked.
         */
        fun answered(
            requestId: String,
            load: Load,
            type: String,
            statusCode: Int,
            reason: String?,
            headers: Map<String, String>?,
            mime: String?,
            charset: String?
        ): List<JSONObject> {
            val method = load.method.uppercase(Locale.ROOT)
            val netError = headers?.entries?.firstOrNull { it.key.equals(NetErrorAnswer.HEADER, ignoreCase = true) }?.value
            if (netError != null) return listOf(response(requestId, load.url, type, method, 0, "", emptyList(), ERROR, "net::$netError"))
            val lines = ArrayList<Pair<String, String>>()
            if (mime != null) lines.add("Content-Type" to (if (charset != null) "$mime; charset=$charset" else mime))
            headers?.forEach { (name, value) -> if (!name.equals("Content-Type", ignoreCase = true)) lines.add(name to value) }
            val phrase = reason?.ifEmpty { null } ?: HeaderStage.reasonOf(statusCode)
            val statusLine = "HTTP/1.1 $statusCode $phrase".trimEnd()
            return listOf(
                response(requestId, load.url, type, method, statusCode, statusLine, lines, HEADERS),
                response(requestId, load.url, type, method, statusCode, statusLine, lines, COMPLETE)
            )
        }
    }
}
