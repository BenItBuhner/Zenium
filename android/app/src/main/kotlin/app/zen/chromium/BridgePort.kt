package app.zen.chromium

import android.net.Uri
import android.os.Handler
import android.util.Log
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.atomic.AtomicInteger

/**
 * The asynchronous channel of the chrome's bridge (services perf pass 2, #455's finding): a
 * `WebMessageChannel` per chrome document, its page end posted to the document when the page asks
 * for it (`bridge.port`, `bridge.ts` `openBridgePort`), its host end read on a background handler
 * and every string routed BY ITS SHAPE into the route its hop would have taken ([JsBridge.route]
 * → [JsBridge.Calls]: a JSON array is a batch, an envelope with an id a call, one without a post;
 * admission by raw length first, a storage call to the storage thread as the raw string, anything
 * else parsed on the reading thread and dispatched on the main thread) – the dispatch the
 * synchronous hops already used, reached without the hop.
 *
 * WHY: every `@JavascriptInterface` entry point holds the chrome's JS thread across the JNI hop
 * until the Java method returns, a wait that is the JavaBridge thread's scheduling (4–68 ms per
 * storage write inside the thirty-tab overview fold on the emulator, with a millisecond of it on
 * the CPU; 52 hops and 182 ms of the JS thread across the tab swipe and the overview in #469's
 * runs). `port.postMessage(string)` on the page side is a Mojo pipe write that returns at once;
 * a call's reply still goes back through `__zenHost.resolve/reject` once the work is done.
 *
 * THE THREADS: the WebView receives a port message on the UI thread (Chromium's
 * `AppWebMessagePort.onMessage`, one task of a memcpy's size per message) and hands it to the
 * handler's thread, where [Receiver.onMessage] runs; nothing of the message is parsed on the main
 * thread. THE PORT IS THE BRIDGE (services perf pass 4; the storage class came through it in
 * #458, the thumbnail read in #469): once the page holds it, every `call`, `post` and `batch`
 * comes through it and none through the hops – `callSync` alone stays a hop, synchronous by
 * nature – so the host decides nothing about what the channel carries: it routes whatever
 * arrives by its shape. THE ORDER: one channel read on one thread, each string posted to the
 * main thread (or handed to the storage thread) as it is read, so the main thread's dispatch
 * order is the page's order across the kinds, a batch one task as through the hop – and a string
 * the page sent before it held the port went through the hop, which handed it over before the
 * page went on. THE FALLBACK: a WebView without the features ([supported]) opens nothing, the
 * page is told so and keeps the hops. THE TEARDOWN: [close] with the document (replaced, rebuilt,
 * destroyed – `ChromeWebView`); the page end was transferred and dies with its document, and a
 * string of the dying document's posted into the closed channel is dropped by the platform, not
 * reordered – the one loss the channel allows, bounded by the document's own end.
 */
class BridgePort private constructor(
    private val port: WebMessagePortCompat,
    /** The platform-free half, for the tests; the diagnostics read its count. */
    val receiver: Receiver
) {
    /**
     * What the channel does with what arrives, apart from the platform: a string is routed into
     * the bridge's route by shape ([JsBridge.route]: a call's, a post's or a batch's, whose
     * admission comes first), anything else is dropped and logged, and after [close] nothing is
     * routed – a message the platform still delivers for a channel the host has torn down is a
     * string from a document that is gone.
     */
    class Receiver(
        /** The bridge's route by shape ([JsBridge.route]): admission, then the parse and the dispatch on their threads. */
        private val route: (json: String) -> Unit,
        private val log: (message: String) -> Unit
    ) {
        @Volatile
        var closed = false
            private set

        /** Strings routed so far (the host's diagnostics, the tests). */
        val received = AtomicInteger()

        /** Strings that were not (no string in the message, or the channel closed), logged the first time and every hundredth. */
        val dropped = AtomicInteger()

        /** A message off the port, on the handler's thread. */
        fun onMessage(data: String?) {
            if (closed || data == null) {
                val count = dropped.incrementAndGet()
                if (count == 1 || count % 100 == 0) log(if (closed) "a port message after the channel closed was dropped ($count so far)" else "a port message without a string was dropped ($count so far)")
                return
            }
            received.incrementAndGet()
            route(data)
        }

        fun close() {
            closed = true
        }
    }

    /** Tear the channel down: nothing arriving is routed from here, and the host end is closed (the page end went with its document). */
    fun close() {
        receiver.close()
        runCatching { port.close() }.onFailure { Log.w(TAG, "closing the port", it) }
    }

    companion object {
        const val TAG = "ZenBridgePort"

        /**
         * Whether this WebView has the channel: the features the host end needs, each asked of
         * `WebViewFeature` (the framework's since API 23, the WebView's own before it); one
         * missing and the page keeps the hop.
         */
        fun supported(): Boolean =
            WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_CLOSE)

        /**
         * Open a channel on [view] (main thread): the host end's callback on [handler]'s thread
         * routing into [route], the page end posted to the document at [origin] with [token] as
         * the message – the token the page's listener wants back. Null when the WebView lacks the
         * features or refused, logged; the page then keeps the hop.
         */
        fun open(view: WebView, token: String, origin: Uri, handler: Handler, route: (json: String) -> Unit): BridgePort? {
            if (!supported()) {
                Log.i(TAG, "this WebView has no message channel; every kind keeps the hop")
                return null
            }
            return runCatching {
                val ports = WebViewCompat.createWebMessageChannel(view)
                val receiver = Receiver(route) { Log.w(TAG, it) }
                val channel = BridgePort(ports[0], receiver)
                ports[0].setWebMessageCallback(handler, object : WebMessagePortCompat.WebMessageCallbackCompat() {
                    override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                        receiver.onMessage(message?.takeIf { it.type == WebMessageCompat.TYPE_STRING }?.data)
                    }
                })
                WebViewCompat.postWebMessage(view, WebMessageCompat(token, arrayOf(ports[1])), origin)
                Log.i(TAG, "channel open for $origin; the port is the bridge from here (every call, post and batch)")
                channel
            }.onFailure { Log.w(TAG, "the channel could not be opened; every kind keeps the hop", it) }.getOrNull()
        }
    }
}
