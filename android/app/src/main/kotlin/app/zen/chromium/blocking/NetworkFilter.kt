package app.zen.chromium.blocking

/**
 * One ABP / uBlock Origin network filter: `[@@]pattern[$option,option=value,…]`. The parser
 * accepts what the request engine can act on – blocking, exceptions, `$important`, resource
 * types, party, `$domain=` / `$from=`, `$to=`, `$denyallow=`, `$method=`, `$match-case`,
 * `$redirect=` (a blocked request answered with nothing) – and rejects filters whose options it
 * cannot honour (`$csp`, `$removeparam`, `$replace`, cosmetic exceptions, popups), as uBlock
 * Origin drops filters with options it does not know.
 */
class NetworkFilter private constructor(
    val pattern: UrlPattern,
    val isException: Boolean,
    val isImportant: Boolean,
    /** `$redirect=` / `$empty` / `$mp4`: blocked, and the host answers with an empty body. */
    val isRedirect: Boolean,
    private val typeMask: Int,
    /** 0 = any party, 1 = first party only, 2 = third party only. */
    private val party: Int,
    private val initiatorDomains: Array<String>?,
    private val excludedInitiatorDomains: Array<String>?,
    private val requestDomains: Array<String>?,
    private val excludedRequestDomains: Array<String>?,
    private val methods: Array<String>?,
    private val excludedMethods: Array<String>?
) {
    /**
     * `@@…$document` exceptions whitelist every request of the pages they match; the text engine
     * matches them against the document request itself.
     */
    val whitelistsDocument: Boolean = isException && (typeMask and ResourceType.MAIN_FRAME.bit) != 0

    /** Does the filter apply to `req` (pattern and every option)? */
    fun matches(req: Request): Boolean =
        matchesOptions(req) && pattern.matches(req.url, req.urlLower, req.host, req.hostStart)

    /** The options alone – the caller has already matched the pattern (host-map lookups). */
    fun matchesOptions(req: Request): Boolean {
        if ((typeMask and req.typeMask) == 0) return false
        if (party == 1 && req.isThirdParty) return false
        if (party == 2 && !req.isThirdParty) return false
        if (methods != null && !methods.any { it == req.methodLower }) return false
        if (excludedMethods != null && excludedMethods.any { it == req.methodLower }) return false
        if (excludedRequestDomains != null && excludedRequestDomains.any { Domains.hostMatchesDomain(req.host, it) }) return false
        if (requestDomains != null && !requestDomains.any { Domains.hostMatchesDomain(req.host, it) }) return false
        if (initiatorDomains != null || excludedInitiatorDomains != null) {
            val doc = req.documentHost
            if (excludedInitiatorDomains != null && excludedInitiatorDomains.any { Domains.hostMatchesDomain(doc, it) }) return false
            if (initiatorDomains != null && (doc.isEmpty() || !initiatorDomains.any { Domains.hostMatchesDomain(doc, it) })) return false
        }
        return true
    }

    override fun toString(): String = (if (isException) "@@" else "") + pattern.toString()

    companion object {
        private const val ANY = 0
        private const val FIRST_PARTY = 1
        private const val THIRD_PARTY = 2

        private val TYPE_OPTIONS: Map<String, Int> = mapOf(
            "script" to ResourceType.SCRIPT.bit,
            "image" to ResourceType.IMAGE.bit,
            "stylesheet" to ResourceType.STYLESHEET.bit,
            "css" to ResourceType.STYLESHEET.bit,
            "object" to ResourceType.OBJECT.bit,
            "object-subrequest" to ResourceType.OBJECT.bit,
            "xmlhttprequest" to ResourceType.XMLHTTPREQUEST.bit,
            "xhr" to ResourceType.XMLHTTPREQUEST.bit,
            "subdocument" to ResourceType.SUB_FRAME.bit,
            "frame" to ResourceType.SUB_FRAME.bit,
            "document" to ResourceType.MAIN_FRAME.bit,
            "doc" to ResourceType.MAIN_FRAME.bit,
            "ping" to ResourceType.PING.bit,
            "beacon" to ResourceType.PING.bit,
            "websocket" to ResourceType.WEBSOCKET.bit,
            "font" to ResourceType.FONT.bit,
            "media" to ResourceType.MEDIA.bit,
            "other" to ResourceType.OTHER.bit,
            "csp_report" to ResourceType.CSP_REPORT.bit,
            "webtransport" to ResourceType.WEBTRANSPORT.bit,
            "webbundle" to ResourceType.WEBBUNDLE.bit,
            "all" to ResourceType.ALL_MASK
        )

        /** Types the WebView never hands to `shouldInterceptRequest`: a filter only for them matches nothing. */
        private val UNINTERCEPTABLE_TYPES = setOf("popup", "popunder", "webrtc", "inline-script", "inline-font")

        /** Options that do not block and cannot be applied from `shouldInterceptRequest`. */
        private val UNSUPPORTED_OPTIONS = setOf(
            "csp", "removeparam", "redirect-rule", "replace", "urlskip", "uritransform", "permissions", "header",
            "ipaddress", "cname", "elemhide", "ehide", "generichide", "ghide", "specifichide", "shide", "genericblock"
        )

        /** Option values may hold spaces (`$csp=script-src 'none'`) but never commas. */
        private val OPTIONS_TEXT = Regex("^[~a-zA-Z0-9_-]+(=[^,]*)?(,\\s*[~a-zA-Z0-9_-]+(=[^,]*)?)*$")

        /**
         * Index of the `$` that starts the options, or -1. A `$` inside a regular expression
         * (`/…$/`) is followed by something that does not read as options, so the last `$` whose
         * remainder does wins.
         */
        fun optionsIndex(line: String): Int {
            var i = line.lastIndexOf('$')
            while (i > 0) {
                if (i < line.length - 1 && OPTIONS_TEXT.matches(line.substring(i + 1))) return i
                i = line.lastIndexOf('$', i - 1)
            }
            return -1
        }

        /** Element hiding, scriptlet and HTML filters: `##`, `#@#`, `#?#`, `#$#`, `#%#` and their combinations. */
        fun isCosmetic(line: String): Boolean {
            var from = line.indexOf('#')
            while (from != -1 && from < line.length - 1) {
                var j = from + 1
                var marks = 0
                while (j < line.length && marks < 2 && (line[j] == '@' || line[j] == '?' || line[j] == '$' || line[j] == '%')) {
                    j++
                    marks++
                }
                if (j < line.length && line[j] == '#') return true
                from = line.indexOf('#', from + 1)
            }
            return false
        }

        /** The filter a `$badfilter` line cancels: the same line without that option. */
        fun badfilterTarget(line: String): String? {
            val at = optionsIndex(line)
            if (at == -1) return null
            val options = line.substring(at + 1).split(',').filter { it != "badfilter" }
            if (options.size == line.substring(at + 1).split(',').size) return null
            return if (options.isEmpty()) line.substring(0, at) else line.substring(0, at + 1) + options.joinToString(",")
        }

        /**
         * Parse one line. Null for lines the engine cannot use: comments, cosmetic filters,
         * `$badfilter` lines (handled by the caller), unsupported options, invalid patterns.
         */
        fun parse(line: String): NetworkFilter? {
            var text = line.trim()
            if (text.isEmpty() || text.startsWith("!") || text.startsWith("[") || text.startsWith("#")) return null
            if (isCosmetic(text)) return null
            var exception = false
            if (text.startsWith("@@")) {
                exception = true
                text = text.substring(2)
            }
            var important = false
            var redirect = false
            var caseSensitive = false
            var party = ANY
            var typeMask = 0
            var negatedTypes = 0
            var initiator: ArrayList<String>? = null
            var excludedInitiator: ArrayList<String>? = null
            var request: ArrayList<String>? = null
            var excludedRequest: ArrayList<String>? = null
            var methods: ArrayList<String>? = null
            var excludedMethods: ArrayList<String>? = null
            var uninterceptableOnly = false

            val at = optionsIndex(text)
            val patternText = if (at == -1) text else text.substring(0, at)
            if (at != -1) {
                for (rawOption in text.substring(at + 1).split(',')) {
                    var option = rawOption.trim()
                    if (option.isEmpty()) continue
                    val negated = option.startsWith("~")
                    if (negated) option = option.substring(1)
                    val eq = option.indexOf('=')
                    val name = if (eq == -1) option else option.substring(0, eq)
                    val value = if (eq == -1) "" else option.substring(eq + 1)
                    val type = TYPE_OPTIONS[name]
                    when {
                        type != null -> if (negated) negatedTypes = negatedTypes or type else typeMask = typeMask or type
                        name in UNINTERCEPTABLE_TYPES -> if (!negated) uninterceptableOnly = true
                        name == "third-party" || name == "3p" || name == "strict3p" -> party = if (negated) FIRST_PARTY else THIRD_PARTY
                        name == "first-party" || name == "1p" || name == "strict1p" -> party = if (negated) THIRD_PARTY else FIRST_PARTY
                        name == "important" -> important = true
                        name == "match-case" -> caseSensitive = true
                        name == "badfilter" -> return null
                        name == "redirect" || name == "empty" || name == "mp4" -> redirect = true
                        name == "_" -> Unit
                        name == "domain" || name == "from" -> {
                            for (d in value.split('|')) {
                                val entry = d.trim().lowercase()
                                if (entry.isEmpty()) continue
                                if (entry.startsWith("~")) {
                                    (excludedInitiator ?: ArrayList<String>().also { excludedInitiator = it }).add(entry.substring(1))
                                } else {
                                    (initiator ?: ArrayList<String>().also { initiator = it }).add(entry)
                                }
                            }
                        }
                        name == "to" -> {
                            for (d in value.split('|')) {
                                val entry = d.trim().lowercase()
                                if (entry.isEmpty()) continue
                                if (entry.startsWith("~")) {
                                    (excludedRequest ?: ArrayList<String>().also { excludedRequest = it }).add(entry.substring(1))
                                } else {
                                    (request ?: ArrayList<String>().also { request = it }).add(entry)
                                }
                            }
                        }
                        name == "denyallow" -> {
                            for (d in value.split('|')) {
                                val entry = d.trim().lowercase()
                                if (entry.isNotEmpty()) (excludedRequest ?: ArrayList<String>().also { excludedRequest = it }).add(entry)
                            }
                        }
                        name == "method" -> {
                            for (m in value.split('|')) {
                                val entry = m.trim().lowercase()
                                if (entry.isEmpty()) continue
                                if (entry.startsWith("~")) {
                                    (excludedMethods ?: ArrayList<String>().also { excludedMethods = it }).add(entry.substring(1))
                                } else {
                                    (methods ?: ArrayList<String>().also { methods = it }).add(entry)
                                }
                            }
                        }
                        name in UNSUPPORTED_OPTIONS -> return null
                        else -> return null
                    }
                }
            }
            if (typeMask == 0) {
                if (uninterceptableOnly) return null
                typeMask = ResourceType.DEFAULT_MASK
            }
            typeMask = typeMask and negatedTypes.inv()
            if (typeMask == 0) return null
            val pattern = UrlPattern.parse(patternText, caseSensitive) ?: return null
            return NetworkFilter(
                pattern, exception, important, redirect, typeMask, party,
                initiator?.toTypedArray(), excludedInitiator?.toTypedArray(),
                request?.toTypedArray(), excludedRequest?.toTypedArray(),
                methods?.toTypedArray(), excludedMethods?.toTypedArray()
            )
        }
    }
}
