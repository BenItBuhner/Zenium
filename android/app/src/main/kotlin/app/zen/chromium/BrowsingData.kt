package app.zen.chromium

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/**
 * The engine's share of Clear browsing data on Android: cookies, site storage and the HTTP
 * cache of the given containers, each a WebView profile of its own (see [Profiles]). The core
 * clears what it owns itself (history, downloads, passwords, permissions) and asks here for the
 * rest; the same steps end a private session.
 *
 * What the WebView can say about its data is thin: cookies cannot be enumerated and the cache
 * has no size, so the preview counts the sites that hold quota-managed storage and leaves the
 * cache uncounted.
 */
object BrowsingData {
    /** One WebView call of a clearing run. */
    enum class Step { COOKIES, STORAGE, ALL_SITE_DATA, CACHE }

    /**
     * Which calls clear `kinds` (`cookies`, `storage`, `cache`). When the WebView has the one-shot
     * delete and both cookies and storage are asked for, that one call goes: it also takes the
     * service workers and everything else a site registered, which the two older calls miss.
     * Pure, for the tests; [clear] runs the steps.
     */
    fun plan(kinds: Set<String>, oneShotDelete: Boolean): List<Step> {
        val out = ArrayList<Step>()
        val cookies = "cookies" in kinds
        val storage = "storage" in kinds
        if (cookies && storage && oneShotDelete) {
            out += Step.ALL_SITE_DATA
        } else {
            if (cookies) out += Step.COOKIES
            if (storage) out += Step.STORAGE
        }
        if ("cache" in kinds) out += Step.CACHE
        return out
    }

    /** Distinct sites (registrable domains) behind storage origins: the dialog's "from N sites". */
    fun siteCount(origins: Iterable<String>): Int =
        origins.mapNotNull { CookieJar.Target.of(it)?.host }.map(CookieJar::registrableDomain).toSet().size

    /**
     * The count the preview shows for cookies and site data, or null for "unknown": the WebView
     * cannot list cookies, and `WebStorage.getOrigins` names only quota-managed storage (the Web
     * SQL and AppCache era – empty on current WebViews however many sites set cookies), so an
     * empty answer is no answer, not "0 sites", while a non-empty one is a lower bound worth showing.
     */
    fun cookieSites(origins: Iterable<String>): Int? = siteCount(origins).takeIf { it > 0 }

    val oneShotDelete: Boolean
        get() = WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)

    /** Lazily: the planner and the counting above run in plain JVM tests, without a main looper. */
    private val main by lazy { Handler(Looper.getMainLooper()) }

    /**
     * Clear `kinds` for every container in `containerIds`; `done` runs on the main thread once
     * every asynchronous WebView call answered. `webViewFor` yields a WebView on a container's
     * profile for the cache, which only a WebView can clear (a live tab, or a throwaway one).
     *
     * A container's stores are those of its own profile ([Profiles.ownStores]); a container that
     * has none on this WebView – every one but the default on a WebView without profiles – is
     * left out rather than have the default profile's data go in its name.
     */
    fun clear(
        context: Context,
        containerIds: List<String>,
        kinds: Set<String>,
        webViewFor: (String) -> WebView?,
        done: () -> Unit
    ) {
        val steps = plan(kinds, oneShotDelete)
        if (steps.isEmpty() || containerIds.isEmpty()) {
            done()
            return
        }
        var pending = 1
        val finish = { if (--pending == 0) done() }
        val await = { pending++; { main.post(finish) } }
        for (containerId in containerIds.toSet()) {
            val stores = Profiles.ownStores(containerId)
            if (stores == null) {
                Log.w(TAG, "container $containerId has no profile of its own on this WebView: its data is the default profile's, left as it is")
                continue
            }
            for (step in steps) {
                when (step) {
                    Step.COOKIES -> {
                        val jar = stores.cookies
                        val settle = await()
                        jar.removeAllCookies { settle() }
                        jar.flush()
                    }
                    Step.STORAGE -> stores.storage.deleteAllData()
                    Step.ALL_SITE_DATA -> {
                        val storage = stores.storage
                        val settle = await()
                        val started = runCatching { WebStorageCompat.deleteBrowsingData(storage) { settle() } }
                        if (started.isFailure) {
                            stores.cookies.removeAllCookies(null)
                            storage.deleteAllData()
                            settle()
                        }
                    }
                    Step.CACHE -> clearCache(context, containerId, webViewFor)
                }
            }
        }
        finish()
    }

    /**
     * The HTTP cache belongs to the profile but is cleared through a WebView on it; without a live
     * tab of the container a throwaway view does it and is destroyed at once.
     */
    private fun clearCache(context: Context, containerId: String, webViewFor: (String) -> WebView?) {
        val live = webViewFor(containerId)
        if (live != null) {
            runCatching { live.clearCache(true) }
            return
        }
        runCatching {
            val view = WebView(context)
            try {
                Profiles.apply(view, containerId)
                view.clearCache(true)
            } finally {
                view.destroy()
            }
        }
    }

    /**
     * `{ cookieSites, cacheBytes }` across `containerIds`: sites with quota-managed storage (see
     * [cookieSites]), and null for the cache the WebView cannot measure. `reply` runs on the main
     * thread.
     */
    fun counts(containerIds: List<String>, reply: (JSONObject) -> Unit) {
        val ids = containerIds.toSet().toList()
        if (ids.isEmpty()) {
            reply(json("cookieSites" to 0, "cacheBytes" to JSONObject.NULL))
            return
        }
        val origins = ArrayList<String>()
        var pending = ids.size
        val answer = { reply(json("cookieSites" to (cookieSites(origins) ?: JSONObject.NULL), "cacheBytes" to JSONObject.NULL)) }
        for (containerId in ids) {
            val storage = Profiles.webStorage(containerId)
            val received = runCatching {
                storage.getOrigins { raw ->
                    val entries = (raw as? Map<*, *>)?.values ?: emptyList<Any?>()
                    for (entry in entries) (entry as? WebStorage.Origin)?.let { origins += it.origin }
                    main.post { if (--pending == 0) answer() }
                }
            }
            if (received.isFailure) main.post { if (--pending == 0) answer() }
        }
    }

    fun strings(array: JSONArray): List<String> = (0 until array.length()).mapNotNull { array.optString(it).takeIf(String::isNotEmpty) }

    private const val TAG = "ZenBrowsingData"
}
