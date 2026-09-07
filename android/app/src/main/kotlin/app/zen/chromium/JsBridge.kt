package app.zen.chromium

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * `window.__zenNative` inside the chrome WebView. `call` is asynchronous and answered through
 * `__zenHost.resolve/reject`; `callSync` blocks the JS thread and is reserved for boot data and
 * last-chance persistence. Both arrive on WebView's bridge thread and are handed to the main thread.
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
                host.dispatch(method, args) { result -> host.chrome.resolve(id, result) }
            } catch (e: Exception) {
                Log.w(TAG, "native $method failed", e)
                host.chrome.reject(id, e.message ?: e.javaClass.simpleName)
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
    }
}
