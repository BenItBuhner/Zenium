package app.zen.chromium.ext

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import androidx.webkit.CookieManagerCompat
import androidx.webkit.WebViewFeature
import app.zen.chromium.Profiles
import app.zen.chromium.json
import org.json.JSONArray
import org.json.JSONObject

/**
 * The jar half of `chrome.cookies` (`src/android/extensionCookies.ts` does Chrome's part): one
 * `CookieManager` per container ([Profiles.cookieManager]), read by URL. A WebView with
 * `GET_COOKIE_INFO` (Chromium 120+) lists each cookie in `Set-Cookie` syntax, attributes and all;
 * an older one only knows the `name=value` pairs a request would send, and says so (`detailed`).
 * Writes go through `setCookie` with its callback, which needs a thread with a Looper: the main
 * thread here, as the WebView's own work is.
 */
class ExtensionCookies(private val cookieManagerFor: (String) -> CookieManager = Profiles::cookieManager) {
    private val main = Handler(Looper.getMainLooper())

    /** Whether the WebView lists cookies with their attributes. */
    val detailed: Boolean by lazy { WebViewFeature.isFeatureSupported(WebViewFeature.GET_COOKIE_INFO) }

    /** `{ cookies: [...], detailed }` for `url` in the container's jar. */
    fun read(container: String, url: String): JSONObject {
        val manager = cookieManagerFor(container)
        val lines: List<String> = if (detailed) {
            runCatching { CookieManagerCompat.getCookieInfo(manager, url) }.getOrNull() ?: emptyList()
        } else {
            splitHeader(manager.getCookie(url))
        }
        return json("cookies" to JSONArray(lines), "detailed" to detailed)
    }

    /** Store one `Set-Cookie` line against `url`; `done(true)` (on the main thread) when the jar took it. */
    fun write(container: String, url: String, setCookie: String, done: (Any?) -> Unit) {
        val manager = cookieManagerFor(container)
        main.post {
            runCatching {
                manager.setCookie(url, setCookie) { ok -> done(ok == true) }
            }.onFailure { done(false) }
        }
    }

    companion object {
        /** `a=1; b=2` → `["a=1", "b=2"]` (the `Cookie` header form `getCookie` returns). */
        fun splitHeader(header: String?): List<String> {
            if (header.isNullOrBlank()) return emptyList()
            return header.split(';').map { it.trim() }.filter { it.isNotEmpty() }
        }
    }
}
