package app.zen.chromium.ext

import org.json.JSONArray
import org.json.JSONObject

/**
 * The `ext.requestHeaders` report: the headers WebView is about to send with a request the
 * engine just decided, for the runtime's `onBeforeSendHeaders` / `onSendHeaders`.
 *
 * WebView shows a request's headers at one place – `shouldInterceptRequest`'s
 * `WebResourceRequest.getRequestHeaders()`, the headers the page's fetch set and the ones the
 * WebView adds before the network stack's own (no `Cookie`, no `Content-Length`) – and the
 * engine hands them to its `onSendHeaders` listeners ([app.zen.chromium.blocking.WebRequestEvent.ON_SEND_HEADERS])
 * right after the decision observer heard the same request, on the same intercept thread, in
 * one `Blocking.evaluate`. Nothing on that path carries the `ext.request` id across, so the
 * runtime pairs the two by the thread: [Extensions.onDecision] leaves the request's payload in a
 * thread-local and the `onSendHeaders` listener takes it. This builds the report from the two,
 * or refuses when they are not one request – another URL on record (a decision the engine's
 * verdict kept from going out never reaches `onSendHeaders`, and the next request on the thread
 * must not inherit its predecessor), or none.
 *
 * Speak Subtitles for YouTube's worker (compat rounds 18-19) listens on `youtube.com`'s
 * `/api/timedtext*` (any scheme, any subdomain) with `["requestHeaders", "extraHeaders"]` and
 * keeps the `x-*` request headers of the player's own subtitle fetch, to fetch the same text
 * itself.
 */
object RequestHeadersReport {
    /**
     * The payload, or null when [decided] – the last `ext.request` payload of this thread – is not
     * the request at [url]. [headers] as WebView gives them (case as sent, one value per name).
     */
    fun build(decided: JSONObject?, url: String, headers: Map<String, String>?): JSONObject? {
        if (decided == null || decided.optString("url") != url) return null
        val list = JSONArray()
        if (headers != null) for ((name, value) in headers) list.put(JSONObject().put("name", name).put("value", value))
        return JSONObject()
            .put("tabId", decided.opt("tabId") ?: JSONObject.NULL)
            .put("requestId", decided.optString("requestId"))
            .put("url", url)
            .put("type", decided.optString("type"))
            .put("method", decided.optString("method"))
            .put("initiator", decided.opt("initiator") ?: JSONObject.NULL)
            .put("mainFrame", decided.optBoolean("mainFrame"))
            .put("document", decided.optLong("document"))
            .put("requestHeaders", list)
    }
}
