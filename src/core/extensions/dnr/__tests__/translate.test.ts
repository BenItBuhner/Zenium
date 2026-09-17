import { describe, expect, test } from 'vitest'
import {
  DnrTranslator,
  compareForEmission,
  enginePriorityForRank,
  translateExtension,
  translateRule,
  translateRuleset,
  type TranslateExtension
} from '../translate'
import {
  ENGINE_DNR_BAND_SIZE,
  ENGINE_DNR_PRIORITY,
  dnrAttribution,
  engineSetId,
  parseEngineSetId,
  routeDecision,
  type EngineRule,
  type EngineRuleSet,
  type RuleSink
} from '../sink'
import {
  CHROME_EXAMPLE_RULES,
  EXTENSION_BASE_URL,
  EXTENSION_ID,
  compileAll,
  rule
} from './fixtures'
import type { CompiledRule } from '../rules'

function compiled(id: number): CompiledRule {
  const found = compileAll(CHROME_EXAMPLE_RULES).find((r) => r.id === id)
  if (!found) throw new Error(`no example rule ${id}`)
  return found
}

function engineRule(id: number): EngineRule {
  const out = translateRule(compiled(id))
  if ('reason' in out) throw new Error(`rule ${id} skipped: ${out.reason}`)
  return out
}

class RecordingSink implements RuleSink {
  readonly sets = new Map<string, EngineRuleSet>()
  readonly log: string[] = []
  setRuleSet(set: EngineRuleSet): void {
    this.sets.set(set.id, set)
    this.log.push(`set ${set.id}`)
  }
  removeRuleSet(id: string): void {
    this.sets.delete(id)
    this.log.push(`remove ${id}`)
  }
}

describe('translateRule', () => {
  test('block rule: condition fields carry over, priority 1 is left implicit', () => {
    expect(engineRule(1)).toEqual({
      id: 1,
      action: { type: 'block' },
      condition: { urlFilter: 'abc', initiatorDomains: ['foo.com'], resourceTypes: ['script'] }
    })
  })

  test('redirect to a URL, to an extension path and by regex substitution', () => {
    // The URL is kept as the rule wrote it; the engine canonicalises when it redirects.
    expect(engineRule(2).action).toEqual({
      type: 'redirect',
      redirect: { url: 'https://example.com' }
    })
    expect(engineRule(3).action).toEqual({
      type: 'redirect',
      redirect: { url: `${EXTENSION_BASE_URL}a.jpg` }
    })
    const substitution = engineRule(5)
    expect(substitution.action).toEqual({
      type: 'redirect',
      redirect: { regexSubstitution: 'https://\\1.xyz.com/' }
    })
    expect(substitution.condition).toEqual({
      regexFilter: '^https://www\\.(abc|def)\\.xyz\\.com/',
      resourceTypes: ['main_frame']
    })
  })

  test('redirect transforms are carried through for the engine', () => {
    expect(engineRule(4).action.redirect).toEqual({
      transform: { scheme: 'https', host: 'new.example.com' }
    })
    expect(engineRule(12).action.redirect?.transform?.queryTransform).toEqual({
      removeParams: ['utm_source', 'utm_medium'],
      addOrReplaceParams: [{ key: 'ref', value: 'zenium' }]
    })
  })

  test('modifyHeaders operations', () => {
    expect(engineRule(8).action).toEqual({
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'remove' }],
      responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
    })
  })

  test('every condition field the engine knows', () => {
    const out = engineRule(10)
    expect(out.priority).toBe(2)
    expect(out.condition).toEqual({
      urlFilter: '||ads.example.com^',
      excludedInitiatorDomains: ['example.com'],
      excludedResourceTypes: ['main_frame'],
      requestMethods: ['post'],
      domainType: 'thirdParty'
    })
    expect(engineRule(11).condition).toEqual({
      urlFilter: '/Pixel?',
      isUrlFilterCaseSensitive: true,
      requestDomains: ['tracker.example', 'stats.example'],
      excludedRequestDomains: ['good.stats.example'],
      excludedResourceTypes: ['main_frame']
    })
  })

  test('a rule that names no resource types excludes main_frame, as Chrome does', () => {
    const [generic, included, excluded] = compileAll([
      rule(1, { type: 'block' }, { urlFilter: '/ads.' }),
      rule(2, { type: 'block' }, { urlFilter: '/ads.', resourceTypes: ['main_frame', 'script'] }),
      rule(3, { type: 'block' }, { urlFilter: '/ads.', excludedResourceTypes: ['image'] })
    ])
    expect(translateRule(generic!)).toMatchObject({
      condition: { urlFilter: '/ads.', excludedResourceTypes: ['main_frame'] }
    })
    expect(translateRule(included!)).toMatchObject({
      condition: { urlFilter: '/ads.', resourceTypes: ['main_frame', 'script'] }
    })
    expect((translateRule(included!) as EngineRule).condition.excludedResourceTypes).toBeUndefined()
    expect(translateRule(excluded!)).toMatchObject({
      condition: { urlFilter: '/ads.', excludedResourceTypes: ['image'] }
    })
  })

  test('the deprecated domains and excludedDomains become initiator domains', () => {
    const [legacy] = compileAll([
      rule(
        1,
        { type: 'block' },
        { urlFilter: 'x', domains: ['A.com'], excludedDomains: ['b.a.com'] }
      )
    ])
    expect(translateRule(legacy!)).toMatchObject({
      condition: { initiatorDomains: ['a.com'], excludedInitiatorDomains: ['b.a.com'] }
    })
  })

  test('tab ids on session rules', () => {
    const [included, excluded, both] = compileAll(
      [
        rule(1, { type: 'block' }, { urlFilter: 'x', tabIds: [3, 4] }),
        rule(2, { type: 'block' }, { urlFilter: 'x', excludedTabIds: [5] }),
        rule(3, { type: 'block' }, { urlFilter: 'x', tabIds: [3, 4], excludedTabIds: [5] })
      ],
      'session'
    )
    expect(translateRule(included!)).toMatchObject({ condition: { tabIds: [3, 4] } })
    expect(translateRule(excluded!)).toMatchObject({ condition: { excludedTabIds: [5] } })
    // With an explicit tab list the exclusions add nothing, and the compiler drops them.
    expect(translateRule(both!)).toMatchObject({ condition: { tabIds: [3, 4] } })
    expect((translateRule(both!) as EngineRule).condition.excludedTabIds).toBeUndefined()
  })

  test('rules the engine cannot evaluate are reported, not emitted', () => {
    const [headers, top] = compileAll([
      rule(1, { type: 'block' }, { urlFilter: 'x', responseHeaders: [{ header: 'x-ads' }] }),
      rule(2, { type: 'block' }, { urlFilter: 'x', topDomains: ['news.test'] })
    ])
    expect(translateRule(headers!)).toEqual({ ruleId: 1, reason: 'responseHeaderCondition' })
    expect(translateRule(top!)).toEqual({ ruleId: 2, reason: 'topDomains' })
  })
})

describe('compareForEmission', () => {
  test('priority, then action type, then the greater rule id first', () => {
    const rules = compileAll([
      rule(1, { type: 'redirect', redirect: { url: 'https://a.test/' } }, { urlFilter: 'x' }),
      rule(2, { type: 'block' }, { urlFilter: 'x' }),
      rule(3, { type: 'allow' }, { urlFilter: 'x' }),
      rule(4, { type: 'block' }, { urlFilter: 'x' }, 5),
      rule(
        5,
        { type: 'modifyHeaders', requestHeaders: [{ header: 'a', operation: 'remove' }] },
        { urlFilter: 'x' }
      ),
      rule(6, { type: 'block' }, { urlFilter: 'x' })
    ])
    expect([...rules].sort(compareForEmission).map((r) => r.id)).toEqual([4, 3, 6, 2, 1, 5])
  })
})

describe('enginePriorityForRank', () => {
  test('newest extensions sit at the top of the DNR band, older ones share its floor', () => {
    expect(enginePriorityForRank(0)).toBe(ENGINE_DNR_PRIORITY + ENGINE_DNR_BAND_SIZE - 1)
    expect(enginePriorityForRank(1)).toBe(ENGINE_DNR_PRIORITY + ENGINE_DNR_BAND_SIZE - 2)
    expect(enginePriorityForRank(ENGINE_DNR_BAND_SIZE - 1)).toBe(ENGINE_DNR_PRIORITY)
    expect(enginePriorityForRank(ENGINE_DNR_BAND_SIZE + 10)).toBe(ENGINE_DNR_PRIORITY)
    expect(enginePriorityForRank(undefined)).toBe(ENGINE_DNR_PRIORITY)
    expect(enginePriorityForRank(-3)).toBe(enginePriorityForRank(0))
  })
})

describe('translateRuleset', () => {
  const extension: TranslateExtension = {
    extensionId: EXTENSION_ID,
    name: 'Example Blocker',
    version: '1.2.3',
    installRank: 0,
    rulesets: []
  }

  test('a static ruleset becomes one engine set with attribution', () => {
    const rules = compileAll(CHROME_EXAMPLE_RULES)
    const { set, skipped, transforms } = translateRuleset(
      extension,
      { source: 'static', rulesetId: 'ads', path: 'rules/ads.json', manifestIndex: 0, rules },
      { now: () => 1000 }
    )
    expect(set.id).toBe(`ext:${EXTENSION_ID}:static:ads`)
    expect(set.source).toBe('dnr')
    expect(set.enabled).toBe(true)
    expect(set.priority).toBe(enginePriorityForRank(0))
    expect(set.version).toBe('1.2.3')
    expect(set.updatedAt).toBe(1000)
    expect(set.attribution).toEqual({
      name: 'Example Blocker: ruleset ads',
      url: `${EXTENSION_BASE_URL}rules/ads.json`,
      licence: ''
    })
    expect(skipped).toEqual([])
    expect(transforms.sort()).toEqual([12, 4])
    // Priority 2 first; then at priority 1: allow, allowAllRequests, blocks (11, 1),
    // upgradeScheme, redirects (12 .. 2), modifyHeaders; greater id first within a type.
    expect(set.rules?.map((r) => r.id)).toEqual([10, 6, 9, 11, 1, 7, 12, 5, 4, 3, 2, 8])
  })

  test('disabled rules are left out; the timestamp is omitted without a clock', () => {
    const rules = compileAll(CHROME_EXAMPLE_RULES)
    const { set } = translateRuleset(extension, {
      source: 'static',
      rulesetId: 'ads',
      rules,
      disabledRuleIds: new Set([1, 2, 3])
    })
    expect(set.rules?.map((r) => r.id)).not.toContain(1)
    expect(set.rules).toHaveLength(9)
    expect(set.updatedAt).toBeUndefined()
    expect(set.attribution?.url).toBe(EXTENSION_BASE_URL)
  })

  test('dynamic and session sets', () => {
    const rules = compileAll([rule(1, { type: 'block' }, { urlFilter: 'x' })], 'dynamic')
    const dynamic = translateRuleset(
      { extensionId: EXTENSION_ID, rulesets: [] },
      { source: 'dynamic', rules }
    )
    expect(dynamic.set.id).toBe(`ext:${EXTENSION_ID}:_dynamic`)
    expect(dynamic.set.priority).toBe(ENGINE_DNR_PRIORITY)
    expect(dynamic.set.attribution).toEqual({
      name: `${EXTENSION_ID}: dynamic rules`,
      url: EXTENSION_BASE_URL,
      licence: ''
    })
    const session = translateRuleset(
      { extensionId: EXTENSION_ID, rulesets: [] },
      { source: 'session', rules }
    )
    expect(session.set.id).toBe(`ext:${EXTENSION_ID}:_session`)
    expect(session.set.attribution?.name).toBe(`${EXTENSION_ID}: session rules`)
  })

  test('translateExtension drops rulesets that produce no rules', () => {
    const [headers] = compileAll([
      rule(1, { type: 'block' }, { urlFilter: 'x', responseHeaders: [{ header: 'x-ads' }] })
    ])
    const sets = translateExtension({
      extensionId: EXTENSION_ID,
      rulesets: [
        { source: 'static', rulesetId: 'empty', rules: [] },
        { source: 'static', rulesetId: 'headers', rules: [headers!] },
        {
          source: 'dynamic',
          rules: compileAll([rule(1, { type: 'block' }, { urlFilter: 'x' })], 'dynamic')
        }
      ]
    })
    expect(sets.map((t) => t.set.id)).toEqual([`ext:${EXTENSION_ID}:_dynamic`])
  })

  test('translation is deterministic', () => {
    const rules = compileAll(CHROME_EXAMPLE_RULES)
    const input = { source: 'static' as const, rulesetId: 'ads', rules }
    expect(translateRuleset(extension, input)).toEqual(translateRuleset(extension, input))
  })
})

describe('DnrTranslator', () => {
  const staticRules = compileAll([rule(1, { type: 'block' }, { urlFilter: 'a' })])
  const dynamicRules = compileAll([rule(1, { type: 'block' }, { urlFilter: 'b' })], 'dynamic')
  const input = (overrides: Partial<TranslateExtension> = {}): TranslateExtension => ({
    extensionId: EXTENSION_ID,
    rulesets: [
      { source: 'static', rulesetId: 'r1', rules: staticRules },
      { source: 'dynamic', rules: dynamicRules }
    ],
    ...overrides
  })

  test('sync emits the sets once and skips unchanged ones', async () => {
    const sink = new RecordingSink()
    const translator = new DnrTranslator(sink)
    const first = await translator.sync(input())
    expect(first.updated).toEqual([`ext:${EXTENSION_ID}:static:r1`, `ext:${EXTENSION_ID}:_dynamic`])
    expect(first.removed).toEqual([])
    expect(sink.sets.size).toBe(2)
    const second = await translator.sync(input())
    expect(second.updated).toEqual([])
    expect(sink.log).toHaveLength(2)
    expect(translator.extensionIds()).toEqual([EXTENSION_ID])
  })

  test('changed rules, disabled ids, name or version re-emit only the affected set', async () => {
    const sink = new RecordingSink()
    const translator = new DnrTranslator(sink)
    await translator.sync(input())
    const replaced = compileAll([rule(2, { type: 'block' }, { urlFilter: 'c' })], 'dynamic')
    const report = await translator.sync(
      input({
        rulesets: [
          { source: 'static', rulesetId: 'r1', rules: staticRules },
          { source: 'dynamic', rules: replaced }
        ]
      })
    )
    expect(report.updated).toEqual([`ext:${EXTENSION_ID}:_dynamic`])
    expect(sink.sets.get(`ext:${EXTENSION_ID}:_dynamic`)?.rules?.[0]?.id).toBe(2)

    const disabled = await translator.sync(
      input({
        rulesets: [
          { source: 'static', rulesetId: 'r1', rules: staticRules, disabledRuleIds: new Set([1]) },
          { source: 'dynamic', rules: replaced }
        ]
      })
    )
    // The only static rule is now disabled: the set has no rules and is removed.
    expect(disabled.updated).toEqual([])
    expect(disabled.removed).toEqual([`ext:${EXTENSION_ID}:static:r1`])

    const renamed = await translator.sync(
      input({
        name: 'Renamed',
        rulesets: [
          { source: 'static', rulesetId: 'r1', rules: staticRules },
          { source: 'dynamic', rules: replaced }
        ]
      })
    )
    expect(renamed.updated.sort()).toEqual(
      [`ext:${EXTENSION_ID}:static:r1`, `ext:${EXTENSION_ID}:_dynamic`].sort()
    )
    expect(sink.sets.get(`ext:${EXTENSION_ID}:_dynamic`)?.attribution?.name).toBe(
      'Renamed: dynamic rules'
    )
  })

  test('a ruleset that disappears is removed; remove() clears the extension', async () => {
    const sink = new RecordingSink()
    const translator = new DnrTranslator(sink)
    await translator.sync(input())
    const report = await translator.sync(
      input({ rulesets: [{ source: 'static', rulesetId: 'r1', rules: staticRules }] })
    )
    expect(report.removed).toEqual([`ext:${EXTENSION_ID}:_dynamic`])
    expect(sink.sets.size).toBe(1)
    expect(await translator.remove(EXTENSION_ID)).toEqual([`ext:${EXTENSION_ID}:static:r1`])
    expect(sink.sets.size).toBe(0)
    expect(translator.extensionIds()).toEqual([])
  })

  test('the install order re-emits sets whose priority moved and is kept across syncs', async () => {
    const sink = new RecordingSink()
    const translator = new DnrTranslator(sink)
    const other = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    await translator.sync(input())
    await translator.sync({
      extensionId: other,
      rulesets: [{ source: 'dynamic', rules: dynamicRules }]
    })
    expect(sink.sets.get(`ext:${EXTENSION_ID}:_dynamic`)?.priority).toBe(ENGINE_DNR_PRIORITY)

    sink.log.length = 0
    await translator.setInstallOrder([other, EXTENSION_ID])
    expect(sink.sets.get(`ext:${other}:_dynamic`)?.priority).toBe(enginePriorityForRank(0))
    expect(sink.sets.get(`ext:${EXTENSION_ID}:_dynamic`)?.priority).toBe(enginePriorityForRank(1))
    expect(sink.log).toHaveLength(3)

    sink.log.length = 0
    await translator.setInstallOrder([other, EXTENSION_ID])
    expect(sink.log).toEqual([])

    // A later sync without installRank keeps the recorded rank.
    const report = await translator.sync(input())
    expect(report.updated).toEqual([])
  })

  test('skipped rules and transforms are reported per sync', async () => {
    const sink = new RecordingSink()
    const translator = new DnrTranslator(sink)
    const rules = compileAll([
      rule(1, { type: 'block' }, { urlFilter: 'x', topDomains: ['a.test'] }),
      rule(
        2,
        { type: 'redirect', redirect: { transform: { scheme: 'https' } } },
        { urlFilter: 'x' }
      )
    ])
    const report = await translator.sync(
      input({ rulesets: [{ source: 'static', rulesetId: 'r1', rules }] })
    )
    expect(report.skipped).toEqual([{ ruleId: 1, reason: 'topDomains' }])
    expect(report.transforms).toEqual([2])
  })
})

describe('set ids and attribution', () => {
  test('engineSetId and parseEngineSetId round-trip', () => {
    for (const kind of [
      { kind: 'static', rulesetId: 'ads' } as const,
      { kind: 'static', rulesetId: 'with:colon' } as const,
      { kind: 'dynamic' } as const,
      { kind: 'session' } as const
    ]) {
      const id = engineSetId(EXTENSION_ID, kind)
      expect(parseEngineSetId(id)).toEqual({
        extensionId: EXTENSION_ID,
        set: kind,
        rulesetId: kind.kind === 'static' ? kind.rulesetId : `_${kind.kind}`
      })
    }
    expect(parseEngineSetId('easylist')).toBeUndefined()
    expect(parseEngineSetId('ext:')).toBeUndefined()
    expect(parseEngineSetId(`ext:${EXTENSION_ID}:static:`)).toBeUndefined()
    expect(parseEngineSetId(`ext:${EXTENSION_ID}:other`)).toBeUndefined()
  })

  test('routeDecision names the extension rule behind an engine decision', () => {
    expect(
      routeDecision({
        action: 'block',
        matched: { setId: engineSetId(EXTENSION_ID, { kind: 'dynamic' }), ruleId: 7 }
      })
    ).toEqual({ extensionId: EXTENSION_ID, ruleId: 7, rulesetId: '_dynamic' })
    expect(routeDecision({ action: 'allow' })).toBeUndefined()
    expect(
      routeDecision({ action: 'block', matched: { setId: 'easylist', filter: '||ads' } })
    ).toBeUndefined()
    expect(
      routeDecision({ action: 'block', matched: { setId: 'easylist', ruleId: 1 } })
    ).toBeUndefined()
  })

  test('dnrAttribution falls back to the id and the extension root', () => {
    expect(
      dnrAttribution({ extensionId: EXTENSION_ID }, { kind: 'static', rulesetId: 'r' })
    ).toEqual({
      name: `${EXTENSION_ID}: ruleset r`,
      url: EXTENSION_BASE_URL,
      licence: ''
    })
    expect(
      dnrAttribution(
        { extensionId: EXTENSION_ID, name: 'N', path: '/rules/r.json' },
        { kind: 'static', rulesetId: 'r' }
      ).url
    ).toBe(`${EXTENSION_BASE_URL}rules/r.json`)
  })
})
