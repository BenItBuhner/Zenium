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
    /** The `urlFilter` / `regexFilter`; null when the rule has neither. Read by [RuleIndex]. */
    val pattern: UrlPattern?,
    private val initiatorDomains: Set<String>?,
    private val excludedInitiatorDomains: Set<String>?,
    /** `requestDomains`, lowercased; a request host matches when it is one or a subdomain of one. Read by [RuleIndex]. */
    val requestDomains: Set<String>?,
    private val excludedRequestDomains: Set<String>?,
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

        private fun matchesDomains(host: String, include: Set<String>?, exclude: Set<String>?): Boolean {
            if (exclude != null && hasDomainOf(host, exclude)) return false
            if (include != null) return hasDomainOf(host, include)
            return true
        }

        /**
         * Whether `host` or one of its parent domains is in `domains`: the host's label suffixes
         * are looked up in turn, so a list of tens of thousands of domains (uBlock Origin Lite
         * folds whole hosts files into one rule's `requestDomains`) costs as many lookups as the
         * host has labels, not one comparison per domain.
         */
        fun hasDomainOf(host: String, domains: Set<String>): Boolean {
            if (host.isEmpty()) return false
            var start = 0
            while (true) {
                val key = if (start == 0) host else host.substring(start)
                if (key in domains) return true
                val dot = host.indexOf('.', start)
                if (dot == -1) return false
                start = dot + 1
            }
        }

        private fun strings(o: JSONObject, key: String): Set<String>? {
            val arr = o.optJSONArray(key) ?: return null
            val out = HashSet<String>(arr.length() * 2)
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
                methods = strings(c, "requestMethods"),
                excludedMethods = strings(c, "excludedRequestMethods"),
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
 * metadata, compiled structured rules (and their [RuleIndex]), the partitions it is scoped to,
 * and where its filter text lives.
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
    val filterCount: Int,
    /**
     * Session partitions the set applies to (`RuleSet.partitions`): container ids, `private`
     * for private tabs. Null for a set that applies everywhere. An extension's sets arrive
     * scoped to the partitions it is loaded into, so a private tab's requests never meet the
     * rules of an extension the user has not allowed there.
     */
    val partitions: Set<String>? = null
) {
    /** Changes to any of these mean the filter text must be re-read. */
    val textFingerprint: String get() = "$file:$updatedAt:$filterCount"

    /** The rules indexed for lookup; built once with the set, on the builder thread. */
    val index: RuleIndex = RuleIndex(rules)

    /** Whether the set takes part in requests of `partition` (`appliesToPartition` in `engine.ts`). */
    fun appliesTo(partition: String?): Boolean {
        val scope = partitions ?: return true
        return partition != null && partition in scope
    }

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
            val partitions = o.optJSONArray("partitions")?.let { arr ->
                val out = HashSet<String>()
                for (i in 0 until arr.length()) {
                    val p = arr.optString(i, "")
                    if (p.isNotEmpty()) out.add(p)
                }
                out
            }
            return RuleSetInfo(
                id = id,
                source = o.optString("source", "filter-list"),
                priority = priority,
                enabled = o.optBoolean("enabled", true),
                rules = rules,
                hasFilterText = hasText,
                file = o.optString("file").takeIf { hasText && it.isNotEmpty() },
                updatedAt = o.optLong("updatedAt", 0L),
                filterCount = o.optInt("filterCount", 0),
                partitions = partitions
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
