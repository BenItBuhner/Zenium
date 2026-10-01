package app.zen.chromium.ext

import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/**
 * Cross-origin `fetch` / XHR from an extension context to a host its `host_permissions` cover.
 * Chrome lets those through without CORS; the WebView runs extension pages on the emulated
 * `https://<id>.ext.zenium.invalid` origin and applies CORS to every response, the intercepted
 * ones included, so the proxy answers in `shouldInterceptRequest`: it performs the request
 * itself over `HttpURLConnection` with the headers the page sent (the `Origin` rewritten to
 * `chrome-extension://<id>`, as Chrome sends it; no `Referer`, as Chrome sends none for an
 * extension page) and re-serves the response with the CORS headers the WebView wants to see
 * for that origin. A CORS preflight (`OPTIONS` with `Access-Control-Request-Method`) is answered
 * on the spot.
 *
 * `shouldInterceptRequest` never sees a request body, so the page bootstrap sends the body of a
 * `POST` / `PUT` / `PATCH` over the bridge first, under a ticket it then names in the
 * [PROXY_HEADER] of the request ([putBody] / [takeBody]); the interceptor waits briefly for a body
 * that is still in flight. Credentials follow the fetch: the bootstrap marks `credentials:
 * "include"` and `withCredentials` requests with [CREDENTIALS_HEADER], and only those carry the
 * WebView's cookies for the URL and keep the `Set-Cookie` the response brings. The WebView drops
 * the `Set-Cookie` of an intercepted response; one with `COOKIE_INTERCEPT` (Chromium 137+) stores
 * the lines handed to it as the response's cookies ([Reply.cookies], which the caller passes on
 * through `WebResourceResponseCompat.setCookies`), an older one leaves it to the jar ([Cookies.store]).
 *
 * The same request engine serves a CONTENT SCRIPT's cross-origin `fetch` the page's
 * Content-Security-Policy refused ([Framing.contentScript], `Extensions.extensionProxyFetch`):
 * there the request is performed as the page's own CORS request – its `Origin` and `Referer`
 * the page's – and the server's answer is returned as it came, CORS headers and all, for the
 * world to judge as Chrome's renderer does (`extensionCorsRelay.ts`).
 *
 * Plain JVM: the unit tests run it against a local server. What is Android (the cookie jar, the
 * WebView response object, the user agent) comes in through [Cookies] and the caller.
 */
class CorsProxy(private val cookies: Cookies, private val userAgent: () -> String?) {
    interface Cookies {
        /**
         * Whether the WebView stores the cookies of an intercepted response itself when they are
         * handed over as such (`WebViewFeature.COOKIE_INTERCEPT`); when false the proxy writes
         * them into the jar through [store].
         */
        val intercepts: Boolean
        /** The `Cookie` header value for `url`, or null when the jar has nothing for it. */
        fun header(url: String): String?
        /** Store one `Set-Cookie` value the response to `url` carried. */
        fun store(url: String, setCookie: String)
    }

    /** What the interceptor sees: method, URL and the headers the page sent (no body). */
    class Request(val method: String, val url: String, val headers: Map<String, String>) {
        fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, true) }?.value
    }

    class Reply(
        val status: Int,
        val reason: String,
        val mime: String,
        val charset: String?,
        val headers: Map<String, String>,
        val body: InputStream,
        /** `Set-Cookie` lines of a credentialed response for the WebView to store ([Cookies.intercepts]); else empty. */
        val cookies: List<String> = emptyList(),
        /** The URL the response came from: the request's, or where the redirects the proxy followed landed. */
        val url: String = "",
        /** Whether a redirect was followed on the way (fetch's `Response.redirected`). */
        val redirected: Boolean = false
    )

    /**
     * Whose request the proxy performs, and how the answer is framed.
     *
     * An EXTENSION PAGE's ([extensionPage]): `Origin: chrome-extension://<id>` as Chrome sends it
     * and no `Referer` (Chrome sends none for an extension page); the server's CORS answer is
     * replaced by one for the emulated origin, since Chrome skips CORS for a host the extension's
     * permissions cover and the WebView applies it to every response; the response's cookies go
     * to the WebView when it intercepts them (the answer is a `WebResourceResponse`).
     *
     * A CONTENT SCRIPT's ([contentScript]): the request is the page's own CORS request in Chrome
     * – its `Origin` and `Referer` the page's, no host permission consulted (Chrome 85), the
     * server's consent read from the response – so the server's CORS headers are KEPT for the
     * world to judge as Chrome's renderer does, none added, and the cookies of a credentialed
     * request go to the jar, the answer never passing through a `WebResourceResponse`.
     */
    class Framing private constructor(
        /** The `Origin` header the target sees. */
        val origin: String,
        /** The `Referer` the target sees; null sends none. */
        val referer: String?,
        /** Whether the server's CORS answer is replaced by one for the extension origin. */
        val rewriteCors: Boolean,
        /** Whether a credentialed response's cookies always go to the jar (never handed to a WebView). */
        val cookiesToJar: Boolean
    ) {
        companion object {
            fun extensionPage(extensionId: String): Framing =
                Framing("chrome-extension://$extensionId", referer = null, rewriteCors = true, cookiesToJar = false)

            fun contentScript(pageOrigin: String, referer: String?): Framing =
                Framing(pageOrigin, referer, rewriteCors = false, cookiesToJar = true)
        }
    }

    private class Body(val bytes: ByteArray, val at: Long)

    private val lock = Object()
    private val bodies = HashMap<String, Body>()

    /** The bootstrap delivered the body of a ticketed request; the request may already be waiting for it. */
    fun putBody(ticket: String, bytes: ByteArray) {
        synchronized(lock) {
            val now = System.currentTimeMillis()
            bodies.entries.removeAll { now - it.value.at > BODY_TTL_MS }
            bodies[ticket] = Body(bytes, now)
            lock.notifyAll()
        }
    }

    /** The body under `ticket`, waiting up to `timeoutMs` for the bridge to deliver it; null when it never comes. */
    fun takeBody(ticket: String, timeoutMs: Long = BODY_WAIT_MS): ByteArray? {
        val deadline = System.currentTimeMillis() + timeoutMs
        synchronized(lock) {
            while (true) {
                val body = bodies.remove(ticket)
                if (body != null) return body.bytes
                val left = deadline - System.currentTimeMillis()
                if (left <= 0) return null
                lock.wait(left)
            }
        }
    }

    /**
     * Whether the proxy answers `request` from a page on `extensionOrigin`: an http(s) request off
     * that origin carrying it as the CORS `Origin` (a fetch, an XHR, a `crossorigin` element; a
     * plain `<img>` or `<script>` sends none and needs no CORS), to the security origin of a host
     * in `hosts` (the pattern's path is not consulted, as Chrome's CORS allowlist for an extension's
     * host permissions takes none: `https://mail.google.com/` reaches the whole origin), and not
     * one the bootstrap marked as its own to send ([SKIP]).
     */
    fun applies(request: Request, extensionOrigin: String, hosts: List<MatchPattern>): Boolean {
        if (!request.url.startsWith("http://") && !request.url.startsWith("https://")) return false
        if (request.url.startsWith("$extensionOrigin/")) return false
        if (request.header("Origin") != extensionOrigin) return false
        if (request.header(PROXY_HEADER) == SKIP) return false
        return MatchPattern.anyMatchesOrigin(hosts, request.url)
    }

    /**
     * Answer `request` (a preflight or the request itself); null when the network failed – or a
     * ticketed body never came over the bridge – and the WebView should try. What went wrong is
     * told to [onFailure] (the exception's class and message; `body <ticket> never arrived`) for
     * the runtime's record of the extension's proxied requests: compat round 22 read Temp Mail's
     * popup draw an empty address with nothing in that record, and a request the proxy could not
     * answer left it as empty as one never made.
     */
    fun handle(request: Request, extensionId: String, extensionOrigin: String, onFailure: (String) -> Unit = {}): Reply? {
        if (request.method.equals("OPTIONS", true) && request.header("Access-Control-Request-Method") != null) {
            return preflight(request, extensionOrigin)
        }
        val ticket = request.header(PROXY_HEADER)
        val body = if (ticket != null && ticket != SKIP) {
            takeBody(ticket) ?: run {
                onFailure("body $ticket never arrived over the bridge")
                return null
            }
        } else null
        return runCatching { forward(request, extensionId, extensionOrigin, body) }
            .onFailure { e -> onFailure("${e.javaClass.simpleName}: ${e.message ?: "no message"}") }
            .getOrNull()
    }

    /** The preflight allows what the page asked for; the request that follows is answered by [forward]. */
    fun preflight(request: Request, extensionOrigin: String): Reply {
        val headers = LinkedHashMap<String, String>()
        headers["Access-Control-Allow-Origin"] = extensionOrigin
        headers["Access-Control-Allow-Credentials"] = "true"
        headers["Access-Control-Allow-Methods"] = request.header("Access-Control-Request-Method") ?: "GET"
        request.header("Access-Control-Request-Headers")?.let { headers["Access-Control-Allow-Headers"] = it }
        headers["Access-Control-Max-Age"] = "600"
        headers["Content-Length"] = "0"
        return Reply(204, "No Content", "text/plain", null, headers, ByteArrayInputStream(ByteArray(0)))
    }

    /**
     * Perform the request as an extension page's and re-serve the response with CORS headers for
     * `extensionOrigin` ([Framing.extensionPage]).
     */
    fun forward(request: Request, extensionId: String, extensionOrigin: String, body: ByteArray?): Reply =
        forward(request, extensionOrigin, body, Framing.extensionPage(extensionId))

    /** Perform the request framed as [framing] says and re-serve the response the way it asks. */
    fun forward(request: Request, extensionOrigin: String, body: ByteArray?, framing: Framing): Reply {
        val credentials = request.header(CREDENTIALS_HEADER) == "include"
        var method = request.method.uppercase(Locale.ROOT)
        var url = request.url
        var payload = body
        var hops = 0
        while (true) {
            val connection = URL(url).openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.requestMethod = method
            for ((name, value) in request.headers) {
                if (DROPPED_REQUEST_HEADERS.contains(name.lowercase(Locale.ROOT))) continue
                connection.setRequestProperty(name, value)
            }
            connection.setRequestProperty("Origin", framing.origin)
            framing.referer?.let { connection.setRequestProperty("Referer", it) }
            userAgent()?.let { connection.setRequestProperty("User-Agent", it) }
            if (credentials) cookies.header(url)?.let { connection.setRequestProperty("Cookie", it) }
            if (payload != null && method != "GET" && method != "HEAD") {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(payload.size)
                connection.outputStream.use { it.write(payload) }
            }
            val status = connection.responseCode
            val location = connection.getHeaderField("Location")
            if (status in REDIRECTS && location != null && hops < MAX_REDIRECTS) {
                hops++
                url = URL(URL(url), location).toString()
                // fetch's redirect rules: 303 (and 301/302 for POST) turn into a bodyless GET, 307/308 keep both.
                if (status == 303 || ((status == 301 || status == 302) && method == "POST")) {
                    method = "GET"
                    payload = null
                }
                connection.disconnect()
                continue
            }
            return reply(connection, status, url, extensionOrigin, credentials, redirected = hops > 0, framing = framing)
        }
    }

    private fun reply(
        connection: HttpURLConnection,
        status: Int,
        url: String,
        extensionOrigin: String,
        credentials: Boolean,
        redirected: Boolean,
        framing: Framing
    ): Reply {
        val stream = (if (status >= 400) connection.errorStream else connection.inputStream) ?: ByteArrayInputStream(ByteArray(0))
        // The WebView writes the Content-Type line itself from the mime and the charset (measured:
        // one carried in the header map as well came out doubled, "application/json, application/json",
        // where Chrome's page reads a single value), so the type keeps its other parameters (a
        // multipart boundary) and the header map goes without it.
        val contentType = connection.contentType ?: "application/octet-stream"
        val parameters = contentType.split(';').map { it.trim() }
        val mime = parameters.filterIndexed { i, p -> i == 0 || !p.startsWith("charset=", ignoreCase = true) }
            .filter { it.isNotEmpty() }.joinToString("; ").ifEmpty { "application/octet-stream" }
        val charset = parameters.drop(1).firstOrNull { it.startsWith("charset=", ignoreCase = true) }
            ?.substringAfter('=')?.trim()?.trim('"')?.ifEmpty { null }
        val headers = LinkedHashMap<String, String>()
        val exposed = ArrayList<String>()
        // The WebView files a response's cookies under the URL it asked for; after a redirect the
        // proxy followed they belong to the final URL, which only the jar can be told – as can
        // the cookies of an answer that never passes through a WebResourceResponse.
        val handOver = cookies.intercepts && !redirected && !framing.cookiesToJar
        val forWebView = ArrayList<String>()
        for ((name, values) in connection.headerFields) {
            if (name == null || values.isNullOrEmpty()) continue
            val lower = name.lowercase(Locale.ROOT)
            if (lower == "set-cookie" || lower == "set-cookie2") {
                if (credentials) for (value in values) if (handOver) forWebView.add(value) else cookies.store(url, value)
                continue
            }
            if (DROPPED_RESPONSE_HEADERS.contains(lower)) continue
            if (framing.rewriteCors && CORS_RESPONSE_HEADERS.contains(lower)) continue
            headers[name] = values.joinToString(", ")
            exposed.add(name)
        }
        if (framing.rewriteCors) {
            headers["Access-Control-Allow-Origin"] = extensionOrigin
            headers["Access-Control-Allow-Credentials"] = "true"
            if (exposed.isNotEmpty()) headers["Access-Control-Expose-Headers"] = exposed.joinToString(", ")
        }
        val reason = connection.responseMessage?.ifEmpty { null } ?: "OK"
        // Closing the body closes the connection; the WebView reads it on its own schedule.
        val body = object : FilterInputStream(stream) {
            override fun close() {
                try {
                    super.close()
                } finally {
                    connection.disconnect()
                }
            }
        }
        return Reply(status, reason, mime, charset, headers, body, forWebView, url, redirected)
    }

    companion object {
        /** The request header naming the ticket the bootstrap sent the body under, or [SKIP]. */
        const val PROXY_HEADER = "X-Zenium-Proxy"
        /** The request header marking a credentialed fetch (`credentials: "include"`, `withCredentials`). */
        const val CREDENTIALS_HEADER = "X-Zenium-Credentials"
        /** [PROXY_HEADER] value for a request the bootstrap could not hand over (a body it cannot read). */
        const val SKIP = "skip"
        const val BODY_WAIT_MS = 5_000L
        const val BODY_TTL_MS = 60_000L
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 30_000
        const val MAX_REDIRECTS = 10
        private val REDIRECTS = setOf(301, 302, 303, 307, 308)
        /**
         * Request headers that are the WebView's business, not the target's: the emulated origin
         * (`Origin` is rewritten, `Referer` dropped), the proxy's own markers, `Accept-Encoding`
         * (HttpURLConnection negotiates and decodes gzip itself), and connection framing.
         */
        private val DROPPED_REQUEST_HEADERS = setOf(
            "host", "origin", "referer", "cookie", "accept-encoding", "content-length", "connection", "keep-alive",
            PROXY_HEADER.lowercase(Locale.ROOT), CREDENTIALS_HEADER.lowercase(Locale.ROOT)
        )
        /**
         * Response headers that would lie about the re-framed, decoded body, the one the WebView
         * writes itself from the reply's mime and charset (the caller re-derives them).
         */
        private val DROPPED_RESPONSE_HEADERS = setOf(
            "content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive", "content-type"
        )
        /**
         * The server's own CORS answer: replaced for an extension page's request
         * ([Framing.rewriteCors]), kept for a content script's, whose world judges it.
         */
        private val CORS_RESPONSE_HEADERS = setOf(
            "access-control-allow-origin", "access-control-allow-credentials", "access-control-expose-headers"
        )
    }
}
