package app.zen.chromium

import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * The host's copy of the core's page-controls policy (`PageRules` in `src/shared/types.ts`):
 * desktop site, dark theme for sites and page zoom, each a default plus the sites that differ.
 * Kept here so a navigation gets its user agent and its viewport before the request leaves and
 * before the document starts – the core's own decision arrives a round trip later and is applied
 * on top for anything this mirror cannot decide (a per-tab override, an internal page).
 *
 * Sites are registrable domains; a URL's host matches by suffix, the longest domain winning,
 * exactly like `siteValue` in `src/shared/pageControls.ts`. Pure and unit-tested.
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

    /** The effective factor: the site's (or the default) times the scale, to three decimals. */
    fun zoom(url: String): Double {
        if (!isWebPage(url)) return 1.0
        val base = siteValue(zoomSites, url) ?: zoomDefault
        return (base * zoomScale * 1000).roundToInt() / 1000.0
    }

    fun controls(url: String): Controls = Controls(desktop(url), darken(url), zoom(url), forceZoom)

    companion object {
        val NONE = PageRules(false, emptyMap(), false, emptyMap(), 1.0, emptyMap(), 1.0, false)

        fun isWebPage(url: String): Boolean = url.startsWith("http://", true) || url.startsWith("https://", true)

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
            val start = url.indexOf("//") + 2
            var end = url.length
            for (i in start until url.length) {
                val c = url[i]
                if (c == '/' || c == '?' || c == '#') {
                    end = i
                    break
                }
            }
            var authority = url.substring(start, end)
            authority = authority.substringAfterLast('@')
            val host = if (authority.startsWith("[")) authority.substringBefore(']').removePrefix("[")
            else authority.substringBefore(':')
            return host.lowercase().trimEnd('.').takeIf { it.isNotEmpty() }
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
