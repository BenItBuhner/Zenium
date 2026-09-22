package app.zen.chromium

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * `window.__zenNative` inside the chrome WebView. `call` is asynchronous and answered through
 * `__zenHost.resolve/reject`; `post` is asynchronous and one way (no answer at all); `callSync`
 * blocks the JS thread and is reserved for boot data and last-chance persistence. All arrive on
 * WebView's bridge thread and are handed to the main thread.
 */
class JsBridge(private val host: Host) {
    private val main = Handler(Looper.getMainLooper())

    /**
     * Chars of the calls handed to the main thread and not yet dispatched. The bridge thread
     * parses a call and posts it, so a main thread slower than the chrome's calls arrive holds
     * every posted one on the heap, arguments and all. An extension's state broadcast on a port
     * at a few hundred KB several times a second (Trust Wallet's to its two pages, compat round
     * 9 row 33) grew that queue until the process died of `OutOfMemoryError`. Past
     * [QUEUE_LIMIT_CHARS] a call is refused instead: a `call` rejected, a `post` dropped, each
     * logged and counted in [refused]. The chrome's own traffic never comes near the limit.
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
        val method = call.str("method")
        val args = call.obj("args")
        enqueue(method, json.length) {
            try {
                host.dispatch(method, args) { result ->
                    if (result is Host.Rejection) Log.w(TAG, "native $method rejected: ${result.message}")
                }
            } catch (e: Exception) {
                Log.w(TAG, "native $method failed", e)
            }
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
