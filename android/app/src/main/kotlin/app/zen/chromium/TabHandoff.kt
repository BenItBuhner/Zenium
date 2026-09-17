package app.zen.chromium

import android.os.Handler
import android.os.Looper
import java.util.UUID

/**
 * The live page a custom tab hands to the browser window ("Open in Zenium"): the WebView, its
 * history and its form state, parked here under a one-time token while the intent that names
 * the token travels to `MainActivity` (same process, so the view itself never has to be
 * serialised). A page nobody collects – the window never came up – is destroyed after a while
 * rather than leaked; the intent's URL still opens as a plain tab then.
 */
object TabHandoff {
    const val EXTRA_TOKEN = "app.zen.chromium.extra.HANDOFF_TOKEN"

    private class Parked(val view: TabWebView, val expire: Runnable)

    private val parked = HashMap<String, Parked>()
    private val main = Handler(Looper.getMainLooper())

    /** Main thread. Returns the token the intent carries. */
    fun park(view: TabWebView): String {
        val token = UUID.randomUUID().toString()
        val expire = Runnable {
            val stale = parked.remove(token) ?: return@Runnable
            runCatching { stale.view.destroy() }
        }
        parked[token] = Parked(view, expire)
        main.postDelayed(expire, EXPIRY_MS)
        return token
    }

    /** Main thread. The parked page for `token`, once; null when it expired or never existed. */
    fun take(token: String?): TabWebView? {
        val entry = parked.remove(token ?: return null) ?: return null
        main.removeCallbacks(entry.expire)
        return entry.view
    }

    private const val EXPIRY_MS = 20_000L
}
