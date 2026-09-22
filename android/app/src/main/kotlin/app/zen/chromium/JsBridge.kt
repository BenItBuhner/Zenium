package app.zen.chromium

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * `window.__zenNative` inside the chrome WebView. `call` is asynchronous and answered through
 * `__zenHost.resolve/reject`; `post` is asynchronous and one way (no answer at all); `batch` is
 * `post` for a list of commands in one hop; `callSync` blocks the JS thread and is reserved for
 * boot data and last-chance persistence. All arrive on WebView's bridge thread and are handed to
 * the main thread.
 *
 * Every one of them holds the chrome's JS thread while the WebView carries the string over to
 * this thread and back, a wait that is the device's scheduling more than the parse (the tab
 * swipe profile, #312): the chrome sends a layout report's view ops – four to six of them –
 * through [batch] for that reason, one hop and one main-thread task for the report.
 */
class JsBridge(private val host: Host) {
    private val main = Handler(Looper.getMainLooper())

    /**
     * Chars of the calls handed to the main thread and not yet dispatched. The bridge thread
     * parses a call and posts it, so a main thread slower than the chrome's calls arrive holds
     * every posted one on the heap, arguments and all. An extension's state broadcast on a port
     * at a few hundred KB several times a second (Trust Wallet's to its two pages, compat round
     * 9 row 33) grew that queue until the process died of `OutOfMemoryError`. Past
     * [QUEUE_LIMIT_CHARS] a call is refused instead: a `call` rejected, a `post` or a `batch`
     * dropped, each logged and counted in [refused]. The chrome's own traffic never comes near the limit.
     */
    private val queuedChars = AtomicLong()
    /** Calls refused at [QUEUE_LIMIT_CHARS], for instrumentation. */
    val refused = AtomicInteger()

    /** Posts [block] to the main thread against the queue's limit; false when refused. */
    private fun enqueue(method: String, chars: Int, block: () -> Unit): Boolean {
        val size = chars.toLong()
        if (queuedChars.get() + size > QUEUE_LIMIT_CHARS) {
            val count = refused.incrementAndGet()
            if (count == 1 || count % 100 == 0) Log.w(TAG, "the main thread's queue holds ${queuedChars.get()} chars of calls: $method ($chars chars) refused ($count so far)")
            return false
        }
        queuedChars.addAndGet(size)
        main.post {
            queuedChars.addAndGet(-size)
            block()
        }
        return true
    }

    @JavascriptInterface
    fun call(json: String) {
        val call = try {
            JSONObject(json)
        } catch (e: Exception) {
            Log.w(TAG, "bad call payload", e)
            return
        }
        val id = call.optInt("id")
        val method = call.str("method")
        val args = call.obj("args")
        val queued = enqueue(method, json.length) {
            try {
                host.dispatch(method, args) { result ->
                    if (result is Host.Rejection) host.chrome.reject(id, result.message) else host.chrome.resolve(id, result)
                }
            } catch (e: Exception) {
                Log.w(TAG, "native $method failed", e)
                host.chrome.reject(id, e.message ?: e.javaClass.simpleName)
            }
        }
        if (!queued) main.post { host.chrome.reject(id, QUEUE_FULL) }
    }

    /**
     * One way: dispatched like [call], but nothing goes back to the chrome. For the commands the
     * chrome sends every frame and whose answer it never reads (`chrome.setBarHide`, the bar
     * hide's frame): each `resolve` of a [call] is an `evaluateJavascript` on the chrome's main
     * thread, a task per frame beside the frame's own work (the bar hide profile, #270). A
     * rejection or a failure is logged here instead.
     */
    @JavascriptInterface
    fun post(json: String) {
        val call = try {
            JSONObject(json)
        } catch (e: Exception) {
            Log.w(TAG, "bad post payload", e)
            return
        }
        enqueue(call.str("method"), json.length) { dispatchOneWay(call) }
    }

    /**
     * One way like [post], for a JSON array of `{ method, args }`: the commands run in order in
     * ONE main-thread task, so a layout report's view ops (the bounds, the radius, the cover, a
     * visibility flip, the glance to the front: `TabHost`) land in the same frame of the host's
     * as they left the chrome's, and cost the chrome's thread one hop instead of one each. A
     * command that fails is logged and the rest still run: they are each other's siblings, not
     * each other's premises. Against the queue's limit as one call of the array's size (a batch
     * refused is dropped whole, and logged, like a `post`).
     */
    @JavascriptInterface
    fun batch(json: String) {
        val calls = try {
            JSONArray(json)
        } catch (e: Exception) {
            Log.w(TAG, "bad batch payload", e)
            return
        }
        enqueue("batch of ${calls.length()}", json.length) {
            for (i in 0 until calls.length()) {
                val call = calls.optJSONObject(i)
                if (call == null) Log.w(TAG, "bad batch command at $i") else dispatchOneWay(call)
            }
        }
    }

    /** Dispatch a `{ method, args }` on the main thread with nothing going back to the chrome; a rejection or a failure is logged here instead. */
    private fun dispatchOneWay(call: JSONObject) {
        val method = call.str("method")
        try {
            host.dispatch(method, call.obj("args")) { result ->
                if (result is Host.Rejection) Log.w(TAG, "native $method rejected: ${result.message}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "native $method failed", e)
        }
    }

    @JavascriptInterface
    fun callSync(json: String): String {
        val call = try {
            JSONObject(json)
        } catch (e: Exception) {
            return ""
        }
        return try {
            encodeResult(host.dispatchSync(call.str("method"), call.obj("args")))
        } catch (e: Exception) {
            Log.w(TAG, "native sync ${call.str("method")} failed", e)
            ""
        }
    }

    companion object {
        const val TAG = "ZenBridge"
        /**
         * Chars of parsed calls the main thread may have waiting: 24M chars is 24-48 MB of strings
         * on a heap whose growth limit is 192 MB on the emulator (256-512 MB on phones), a few
         * seconds of a 300-KB broadcast at ten a second.
         */
        const val QUEUE_LIMIT_CHARS = 24L * 1024 * 1024
        const val QUEUE_FULL = "the host's queue is full"
    }
}
