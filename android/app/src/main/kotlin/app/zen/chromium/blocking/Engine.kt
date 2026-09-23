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
 * `modifyHeaders` rules never decide: when the request is neither blocked nor redirected, the
 * edits of those above the allow that stands ride on the decision, highest effective priority
 * first ([Decision.requestHeaderEdits], [Decision.responseHeaderEdits]); on Android only a
 * document's are applied, by the header stage's relay ([HeaderStage]).
 *
 * Rules with response header conditions (`responseHeaders` / `excludedResponseHeaders`) are
 * decided in two stages as on the desktop: [decide] without headers is the request stage and
 * marks an allow one of them could still overturn ([Decision.needsHeaders]); [decide] with the
 * response's headers is the headers-received stage ([HeaderStage] relays the document request to
 * reach it), where the `modifyHeaders` rules of both stages apply together.
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

    /** Structured rules with response header conditions across the enabled sets. */
    val headerRuleCount: Int = ordered.sumOf { set -> set.rules.count { it.needsHeaders } }

    /** `modifyHeaders` rules across the enabled sets. */
    val modifyHeadersRuleCount: Int = ordered.sumOf { set -> set.rules.count { it.editsHeaders } }

    /** The enabled sets with structured rules, highest priority first (diagnostics). */
    val ruleSets: List<RuleSetInfo> get() = ordered

    /**
     * Decide `req`. Without `responseHeaders` this is the request stage: rules with response
     * header conditions are left aside, and an allow (or no match) that one of them – selected by
     * its other conditions – could still overturn carries [Decision.needsHeaders]. With them (the
     * response's headers indexed by lowercase name, [HeaderCondition.index]) it is the
     * headers-received stage: those rules are evaluated too and the two stages merge as Chrome's
     * `RulesetManager` merges them – a request-stage block or redirect stands, a request-stage
     * allow caps the header stage (a header rule of equal or lower effective priority yields), a
     * header-stage allow caps the request stage's header edits, a header-stage block or redirect
     * wins over the allow and over the header edits of either stage, and the `modifyHeaders`
     * rules of both stages apply together, highest priority first.
     */
    fun decide(req: Request, responseHeaders: Map<String, List<String>>? = null): Decision {
        val resolution = Resolution(responseHeaders)
        var frameComputed = false
        var frame: Request? = null
        for ((setIndex, set) in ordered.withIndex()) {
            if (!set.appliesTo(req.partition)) continue
            // Lower bands cannot beat a definitive winner from a higher band.
            if (resolution.best != null && set.priority < resolution.band()) break
            set.index.forEachCandidate(req) { rule ->
                if (rule.matches(req)) resolution.claim(set.id, setIndex, rule, req)
            }
            for (rule in set.index.allowAll) {
                var hit = rule.matches(req)
                // The document's headers are not at hand: a header-conditioned `allowAllRequests`
                // only matches the frame request itself (as on the desktop).
                if (!hit && !rule.needsHeaders) {
                    if (!frameComputed) {
                        frame = frameContext(req)
                        frameComputed = true
                    }
                    val f = frame
                    hit = f != null && rule.matches(f)
                }
                if (!hit) continue
                resolution.claim(set.id, setIndex, rule, req)
            }
        }
        return conclude(resolution, req)
    }

    /**
     * Merge the stages of `resolution` with the filter lists' word and stack the header edits
     * (the desktop engine's `conclude`). The caps are Chromium's, with their `<` / `<=`
     * asymmetry: a header-stage rule needs strictly more than the request stage's allow; a
     * request-stage `modifyHeaders` rule survives a header-stage allow of equal priority, a
     * header-stage one needs strictly more than either allow.
     */
    private fun conclude(resolution: Resolution, req: Request): Decision {
        val best = resolveText(resolution.best, req)
        if (best != null && best.decision.action != Decision.Action.ALLOW) return best.decision
        // The request stage's allow caps everything the header stage finds.
        val allowEffective = best?.effective ?: -1L
        val allow = best?.decision ?: Decision.ALLOW
        if (resolution.received == null) {
            val applicable = resolution.headers.filter { it.rule.effective > allowEffective }
            val decision = composeHeaderEdits(applicable, allow)
            // A second round is only worth it when a header rule could change the outcome.
            return if (resolution.relayWorthIt(allowEffective, applicable)) decision.awaitingHeaders() else decision
        }
        val late = resolution.bestLate?.takeIf { it.effective > allowEffective }
        if (late != null && late.decision.action != Decision.Action.ALLOW) return late.decision
        // A header-stage allow caps the request stage's header edits (Chrome keeps the ones of
        // equal or higher priority) and its own stage's (strictly higher).
        val lateAllowEffective = late?.effective ?: -1L
        val applicable = resolution.headers.filter { it.rule.effective > allowEffective && it.rule.effective >= lateAllowEffective } +
            resolution.lateHeaders.filter { it.rule.effective > maxOf(allowEffective, lateAllowEffective) }
        return composeHeaderEdits(applicable, late?.decision ?: allow)
    }

    /** The filter lists' word, against the structured rules' best candidate so far. */
    private fun resolveText(structured: Candidate?, req: Request): Candidate? {
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
        return best
    }

    /**
     * The same resolution over every rule of every applicable set, without the index: the
     * reference [decide] is checked against in tests, and what a diagnostics run compares to.
     */
    internal fun decideLinear(req: Request, responseHeaders: Map<String, List<String>>? = null): Decision {
        val resolution = Resolution(responseHeaders)
        var frameComputed = false
        var frame: Request? = null
        for ((setIndex, set) in ordered.withIndex()) {
            if (!set.appliesTo(req.partition)) continue
            if (resolution.best != null && set.priority < resolution.band()) break
            for (rule in set.rules) {
                var hit = rule.matches(req)
                if (!hit && rule.action == RuleAction.ALLOW_ALL_REQUESTS && !rule.needsHeaders) {
                    if (!frameComputed) {
                        frame = frameContext(req)
                        frameComputed = true
                    }
                    val f = frame
                    hit = f != null && rule.matches(f)
                }
                if (!hit) continue
                resolution.claim(set.id, setIndex, rule, req)
            }
        }
        return conclude(resolution, req)
    }

    companion object {
        /** Priority band of subscribed filter lists (`RULE_SET_PRIORITY.filterList` in `rules.ts`). */
        const val FILTER_LIST_PRIORITY = 1

        /** Effective priority of a filter-text match. */
        val TEXT_EFFECTIVE: Long = DnrRule.effectivePriority(FILTER_LIST_PRIORITY, 1)

        val EMPTY = EngineSnapshot(emptyList(), null)
    }
}

/**
 * A matching rule's claim. `order` is where the linear scan would have met it – the set's
 * place in the snapshot's order above the rule's [DnrRule.position] – and breaks a full tie
 * the way the scan (and the TypeScript engine) does: the first met wins.
 */
private class Candidate(val effective: Long, val rank: Int, val order: Long, val decision: Decision)

/** A `modifyHeaders` rule that matched, with its set and where the scan meets it (`HeaderCandidate` in `engine.ts`). */
private class HeaderCandidate(val setId: String, val rule: DnrRule, val order: Long)

/**
 * The claims of one evaluation (the desktop engine's `Resolution`): the request stage's best
 * candidate and its `modifyHeaders` rules ([headers]), and – for rules with response header
 * conditions – either the strongest such rule the request's other conditions selected
 * ([lateEffective] / [lateAllowEffective], without the received headers) or, with them, the
 * best one whose header conditions the response met ([bestLate]) and the `modifyHeaders` rules
 * among them ([lateHeaders]).
 */
private class Resolution(val received: Map<String, List<String>>?) {
    var best: Candidate? = null
    val headers = ArrayList<HeaderCandidate>()
    var bestLate: Candidate? = null
    val lateHeaders = ArrayList<HeaderCandidate>()
    /** Request stage: the strongest header-conditioned block / redirect / upgrade / `modifyHeaders` whose other conditions passed. */
    var lateEffective: Long = -1L
    /** Request stage: the strongest header-conditioned allow / `allowAllRequests` whose other conditions passed. */
    var lateAllowEffective: Long = -1L

    fun claim(setId: String, setIndex: Int, rule: DnrRule, req: Request) {
        if (rule.needsHeaders) {
            if (received == null) {
                // The request stage only notes a header-conditioned rule; `relayWorthIt` weighs
                // what it could change. The two kinds are told apart because a header-conditioned
                // allow yields to the request stage's decision and can only cap header edits.
                if (rule.action == RuleAction.ALLOW || rule.action == RuleAction.ALLOW_ALL_REQUESTS) {
                    if (rule.effective > lateAllowEffective) lateAllowEffective = rule.effective
                } else if (rule.effective > lateEffective) {
                    lateEffective = rule.effective
                }
                return
            }
            if (!rule.matchesHeaders(received)) return
        }
        if (rule.editsHeaders) {
            (if (rule.needsHeaders) lateHeaders else headers).add(HeaderCandidate(setId, rule, orderOf(setIndex, rule)))
            return
        }
        val decision = decisionFor(setId, rule, req) ?: return
        val candidate = Candidate(rule.effective, rule.action.rank, orderOf(setIndex, rule), decision)
        if (rule.needsHeaders) bestLate = better(bestLate, candidate) else best = better(best, candidate)
    }

    /**
     * Request stage: whether the header stage could change the outcome, given the allow that
     * stands (`allowEffective`, -1 for the default) and the request-stage header edits above it
     * (`applicable`). A header-conditioned block / redirect / upgrade / `modifyHeaders` above the
     * allow could; a header-conditioned allow above it only by capping an edit weaker than
     * itself. The desktop engine asks for the second round for any header-conditioned rule above
     * the allow (there it costs microseconds; here it is a network fetch of the document) –
     * recorded deviation, the outcomes are the same.
     */
    fun relayWorthIt(allowEffective: Long, applicable: List<HeaderCandidate>): Boolean {
        if (lateEffective > allowEffective) return true
        return lateAllowEffective > allowEffective && applicable.any { it.rule.effective < lateAllowEffective }
    }

    /** The band the request stage's winner sits in; -1 without one. */
    fun band(): Long = best?.let { it.effective / (DnrRule.RULE_PRIORITY_MAX + 1) } ?: -1L
}

/**
 * The `modifyHeaders` decision of `applicable` (already capped), highest effective priority
 * first and, within one, in the order the scan meets them; `otherwise` when none is left
 * (`composeHeaderEdits` in `engine.ts`). The first rule is the decision's match.
 */
private fun composeHeaderEdits(applicable: List<HeaderCandidate>, otherwise: Decision): Decision {
    if (applicable.isEmpty()) return otherwise
    val sorted = applicable.sortedWith(compareByDescending<HeaderCandidate> { it.rule.effective }.thenBy { it.order })
    val request = ArrayList<HeaderOp>()
    val response = ArrayList<HeaderOp>()
    for (candidate in sorted) {
        val rule = candidate.rule
        // A header-conditioned rule decides once the request is out, so it can only edit the
        // response (Chrome refuses its `requestHeaders` at parse); a set written by hand gets
        // the same treatment here.
        if (!rule.needsHeaders) rule.requestHeaderEdits?.let(request::addAll)
        rule.responseHeaderEdits?.let(response::addAll)
    }
    val first = sorted[0]
    return Decision(
        Decision.Action.MODIFY_HEADERS, matchedSet = first.setId, matchedRule = first.rule.id,
        requestHeaderEdits = request, responseHeaderEdits = response
    )
}

private fun orderOf(setIndex: Int, rule: DnrRule): Long = (setIndex.toLong() shl 32) or rule.position.toLong()

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
    // Never a decision of its own: `Resolution.claim` stacks it (`composeHeaderEdits`).
    RuleAction.MODIFY_HEADERS -> null
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
