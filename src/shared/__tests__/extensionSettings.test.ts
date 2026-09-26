import { describe, expect, it } from 'vitest'
import {
  EMPTY_EXTENSION_LAYER,
  EXTENSION_SETTING_KEYS,
  STRICT_POLE,
  effectivePreloadPages,
  effectiveSwitch,
  effectiveThirdPartyCookiePolicy,
  extensionBoolean,
  privateThirdPartyCookieSwitch,
  type ExtensionControls,
  type ExtensionLayer
} from '../extensionSettings'
import {
  PRELOAD_PAGES_LABELS,
  sanitizePreloadPages,
  type PreloadPagesLevel,
  type ThirdPartyCookiePolicy
} from '../privacy'
import { isPreloadRequest } from '../../core/protection/policy'

const GUARD = { extensionId: 'guard', name: 'Guard' }

/** A published layer, nothing pending (the run's ordinary state). */
function layer(controls: ExtensionControls = {}): ExtensionLayer {
  return { controls, pending: false }
}

/** The cold start's interval before the first publish: nothing published, the strict pole answers. */
const PENDING: ExtensionLayer = { controls: {}, pending: true }

describe('the extension layer over the settings (chrome.privacy, services pass 10)', () => {
  it('reads a switch as the extension holds it and as the user has it otherwise', () => {
    const key = EXTENSION_SETTING_KEYS.passwordSaving
    expect(effectiveSwitch(layer(), key, true)).toBe(true)
    expect(effectiveSwitch(layer(), key, false)).toBe(false)
    expect(effectiveSwitch(EMPTY_EXTENSION_LAYER, key, true)).toBe(true)
    expect(effectiveSwitch(layer({ [key]: { ...GUARD, value: false } }), key, true)).toBe(false)
    expect(effectiveSwitch(layer({ [key]: { ...GUARD, value: true } }), key, false)).toBe(true)
    // A hold on another key, or one without a boolean value, is not this switch.
    const other = EXTENSION_SETTING_KEYS.autofillCards
    expect(effectiveSwitch(layer({ [other]: { ...GUARD, value: false } }), key, true)).toBe(true)
    expect(effectiveSwitch(layer({ [key]: { ...GUARD } }), key, true)).toBe(true)
    expect(effectiveSwitch(layer({ [key]: { ...GUARD, value: 'off' } }), key, true)).toBe(true)
    expect(extensionBoolean(layer({ [key]: { ...GUARD, value: 1 } }), key)).toBeUndefined()
  })

  it("reads the cookie boolean as Chrome's one cookie pref: false blocks everywhere, true allows everywhere", () => {
    const key = EXTENSION_SETTING_KEYS.thirdPartyCookies
    const user: ThirdPartyCookiePolicy = {
      thirdPartyCookies: 'block-private',
      thirdPartyCookiesPrivate: 'block'
    }
    expect(effectiveThirdPartyCookiePolicy(layer(), user)).toBe(user)
    expect(
      effectiveThirdPartyCookiePolicy(layer({ [key]: { ...GUARD, value: false } }), user)
    ).toEqual({
      thirdPartyCookies: 'block',
      thirdPartyCookiesPrivate: 'block'
    })
    expect(
      effectiveThirdPartyCookiePolicy(layer({ [key]: { ...GUARD, value: true } }), user)
    ).toEqual({
      thirdPartyCookies: 'allow',
      thirdPartyCookiesPrivate: 'default'
    })
    // The user's `allow` under the extension's `false`, and the user's `block` under its `true`.
    expect(
      effectiveThirdPartyCookiePolicy(layer({ [key]: { ...GUARD, value: false } }), {
        thirdPartyCookies: 'allow',
        thirdPartyCookiesPrivate: 'default'
      }).thirdPartyCookies
    ).toBe('block')
    expect(
      effectiveThirdPartyCookiePolicy(layer({ [key]: { ...GUARD, value: true } }), {
        thirdPartyCookies: 'block',
        thirdPartyCookiesPrivate: 'default'
      }).thirdPartyCookies
    ).toBe('allow')
  })
})

describe("the private contexts' cookie switch under the layer (the independent review's Required 1)", () => {
  const key = EXTENSION_SETTING_KEYS.thirdPartyCookies
  const userAllowing: ThirdPartyCookiePolicy = {
    thirdPartyCookies: 'block-private',
    thirdPartyCookiesPrivate: 'allow'
  }
  const userBlocking: ThirdPartyCookiePolicy = {
    thirdPartyCookies: 'block',
    thirdPartyCookiesPrivate: 'default'
  }

  it("is the user's own status while no extension holds the cookie setting: live under block-private, locked under the global block", () => {
    expect(privateThirdPartyCookieSwitch(layer(), userAllowing)).toEqual({
      blocked: false,
      locked: false
    })
    expect(
      privateThirdPartyCookieSwitch(layer(), {
        thirdPartyCookies: 'block-private',
        thirdPartyCookiesPrivate: 'default'
      })
    ).toEqual({ blocked: true, locked: false })
    // The user's own block everywhere: on and locked, no extension named.
    expect(privateThirdPartyCookieSwitch(layer(), userBlocking)).toEqual({
      blocked: true,
      locked: true
    })
    // A hold on another key is not this switch.
    expect(
      privateThirdPartyCookieSwitch(
        layer({ [EXTENSION_SETTING_KEYS.safeBrowsing]: { ...GUARD, value: false } }),
        userAllowing
      )
    ).toEqual({ blocked: false, locked: false })
  })

  it('locks the switch on under thirdPartyCookiesAllowed=false and names the holder', () => {
    expect(
      privateThirdPartyCookieSwitch(layer({ [key]: { ...GUARD, value: false } }), userAllowing)
    ).toEqual({ blocked: true, locked: true, lockedByExtension: 'Guard' })
  })

  it('locks the switch OFF under thirdPartyCookiesAllowed=true and names the holder – a tap would spring back', () => {
    // The user's private override says block; the extension's `true` is Chrome's "Allow all
    // cookies", the incognito block lifted too – the switch reads off, and locked at that pole.
    expect(
      privateThirdPartyCookieSwitch(layer({ [key]: { ...GUARD, value: true } }), {
        thirdPartyCookies: 'block-private',
        thirdPartyCookiesPrivate: 'block'
      })
    ).toEqual({ blocked: false, locked: true, lockedByExtension: 'Guard' })
    // Over the user's own global block as well: the extension's allow wins and locks.
    expect(
      privateThirdPartyCookieSwitch(layer({ [key]: { ...GUARD, value: true } }), userBlocking)
    ).toEqual({ blocked: false, locked: true, lockedByExtension: 'Guard' })
  })

  it('names the holder by its published name, empty while there is none', () => {
    expect(
      privateThirdPartyCookieSwitch(
        layer({ [key]: { extensionId: 'guard', name: '', value: true } }),
        userAllowing
      ).lockedByExtension
    ).toBe('')
  })

  it('reads the block – locked on, no name yet – while the layer is pending at a cold start', () => {
    expect(privateThirdPartyCookieSwitch(PENDING, userAllowing)).toEqual({
      blocked: true,
      locked: true,
      lockedByExtension: ''
    })
  })
})

describe('the pending layer answers the strict pole at every reader (the root’s merge condition, C1)', () => {
  it('has one strict pole per key, the least permissive: only Safe Browsing is on', () => {
    expect(Object.keys(STRICT_POLE).sort()).toEqual(Object.values(EXTENSION_SETTING_KEYS).sort())
    expect(STRICT_POLE).toEqual({
      'passwords.offerToSave': false,
      'autofill.addresses': false,
      'autofill.cards': false,
      'privacy.safeBrowsingEnabled': true,
      'privacy.thirdPartyCookies': false,
      'search.suggestions': false,
      'privacy.preloadPages': false
    })
  })

  it("answers the strict pole over the user's permissive value, and over a value already published", () => {
    for (const key of Object.values(EXTENSION_SETTING_KEYS)) {
      const strict = STRICT_POLE[key]
      expect(extensionBoolean(PENDING, key)).toBe(strict)
      expect(effectiveSwitch(PENDING, key, !strict)).toBe(strict)
      expect(effectiveSwitch(PENDING, key, strict)).toBe(strict)
      // A publish that has landed under a pending flag still to clear reads strict too: the
      // flag is the platform's word that the layer is not whole yet.
      expect(
        extensionBoolean({ controls: { [key]: { ...GUARD, value: !strict } }, pending: true }, key)
      ).toBe(strict)
    }
  })

  it('leaves a key without a strict pole to the map: pending says nothing about the font rows', () => {
    expect(extensionBoolean(PENDING, 'fonts.standard')).toBeUndefined()
    expect(effectiveSwitch(PENDING, 'fonts.standard', true)).toBe(true)
  })

  it('reads the block and no preloading while pending, whatever the user chose', () => {
    expect(
      effectiveThirdPartyCookiePolicy(PENDING, {
        thirdPartyCookies: 'allow',
        thirdPartyCookiesPrivate: 'allow'
      })
    ).toEqual({ thirdPartyCookies: 'block', thirdPartyCookiesPrivate: 'allow' })
    expect(effectivePreloadPages(PENDING, 'standard')).toBe('none')
    expect(effectivePreloadPages(PENDING, 'none')).toBe('none')
  })

  it("reads the extension's value, or the user's, the moment the layer is no longer pending", () => {
    const key = EXTENSION_SETTING_KEYS.passwordSaving
    expect(effectiveSwitch(layer({}), key, true)).toBe(true)
    expect(effectiveSwitch(layer({ [key]: { ...GUARD, value: true } }), key, false)).toBe(true)
    expect(
      effectiveThirdPartyCookiePolicy(layer(), {
        thirdPartyCookies: 'allow',
        thirdPartyCookiesPrivate: 'default'
      }).thirdPartyCookies
    ).toBe('allow')
    expect(effectivePreloadPages(layer(), 'standard')).toBe('standard')
  })
})

describe('Preload pages (PS-43)', () => {
  it("reads networkPredictionEnabled over the user's level: false is none, true the user's own", () => {
    const key = EXTENSION_SETTING_KEYS.preloadPages
    expect(key).toBe('privacy.preloadPages')
    for (const user of ['standard', 'extended', 'none'] as const) {
      expect(effectivePreloadPages(layer(), user)).toBe(user)
      expect(effectivePreloadPages(layer({ [key]: { ...GUARD, value: false } }), user)).toBe('none')
      expect(effectivePreloadPages(layer({ [key]: { ...GUARD, value: true } }), user)).toBe(user)
      expect(effectivePreloadPages(layer({ [key]: { ...GUARD } }), user)).toBe(user)
    }
  })

  it('sanitises the persisted level to the three values, standard for anything else', () => {
    for (const level of ['standard', 'extended', 'none'] as const)
      expect(sanitizePreloadPages(level)).toBe(level)
    for (const junk of [undefined, null, true, 'Standard', 'off', 7, {}])
      expect(sanitizePreloadPages(junk)).toBe('standard')
    const offered: PreloadPagesLevel[] = Object.keys(PRELOAD_PAGES_LABELS) as PreloadPagesLevel[]
    expect(offered).toEqual(['standard', 'none'])
  })

  it('tells a speculative request by Sec-Purpose, any case, prefetch or prefetch;prerender, never by the type alone', () => {
    expect(isPreloadRequest({ 'Sec-Purpose': 'prefetch' })).toBe(true)
    expect(isPreloadRequest({ 'sec-purpose': 'prefetch;prerender' })).toBe(true)
    expect(isPreloadRequest({ 'SEC-PURPOSE': 'Prefetch ; anonymous-client-ip' })).toBe(true)
    expect(isPreloadRequest({ Purpose: 'prefetch' })).toBe(true)
    expect(isPreloadRequest({})).toBe(false)
    expect(isPreloadRequest({ 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'no-cors' })).toBe(false)
    expect(isPreloadRequest({ 'Sec-Purpose': 'prerender' })).toBe(false)
    expect(isPreloadRequest({ 'X-Purpose': 'prefetch', Accept: 'prefetch' })).toBe(false)
  })
})
