/**
 * `chrome.privacy` on the phone: Chrome's `types.ChromeSetting`s over the browser settings the
 * API exposes, live for the extensions that hold the permission.
 *
 * The shim builds the setting objects from the shared table (`PRIVACY_SETTING_NAMES`) and routes
 * their `get` / `set` / `clear` here as `privacy.<method>(category, name, details)`. Every
 * extension holding `privacy` may set every setting; the values are kept per extension, setting
 * and scope (persisted in the runtime's store but for the session-only private scope, as Chrome's
 * `ExtensionPrefs` keep them) and resolve per Chrome's precedence – the most recently installed
 * enabled extension wins (`core/extensions/api/privacy.ts`, the pure model both hosts share) –
 * to one effective value per setting for regular tabs and one for private tabs; an extension's
 * values reach private tabs only where the user allowed it (`allowPrivate`). A change is
 * reported through the setting's `onChange` to every holder of the permission, each with its own
 * `levelOfControl`.
 *
 * What the phone acts on:
 *
 * - The layer the services read: the held settings' keys are published whole under the
 *   `'privacy'` source of `UIState.extensionControls` (`PRIVACY_CONTROL_KEYS`: the same keys the
 *   desktop publishes) on every change, never persisted as such – the services' hooks read
 *   `extension ?? user` and act by themselves; the Settings rows show the controlling extension.
 *   At boot the map is REBUILT FROM THE STORE before any tab WebView exists (`prime`: the
 *   runtime is built inside the `Browser` constructor, ahead of the startup windows), so the
 *   first page's decisions read the held values; the attach of each extension then re-resolves
 *   with its manifest's permission checked.
 * - Do Not Track: `navigator.doNotTrack` reads `'1'` in every document from document start
 *   (`ext.privacy.apply`: a per-view document-start script the Kotlin host registers, swapped
 *   when the value moves, the open documents' value moved in place), and the `DNT: 1` request
 *   header goes out through the blocking engine as a `modifyHeaders` rule set the runtime
 *   installs (`builtin:extension-privacy`; the private tabs' twin scoped to the private
 *   partition). Referrers off drops `Referer` through the same rule. What the engine can carry
 *   on this platform bounds both: a `modifyHeaders` rule is honoured for documents alone (main
 *   and sub frames, `GET` / `HEAD`), which the header stage relays to build their headers;
 *   subresources go out as WebView sends them (the platform's recorded `modifyHeaders` limit).
 *   While an extension holds either setting every document navigation pays that relay.
 * - Hyperlink auditing off (the `ping` cancel) installs nothing: WebView's requests carry no
 *   resource type and the engine reads an unknown one as a fetch for a type-only rule, so a
 *   `ping` block could never select one – the value is kept and reported, the effect is a
 *   recorded limit. `network.webRTCIPHandlingPolicy` likewise: WebView has no policy API.
 * - The other settings stand for Chromium features the WebView exposes no switch for or Zenium
 *   does not have: their values are remembered and reported back, so extensions that toggle them
 *   at start-up run and see their own value.
 * - The browser's own value, while no extension controls a setting, is the user's Settings value
 *   for the paired settings (`browserValueOf`: `passwords.offerToSave`, `autofill.addresses`,
 *   `autofill.cards`, Safe Browsing, the cookie mode, search suggestions, preloading, Do Not
 *   Track), as Chrome's `get` answers the user's pref – a read-before-set extension (iCloud
 *   Passwords' `#g`) sets what differs from its target (R21-9); the unpaired settings answer the
 *   table's default. The effects (rules, the document-start layer) carry an extension's value
 *   alone: the user's own Do Not Track is the protection service's to send.
 */
import type { HeaderOp, Rule, RuleSet } from '../core/blocking/rules'
import { DNR_BAND_SIZE, RULE_SET_PRIORITY } from '../core/blocking/rules'
import {
  INCOGNITO_ERROR,
  INCOGNITO_SCOPE_ERROR,
  PRIVACY_PERMISSION_ERROR,
  PRIVACY_SETTINGS,
  browserValueOf,
  effectiveSetting,
  hasValues,
  incognitoSpecific,
  isIncognitoScope,
  levelOfControlFor,
  normalizeClearDetails,
  normalizeGetDetails,
  normalizeSetDetails,
  normalizeStoredPrivacyValues,
  persistedValues,
  privacyControls,
  privacyRequestEffects,
  privacySetting,
  sameEffective,
  sameRequestEffects,
  settingKey,
  settingResult,
  withValue,
  withoutValue,
  type EffectiveSetting,
  type PrivacyRank,
  type PrivacyRequestEffects,
  type PrivacySettingSpec,
  type PrivacyUserSettings,
  type PrivacyValue,
  type ScopedValues,
  type SettingResult
} from '../core/extensions/api/privacy'
import { PRIVATE_CONTAINER_ID, type ExtensionControl } from '../shared/types'
import type { AttachedExtension } from './extensionApi'

export const PRIVACY_PERMISSION = 'privacy'

/** The engine set of the regular tabs' request effects, and the private tabs'. */
export const PRIVACY_RULE_SET_ID = 'builtin:extension-privacy'
export const PRIVACY_PRIVATE_RULE_SET_ID = 'builtin:extension-privacy-private'

/**
 * Above every extension's declarativeNetRequest slot: the resolved privacy value stands over an
 * extension's own header rules, as the desktop's request hooks rank above every extension's
 * listeners (`PRIVACY_REGISTRANT`, `Number.MAX_SAFE_INTEGER`).
 */
export const PRIVACY_RULE_SET_PRIORITY: number = RULE_SET_PRIORITY.dnr + DNR_BAND_SIZE

/** What `ext.privacy.apply` carries to the Kotlin host. */
export interface WebViewPrivacyLayer {
  /** Whether `navigator.doNotTrack` reads `'1'` in regular tabs' documents. */
  doNotTrack: boolean
  /** The same for private tabs' documents. */
  doNotTrackPrivate: boolean
  /** The scripts that move an open document's value: registered at document start while on. */
  script: { on: string; off: string }
}

export const EMPTY_WEBVIEW_PRIVACY_LAYER: Readonly<WebViewPrivacyLayer> = {
  doNotTrack: false,
  doNotTrackPrivate: false,
  script: { on: '', off: '' }
}

/**
 * `navigator.doNotTrack` as Chrome reports it: `'1'` while Do Not Track is on, `null` otherwise
 * (the WebView's own value, which has no such setting, is `null`). Defined on the prototype, as
 * the native accessor is, so a page's own `Navigator.prototype` reads agree; configurable so the
 * off script can put the other value back in an open document.
 */
export function doNotTrackScript(on: boolean): string {
  const value = on ? "'1'" : 'null'
  return (
    '(function () {' +
    ' try {' +
    " Object.defineProperty(Navigator.prototype, 'doNotTrack', {" +
    ` get: function () { return ${value} }, configurable: true, enumerable: true });` +
    ' } catch (e) {}' +
    ' })();'
  )
}

/** The Kotlin layer for the two kinds of tab. */
export function webViewPrivacyLayer(
  regular: PrivacyRequestEffects,
  priv: PrivacyRequestEffects
): WebViewPrivacyLayer {
  return {
    doNotTrack: regular.doNotTrack,
    doNotTrackPrivate: priv.doNotTrack,
    script: { on: doNotTrackScript(true), off: doNotTrackScript(false) }
  }
}

/**
 * The engine set that carries one kind of tab's request effects, or null when it has nothing to
 * carry: `DNT: 1` set and `Referer` removed on documents (`main_frame`, `sub_frame` – the
 * requests whose headers the platform's header stage can edit). The `ping` cancel installs no
 * rule (see the module doc). `partitions` scopes the set to the tabs the value applies to.
 */
export function privacyRuleSet(
  id: string,
  effects: PrivacyRequestEffects,
  partitions: readonly string[],
  controller: { id: string; name: string } | null
): RuleSet | null {
  const headers: HeaderOp[] = []
  if (effects.doNotTrack) headers.push({ header: 'DNT', operation: 'set', value: '1' })
  if (effects.dropReferer) headers.push({ header: 'Referer', operation: 'remove' })
  if (headers.length === 0 || partitions.length === 0) return null
  const rule: Rule = {
    id: 1,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: headers },
    condition: { resourceTypes: ['main_frame', 'sub_frame'] }
  }
  return {
    id,
    source: 'builtin',
    priority: PRIVACY_RULE_SET_PRIORITY,
    enabled: true,
    rules: [rule],
    partitions: [...partitions],
    attribution: {
      name: controller
        ? `${controller.name}: chrome.privacy request settings`
        : 'chrome.privacy request settings',
      url: controller ? `chrome-extension://${controller.id}/` : '',
      licence: ''
    }
  }
}

/** A store record, for the boot-time rebuild before the extension attaches. */
export interface PrivacyPrimeRecord {
  id: string
  name: string
  installedAt: number
  allowPrivate: boolean
}

export interface PrivacyHost {
  attached(id: string): AttachedExtension | undefined
  allAttached(): Iterable<AttachedExtension>
  /** Whether the extension holds `privacy`: declared, or optional and granted (`permissions.request`). */
  holdsPermission(ext: AttachedExtension): boolean
  /** Whether the user allowed the extension in private tabs (`allowPrivate`). */
  allowedInPrivate(id: string): boolean
  /** Whether a private tab is open (Chrome's `incognito_session_only` needs an incognito window). */
  privateTabOpen(): boolean
  /** An extension's persisted values by setting key (the runtime's store), and the write of them (`{}` forgets). */
  persistedValues(id: string): unknown
  persistValues(id: string, values: Record<string, ScopedValues>): void
  /**
   * The user's Settings document, read live: the browser's own value of every paired setting
   * (`browserValueOf` – `passwords.offerToSave` for `services.passwordSavingEnabled`,
   * `autofill.addresses` / `autofill.cards` for the two autofill settings, and the rest of
   * `PRIVACY_CONTROL_KEYS`), as Chrome's `get` answers the user's pref.
   */
  userSettings(): PrivacyUserSettings
  /** The container ids of the regular (non-private) partitions, for the request rules' scope. */
  regularPartitions(): readonly string[]
  /**
   * The request effects' sets to the blocking engine (`set` replaces one by id, `remove` drops
   * it); false while the engine is not there yet (the boot-time rebuild runs inside the
   * `Browser` constructor), so the sets are applied at the first resolution after it is.
   */
  applyRequestRules(sets: { set: RuleSet[]; remove: string[] }): boolean
  /** `navigator.doNotTrack` at document start, to every tab WebView (`ext.privacy.apply`). */
  applyDocumentStart(layer: WebViewPrivacyLayer): Promise<void>
  /** The controls the extensions hold, whole (`state.setExtensionControls` through the runtime's merge). */
  publish(controls: Record<string, ExtensionControl>): void
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void
  warn(message: string): void
}

/** An extension's values as the resolution sees them, and what the rank needs of it. */
interface Holder {
  id: string
  name: string
  installedAt: number
  allowPrivate: boolean
  /** By setting key. */
  values: Record<string, ScopedValues>
}

export class AndroidPrivacy {
  /** By extension id: the attached extensions' values, and the primed records' until they attach. */
  private readonly holders = new Map<string, Holder>()
  /** The last resolved value per setting key, for regular (`key`) and private (`key:private`) tabs. */
  private readonly effective = new Map<string, EffectiveSetting>()
  /** The request effects last applied to the engine (null: not applied this run yet). */
  private appliedEffects: { regular: PrivacyRequestEffects; priv: PrivacyRequestEffects } | null =
    null
  /** The document-start layer last handed to the Kotlin host (one string), so an unchanged one is not sent. */
  private documentStartKey = ''
  /** The controls map last published (one string); the empty map counts as published at start. */
  private publishedKey = '{}'
  constructor(private readonly host: PrivacyHost) {}

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /**
   * The boot-time rebuild, before any extension attaches and before any tab WebView exists: the
   * enabled records' persisted values resolve and the controls map is published from them. A
   * persisted value implies the permission (only `set` writes one); the manifest's word follows
   * at each extension's attach (`load`), which re-resolves from the store with the permission
   * checked. The blocking engine is not up yet at this point: the request rule sets wait for the
   * first resolution after it is (the store keeps the last run's sets meanwhile).
   */
  prime(records: readonly PrivacyPrimeRecord[]): void {
    for (const record of records) {
      const values = normalizeStoredPrivacyValues(this.host.persistedValues(record.id))
      if (Object.keys(values).length === 0) continue
      this.holders.set(record.id, { ...record, values })
    }
    this.recompute()
  }

  /** The extension attached: its persisted values apply again, with its manifest's permission checked. */
  load(ext: AttachedExtension): void {
    this.holders.delete(ext.record.id)
    if (this.host.holdsPermission(ext)) {
      const values = normalizeStoredPrivacyValues(this.host.persistedValues(ext.record.id))
      this.holders.set(ext.record.id, this.holder(ext, values))
    }
    this.recompute()
  }

  /** Disabled or detached: its values stop applying (the store keeps them). */
  unload(extensionId: string): void {
    this.holders.delete(extensionId)
    this.recompute()
  }

  /** Uninstalled: the values go with it. */
  forget(extensionId: string): void {
    this.unload(extensionId)
    this.host.persistValues(extensionId, {})
  }

  /**
   * The blocking engine is up (the runtime's `start`, after `blocking.start()` loaded the last
   * run's sets): the request sets follow the current resolution – installed or replaced where a
   * value is held, a stale set of an extension gone while the app was closed removed.
   */
  engineReady(): void {
    this.appliedEffects = null
    const { regular, priv } = this.requestEffects()
    this.applyRequestRules(regular, priv)
  }

  /** The user allowed an extension in private tabs, or withdrew that; or the containers changed. */
  privateAccessChanged(): void {
    for (const holder of this.holders.values()) {
      holder.allowPrivate = this.host.allowedInPrivate(holder.id)
    }
    this.recompute()
  }

  /** The value in effect for regular or private tabs (diagnostics, tests). */
  effectiveValue(object: string, setting: string, incognito: boolean): PrivacyValue | undefined {
    return this.effective.get(effectiveKey(settingKey(object, setting), incognito))?.value
  }

  /** The extension whose value applies for regular tabs, if any (diagnostics, tests). */
  controller(object: string, setting: string): string | null {
    return this.effective.get(settingKey(object, setting))?.controller ?? null
  }

  // ---------------------------------------------------------------------------
  // The calls: `chrome.privacy.<method>(category, name, details)` as the shim routes a ChromeSetting
  // ---------------------------------------------------------------------------

  call(ext: AttachedExtension, method: string, args: readonly unknown[]): unknown {
    const [object, setting, details] = args
    if (!this.host.holdsPermission(ext)) throw new Error(PRIVACY_PERMISSION_ERROR)
    const spec = privacySetting(object, setting)
    if (!spec) throw new Error(`Unknown privacy setting ${String(object)}.${String(setting)}.`)
    switch (method) {
      case 'get':
        return this.get(ext, spec, details)
      case 'set':
        return this.set(ext, spec, details)
      case 'clear':
        return this.clear(ext, spec, details)
      default:
        throw new Error(
          `chrome.privacy.${spec.category}.${spec.name}.${method} is not implemented on Zenium for Android`
        )
    }
  }

  private get(ext: AttachedExtension, spec: PrivacySettingSpec, details: unknown): SettingResult {
    const { incognito } = normalizeGetDetails(details)
    if (incognito && !this.host.allowedInPrivate(ext.record.id)) throw new Error(INCOGNITO_ERROR)
    const key = settingKey(spec.category, spec.name)
    return settingResult(
      this.valuesOf(key),
      this.browserValue(spec),
      ext.record.id,
      incognito,
      this.rank()
    )
  }

  private set(ext: AttachedExtension, spec: PrivacySettingSpec, details: unknown): void {
    const { value, scope } = normalizeSetDetails(spec, details)
    if (isIncognitoScope(scope) && !this.host.allowedInPrivate(ext.record.id))
      throw new Error(INCOGNITO_ERROR)
    if (scope === 'incognito_session_only' && !this.host.privateTabOpen())
      throw new Error(INCOGNITO_SCOPE_ERROR)
    const holder = this.holders.get(ext.record.id) ?? this.holder(ext, {})
    const key = settingKey(spec.category, spec.name)
    const own = holder.values[key] ?? {}
    if (!withValue(own, scope, value)) return
    holder.values[key] = own
    this.holders.set(ext.record.id, holder)
    this.persist(holder)
    this.recompute()
  }

  private clear(ext: AttachedExtension, spec: PrivacySettingSpec, details: unknown): void {
    const { scope } = normalizeClearDetails(details)
    if (isIncognitoScope(scope) && !this.host.allowedInPrivate(ext.record.id))
      throw new Error(INCOGNITO_ERROR)
    const holder = this.holders.get(ext.record.id)
    const key = settingKey(spec.category, spec.name)
    const own = holder?.values[key]
    if (!holder || !own || !withoutValue(own, scope)) return
    if (!hasValues(own)) delete holder.values[key]
    this.persist(holder)
    this.recompute()
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  private holder(ext: AttachedExtension, values: Record<string, ScopedValues>): Holder {
    return {
      id: ext.record.id,
      name: ext.manifest.name || ext.record.name || ext.record.id,
      installedAt: ext.record.installedAt,
      allowPrivate: ext.record.allowPrivate === true,
      values
    }
  }

  /** The values set for one setting, by extension id. */
  private valuesOf(key: string): Map<string, ScopedValues> {
    const out = new Map<string, ScopedValues>()
    for (const holder of this.holders.values()) {
      const own = holder.values[key]
      if (own && hasValues(own)) out.set(holder.id, own)
    }
    return out
  }

  /** Chrome's precedence: the most recently installed extension ranks first; private tabs count the allowed ones. */
  private rank(): PrivacyRank {
    const order = [...this.holders.values()]
      .sort((a, b) => b.installedAt - a.installedAt)
      .map((holder) => holder.id)
    const ranks = new Map(order.map((id, index) => [id, index]))
    return (extensionId, incognito) => {
      const rank = ranks.get(extensionId)
      if (rank === undefined) return undefined
      if (incognito && this.holders.get(extensionId)?.allowPrivate !== true) return undefined
      return rank
    }
  }

  /**
   * The browser's own value while no extension controls the setting: the user's Settings value
   * for the paired settings, the table's default for the rest (R21-9: a read-before-set
   * extension takes a setting whose user value differs from its target, as in Chrome).
   */
  private browserValue(spec: PrivacySettingSpec): PrivacyValue {
    return browserValueOf(spec, this.host.userSettings())
  }

  private persist(holder: Holder): void {
    const out: Record<string, ScopedValues> = {}
    for (const [key, own] of Object.entries(holder.values)) {
      const kept = persistedValues(own)
      if (hasValues(kept)) out[key] = kept
    }
    this.host.persistValues(holder.id, out)
  }

  /** The extension's name as the Extensions page shows it (the record's before it attached; the id when it is gone). */
  private nameOf(extensionId: string): string {
    return (
      this.host.attached(extensionId)?.manifest.name ||
      this.holders.get(extensionId)?.name ||
      extensionId
    )
  }

  /**
   * Resolve every setting for both kinds of tab; a value that changed is reported through
   * `onChange` to every attached extension holding the permission (the ones allowed in private
   * tabs for a private change), each with its own level of control; then the effects follow –
   * the controls map, the request rule sets, the document-start layer.
   */
  private recompute(): void {
    const rank = this.rank()
    for (const spec of PRIVACY_SETTINGS) {
      const key = settingKey(spec.category, spec.name)
      const values = this.valuesOf(key)
      const browserValue = this.browserValue(spec)
      for (const incognito of [false, true]) {
        const next = effectiveSetting(values, browserValue, incognito, rank)
        const prev = this.effective.get(effectiveKey(key, incognito))
        if (prev && sameEffective(prev, next)) continue
        this.effective.set(effectiveKey(key, incognito), next)
        if (!prev) continue
        const details: SettingResult = {
          value: next.value,
          levelOfControl: 'controllable_by_this_extension'
        }
        if (incognito) details.incognitoSpecific = incognitoSpecific(values, rank)
        for (const ext of this.host.allAttached()) {
          if (!this.host.holdsPermission(ext)) continue
          if (incognito && !this.host.allowedInPrivate(ext.record.id)) continue
          this.host.emit(ext.record.id, 'privacy', `${key}.onChange`, [
            { ...details, levelOfControl: levelOfControlFor(next.controller, ext.record.id) }
          ])
        }
      }
    }
    this.publish()
    this.applyEffects()
  }

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  /** The layer the services read: every held key with its holder and the regular tabs' value (`PRIVACY_CONTROL_KEYS`). */
  private publish(): void {
    const controls = privacyControls(
      (key) => this.effective.get(key),
      (id) => this.nameOf(id)
    )
    const key = JSON.stringify(controls)
    if (key === this.publishedKey) return
    this.publishedKey = key
    this.host.publish(controls)
  }

  /**
   * The effects are the extensions': a setting at the browser's own value asks nothing of the
   * extension host – the user's Do Not Track is the protection service's to send, the rules
   * and the document-start layer here carry an extension's value alone.
   */
  private applyEffects(): void {
    const { regular, priv } = this.requestEffects()
    this.applyRequestRules(regular, priv)
    this.applyDocumentStart(regular, priv)
  }

  /** The request effects for both kinds of tab, from the settings an extension controls alone. */
  private requestEffects(): { regular: PrivacyRequestEffects; priv: PrivacyRequestEffects } {
    const controlled = (key: string): EffectiveSetting | undefined => {
      const setting = this.effective.get(key)
      return setting && setting.controller !== null ? setting : undefined
    }
    return {
      regular: privacyRequestEffects(controlled),
      priv: privacyRequestEffects((key) => controlled(effectiveKey(key, true)))
    }
  }

  /** The request effects as the engine's sets: replaced when they moved, applied once the engine is there. */
  private applyRequestRules(regular: PrivacyRequestEffects, priv: PrivacyRequestEffects): void {
    const applied = this.appliedEffects
    if (
      applied &&
      sameRequestEffects(applied.regular, regular) &&
      sameRequestEffects(applied.priv, priv)
    )
      return
    const sets: RuleSet[] = []
    const remove: string[] = []
    const controllerOf = (incognito: boolean): { id: string; name: string } | null => {
      for (const name of ['doNotTrackEnabled', 'referrersEnabled']) {
        const id = this.effective.get(
          effectiveKey(settingKey('websites', name), incognito)
        )?.controller
        if (id) return { id, name: this.nameOf(id) }
      }
      return null
    }
    const regularSet = privacyRuleSet(
      PRIVACY_RULE_SET_ID,
      regular,
      this.host.regularPartitions(),
      controllerOf(false)
    )
    if (regularSet) sets.push(regularSet)
    else remove.push(PRIVACY_RULE_SET_ID)
    const privateSet = privacyRuleSet(
      PRIVACY_PRIVATE_RULE_SET_ID,
      priv,
      [PRIVATE_CONTAINER_ID],
      controllerOf(true)
    )
    if (privateSet) sets.push(privateSet)
    else remove.push(PRIVACY_PRIVATE_RULE_SET_ID)
    let ok: boolean
    try {
      ok = this.host.applyRequestRules({ set: sets, remove })
    } catch (error) {
      this.host.warn(
        `privacy: the request rules were refused: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
    if (ok) this.appliedEffects = { regular, priv }
  }

  /** `navigator.doNotTrack` to the Kotlin host when it moved (or at the first resolution that holds it). */
  private applyDocumentStart(regular: PrivacyRequestEffects, priv: PrivacyRequestEffects): void {
    const layer = webViewPrivacyLayer(regular, priv)
    const key = `${layer.doNotTrack}/${layer.doNotTrackPrivate}`
    if (key === this.documentStartKey) return
    // Nothing held and nothing sent yet: the WebView's own value stands, no message needed.
    if (this.documentStartKey === '' && !layer.doNotTrack && !layer.doNotTrackPrivate) {
      this.documentStartKey = key
      return
    }
    this.documentStartKey = key
    this.host.applyDocumentStart(layer).catch((error: unknown) => {
      this.host.warn(
        `privacy: the document-start layer was refused: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }
}

function effectiveKey(key: string, incognito: boolean): string {
  return incognito ? `${key}:private` : key
}
