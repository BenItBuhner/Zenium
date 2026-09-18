package app.zen.chromium.blocking

/**
 * One request as the engine sees it (the Kotlin twin of `RequestContext` in
 * `src/core/blocking/rules.ts`). Facts every filter needs – the lowercased URL, the host and
 * where it starts, the document's host, the third-party bit and the URL's tokens – are computed
 * once here so tens of thousands of filters can be tested cheaply.
 */
class Request(
    val url: String,
    val type: ResourceType,
    /** URL of the top-level document the request belongs to; null for main-frame navigations. */
    val documentUrl: String?,
    /** Uppercase HTTP method. */
    val method: String = "GET",
    thirdParty: Boolean? = null,
    val tabId: String? = null,
    /**
     * The types the request may be, as [ResourceType] bits: `type`'s own bit when it is known,
     * [ResourceType.AMBIGUOUS_MASK] when WebView gave nothing away. Type conditions match when
     * they and this mask share a bit.
     */
    val typeMask: Int = type.bit,
    /**
     * The session partition the request runs in (`RequestContext.partition`: the tab's container
     * id, `private` for a private tab). A set scoped to partitions (`RuleSet.partitions`) takes
     * part only when this names one of them; null takes part in unscoped sets only.
     */
    val partition: String? = null,
    /** The tab's document generation at the time of the request (`BlockingTab.documentGeneration`). */
    val documentGeneration: Long = 0L
) {
    val urlLower: String = url.lowercase()
    /** Index in `url` where the host begins (after the scheme and any user info). */
    val hostStart: Int
    /** Lowercased hostname without port, or "" when the URL has none. */
    val host: String
    /** Hostname of the document (for `$domain=` lists); main-frame requests use their own host. */
    val documentHost: String
    val isThirdParty: Boolean
    val methodLower: String = method.lowercase()

    private var tokenCache: IntArray? = null

    init {
        var start = url.indexOf("://")
        if (start == -1) {
            hostStart = 0
            host = Domains.hostnameOf(url) ?: ""
        } else {
            start += 3
            var end = url.length
            for (i in start until url.length) {
                val c = url[i]
                if (c == '/' || c == '?' || c == '#') {
                    end = i
                    break
                }
            }
            val at = url.lastIndexOf('@', end - 1)
            if (at >= start) start = at + 1
            var hostEnd = end
            if (url.startsWith("[", start)) {
                val close = url.indexOf(']', start)
                if (close != -1 && close < end) hostEnd = close + 1
            } else {
                val colon = url.indexOf(':', start)
                if (colon != -1 && colon < end) hostEnd = colon
            }
            hostStart = start
            host = urlLower.substring(start, hostEnd).removeSuffix(".")
        }
        val doc = documentUrl?.let { Domains.hostnameOf(it) }
        documentHost = doc ?: if (type == ResourceType.MAIN_FRAME) host else ""
        isThirdParty = thirdParty ?: (documentUrl != null && Domains.isThirdParty(url, documentUrl))
    }

    /** Token hashes of the lowercased URL, computed on first use. */
    val tokens: IntArray
        get() = tokenCache ?: Tokens.tokenize(urlLower).also { tokenCache = it }

    private var hostSuffixCache: Array<String>? = null
    private var documentSuffixCache: Array<String>? = null

    /**
     * The host and each of its parent domains (`a.b.example`, `b.example`, `example`), computed
     * once: a domain condition of any of a thousand rules is then a set lookup per label instead
     * of a substring per label per rule.
     */
    val hostSuffixes: Array<String>
        get() = hostSuffixCache ?: Domains.suffixesOf(host).also { hostSuffixCache = it }

    /** [hostSuffixes] of the document's host. */
    val documentHostSuffixes: Array<String>
        get() = documentSuffixCache ?: Domains.suffixesOf(documentHost).also { documentSuffixCache = it }

    /** The digits of a `tab_<n>` / `<n>` tab id, for `tabIds` conditions; null without a tab. */
    val tabNumber: String? = tabId?.trimStart { !it.isDigit() }
}
