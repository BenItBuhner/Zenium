package app.zen.chromium

import android.webkit.WebSettings
import app.zen.chromium.ext.ExtensionUrls
import org.json.JSONObject
import java.net.IDN

/**
 * The host's copy of the core's per-site content rules document (`ContentRules` in
 * `src/shared/contentRules.ts`): images, JavaScript, insecure content, sensors, third-party
 * sign-in and payment handlers, each a default plus the sites that differ – the permission
 * store's part alone. The decision for a navigation is the core's (`PermissionService.resolve`:
 * an extension's `chrome.contentSettings` rule over the user's answer, in the tab's own
 * container, over the default), which the core hands over as a [Resolved] answer per navigation
 * ([TabWebView.applyContentRules]: with its own `view.load`, or on the question the WebView asks
 * for a navigation the page started). This document is what a navigation the core could not be
 * asked about falls back to, and the defaults of any row the answer leaves out.
 *
 * Sites are permission-store origins (`https://example.com`, a non-default port kept, `file://`
 * for every local file), matched exactly – the twin of `contentRuleSite`. Pure and unit-tested.
 */
class ContentRules(private val rows: Map<String, Row>) {
    /** One setting: what sites without an answer of their own get, and the sites with one (true = allow). */
    class Row(val default: Boolean, val sites: Map<String, Boolean>)

    /**
     * The core's word for one site (`ContentRulesService.resolveAll`): every row's effective
     * answer for the tab's navigation there (true = allow), read ahead of the document's rows for
     * a document of that site alone. Handed to the page script as `window.__zenResolvedRules`
     * (`{ site, allowed }`, `ResolvedContentRulesFor`) for the document-start guards.
     */
    class Resolved(val site: String, val allowed: Map<String, Boolean>) {
        fun toJson(): JSONObject = JSONObject().put("site", site).put("allowed", JSONObject(allowed))

        companion object {
            /** The core's answer for `site` (`view.load`'s `rules`, `view.rulesResolved`'s): a boolean per row it names. */
            fun fromJson(site: String, o: JSONObject): Resolved {
                val allowed = HashMap<String, Boolean>()
                for (id in IDS) {
                    val value = o.opt(id)
                    if (value is Boolean) allowed[id] = value
                }
                return Resolved(site, allowed)
            }
        }
    }

    /**
     * Whether `id` is allowed for a document at `url`: the core's [resolved] answer when it is
     * this site's and names the row, else the site's own line of the document, else the row's default.
     */
    fun allows(id: String, url: String, resolved: Resolved? = null): Boolean {
        val site = siteOf(url)
        if (resolved != null && site != null && resolved.site == site) resolved.allowed[id]?.let { return it }
        val row = rows[id] ?: return DEFAULT_ALLOW[id] ?: true
        site ?: return row.default
        return row.sites[site] ?: row.default
    }

    /** The guarded rows a document at `url` is refused, for the page script (`blockedGuardsWith`). */
    fun blockedGuards(url: String, resolved: Resolved? = null): List<String> = GUARDED.filter { !allows(it, url, resolved) }

    /**
     * The view's `WebSettings.mixedContentMode` for a document (PS-59): an extension's own page
     * and a web page whose Insecure content row says Allow run their plaintext parts
     * (`MIXED_CONTENT_ALWAYS_ALLOW`); every other document follows the HTTPS-only setting –
     * `NEVER_ALLOW` under "always", else the engine's own block (`COMPATIBILITY_MODE`, Chrome's
     * default: active content blocked, the rest as the engine sees fit).
     */
    fun mixedContentMode(documentUrl: String?, httpsOnly: String?, resolved: Resolved? = null): Int = when {
        documentUrl != null && ExtensionUrls.isExtensionUrl(documentUrl) -> WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        documentUrl != null && PageRules.isWebPage(documentUrl) && allows(INSECURE_CONTENT, documentUrl, resolved) ->
            WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        httpsOnly == "always" -> WebSettings.MIXED_CONTENT_NEVER_ALLOW
        else -> WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
    }

    companion object {
        const val IMAGES = "images"
        const val JAVASCRIPT = "javascript"
        const val INSECURE_CONTENT = "insecure-content"
        const val SENSORS = "sensors"
        const val THIRD_PARTY_SIGN_IN = "third-party-sign-in"
        const val PAYMENT_HANDLER = "payment-handler"

        val IDS = listOf(IMAGES, JAVASCRIPT, INSECURE_CONTENT, SENSORS, THIRD_PARTY_SIGN_IN, PAYMENT_HANDLER)
        /** The rows a page-world guard enforces (`GUARDED_CONTENT_RULES`). */
        val GUARDED = listOf(SENSORS, THIRD_PARTY_SIGN_IN, PAYMENT_HANDLER)
        /** The catalogue's defaults where a row is missing: everything allowed but insecure content. */
        private val DEFAULT_ALLOW = mapOf(INSECURE_CONTENT to false)

        val NONE = ContentRules(emptyMap())

        /**
         * The permission-store site of `url`: its origin – scheme and lower-cased host, the port
         * only when it is not the scheme's default – as `new URL(url).origin` spells it; `file://`
         * for a local file; null for a URL without one (`zen://`, `about:blank`, `data:`).
         */
        fun siteOf(url: String): String? {
            val lower = url.lowercase()
            if (lower.startsWith("file:")) return "file://"
            val scheme = when {
                lower.startsWith("https://") -> "https"
                lower.startsWith("http://") -> "http"
                else -> return null
            }
            val start = scheme.length + 3
            var end = url.length
            for (i in start until url.length) {
                val c = url[i]
                if (c == '/' || c == '?' || c == '#' || c == '\\') {
                    end = i
                    break
                }
            }
            val authority = url.substring(start, end).substringAfterLast('@')
            val host: String
            val portText: String
            if (authority.startsWith("[")) {
                val close = authority.indexOf(']')
                if (close < 0) return null
                host = authority.substring(0, close + 1).lowercase()
                portText = authority.substring(close + 1).removePrefix(":")
            } else {
                host = asciiHost(authority.substringBefore(':')) ?: return null
                portText = if (authority.contains(':')) authority.substringAfter(':') else ""
            }
            if (host.isEmpty()) return null
            val port = if (portText.isEmpty()) null else portText.toIntOrNull() ?: return null
            val defaultPort = if (scheme == "https") 443 else 80
            return if (port == null || port == defaultPort) "$scheme://$host" else "$scheme://$host:$port"
        }

        /**
         * The referrer a navigation the WebView held for the core's answer is resumed with
         * ([TabWebView] re-issues it as a load of its own, which carries none by itself): Chrome's
         * default policy, `strict-origin-when-cross-origin` – the page's address without its
         * fragment for a destination of the same origin, the origin alone across origins, nothing
         * from HTTPS down to HTTP or for a page or a destination without a web origin. A page's
         * own stricter policy is not read here.
         */
        fun resumeReferer(from: String?, to: String): String? {
            if (from == null) return null
            val fromSite = siteOf(from) ?: return null
            val toSite = siteOf(to) ?: return null
            if (!fromSite.startsWith("http") || !toSite.startsWith("http")) return null
            if (fromSite.startsWith("https://") && toSite.startsWith("http://")) return null
            return if (fromSite == toSite) from.substringBefore('#') else "$fromSite/"
        }

        private fun asciiHost(host: String): String? {
            val lower = host.lowercase()
            if (lower.all { it.code < 128 }) return lower
            return try {
                IDN.toASCII(lower, IDN.ALLOW_UNASSIGNED).lowercase()
            } catch (_: IllegalArgumentException) {
                lower
            }
        }

        /** Parse the core's `view.setContentRules` payload; anything malformed falls back to the defaults. */
        fun fromJson(o: JSONObject): ContentRules {
            val rows = HashMap<String, Row>()
            for (id in IDS) {
                val row = o.optJSONObject(id) ?: continue
                val sites = HashMap<String, Boolean>()
                row.optJSONObject("sites")?.let { listed ->
                    for (key in listed.keys()) {
                        val decision = decisionOf(listed.opt(key)) ?: continue
                        if (key.isNotEmpty()) sites[key] = decision
                    }
                }
                rows[id] = Row(decisionOf(row.opt("default")) ?: (DEFAULT_ALLOW[id] ?: true), sites)
            }
            return ContentRules(rows)
        }

        private fun decisionOf(value: Any?): Boolean? = when (value) {
            "allow" -> true
            "deny" -> false
            else -> null
        }
    }
}
