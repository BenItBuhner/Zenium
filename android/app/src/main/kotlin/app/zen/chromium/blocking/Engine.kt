package app.zen.chromium.blocking

/**
 * An immutable, fully compiled view of the rule sets: the enabled sets' structured rules in
 * priority order plus one text engine over the enabled filter lists. `decide` follows the
 * declarativeNetRequest resolution of the TypeScript engine (`src/core/blocking/engine.ts`):
 * highest effective priority wins, allow beats block within a priority, a full tie goes to the
 * rule met first in the sets' and their rules' order (so two equal redirects name the target the
 * desktop names), `allowAllRequests`
 * matched by a request's document allows the request, a set scoped to partitions takes part
 * only in requests of one of them, and filter-list matches take part at the filter-list
 * priority with uBlock Origin's `@@` / `$important` semantics resolved inside the text engine.
 * Header edits are not applied on Android.
 *
 * Structured rules are looked up through each set's [RuleIndex] (a request visits the rules
 * under its host's suffixes and its URL's tokens, plus the few with nothing to index them by),
 * so an extension's tens of thousands of rules cost a request microseconds, not a scan.
 */
class EngineSnapshot(sets: Collection<RuleSetInfo>, private val text: TextEngine?) {
    private val ordered: List<RuleSetInfo> = sets
        .filter { it.enabled && it.rules.isNotEmpty() }
        .sortedWith(compareByDescending<RuleSetInfo> { it.priority }.thenBy { it.id })

    /** Every set the snapshot was built from, enabled or not. */
    val setCount: Int = sets.size

    /** Network filters in the text engine. */
    val filterCount: Int get() = text?.filterCount ?: 0

    /** Structured rules across the enabled sets. */
    val ruleCount: Int = ordered.sumOf { it.rules.size }

    /** The enabled sets with structured rules, highest priority first (diagnostics). */
    val ruleSets: List<RuleSetInfo> get() = ordered

    /**
     * A matching rule's claim. `order` is where the linear scan would have met it – the set's
     * place in [ordered] above the rule's [DnrRule.position] – and breaks a full tie the way
     * the scan (and the TypeScript engine) does: the first met wins.
     */
    private class Candidate(val effective: Long, val rank: Int, val order: Long, val decision: Decision)

    private fun orderOf(setIndex: Int, rule: DnrRule): Long = (setIndex.toLong() shl 32) or rule.position.toLong()

    fun decide(req: Request): Decision {
        var best: Candidate? = null
        var frameComputed = false
        var frame: Request? = null
        for ((setIndex, set) in ordered.withIndex()) {
            if (!set.appliesTo(req.partition)) continue
            val current = best
            // Lower bands cannot beat a definitive winner from a higher band.
            if (current != null && set.priority < current.effective / (DnrRule.RULE_PRIORITY_MAX + 1)) break
            set.index.forEachCandidate(req) { rule ->
                if (rule.matches(req)) {
                    decisionFor(set.id, rule, req)?.let {
                        best = better(best, Candidate(rule.effective, rule.action.rank, orderOf(setIndex, rule), it))
                    }
                }
            }
            for (rule in set.index.allowAll) {
                var hit = rule.matches(req)
                if (!hit) {
                    if (!frameComputed) {
                        frame = frameContext(req)
                        frameComputed = true
                    }
                    val f = frame
                    hit = f != null && rule.matches(f)
                }
                if (!hit) continue
                val decision = decisionFor(set.id, rule, req) ?: continue
                best = better(best, Candidate(rule.effective, rule.action.rank, orderOf(setIndex, rule), decision))
            }
        }
        return resolveText(best, req)
    }

    /** The filter lists' word, against the structured rules' best candidate so far. */
    private fun resolveText(structured: Candidate?, req: Request): Decision {
        var best = structured
        if (text != null) {
            val current = best
            val allowedAbove = current != null && current.decision.action == Decision.Action.ALLOW && current.effective >= TEXT_EFFECTIVE
            if (!allowedAbove && (current == null || current.effective <= TEXT_EFFECTIVE)) {
                val match = text.match(req)
                if (match != null) {
                    val filter = match.filter.toString()
                    val decision = when (match.action) {
                        TextMatch.Action.ALLOW -> Decision(Decision.Action.ALLOW, matchedSet = Decision.TEXT_SET_ID, matchedFilter = filter)
                        TextMatch.Action.BLOCK -> Decision(Decision.Action.BLOCK, matchedSet = Decision.TEXT_SET_ID, matchedFilter = filter)
                        // A `$redirect` filter: no target URL, the host answers with a neutered resource.
                        TextMatch.Action.REDIRECT -> Decision(Decision.Action.REDIRECT, matchedSet = Decision.TEXT_SET_ID, matchedFilter = filter)
                    }
                    val rank = when (match.action) {
                        TextMatch.Action.ALLOW -> RuleAction.ALLOW.rank
                        TextMatch.Action.BLOCK -> RuleAction.BLOCK.rank
                        TextMatch.Action.REDIRECT -> RuleAction.REDIRECT.rank
                    }
                    // Met after every structured rule: a structured rule of the same priority and rank keeps the tie.
                    best = better(best, Candidate(TEXT_EFFECTIVE, rank, Long.MAX_VALUE, decision))
                }
            }
        }
        return best?.decision ?: Decision.ALLOW
    }

    private fun better(current: Candidate?, candidate: Candidate): Candidate =
        if (current == null || candidate.effective > current.effective ||
            (candidate.effective == current.effective &&
                (candidate.rank > current.rank || (candidate.rank == current.rank && candidate.order < current.order)))
        ) candidate else current

    private fun decisionFor(setId: String, rule: DnrRule, req: Request): Decision? = when (rule.action) {
        RuleAction.ALLOW, RuleAction.ALLOW_ALL_REQUESTS -> Decision(Decision.Action.ALLOW, matchedSet = setId, matchedRule = rule.id)
        RuleAction.BLOCK -> Decision(Decision.Action.BLOCK, matchedSet = setId, matchedRule = rule.id)
        RuleAction.UPGRADE_SCHEME -> rule.target(req.url)?.let { Decision(Decision.Action.UPGRADE, it, setId, rule.id) }
        RuleAction.REDIRECT -> rule.target(req.url)?.let { Decision(Decision.Action.REDIRECT, it, setId, rule.id) }
    }

    /**
     * The navigation request of the document `req` belongs to (what `allowAllRequests` rules are
     * matched against); null for main-frame navigations and requests without a document.
     */
    private fun frameContext(req: Request): Request? {
        if (req.type == ResourceType.MAIN_FRAME) return null
        val url = req.documentUrl ?: return null
        return Request(url, ResourceType.MAIN_FRAME, null, "GET", thirdParty = false, tabId = req.tabId, partition = req.partition)
    }

    /**
     * The same resolution over every rule of every applicable set, without the index: the
     * reference [decide] is checked against in tests, and what a diagnostics run compares to.
     */
    internal fun decideLinear(req: Request): Decision {
        var best: Candidate? = null
        var frameComputed = false
        var frame: Request? = null
        for ((setIndex, set) in ordered.withIndex()) {
            if (!set.appliesTo(req.partition)) continue
            val current = best
            if (current != null && set.priority < current.effective / (DnrRule.RULE_PRIORITY_MAX + 1)) break
            for (rule in set.rules) {
                var hit = rule.matches(req)
                if (!hit && rule.action == RuleAction.ALLOW_ALL_REQUESTS) {
                    if (!frameComputed) {
                        frame = frameContext(req)
                        frameComputed = true
                    }
                    val f = frame
                    hit = f != null && rule.matches(f)
                }
                if (!hit) continue
                val decision = decisionFor(set.id, rule, req) ?: continue
                best = better(best, Candidate(rule.effective, rule.action.rank, orderOf(setIndex, rule), decision))
            }
        }
        return resolveText(best, req)
    }

    companion object {
        /** Priority band of subscribed filter lists (`RULE_SET_PRIORITY.filterList` in `rules.ts`). */
        const val FILTER_LIST_PRIORITY = 1

        /** Effective priority of a filter-text match. */
        val TEXT_EFFECTIVE: Long = DnrRule.effectivePriority(FILTER_LIST_PRIORITY, 1)

        val EMPTY = EngineSnapshot(emptyList(), null)
    }
}
