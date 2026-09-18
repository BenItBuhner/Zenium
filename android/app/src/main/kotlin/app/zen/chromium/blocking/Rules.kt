package app.zen.chromium.blocking

import app.zen.chromium.privacy.NonUniqueHost
import org.json.JSONArray
import org.json.JSONObject

/** `chrome.declarativeNetRequest` action types the engine evaluates (header edits are desktop only). */
enum class RuleAction(val dnrName: String, val rank: Int) {
    ALLOW("allow", 5),
    ALLOW_ALL_REQUESTS("allowAllRequests", 4),
    BLOCK("block", 3),
    UPGRADE_SCHEME("upgradeScheme", 2),
    REDIRECT("redirect", 1);

    companion object {
        fun fromDnrName(name: String): RuleAction? = entries.firstOrNull { it.dnrName == name }
    }
}

/**
 * One structured rule (the shape of `chrome.declarativeNetRequest.Rule`, see `rules.ts`),
 * compiled for matching. `effective` orders rules across sets: the set's priority band first,
 * the rule's own priority second, exactly as the TypeScript engine computes it.
 */
class DnrRule(
    val id: Int,
    val action: RuleAction,
    val effective: Long,
    private val redirectUrl: String?,
    private val regexSubstitution: String?,
    private val pattern: UrlPattern?,
    private val initiatorDomains: List<String>?,
    private val excludedInitiatorDomains: List<String>?,
    private val requestDomains: List<String>?,
    private val excludedRequestDomains: List<String>?,
    /** Zenium's addition to the shape: never match a non-unique host (`excludedNonUniqueHosts` in `rules.ts`). */
    private val excludedNonUniqueHosts: Boolean,
    private val typeMask: Int,
    private val excludedTypeMask: Int,
    private val methods: Set<String>?,
    private val excludedMethods: Set<String>?,
    /** 0 = any, 1 = first party, 2 = third party. */
    private val domainType: Int,
    private val tabIds: Set<String>?,
    private val excludedTabIds: Set<String>?
) {
    /** No `urlFilter`, `requestDomains` or `initiatorDomains`: the type conditions alone select requests. */
    private val unscoped: Boolean = pattern == null && requestDomains == null && initiatorDomains == null

    fun matches(req: Request): Boolean {
        val candidates = ResourceType.candidateMask(req.typeMask, unscoped)
        if (typeMask != 0 && (typeMask and candidates) == 0) return false
        // An excluded type only rules the request out when every type it might be is excluded.
        if (excludedTypeMask != 0 && (candidates and excludedTypeMask.inv()) == 0) return false
        if (methods != null && req.methodLower !in methods) return false
        if (excludedMethods != null && req.methodLower in excludedMethods) return false
        if (domainType == 2 && !req.isThirdParty) return false
        if (domainType == 1 && req.isThirdParty) return false
        val tab = req.tabId?.trimStart { !it.isDigit() }
        if (tabIds != null && (tab == null || tab !in tabIds)) return false
        if (excludedTabIds != null && tab != null && tab in excludedTabIds) return false
        if (!matchesDomains(req.host, requestDomains, excludedRequestDomains)) return false
        if (excludedNonUniqueHosts && NonUniqueHost.isNonUnique(req.host)) return false
        if (initiatorDomains != null || excludedInitiatorDomains != null) {
            val initiator = if (req.type == ResourceType.MAIN_FRAME) "" else req.documentHost
            if (initiatorDomains != null && initiator.isEmpty()) return false
            if (!matchesDomains(initiator, initiatorDomains, excludedInitiatorDomains)) return false
        }
        return pattern?.matches(req.url, req.urlLower, req.host, req.hostStart) ?: true
    }

    /** The URL a `redirect` / `upgradeScheme` rule sends `url` to, or null when it has none. */
    fun target(url: String): String? = when (action) {
        RuleAction.UPGRADE_SCHEME ->
            if (url.startsWith("http://", ignoreCase = true)) "https://" + url.substring(7) else null
        RuleAction.REDIRECT -> {
            val target = redirectUrl ?: regexSubstitution?.let { pattern?.substitute(url, it) }
            if (target == null || target == url) null else target
        }
        else -> null
    }

    companion object {
        private const val RULE_PRIORITY_BITS = 20
        const val RULE_PRIORITY_MAX: Long = (1L shl RULE_PRIORITY_BITS) - 1

        fun effectivePriority(setPriority: Int, rulePriority: Int): Long {
            val rp = rulePriority.coerceIn(1, RULE_PRIORITY_MAX.toInt()).toLong()
            return setPriority.toLong() * (RULE_PRIORITY_MAX + 1) + rp
        }

        private fun matchesDomains(host: String, include: List<String>?, exclude: List<String>?): Boolean {
            if (exclude != null && exclude.any { Domains.hostMatchesDomain(host, it) }) return false
            if (include != null) return include.any { Domains.hostMatchesDomain(host, it) }
            return true
        }

        private fun hasEntries(o: JSONObject, key: String): Boolean = (o.optJSONArray(key)?.length() ?: 0) > 0

        private fun strings(o: JSONObject, key: String): List<String>? {
            val arr = o.optJSONArray(key) ?: return null
            val out = ArrayList<String>(arr.length())
            for (i in 0 until arr.length()) out.add(arr.optString(i).lowercase())
            return if (out.isEmpty()) null else out
        }

        private fun typeMask(o: JSONObject, key: String): Int {
            val arr = o.optJSONArray(key) ?: return 0
            var mask = 0
            for (i in 0 until arr.length()) ResourceType.fromDnrName(arr.optString(i))?.let { mask = mask or it.bit }
            return mask
        }

        /** Compile a rule of a set with `setPriority`; null when the rule cannot be evaluated. */
        fun parse(o: JSONObject, setPriority: Int): DnrRule? {
            val actionObj = o.optJSONObject("action") ?: return null
            val action = RuleAction.fromDnrName(actionObj.optString("type")) ?: return null
            val c = o.optJSONObject("condition") ?: JSONObject()
            // Response header conditions need the headers-received stage the desktop engine has;
            // `shouldInterceptRequest` decides before any response exists, so such a rule cannot be
            // evaluated here (and evaluating it without its header condition would over-match).
            if (hasEntries(c, "responseHeaders") || hasEntries(c, "excludedResponseHeaders")) return null
            val caseSensitive = c.optBoolean("isUrlFilterCaseSensitive", false)
            val pattern: UrlPattern? = when {
                c.has("regexFilter") && !c.isNull("regexFilter") -> UrlPattern.regex(c.optString("regexFilter"), caseSensitive) ?: return null
                c.optString("urlFilter").isNotEmpty() ->
                    UrlPattern.parse(c.optString("urlFilter"), caseSensitive, allowRegex = false) ?: return null
                else -> null
            }
            val redirect = actionObj.optJSONObject("redirect")
            val domainType = when (c.optString("domainType")) {
                "firstParty" -> 1
                "thirdParty" -> 2
                else -> 0
            }
            return DnrRule(
                id = o.optInt("id"),
                action = action,
                effective = effectivePriority(setPriority, o.optInt("priority", 1)),
                redirectUrl = redirect?.optString("url")?.takeIf { it.isNotEmpty() },
                regexSubstitution = redirect?.optString("regexSubstitution")?.takeIf { it.isNotEmpty() },
                pattern = pattern,
                initiatorDomains = strings(c, "initiatorDomains"),
                excludedInitiatorDomains = strings(c, "excludedInitiatorDomains"),
                requestDomains = strings(c, "requestDomains"),
                excludedRequestDomains = strings(c, "excludedRequestDomains"),
                excludedNonUniqueHosts = c.optBoolean("excludedNonUniqueHosts", false),
                typeMask = typeMask(c, "resourceTypes"),
                excludedTypeMask = typeMask(c, "excludedResourceTypes"),
                methods = strings(c, "requestMethods")?.toHashSet(),
                excludedMethods = strings(c, "excludedRequestMethods")?.toHashSet(),
                domainType = domainType,
                tabIds = c.optJSONArray("tabIds")?.let { ints(it) },
                excludedTabIds = c.optJSONArray("excludedTabIds")?.let { ints(it) }
            )
        }

        private fun ints(arr: JSONArray): Set<String>? {
            val out = HashSet<String>()
            for (i in 0 until arr.length()) out.add(arr.optLong(i).toString())
            return if (out.isEmpty()) null else out
        }
    }
}

/**
 * A rule set as the core persists it (`blocking/index.json` entry or a `blocking.sync` change):
 * metadata, compiled structured rules, and where its filter text lives.
 */
class RuleSetInfo(
    val id: String,
    val source: String,
    val priority: Int,
    val enabled: Boolean,
    val rules: List<DnrRule>,
    val hasFilterText: Boolean,
    /** File under the profile (`blocking/<name>.json`) with the full set when `hasFilterText`. */
    val file: String?,
    val updatedAt: Long,
    val filterCount: Int
) {
    /** Changes to any of these mean the filter text must be re-read. */
    val textFingerprint: String get() = "$file:$updatedAt:$filterCount"

    companion object {
        fun parse(o: JSONObject): RuleSetInfo? {
            val id = o.optString("id")
            if (id.isEmpty() || !o.has("priority")) return null
            val priority = o.optInt("priority")
            val rules = ArrayList<DnrRule>()
            o.optJSONArray("rules")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val rule = arr.optJSONObject(i) ?: continue
                    DnrRule.parse(rule, priority)?.let { rules.add(it) }
                }
            }
            rules.sortWith(compareByDescending<DnrRule> { it.effective }.thenByDescending { it.action.rank })
            val hasText = o.optBoolean("hasFilterText", false)
            return RuleSetInfo(
                id = id,
                source = o.optString("source", "filter-list"),
                priority = priority,
                enabled = o.optBoolean("enabled", true),
                rules = rules,
                hasFilterText = hasText,
                file = o.optString("file").takeIf { hasText && it.isNotEmpty() },
                updatedAt = o.optLong("updatedAt", 0L),
                filterCount = o.optInt("filterCount", 0)
            )
        }
    }
}

/** The engine's verdict for one request (the Kotlin twin of `Decision` in `rules.ts`). */
class Decision(
    val action: Action,
    val redirectUrl: String? = null,
    /** Set id (or `filter-text` for list matches) and the rule id or filter that decided. */
    val matchedSet: String? = null,
    val matchedRule: Int = 0,
    val matchedFilter: String? = null
) {
    enum class Action { ALLOW, BLOCK, REDIRECT, UPGRADE }

    val isBlocked: Boolean get() = action == Action.BLOCK

    companion object {
        val ALLOW = Decision(Action.ALLOW)
        const val TEXT_SET_ID = "filter-text"
    }
}
