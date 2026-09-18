package app.zen.chromium.blocking

/**
 * One rule set's structured rules indexed for lookup, the way [FilterIndex] indexes network
 * filters: `||host^` rules and rules that select requests by `requestDomains` alone live in a
 * hash map keyed by hostname and are found by walking the request host's label suffixes; every
 * other rule with a `urlFilter` sits in the bucket of its rarest token; rules with nothing to
 * index them by (regular expressions, `*ads*`, type-only rules) are tested for every request.
 *
 * Unlike a filter list a rule set has no first match – the highest effective priority wins, so
 * [forEachCandidate] visits every rule that may match and leaves the resolution to
 * [EngineSnapshot.decide]. `allowAllRequests` rules are kept apart ([allowAll]): they are matched
 * against the request's document as well as the request, which the request's own tokens say
 * nothing about. The index is a superset filter: every visited rule is still put through
 * [DnrRule.matches].
 */
class RuleIndex(rules: List<DnrRule>) {
    /** hostname → DnrRule or Array<DnrRule>. */
    private val hosts = HashMap<String, Any>()
    private val buckets: HashMap<Int, Array<DnrRule>>
    private val wildcard: Array<DnrRule>

    /** `allowAllRequests` rules, in the set's order. */
    val allowAll: Array<DnrRule>

    /** Rules indexed by a token (the rest sit under a hostname or in the wildcard list). */
    val tokenIndexedCount: Int

    init {
        val allowAllRules = ArrayList<DnrRule>()
        val tokenCandidates = ArrayList<DnrRule>()
        val loose = ArrayList<DnrRule>()
        for (rule in rules) {
            if (rule.action == RuleAction.ALLOW_ALL_REQUESTS) {
                allowAllRules.add(rule)
                continue
            }
            val pattern = rule.pattern
            when {
                pattern != null && pattern.isHostnameOnly -> addHost(pattern.hostname, rule)
                pattern == null || pattern.matchesEveryUrl -> byDomainsOrLoose(rule, loose)
                else -> tokenCandidates.add(rule)
            }
        }
        val tokens = ArrayList<IntArray>(tokenCandidates.size)
        val histogram = HashMap<Int, Int>()
        for (rule in tokenCandidates) {
            val t = rule.pattern!!.tokens()
            tokens.add(t)
            for (h in t) histogram[h] = (histogram[h] ?: 0) + 1
        }
        val building = HashMap<Int, ArrayList<DnrRule>>()
        var indexed = 0
        for (i in tokenCandidates.indices) {
            val t = tokens[i]
            val rule = tokenCandidates[i]
            if (t.isEmpty()) {
                byDomainsOrLoose(rule, loose)
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
            building.getOrPut(best) { ArrayList() }.add(rule)
            indexed++
        }
        buckets = HashMap(building.size)
        for ((k, v) in building) buckets[k] = v.toTypedArray()
        wildcard = loose.toTypedArray()
        allowAll = allowAllRules.toTypedArray()
        tokenIndexedCount = indexed
    }

    /** A rule without a usable URL token: under each of its request domains, or in the wildcard list. */
    private fun byDomainsOrLoose(rule: DnrRule, loose: ArrayList<DnrRule>) {
        val domains = rule.requestDomains
        if (domains == null) loose.add(rule) else for (domain in domains) addHost(domain, rule)
    }

    private fun addHost(key: String, rule: DnrRule) {
        when (val existing = hosts[key]) {
            null -> hosts[key] = rule
            is DnrRule -> hosts[key] = arrayOf(existing, rule)
            is Array<*> -> {
                @Suppress("UNCHECKED_CAST")
                hosts[key] = (existing as Array<DnrRule>) + rule
            }
        }
    }

    /** Rules that had no hostname or token to index them by (tested for every request). */
    val wildcardCount: Int get() = wildcard.size

    /** Hostnames the map indexes (`||host^` rules and `requestDomains` entries). */
    val hostCount: Int get() = hosts.size

    /**
     * Visit every rule that may match `req` (other than `allowAllRequests` rules): a rule under
     * several of the host's suffixes or several tokens is visited more than once, which the
     * resolution does not mind.
     */
    fun forEachCandidate(req: Request, visit: (DnrRule) -> Unit) {
        if (hosts.isNotEmpty()) {
            // The request's suffixes are computed once and shared with the rules' domain conditions.
            for (key in req.hostSuffixes) {
                when (val hit = hosts[key]) {
                    is DnrRule -> visit(hit)
                    is Array<*> -> for (item in hit) visit(item as DnrRule)
                }
            }
        }
        if (buckets.isNotEmpty()) {
            for (t in req.tokens) {
                val bucket = buckets[t] ?: continue
                for (rule in bucket) visit(rule)
            }
        }
        for (rule in wildcard) visit(rule)
    }
}
