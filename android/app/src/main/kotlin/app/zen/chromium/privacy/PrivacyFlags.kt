package app.zen.chromium.privacy

import app.zen.chromium.blocking.Domains
import org.json.JSONArray
import org.json.JSONObject

/**
 * The effective privacy policy the core pushes (`PrivacyFlags` in `src/shared/privacy.ts`,
 * through `privacy.apply`), parsed once and read per request and per WebView. The questions a
 * request or a page puts to it mirror `src/core/privacy/policy.ts`, with what WebView can act
 * on: third-party cookies are a per-WebView switch here (`CookieManager.setAcceptThirdPartyCookies`),
 * so the exception list is honoured for the top document's site, not per embedded request.
 */
class PrivacyFlags(
    val safeBrowsing: Boolean,
    /** Origins (`scheme://host[:port]`) the user chose to proceed to past a Safe Browsing warning. */
    val safeBrowsingBypassed: Set<String>,
    /** `off`, `ask` or `always`. */
    val httpsOnly: String,
    /** Sites (hosts, subdomains included) the user allowed over plaintext. */
    val httpsOnlyAllowed: List<String>,
    /** `allow`, `block-private` or `block`. */
    val thirdPartyCookies: String,
    /**
     * The private tabs' own choice, `default` (follow the mode), `allow` or `block`; never
     * changes what the other containers do (`thirdPartyCookiesPrivate` in `src/shared/privacy.ts`).
     */
    val thirdPartyCookiesPrivate: String,
    val thirdPartyCookieExceptions: List<String>,
    val gpc: Boolean,
    val dnt: Boolean,
    /** The per-site cookie policy (Chrome's three lists and the "block all" default); empty before the core has one. */
    val siteData: SiteDataPolicy = SiteDataPolicy.EMPTY
) {
    /**
     * Whether the WebView of `containerId` showing `documentUrl` accepts third-party cookies:
     * the policy allows them in this container ([blocksThirdPartyCookiesIn]), or the document's
     * site is on the exception list (the related-sites exception, evaluated for the site the
     * user is on since WebView has no per-request cookie switch).
     */
    fun acceptsThirdPartyCookies(containerId: String, documentUrl: String?): Boolean {
        if (!blocksThirdPartyCookiesIn(containerId == PRIVATE_CONTAINER)) return true
        val host = documentUrl?.let(Domains::hostnameOf) ?: return false
        return hostInSites(host, thirdPartyCookieExceptions)
    }

    /**
     * Whether a request for `url` goes without cookies – no `Cookie` sent, no `Set-Cookie` kept –
     * under the whole policy, the twin of `cookiesWithheld` in `src/core/protection/policy.ts`:
     * the per-site lists and the "block all" default first ([SiteDataPolicy.verdict]: a
     * never-site's request always does, a listed site's never does), then the third-party rule
     * for the rest – a request whose site is not `documentUrl`'s, in a container that blocks
     * third-party cookies, with neither site on the exception list. A document's own request
     * (`documentUrl` null) is never third party. The header stage asks this for the documents it
     * relays; WebView attaches the cookies of everything else itself.
     */
    fun cookiesWithheld(url: String, documentUrl: String?, containerId: String): Boolean {
        when (siteData.verdict(url)) {
            SiteDataPolicy.Verdict.BLOCKED -> return true
            SiteDataPolicy.Verdict.ALLOWED -> return false
            SiteDataPolicy.Verdict.DEFAULT -> Unit
        }
        if (!blocksThirdPartyCookiesIn(containerId == PRIVATE_CONTAINER)) return false
        if (documentUrl.isNullOrEmpty()) return false
        if (!Domains.isThirdParty(url, documentUrl)) return false
        if (thirdPartyCookieExceptions.isEmpty()) return true
        val requestHost = Domains.hostnameOf(url)
        if (requestHost != null && hostInSites(requestHost, thirdPartyCookieExceptions)) return false
        val documentHost = Domains.hostnameOf(documentUrl)
        if (documentHost != null && hostInSites(documentHost, thirdPartyCookieExceptions)) return false
        return true
    }

    /**
     * Whether third-party cookies are blocked in a regular or a private container, before the
     * exceptions: the global `block` blocks everywhere; in a private container the private
     * choice decides when set (`allow` / `block`), else the mode's own answer (`block-private`
     * blocks there, `allow` does not); in a regular container `allow` and `block-private` both
     * allow. The twin of `thirdPartyCookiesBlockedIn` in `src/shared/privacy.ts`.
     */
    fun blocksThirdPartyCookiesIn(isPrivate: Boolean): Boolean {
        if (thirdPartyCookies == "block") return true
        if (!isPrivate) return false
        if (thirdPartyCookiesPrivate != "default") return thirdPartyCookiesPrivate == "block"
        return thirdPartyCookies == "block-private"
    }

    /**
     * Whether HTTPS-only mode leaves an `http://` request of `url` alone: the mode is off, the
     * host is non-unique ([NonUniqueHost]: loopback, private addresses, names without a
     * registrable suffix), or it is on (or under) a site the user allowed over plaintext. The
     * engine's own rule already excludes both; this answers ahead of a rule set the engine has
     * yet to reload.
     */
    fun plaintextAllowed(url: String): Boolean {
        if (httpsOnly == "off") return true
        val host = Domains.hostnameOf(url) ?: return false
        return NonUniqueHost.isNonUnique(host) || hostInSites(host, httpsOnlyAllowed)
    }

    /**
     * The user chose to proceed to `url`'s host past a Safe Browsing warning (the core keys the
     * bypasses on the lowercase host, without scheme or port: `bypassKey` in `safebrowsing/service.ts`).
     */
    fun isBypassed(url: String): Boolean {
        if (safeBrowsingBypassed.isEmpty()) return false
        if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) return false
        val host = Domains.hostnameOf(url) ?: return false
        return safeBrowsingBypassed.contains(host)
    }

    /** The request headers the privacy signals add, by their wire names. */
    fun signalHeaders(): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        if (gpc) out["Sec-GPC"] = "1"
        if (dnt) out["DNT"] = "1"
        return out
    }

    /**
     * The document-start script that puts the enabled signals on `Navigator.prototype`
     * (`navigator.globalPrivacyControl`, `navigator.doNotTrack`), or null when neither is on.
     * The same body as `installNavigatorSignals` in `src/shared/privacySignals.ts`.
     */
    fun navigatorScript(): String? {
        if (!gpc && !dnt) return null
        val defines = StringBuilder()
        if (gpc) defines.append("d('globalPrivacyControl',true);")
        if (dnt) defines.append("d('doNotTrack','1');")
        return "(function(){var d=function(n,v){try{Object.defineProperty(Navigator.prototype,n," +
            "{get:function(){return v},configurable:true,enumerable:true})}catch(e){}};$defines})();"
    }

    /** The policy without its session-only part (the Safe Browsing bypasses), for the copy kept on disk. */
    fun withoutSession(): PrivacyFlags = if (safeBrowsingBypassed.isEmpty()) this else PrivacyFlags(
        safeBrowsing, emptySet(), httpsOnly, httpsOnlyAllowed, thirdPartyCookies, thirdPartyCookiesPrivate,
        thirdPartyCookieExceptions, gpc, dnt, siteData
    )

    fun toJson(): JSONObject = JSONObject()
        .put("safeBrowsing", safeBrowsing)
        .put("safeBrowsingBypassed", JSONArray(safeBrowsingBypassed.sorted()))
        .put("httpsOnly", httpsOnly)
        .put("httpsOnlyAllowed", JSONArray(httpsOnlyAllowed))
        .put("thirdPartyCookies", thirdPartyCookies)
        .put("thirdPartyCookiesPrivate", thirdPartyCookiesPrivate)
        .put("thirdPartyCookieExceptions", JSONArray(thirdPartyCookieExceptions))
        .put("gpc", gpc)
        .put("dnt", dnt)
        .put("siteData", siteData.toJson())

    companion object {
        /** The container id of private tabs (`Tab.containerId` in the core). */
        const val PRIVATE_CONTAINER = "private"

        private val HTTPS_ONLY_MODES = setOf("off", "ask", "always")
        private val COOKIE_MODES = setOf("allow", "block-private", "block")
        private val COOKIE_PRIVATE_MODES = setOf("default", "allow", "block")

        /** What applies before the core has pushed anything: the settings' defaults. */
        val DEFAULT = PrivacyFlags(
            safeBrowsing = true,
            safeBrowsingBypassed = emptySet(),
            httpsOnly = "ask",
            httpsOnlyAllowed = emptyList(),
            thirdPartyCookies = "block-private",
            thirdPartyCookiesPrivate = "default",
            thirdPartyCookieExceptions = emptyList(),
            gpc = false,
            dnt = false
        )

        /** Parse the core's document; a missing or malformed field keeps its default. */
        fun parse(o: JSONObject?): PrivacyFlags {
            if (o == null) return DEFAULT
            val d = DEFAULT
            return PrivacyFlags(
                safeBrowsing = o.optBoolean("safeBrowsing", d.safeBrowsing),
                safeBrowsingBypassed = strings(o.optJSONArray("safeBrowsingBypassed")).toHashSet(),
                httpsOnly = o.optString("httpsOnly", d.httpsOnly).takeIf { it in HTTPS_ONLY_MODES } ?: d.httpsOnly,
                httpsOnlyAllowed = strings(o.optJSONArray("httpsOnlyAllowed")),
                thirdPartyCookies = o.optString("thirdPartyCookies", d.thirdPartyCookies).takeIf { it in COOKIE_MODES }
                    ?: d.thirdPartyCookies,
                thirdPartyCookiesPrivate = o.optString("thirdPartyCookiesPrivate", d.thirdPartyCookiesPrivate)
                    .takeIf { it in COOKIE_PRIVATE_MODES } ?: d.thirdPartyCookiesPrivate,
                thirdPartyCookieExceptions = strings(o.optJSONArray("thirdPartyCookieExceptions")),
                gpc = o.optBoolean("gpc", d.gpc),
                dnt = o.optBoolean("dnt", d.dnt),
                siteData = SiteDataPolicy.parse(o.optJSONObject("siteData"))
            )
        }

        private fun strings(arr: JSONArray?): List<String> {
            if (arr == null) return emptyList()
            val out = ArrayList<String>(arr.length())
            for (i in 0 until arr.length()) {
                val s = arr.optString(i, "").lowercase()
                if (s.isNotEmpty()) out.add(s)
            }
            return out
        }

        /** `host` is one of `sites` or a subdomain of one (`hostInSites` in `src/shared/privacy.ts`). */
        fun hostInSites(host: String, sites: List<String>): Boolean = sites.any { Domains.hostMatchesDomain(host, it) }
    }
}
