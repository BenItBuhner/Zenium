package app.zen.chromium

import app.zen.chromium.blocking.Decision
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * The host's copy of the core's page-controls policy (`PageRules` in `src/shared/types.ts`):
 * desktop site, dark theme for sites and page zoom, each a default plus the sites that differ.
 * Kept here so a navigation gets its user agent and its viewport before the request leaves and
 * before the document starts – the core's own decision arrives a round trip later and is applied
 * on top for anything this mirror cannot decide (a per-tab override, an internal page).
 *
 * Desktop-site and darkening sites are registrable domains; a URL's host matches by suffix, the
 * longest domain winning, exactly like `siteValue` in `src/shared/pageControls.ts`. Zoom is kept
 * by host, as Chrome's `HostZoomMap` keeps it, and looked up by the host itself (`zoomValue`).
 * Pure and unit-tested.
 */
class PageRules(
    val desktopDefault: Boolean,
    val desktopSites: Map<String, Boolean>,
    val darkenDefault: Boolean,
    val darkenSites: Map<String, Boolean>,
    val zoomDefault: Double,
    val zoomSites: Map<String, Double>,
    /** The system font scale when the default zoom includes it, else 1. */
    val zoomScale: Double,
    val forceZoom: Boolean
) {
    /** What one page gets under these rules. */
    data class Controls(val desktop: Boolean, val darken: Boolean, val zoom: Double, val forceZoom: Boolean)

    fun desktop(url: String): Boolean = if (!isWebPage(url)) false else siteValue(desktopSites, url) ?: desktopDefault

    fun darken(url: String): Boolean = if (!isWebPage(url)) false else siteValue(darkenSites, url) ?: darkenDefault

    /** The effective factor: the host's (or the default) times the scale, to three decimals. */
    fun zoom(url: String): Double {
        if (!isWebPage(url)) return 1.0
        val base = zoomValue(zoomSites, url) ?: zoomDefault
        return (base * zoomScale * 1000).roundToInt() / 1000.0
    }

    fun controls(url: String): Controls = Controls(desktop(url), darken(url), zoom(url), forceZoom)

    companion object {
        val NONE = PageRules(false, emptyMap(), false, emptyMap(), 1.0, emptyMap(), 1.0, false)

        fun isWebPage(url: String): Boolean = url.startsWith("http://", true) || url.startsWith("https://", true)

        /** The zoom stored for the host of `url` itself (`zoomSiteKey` in the shared module). */
        fun zoomValue(sites: Map<String, Double>, url: String): Double? {
            val host = hostOf(url) ?: return null
            return sites[host]
        }

        /** The host of `url` matched by suffix against `sites`; the longest matching domain wins. */
        fun <T> siteValue(sites: Map<String, T>, url: String): T? {
            val host = hostOf(url) ?: return null
            var best: T? = null
            var bestLength = -1
            for ((domain, value) in sites) {
                if ((host == domain || host.endsWith(".$domain")) && domain.length > bestLength) {
                    best = value
                    bestLength = domain.length
                }
            }
            return best
        }

        /**
         * The lower-cased host of an http(s) URL without credentials, port or trailing dot; null
         * for anything else. Hand-rolled so the JVM unit tests need no Android `Uri`.
         */
        fun hostOf(url: String): String? {
            if (!isWebPage(url)) return null
            val authority = authorityOf(url)
            val host = if (authority.startsWith("[")) authority.substringBefore(']').removePrefix("[")
            else authority.substringBefore(':')
            return host.lowercase().trimEnd('.').takeIf { it.isNotEmpty() }
        }

        /**
         * WebView asks `shouldOverrideUrlLoading` for a speculation-rules prerender as it asks
         * for a navigation, marking the request `Sec-Purpose: prefetch;prerender` (Chromium's
         * `AwContentBrowserClient::ShouldOverrideUrlLoading` under `is_prerendering`) – the one
         * place the embedder can veto it. True when the request headers carry the token
         * `prerender` among `Sec-Purpose`'s `;`-separated values, the header name matched in any
         * case; a page cannot forge a `Sec-` header, so the token is the proof. A prefetch alone
         * (`Sec-Purpose: prefetch`) is not a navigation and never reaches the hook.
         */
        fun isPrerender(headers: Map<String, String>?): Boolean {
            headers ?: return false
            for ((name, value) in headers) {
                if (!name.equals("Sec-Purpose", ignoreCase = true)) continue
                if (value.split(';').any { it.trim().equals("prerender", ignoreCase = true) }) return true
            }
            return false
        }

        /**
         * Whether a prerender the page declared is refused (the hook answers true: the prerender
         * cancelled, nothing shown, loaded or recorded). Refused when the engine would not let it
         * go as it stands – Safe Browsing names the address, or the rule sets decide anything but
         * allow – and when it could not run under this view's settings: another site than the
         * document's (one WebView, one set of WebSettings; the sites as [ContentRules.siteOf]
         * spells them, the permission store's origin) or the other desktop-site setting. A
         * target or a document without a web origin has no site to run under, and is refused
         * too. The real tap comes through the hook as itself and is decided then.
         */
        fun prerenderVeto(
            guardHit: Boolean,
            action: Decision.Action,
            targetSite: String?,
            currentSite: String?,
            desktopDiffers: Boolean
        ): Boolean {
            if (guardHit) return true
            if (action != Decision.Action.ALLOW && action != Decision.Action.MODIFY_HEADERS) return true
            if (targetSite == null || currentSite == null || targetSite != currentSite) return true
            return desktopDiffers
        }

        /** What lies between an http(s) URL's `//` and its path, query or fragment, credentials removed. */
        private fun authorityOf(url: String): String {
            val start = url.indexOf("//") + 2
            var end = url.length
            for (i in start until url.length) {
                val c = url[i]
                if (c == '/' || c == '?' || c == '#') {
                    end = i
                    break
                }
            }
            return url.substring(start, end).substringAfterLast('@')
        }

        /** Parse the core's `view.setPageRules` payload; anything malformed falls back to the defaults. */
        fun fromJson(o: JSONObject): PageRules {
            val desktop = o.optJSONObject("desktop") ?: JSONObject()
            val darken = o.optJSONObject("darken") ?: JSONObject()
            val zoom = o.optJSONObject("zoom") ?: JSONObject()
            return PageRules(
                desktopDefault = desktop.optBoolean("default", false),
                desktopSites = booleanMap(desktop.optJSONObject("sites")),
                darkenDefault = darken.optBoolean("default", false),
                darkenSites = booleanMap(darken.optJSONObject("sites")),
                zoomDefault = zoom.optDouble("default", 1.0).takeIf { it.isFinite() && it > 0 } ?: 1.0,
                zoomSites = doubleMap(zoom.optJSONObject("sites")),
                zoomScale = zoom.optDouble("scale", 1.0).takeIf { it.isFinite() && it > 0 } ?: 1.0,
                forceZoom = o.optBoolean("forceZoom", false)
            )
        }

        private fun booleanMap(o: JSONObject?): Map<String, Boolean> {
            o ?: return emptyMap()
            val out = HashMap<String, Boolean>()
            for (key in o.keys()) {
                val v = o.opt(key)
                if (v is Boolean && key.isNotEmpty()) out[key.lowercase()] = v
            }
            return out
        }

        private fun doubleMap(o: JSONObject?): Map<String, Double> {
            o ?: return emptyMap()
            val out = HashMap<String, Double>()
            for (key in o.keys()) {
                val v = o.optDouble(key, Double.NaN)
                if (v.isFinite() && v > 0 && key.isNotEmpty()) out[key.lowercase()] = v
            }
            return out
        }
    }
}
