package app.zen.chromium

import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * The sync engine's HTTP verbs on the phone (`sync.fetch` / `sync.fetchAbort` on the bridge): the
 * WebDAV transport in src/core/sync/webdav.ts speaks PROPFIND, MKCOL, PUT, MOVE and DELETE through
 * `SyncPlatformHost.fetch` (the contract is `SyncFetch` in src/core/platform.ts, the caller
 * `AndroidSyncFetch` in src/android/syncFetch.ts), and on Android that is this class over OkHttp –
 * the platform's `HttpURLConnection` refuses every method it does not know, WebDAV's included.
 *
 * The desktop's `net.fetch(url, { cache: 'no-store', redirect: 'manual', credentials: 'omit' })`,
 * kept to the letter: the client follows no redirect at all (a 3xx comes back as the response, so
 * the `Authorization` header never travels to a second origin; the transport classes it
 * `redirect`, the same kind the desktop host types Electron's cancelled manual redirect as), holds
 * no cookie jar and no cache, and trusts what the platform trusts (its TLS is
 * the system's). A response body comes back as text and is capped at [MAX_BODY_BYTES]; response
 * headers come back by lower-cased name, repeats joined with `, ` the way the Fetch standard's
 * `Headers.get` joins them, so `headers.get('etag')` reads the same on both platforms.
 *
 * Never built at boot: [Host] creates its instance on the first `sync.fetch`, and the
 * [OkHttpClient] itself only when the first request runs (`client` is lazy). No header, URL or
 * body is ever logged here – the `Authorization` header is the user's app password.
 */
class SyncFetch(
    private val connectTimeoutMs: Long = CONNECT_TIMEOUT_MS,
    private val ioTimeoutMs: Long = IO_TIMEOUT_MS,
    private val maxBodyBytes: Long = MAX_BODY_BYTES
) {
    /**
     * One request's handle from the moment the bridge call arrives: [Host] takes it on the main
     * thread (nothing is built yet) so an abort that lands before the worker thread has even
     * started the request still finds something to cancel.
     */
    class Ticket internal constructor(internal val id: String) {
        @Volatile internal var call: Call? = null
        @Volatile internal var aborted = false
    }

    sealed class Outcome {
        /** The server answered; [headers] by lower-cased name, [body] the response's text. */
        class Response(val status: Int, val headers: Map<String, String>, val body: String) : Outcome()

        /** No response: [kind] is one of the `fetch-*` kinds below, [message] the words the transport shows scrubbed. */
        class Failure(val kind: String, val message: String) : Outcome()
    }

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(ioTimeoutMs, TimeUnit.MILLISECONDS)
            .writeTimeout(ioTimeoutMs, TimeUnit.MILLISECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .cookieJar(CookieJar.NO_COOKIES)
            .build()
    }

    private val inFlight = ConcurrentHashMap<String, Ticket>()

    /** Register a request by the caller's [id] before any thread hop; [run] retires it. */
    fun begin(id: String): Ticket = Ticket(id).also { if (id.isNotEmpty()) inFlight[id] = it }

    /** The request registered under [id] is cancelled if it is still going; true when there was one. */
    fun abort(id: String): Boolean {
        val ticket = inFlight[id] ?: return false
        ticket.aborted = true
        ticket.call?.cancel()
        return true
    }

    /**
     * Send the request and read the whole answer, on the calling thread (a worker's). [headers]
     * go on the wire as given; a [body] is sent as UTF-8 under the caller's `Content-Type` (or
     * none), and a method that must carry one (PUT, POST, PATCH, PROPPATCH, REPORT) carries an
     * empty one when the caller sent none. [noStore] adds `Cache-Control: no-store` for the
     * intermediaries unless the caller set the header; the client itself never stores anything.
     */
    fun run(ticket: Ticket, url: String, method: String, headers: Map<String, String>, body: String?, noStore: Boolean): Outcome {
        try {
            val target = url.toHttpUrlOrNull() ?: return Outcome.Failure(BAD_URL, "not an absolute http(s) URL")
            if (!METHOD.matches(method)) return Outcome.Failure(BAD_METHOD, "not an HTTP method")
            val builder = Request.Builder().url(target)
            for ((name, value) in headers) {
                try {
                    builder.header(name, value)
                } catch (e: IllegalArgumentException) {
                    // OkHttp's own message quotes the value; a header's value may be the credential.
                    return Outcome.Failure(BAD_HEADER, "header '$name' has a character HTTP forbids")
                }
            }
            if (noStore && headers.keys.none { it.equals("Cache-Control", ignoreCase = true) }) {
                builder.header("Cache-Control", "no-store")
            }
            val requestBody = when {
                method == "GET" || method == "HEAD" -> null
                body != null -> body.toRequestBody()
                method in REQUIRES_BODY -> "".toRequestBody()
                else -> null
            }
            builder.method(method, requestBody)
            if (ticket.aborted) return Outcome.Failure(ABORTED, "aborted before it was sent")
            val call = client.newCall(builder.build())
            ticket.call = call
            // The abort may have landed between the check above and the handle being published.
            if (ticket.aborted) call.cancel()
            return try {
                call.execute().use { response -> read(response) }
            } catch (e: IOException) {
                Outcome.Failure(
                    when {
                        call.isCanceled() -> ABORTED
                        e is SocketTimeoutException -> TIMEOUT
                        else -> NETWORK
                    },
                    // The exception's words, never the request's: no URL, no header travels in them.
                    e.javaClass.simpleName + (e.message?.let { ": $it" } ?: "")
                )
            }
        } finally {
            if (ticket.id.isNotEmpty()) inFlight.remove(ticket.id, ticket)
        }
    }

    private fun read(response: Response): Outcome {
        val headers = LinkedHashMap<String, String>()
        for (i in 0 until response.headers.size) {
            val name = response.headers.name(i).lowercase()
            val value = response.headers.value(i)
            headers[name] = headers[name]?.let { "$it, $value" } ?: value
        }
        val body = response.body ?: return Outcome.Response(response.code, headers, "")
        if (body.contentLength() > maxBodyBytes) return tooLarge()
        // `request` buffers up to a byte past the cap: true means the body runs over it.
        if (body.source().request(maxBodyBytes + 1)) return tooLarge()
        return Outcome.Response(response.code, headers, body.string())
    }

    private fun tooLarge(): Outcome = Outcome.Failure(TOO_LARGE, "response body over $maxBodyBytes bytes")

    companion object {
        /** A first connection to the server, TLS included. */
        const val CONNECT_TIMEOUT_MS = 15_000L
        /** Between bytes of a request going out or an answer coming in; the transport's own 30 s abort usually wins. */
        const val IO_TIMEOUT_MS = 30_000L
        /** A sync document is a few kilobytes; a PROPFIND listing a few hundred – anything past this is not the transport's. */
        const val MAX_BODY_BYTES = 16L * 1024 * 1024

        /** Rejection prefix on the bridge: `fetch-<kind>: <message>` (`AndroidSyncFetch` maps the kinds). */
        const val REJECTION_PREFIX = "fetch-"
        const val ABORTED = "aborted"
        const val TIMEOUT = "timeout"
        const val NETWORK = "network"
        const val TOO_LARGE = "too-large"
        const val BAD_URL = "bad-url"
        const val BAD_METHOD = "bad-method"
        const val BAD_HEADER = "bad-header"

        /** The methods OkHttp insists carry a body (its `HttpMethod.requiresRequestBody`). */
        private val REQUIRES_BODY = setOf("POST", "PUT", "PATCH", "PROPPATCH", "REPORT")
        /** A method token as the transport writes them: upper-case letters, a hyphen inside (`VERSION-CONTROL`). */
        private val METHOD = Regex("[A-Z][A-Z-]{0,31}")
    }
}
