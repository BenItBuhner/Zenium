import type { RuleEngine } from '../../../core/blocking/engine'
import type { Decision, RequestContext } from '../../../core/blocking/rules'
import type { EngineRuleSet, RuleSink } from '../../../core/extensions/dnr/sink'
import type { ExtensionResourceOrigin } from './resourceOrigin'

/**
 * Where the declarativeNetRequest translator's rule sets go on desktop: straight into the core's
 * request-blocking engine (`src/core/blocking/engine.ts`), whose `setRuleSet` / `removeRuleSet`
 * are the `RuleSink` contract (`core/extensions/dnr/sink.ts` mirrors the engine's rule types).
 * The engine sits behind the session's `webRequest` multiplexer (`platform/blocking.ts`), so a
 * set handed over here filters requests from the next one on. Set ids
 * (`ext:<extensionId>:static:<rulesetId>`, `:_dynamic`, `:_session`), the priority band
 * (`RULE_SET_PRIORITY.dnr`, newest install highest) and the attribution the blocking settings
 * show follow `internal/parity-services/blocking-rule-interface.md`.
 *
 * Decisions come back the other way: `ElectronBlocking.onDecision` reports every decision that
 * named a rule, and `DeclarativeNetRequestHostApi.decided` routes the ones from an extension's
 * set into its matched-rule log, action count and `onRuleMatchedDebug`.
 *
 * Redirects to an extension's `use_dynamic_url` resources are rewritten on the way in to the
 * origin Zenium serves them from (`resourceOrigin.ts`); Chromium refuses them at the static
 * `chrome-extension://<id>/` URL.
 */
export function createDnrSink(
  engine: RuleEngine,
  resources?: Pick<ExtensionResourceOrigin, 'rewriteSet'>
): RuleSink {
  return {
    setRuleSet: (set) => engine.setRuleSet(resources ? resources.rewriteSet(set) : set),
    removeRuleSet: (id) => engine.removeRuleSet(id)
  }
}

/** A decision the engine took and the request it was about, as `ElectronBlocking` reports it. */
export interface EngineDecisionReport {
  ctx: RequestContext
  decision: Decision
}

/**
 * An in-memory `RuleSink` for tests and diagnostics: holds the sets the translator emits without
 * filtering anything (`ruleCount` counts across every held set).
 */
export class InMemoryRuleSink implements RuleSink {
  readonly sets = new Map<string, EngineRuleSet>()

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  setRuleSet(set: EngineRuleSet): void {
    this.sets.set(set.id, set)
    this.log(
      `[zen] dnr sink: set ${set.id} (${set.rules?.length ?? 0} rules, priority ${set.priority})`
    )
  }

  removeRuleSet(id: string): void {
    if (this.sets.delete(id)) this.log(`[zen] dnr sink: removed ${id}`)
  }

  ruleCount(): number {
    let count = 0
    for (const set of this.sets.values()) count += set.rules?.length ?? 0
    return count
  }
}
