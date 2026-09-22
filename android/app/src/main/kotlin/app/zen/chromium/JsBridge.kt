package app.zen.chromium

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

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
        main.post {
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
        val call = try {
            JSONObject(json)
        } catch (e: Exception) {
            Log.w(TAG, "bad post payload", e)
            return
        }
        main.post { dispatchOneWay(call) }
    }

    /**
     * One way like [post], for a JSON array of `{ method, args }`: the commands run in order in
     * ONE main-thread task, so a layout report's view ops (the bounds, the radius, the cover, a
     * visibility flip, the glance to the front: `TabHost`) land in the same frame of the host's
     * as they left the chrome's, and cost the chrome's thread one hop instead of one each. A
     * command that fails is logged and the rest still run: they are each other's siblings, not
     * each other's premises.
     */
    @JavascriptInterface
    fun batch(json: String) {
        val calls = try {
            JSONArray(json)
        } catch (e: Exception) {
            Log.w(TAG, "bad batch payload", e)
            return
        }
        main.post {
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
    }
}
