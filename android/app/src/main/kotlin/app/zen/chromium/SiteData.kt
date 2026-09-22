package app.zen.chromium

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewFeature
import app.zen.chromium.blocking.Domains
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The WebView's knowledge of one site for the site-information sheet and of every site for the
 * site-data viewer: which cookies a page receives, how much a site stores, and how to take both
 * away again – per container, since every container is its own WebView profile with its own jar
 * and quota manager. Only names and attributes leave this class; cookie values stay in the jar.
 * The reasoning about the jar's answers is in [CookieJar], which has no Android in it.
 */
class SiteData {
    private val main = Handler(Looper.getMainLooper())

    /** The viewer's jar reads (one `getCookie` per origin, hundreds of them) run here, off the main thread. */
    private val reader = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-sitedata") }

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
     * Every origin of the container with data, for the site-data viewer: the quota manager's
     * origins with their usage (`WebStorage.getOrigins`) and, of the `probe` origins the core
     * knows of (visited, with permissions), those holding cookies – WebView's jar cannot be
     * enumerated, so an origin that left cookies alone is found only when the core asks after
     * it. A cookie count is what a page of the origin receives (`getCookie`), so a domain cookie
     * counts under every host of its site the list holds. `[{ origin, cookies, usageBytes }]`,
     * at most [ORIGIN_LIMIT] rows; the jar is read off the main thread.
     */
    fun listOrigins(containerId: String, probe: JSONArray, reply: (Any?) -> Unit) {
        val jar = Profiles.cookieManager(containerId)
        val storage = Profiles.webStorage(containerId)
        storage.getOrigins { raw ->
            val stored = ArrayList<Pair<String, Long>>()
            val entries = (raw as? Map<*, *>)?.values ?: emptyList<Any?>()
            for (entry in entries) {
                val origin = entry as? WebStorage.Origin ?: continue
                val key = Domains.originOf(origin.origin) ?: continue
                stored.add(key to origin.usage)
                if (stored.size >= ORIGIN_LIMIT) break
            }
            val probes = ArrayList<String>()
            for (i in 0 until probe.length()) {
                if (probes.size >= PROBE_LIMIT) break
                Domains.originOf(probe.optString(i))?.let { if (it !in probes) probes.add(it) }
            }
            reader.execute {
                val rows = originRows(stored, probes) { origin -> CookieJar.parse(runCatching { jar.getCookie("$origin/") }.getOrNull()).size }
                main.post { reply(rows) }
            }
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

    companion object {
        /** The viewer's cap (`SITE_DATA_ORIGIN_CAP` in the core). */
        const val ORIGIN_LIMIT = 1000

        /** Probed origins per call: each is one synchronous read of the jar. */
        const val PROBE_LIMIT = 500

        /**
         * The viewer's rows from the quota manager's `stored` origins (with their usage) and the
         * core's `probes`, each origin's cookies counted through `cookies`: a stored origin is a
         * row whatever it holds; a probed one only when it holds cookies. Pure, for the tests.
         */
        fun originRows(stored: List<Pair<String, Long>>, probes: List<String>, cookies: (String) -> Int): JSONArray {
            val out = JSONArray()
            val seen = HashSet<String>()
            for ((origin, usage) in stored) {
                if (!seen.add(origin)) continue
                out.put(json("origin" to origin, "cookies" to cookies(origin), "usageBytes" to usage))
            }
            for (origin in probes) {
                if (out.length() >= ORIGIN_LIMIT) break
                if (!seen.add(origin)) continue
                val count = cookies(origin)
                if (count > 0) out.put(json("origin" to origin, "cookies" to count, "usageBytes" to JSONObject.NULL))
            }
            return out
        }
    }
}
