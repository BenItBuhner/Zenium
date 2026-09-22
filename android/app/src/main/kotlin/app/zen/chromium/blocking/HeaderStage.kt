package app.zen.chromium.blocking

import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/**
 * The engine's headers-received stage for a document request, on a platform whose
 * `shouldInterceptRequest` decides before any response exists.
 *
 * A rule with `responseHeaders` / `excludedResponseHeaders` conditions (Stylus's usercss
 * installer: redirect a `*.user.css` navigation whose response is a text type but not HTML) can only
 * be decided against the real response. When the request stage's answer for a main-frame or
 * sub-frame document is an allow one such rule could still overturn ([Decision.needsHeaders]),
 * the request is relayed: fetched here, on the intercept thread, with the request's method and
 * headers and the profile's cookies, following no redirects; the rules are asked again with the
 * response's headers ([EngineSnapshot.decide]); and the answer is applied the way the request
 * stage applies its own – a block drops the document, a redirect has the tab load the target (a
 * frame replaces itself), an allow serves the fetched response as the document. A `3xx` of the
 * origin is mirrored the same way a rule's redirect is (WebView cannot take a `3xx`
 * `WebResourceResponse`): the tab loads the `Location`, and that navigation is decided afresh, so
 * a header rule sees every hop, as the desktop engine's headers-received stage does.
 *
 * Narrow by construction: only documents whose request-side conditions selected a
 * header-conditioned rule come here (ordinary traffic never pays the relay), and only `GET` /
 * `HEAD` ones (a `POST`'s body is not at hand; the request-stage allow stands). A relay that
 * fails to connect hands the request back to WebView unchanged.
 */
class HeaderStage(private val cookies: CookieStore, private val fetcher: Fetcher = HttpFetcher()) {
    /** The profile's cookie jar (WebView's `CookieManager` for the partition). */
    interface CookieStore {
        /** The `Cookie` header for `url` in `partition`, or null without cookies. */
        fun cookieHeader(partition: String, url: String): String?

        /** Store the response's `Set-Cookie` lines for `url` in `partition`. */
        fun store(partition: String, url: String, setCookie: List<String>)
    }

    /** A relayed response as the fetch returned it (`headers` in `HttpURLConnection.headerFields` shape: a null key for the status line). */
    class Response(
        val status: Int,
        val reason: String,
        val headers: Map<String?, List<String>?>,
        val body: InputStream?
    ) {
        /** The first `name` header, whatever its case; null without one. */
        fun header(name: String): String? {
            for ((key, values) in headers) {
                if (key != null && key.equals(name, ignoreCase = true)) return values?.firstOrNull()
            }
            return null
        }
    }

    /** Performs the relayed fetch; null when it could not be made at all. */
    fun interface Fetcher {
        fun fetch(url: String, method: String, headers: Map<String, String>): Response?
    }

    /** What the header stage decided for a relayed response. */
    sealed class Outcome {
        /** Serve the relayed response as the document. */
        object Serve : Outcome()

        /** Block the document (204 and the blocked page for a main frame, 403 for a frame). */
        object Block : Outcome()

        /** The tab (or the frame) goes to `url`: a rule's target when [byRule], the origin's own `Location` otherwise. */
        class Redirect(val url: String, val byRule: Boolean) : Outcome()

        /** Nothing here can stand in for the response: WebView loads the request itself. */
        object PassThrough : Outcome()
    }

    /**
     * What the relay hands WebView in place of the request: a `WebResourceResponse` in all but
     * name (the platform class has no readable fields off the device; this one does).
     */
    class Answer(
        val status: Int,
        val reason: String,
        val mime: String,
        val encoding: String?,
        val headers: Map<String, String>,
        val data: InputStream
    ) {
        fun toResponse(): WebResourceResponse = WebResourceResponse(mime, encoding, status, reason, headers, data)

        companion object {
            fun empty(status: Int, reason: String, mime: String = "text/plain"): Answer =
                Answer(status, reason, mime, "utf-8", mapOf("Content-Length" to "0"), ByteArrayInputStream(ByteArray(0)))
        }
    }

    /**
     * Relay `req` (already decided [Decision.needsHeaders] at the request stage) and answer for
     * it, or null to let WebView load it. `requestHeaders` are the request's own; `observer` hears
     * the header stage's decision when it names another match than `requestDecision`, the request
     * stage's (the desktop's `sameMatch`, contract 5.5: a re-reported request-stage allow would
     * count twice). Runs on the intercept thread.
     *
     * The profile's cookie jar rides only on a first-party relay. WebView attaches `Cookie` at the
     * network layer, after the intercept, under the profile's third-party cookie policy and
     * SameSite; a cross-site frame relayed with the whole jar would bypass both, so it goes
     * without cookies and its `Set-Cookie` is not stored. `withCookies` false is the cookie
     * policy's word ([RequestPolicy.cookiesWithheld]: a never-site's document, every unlisted
     * one under "block all cookies"): the relay then carries no `Cookie` at all – the request's
     * own header goes too – and keeps no `Set-Cookie`, the desktop header stage's strip.
     */
    fun relay(
        snap: EngineSnapshot,
        tab: BlockingTab,
        req: Request,
        requestHeaders: Map<String, String>,
        observer: DecisionObserver?,
        requestDecision: Decision = Decision.ALLOW,
        withCookies: Boolean = true
    ): Answer? {
        if (req.method != "GET" && req.method != "HEAD") return null
        val headers = relayHeaders(requestHeaders)
        if (!withCookies) headers.keys.filter { it.equals("Cookie", ignoreCase = true) }.forEach { headers.remove(it) }
        val withJar = withCookies && !req.isThirdParty
        if (withJar && headers.keys.none { it.equals("Cookie", ignoreCase = true) }) {
            cookies.cookieHeader(tab.containerId, req.url)?.let { headers["Cookie"] = it }
        }
        val started = System.nanoTime()
        val response = fetcher.fetch(req.url, req.method, headers) ?: return null
        val indexed = HeaderCondition.index(response.headers)
        val decision = snap.decide(req, indexed)
        if (observer != null && decision.matchedSet != null && !sameMatch(decision, requestDecision)) {
            observer.onDecision(tab, req, decision, System.nanoTime() - started, -1L)
        }
        val setCookie = indexed["set-cookie"]
        if (withJar && !setCookie.isNullOrEmpty()) cookies.store(tab.containerId, req.url, setCookie)
        val isMainFrame = req.type == ResourceType.MAIN_FRAME
        return when (val outcome = outcome(decision, response, req.url)) {
            Outcome.PassThrough -> {
                response.body?.close()
                null
            }
            Outcome.Block -> {
                response.body?.close()
                if (isMainFrame) {
                    tab.onDocumentBlocked(req.url)
                    Answer.empty(204, "No Content")
                } else {
                    tab.onRequestsBlocked(1)
                    Answer.empty(403, "Forbidden")
                }
            }
            is Outcome.Redirect -> {
                response.body?.close()
                if (isMainFrame) {
                    tab.onDocumentRedirected(outcome.url)
                    Answer.empty(204, "No Content")
                } else {
                    frameRedirect(outcome.url)
                }
            }
            Outcome.Serve -> serve(response, req.method == "HEAD")
        }
    }

    /** The relayed response as WebView takes it (the body streams; the framing headers the decoding made stale go). */
    private fun serve(response: Response, headOnly: Boolean): Answer {
        val contentType = response.header("Content-Type") ?: "application/octet-stream"
        val mime = contentType.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
        val charset = contentType.substringAfter("charset=", "").substringBefore(';').trim().trim('"').ifEmpty { null }
        val headers = LinkedHashMap<String, String>()
        for ((name, values) in response.headers) {
            if (name == null || values.isNullOrEmpty()) continue
            val lower = name.lowercase(Locale.ROOT)
            if (lower in DROPPED_RESPONSE_HEADERS) continue
            headers[name] = values.joinToString(", ")
        }
        val body = if (headOnly) ByteArrayInputStream(ByteArray(0)) else response.body ?: ByteArrayInputStream(ByteArray(0))
        return Answer(response.status, response.reason.ifEmpty { "OK" }, mime, charset, headers, body)
    }

    private fun frameRedirect(url: String): Answer {
        val html = "<!doctype html><meta charset=\"utf-8\"><script>location.replace(${org.json.JSONObject.quote(url)})</script>"
        val bytes = html.toByteArray()
        return Answer(200, "OK", "text/html", "utf-8", mapOf("Content-Length" to bytes.size.toString(), "Cache-Control" to "no-cache"), ByteArrayInputStream(bytes))
    }

    /** The relayed fetch over `HttpURLConnection`, following no redirects. */
    class HttpFetcher(private val connectTimeoutMs: Int = 10_000, private val readTimeoutMs: Int = 20_000) : Fetcher {
        override fun fetch(url: String, method: String, headers: Map<String, String>): Response? = runCatching {
            val connection = URL(url).openConnection() as HttpURLConnection
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.useCaches = false
            for ((name, value) in headers) connection.setRequestProperty(name, value)
            val status = connection.responseCode
            if (status < 100) return null
            val body = runCatching { if (status >= 400) connection.errorStream else connection.inputStream }.getOrNull()
            Response(status, connection.responseMessage ?: "", connection.headerFields, body)
        }.getOrNull()
    }

    companion object {
        /**
         * Request headers the relay does not forward: `Host` is the target's, `Accept-Encoding`
         * stays with the connection so the body arrives decoded, and a conditional request could
         * draw a `304` WebView cannot take for a document.
         */
        private val DROPPED_REQUEST_HEADERS = setOf("host", "accept-encoding", "if-none-match", "if-modified-since", "range", "connection", "content-length")

        /** Response headers the decoded, re-framed body makes wrong (and the cookies WebView drops from an intercepted response; the relay stores them itself). */
        private val DROPPED_RESPONSE_HEADERS = setOf("content-length", "content-encoding", "transfer-encoding", "set-cookie", "connection", "keep-alive")

        /** Both decisions name the same set, rule and filter (`sameMatch` in `blocking.ts`). */
        fun sameMatch(a: Decision, b: Decision): Boolean =
            a.matchedSet == b.matchedSet && a.matchedRule == b.matchedRule && a.matchedFilter == b.matchedFilter

        /** The request's headers as the relay sends them (minus [DROPPED_REQUEST_HEADERS]). */
        fun relayHeaders(requestHeaders: Map<String, String>): LinkedHashMap<String, String> {
            val out = LinkedHashMap<String, String>()
            for ((name, value) in requestHeaders) {
                if (name.lowercase(Locale.ROOT) in DROPPED_REQUEST_HEADERS) continue
                out[name] = value
            }
            return out
        }

        /**
         * The header stage's outcome for `decision` (the rules' word with the response's headers)
         * on `response` to `requestUrl`: a block or redirect of the rules first; then the origin's
         * own `3xx`, mirrored as a redirect to its `Location` (resolved against the request); a
         * `3xx` without one, or a status WebView cannot carry, hands the request back; anything
         * else is served as it is.
         */
        fun outcome(decision: Decision, response: Response, requestUrl: String): Outcome {
            when (decision.action) {
                Decision.Action.BLOCK -> return Outcome.Block
                Decision.Action.REDIRECT, Decision.Action.UPGRADE -> {
                    val target = decision.redirectUrl
                    if (target != null && decision.matchedSet != Decision.TEXT_SET_ID) return Outcome.Redirect(target, byRule = true)
                }
                Decision.Action.ALLOW -> Unit
            }
            if (response.status in 300..399) {
                val location = response.header("Location") ?: return Outcome.PassThrough
                val resolved = runCatching { URL(URL(requestUrl), location).toString() }.getOrNull() ?: return Outcome.PassThrough
                return Outcome.Redirect(resolved, byRule = false)
            }
            if (response.status < 200 || response.status > 599) return Outcome.PassThrough
            return Outcome.Serve
        }
    }
}
