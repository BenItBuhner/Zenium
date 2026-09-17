package app.zen.chromium

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/**
 * The WebView's knowledge of one site for the site-information sheet: which cookies a page
 * receives, how much the site stores, and how to take both away again – per container, since
 * every container is its own WebView profile with its own jar and quota manager. Only names and
 * attributes leave this class; cookie values stay in the jar. The reasoning about the jar's
 * answers is in [CookieJar], which has no Android in it.
 */
class SiteData {
    private val main = Handler(Looper.getMainLooper())

    /** `[{ name, domain, secure, size }]` for the page at `url`. */
    fun cookies(containerId: String, url: String): JSONArray {
        val target = CookieJar.Target.of(url) ?: return JSONArray()
        val jar = Profiles.cookieManager(containerId)
        return CookieJar.toJson(CookieJar.classify(target) { CookieJar.parse(jar.getCookie(it)) })
    }

    /**
     * Expire every cookie the page at `url` receives, under each domain and path it may be
     * scoped to, then read again: `{ removed, remaining }`.
     */
    fun clearCookies(containerId: String, url: String, reply: (Any?) -> Unit) {
        val target = CookieJar.Target.of(url)
        if (target == null) {
            reply(json("removed" to 0, "remaining" to 0))
            return
        }
        val jar = Profiles.cookieManager(containerId)
        val before = CookieJar.parse(jar.getCookie(target.pageUrl))
        val headers = CookieJar.expiryHeaders(before.map { it.name }, target)
        if (headers.isEmpty()) {
            reply(json("removed" to 0, "remaining" to before.size))
            return
        }
        var pending = headers.size
        val finish = {
            jar.flush()
            val remaining = CookieJar.parse(jar.getCookie(target.pageUrl)).size
            reply(json("removed" to (before.size - remaining).coerceAtLeast(0), "remaining" to remaining))
        }
        for ((setUrl, header) in headers) {
            jar.setCookie(setUrl, header) { main.post { if (--pending == 0) finish() } }
        }
    }

    /**
     * Quota-managed storage of `site` (IndexedDB, Cache API, …): the origins of the site that
     * hold data and their summed usage. Web Storage is not quota-managed on Android; the page
     * itself reports that part.
     */
    fun storage(containerId: String, site: String, reply: (Any?) -> Unit) {
        val storage = Profiles.webStorage(containerId)
        storage.getOrigins { raw ->
            val origins = JSONArray()
            var usage = 0L
            var quota = 0L
            val entries = (raw as? Map<*, *>)?.values ?: emptyList<Any?>()
            for (entry in entries) {
                val origin = entry as? WebStorage.Origin ?: continue
                if (!CookieJar.originBelongsTo(origin.origin, site)) continue
                origins.put(origin.origin)
                usage += origin.usage
                quota = maxOf(quota, origin.quota)
            }
            reply(
                json(
                    "usageBytes" to usage,
                    "quotaBytes" to if (quota > 0) quota else JSONObject.NULL,
                    "origins" to origins
                )
            )
        }
    }

    /**
     * Delete what `site` stored. WebViews that can (`DELETE_BROWSING_DATA`) wipe the whole site –
     * cookies, Web Storage, IndexedDB, caches, service workers, across its subdomains – in one
     * call; older ones delete the quota-managed data of the given origins (the page has already
     * cleared its own Web Storage and unregistered its workers by then).
     */
    fun clearStorage(containerId: String, site: String, origins: JSONArray, reply: (Any?) -> Unit) {
        val storage = Profiles.webStorage(containerId)
        if (site.isNotEmpty() && WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
            val started = runCatching {
                WebStorageCompat.deleteBrowsingDataForSite(storage, site) { main.post { reply(json("ok" to true, "scope" to "site")) } }
            }
            if (started.isSuccess) return
        }
        for (i in 0 until origins.length()) {
            val origin = origins.optString(i)
            if (origin.isNotEmpty()) runCatching { storage.deleteOrigin(origin) }
        }
        reply(json("ok" to true, "scope" to "origins"))
    }
}
