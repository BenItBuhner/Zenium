import { describe, expect, it } from 'vitest'
import { RuleEngine } from '../../../core/blocking/engine'
import { DNR_BAND_SIZE, RULE_SET_PRIORITY, type RequestContext } from '../../../core/blocking/rules'
import {
  ENGINE_DNR_BAND_SIZE,
  ENGINE_DNR_PRIORITY,
  engineSetId,
  routeDecision
} from '../../../core/extensions/dnr/sink'
import { DnrTranslator, type TranslateExtension } from '../../../core/extensions/dnr/translate'
import { EXTENSION_ID, compileAll, rule } from '../../../core/extensions/dnr/__tests__/fixtures'
import { InMemoryRuleSink, createDnrSink } from '../extensionApi/dnrSink'

const OTHER_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba'

const request = (url: string, extra: Partial<RequestContext> = {}): RequestContext => ({
  url,
  type: 'script',
  method: 'GET',
  initiator: 'https://news.example.com',
  documentUrl: 'https://news.example.com/',
  ...extra
})

function extension(
  extensionId: string,
  rules: ReturnType<typeof compileAll>,
  installRank?: number
): TranslateExtension {
  return {
    extensionId,
    name: `Blocker ${extensionId.slice(0, 4)}`,
    version: '1.0.0',
    installRank,
    rulesets: [
      { source: 'static', rulesetId: 'ruleset_1', path: 'rules/1.json', manifestIndex: 0, rules }
    ]
  }
}

describe('createDnrSink', () => {
  it('hands the translator’s sets to the real engine, which blocks by them', async () => {
    const engine = new RuleEngine()
    const translator = new DnrTranslator(createDnrSink(engine))
    const rules = compileAll([
      rule(1, { type: 'block' }, { urlFilter: '||ads.example.com^', resourceTypes: ['script'] }),
      rule(2, { type: 'allow' }, { urlFilter: '||ads.example.com/keep.js' }, 2)
    ])
    const report = await translator.sync(extension(EXTENSION_ID, rules))
    const setId = engineSetId(EXTENSION_ID, { kind: 'static', rulesetId: 'ruleset_1' })
    expect(report.updated).toEqual([setId])
    expect(engine.has(setId)).toBe(true)

    const blocked = engine.decide(request('https://ads.example.com/track.js'))
    expect(blocked.action).toBe('block')
    expect(blocked.matched).toEqual({ setId, ruleId: 1 })
    // The engine's answer routes back to the extension and its rule.
    expect(routeDecision(blocked)).toEqual({
      extensionId: EXTENSION_ID,
      ruleId: 1,
      rulesetId: 'ruleset_1'
    })
    // Within the set the higher-priority allow rule wins over the block.
    const kept = engine.decide(request('https://ads.example.com/keep.js'))
    expect(kept.action).toBe('allow')
    expect(kept.matched).toEqual({ setId, ruleId: 2 })
    // Other resource types are not covered by rule 1.
    expect(engine.decide(request('https://ads.example.com/a.png', { type: 'image' })).action).toBe(
      'allow'
    )
  })

  it('puts extensions in the declarativeNetRequest band above filter lists, newest first', async () => {
    const engine = new RuleEngine()
    // A filter list that allows the URL an extension blocks: the extension wins, as in Chromium.
    engine.setRuleSet({
      id: 'filter-list:easylist',
      source: 'filter-list',
      priority: RULE_SET_PRIORITY.filterList,
      enabled: true,
      rules: [{ id: 1, action: { type: 'allow' }, condition: { urlFilter: '||cdn.example.com^' } }]
    })
    const translator = new DnrTranslator(createDnrSink(engine))
    const older = compileAll([rule(1, { type: 'block' }, { urlFilter: '||cdn.example.com^' })])
    const newer = compileAll([rule(1, { type: 'allow' }, { urlFilter: '||cdn.example.com^' })])
    await translator.sync(extension(EXTENSION_ID, older, 1))
    await translator.sync(extension(OTHER_ID, newer, 0))

    const summaries = engine.listRuleSets()
    const olderSet = summaries.find((s) => s.id.startsWith(`ext:${EXTENSION_ID}:`))
    const newerSet = summaries.find((s) => s.id.startsWith(`ext:${OTHER_ID}:`))
    expect(olderSet?.source).toBe('dnr')
    expect(olderSet && olderSet.priority >= RULE_SET_PRIORITY.dnr).toBe(true)
    expect(newerSet && olderSet && newerSet.priority > olderSet.priority).toBe(true)
    expect(newerSet && newerSet.priority < RULE_SET_PRIORITY.dnr + DNR_BAND_SIZE).toBe(true)
    expect(olderSet?.attribution?.name).toContain('Blocker')

    // The most recently installed extension decides: its allow beats the older block, and both
    // beat the filter list.
    const decision = engine.decide(request('https://cdn.example.com/lib.js'))
    expect(decision.matched?.setId.startsWith(`ext:${OTHER_ID}:`)).toBe(true)
    expect(decision.action).toBe('allow')

    // Re-ranking (an uninstall, a newer install) re-emits the sets and flips the outcome.
    await translator.setInstallOrder([EXTENSION_ID, OTHER_ID])
    const flipped = engine.decide(request('https://cdn.example.com/lib.js'))
    expect(flipped.action).toBe('block')
    expect(flipped.matched?.setId.startsWith(`ext:${EXTENSION_ID}:`)).toBe(true)
  })

  it('removes an extension’s sets from the engine when it goes', async () => {
    const engine = new RuleEngine()
    const translator = new DnrTranslator(createDnrSink(engine))
    const rules = compileAll([rule(1, { type: 'block' }, { urlFilter: '||ads.example.com^' })])
    await translator.sync(extension(EXTENSION_ID, rules))
    expect(engine.decide(request('https://ads.example.com/a.js')).action).toBe('block')
    const removed = await translator.remove(EXTENSION_ID)
    expect(removed).toEqual([engineSetId(EXTENSION_ID, { kind: 'static', rulesetId: 'ruleset_1' })])
    expect(engine.listRuleSets().filter((s) => s.source === 'dnr')).toEqual([])
    expect(engine.decide(request('https://ads.example.com/a.js')).action).toBe('allow')
  })

  it('shares the band constants with the engine', () => {
    expect(ENGINE_DNR_PRIORITY).toBe(RULE_SET_PRIORITY.dnr)
    expect(ENGINE_DNR_BAND_SIZE).toBe(DNR_BAND_SIZE)
  })
})

describe('InMemoryRuleSink', () => {
  it('holds sets without filtering and counts their rules', async () => {
    const log: string[] = []
    const sink = new InMemoryRuleSink((line) => log.push(line))
    const translator = new DnrTranslator(sink)
    const rules = compileAll([
      rule(1, { type: 'block' }, { urlFilter: 'a' }),
      rule(2, { type: 'block' }, { urlFilter: 'b' })
    ])
    await translator.sync(extension(EXTENSION_ID, rules))
    expect(sink.ruleCount()).toBe(2)
    expect(log[0]).toMatch(/dnr sink: set ext:.*2 rules/)
    await translator.remove(EXTENSION_ID)
    expect(sink.ruleCount()).toBe(0)
    expect(log[1]).toMatch(/removed ext:/)
  })
})
