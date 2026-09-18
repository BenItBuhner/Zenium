import { describe, expect, it } from 'vitest'
import {
  PRIVACY_SETTINGS,
  PRIVACY_SETTING_NAMES,
  acceptsValue,
  controllerOf,
  effectiveSetting,
  incognitoSpecific,
  levelOfControlFor,
  normalizeClearDetails,
  normalizeGetDetails,
  normalizeScopedValues,
  normalizeSetDetails,
  persistedValues,
  privacySetting,
  settingResult,
  valueFor,
  withValue,
  withoutValue,
  type PrivacyRank,
  type ScopedValues
} from '../api/privacy'

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const DISABLED = 'cccccccccccccccccccccccccccccccc'

const webRtc = privacySetting('network', 'webRTCIPHandlingPolicy')!
const auditing = privacySetting('websites', 'hyperlinkAuditingEnabled')!

/** NEW installed after OLD; DISABLED does not count; only NEW is allowed in private windows. */
const rank: PrivacyRank = (id, incognito) => {
  if (id === DISABLED) return undefined
  if (incognito && id !== NEW) return undefined
  return id === NEW ? 0 : 1
}

describe('chrome.privacy settings table', () => {
  it('lists every setting once under its category, with a default the setting accepts', () => {
    const keys = PRIVACY_SETTINGS.map((s) => `${s.category}.${s.name}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const spec of PRIVACY_SETTINGS) {
      expect(PRIVACY_SETTING_NAMES[spec.category]).toContain(spec.name)
      expect(acceptsValue(spec, spec.browserDefault)).toBe(true)
    }
    expect(PRIVACY_SETTING_NAMES.network).toEqual([
      'networkPredictionEnabled',
      'webRTCIPHandlingPolicy'
    ])
    expect(privacySetting('websites', 'topicsEnabled')?.kind).toEqual({ type: 'boolean' })
    expect(privacySetting('network', 'nope')).toBeUndefined()
    expect(privacySetting(3, 'webRTCIPHandlingPolicy')).toBeUndefined()
  })

  it('accepts booleans for boolean settings and the listed strings for enums', () => {
    expect(acceptsValue(auditing, false)).toBe(true)
    expect(acceptsValue(auditing, 'false')).toBe(false)
    expect(acceptsValue(webRtc, 'disable_non_proxied_udp')).toBe(true)
    expect(acceptsValue(webRtc, 'default_public_interface_only')).toBe(true)
    expect(acceptsValue(webRtc, 'proxy_only')).toBe(false)
    expect(acceptsValue(webRtc, true)).toBe(false)
  })
})

describe('chrome.privacy argument shapes', () => {
  it('normalizes get details', () => {
    expect(normalizeGetDetails({})).toEqual({ incognito: false })
    expect(normalizeGetDetails(undefined)).toEqual({ incognito: false })
    expect(normalizeGetDetails({ incognito: true })).toEqual({ incognito: true })
    expect(normalizeGetDetails({ incognito: null })).toEqual({ incognito: false })
    expect(() => normalizeGetDetails({ incognito: 'yes' })).toThrow(/expected boolean/)
    expect(() => normalizeGetDetails([])).toThrow('Invalid details.')
  })

  it('normalizes set details: the value must fit, the scope defaults to regular', () => {
    expect(normalizeSetDetails(auditing, { value: false })).toEqual({
      value: false,
      scope: 'regular'
    })
    expect(
      normalizeSetDetails(webRtc, { value: 'disable_non_proxied_udp', scope: 'regular_only' })
    ).toEqual({ value: 'disable_non_proxied_udp', scope: 'regular_only' })
    expect(() => normalizeSetDetails(auditing, {})).toThrow("Missing required property 'value'.")
    expect(() => normalizeSetDetails(auditing, { value: 'no' })).toThrow(
      "Invalid value for 'hyperlinkAuditingEnabled': expected a boolean."
    )
    expect(() => normalizeSetDetails(webRtc, { value: 'nope' })).toThrow(
      /expected one of default, default_public_and_private_interfaces/
    )
    expect(() => normalizeSetDetails(auditing, { value: true, scope: 'global' })).toThrow(
      "Invalid scope 'global'."
    )
  })

  it('normalizes clear details', () => {
    expect(normalizeClearDetails(undefined)).toEqual({ scope: 'regular' })
    expect(normalizeClearDetails({ scope: 'incognito_session_only' })).toEqual({
      scope: 'incognito_session_only'
    })
    expect(() => normalizeClearDetails({ scope: 1 })).toThrow("Invalid scope '1'.")
  })
})

describe('chrome.privacy scopes', () => {
  it('resolves an entry for normal and private windows the way Chrome does', () => {
    const values: ScopedValues = { regular: 'a' }
    expect(valueFor(values, false)).toBe('a')
    expect(valueFor(values, true)).toBe('a')
    values.regular_only = 'b'
    expect(valueFor(values, false)).toBe('b')
    expect(valueFor(values, true)).toBe('a')
    values.incognito_persistent = 'c'
    expect(valueFor(values, true)).toBe('c')
    values.incognito_session_only = 'd'
    expect(valueFor(values, true)).toBe('d')
    expect(valueFor(values, false)).toBe('b')
    expect(valueFor({ incognito_persistent: 'c' }, false)).toBeUndefined()
    expect(valueFor({ regular_only: 'b' }, true)).toBeUndefined()
  })

  it('reports whether set and clear changed anything', () => {
    const values: ScopedValues = {}
    expect(withValue(values, 'regular', false)).toBe(true)
    expect(withValue(values, 'regular', false)).toBe(false)
    expect(withValue(values, 'regular', true)).toBe(true)
    expect(withoutValue(values, 'regular_only')).toBe(false)
    expect(withoutValue(values, 'regular')).toBe(true)
    expect(values).toEqual({})
  })

  it('persists everything but the session-only private-window value', () => {
    const values: ScopedValues = {
      regular: true,
      regular_only: false,
      incognito_persistent: true,
      incognito_session_only: false
    }
    expect(persistedValues(values)).toEqual({
      regular: true,
      regular_only: false,
      incognito_persistent: true
    })
    expect(normalizeScopedValues(auditing, persistedValues(values))).toEqual({
      regular: true,
      regular_only: false,
      incognito_persistent: true
    })
    // What comes back from disk is checked against the setting: junk and stale kinds drop out.
    expect(
      normalizeScopedValues(webRtc, {
        regular: 'default',
        regular_only: 'bogus',
        incognito_persistent: 3,
        incognito_session_only: 'default'
      })
    ).toEqual({ regular: 'default' })
    expect(normalizeScopedValues(webRtc, 'default')).toEqual({})
    expect(normalizeScopedValues(webRtc, null)).toEqual({})
  })
})

describe('chrome.privacy precedence', () => {
  it('lets the most recently installed extension win, ignoring the ones that do not apply', () => {
    const values = new Map<string, ScopedValues>([
      [OLD, { regular: 'default_public_interface_only' }],
      [DISABLED, { regular: 'disable_non_proxied_udp' }]
    ])
    expect(controllerOf(values, false, rank)).toEqual({
      extensionId: OLD,
      value: 'default_public_interface_only'
    })
    values.set(NEW, { regular: 'default_public_and_private_interfaces' })
    expect(controllerOf(values, false, rank)).toEqual({
      extensionId: NEW,
      value: 'default_public_and_private_interfaces'
    })
    // The newest extension only set a private-window value: normal windows fall back to OLD.
    values.set(NEW, { incognito_persistent: 'disable_non_proxied_udp' })
    expect(controllerOf(values, false, rank)?.extensionId).toBe(OLD)
    expect(controllerOf(values, true, rank)).toEqual({
      extensionId: NEW,
      value: 'disable_non_proxied_udp'
    })
    expect(controllerOf(new Map(), false, rank)).toBeUndefined()
  })

  it('keeps an extension that is not allowed in private windows out of them', () => {
    const values = new Map<string, ScopedValues>([[OLD, { regular: false }]])
    expect(effectiveSetting(values, true, false, rank)).toEqual({ value: false, controller: OLD })
    expect(effectiveSetting(values, true, true, rank)).toEqual({ value: true, controller: null })
  })

  it('orders equal ranks by id', () => {
    const values = new Map<string, ScopedValues>([
      [NEW, { regular: 'b' }],
      [OLD, { regular: 'a' }]
    ])
    const flat: PrivacyRank = () => 0
    expect(controllerOf(values, false, flat)?.extensionId).toBe(OLD)
  })

  it('answers get with the value and the level of control per extension', () => {
    const values = new Map<string, ScopedValues>([[NEW, { regular: false }]])
    expect(settingResult(values, true, NEW, false, rank)).toEqual({
      value: false,
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(settingResult(values, true, OLD, false, rank)).toEqual({
      value: false,
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(settingResult(new Map(), true, OLD, false, rank)).toEqual({
      value: true,
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(levelOfControlFor(null, OLD)).toBe('controllable_by_this_extension')
  })

  it('tells private-window answers whether a private-window value exists', () => {
    const values = new Map<string, ScopedValues>([[NEW, { regular: false }]])
    expect(settingResult(values, true, NEW, true, rank)).toEqual({
      value: false,
      levelOfControl: 'controlled_by_this_extension',
      incognitoSpecific: false
    })
    values.set(NEW, { regular: false, incognito_session_only: true })
    expect(settingResult(values, true, OLD, true, rank)).toEqual({
      value: true,
      levelOfControl: 'controlled_by_other_extensions',
      incognitoSpecific: true
    })
    // A private-window value of an extension that is not allowed there does not count.
    expect(incognitoSpecific(new Map([[OLD, { incognito_persistent: true }]]), rank)).toBe(false)
    expect(incognitoSpecific(new Map([[NEW, { incognito_persistent: true }]]), rank)).toBe(true)
  })
})
