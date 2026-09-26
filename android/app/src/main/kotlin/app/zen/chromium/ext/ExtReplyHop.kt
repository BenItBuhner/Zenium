package app.zen.chromium.ext

import android.util.Log
import android.webkit.JavascriptInterface
import app.zen.chromium.BridgeAdmission
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray

/**
 * The reply's own hop (compat round 20; round 19 §4's candidate (b)): `ext.send` – the runtime's
 * one message to one frame or extension page, a call's reply or an event – enters the host over
 * this synchronous `@JavascriptInterface` object of the chrome document (`__zenExtHop`) instead
 * of the bridge port, and is posted to the endpoint's reply proxy from the JavaBridge thread it
 * arrives on ([Extensions.sendFromHop]).
 *
 * WHY: round 19 read the storage round trip's `back` leg – the runtime's reply leaving the chrome
 * document to the page's receipt – at 212-292 ms median on WebView 113 and 608-878 ms on the
 * AOSP lane, 97-99.7 % of the whole trip against Chrome's 1-5 ms. A string off the bridge port
 * waits its turn in the app's UI thread queue TWICE (Chromium's `AppWebMessagePort` delivers it
 * on the UI thread and hands it to the port's handler thread; the handler's parse posts the
 * dispatch back to the main thread, which reaches `Extensions.send`), and
 * `JavaScriptReplyProxy.postMessage` then runs at once because it is on the UI thread. A hop
 * enters the host on the JavaBridge thread with no queue at all (0.2-2.4 ms of the chrome's JS
 * thread held across JNI, services perf pass 4's measure) and the proxy's `postMessage` from
 * there is ONE posted UI task (Chromium's `JsReplyProxy.postMessage` is
 * `PostTask.runOrPostTask(UI_USER_VISIBLE, …)` on 113 and on main alike): one UI turn where there
 * were two, and nothing of the reply parsed on the main thread. The chrome's hot path keeps the
 * port (#455's finding stands: a hop's wait is the JS thread's); a reply's frame is small and
 * replies are few, so the hop's trade is the right one here. The candidate that routes the port's
 * string to `Extensions.send` on the handler thread was not built: the proxy would post the UI
 * task the dispatch posted, the same two turns.
 *
 * THE SHAPE: the endpoint id, the message string and the runtime's two stamps (`ext.send`'s `at`
 * while `debug`, a JSON array or null) as three parameters – nothing of the message is parsed
 * here; a message over the bridge's message limit is refused as `callSync` refuses one, never
 * posted (the runtime keeps to half the limit itself: its `messageLimit`). A host without
 * extensions yet (the chrome document's first script before `Host` finished) drops the message,
 * counted. The runtime falls back to the port for a chrome without this object (`Bridge.post` as
 * before: the tests' fakes, a preview host).
 */
class ExtReplyHop(
    private val admission: BridgeAdmission,
    private val extensions: () -> Extensions?
) {
    /** Messages posted on to an endpoint's proxy through this hop. */
    val taken = AtomicInteger()

    /** Messages refused over the limit or dropped for want of a host, logged the first time and every hundredth. */
    val refused = AtomicInteger()

    @JavascriptInterface
    fun send(ep: String?, message: String?, at: String?) {
        if (ep == null || message == null) {
            refuse("a reply without an endpoint or a message")
            return
        }
        if (!admission.admitUnqueued(message.length)) {
            refuse("a reply of ${message.length} chars to $ep over the message limit of ${admission.messageLimitChars} chars")
            return
        }
        val host = extensions()
        if (host == null) {
            refuse("a reply to $ep before the host had extensions")
            return
        }
        val stamps = if (at == null) null else runCatching { JSONArray(at) }.getOrNull()
        taken.incrementAndGet()
        host.sendFromHop(ep, message, stamps)
    }

    private fun refuse(what: String) {
        val count = refused.incrementAndGet()
        if (count == 1 || count % 100 == 0) Log.w(TAG, "$what was dropped ($count so far)")
    }

    companion object {
        const val TAG = "ZenExtHop"

        /** The chrome document's name for the object (`window.__zenExtHop`; `extensionReplyHop.ts`). */
        const val NAME = "__zenExtHop"
    }
}
