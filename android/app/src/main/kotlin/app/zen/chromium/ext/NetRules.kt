package app.zen.chromium.ext

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.Locale

/**
 * declarativeNetRequest on the network path. Consumes the normalised rule model produced by the
 * TypeScript translator (`src/core/extensions/runtime/dnr.ts`, one JSON object per rule) and
 * answers per request from `shouldInterceptRequest`. The semantics live in the TypeScript
 * reference matcher and its tests; this is the Kotlin twin: same `urlFilter` grammar, same
 * priority-then-action precedence.
 *
 * The prototype's index is a token index in the shape of the shared engine's `FilterIndex`:
 * every rule whose `urlFilter` has a complete token (a run of letters and digits bounded on both
 * sides by something other than a wildcard, so every matching URL contains it as a whole token)
 * sits in the bucket of its rarest one, and a request only tests the rules of the buckets its
 * URL's tokens name plus the few rules without a token (domain-list rules, regular expressions).
 * Within a bucket the longest literal run of the `urlFilter` must occur in the URL before its
 * regex is tried. The shared request-blocking engine replaces this.
 */
class NetRules(val rules: List<Rule>) {
    constructor(rulesJson: JSONArray) : this(
        buildList {
            for (i in 0 until rulesJson.length()) {
                val o = rulesJson.optJSONObject(i) ?: continue
                runCatching { add(parse(o)) }
            }
        }
    )

    /** token hash → the rules whose rarest complete token it is. */
    private val buckets: HashMap<Int, Array<Rule>>
    /** Rules without a complete token: tested for every request. */
    private val loose: Array<Rule>

    init {
        val tokens = ArrayList<IntArray>(rules.size)
        val histogram = HashMap<Int, Int>()
        for (rule in rules) {
            val t = rule.tokens
            tokens.add(t)
            for (h in t) histogram[h] = (histogram[h] ?: 0) + 1
        }
        val building = HashMap<Int, ArrayList<Rule>>()
        val untokened = ArrayList<Rule>()
        for (i in rules.indices) {
            val t = tokens[i]
            if (t.isEmpty()) {
                untokened.add(rules[i])
                continue
            }
            var best = t[0]
            var bestCount = histogram[best] ?: 0
            for (h in t) {
                val count = histogram[h] ?: 0
                if (count < bestCount) {
                    best = h
                    bestCount = count
                }
            }
            building.getOrPut(best) { ArrayList() }.add(rules[i])
        }
        buckets = HashMap(building.size)
        for ((k, v) in building) buckets[k] = v.toTypedArray()
        loose = untokened.toTypedArray()
    }

    /** Rules no token indexes (tested for every request). */
    val looseCount: Int get() = loose.size

    class Rule(
        val id: Int,
        val priority: Int,
        val action: String,
        val redirectUrl: String?,
        /** The `urlFilter` as written (null for regex-only and URL-less rules). */
        val urlFilter: String?,
        /** Regex source (null when the rule has no URL condition); compiled on first use. */
        val regexSource: String?,
        /** Lower-cased literal that must appear in the (lower-cased) URL when the filter is case-insensitive. */
        val requiredLiteral: String?,
        val caseSensitive: Boolean,
        val requestDomains: List<String>,
        val excludedRequestDomains: List<String>,
        val initiatorDomains: List<String>,
        val excludedInitiatorDomains: List<String>,
        val resourceTypes: Set<String>,
        val excludedResourceTypes: Set<String>,
        val requestMethods: Set<String>,
        val excludedRequestMethods: Set<String>,
        val domainType: String?
    ) {
        /**
         * Compiling tens of thousands of patterns up front cost seconds on ART; the literal
         * prefilter rejects almost every (rule, request) pair, so most rules never compile.
         */
        val urlRegex: Regex? by lazy(LazyThreadSafetyMode.PUBLICATION) {
            regexSource?.let { runCatching { Regex(it, if (caseSensitive) emptySet() else setOf(RegexOption.IGNORE_CASE)) }.getOrNull() }
        }

        /**
         * The domain lists as sets: a list rule (uBlock Origin Lite's carry thousands of
         * `requestDomains`) is matched by looking up the host and each of its parent domains,
         * a handful of lookups instead of a walk over the whole list per request.
         */
        val requestDomainSet: Set<String> = requestDomains.toHashSet()
        val excludedRequestDomainSet: Set<String> = excludedRequestDomains.toHashSet()
        val initiatorDomainSet: Set<String> = initiatorDomains.toHashSet()
        val excludedInitiatorDomainSet: Set<String> = excludedInitiatorDomains.toHashSet()

        /** Hashes of the `urlFilter`'s complete tokens (empty for regex-only and URL-less rules). */
        val tokens: IntArray = urlFilter?.let(::filterTokens) ?: IntArray(0)
    }

    sealed class Decision {
        object Allow : Decision()
        object Block : Decision()
        object UpgradeScheme : Decision()
        class Redirect(val url: String) : Decision()
    }

    fun decide(url: String, initiator: String?, type: String, method: String): Decision? {
        val host = hostOf(url)
        val initiatorHost = initiator?.let(::hostOf) ?: ""
        val lowerUrl = url.lowercase(Locale.ROOT)
        val lowerMethod = method.lowercase(Locale.ROOT)
        var best: Rule? = null
        val consider = { rule: Rule ->
            if (rule.action != "modifyHeaders" && matches(rule, url, lowerUrl, host, initiatorHost, type, lowerMethod) &&
                (best == null || rule.priority > best!!.priority ||
                    (rule.priority == best!!.priority && rank(rule.action) > rank(best!!.action)))
            ) best = rule
        }
        if (buckets.isNotEmpty()) {
            for (token in urlTokens(lowerUrl)) {
                val bucket = buckets[token] ?: continue
                for (rule in bucket) consider(rule)
            }
        }
        for (rule in loose) consider(rule)
        val winner = best ?: return null
        return when (winner.action) {
            "allow", "allowAllRequests" -> Decision.Allow
            "block" -> Decision.Block
            "upgradeScheme" -> Decision.UpgradeScheme
            "redirect" -> winner.redirectUrl?.let { Decision.Redirect(it) }
            else -> null
        }
    }

    private fun matches(rule: Rule, url: String, lowerUrl: String, host: String, initiatorHost: String, type: String, method: String): Boolean {
        if (rule.resourceTypes.isNotEmpty()) {
            if (type !in rule.resourceTypes) return false
        } else if (rule.excludedResourceTypes.isNotEmpty()) {
            if (type in rule.excludedResourceTypes) return false
        } else if (type == "main_frame") {
            return false
        }
        if (rule.requestMethods.isNotEmpty() && method !in rule.requestMethods) return false
        if (method in rule.excludedRequestMethods) return false
        if (rule.requestDomainSet.isNotEmpty() && !hostIn(host, rule.requestDomainSet)) return false
        if (rule.excludedRequestDomainSet.isNotEmpty() && hostIn(host, rule.excludedRequestDomainSet)) return false
        if (rule.initiatorDomainSet.isNotEmpty() && !hostIn(initiatorHost, rule.initiatorDomainSet)) return false
        if (rule.excludedInitiatorDomainSet.isNotEmpty() && hostIn(initiatorHost, rule.excludedInitiatorDomainSet)) return false
        if (rule.domainType != null) {
            val firstParty = initiatorHost.isNotEmpty() && registrableDomain(initiatorHost) == registrableDomain(host)
            if (rule.domainType == "firstParty" && !firstParty) return false
            if (rule.domainType == "thirdParty" && firstParty) return false
        }
        if (rule.regexSource != null) {
            val literal = rule.requiredLiteral
            if (literal != null && !(if (rule.caseSensitive) url.contains(literal) else lowerUrl.contains(literal))) return false
            val regex = rule.urlRegex ?: return false
            if (!regex.containsMatchIn(url)) return false
        }
        return true
    }

    companion object {
        private fun rank(action: String): Int = when (action) {
            "allow" -> 5
            "allowAllRequests" -> 4
            "block" -> 3
            "upgradeScheme" -> 2
            "redirect" -> 1
            else -> 0
        }

        fun parse(o: JSONObject): Rule {
            val caseSensitive = o.optBoolean("caseSensitive", false)
            val urlFilter = o.optString("urlFilter", "").takeIf { o.has("urlFilter") && !o.isNull("urlFilter") }
            val regexFilter = o.optString("regexFilter", "").takeIf { o.has("regexFilter") && !o.isNull("regexFilter") }
            val source = when {
                urlFilter != null -> urlFilterToRegex(urlFilter)
                regexFilter != null -> regexFilter
                else -> null
            }
            val literal = urlFilter?.let(::longestLiteral)?.let { if (caseSensitive) it else it.lowercase(Locale.ROOT) }
            return Rule(
                id = o.optInt("id"),
                priority = o.optInt("priority", 1),
                action = o.optString("action", "block"),
                redirectUrl = o.optString("redirectUrl", "").takeIf { o.has("redirectUrl") && !o.isNull("redirectUrl") },
                urlFilter = urlFilter,
                regexSource = source,
                requiredLiteral = literal?.takeIf { it.length >= 3 },
                caseSensitive = caseSensitive,
                requestDomains = strings(o.optJSONArray("requestDomains")),
                excludedRequestDomains = strings(o.optJSONArray("excludedRequestDomains")),
                initiatorDomains = strings(o.optJSONArray("initiatorDomains")),
                excludedInitiatorDomains = strings(o.optJSONArray("excludedInitiatorDomains")),
                resourceTypes = strings(o.optJSONArray("resourceTypes")).toSet(),
                excludedResourceTypes = strings(o.optJSONArray("excludedResourceTypes")).toSet(),
                requestMethods = strings(o.optJSONArray("requestMethods")).toSet(),
                excludedRequestMethods = strings(o.optJSONArray("excludedRequestMethods")).toSet(),
                domainType = o.optString("domainType", "").takeIf { it == "firstParty" || it == "thirdParty" }
            )
        }

        private fun strings(arr: JSONArray?): List<String> {
            if (arr == null) return emptyList()
            return buildList { for (i in 0 until arr.length()) arr.optString(i, null)?.let { add(it) } }
        }

        private val ACTIONS = setOf("block", "allow", "allowAllRequests", "upgradeScheme", "redirect", "modifyHeaders")
        private val RESOURCE_TYPES = setOf(
            "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest",
            "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"
        )

        /**
         * Chrome's `declarativeNetRequest.Rule` → the normalised model `parse` reads (the Kotlin
         * twin of `normalizeRule` in dnr.ts, so static rulesets never cross the bridge). Null when
         * malformed; `transform`/`regexSubstitution` redirects are not modelled.
         */
        fun fromChromeRule(raw: JSONObject, extensionOrigin: String): JSONObject? {
            val id = raw.opt("id") as? Number ?: return null
            val action = raw.optJSONObject("action") ?: return null
            val condition = raw.optJSONObject("condition") ?: return null
            val type = action.optString("type", "")
            if (type !in ACTIONS) return null
            var redirectUrl: String? = null
            if (type == "redirect") {
                val redirect = action.optJSONObject("redirect")
                val url = redirect?.optString("url", "")?.takeIf { it.isNotEmpty() && redirect.has("url") }
                val path = redirect?.optString("extensionPath", "")?.takeIf { it.isNotEmpty() && redirect.has("extensionPath") }
                redirectUrl = url ?: path?.let { extensionOrigin + it }
            }
            val lower = { list: List<String> -> list.map { it.lowercase(Locale.ROOT) } }
            val types = { arr: JSONArray? -> strings(arr).filter { it in RESOURCE_TYPES } }
            val o = JSONObject()
            o.put("id", id.toInt())
            o.put("priority", (raw.opt("priority") as? Number)?.toInt() ?: 1)
            o.put("action", type)
            if (redirectUrl != null) o.put("redirectUrl", redirectUrl)
            if (condition.has("urlFilter") && !condition.isNull("urlFilter")) o.put("urlFilter", condition.optString("urlFilter"))
            if (condition.has("regexFilter") && !condition.isNull("regexFilter")) o.put("regexFilter", condition.optString("regexFilter"))
            o.put("caseSensitive", condition.optBoolean("isUrlFilterCaseSensitive", false))
            o.put("requestDomains", JSONArray(lower(strings(condition.optJSONArray("requestDomains")))))
            o.put("excludedRequestDomains", JSONArray(lower(strings(condition.optJSONArray("excludedRequestDomains")))))
            o.put("initiatorDomains", JSONArray(lower(strings(condition.optJSONArray("initiatorDomains") ?: condition.optJSONArray("domains")))))
            o.put("excludedInitiatorDomains", JSONArray(lower(strings(condition.optJSONArray("excludedInitiatorDomains") ?: condition.optJSONArray("excludedDomains")))))
            o.put("resourceTypes", JSONArray(types(condition.optJSONArray("resourceTypes"))))
            o.put("excludedResourceTypes", JSONArray(types(condition.optJSONArray("excludedResourceTypes"))))
            o.put("requestMethods", JSONArray(lower(strings(condition.optJSONArray("requestMethods")))))
            o.put("excludedRequestMethods", JSONArray(lower(strings(condition.optJSONArray("excludedRequestMethods")))))
            val domainType = condition.optString("domainType", "")
            if (domainType == "firstParty" || domainType == "thirdParty") o.put("domainType", domainType)
            return o
        }

        /** Same grammar as `urlFilterToRegExp` in dnr.ts: `||`, `|`, `*`, `^`. */
        fun urlFilterToRegex(filter: String): String {
            val sb = StringBuilder()
            var body = filter
            var anchoredStart = false
            var anchoredEnd = false
            if (body.startsWith("||")) {
                sb.append("^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#]*\\.)?")
                body = body.substring(2)
            } else if (body.startsWith("|")) {
                anchoredStart = true
                body = body.substring(1)
            }
            if (body.endsWith("|")) {
                anchoredEnd = true
                body = body.substring(0, body.length - 1)
            }
            if (anchoredStart) sb.append('^')
            for (ch in body) {
                when (ch) {
                    '*' -> sb.append(".*")
                    '^' -> sb.append("(?:[^a-zA-Z0-9_\\-.%]|$)")
                    else -> if (ch in ".*+?^\${}()|[]\\/") sb.append('\\').append(ch) else sb.append(ch)
                }
            }
            if (anchoredEnd) sb.append('$')
            return sb.toString()
        }

        /** The longest run of the filter without `*`, `^` or `|` – a substring every match must contain. */
        fun longestLiteral(filter: String): String? =
            filter.split('*', '^', '|').maxByOrNull { it.length }?.takeIf { it.isNotEmpty() }

        private fun isTokenChar(c: Char): Boolean = c in 'a'..'z' || c in '0'..'9'

        private fun tokenHash(s: String, start: Int, end: Int): Int {
            var h = 0
            for (i in start until end) h = h * 31 + s[i].code
            return h
        }

        /**
         * Hashes of a `urlFilter`'s complete tokens: runs of `[a-z0-9]` (the filter lowercased)
         * bounded on both sides by something in the filter other than `*` – a separator character,
         * or an anchor at the edge (`||`, `|`). A run at an unanchored edge or next to a wildcard
         * may be only part of a URL token and is not indexed; a filter of nothing but such runs
         * yields no tokens and its rule is tested for every request.
         */
        fun filterTokens(filter: String): IntArray {
            var body = filter.lowercase(Locale.ROOT)
            var leftAnchored = false
            var rightAnchored = false
            if (body.startsWith("||")) {
                leftAnchored = true
                body = body.substring(2)
            } else if (body.startsWith("|")) {
                leftAnchored = true
                body = body.substring(1)
            }
            if (body.endsWith("|")) {
                rightAnchored = true
                body = body.substring(0, body.length - 1)
            }
            val out = ArrayList<Int>(8)
            var i = 0
            val n = body.length
            while (i < n) {
                if (!isTokenChar(body[i])) {
                    i++
                    continue
                }
                val start = i
                while (i < n && isTokenChar(body[i])) i++
                val boundedLeft = if (start == 0) leftAnchored else body[start - 1] != '*'
                val boundedRight = if (i == n) rightAnchored else body[i] != '*'
                if (boundedLeft && boundedRight) out.add(tokenHash(body, start, i))
            }
            return out.toIntArray()
        }

        /** Distinct hashes of the tokens of a lowercased URL (every run of `[a-z0-9]`). */
        fun urlTokens(lowerUrl: String): IntArray {
            val out = ArrayList<Int>(24)
            var i = 0
            val n = lowerUrl.length
            while (i < n) {
                if (!isTokenChar(lowerUrl[i])) {
                    i++
                    continue
                }
                val start = i
                while (i < n && isTokenChar(lowerUrl[i])) i++
                val h = tokenHash(lowerUrl, start, i)
                if (h !in out) out.add(h)
            }
            return out.toIntArray()
        }

        fun hostOf(url: String): String = runCatching { URI(url).host?.lowercase(Locale.ROOT) ?: "" }.getOrDefault("")

        fun domainMatches(host: String, domain: String): Boolean = host == domain || host.endsWith(".$domain")

        /** Whether `host` or one of its parent domains is in `domains` (`domainMatches` over a set). */
        fun hostIn(host: String, domains: Set<String>): Boolean {
            if (host.isEmpty()) return false
            var from = 0
            while (true) {
                if (host.substring(from) in domains) return true
                val dot = host.indexOf('.', from)
                if (dot < 0) return false
                from = dot + 1
            }
        }

        fun registrableDomain(host: String): String {
            val labels = host.split('.')
            return if (labels.size <= 2) host else labels.takeLast(2).joinToString(".")
        }

        /**
         * Resource type from what `WebResourceRequest` exposes (frame flag, Accept, URL extension).
         * A non-main-frame request whose Accept asks for HTML is a subframe navigation: WebView has
         * no flag for it.
         */
        private val FONT_EXT = Regex("\\.(woff2?|ttf|otf|eot)$")
        private val SCRIPT_EXT = Regex("\\.(js|mjs)$")
        private val IMAGE_EXT = Regex("\\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$")
        private val MEDIA_EXT = Regex("\\.(mp4|webm|m4s|mp3|ogg|m3u8|ts)$")

        fun guessResourceType(url: String, accept: String?, isMainFrame: Boolean, isSubFrame: Boolean): String {
            if (isMainFrame) return "main_frame"
            if (isSubFrame) return "sub_frame"
            val a = (accept ?: "").lowercase(Locale.ROOT)
            val path = url.substringBefore('#').substringBefore('?').lowercase(Locale.ROOT)
            return when {
                a.startsWith("text/html") -> "sub_frame"
                a.startsWith("text/css") -> "stylesheet"
                a.startsWith("image/") -> "image"
                a.contains("video/") || a.contains("audio/") -> "media"
                a.contains("font") || FONT_EXT.containsMatchIn(path) -> "font"
                SCRIPT_EXT.containsMatchIn(path) -> "script"
                path.endsWith(".css") -> "stylesheet"
                IMAGE_EXT.containsMatchIn(path) -> "image"
                MEDIA_EXT.containsMatchIn(path) -> "media"
                a == "*/*" || a.contains("application/json") -> "xmlhttprequest"
                else -> "other"
            }
        }
    }
}
