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
    /** `initiatorDomains`, lowercased; the document host must be one or a subdomain of one. Read by [RuleIndex]. */
    val initiatorDomains: Set<String>?,
    private val excludedInitiatorDomains: Set<String>?,
    /** `requestDomains`, lowercased; a request host matches when it is one or a subdomain of one. Read by [RuleIndex]. */
    val requestDomains: Set<String>?,
    private val excludedRequestDomains: Set<String>?,
    /**
     * `topDomains` / `excludedTopDomains`, lowercased: conditions on the top-level document's host
     * (Chrome's `top_level_frame_or_initiator_host`: a main-frame navigation's own host, else the
     * document's, which is what [Request.documentHost] holds). A rule with `topDomains` never matches
     * a request whose top-level host is unknown; `excludedTopDomains` then has nothing to exclude.
     */
    private val topDomains: Set<String>?,
    private val excludedTopDomains: Set<String>?,
    /** Zenium's addition to the shape: never match a non-unique host (`excludedNonUniqueHosts` in `rules.ts`). */
    private val excludedNonUniqueHosts: Boolean,
    /** `resourceTypes` as [ResourceType] bits; 0 for any type. Read by [RuleIndex]. */
    val typeMask: Int,
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

    /**
     * The rule's index in its set's [CompiledRules.rules] (resolution order, a stable sort of the
     * set's own order), set once by [CompiledRules.of]. On a full tie – equal effective priority
     * and action – the lower position wins, which is the first rule the TypeScript engine's scan
     * meets; the index visits rules in bucket order and needs this to agree with it.
     */
    internal var position: Int = -1

    fun matches(req: Request): Boolean {
        val candidates = ResourceType.candidateMask(req.typeMask, unscoped)
        if (typeMask != 0 && (typeMask and candidates) == 0) return false
        // An excluded type only rules the request out when every type it might be is excluded.
        if (excludedTypeMask != 0 && (candidates and excludedTypeMask.inv()) == 0) return false
        if (methods != null && req.methodLower !in methods) return false
        if (excludedMethods != null && req.methodLower in excludedMethods) return false
        if (domainType == 2 && !req.isThirdParty) return false
        if (domainType == 1 && req.isThirdParty) return false
        if (tabIds != null || excludedTabIds != null) {
            val tab = req.tabNumber
            if (tabIds != null && (tab == null || tab !in tabIds)) return false
            if (excludedTabIds != null && tab != null && tab in excludedTabIds) return false
        }
        if (requestDomains != null || excludedRequestDomains != null) {
            if (!matchesDomains(req.hostSuffixes, requestDomains, excludedRequestDomains)) return false
        }
        if (excludedNonUniqueHosts && NonUniqueHost.isNonUnique(req.host)) return false
        if (initiatorDomains != null || excludedInitiatorDomains != null) {
            // A navigation has no initiator: `initiatorDomains` never matches it, `excludedInitiatorDomains` never excludes it.
            val initiator = if (req.type == ResourceType.MAIN_FRAME) EMPTY_SUFFIXES else req.documentHostSuffixes
            if (initiatorDomains != null && initiator.isEmpty()) return false
            if (!matchesDomains(initiator, initiatorDomains, excludedInitiatorDomains)) return false
        }
        if (topDomains != null || excludedTopDomains != null) {
            val top = req.documentHostSuffixes
            if (topDomains != null && top.isEmpty()) return false
            if (!matchesDomains(top, topDomains, excludedTopDomains)) return false
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

        private val EMPTY_SUFFIXES = emptyArray<String>()

        private fun matchesDomains(suffixes: Array<String>, include: Set<String>?, exclude: Set<String>?): Boolean {
            if (exclude != null && hasDomainOf(suffixes, exclude)) return false
            if (include != null) return hasDomainOf(suffixes, include)
            return true
        }

        /**
         * Whether the host or one of its parent domains is in `domains`: the host's label
         * suffixes (`Request.hostSuffixes`) are looked up in turn, so a list of tens of thousands
         * of domains (uBlock Origin Lite folds whole hosts files into one rule's `requestDomains`)
         * costs as many lookups as the host has labels, not one comparison per domain.
         */
        fun hasDomainOf(suffixes: Array<String>, domains: Set<String>): Boolean {
            for (key in suffixes) if (key in domains) return true
            return false
        }

        /** [hasDomainOf] for a host given as a string (tests and one-off callers). */
        fun hasDomainOf(host: String, domains: Set<String>): Boolean = hasDomainOf(Domains.suffixesOf(host), domains)

        private fun hasEntries(o: JSONObject, key: String): Boolean = (o.optJSONArray(key)?.length() ?: 0) > 0

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
                topDomains = strings(c, "topDomains"),
                excludedTopDomains = strings(c, "excludedTopDomains"),
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
 * A set's structured rules compiled for matching, in resolution order (highest effective
 * priority first, then the action's rank, ties in the set's own order – the order the
 * TypeScript engine scans them in, which [DnrRule.position] records), with their [RuleIndex]. Built on the engine's
 * builder thread and immutable after; a set that [IndexReader] recognises as unchanged keeps
 * the same instance across snapshot rebuilds, `fingerprint` naming what it was compiled from
 * (null when the set must be compiled at every read).
 */
class CompiledRules private constructor(val rules: List<DnrRule>, val fingerprint: String?) {
    val index: RuleIndex = RuleIndex(rules)

    companion object {
        /** No rules, compiled from nothing. */
        val NONE = CompiledRules(emptyList(), null)

        private val RESOLUTION_ORDER = compareByDescending<DnrRule> { it.effective }.thenByDescending { it.action.rank }

        /** Takes ownership of `rules`, sorts them into resolution order and numbers them ([DnrRule.position]). */
        fun of(rules: MutableList<DnrRule>, fingerprint: String? = null): CompiledRules {
            if (rules.isEmpty() && fingerprint == null) return NONE
            rules.sortWith(RESOLUTION_ORDER)
            for (i in rules.indices) rules[i].position = i
            return CompiledRules(rules, fingerprint)
        }

        /** Compiles the `rules` array of a set with `priority`; rules that cannot be evaluated are left out. */
        fun parse(arr: JSONArray?, priority: Int, fingerprint: String? = null): CompiledRules {
            val rules = ArrayList<DnrRule>(arr?.length() ?: 0)
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val rule = arr.optJSONObject(i) ?: continue
                    DnrRule.parse(rule, priority)?.let { rules.add(it) }
                }
            }
            return of(rules, fingerprint)
        }
    }
}

/**
 * A rule set as the core persists it (a `blocking/index.json` summary with the structured rules
 * of its `blocking/sets/` document, or a `blocking.sync` change): metadata, compiled structured
 * rules (and their [RuleIndex]), the partitions it is scoped to, and where its filter text lives.
 */
class RuleSetInfo(
    val id: String,
    val source: String,
    val priority: Int,
    val enabled: Boolean,
    /** The structured rules compiled for matching; shared with the previous snapshot while the set is unchanged. */
    val compiled: CompiledRules,
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
    /** The compiled rules in resolution order. */
    val rules: List<DnrRule> get() = compiled.rules

    /** The rules indexed for lookup. */
    val index: RuleIndex get() = compiled.index

    /** Changes to any of these mean the filter text must be re-read. */
    val textFingerprint: String get() = "$file:$updatedAt:$filterCount"

    /** Whether the set takes part in requests of `partition` (`appliesToPartition` in `engine.ts`). */
    fun appliesTo(partition: String?): Boolean {
        val scope = partitions ?: return true
        return partition != null && partition in scope
    }

    companion object {
        /**
         * One entry of the index as an `org.json` document with its `rules` – inline in a
         * version-1 entry, or passed in from the set's document (`blocking/sets/<name>.json`) for
         * a summary. The tests' fixtures; the engine reads the files through [IndexReader].
         */
        fun parse(o: JSONObject, rules: JSONArray? = o.optJSONArray("rules")): RuleSetInfo? {
            val id = o.optString("id")
            if (id.isEmpty() || !o.has("priority")) return null
            val priority = o.optInt("priority")
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
                compiled = CompiledRules.parse(rules, priority),
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
