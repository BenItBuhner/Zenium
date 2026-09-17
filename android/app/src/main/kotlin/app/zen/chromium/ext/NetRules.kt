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
 * The prototype's index is a required-literal prefilter: the longest literal run of a
 * `urlFilter` must occur in the URL before its regex is tried, so a request against tens of
 * thousands of rules costs mostly `indexOf`. The shared request-blocking engine replaces this.
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

    class Rule(
        val id: Int,
        val priority: Int,
        val action: String,
        val redirectUrl: String?,
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
        for (rule in rules) {
            if (rule.action == "modifyHeaders") continue
            if (!matches(rule, url, lowerUrl, host, initiatorHost, type, lowerMethod)) continue
            if (best == null || rule.priority > best.priority ||
                (rule.priority == best.priority && rank(rule.action) > rank(best.action))
            ) best = rule
        }
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
        if (rule.requestDomains.isNotEmpty() && rule.requestDomains.none { domainMatches(host, it) }) return false
        if (rule.excludedRequestDomains.any { domainMatches(host, it) }) return false
        if (rule.initiatorDomains.isNotEmpty() && rule.initiatorDomains.none { domainMatches(initiatorHost, it) }) return false
        if (rule.excludedInitiatorDomains.any { domainMatches(initiatorHost, it) }) return false
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

        fun hostOf(url: String): String = runCatching { URI(url).host?.lowercase(Locale.ROOT) ?: "" }.getOrDefault("")

        fun domainMatches(host: String, domain: String): Boolean = host == domain || host.endsWith(".$domain")

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
