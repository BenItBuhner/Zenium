import type { EngineRuleSet, RuleSink } from '../../../core/extensions/dnr/sink'

/**
 * Where the declarativeNetRequest translator's rule sets go on desktop.
 *
 * Until the shared-services blocking engine lands (`src/core/blocking/engine.ts` with its Electron
 * multiplexer `src/main/platform/blocking.ts`, branch `cursor/services-blocking-24d1`), the sets
 * are held here in memory and logged: extensions see their rulesets enabled and counted, no
 * request is filtered yet. The swap when that branch merges is this one file:
 *
 *   import type { RuleEngine } from '../../../core/blocking/engine'
 *   export function createDnrSink(engine: RuleEngine): RuleSink {
 *     return engine   // `RuleEngine` implements `setRuleSet` / `removeRuleSet` directly
 *   }
 *
 * and `ExtensionApiHost` receives the platform's engine instead of `new InMemoryRuleSink()`.
 * The engine's decisions then flow back through `routeDecision` (`core/extensions/dnr/sink.ts`)
 * into `DeclarativeNetRequestApi.recordDecision`, which fills `getMatchedRules` and
 * `onRuleMatchedDebug`. Set ids (`ext:<extensionId>:static:<rulesetId>`, `:_dynamic`,
 * `:_session`), priorities (`ENGINE_DNR_PRIORITY` band) and attribution already follow
 * `internal/parity-services/blocking-rule-interface.md`, so nothing else changes.
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

  /** Rule count across every held set, for diagnostics. */
  ruleCount(): number {
    let count = 0
    for (const set of this.sets.values()) count += set.rules?.length ?? 0
    return count
  }
}
