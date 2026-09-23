package app.zen.chromium

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

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
class JsBridge(
    private val host: Host,
    /**
     * The string's admission by its raw length, before any parse: a single string over the heap's
     * message limit, or one the main thread's queue of undispatched calls has no room for, is
     * refused as it came off JNI. The bridge thread parses a call and posts it, so a main thread
     * slower than the chrome's calls arrive holds every posted one on the heap, arguments and all:
     * an extension's state broadcast on a port at a few hundred KB tens of times a second (Trust
     * Wallet's to its worker, compat rounds 9 and 10) grew that queue until the process died of
     * `OutOfMemoryError`, and round 9's cap, checked after the parse and sized without the heap,
     * did not hold it (BridgeAdmission). A refused `call` is rejected with Chrome's error for a
     * message its channel will not carry, a refused `post` or `batch` is dropped, each logged and
     * counted in [refused]. The chrome's own traffic never comes near either limit.
     */
    val admission: BridgeAdmission = BridgeAdmission(Runtime.getRuntime().maxMemory())
) {
    private val main = Handler(Looper.getMainLooper())

    /** Strings refused at either limit, for instrumentation (the driver's per-row `bridgeRefused`). */
    val refused: AtomicInteger get() = admission.refused

    /**
     * Admits [json] by its raw length, reserving it in the queue: null when admitted, the refusal
     * otherwise (logged: the first, then every hundredth; [what] names the call off its head).
     */
    private fun admit(json: String, what: () -> String): BridgeAdmission.Verdict? {
        val verdict = admission.admit(json.length)
        if (verdict === BridgeAdmission.Verdict.Admitted) return null
        val count = refused.get()
        if (count == 1 || count % 100 == 0) {
            val reason = if (verdict === BridgeAdmission.Verdict.TooLong) "over the message limit of ${admission.messageLimitChars} chars" else "the main thread's queue holds ${admission.queuedChars} chars of calls"
            Log.w(TAG, "${what()} (${json.length} chars) refused, $reason ($count so far)")
        }
        return verdict
    }

    /** Parses an admitted string; a malformed one is logged and its reservation returned. */
    private fun parseAdmitted(json: String, kind: String): JSONObject? = try {
        JSONObject(json)
    } catch (e: Exception) {
        admission.release(json.length)
        Log.w(TAG, "bad $kind payload", e)
        null
    }

    /** Posts [block] for an admitted string of [chars] to the main thread; the reservation ends as it runs. */
    private fun dispatchLater(chars: Int, block: () -> Unit) {
        main.post {
            admission.release(chars)
            block()
        }
    }

    @JavascriptInterface
    fun call(json: String) {
        // Admission first, on the raw length: a refused call is never parsed. Its id and method
        // come off the string's head, so the chrome's promise still settles.
        val refusal = admit(json) { BridgeAdmission.head(json)?.method ?: "a call" }
        if (refusal != null) {
            val head = BridgeAdmission.head(json) ?: return
            main.post { host.chrome.reject(head.id, refusal.message ?: BridgeAdmission.MESSAGE_TOO_LONG) }
            return
        }
        val call = parseAdmitted(json, "call") ?: return
        val id = call.optInt("id")
        val method = call.str("method")
        val args = call.obj("args")
        dispatchLater(json.length) {
            try {
                host.dispatch(method, args) { result ->
                    if (result is Host.Rejection) host.chrome.reject(id, result.message) else host.chrome.resolve(id, result)
                }
            } catch (e: Exception) {
                Log.w(TAG, "native $method failed", e)
                host.chrome.reject(id, e.message ?: e.javaClass.simpleName)
            }
        }
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
        if (admit(json) { BridgeAdmission.commandMethod(json) ?: "a post" } != null) return
        val call = parseAdmitted(json, "post") ?: return
        dispatchLater(json.length) { dispatchOneWay(call) }
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
        if (admit(json) { "a batch" } != null) return
        val calls = try {
            JSONArray(json)
        } catch (e: Exception) {
            admission.release(json.length)
            Log.w(TAG, "bad batch payload", e)
            return
        }
        dispatchLater(json.length) {
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
        // Nothing is queued, but nothing over the message limit is parsed either.
        if (!admission.admitUnqueued(json.length)) {
            Log.w(TAG, "a sync call of ${json.length} chars refused, over the message limit of ${admission.messageLimitChars} chars")
            return ""
        }
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
    }
}
