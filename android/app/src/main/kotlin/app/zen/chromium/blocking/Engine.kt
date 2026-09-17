package app.zen.chromium.blocking

/**
 * An immutable, fully compiled view of the rule sets: the enabled sets' structured rules in
 * priority order plus one text engine over the enabled filter lists. `decide` follows the
 * declarativeNetRequest resolution of the TypeScript engine (`src/core/blocking/engine.ts`):
 * highest effective priority wins, allow beats block within a priority, `allowAllRequests`
 * matched by a request's document allows the request, and filter-list matches take part at the
 * filter-list priority with uBlock Origin's `@@` / `$important` semantics resolved inside the
 * text engine. Header edits are not applied on Android.
 */
class EngineSnapshot(sets: Collection<RuleSetInfo>, private val text: TextEngine?) {
    private val ordered: List<RuleSetInfo> = sets
        .filter { it.enabled && it.rules.isNotEmpty() }
        .sortedWith(compareByDescending<RuleSetInfo> { it.priority }.thenBy { it.id })

    /** Every set the snapshot was built from, enabled or not. */
    val setCount: Int = sets.size

    /** Network filters in the text engine. */
    val filterCount: Int get() = text?.filterCount ?: 0

    private class Candidate(val effective: Long, val rank: Int, val decision: Decision)

    fun decide(req: Request): Decision {
        var best: Candidate? = null
        var frameComputed = false
        var frame: Request? = null
        for (set in ordered) {
            val current = best
            // Lower bands cannot beat a definitive winner from a higher band.
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
                best = better(best, Candidate(rule.effective, rule.action.rank, decision))
            }
        }
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
                    best = better(best, Candidate(TEXT_EFFECTIVE, rank, decision))
                }
            }
        }
        return best?.decision ?: Decision.ALLOW
    }

    private fun better(current: Candidate?, candidate: Candidate): Candidate =
        if (current == null || candidate.effective > current.effective ||
            (candidate.effective == current.effective && candidate.rank > current.rank)
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
        return Request(url, ResourceType.MAIN_FRAME, null, "GET", thirdParty = false, tabId = req.tabId)
    }

    companion object {
        /** Priority band of subscribed filter lists (`RULE_SET_PRIORITY.filterList` in `rules.ts`). */
        const val FILTER_LIST_PRIORITY = 1

        /** Effective priority of a filter-text match. */
        val TEXT_EFFECTIVE: Long = DnrRule.effectivePriority(FILTER_LIST_PRIORITY, 1)

        val EMPTY = EngineSnapshot(emptyList(), null)
    }
}
