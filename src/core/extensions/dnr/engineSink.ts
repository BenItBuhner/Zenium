import type { RuleEngine } from '../../blocking/engine'
import type { Decision, RequestContext } from '../../blocking/rules'
import type { RuleSetOwnership } from '../../blocking/service'
import { parseEngineSetId, type EngineRuleSet, type RuleSink } from './sink'

/**
 * Where the declarativeNetRequest translator's rule sets go on both hosts: straight into the
 * core's request-blocking engine (`src/core/blocking/engine.ts`), whose `setRuleSet` /
 * `removeRuleSet` are the `RuleSink` contract (`sink.ts` mirrors the engine's rule types). On
 * the desktop the engine sits behind the session's `webRequest` multiplexer and filters requests
 * from the next one on; on Android the engine's store mirrors every set to `blocking/index.json`,
 * which the Kotlin engine compiles and answers `shouldInterceptRequest` from. Set ids
 * (`ext:<extensionId>:static:<rulesetId>`, `:_dynamic`, `:_session`), the priority band
 * (`RULE_SET_PRIORITY.dnr`, newest install highest) and the attribution the blocking settings
 * show follow `internal/parity-services/blocking-rule-interface.md`.
 *
 * The engine is one per profile while requests run in per-container sessions, so every set is
 * scoped on the way in to the partitions its extension is loaded into (`RuleSet.partitions`,
 * from `DnrSinkScope.partitionsOf`): a private window or tab, whose session holds no extension,
 * is never filtered by an extension's rules unless the user allowed the extension there.
 * `rescope` follows an extension into (or out of) a session without re-sending rules.
 *
 * Decisions come back the other way: the host's engine reports every decision that named a
 * rule, and the host's declarativeNetRequest layer routes the ones from an extension's set into
 * its matched-rule log, action count and `onRuleMatchedDebug`.
 *
 * A host may rewrite sets on the way in (`RuleSetRewriter`): the desktop sends redirects to an
 * extension's `use_dynamic_url` resources to the origin it serves them from.
 *
 * The engine persists the sets across runs, so an extension removed or disabled while the app
 * was closed leaves its sets behind; at start each host declares the extensions that are alive
 * with `browser.blocking.reconcileOwners(DNR_OWNERSHIP, ids)` and the engine drops the rest.
 */
export interface DnrSinkScope {
  /** The session partitions (container ids) an extension's rules apply to right now. */
  partitionsOf(extensionId: string): readonly string[]
}

/**
 * Who owns an `ext:` set, for the engine's owner reconciliation at start
 * (`BlockingService.reconcileOwners`): the extension whose id the set id carries; a `dnr` set
 * with an id of another shape has no owner and is dropped.
 */
export const DNR_OWNERSHIP: RuleSetOwnership = {
  source: 'dnr',
  ownerOf: (setId) => parseEngineSetId(setId)?.extensionId
}

/** A `RuleSink` that also follows an extension's sessions. */
export interface ScopedRuleSink extends RuleSink {
  /** The partitions of an extension changed: re-scope every set it has in the engine. */
  rescope(extensionId: string): void
}

/** Rewrites a translated set before the engine sees it (the desktop's extension resource origin). */
export interface RuleSetRewriter {
  rewriteSet(set: EngineRuleSet): EngineRuleSet
}

/**
 * The engine, or a getter for it: a host whose extension layer is built inside the `Browser`
 * constructor (Android's `createExtensions`) has no `browser.blocking` yet at that point; the
 * sink reads the getter at the first set, never before.
 */
export type EngineSource = RuleEngine | (() => RuleEngine)

export function createDnrSink(
  engine: EngineSource,
  resources?: RuleSetRewriter,
  scope?: DnrSinkScope
): ScopedRuleSink {
  const engineOf = typeof engine === 'function' ? engine : (): RuleEngine => engine
  const scoped = (set: EngineRuleSet): EngineRuleSet => {
    if (!scope) return set
    const parsed = parseEngineSetId(set.id)
    if (!parsed) return set
    return { ...set, partitions: [...scope.partitionsOf(parsed.extensionId)] }
  }
  return {
    setRuleSet: (set) => {
      const own = scoped(set)
      engineOf().setRuleSet(resources ? resources.rewriteSet(own) : own)
    },
    removeRuleSet: (id) => engineOf().removeRuleSet(id),
    rescope: (extensionId) => {
      if (!scope) return
      const partitions = [...scope.partitionsOf(extensionId)]
      const target = engineOf()
      for (const summary of target.listRuleSets()) {
        if (parseEngineSetId(summary.id)?.extensionId !== extensionId) continue
        target.setPartitions(summary.id, partitions)
      }
    }
  }
}

/** A decision the engine took and the request it was about, as a host's engine reports it. */
export interface EngineDecisionReport {
  ctx: RequestContext
  decision: Decision
}

/**
 * An in-memory `RuleSink` for tests and diagnostics: holds the sets the translator emits without
 * filtering anything (`ruleCount` counts across every held set).
 */
export class InMemoryRuleSink implements ScopedRuleSink {
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

  rescope(): void {
    /* holds sets as given */
  }

  ruleCount(): number {
    let count = 0
    for (const set of this.sets.values()) count += set.rules?.length ?? 0
    return count
  }
}
