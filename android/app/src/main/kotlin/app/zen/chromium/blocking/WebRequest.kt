package app.zen.chromium.blocking

import android.webkit.WebViewClient
import java.net.URLDecoder
import java.util.Base64
import java.util.concurrent.atomic.AtomicLong

/**
 * The Android half of the listener contract of `src/main/platform/webRequest.ts`: a registry of
 * `chrome.webRequest`-style listeners over `shouldInterceptRequest`, so the extension platform's
 * emulation registers the same listeners, with the same event names, details and result shape,
 * on both platforms. As on the desktop the engine decides first: a request the engine blocked or
 * neutered is not offered to the `onBeforeRequest` listeners (Chromium evaluates
 * declarativeNetRequest before it dispatches `webRequest`); listeners then run in a stable order
 * (priority, registrant id, registration order) and their answers compose the way Chromium
 * composes extension answers ([composeBeforeRequest], [mergeRedirect]).
 *
 * WebView supplies far less than Electron's `webRequest`, so only three events fire:
 *  - `onBeforeRequest`, from `shouldInterceptRequest` (blocking and observing);
 *  - `onSendHeaders`, right after it, observing, with the read-only headers WebView will send;
 *  - `onErrorOccurred`, from `WebViewClient.onReceivedError`, and synthesised with
 *    `net::ERR_BLOCKED_BY_CLIENT` when the engine or a listener cancelled the request (Chromium
 *    reports a cancelled request the same way).
 * `onBeforeSendHeaders`, `onHeadersReceived`, `onResponseStarted`, `onBeforeRedirect` and
 * `onCompleted` accept registrations, so the emulation's code stays platform-neutral, but never
 * fire ([WebRequestEvent.fires]): WebView shows the embedder no response and lets it change no
 * outgoing header. Of a blocking answer, `cancel` is honoured for every request; `redirectUrl`
 * is honoured for a navigation (the tab loads the target) and for `data:` / `about:blank`
 * targets (the body is synthesised, as Chromium does for these cancel-style redirects); an
 * `http(s)` redirect of a subresource, `requestHeaders` and `responseHeaders` cannot be applied
 * and are recorded in [WebRequestListeners.unsupported] instead.
 *
 * Listeners run on WebView's IO threads, several at a time, and a blocking listener holds its
 * request until it returns: the emulation is responsible for its own thread safety and for
 * bounding how long it takes.
 */
enum class WebRequestEvent(
    /** The `chrome.webRequest` name, the desktop's `WebRequestEvent` string. */
    val wireName: String,
    /** Whether the event has a blocking variant (the desktop's `BLOCKING_EVENTS`). */
    val blockable: Boolean,
    /** Whether WebView lets this event fire on Android. */
    val fires: Boolean
) {
    ON_BEFORE_REQUEST("onBeforeRequest", blockable = true, fires = true),
    ON_BEFORE_SEND_HEADERS("onBeforeSendHeaders", blockable = true, fires = false),
    ON_SEND_HEADERS("onSendHeaders", blockable = false, fires = true),
    ON_HEADERS_RECEIVED("onHeadersReceived", blockable = true, fires = false),
    ON_RESPONSE_STARTED("onResponseStarted", blockable = false, fires = false),
    ON_BEFORE_REDIRECT("onBeforeRedirect", blockable = false, fires = false),
    ON_COMPLETED("onCompleted", blockable = false, fires = false),
    ON_ERROR_OCCURRED("onErrorOccurred", blockable = false, fires = true);

    companion object {
        private val byWireName = entries.associateBy { it.wireName }

        fun fromWireName(name: String): WebRequestEvent? = byWireName[name]
    }
}

/**
 * What a listener sees: the desktop's `WebRequestDetails`. The fields every event carries come
 * first; the optional ones follow the event as in `chrome.webRequest`. On Android only
 * [requestHeaders] (`onSendHeaders`) and [error] (`onErrorOccurred`) are ever set – the
 * response-phase fields exist for the shape and stay null.
 */
data class WebRequestDetails(
    val event: WebRequestEvent,
    /** Stable across the phases of one request; WebView has no request id, so it is minted here. */
    val requestId: String,
    val url: String,
    val method: String,
    /**
     * Inferred from the main-frame flag, the `Accept` header and the extension (WebView carries
     * no type): [ResourceType.OTHER] when nothing gives it away.
     */
    val resourceType: ResourceType,
    /** 0 for a main-frame navigation; -1 otherwise, because WebView does not say which frame asked. */
    val frameId: Int,
    /** Always -1: WebView exposes no frame tree. */
    val parentFrameId: Int,
    /** The Zenium tab id (never null on Android: every request comes from a tab's WebView). */
    val tabId: String?,
    /** The profile: `default`, a container id or `private`. */
    val partition: String,
    /** Origin of the tab's document for a subresource; null for a navigation. */
    val initiator: String?,
    /** The tab's document for a subresource; null for a navigation. */
    val documentUrl: String?,
    /** Milliseconds since the epoch. */
    val timestamp: Long,
    /** `onSendHeaders`: the headers WebView is about to send, read-only. */
    val requestHeaders: Map<String, String>? = null,
    val responseHeaders: Map<String, List<String>>? = null,
    val statusLine: String? = null,
    val statusCode: Int? = null,
    val fromCache: Boolean? = null,
    val ip: String? = null,
    val redirectUrl: String? = null,
    /** `onErrorOccurred`: a `net::ERR_*` name, see [WebRequestListeners.netErrorName]. */
    val error: String? = null
)

/** What a blocking listener may answer (the desktop's `BlockingResponse`, Chromium's shape). */
data class BlockingResponse(
    val cancel: Boolean = false,
    val redirectUrl: String? = null,
    /** Not applicable on Android (WebView sends its own headers); recorded as unsupported. */
    val requestHeaders: Map<String, String>? = null,
    /** Not applicable on Android (WebView shows no response); recorded as unsupported. */
    val responseHeaders: Map<String, List<String>>? = null
)

fun interface WebRequestListener {
    /** The answer of a blocking listener; ignored for an observing one. */
    fun onEvent(details: WebRequestDetails): BlockingResponse?
}

/** The desktop's `ListenerFilter`: which requests a listener sees. */
class ListenerFilter(
    /** Matched against the request's possible types: a request of unknown kind matches many. */
    val types: Set<ResourceType>? = null,
    val tabId: String? = null,
    val partition: String? = null,
    /** Chromium match patterns are the caller's business; this is the compiled predicate. */
    val url: ((String) -> Boolean)? = null
)

/** The desktop's `ListenerOptions`. */
class ListenerOptions(
    /** Who registers, an extension id; answers compose per registrant. */
    val registrant: String,
    /** Higher runs first and wins conflicts; equal priorities order by registrant id. */
    val priority: Int = 0,
    /** The request waits for the answer; only [WebRequestEvent.blockable] events accept it. */
    val blocking: Boolean = false,
    val filter: ListenerFilter? = null
)

/** A blocking listener's answer with who gave it, in precedence order. */
class Answer(val registrant: String, val response: BlockingResponse)

/** What the `onBeforeRequest` answers compose to (the desktop's `composeBeforeRequest` result). */
class Composed(val cancel: Boolean, val redirectUrl: String?, /** Whose redirect won. */ val redirectedBy: String? = null)

class Conflict(val event: WebRequestEvent, val registrant: String, val url: String)

/** A listener's answer WebView cannot apply: `what` is `redirectUrl`, `requestHeaders` or `responseHeaders`. */
class Unsupported(val registrant: String, val what: String, val url: String)

/**
 * One request between `shouldInterceptRequest` and its error callback: the details every event
 * shares, plus the type bits its filters are matched against.
 */
class RequestRecord(val base: WebRequestDetails, val typeMask: Int) {
    fun details(event: WebRequestEvent, requestHeaders: Map<String, String>? = null, error: String? = null): WebRequestDetails =
        base.copy(event = event, requestHeaders = requestHeaders, error = error)
}

/** The registry: one per app, shared by every tab and profile, like the desktop multiplexer. */
class WebRequestListeners {
    private class Registration(
        val seq: Long,
        val event: WebRequestEvent,
        val registrant: String,
        val priority: Int,
        val blocking: Boolean,
        val filter: ListenerFilter?,
        val listener: WebRequestListener
    )

    /** Copy-on-write, sorted per event; read without a lock on the IO threads. */
    @Volatile
    private var registrations: Map<WebRequestEvent, List<Registration>> = emptyMap()
    private val seq = AtomicLong()
    private val ids = AtomicLong()
    private val recent = object : LinkedHashMap<String, RequestRecord>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, RequestRecord>?): Boolean = size > MAX_RECENT
    }
    private val conflictLog = ArrayList<Conflict>()
    private val unsupportedLog = ArrayList<Unsupported>()

    /** Told when a listener throws (the app logs it; tests look). */
    @Volatile
    var onListenerFailure: (registrant: String, error: RuntimeException) -> Unit = { _, _ -> }

    /** Registrants whose answers were dropped in a conflict, for diagnostics and tests. */
    val conflicts: List<Conflict>
        get() = synchronized(conflictLog) { conflictLog.toList() }

    /** Answers WebView could not apply, for diagnostics and tests. */
    val unsupported: List<Unsupported>
        get() = synchronized(unsupportedLog) { unsupportedLog.toList() }

    val isEmpty: Boolean
        get() = registrations.isEmpty()

    /**
     * Register a listener; returns the function that removes it again. Throws for a blocking
     * listener on an event without a blocking variant, like the desktop.
     */
    @Synchronized
    fun addListener(event: WebRequestEvent, listener: WebRequestListener, options: ListenerOptions): () -> Unit {
        require(!options.blocking || event.blockable) { "${event.wireName} has no blocking variant" }
        val registration = Registration(
            seq.getAndIncrement(), event, options.registrant, options.priority, options.blocking, options.filter, listener
        )
        val list = ArrayList(registrations[event] ?: emptyList())
        list.add(registration)
        list.sortWith(ORDER)
        registrations = registrations + (event to list)
        return { remove(registration) }
    }

    @Synchronized
    private fun remove(registration: Registration) {
        val list = registrations[registration.event] ?: return
        val next = list.filter { it !== registration }
        registrations = if (next.isEmpty()) registrations - registration.event else registrations + (registration.event to next)
    }

    /** Remove every listener of a registrant (an extension was unloaded). */
    @Synchronized
    fun removeListenersOf(registrant: String) {
        val next = HashMap<WebRequestEvent, List<Registration>>()
        for ((event, list) in registrations) {
            val kept = list.filter { it.registrant != registrant }
            if (kept.isNotEmpty()) next[event] = kept
        }
        registrations = next
    }

    /** `(registrant, blocking)` of the listeners of an event, in the order they run. */
    fun listenerOrder(event: WebRequestEvent): List<Pair<String, Boolean>> =
        (registrations[event] ?: emptyList()).map { it.registrant to it.blocking }

    fun hasListeners(event: WebRequestEvent): Boolean = !registrations[event].isNullOrEmpty()

    // ---------------------------------------------------------------------------------------------
    // Requests
    // ---------------------------------------------------------------------------------------------

    /**
     * Start tracking a request `shouldInterceptRequest` was handed: mints its id and builds the
     * details every event shares. `known` is the inferred type, null when nothing gave it away.
     */
    fun begin(tab: BlockingTab, url: String, method: String, isMainFrame: Boolean, known: ResourceType?): RequestRecord {
        val document = if (isMainFrame) null else tab.documentUrl
        val base = WebRequestDetails(
            event = WebRequestEvent.ON_BEFORE_REQUEST,
            requestId = ids.incrementAndGet().toString(),
            url = url,
            method = method,
            resourceType = known ?: ResourceType.OTHER,
            frameId = if (isMainFrame) 0 else -1,
            parentFrameId = -1,
            tabId = tab.tabId,
            partition = tab.containerId,
            initiator = document?.let { Domains.originOf(it) },
            documentUrl = document,
            timestamp = System.currentTimeMillis()
        )
        val record = RequestRecord(base, known?.bit ?: ResourceType.AMBIGUOUS_MASK)
        synchronized(recent) { recent[correlationKey(tab.tabId, url, method)] = record }
        return record
    }

    /**
     * The record of a request an error callback reports: the one `begin` made for the same tab,
     * URL and method when it is still remembered, otherwise a fresh record (WebView's callbacks
     * carry no id to correlate on, so this is best effort).
     */
    fun recordFor(tab: BlockingTab, url: String, method: String, isMainFrame: Boolean, known: ResourceType?): RequestRecord {
        synchronized(recent) { recent.remove(correlationKey(tab.tabId, url, method)) }?.let { return it }
        return begin(tab, url, method, isMainFrame, known)
    }

    /** Forget a request that ended (it will not report an error any more). */
    fun end(record: RequestRecord) {
        synchronized(recent) {
            val key = correlationKey(record.base.tabId, record.base.url, record.base.method)
            if (recent[key] === record) recent.remove(key)
        }
    }

    /** `onBeforeRequest`: run the matching listeners and compose the blocking ones' answers. */
    fun beforeRequest(record: RequestRecord): Composed {
        val answers = dispatch(WebRequestEvent.ON_BEFORE_REQUEST, record, record.details(WebRequestEvent.ON_BEFORE_REQUEST))
        for (answer in answers) {
            if (answer.response.requestHeaders != null) unsupported(answer.registrant, "requestHeaders", record.base.url)
            if (answer.response.responseHeaders != null) unsupported(answer.registrant, "responseHeaders", record.base.url)
        }
        return composeBeforeRequest(record.base.url, answers) { registrant ->
            conflict(WebRequestEvent.ON_BEFORE_REQUEST, registrant, record.base.url)
        }
    }

    /** `onSendHeaders`: the request goes out with these headers (observing listeners only). */
    fun sendHeaders(record: RequestRecord, headers: Map<String, String>) {
        if (!hasListeners(WebRequestEvent.ON_SEND_HEADERS)) return
        dispatch(WebRequestEvent.ON_SEND_HEADERS, record, record.details(WebRequestEvent.ON_SEND_HEADERS, requestHeaders = LinkedHashMap(headers)))
    }

    /** `onErrorOccurred`: the request failed with `error`, a `net::ERR_*` name. */
    fun errorOccurred(record: RequestRecord, error: String) {
        end(record)
        if (!hasListeners(WebRequestEvent.ON_ERROR_OCCURRED)) return
        dispatch(WebRequestEvent.ON_ERROR_OCCURRED, record, record.details(WebRequestEvent.ON_ERROR_OCCURRED, error = error))
    }

    /** A listener's answer WebView cannot apply; the request proceeds as if it had not been given. */
    fun unsupported(registrant: String, what: String, url: String) {
        synchronized(unsupportedLog) {
            if (unsupportedLog.size >= MAX_LOG) unsupportedLog.removeAt(0)
            unsupportedLog.add(Unsupported(registrant, what, url))
        }
    }

    /**
     * Call the listeners of `event` that match the request, in order, and collect the blocking
     * ones' answers in the same order. A listener that throws is skipped, like on the desktop.
     */
    private fun dispatch(event: WebRequestEvent, record: RequestRecord, details: WebRequestDetails): List<Answer> {
        val list = registrations[event] ?: return emptyList()
        if (list.isEmpty()) return emptyList()
        val answers = ArrayList<Answer>()
        for (registration in list) {
            if (!matches(registration.filter, record)) continue
            val response = try {
                registration.listener.onEvent(details)
            } catch (e: RuntimeException) {
                onListenerFailure(registration.registrant, e)
                continue
            }
            if (registration.blocking && response != null) answers.add(Answer(registration.registrant, response))
        }
        return answers
    }

    private fun conflict(event: WebRequestEvent, registrant: String, url: String) {
        synchronized(conflictLog) {
            if (conflictLog.size >= MAX_LOG) conflictLog.removeAt(0)
            conflictLog.add(Conflict(event, registrant, url))
        }
    }

    companion object {
        private const val MAX_RECENT = 256
        private const val MAX_LOG = 256

        /** Higher priority first, then registrant id, then registration order. */
        private val ORDER = Comparator<Registration> { a, b ->
            when {
                a.priority != b.priority -> b.priority.compareTo(a.priority)
                a.registrant != b.registrant -> a.registrant.compareTo(b.registrant)
                else -> a.seq.compareTo(b.seq)
            }
        }

        private fun correlationKey(tabId: String?, url: String, method: String): String = "$tabId\n$method\n$url"

        internal fun matches(filter: ListenerFilter?, record: RequestRecord): Boolean {
            if (filter == null) return true
            val types = filter.types
            if (types != null && types.none { (it.bit and record.typeMask) != 0 }) return false
            if (filter.tabId != null && filter.tabId != record.base.tabId) return false
            if (filter.partition != null && filter.partition != record.base.partition) return false
            val url = filter.url
            if (url != null && !url(record.base.url)) return false
            return true
        }

        /** A redirect to `data:` or `about:blank` is a way of cancelling and beats every other redirect. */
        fun isCancelRedirect(url: String): Boolean =
            url.startsWith("data:", ignoreCase = true) || url == "about:blank"

        /**
         * The redirect the answers agree on: cancel-style redirects first, otherwise the first
         * answer in precedence order; later, different targets are conflicts. Null when nobody
         * redirects (or every redirect points at the request's own URL).
         */
        fun mergeRedirect(url: String, answers: List<Answer>, conflict: (String) -> Unit = {}): String? {
            var chosen: String? = null
            for (onlyCancelStyle in booleanArrayOf(true, false)) {
                for (answer in answers) {
                    val target = answer.response.redirectUrl
                    if (target == null || target == url) continue
                    if (onlyCancelStyle && !isCancelRedirect(target)) continue
                    if (chosen == null || chosen == target) chosen = target else conflict(answer.registrant)
                }
                if (chosen != null) return chosen
            }
            return null
        }

        /** `onBeforeRequest`: any cancel cancels; otherwise the merged redirect. */
        fun composeBeforeRequest(url: String, answers: List<Answer>, conflict: (String) -> Unit = {}): Composed {
            if (answers.any { it.response.cancel }) return Composed(cancel = true, redirectUrl = null)
            val redirect = mergeRedirect(url, answers, conflict) ?: return Composed(cancel = false, redirectUrl = null)
            return Composed(cancel = false, redirect, answers.first { it.response.redirectUrl == redirect }.registrant)
        }

        /** `net::ERR_BLOCKED_BY_CLIENT`, what Chromium reports for a request an extension or a rule cancelled. */
        const val BLOCKED_BY_CLIENT = "net::ERR_BLOCKED_BY_CLIENT"

        /** `WebViewClient.ERROR_*` → the `net::ERR_*` name `chrome.webRequest` puts in `details.error`. */
        fun netErrorName(webViewError: Int): String = when (webViewError) {
            WebViewClient.ERROR_HOST_LOOKUP -> "net::ERR_NAME_NOT_RESOLVED"
            WebViewClient.ERROR_UNSUPPORTED_AUTH_SCHEME -> "net::ERR_UNSUPPORTED_AUTH_SCHEME"
            WebViewClient.ERROR_AUTHENTICATION -> "net::ERR_INVALID_AUTH_CREDENTIALS"
            WebViewClient.ERROR_PROXY_AUTHENTICATION -> "net::ERR_PROXY_AUTH_REQUESTED"
            WebViewClient.ERROR_CONNECT -> "net::ERR_CONNECTION_REFUSED"
            WebViewClient.ERROR_IO -> "net::ERR_CONNECTION_CLOSED"
            WebViewClient.ERROR_TIMEOUT -> "net::ERR_CONNECTION_TIMED_OUT"
            WebViewClient.ERROR_REDIRECT_LOOP -> "net::ERR_TOO_MANY_REDIRECTS"
            WebViewClient.ERROR_UNSUPPORTED_SCHEME -> "net::ERR_UNKNOWN_URL_SCHEME"
            WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> "net::ERR_SSL_PROTOCOL_ERROR"
            WebViewClient.ERROR_BAD_URL -> "net::ERR_INVALID_URL"
            WebViewClient.ERROR_FILE_NOT_FOUND -> "net::ERR_FILE_NOT_FOUND"
            WebViewClient.ERROR_TOO_MANY_REQUESTS -> "net::ERR_INSUFFICIENT_RESOURCES"
            WebViewClient.ERROR_UNSAFE_RESOURCE -> BLOCKED_BY_CLIENT
            else -> "net::ERR_FAILED"
        }
    }
}

/** A `data:` URL taken apart, for a listener's cancel-style redirect. */
class DataUrl(val mimeType: String, val charset: String?, val bytes: ByteArray) {
    companion object {
        /** RFC 2397: `data:[<mediatype>][;base64],<data>`; null when `url` is not one or is malformed. */
        fun parse(url: String): DataUrl? {
            if (!url.startsWith("data:", ignoreCase = true)) return null
            val comma = url.indexOf(',')
            if (comma == -1) return null
            val header = url.substring(5, comma)
            val payload = url.substring(comma + 1)
            val parts = header.split(';').map { it.trim() }
            var mimeType = parts.firstOrNull()?.takeIf { it.contains('/') } ?: "text/plain"
            var charset: String? = null
            var base64 = false
            for (part in parts.drop(if (parts.firstOrNull()?.contains('/') == true) 1 else 0)) {
                when {
                    part.equals("base64", ignoreCase = true) -> base64 = true
                    part.startsWith("charset=", ignoreCase = true) -> charset = part.substring(8).trim('"')
                }
            }
            if (mimeType == "text/plain" && charset == null && !base64 && parts.firstOrNull().isNullOrEmpty()) charset = "US-ASCII"
            mimeType = mimeType.lowercase()
            val bytes = runCatching {
                if (base64) Base64.getMimeDecoder().decode(percentDecode(payload))
                else percentDecode(payload).toByteArray(Charsets.UTF_8)
            }.getOrNull() ?: return null
            return DataUrl(mimeType, charset, bytes)
        }

        private fun percentDecode(s: String): String =
            if (s.indexOf('%') == -1) s else URLDecoder.decode(s.replace("+", "%2B"), "UTF-8")
    }
}
