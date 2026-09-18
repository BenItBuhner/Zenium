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
        val cookies: List<String> = emptyList()
    )

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
     * plain `<img>` or `<script>` sends none and needs no CORS), to a host in `hosts`, and not one
     * the bootstrap marked as its own to send ([SKIP]).
     */
    fun applies(request: Request, extensionOrigin: String, hosts: List<MatchPattern>): Boolean {
        if (!request.url.startsWith("http://") && !request.url.startsWith("https://")) return false
        if (request.url.startsWith("$extensionOrigin/")) return false
        if (request.header("Origin") != extensionOrigin) return false
        if (request.header(PROXY_HEADER) == SKIP) return false
        return MatchPattern.anyMatches(hosts, request.url)
    }

    /** Answer `request` (a preflight or the request itself); null when the network failed and the WebView should try. */
    fun handle(request: Request, extensionId: String, extensionOrigin: String): Reply? {
        if (request.method.equals("OPTIONS", true) && request.header("Access-Control-Request-Method") != null) {
            return preflight(request, extensionOrigin)
        }
        val ticket = request.header(PROXY_HEADER)
        val body = if (ticket != null && ticket != SKIP) takeBody(ticket) ?: return null else null
        return runCatching { forward(request, extensionId, extensionOrigin, body) }.getOrNull()
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

    /** Perform the request and re-serve the response with CORS headers for `extensionOrigin`. */
    fun forward(request: Request, extensionId: String, extensionOrigin: String, body: ByteArray?): Reply {
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
            connection.setRequestProperty("Origin", "chrome-extension://$extensionId")
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
            return reply(connection, status, url, extensionOrigin, credentials, redirected = url != request.url)
        }
    }

    private fun reply(
        connection: HttpURLConnection,
        status: Int,
        url: String,
        extensionOrigin: String,
        credentials: Boolean,
        redirected: Boolean
    ): Reply {
        val stream = (if (status >= 400) connection.errorStream else connection.inputStream) ?: ByteArrayInputStream(ByteArray(0))
        val contentType = connection.contentType ?: "application/octet-stream"
        val mime = contentType.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
        val charset = contentType.substringAfter("charset=", "").substringBefore(';').trim().ifEmpty { null }
        val headers = LinkedHashMap<String, String>()
        val exposed = ArrayList<String>()
        // The WebView files a response's cookies under the URL it asked for; after a redirect the
        // proxy followed they belong to the final URL, which only the jar can be told.
        val handOver = cookies.intercepts && !redirected
        val forWebView = ArrayList<String>()
        for ((name, values) in connection.headerFields) {
            if (name == null || values.isNullOrEmpty()) continue
            val lower = name.lowercase(Locale.ROOT)
            if (lower == "set-cookie" || lower == "set-cookie2") {
                if (credentials) for (value in values) if (handOver) forWebView.add(value) else cookies.store(url, value)
                continue
            }
            if (DROPPED_RESPONSE_HEADERS.contains(lower)) continue
            headers[name] = values.joinToString(", ")
            exposed.add(name)
        }
        headers["Access-Control-Allow-Origin"] = extensionOrigin
        headers["Access-Control-Allow-Credentials"] = "true"
        if (exposed.isNotEmpty()) headers["Access-Control-Expose-Headers"] = exposed.joinToString(", ")
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
        return Reply(status, reason, mime, charset, headers, body, forWebView)
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
        /** Response headers that would lie about the re-framed, decoded body, plus the server's own CORS answer. */
        private val DROPPED_RESPONSE_HEADERS = setOf(
            "content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive",
            "access-control-allow-origin", "access-control-allow-credentials", "access-control-expose-headers"
        )
    }
}
