import { describe, expect, test } from 'vitest'
import {
  ERROR_INVALID_RESPONSE_HEADER_NAME,
  ERROR_INVALID_RESPONSE_HEADER_OBJECT,
  ERROR_INVALID_RESPONSE_HEADER_VALUE,
  ERROR_INVALID_TEST_INITIATOR,
  ERROR_INVALID_TEST_TAB_ID,
  ERROR_INVALID_TEST_TOP_URL,
  ERROR_INVALID_TEST_URL,
  createDeclarativeNetRequestApi,
  isRegexSupported,
  toMatchRequest
} from '../api'
import { DNR_CONSTANTS, MAX_STATIC_RULES_PER_PROFILE } from '../limits'
import { DnrState, UNKNOWN_TAB_ID, type DnrPersistedState, type DnrStateIO } from '../state'
import { EXTENSION_ID, blockRule, rule } from './fixtures'

function io(files: Record<string, unknown> = {}): DnrStateIO {
  let persisted: DnrPersistedState | undefined
  return {
    async readFile(path) {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`)
      return JSON.stringify(files[path])
    },
    async loadState() {
      return persisted
    },
    async saveState(state) {
      persisted = state
    }
  }
}

describe('isRegexSupported', () => {
  test('defaults to case-sensitive, non-capturing checks', () => {
    expect(isRegexSupported({ regex: '^https://[a-z]+\\.test/' })).toEqual({ isSupported: true })
    expect(isRegexSupported({ regex: '(?<=a)b' })).toEqual({
      isSupported: false,
      reason: 'syntaxError'
    })
    expect(isRegexSupported({ regex: 'a{120}' })).toEqual({
      isSupported: false,
      reason: 'memoryLimitExceeded'
    })
    expect(
      isRegexSupported({ regex: '(a)(b)', requireCapturing: true, isCaseSensitive: false })
    ).toEqual({
      isSupported: true
    })
  })
})

describe('toMatchRequest', () => {
  test('validates the request like Chrome and fills the defaults', () => {
    expect(toMatchRequest({ url: 'https://x.test/a', type: 'image' })).toEqual({
      url: 'https://x.test/a',
      type: 'image',
      tabId: UNKNOWN_TAB_ID
    })
    expect(
      toMatchRequest({
        url: 'https://x.test/a',
        type: 'script',
        initiator: 'https://i.test',
        method: 'post',
        tabId: 3,
        topUrl: 'https://top.test/',
        responseHeaders: { 'Content-Type': ['text/html'] }
      })
    ).toEqual({
      url: 'https://x.test/a',
      type: 'script',
      initiator: 'https://i.test',
      method: 'post',
      tabId: 3,
      topUrl: 'https://top.test/',
      responseHeaders: { 'Content-Type': ['text/html'] }
    })
    expect(() => toMatchRequest({ url: 'not a url', type: 'image' })).toThrow(
      ERROR_INVALID_TEST_URL
    )
    expect(() =>
      toMatchRequest({ url: 'https://x.test/', type: 'image', initiator: 'nope' })
    ).toThrow(ERROR_INVALID_TEST_INITIATOR)
    expect(() => toMatchRequest({ url: 'https://x.test/', type: 'image', tabId: -2 })).toThrow(
      ERROR_INVALID_TEST_TAB_ID
    )
    expect(() => toMatchRequest({ url: 'https://x.test/', type: 'image', topUrl: '::' })).toThrow(
      ERROR_INVALID_TEST_TOP_URL
    )
    expect(() =>
      toMatchRequest({
        url: 'https://x.test/',
        type: 'image',
        responseHeaders: { 'bad header': ['1'] }
      })
    ).toThrow(ERROR_INVALID_RESPONSE_HEADER_NAME.replace('*', 'bad header'))
    expect(() =>
      toMatchRequest({ url: 'https://x.test/', type: 'image', responseHeaders: { 'x-a': 'one' } })
    ).toThrow(ERROR_INVALID_RESPONSE_HEADER_OBJECT.replace('*', 'x-a'))
    expect(() =>
      toMatchRequest({
        url: 'https://x.test/',
        type: 'image',
        responseHeaders: { 'x-a': ['ok', 'bad\r\n'] }
      })
    ).toThrow(ERROR_INVALID_RESPONSE_HEADER_VALUE.replace('*', 'x-a'))
    expect(() =>
      toMatchRequest({ url: 'https://x.test/', type: 'image', responseHeaders: { 'x-a': [1] } })
    ).toThrow(ERROR_INVALID_RESPONSE_HEADER_VALUE.replace('*', 'x-a'))
    expect(() => toMatchRequest({ url: 'https://x.test/', type: 'bogus' as 'image' })).toThrow(
      TypeError
    )
  })
})

describe('createDeclarativeNetRequestApi', () => {
  const files = {
    'rules/a.json': [
      blockRule(1, '||ads.test^'),
      rule(2, { type: 'allow' }, { urlFilter: '||ads.test/ok' }, 2)
    ]
  }
  const ruleResources = [{ id: 'a', enabled: true, path: 'rules/a.json' }]

  test('carries the constants and the method table', async () => {
    const state = new DnrState({ id: EXTENSION_ID, ruleResources }, io(files))
    const api = createDeclarativeNetRequestApi(state)
    expect(api.MAX_NUMBER_OF_DYNAMIC_RULES).toBe(DNR_CONSTANTS.MAX_NUMBER_OF_DYNAMIC_RULES)
    expect(api.DYNAMIC_RULESET_ID).toBe('_dynamic')
    expect(api.SESSION_RULESET_ID).toBe('_session')
    expect(api.GUARANTEED_MINIMUM_STATIC_RULES).toBe(30000)
    expect(await api.getEnabledRulesets()).toEqual(['a'])
    // The guaranteed minimum less the two enabled rules, plus the whole unused global pool.
    expect(await api.getAvailableStaticRuleCount()).toBe(
      DNR_CONSTANTS.GUARANTEED_MINIMUM_STATIC_RULES - 2 + MAX_STATIC_RULES_PER_PROFILE
    )
    await api.updateDynamicRules({ addRules: [blockRule(1, 'dyn')] })
    expect((await api.getDynamicRules()).map((r) => r.id)).toEqual([1])
    await api.updateSessionRules({ addRules: [blockRule(1, 'ses')] })
    expect((await api.getSessionRules()).map((r) => r.id)).toEqual([1])
    await api.updateStaticRules({ rulesetId: 'a', disableRuleIds: [2] })
    expect(await api.getDisabledRuleIds({ rulesetId: 'a' })).toEqual([2])
    expect(await api.isRegexSupported({ regex: '(' })).toEqual({
      isSupported: false,
      reason: 'syntaxError'
    })
    await expect(api.getMatchedRules()).rejects.toThrow(/declarativeNetRequestFeedback/)
    await api.setExtensionActionOptions({ displayActionCountAsBadgeText: true })
    expect(state.displaysActionCountAsBadgeText()).toBe(true)
    // Methods do not rely on `this`.
    const { getEnabledRulesets } = api
    expect(await getEnabledRulesets()).toEqual(['a'])
  })

  test('testMatchOutcome and onRuleMatchedDebug exist only where Chrome offers them', () => {
    const packed = createDeclarativeNetRequestApi(
      new DnrState({ id: EXTENSION_ID, permissions: ['declarativeNetRequestFeedback'] }, io())
    )
    expect(packed.testMatchOutcome).toBeUndefined()
    expect(packed.onRuleMatchedDebug).toBeUndefined()
    const unpacked = createDeclarativeNetRequestApi(
      new DnrState({ id: EXTENSION_ID, isUnpacked: true }, io())
    )
    expect(unpacked.testMatchOutcome).toBeDefined()
    expect(unpacked.onRuleMatchedDebug).toBeUndefined()
    const debuggable = createDeclarativeNetRequestApi(
      new DnrState(
        { id: EXTENSION_ID, isUnpacked: true, permissions: ['declarativeNetRequestFeedback'] },
        io()
      )
    )
    expect(debuggable.onRuleMatchedDebug).toBeDefined()
  })

  test('testMatchOutcome evaluates static, dynamic and session rules together', async () => {
    const state = new DnrState({ id: EXTENSION_ID, ruleResources, isUnpacked: true }, io(files))
    const api = createDeclarativeNetRequestApi(state)
    await api.updateDynamicRules({
      addRules: [rule(7, { type: 'block' }, { urlFilter: '||dyn.test^' })]
    })
    await api.updateSessionRules({
      addRules: [rule(9, { type: 'block' }, { urlFilter: '||ads.test^', tabIds: [4] }, 5)]
    })
    const test = api.testMatchOutcome!
    expect(await test({ url: 'https://ads.test/x.js', type: 'script' })).toEqual({
      matchedRules: [{ ruleId: 1, rulesetId: 'a' }]
    })
    expect(await test({ url: 'https://ads.test/ok', type: 'script' })).toEqual({
      matchedRules: [{ ruleId: 2, rulesetId: 'a' }]
    })
    expect(await test({ url: 'https://dyn.test/', type: 'image' })).toEqual({
      matchedRules: [{ ruleId: 7, rulesetId: '_dynamic' }]
    })
    expect(await test({ url: 'https://ads.test/ok', type: 'script', tabId: 4 })).toEqual({
      matchedRules: [{ ruleId: 9, rulesetId: '_session' }]
    })
    expect(await test({ url: 'https://ads.test/x.js', type: 'main_frame' })).toEqual({
      matchedRules: []
    })
    await api.updateStaticRules({ rulesetId: 'a', disableRuleIds: [1] })
    expect(await test({ url: 'https://ads.test/x.js', type: 'script' })).toEqual({
      matchedRules: []
    })
    await expect(test({ url: 'nope', type: 'script' })).rejects.toThrow(ERROR_INVALID_TEST_URL)
  })

  test('onRuleMatchedDebug behaves like a chrome.events.Event', () => {
    const state = new DnrState(
      { id: EXTENSION_ID, isUnpacked: true, permissions: ['declarativeNetRequestFeedback'] },
      io()
    )
    const api = createDeclarativeNetRequestApi(state)
    const event = api.onRuleMatchedDebug!
    const seen: number[] = []
    const listener = (info: { rule: { ruleId: number } }): void => {
      seen.push(info.rule.ruleId)
    }
    expect(event.hasListeners()).toBe(false)
    event.addListener(listener)
    event.addListener(listener)
    expect(event.hasListener(listener)).toBe(true)
    expect(event.hasListeners()).toBe(true)
    const request = {
      requestId: '1',
      url: 'https://x.test/',
      method: 'GET',
      frameId: 0,
      parentFrameId: -1,
      tabId: 1,
      type: 'image'
    }
    state.recordMatch({ ruleId: 5, rulesetId: '_dynamic', tabId: 1, request })
    expect(seen).toEqual([5])
    event.removeListener(listener)
    expect(event.hasListener(listener)).toBe(false)
    state.recordMatch({ ruleId: 6, rulesetId: '_dynamic', tabId: 1, request })
    expect(seen).toEqual([5])
  })
})
