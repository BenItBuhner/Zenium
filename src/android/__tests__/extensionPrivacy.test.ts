import { DNR_BAND_SIZE, RULE_SET_PRIORITY, type RuleSet } from '@core/blocking/rules'
import {
  INCOGNITO_ERROR,
  INCOGNITO_SCOPE_ERROR,
  PRIVACY_CONTROL_KEYS,
  PRIVACY_PERMISSION_ERROR,
  PRIVACY_SETTINGS,
  browserValueOf,
  privacyRequestEffects,
  settingKey,
  type PrivacyUserSettings,
  type ScopedValues
} from '@core/extensions/api/privacy'
import type { ExtensionControl } from '@shared/types'
import { describe, expect, it } from 'vitest'
import type { AttachedExtension } from '../extensionApi'
import {
  AndroidPrivacy,
  PRIVACY_PRIVATE_RULE_SET_ID,
  PRIVACY_RULE_SET_ID,
  PRIVACY_RULE_SET_PRIORITY,
  doNotTrackScript,
  privacyRuleSet,
  webViewPrivacyLayer,
  type PrivacyHost,
  type WebViewPrivacyLayer
} from '../extensionPrivacy'

/*
 * `chrome.privacy` on the phone against a fake host: the values kept per extension and scope,
 * Chrome's install-order precedence with each caller's level of control, `onChange` per
 * receiver, the controls published under the desktop's keys (and rebuilt from the store at
 * boot, before any extension attaches), the request rule set for `DNT: 1` and the `Referer`
 * drop (applied once the engine is there), the document-start layer for `navigator.doNotTrack`,
 * the private-tab gates and the permission gate.
 */

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

function ext(
  id: string,
  installedAt: number,
  permissions: string[] = ['privacy'],
  allowPrivate = false
): AttachedExtension {
  return {
    record: { id, installedAt, name: `Ext ${id[0].toUpperCase()}`, allowPrivate },
    manifest: { name: `Ext ${id[0].toUpperCase()}`, permissions },
    messages: null
  } as unknown as AttachedExtension
}

class FakeHost implements PrivacyHost {
  readonly attachedById = new Map<string, AttachedExtension>()
  readonly persisted = new Map<string, Record<string, ScopedValues>>()
  readonly published: Array<Record<string, ExtensionControl>> = []
  readonly emitted: Array<{ id: string; event: string; details: Record<string, unknown> }> = []
  readonly warnings: string[] = []
  readonly layers: WebViewPrivacyLayer[] = []
  /** The engine's sets by id, once `engineUp`. */
  readonly sets = new Map<string, RuleSet>()
  readonly removed: string[] = []
  engineUp = false
  privateOpen = false
  /** The user's Settings as `shared/defaults.ts` has them for the paired settings. */
  settings: PrivacyUserSettings = {
    passwords: { offerToSave: true },
    autofill: { addresses: true, cards: true },
    privacy: { safeBrowsingEnabled: true, thirdPartyCookies: 'block-private', dnt: false },
    searchSuggestions: true,
    preloadPages: 'standard'
  }
  partitions: string[] = ['default']
  failRules: string | null = null

  attached(id: string): AttachedExtension | undefined {
    return this.attachedById.get(id)
  }
  allAttached(): Iterable<AttachedExtension> {
    return this.attachedById.values()
  }
  holdsPermission(ext: AttachedExtension): boolean {
    return (ext.manifest as unknown as { permissions: string[] }).permissions.includes('privacy')
  }
  allowedInPrivate(id: string): boolean {
    return this.attachedById.get(id)?.record.allowPrivate === true
  }
  privateTabOpen(): boolean {
    return this.privateOpen
  }
  persistedValues(id: string): unknown {
    return this.persisted.get(id) ?? {}
  }
  persistValues(id: string, values: Record<string, ScopedValues>): void {
    if (Object.keys(values).length === 0) this.persisted.delete(id)
    else this.persisted.set(id, values)
  }
  userSettings(): PrivacyUserSettings {
    return this.settings
  }
  regularPartitions(): readonly string[] {
    return this.partitions
  }
  applyRequestRules(sets: { set: RuleSet[]; remove: string[] }): boolean {
    if (this.failRules) throw new Error(this.failRules)
    if (!this.engineUp) return false
    for (const set of sets.set) this.sets.set(set.id, set)
    for (const id of sets.remove) {
      this.sets.delete(id)
      this.removed.push(id)
    }
    return true
  }
  applyDocumentStart(layer: WebViewPrivacyLayer): Promise<void> {
    this.layers.push(layer)
    return Promise.resolve()
  }
  publish(controls: Record<string, ExtensionControl>): void {
    this.published.push(controls)
  }
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void {
    this.emitted.push({
      id: extensionId,
      event: `${ns}.${name}`,
      details: args[0] as Record<string, unknown>
    })
  }
  warn(message: string): void {
    this.warnings.push(message)
  }

  /** Attach an extension as the runtime does: known to the host, then loaded into the API. */
  attach(api: AndroidPrivacy, e: AttachedExtension): AttachedExtension {
    this.attachedById.set(e.record.id, e)
    api.load(e)
    return e
  }
  detach(api: AndroidPrivacy, id: string): void {
    this.attachedById.delete(id)
    api.unload(id)
  }
  last(): Record<string, ExtensionControl> | undefined {
    return this.published[this.published.length - 1]
  }
}

function make(): { host: FakeHost; api: AndroidPrivacy } {
  const host = new FakeHost()
  const api = new AndroidPrivacy(host)
  return { host, api }
}

const PASSWORDS = settingKey('services', 'passwordSavingEnabled')
const DNT = settingKey('websites', 'doNotTrackEnabled')
const REFERRERS = settingKey('websites', 'referrersEnabled')

/** A `get`'s value alone. */
function value(api: AndroidPrivacy, e: AttachedExtension, category: string, name: string): unknown {
  return (api.call(e, 'get', [category, name, {}]) as { value: unknown }).value
}

describe('doNotTrackScript', () => {
  it("defines navigator.doNotTrack on the prototype as '1' while on and null while off", () => {
    const Navigator = { prototype: {} as { doNotTrack?: string | null } }
    new Function('Navigator', doNotTrackScript(true))(Navigator)
    expect(Navigator.prototype.doNotTrack).toBe('1')
    expect(Object.getOwnPropertyDescriptor(Navigator.prototype, 'doNotTrack')).toMatchObject({
      configurable: true,
      enumerable: true
    })
    new Function('Navigator', doNotTrackScript(false))(Navigator)
    expect(Navigator.prototype.doNotTrack).toBeNull()
    // Where the prototype is not writable the script is silent (a page's own freeze).
    const frozen = { prototype: Object.freeze({}) }
    expect(() => new Function('Navigator', doNotTrackScript(true))(frozen)).not.toThrow()
  })

  it('the layer carries the regular and the private value with both scripts', () => {
    const layer = webViewPrivacyLayer(
      { doNotTrack: true, dropReferer: false, cancelPings: false },
      { doNotTrack: false, dropReferer: false, cancelPings: false }
    )
    expect(layer).toEqual({
      doNotTrack: true,
      doNotTrackPrivate: false,
      script: { on: doNotTrackScript(true), off: doNotTrackScript(false) }
    })
  })
})

describe('privacyRuleSet', () => {
  const none = { doNotTrack: false, dropReferer: false, cancelPings: false }

  it('is null with nothing to carry – the ping cancel installs no rule – and null with no partition', () => {
    expect(privacyRuleSet('x', none, ['default'], null)).toBeNull()
    expect(privacyRuleSet('x', { ...none, cancelPings: true }, ['default'], null)).toBeNull()
    expect(privacyRuleSet('x', { ...none, doNotTrack: true }, [], null)).toBeNull()
  })

  it('carries DNT: 1 and the Referer drop on documents alone, above every dNR slot, scoped and attributed', () => {
    const set = privacyRuleSet(
      PRIVACY_RULE_SET_ID,
      { doNotTrack: true, dropReferer: true, cancelPings: false },
      ['default', 'work'],
      { id: A, name: 'Ext A' }
    )
    expect(set).toEqual({
      id: PRIVACY_RULE_SET_ID,
      source: 'builtin',
      priority: RULE_SET_PRIORITY.dnr + DNR_BAND_SIZE,
      enabled: true,
      rules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'DNT', operation: 'set', value: '1' },
              { header: 'Referer', operation: 'remove' }
            ]
          },
          condition: { resourceTypes: ['main_frame', 'sub_frame'] }
        }
      ],
      partitions: ['default', 'work'],
      attribution: {
        name: 'Ext A: chrome.privacy request settings',
        url: `chrome-extension://${A}/`,
        licence: ''
      }
    })
    expect(PRIVACY_RULE_SET_PRIORITY).toBeGreaterThan(RULE_SET_PRIORITY.dnr)
    const dntOnly = privacyRuleSet('y', { ...none, doNotTrack: true }, ['default'], null)
    expect(dntOnly?.rules?.[0].action.requestHeaders).toEqual([
      { header: 'DNT', operation: 'set', value: '1' }
    ])
    expect(dntOnly?.attribution?.name).toBe('chrome.privacy request settings')
  })

  it('the effects read the three settings that reach requests', () => {
    const effective = new Map([
      [DNT, { value: true, controller: A }],
      [REFERRERS, { value: false, controller: A }],
      [settingKey('websites', 'hyperlinkAuditingEnabled'), { value: false, controller: A }]
    ])
    expect(privacyRequestEffects((key) => effective.get(key))).toEqual({
      doNotTrack: true,
      dropReferer: true,
      cancelPings: true
    })
    expect(privacyRequestEffects(() => undefined)).toEqual({
      doNotTrack: false,
      dropReferer: false,
      cancelPings: false
    })
  })
})

describe('AndroidPrivacy', () => {
  it('needs the permission, knows every setting and its three methods', () => {
    const { host, api } = make()
    const bare = host.attach(api, ext(A, 1, ['storage']))
    expect(() => api.call(bare, 'get', ['services', 'passwordSavingEnabled', {}])).toThrow(
      PRIVACY_PERMISSION_ERROR
    )
    const a = host.attach(api, ext(B, 2))
    expect(() => api.call(a, 'get', ['services', 'nonsense', {}])).toThrow(
      'Unknown privacy setting services.nonsense.'
    )
    expect(() => api.call(a, 'watch', ['services', 'passwordSavingEnabled', {}])).toThrow(
      'chrome.privacy.services.passwordSavingEnabled.watch is not implemented on Zenium for Android'
    )
    // Nothing held: the browser's own value – the user's Settings for the paired settings (the
    // autofill pair `true` where the table's default says off), the table's default for the rest.
    for (const spec of PRIVACY_SETTINGS) {
      expect(api.call(a, 'get', [spec.category, spec.name, {}])).toEqual({
        value: browserValueOf(spec, host.settings),
        levelOfControl: 'controllable_by_this_extension'
      })
    }
    expect(value(api, a, 'services', 'autofillAddressEnabled')).toBe(true)
    expect(value(api, a, 'services', 'autofillCreditCardEnabled')).toBe(true)
    expect(value(api, a, 'services', 'safeBrowsingEnabled')).toBe(true)
    expect(value(api, a, 'websites', 'thirdPartyCookiesAllowed')).toBe(true)
    expect(value(api, a, 'services', 'spellingServiceEnabled')).toBe(false)
    host.settings.privacy.thirdPartyCookies = 'block'
    host.settings.preloadPages = 'none'
    expect(value(api, a, 'websites', 'thirdPartyCookiesAllowed')).toBe(false)
    expect(value(api, a, 'network', 'networkPredictionEnabled')).toBe(false)
    // Nothing held: nothing published, no layer sent, no rules.
    expect(host.published).toEqual([])
    expect(host.layers).toEqual([])
  })

  it("iCloud Passwords' read-before-set takes every setting whose user value differs from its target (R21-9)", () => {
    const { host, api } = make()
    const a = host.attach(api, ext(A, 1, ['privacy'], false))
    // Its `#g(setting, false)`: `get`, return when the value already equals the target, else `set`.
    const settings = [
      ['services', 'passwordSavingEnabled'],
      ['services', 'autofillCreditCardEnabled'],
      ['services', 'autofillAddressEnabled']
    ] as const
    let sets = 0
    for (const [category, name] of settings) {
      if (value(api, a, category, name) === false) continue
      api.call(a, 'set', [category, name, { value: false }])
      sets++
    }
    expect(sets).toBe(3)
    for (const [category, name] of settings) {
      expect(api.call(a, 'get', [category, name, {}])).toEqual({
        value: false,
        levelOfControl: 'controlled_by_this_extension'
      })
    }
    expect(host.last()).toEqual({
      'passwords.offerToSave': { extensionId: A, name: 'Ext A', value: false },
      'autofill.addresses': { extensionId: A, name: 'Ext A', value: false },
      'autofill.cards': { extensionId: A, name: 'Ext A', value: false }
    })
    // The user's Settings do not move: the layer above them answers.
    expect(host.settings.autofill).toEqual({ addresses: true, cards: true })
  })

  it("the user's own Do Not Track installs no rule and no layer – the protection service's to send; an extension's does", () => {
    const { host, api } = make()
    host.engineUp = true
    host.settings.privacy.dnt = true
    const a = host.attach(api, ext(A, 1))
    expect(api.call(a, 'get', ['websites', 'doNotTrackEnabled', {}])).toEqual({
      value: true,
      levelOfControl: 'controllable_by_this_extension'
    })
    api.engineReady()
    expect(host.sets.size).toBe(0)
    expect(host.layers).toEqual([])
    expect(host.published).toEqual([])
    // The extension's own value carries the effects; the user's value shows again once it clears.
    api.call(a, 'set', ['websites', 'doNotTrackEnabled', { value: true }])
    expect(host.sets.get(PRIVACY_RULE_SET_ID)?.rules?.[0].action.requestHeaders).toEqual([
      { header: 'DNT', operation: 'set', value: '1' }
    ])
    expect(host.layers[host.layers.length - 1].doNotTrack).toBe(true)
    api.call(a, 'clear', ['websites', 'doNotTrackEnabled', {}])
    expect(host.sets.has(PRIVACY_RULE_SET_ID)).toBe(false)
    expect(host.layers[host.layers.length - 1].doNotTrack).toBe(false)
    expect(api.call(a, 'get', ['websites', 'doNotTrackEnabled', {}])).toEqual({
      value: true,
      levelOfControl: 'controllable_by_this_extension'
    })
  })

  it("iCloud Passwords' shape: set stores, persists, publishes under the desktop's key, answers the caller its level and tells the listeners", () => {
    const { host, api } = make()
    const a = host.attach(api, ext(A, 1))
    const other = host.attach(api, ext(B, 2, ['privacy', 'storage']))
    const bare = host.attach(api, ext('c'.repeat(32), 3, ['storage']))
    expect(api.call(a, 'set', ['services', 'passwordSavingEnabled', { value: false }])).toBe(
      undefined
    )
    expect(api.call(a, 'get', ['services', 'passwordSavingEnabled', {}])).toEqual({
      value: false,
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(api.call(other, 'get', ['services', 'passwordSavingEnabled', {}])).toEqual({
      value: false,
      levelOfControl: 'controlled_by_other_extensions'
    })
    // The store: by setting key, the regular scope's value.
    expect(host.persisted.get(A)).toEqual({ [PASSWORDS]: { regular: false } })
    // The publish: the desktop's key, the controller and the regular tabs' value.
    expect(host.last()).toEqual({
      'passwords.offerToSave': { extensionId: A, name: 'Ext A', value: false }
    })
    expect(PRIVACY_CONTROL_KEYS.map(([, key]) => key)).toEqual([
      'passwords.offerToSave',
      'autofill.addresses',
      'autofill.cards',
      'privacy.safeBrowsingEnabled',
      'privacy.thirdPartyCookies',
      'search.suggestions',
      'privacy.preloadPages',
      'privacy.dnt'
    ])
    // onChange: every holder of the permission, each with its own level; not the extension without it.
    expect(host.emitted).toEqual([
      {
        id: A,
        event: `privacy.${PASSWORDS}.onChange`,
        details: { value: false, levelOfControl: 'controlled_by_this_extension' }
      },
      {
        id: B,
        event: `privacy.${PASSWORDS}.onChange`,
        details: { value: false, levelOfControl: 'controlled_by_other_extensions' }
      }
    ])
    expect(host.emitted.some((e) => e.id === bare.record.id)).toBe(false)
    // A value that did not move publishes and reports nothing more.
    host.emitted.length = 0
    const published = host.published.length
    api.call(a, 'set', ['services', 'passwordSavingEnabled', { value: false }])
    expect(host.emitted).toEqual([])
    expect(host.published).toHaveLength(published)
    // The browser's value of passwordSavingEnabled is the user's own setting.
    api.call(a, 'clear', ['services', 'passwordSavingEnabled', {}])
    expect(host.persisted.has(A)).toBe(false)
    expect(host.last()).toEqual({})
    host.settings.passwords.offerToSave = false
    expect(api.call(a, 'get', ['services', 'passwordSavingEnabled', {}])).toEqual({
      value: false,
      levelOfControl: 'controllable_by_this_extension'
    })
  })

  it('ranks the most recently installed extension first; a clear surfaces the next value', () => {
    const { host, api } = make()
    const a = host.attach(api, ext(A, 1))
    const b = host.attach(api, ext(B, 2))
    api.call(a, 'set', ['websites', 'doNotTrackEnabled', { value: true }])
    api.call(b, 'set', ['websites', 'doNotTrackEnabled', { value: false }])
    expect(api.effectiveValue('websites', 'doNotTrackEnabled', false)).toBe(false)
    expect(api.controller('websites', 'doNotTrackEnabled')).toBe(B)
    expect(api.call(a, 'get', ['websites', 'doNotTrackEnabled', {}])).toEqual({
      value: false,
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(host.last()).toEqual({
      'privacy.dnt': { extensionId: B, name: 'Ext B', value: false }
    })
    api.call(b, 'clear', ['websites', 'doNotTrackEnabled', {}])
    expect(api.effectiveValue('websites', 'doNotTrackEnabled', false)).toBe(true)
    expect(api.controller('websites', 'doNotTrackEnabled')).toBe(A)
    expect(host.last()).toEqual({
      'privacy.dnt': { extensionId: A, name: 'Ext A', value: true }
    })
    // Disabled: A's value stops applying, the store keeps it; enabled again it applies at attach.
    host.detach(api, A)
    expect(api.controller('websites', 'doNotTrackEnabled')).toBeNull()
    expect(host.last()).toEqual({})
    expect(host.persisted.get(A)).toEqual({ [DNT]: { regular: true } })
    host.attach(api, ext(A, 1))
    expect(api.controller('websites', 'doNotTrackEnabled')).toBe(A)
    // Uninstalled: the values go with it.
    host.detach(api, A)
    api.forget(A)
    expect(host.persisted.has(A)).toBe(false)
  })

  it('rebuilds the controls from the store at boot, before any extension attaches; the attach re-checks the permission', () => {
    const { host, api } = make()
    host.persisted.set(A, { [PASSWORDS]: { regular: false }, [DNT]: { regular: true } })
    host.persisted.set(B, { [DNT]: { regular: false }, 'nonsense.key': { regular: true } })
    api.prime([
      { id: A, name: 'iCloud Passwords', installedAt: 1, allowPrivate: false },
      { id: B, name: 'Later', installedAt: 2, allowPrivate: false }
    ])
    expect(host.published).toEqual([
      {
        'passwords.offerToSave': { extensionId: A, name: 'iCloud Passwords', value: false },
        'privacy.dnt': { extensionId: B, name: 'Later', value: false }
      }
    ])
    // The document-start layer went out from the store too; the rules wait for the engine.
    expect(host.layers).toEqual([])
    expect(host.sets.size).toBe(0)
    host.engineUp = true
    api.engineReady()
    expect(host.sets.size).toBe(0)
    expect(host.removed).toEqual([PRIVACY_RULE_SET_ID, PRIVACY_PRIVATE_RULE_SET_ID])
    // B attaches without the permission any more: its value drops out, A's DNT stands.
    host.attach(api, ext(B, 2, ['storage']))
    expect(host.last()).toEqual({
      'passwords.offerToSave': { extensionId: A, name: 'iCloud Passwords', value: false },
      'privacy.dnt': { extensionId: A, name: 'iCloud Passwords', value: true }
    })
    expect(host.layers.map((l) => l.doNotTrack)).toEqual([true])
    expect(host.sets.get(PRIVACY_RULE_SET_ID)?.rules?.[0].action.requestHeaders).toEqual([
      { header: 'DNT', operation: 'set', value: '1' }
    ])
    // A attaches: its name follows the manifest; nothing moved otherwise.
    host.attach(api, ext(A, 1))
    expect(host.last()).toEqual({
      'passwords.offerToSave': { extensionId: A, name: 'Ext A', value: false },
      'privacy.dnt': { extensionId: A, name: 'Ext A', value: true }
    })
    expect(host.layers).toHaveLength(1)
  })

  it('installs the request rule set once the engine is there, replaces it as the effects move and removes it when nothing is held', () => {
    const { host, api } = make()
    host.partitions = ['default', 'work']
    const a = host.attach(api, ext(A, 1))
    api.call(a, 'set', ['websites', 'doNotTrackEnabled', { value: true }])
    // Before the engine: nothing applied, nothing warned; the layer went to Kotlin.
    expect(host.sets.size).toBe(0)
    expect(host.warnings).toEqual([])
    expect(host.layers).toEqual([
      webViewPrivacyLayer(
        { doNotTrack: true, dropReferer: false, cancelPings: false },
        { doNotTrack: false, dropReferer: false, cancelPings: false }
      )
    ])
    host.engineUp = true
    api.engineReady()
    const set = host.sets.get(PRIVACY_RULE_SET_ID)
    expect(set).toMatchObject({
      source: 'builtin',
      priority: PRIVACY_RULE_SET_PRIORITY,
      partitions: ['default', 'work'],
      attribution: { name: 'Ext A: chrome.privacy request settings' }
    })
    expect(set?.rules?.[0].action.requestHeaders).toEqual([
      { header: 'DNT', operation: 'set', value: '1' }
    ])
    expect(host.sets.has(PRIVACY_PRIVATE_RULE_SET_ID)).toBe(false)
    // Referrers off joins the same rule.
    api.call(a, 'set', ['websites', 'referrersEnabled', { value: false }])
    expect(host.sets.get(PRIVACY_RULE_SET_ID)?.rules?.[0].action.requestHeaders).toEqual([
      { header: 'DNT', operation: 'set', value: '1' },
      { header: 'Referer', operation: 'remove' }
    ])
    // The ping cancel changes no rule (the recorded platform limit) but is held and published.
    const before = host.sets.get(PRIVACY_RULE_SET_ID)
    api.call(a, 'set', ['websites', 'hyperlinkAuditingEnabled', { value: false }])
    expect(host.sets.get(PRIVACY_RULE_SET_ID)).toEqual(before)
    expect(api.effectiveValue('websites', 'hyperlinkAuditingEnabled', false)).toBe(false)
    // Everything cleared: the set goes, the layer says off.
    api.call(a, 'clear', ['websites', 'doNotTrackEnabled', {}])
    api.call(a, 'clear', ['websites', 'referrersEnabled', {}])
    expect(host.sets.has(PRIVACY_RULE_SET_ID)).toBe(false)
    expect(host.removed).toContain(PRIVACY_RULE_SET_ID)
    expect(host.layers[host.layers.length - 1].doNotTrack).toBe(false)
    // A refused engine is warned about, not thrown to the caller.
    host.failRules = 'engine down'
    api.call(a, 'set', ['websites', 'doNotTrackEnabled', { value: true }])
    expect(host.warnings).toEqual(['privacy: the request rules were refused: engine down'])
  })

  it('keeps private tabs to the extensions allowed in them, with the private set scoped to the private partition', () => {
    const { host, api } = make()
    const a = host.attach(api, ext(A, 1))
    expect(() =>
      api.call(a, 'get', ['websites', 'doNotTrackEnabled', { incognito: true }])
    ).toThrow(INCOGNITO_ERROR)
    expect(() =>
      api.call(a, 'set', [
        'websites',
        'doNotTrackEnabled',
        { value: true, scope: 'incognito_persistent' }
      ])
    ).toThrow(INCOGNITO_ERROR)
    // A regular value does not reach private tabs from an extension not allowed there.
    api.call(a, 'set', ['websites', 'doNotTrackEnabled', { value: true }])
    expect(api.effectiveValue('websites', 'doNotTrackEnabled', true)).toBe(false)
    host.engineUp = true
    api.engineReady()
    expect(host.sets.has(PRIVACY_PRIVATE_RULE_SET_ID)).toBe(false)
    expect(host.layers[host.layers.length - 1]).toMatchObject({
      doNotTrack: true,
      doNotTrackPrivate: false
    })
    // Allowed in private tabs: the regular value applies there too, the private set follows.
    host.attachedById.set(A, ext(A, 1, ['privacy'], true))
    api.privateAccessChanged()
    expect(api.effectiveValue('websites', 'doNotTrackEnabled', true)).toBe(true)
    expect(host.sets.get(PRIVACY_PRIVATE_RULE_SET_ID)).toMatchObject({ partitions: ['private'] })
    expect(host.layers[host.layers.length - 1]).toMatchObject({
      doNotTrack: true,
      doNotTrackPrivate: true
    })
    // The session-only scope needs a private tab open, as Chrome's needs an incognito window.
    const b = host.attach(api, ext(B, 2, ['privacy'], true))
    expect(() =>
      api.call(b, 'set', [
        'websites',
        'doNotTrackEnabled',
        { value: false, scope: 'incognito_session_only' }
      ])
    ).toThrow(INCOGNITO_SCOPE_ERROR)
    host.privateOpen = true
    api.call(b, 'set', [
      'websites',
      'doNotTrackEnabled',
      { value: false, scope: 'incognito_session_only' }
    ])
    expect(api.effectiveValue('websites', 'doNotTrackEnabled', true)).toBe(false)
    expect(api.effectiveValue('websites', 'doNotTrackEnabled', false)).toBe(true)
    expect(api.call(b, 'get', ['websites', 'doNotTrackEnabled', { incognito: true }])).toEqual({
      value: false,
      levelOfControl: 'controlled_by_this_extension',
      incognitoSpecific: true
    })
    // The session-only value is not persisted. The private changes reached the allowed holders
    // alone: A when its access opened (the value moved to true for private tabs), then A and B
    // for B's session-only value; none while A was kept out of private tabs.
    expect(host.persisted.get(B)).toBeUndefined()
    const privateEvents = host.emitted.filter(
      (e) => e.event === `privacy.${DNT}.onChange` && e.details.incognitoSpecific !== undefined
    )
    expect(privateEvents.map((e) => [e.id, e.details.value])).toEqual([
      [A, true],
      [A, false],
      [B, false]
    ])
  })
})
