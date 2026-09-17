import { describe, expect, test } from 'vitest'
import type { ManifestRuleResource } from '../../manifest'
import {
  GUARANTEED_MINIMUM_STATIC_RULES,
  MAX_DISABLED_STATIC_RULES,
  MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL,
  MAX_NUMBER_OF_DYNAMIC_RULES,
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
  MAX_NUMBER_OF_REGEX_RULES,
  MAX_NUMBER_OF_SESSION_RULES,
  MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
  MATCHED_RULE_LIFESPAN_MS,
  GETMATCHEDRULES_QUOTA_INTERVAL
} from '../limits'
import {
  DnrState,
  ERROR_DISABLED_STATIC_RULE_COUNT_EXCEEDED,
  ERROR_DYNAMIC_REGEX_RULE_COUNT_EXCEEDED,
  ERROR_DYNAMIC_RULE_COUNT_EXCEEDED,
  ERROR_DYNAMIC_UNSAFE_RULE_COUNT_EXCEEDED,
  ERROR_ENABLED_RULESETS_REGEX_RULE_COUNT_EXCEEDED,
  ERROR_ENABLED_RULESETS_RULE_COUNT_EXCEEDED,
  ERROR_ENABLED_RULESET_COUNT_EXCEEDED,
  ERROR_GET_MATCHED_RULES_MISSING_PERMISSIONS,
  ERROR_INCREMENT_WITHOUT_BADGE_TEXT,
  ERROR_INTERNAL_UPDATING_ENABLED_RULESETS,
  ERROR_OVER_QUOTA,
  ERROR_SESSION_REGEX_RULE_COUNT_EXCEEDED,
  ERROR_SESSION_RULE_COUNT_EXCEEDED,
  UNKNOWN_TAB_ID,
  WARNING_ENABLED_REGEX_RULE_COUNT_EXCEEDED,
  WARNING_ENABLED_RULE_COUNT_EXCEEDED,
  WARNING_RULESET_FAILED_TO_LOAD,
  createGlobalStaticRulePool,
  formatMessage,
  type DnrExtensionInfo,
  type DnrPersistedState,
  type DnrStateIO,
  type GlobalStaticRulePool,
  type MatchedRuleInfoDebug,
  type RequestDetails
} from '../state'
import type { Rule } from '../rules'
import { EXTENSION_ID, blockRule, rule } from './fixtures'

// ---------------------------------------------------------------------------------------------
// Harness

class FakeIO implements DnrStateIO {
  readonly files = new Map<string, string>()
  persisted: DnrPersistedState | undefined
  saves = 0
  reads: string[] = []
  clock = 1_000_000
  validTabs: Set<number> | undefined
  activeTabs = new Set<number>()
  actionCounts: [number, number][] = []
  warnings: string[] = []
  failSave = false
  globalStaticRulePool?: GlobalStaticRulePool

  constructor(pool?: GlobalStaticRulePool) {
    if (pool) this.globalStaticRulePool = pool
  }

  ruleset(path: string, rules: unknown): this {
    this.files.set(path, typeof rules === 'string' ? rules : JSON.stringify(rules))
    return this
  }

  async readFile(path: string): Promise<string> {
    this.reads.push(path)
    const content = this.files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }
  async loadState(): Promise<DnrPersistedState | undefined> {
    return this.persisted
      ? (JSON.parse(JSON.stringify(this.persisted)) as DnrPersistedState)
      : undefined
  }
  async saveState(state: DnrPersistedState): Promise<void> {
    if (this.failSave) throw new Error('disk full')
    this.saves++
    this.persisted = JSON.parse(JSON.stringify(state)) as DnrPersistedState
  }
  now = (): number => this.clock
  isValidTabId = (tabId: number): boolean => this.validTabs?.has(tabId) ?? true
  hasActiveTabAccess = (tabId: number): boolean => this.activeTabs.has(tabId)
  onActionCount = (tabId: number, count: number): void => {
    this.actionCounts.push([tabId, count])
  }
  warn = (message: string): void => {
    this.warnings.push(message)
  }
}

function resource(id: string, enabled = true): ManifestRuleResource {
  return { id, enabled, path: `rules/${id}.json` }
}

function blocks(count: number, prefix = 'x', firstId = 1): Rule[] {
  return Array.from({ length: count }, (_, i) => blockRule(firstId + i, `${prefix}${i}`))
}

function regexRules(count: number, firstId = 1): Rule[] {
  return Array.from({ length: count }, (_, i) =>
    rule(firstId + i, { type: 'block' }, { regexFilter: `^https://r${i}\\.test/` })
  )
}

function redirectRules(count: number, firstId = 1): Rule[] {
  return Array.from({ length: count }, (_, i) =>
    rule(
      firstId + i,
      { type: 'redirect', redirect: { url: 'https://r.test/' } },
      { urlFilter: `u${i}` }
    )
  )
}

function make(io: FakeIO, extension: Partial<DnrExtensionInfo> = {}): DnrState {
  return new DnrState({ id: EXTENSION_ID, ...extension }, io)
}

const FEEDBACK = ['declarativeNetRequestFeedback']

const request = (tabId: number): RequestDetails => ({
  requestId: '1',
  url: 'https://x.test/',
  method: 'GET',
  frameId: 0,
  parentFrameId: -1,
  tabId,
  type: 'image'
})

// ---------------------------------------------------------------------------------------------

describe('loading', () => {
  test('first load seeds the enabled set from the manifest and persists it', async () => {
    const io = new FakeIO().ruleset('rules/a.json', blocks(2)).ruleset('rules/b.json', blocks(3))
    const state = make(io, { ruleResources: [resource('a'), resource('b', false)] })
    await state.load()
    expect(await state.getEnabledRulesets()).toEqual(['a'])
    expect(io.persisted).toEqual({
      version: 1,
      enabledStaticRulesetIds: ['a'],
      disabledStaticRuleIds: {},
      dynamicRules: [],
      displayActionCountAsBadgeText: false
    })
    // Disabled rulesets are not read until they are enabled; load() runs once.
    expect(io.reads).toEqual(['rules/a.json'])
    await state.load()
    expect(io.reads).toEqual(['rules/a.json'])
    expect(state.ruleCounts().static.rules).toBe(2)
    expect(state.warnings).toEqual([])
  })

  test('a persisted record wins over the manifest defaults', async () => {
    const io = new FakeIO().ruleset('rules/a.json', blocks(2)).ruleset('rules/b.json', blocks(3))
    io.persisted = {
      version: 1,
      enabledStaticRulesetIds: ['b', 'gone'],
      disabledStaticRuleIds: { b: [2], gone: [1] },
      dynamicRules: [
        blockRule(1, 'dyn'),
        { id: 2, action: { type: 'block' }, condition: { regexFilter: '(' } }
      ],
      displayActionCountAsBadgeText: true
    }
    const state = make(io, { ruleResources: [resource('a'), resource('b', false)] })
    await state.load()
    expect(await state.getEnabledRulesets()).toEqual(['b'])
    expect(await state.getDisabledRuleIds({ rulesetId: 'b' })).toEqual([2])
    expect(state.displaysActionCountAsBadgeText()).toBe(true)
    // The invalid persisted dynamic rule is dropped silently.
    expect((await state.getDynamicRules()).map((r) => r.id)).toEqual([1])
    expect(io.saves).toBe(0)
    const matcher = state.matcherRulesets()
    expect(matcher.map((r) => r.id)).toEqual(['b', '_dynamic', '_session'])
    expect(matcher[0]?.disabledRuleIds).toEqual(new Set([2]))
  })

  test('a ruleset that fails to read or parse is skipped with a warning', async () => {
    const io = new FakeIO()
      .ruleset('rules/a.json', blocks(1))
      .ruleset('rules/bad.json', '{ not json')
      .ruleset('rules/c.json', blocks(1))
    const state = make(io, {
      ruleResources: [resource('a'), resource('bad'), resource('missing'), resource('c')]
    })
    await state.load()
    expect(await state.getEnabledRulesets()).toEqual(['a', 'c'])
    expect(state.warnings).toEqual([WARNING_RULESET_FAILED_TO_LOAD])
    expect(io.warnings).toEqual([WARNING_RULESET_FAILED_TO_LOAD])
    await expect(state.updateEnabledRulesets({ enableRulesetIds: ['bad'] })).rejects.toThrow(
      ERROR_INTERNAL_UPDATING_ENABLED_RULESETS
    )
  })

  test('static rulesets over the rule budget are skipped in manifest order', async () => {
    const half = GUARANTEED_MINIMUM_STATIC_RULES / 2 + 1
    const io = new FakeIO(createGlobalStaticRulePool(0))
      .ruleset('rules/a.json', blocks(half))
      .ruleset('rules/b.json', blocks(half))
      .ruleset('rules/c.json', blocks(1))
    const state = make(io, { ruleResources: [resource('a'), resource('b'), resource('c')] })
    await state.load()
    expect(await state.getEnabledRulesets()).toEqual(['a', 'c'])
    expect(state.warnings).toEqual([WARNING_ENABLED_RULE_COUNT_EXCEEDED])
    expect(await state.getAvailableStaticRuleCount()).toBe(
      GUARANTEED_MINIMUM_STATIC_RULES - half - 1
    )
    await expect(state.updateEnabledRulesets({ enableRulesetIds: ['b'] })).rejects.toThrow(
      ERROR_ENABLED_RULESETS_RULE_COUNT_EXCEEDED
    )
    await state.updateEnabledRulesets({ disableRulesetIds: ['a'], enableRulesetIds: ['b'] })
    expect(await state.getEnabledRulesets()).toEqual(['b', 'c'])
  })

  test('the pool lets an extension exceed its guaranteed minimum while others do not need it', async () => {
    const pool = createGlobalStaticRulePool(3, 10)
    expect(pool.update('a', 12)).toBe(true)
    expect(pool.available('a')).toBe(3)
    expect(pool.available('b')).toBe(1)
    expect(pool.update('b', 12)).toBe(false)
    expect(pool.update('b', 11)).toBe(true)
    expect(pool.available('a')).toBe(2)
    pool.release('a')
    expect(pool.available('b')).toBe(3)
    expect(pool.update('b', 5)).toBe(true)
    expect(pool.available('a')).toBe(3)

    const shared = createGlobalStaticRulePool(GUARANTEED_MINIMUM_STATIC_RULES)
    const io = new FakeIO(shared).ruleset(
      'rules/a.json',
      blocks(GUARANTEED_MINIMUM_STATIC_RULES + 5)
    )
    const state = make(io, { ruleResources: [resource('a')] })
    await state.load()
    expect(await state.getEnabledRulesets()).toEqual(['a'])
    expect(await state.getAvailableStaticRuleCount()).toBe(GUARANTEED_MINIMUM_STATIC_RULES - 5)
    expect(shared.available('other')).toBe(GUARANTEED_MINIMUM_STATIC_RULES - 5)
    state.dispose()
    expect(shared.available('other')).toBe(GUARANTEED_MINIMUM_STATIC_RULES)
  })

  test('static rulesets over the regex rule limit are skipped', async () => {
    const io = new FakeIO()
      .ruleset('rules/a.json', regexRules(MAX_NUMBER_OF_REGEX_RULES))
      .ruleset('rules/b.json', regexRules(1))
    const state = make(io, { ruleResources: [resource('a'), resource('b')] })
    await state.load()
    expect(await state.getEnabledRulesets()).toEqual(['a'])
    expect(state.warnings).toEqual([WARNING_ENABLED_REGEX_RULE_COUNT_EXCEEDED])
    expect(state.ruleCounts().static.regexRules).toBe(MAX_NUMBER_OF_REGEX_RULES)
    await expect(state.updateEnabledRulesets({ enableRulesetIds: ['b'] })).rejects.toThrow(
      ERROR_ENABLED_RULESETS_REGEX_RULE_COUNT_EXCEEDED
    )
  })

  test('rules Chrome would skip inside a static ruleset do not stop the ruleset', async () => {
    const io = new FakeIO().ruleset('rules/a.json', [
      blockRule(1, 'ok'),
      { id: 2, action: { type: 'block' }, condition: { urlFilter: '' } },
      { id: 3, action: { type: 'block' }, condition: { regexFilter: 'a{120}' } },
      blockRule(4, 'also-ok')
    ])
    const state = make(io, { ruleResources: [resource('a')] })
    await state.load()
    expect(state.ruleCounts().static.rules).toBe(2)
    expect(state.matcherRulesets()[0]?.rules.map((r) => r.id)).toEqual([1, 4])
  })
})

describe('updateEnabledRulesets', () => {
  test('unknown ids are rejected before anything changes', async () => {
    const io = new FakeIO().ruleset('rules/a.json', blocks(1)).ruleset('rules/b.json', blocks(1))
    const state = make(io, { ruleResources: [resource('a'), resource('b', false)] })
    await state.load()
    await expect(state.updateEnabledRulesets({ enableRulesetIds: ['b', 'nope'] })).rejects.toThrow(
      'Invalid ruleset id: nope.'
    )
    await expect(state.updateEnabledRulesets({ disableRulesetIds: ['_dynamic'] })).rejects.toThrow(
      'Invalid ruleset id: _dynamic.'
    )
    expect(await state.getEnabledRulesets()).toEqual(['a'])
  })

  test('enable beats disable, the result is persisted and listeners hear about it', async () => {
    const io = new FakeIO().ruleset('rules/a.json', blocks(1)).ruleset('rules/b.json', blocks(1))
    const state = make(io, { ruleResources: [resource('a'), resource('b', false)] })
    await state.load()
    const changes: string[] = []
    state.onChange((kind) => changes.push(kind))
    await state.updateEnabledRulesets({ disableRulesetIds: ['a', 'b'], enableRulesetIds: ['b'] })
    expect(await state.getEnabledRulesets()).toEqual(['b'])
    expect(io.persisted?.enabledStaticRulesetIds).toEqual(['b'])
    expect(changes).toEqual(['static'])
    // Nothing to do: no persist, no notification.
    const saves = io.saves
    await state.updateEnabledRulesets({})
    await state.updateEnabledRulesets({ enableRulesetIds: ['a'], disableRulesetIds: ['a'] })
    expect(io.saves).toBe(saves + 1)
    expect(await state.getEnabledRulesets()).toEqual(['a', 'b'])
  })

  test('at most 50 static rulesets can be enabled', async () => {
    const io = new FakeIO()
    const resources: ManifestRuleResource[] = []
    for (let i = 0; i <= MAX_NUMBER_OF_ENABLED_STATIC_RULESETS; i++) {
      const id = `r${i}`
      resources.push(resource(id, i < MAX_NUMBER_OF_ENABLED_STATIC_RULESETS))
      io.ruleset(`rules/${id}.json`, blocks(1))
    }
    const state = make(io, { ruleResources: resources })
    await state.load()
    expect((await state.getEnabledRulesets()).length).toBe(MAX_NUMBER_OF_ENABLED_STATIC_RULESETS)
    await expect(
      state.updateEnabledRulesets({
        enableRulesetIds: [`r${MAX_NUMBER_OF_ENABLED_STATIC_RULESETS}`]
      })
    ).rejects.toThrow(ERROR_ENABLED_RULESET_COUNT_EXCEEDED)
    await state.updateEnabledRulesets({
      disableRulesetIds: ['r0'],
      enableRulesetIds: [`r${MAX_NUMBER_OF_ENABLED_STATIC_RULESETS}`]
    })
    expect((await state.getEnabledRulesets()).length).toBe(MAX_NUMBER_OF_ENABLED_STATIC_RULESETS)
  })
})

describe('updateStaticRules', () => {
  test('disabling and enabling individual rules of a ruleset', async () => {
    const io = new FakeIO().ruleset('rules/a.json', blocks(5)).ruleset('rules/b.json', blocks(5))
    const state = make(io, { ruleResources: [resource('a'), resource('b', false)] })
    await state.load()
    const changes: string[] = []
    state.onChange((kind) => changes.push(kind))
    await expect(
      state.updateStaticRules({ rulesetId: 'zzz', disableRuleIds: [1] })
    ).rejects.toThrow('Invalid ruleset id: zzz.')
    await state.updateStaticRules({ rulesetId: 'a', disableRuleIds: [3, 1, 99] })
    expect(await state.getDisabledRuleIds({ rulesetId: 'a' })).toEqual([1, 3, 99])
    expect(state.matcherRulesets()[0]?.disabledRuleIds).toEqual(new Set([1, 3, 99]))
    expect(state.translateInput().rulesets[0]?.disabledRuleIds).toEqual(new Set([1, 3, 99]))
    expect(io.persisted?.disabledStaticRuleIds).toEqual({ a: [1, 3, 99] })
    // An id in both lists ends up enabled.
    await state.updateStaticRules({ rulesetId: 'a', disableRuleIds: [1, 2], enableRuleIds: [1, 3] })
    expect(await state.getDisabledRuleIds({ rulesetId: 'a' })).toEqual([2, 99])
    expect(changes).toEqual(['static', 'static'])
    // Disabled rules in a ruleset that is not enabled are stored but nobody is notified.
    await state.updateStaticRules({ rulesetId: 'b', disableRuleIds: [4] })
    expect(await state.getDisabledRuleIds({ rulesetId: 'b' })).toEqual([4])
    expect(changes).toEqual(['static', 'static'])
    // No change, no work.
    const saves = io.saves
    await state.updateStaticRules({ rulesetId: 'a', disableRuleIds: [2], enableRuleIds: [7] })
    expect(io.saves).toBe(saves)
  })

  test('the disabled rule count is capped across rulesets', async () => {
    const io = new FakeIO().ruleset('rules/a.json', blocks(1)).ruleset('rules/b.json', blocks(1))
    const state = make(io, { ruleResources: [resource('a'), resource('b')] })
    await state.load()
    const ids = Array.from({ length: MAX_DISABLED_STATIC_RULES }, (_, i) => i + 1)
    await state.updateStaticRules({ rulesetId: 'a', disableRuleIds: ids })
    await expect(state.updateStaticRules({ rulesetId: 'b', disableRuleIds: [1] })).rejects.toThrow(
      ERROR_DISABLED_STATIC_RULE_COUNT_EXCEEDED
    )
    await state.updateStaticRules({ rulesetId: 'a', enableRuleIds: [1] })
    await state.updateStaticRules({ rulesetId: 'b', disableRuleIds: [1] })
    expect(await state.getDisabledRuleIds({ rulesetId: 'b' })).toEqual([1])
  })
})

describe('dynamic and session rules', () => {
  test('add, read, replace and remove dynamic rules; the record is persisted', async () => {
    const io = new FakeIO()
    const state = make(io)
    const changes: string[] = []
    state.onChange((kind) => changes.push(kind))
    await state.load()
    // The initial load announces the (empty) static set once.
    expect(changes).toEqual(['static'])
    changes.length = 0
    await state.updateDynamicRules({ addRules: [blockRule(1, 'a'), blockRule(2, 'b')] })
    const rules = await state.getDynamicRules()
    expect(rules.map((r) => r.id)).toEqual([1, 2])
    rules[0]!.condition.urlFilter = 'mutated'
    expect((await state.getDynamicRules({ ruleIds: [1] }))[0]?.condition.urlFilter).toBe('a')
    await state.updateDynamicRules({ removeRuleIds: [1, 42], addRules: [blockRule(1, 'c')] })
    expect((await state.getDynamicRules()).map((r) => r.condition.urlFilter)).toEqual(['b', 'c'])
    expect(io.persisted?.dynamicRules.map((r) => r.id)).toEqual([2, 1])
    expect(changes).toEqual(['dynamic', 'dynamic'])
    expect(state.ruleCounts().dynamic).toEqual({ rules: 2, unsafeRules: 0, regexRules: 0 })

    const reloaded = make(io)
    expect((await reloaded.getDynamicRules()).map((r) => r.id)).toEqual([2, 1])
    expect(reloaded.translateInput().rulesets).toEqual([
      { source: 'dynamic', rules: reloaded.matcherRulesets()[0]?.rules }
    ])
  })

  test('additions are validated like Chrome does and nothing is applied on error', async () => {
    const io = new FakeIO()
    const state = make(io)
    await state.updateDynamicRules({ addRules: [blockRule(1, 'a')] })
    await expect(state.updateDynamicRules({ addRules: [blockRule(1, 'dup')] })).rejects.toThrow(
      'Rule with id 1 does not have a unique ID.'
    )
    await expect(
      state.updateDynamicRules({ addRules: [blockRule(2, 'x'), blockRule(2, 'y')] })
    ).rejects.toThrow('Rule with id 2 does not have a unique ID.')
    await expect(state.updateDynamicRules({ addRules: [{ id: 'x' }] })).rejects.toThrow(
      /^Error at index 0: /
    )
    await expect(
      state.updateDynamicRules({
        addRules: [blockRule(3, 'ok'), { id: 4, action: { type: 'block' } }]
      })
    ).rejects.toThrow(/^Error at index 1: /)
    await expect(
      state.updateDynamicRules({
        addRules: [{ id: 5, action: { type: 'block' }, condition: { regexFilter: '(' } }]
      })
    ).rejects.toThrow(/Rule with id 5 .*regexFilter/)
    await expect(
      state.updateDynamicRules({
        addRules: [{ id: 6, action: { type: 'block' }, condition: { urlFilter: 'x', tabIds: [1] } }]
      })
    ).rejects.toThrow(/only supported for session-scoped rules/)
    expect((await state.getDynamicRules()).map((r) => r.id)).toEqual([1])
    // Removing an id and adding it again in one call is a replacement, not a duplicate.
    await state.updateDynamicRules({ removeRuleIds: [1], addRules: [blockRule(1, 'new')] })
    expect((await state.getDynamicRules())[0]?.condition.urlFilter).toBe('new')
  })

  test('dynamic rule limits: total, unsafe and regex (shared with session rules)', async () => {
    const state = make(new FakeIO())
    await expect(
      state.updateDynamicRules({ addRules: blocks(MAX_NUMBER_OF_DYNAMIC_RULES + 1) })
    ).rejects.toThrow(ERROR_DYNAMIC_RULE_COUNT_EXCEEDED)
    await expect(
      state.updateDynamicRules({ addRules: redirectRules(MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES + 1) })
    ).rejects.toThrow(ERROR_DYNAMIC_UNSAFE_RULE_COUNT_EXCEEDED)
    await expect(
      state.updateDynamicRules({ addRules: regexRules(MAX_NUMBER_OF_REGEX_RULES + 1) })
    ).rejects.toThrow(ERROR_DYNAMIC_REGEX_RULE_COUNT_EXCEEDED)
    expect(await state.getDynamicRules()).toEqual([])

    await state.updateSessionRules({ addRules: regexRules(MAX_NUMBER_OF_REGEX_RULES - 1) })
    await state.updateDynamicRules({ addRules: regexRules(1) })
    await expect(state.updateDynamicRules({ addRules: regexRules(1, 2) })).rejects.toThrow(
      ERROR_DYNAMIC_REGEX_RULE_COUNT_EXCEEDED
    )
    await expect(state.updateSessionRules({ addRules: regexRules(1, 5000) })).rejects.toThrow(
      ERROR_SESSION_REGEX_RULE_COUNT_EXCEEDED
    )
    // Removing regex rules in the same call frees their share.
    await state.updateDynamicRules({ removeRuleIds: [1], addRules: regexRules(1, 2) })
    expect((await state.getDynamicRules()).map((r) => r.id)).toEqual([2])
  })

  test('session rules are not persisted and have their own limit', async () => {
    const io = new FakeIO()
    const state = make(io)
    await state.load()
    const saves = io.saves
    await state.updateSessionRules({ addRules: [blockRule(1, 'a')] })
    expect((await state.getSessionRules()).map((r) => r.id)).toEqual([1])
    expect(io.saves).toBe(saves)
    await expect(
      state.updateSessionRules({ addRules: blocks(MAX_NUMBER_OF_SESSION_RULES, 's', 2) })
    ).rejects.toThrow(ERROR_SESSION_RULE_COUNT_EXCEEDED)
    await expect(state.updateSessionRules({ addRules: [blockRule(1, 'dup')] })).rejects.toThrow(
      'Rule with id 1 does not have a unique ID.'
    )
    await state.updateSessionRules({
      addRules: [rule(2, { type: 'block' }, { urlFilter: 'x', tabIds: [4] })]
    })
    expect(state.ruleCounts().session.rules).toBe(2)
    expect(state.translateInput().rulesets.map((r) => r.source)).toEqual(['session'])
  })

  test('a failed save rolls the dynamic rules back', async () => {
    const io = new FakeIO()
    const state = make(io)
    await state.updateDynamicRules({ addRules: [blockRule(1, 'a')] })
    io.failSave = true
    await expect(state.updateDynamicRules({ addRules: [blockRule(2, 'b')] })).rejects.toThrow(
      'disk full'
    )
    expect((await state.getDynamicRules()).map((r) => r.id)).toEqual([1])
  })
})

describe('translateInput and matcherRulesets', () => {
  test('static rulesets in manifest order, then dynamic and session', async () => {
    const io = new FakeIO().ruleset('rules/a.json', blocks(1)).ruleset('rules/b.json', blocks(1))
    const state = make(io, {
      name: 'Blocker',
      version: '2.0',
      ruleResources: [resource('b'), resource('a')]
    })
    await state.updateDynamicRules({ addRules: [blockRule(1, 'd')] })
    await state.updateSessionRules({ addRules: [blockRule(1, 's')] })
    const input = state.translateInput(3)
    expect(input).toMatchObject({
      extensionId: EXTENSION_ID,
      name: 'Blocker',
      version: '2.0',
      installRank: 3
    })
    expect(input.rulesets.map((r) => [r.source, r.rulesetId, r.path, r.manifestIndex])).toEqual([
      ['static', 'b', 'rules/b.json', 0],
      ['static', 'a', 'rules/a.json', 1],
      ['dynamic', undefined, undefined, undefined],
      ['session', undefined, undefined, undefined]
    ])
    expect(state.matcherRulesets().map((r) => [r.id, r.source, r.manifestIndex])).toEqual([
      ['b', 'static', 0],
      ['a', 'static', 1],
      ['_dynamic', 'dynamic', undefined],
      ['_session', 'session', undefined]
    ])
  })
})

describe('action count', () => {
  test('setExtensionActionOptions validates and drives the badge hook', async () => {
    const io = new FakeIO()
    io.validTabs = new Set([1, 2])
    const state = make(io)
    await expect(
      state.setExtensionActionOptions({ tabUpdate: { tabId: 1, increment: 1 } })
    ).rejects.toThrow(ERROR_INCREMENT_WITHOUT_BADGE_TEXT)
    await state.setExtensionActionOptions({ displayActionCountAsBadgeText: true })
    expect(io.persisted?.displayActionCountAsBadgeText).toBe(true)
    await expect(
      state.setExtensionActionOptions({ tabUpdate: { tabId: 7, increment: 1 } })
    ).rejects.toThrow(formatMessage('No tab with id: *.', 7))
    await state.setExtensionActionOptions({ tabUpdate: { tabId: 1, increment: 3 } })
    await state.setExtensionActionOptions({ tabUpdate: { tabId: 1, increment: -5 } })
    expect(state.actionCount(1)).toBe(0)
    await state.setExtensionActionOptions({ tabUpdate: { tabId: 2, increment: 2 } })
    expect(io.actionCounts).toEqual([
      [1, 3],
      [1, 0],
      [2, 2]
    ])
    // Turning the badge off reports zeros; turning it on again reports the kept counts.
    io.actionCounts.length = 0
    await state.setExtensionActionOptions({ displayActionCountAsBadgeText: false })
    expect(io.actionCounts).toEqual([
      [1, 0],
      [2, 0]
    ])
    io.actionCounts.length = 0
    await state.setExtensionActionOptions({ displayActionCountAsBadgeText: true })
    expect(io.actionCounts).toEqual([
      [1, 0],
      [2, 2]
    ])
  })

  test('matches count per tab, except allow rules and tab-less requests', async () => {
    const io = new FakeIO()
    const state = make(io)
    await state.setExtensionActionOptions({ displayActionCountAsBadgeText: true })
    state.recordMatch({ ruleId: 1, rulesetId: 'a', tabId: 1 })
    state.recordMatch({ ruleId: 2, rulesetId: 'a', tabId: 1, actionType: 'block' })
    state.recordMatch({ ruleId: 3, rulesetId: 'a', tabId: 1, actionType: 'allow' })
    state.recordMatch({ ruleId: 4, rulesetId: 'a', tabId: 1, actionType: 'allowAllRequests' })
    state.recordMatch({ ruleId: 5, rulesetId: 'a', tabId: UNKNOWN_TAB_ID, actionType: 'block' })
    expect(state.actionCount(1)).toBe(2)
    expect(state.actionCount(UNKNOWN_TAB_ID)).toBe(0)
    state.onTabNavigated(1)
    expect(state.actionCount(1)).toBe(0)
    state.recordMatch({ ruleId: 1, rulesetId: 'a', tabId: 1 })
    state.onTabRemoved(1)
    expect(state.actionCount(1)).toBe(0)
    expect(io.actionCounts).toEqual([
      [1, 1],
      [1, 2],
      [1, 0],
      [1, 1]
    ])
  })
})

describe('getMatchedRules', () => {
  test('needs the feedback permission or activeTab for the tab', async () => {
    const io = new FakeIO()
    io.activeTabs.add(5)
    const plain = make(io)
    await expect(plain.getMatchedRules()).rejects.toThrow(
      ERROR_GET_MATCHED_RULES_MISSING_PERMISSIONS
    )
    const activeTab = make(io, { permissions: ['activeTab'] })
    await expect(activeTab.getMatchedRules()).rejects.toThrow(
      ERROR_GET_MATCHED_RULES_MISSING_PERMISSIONS
    )
    await expect(activeTab.getMatchedRules({ tabId: 6 })).rejects.toThrow(
      ERROR_GET_MATCHED_RULES_MISSING_PERMISSIONS
    )
    await expect(activeTab.getMatchedRules({ tabId: UNKNOWN_TAB_ID })).rejects.toThrow(
      ERROR_GET_MATCHED_RULES_MISSING_PERMISSIONS
    )
    activeTab.recordMatch({ ruleId: 1, rulesetId: 'a', tabId: 5 })
    activeTab.recordMatch({ ruleId: 2, rulesetId: 'a', tabId: 6 })
    expect((await activeTab.getMatchedRules({ tabId: 5 })).rulesMatchedInfo).toEqual([
      { rule: { ruleId: 1, rulesetId: 'a' }, tabId: 5, timeStamp: io.clock }
    ])
    // Without any permission matches are not even kept.
    plain.recordMatch({ ruleId: 1, rulesetId: 'a', tabId: 5 })
    const feedbackLater = make(io, { permissions: FEEDBACK })
    expect((await feedbackLater.getMatchedRules()).rulesMatchedInfo).toEqual([])
  })

  test('filters by tab and time; unknown tabs are rejected', async () => {
    const io = new FakeIO()
    io.validTabs = new Set([1, 2])
    const state = make(io, { permissions: FEEDBACK })
    state.recordMatch({ ruleId: 1, rulesetId: '_dynamic', tabId: 1 })
    io.clock += 1000
    state.recordMatch({ ruleId: 2, rulesetId: 'a', tabId: 2 })
    state.recordMatch({ ruleId: 3, rulesetId: 'a', tabId: 99 })
    const all = (await state.getMatchedRules()).rulesMatchedInfo
    expect(all.map((m) => [m.rule.ruleId, m.tabId])).toEqual([
      [1, 1],
      [2, 2],
      [3, UNKNOWN_TAB_ID]
    ])
    expect(
      (await state.getMatchedRules({ tabId: 2 })).rulesMatchedInfo.map((m) => m.rule.ruleId)
    ).toEqual([2])
    expect(
      (await state.getMatchedRules({ minTimeStamp: io.clock })).rulesMatchedInfo.map(
        (m) => m.rule.ruleId
      )
    ).toEqual([2, 3])
    expect(
      (await state.getMatchedRules({ tabId: UNKNOWN_TAB_ID })).rulesMatchedInfo.map(
        (m) => m.rule.ruleId
      )
    ).toEqual([3])
    await expect(state.getMatchedRules({ tabId: 9 })).rejects.toThrow('No tab with id: 9.')
  })

  test('matches follow a closed or navigated tab into the unknown tab for five minutes', async () => {
    const io = new FakeIO()
    const state = make(io, { permissions: FEEDBACK })
    state.recordMatch({ ruleId: 1, rulesetId: 'a', tabId: 1 })
    state.recordMatch({ ruleId: 2, rulesetId: 'a', tabId: 2 })
    state.onTabNavigated(1)
    state.onTabRemoved(2)
    io.clock += MATCHED_RULE_LIFESPAN_MS - 1
    state.recordMatch({ ruleId: 3, rulesetId: 'a', tabId: 3 })
    let infos = (await state.getMatchedRules()).rulesMatchedInfo
    expect(infos.map((m) => [m.rule.ruleId, m.tabId])).toEqual([
      [1, UNKNOWN_TAB_ID],
      [2, UNKNOWN_TAB_ID],
      [3, 3]
    ])
    io.clock += 1
    infos = (await state.getMatchedRules()).rulesMatchedInfo
    expect(infos.map((m) => m.rule.ruleId)).toEqual([3])
    // Matches still attached to an open tab never expire.
    io.clock += 10 * MATCHED_RULE_LIFESPAN_MS
    expect((await state.getMatchedRules()).rulesMatchedInfo.map((m) => m.rule.ruleId)).toEqual([3])
  })

  test('twenty calls per ten minutes, unless made from a user gesture', async () => {
    const io = new FakeIO()
    const state = make(io, { permissions: FEEDBACK })
    for (let i = 0; i < MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL; i++) await state.getMatchedRules()
    await expect(state.getMatchedRules()).rejects.toThrow(ERROR_OVER_QUOTA)
    await expect(state.getMatchedRules({ tabId: 1 })).rejects.toThrow(ERROR_OVER_QUOTA)
    await state.getMatchedRules(undefined, { userGesture: true })
    io.clock += GETMATCHEDRULES_QUOTA_INTERVAL * 60 * 1000 + 1
    await state.getMatchedRules()
  })
})

describe('onRuleMatchedDebug', () => {
  test('fires for unpacked extensions when the host supplies request details', () => {
    const io = new FakeIO()
    io.validTabs = new Set([1])
    const packed = make(io, { permissions: FEEDBACK })
    const packedEvents: MatchedRuleInfoDebug[] = []
    packed.onRuleMatchedDebug((info) => packedEvents.push(info))
    packed.recordMatch({ ruleId: 1, rulesetId: 'a', tabId: 1, request: request(1) })
    expect(packedEvents).toEqual([])

    const unpacked = make(io, { permissions: FEEDBACK, isUnpacked: true })
    const events: MatchedRuleInfoDebug[] = []
    const off = unpacked.onRuleMatchedDebug((info) => events.push(info))
    unpacked.recordMatch({ ruleId: 1, rulesetId: 'a', tabId: 1 })
    unpacked.recordMatch({ ruleId: 2, rulesetId: '_session', tabId: 42, request: request(42) })
    expect(events).toEqual([
      {
        rule: { ruleId: 2, rulesetId: '_session' },
        request: { ...request(42), tabId: UNKNOWN_TAB_ID }
      }
    ])
    off()
    unpacked.recordMatch({ ruleId: 3, rulesetId: 'a', tabId: 1, request: request(1) })
    expect(events).toHaveLength(1)
  })
})

describe('formatMessage', () => {
  test('substitutes each star in turn', () => {
    expect(formatMessage('No tab with id: *.', 4)).toBe('No tab with id: 4.')
    expect(formatMessage('* and *', 'a', 'b')).toBe('a and b')
    expect(formatMessage('* and *', 'a')).toBe('a and *')
  })
})
