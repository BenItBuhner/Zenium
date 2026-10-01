/**
 * `chrome.contentSettings` on the phone: every extension holding `contentSettings` keeps rules
 * per type (`javascript`, `images`, `cookies`, `popups`, `location`, `notifications`, the
 * capture devices…), each a pair of Chrome's content-settings patterns, a value and a scope;
 * the regular-scope rules persist in the runtime's store (Chrome's `ExtensionPrefs`), the
 * `incognito_session_only` ones end with the session. The shim builds the setting objects from
 * the shared table (`CONTENT_SETTING_TYPE_NAMES`) and routes `get` / `set` / `clear` here as
 * `contentSettings.<method>(type, details)`; the pattern grammar, the details' checks and one
 * extension's precedence (the more specific primary pattern, then the more specific secondary
 * one; a rule set again for the same pair replaces the earlier) are the shared model's
 * (`core/extensions/api/contentSettings.ts`); between extensions the most recently installed
 * wins, as for every `ChromeSetting` (the desktop's `ContentSettingsApi` is the shape).
 *
 * How the rules reach the pages: through the permission store's override
 * (`PermissionService.setOverride`), the provider the store consults before the user's answers
 * and the defaults in every `resolve` and `stored` – Chrome's extension provider ranks above its
 * preference provider the same way. So a rule decides wherever the phone asks the core:
 *
 * - `javascript` and `images` per navigation – the Android host asks `ContentRulesService.
 *   resolveAll` for the destination before the request leaves (`view.load` / `view.reload`
 *   preset the answers; a page-started navigation holds for them) and `TabWebView.
 *   applyContentRules` sets `WebSettings.javaScriptEnabled` / `loadsImagesAutomatically` from
 *   the word, so a `block` set by an extension stops the page's scripts from its next load, as
 *   Quick Javascript Switcher's action click expects (`set` then `tabs.reload`). A change of the
 *   rules is announced through `overridesChanged`, which the rules service forwards as a forced
 *   push of its document: the Kotlin host drops the answers it remembered and asks again.
 * - `popups` at the pop-up blocker's decision (`permissions.stored('popups', opener)`);
 *   `location`, `notifications`, `camera`, `microphone`, `clipboard` and `automaticDownloads`
 *   at the prompt engine's and the downloads service's questions. `cookies` is the
 *   `on-device-site-data` row, which the phone's request path does not ask the core about per
 *   request: its rules are kept and reported by `get`, a recorded limit.
 * - The retired types (plugins, fullscreen, mouselock, unsandboxedPlugins) answer Chrome's fixed
 *   value and accept `set` as a no-op; `autoVerify` has no feature here (kept and reported).
 *
 * Private tabs: the core asks with the tab's `privateContainerId`, so the override answers a
 * private tab from the `incognito_session_only` rules first and the regular ones after, of the
 * extensions the user allowed in private tabs alone; `get({ incognito: true })` reads the same
 * and needs a private tab open, as Chrome needs an incognito window.
 */
import type { ContentDefault } from '../shared/contentSettings'
import type { PermissionOverride, PermissionRequestDetails } from '../core/permissions'
import {
  NO_INCOGNITO_WINDOW_ERROR,
  contentSettingType,
  contentSettingTypeFor,
  decisionOfSetting,
  matchingRule,
  normalizeClearDetails,
  normalizeGetDetails,
  normalizeSetDetails,
  normalizeStoredRules,
  persistedRules,
  sameRulePatterns,
  settingOfDecision,
  sortRules,
  type ContentSettingRule,
  type ContentSettingScope,
  type ContentSettingTypeSpec
} from '../core/extensions/api/contentSettings'
import { INCOGNITO_ERROR, INCOGNITO_SCOPE_ERROR } from '../core/extensions/api/privacy'
import type { AttachedExtension } from './extensionApi'

export const CONTENT_SETTINGS_PERMISSION = 'contentSettings'

/** The refusal for a caller without the permission (in Chrome the namespace is not there at all), in the words of the preference API's. */
export const CONTENT_SETTINGS_PERMISSION_ERROR =
  "You do not have permission to access the content setting. Be sure to declare the 'contentSettings' permission in your manifest."

const REGULAR: readonly ContentSettingScope[] = ['regular']
const PRIVATE: readonly ContentSettingScope[] = ['incognito_session_only', 'regular']

/** The permission store as this layer needs it: the override slot, the change signal, the browser's own answer. */
export interface ContentSettingsPermissions {
  setOverride(provider: PermissionOverride | null): void
  overridesChanged(permissions: readonly string[]): void
  resolve(
    permission: string,
    requestingUrl: string,
    details?: PermissionRequestDetails
  ): ContentDefault
}

/** A store record, for the boot-time rebuild before the extension attaches. */
export interface ContentSettingsPrimeRecord {
  id: string
  installedAt: number
  allowPrivate: boolean
}

export interface ContentSettingsHost {
  attached(id: string): AttachedExtension | undefined
  /** Whether the extension holds `contentSettings`: declared, or optional and granted. */
  holdsPermission(ext: AttachedExtension): boolean
  /** Whether the user allowed the extension in private tabs (`allowPrivate`). */
  allowedInPrivate(id: string): boolean
  /** Whether a private tab is open (Chrome's incognito reads need an incognito window). */
  privateTabOpen(): boolean
  /** An extension's persisted rules by type name (the runtime's store), and the write of them (`{}` forgets). */
  persistedRules(id: string): unknown
  persistRules(id: string, rules: Record<string, ContentSettingRule[]>): void
  /** The core's permission store (`browser.permissions`). */
  permissions: ContentSettingsPermissions
  warn(message: string): void
}

/** An extension's rules as the resolution sees them, and what the rank needs of it. */
interface Holder {
  id: string
  installedAt: number
  allowPrivate: boolean
  /** By type name, each list in the order set. */
  rules: Map<string, ContentSettingRule[]>
}

export class AndroidContentSettings {
  /** By extension id: the attached extensions' rules, and the primed records' until they attach. */
  private readonly holders = new Map<string, Holder>()

  constructor(private readonly host: ContentSettingsHost) {
    host.permissions.setOverride(this.override)
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /**
   * The boot-time rebuild, before any extension attaches and before any tab WebView exists: the
   * enabled records' persisted rules apply to the first pages. A persisted rule implies the
   * permission (only `set` writes one); the manifest's word follows at the attach (`load`).
   */
  prime(records: readonly ContentSettingsPrimeRecord[]): void {
    const types = new Set<string>()
    for (const record of records) {
      const rules = this.stored(record.id)
      if (rules.size === 0) continue
      this.holders.set(record.id, { ...record, rules })
      for (const name of rules.keys()) types.add(name)
    }
    if (types.size > 0) this.changed([...types])
  }

  /** The extension attached: its persisted rules apply again, with its manifest's permission checked. */
  load(ext: AttachedExtension): void {
    const had = this.holders.get(ext.record.id)
    this.holders.delete(ext.record.id)
    const types = new Set<string>(had?.rules.keys() ?? [])
    if (this.host.holdsPermission(ext)) {
      const rules = this.stored(ext.record.id)
      if (rules.size > 0) {
        this.holders.set(ext.record.id, this.holder(ext, rules))
        for (const name of rules.keys()) types.add(name)
      }
    }
    if (types.size > 0) this.changed([...types])
  }

  /** Disabled or detached: its rules stop applying (the store keeps them). */
  unload(extensionId: string): void {
    const had = this.holders.get(extensionId)
    this.holders.delete(extensionId)
    if (had && had.rules.size > 0) this.changed([...had.rules.keys()])
  }

  /** Uninstalled: the rules go with it. */
  forget(extensionId: string): void {
    this.unload(extensionId)
    this.host.persistRules(extensionId, {})
  }

  /** The user allowed an extension in private tabs, or withdrew that: the private tabs' answers may differ now. */
  privateAccessChanged(): void {
    const types = new Set<string>()
    for (const holder of this.holders.values()) {
      const allowed = this.host.allowedInPrivate(holder.id)
      if (allowed === holder.allowPrivate) continue
      holder.allowPrivate = allowed
      for (const name of holder.rules.keys()) types.add(name)
    }
    if (types.size > 0) this.changed([...types])
  }

  /** The rules one extension holds for a type, in the order set (diagnostics, tests). */
  rulesOf(extensionId: string, type: string): readonly ContentSettingRule[] {
    return this.holders.get(extensionId)?.rules.get(type) ?? []
  }

  // ---------------------------------------------------------------------------
  // The calls: `chrome.contentSettings.<type>.<method>(details)` as the shim routes a ContentSetting
  // ---------------------------------------------------------------------------

  call(ext: AttachedExtension, method: string, args: readonly unknown[]): unknown {
    const [typeName, details] = args
    if (!this.host.holdsPermission(ext)) throw new Error(CONTENT_SETTINGS_PERMISSION_ERROR)
    const type = contentSettingType(typeName)
    if (!type) throw new Error(`Unknown content setting ${String(typeName)}.`)
    switch (method) {
      case 'get':
        return this.get(ext, type, details)
      case 'set':
        return this.set(ext, type, details)
      case 'clear':
        return this.clear(ext, type, details)
      case 'getResourceIdentifiers':
        // Resource identifiers were plug-ins' (retired with them): no type has any.
        return undefined
      default:
        throw new Error(
          `chrome.contentSettings.${type.name}.${method} is not implemented on Zenium for Android`
        )
    }
  }

  private get(
    ext: AttachedExtension,
    type: ContentSettingTypeSpec,
    raw: unknown
  ): { setting: string } {
    const details = normalizeGetDetails(raw)
    if (typeof details === 'string') throw new Error(details)
    if (details.incognito) {
      if (!this.host.allowedInPrivate(ext.record.id)) throw new Error(INCOGNITO_ERROR)
      if (!this.host.privateTabOpen()) throw new Error(NO_INCOGNITO_WINDOW_ERROR)
    }
    if (type.fixed) return { setting: type.fixed }
    const rule = this.ruleFor(
      type.name,
      details.primaryUrl,
      details.secondaryUrl,
      details.incognito
    )
    if (rule) return { setting: rule.setting }
    return { setting: this.browserSetting(type, details.primaryUrl, details.secondaryUrl) }
  }

  private set(ext: AttachedExtension, type: ContentSettingTypeSpec, raw: unknown): void {
    const details = normalizeSetDetails(type, raw)
    if (typeof details === 'string') throw new Error(details)
    if (details.scope === 'incognito_session_only') {
      if (!this.host.allowedInPrivate(ext.record.id)) throw new Error(INCOGNITO_ERROR)
      if (!this.host.privateTabOpen()) throw new Error(INCOGNITO_SCOPE_ERROR)
    }
    if (type.fixed) return
    const rule: ContentSettingRule = {
      primaryPattern: details.primary.source,
      secondaryPattern: details.secondary.source,
      setting: details.setting,
      scope: details.scope
    }
    const holder = this.holders.get(ext.record.id) ?? this.holder(ext, new Map())
    const list = (holder.rules.get(type.name) ?? []).filter(
      (other) => !sameRulePatterns(other, rule)
    )
    list.push(rule)
    holder.rules.set(type.name, list)
    this.holders.set(ext.record.id, holder)
    this.persist(holder)
    this.changed([type.name])
  }

  private clear(ext: AttachedExtension, type: ContentSettingTypeSpec, raw: unknown): void {
    const details = normalizeClearDetails(raw)
    if (typeof details === 'string') throw new Error(details)
    if (details.scope === 'incognito_session_only' && !this.host.allowedInPrivate(ext.record.id))
      throw new Error(INCOGNITO_ERROR)
    const holder = this.holders.get(ext.record.id)
    const list = holder?.rules.get(type.name)
    if (!holder || !list) return
    const kept = list.filter((rule) => rule.scope !== details.scope)
    if (kept.length === list.length) return
    if (kept.length > 0) holder.rules.set(type.name, kept)
    else holder.rules.delete(type.name)
    this.persist(holder)
    this.changed([type.name])
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /**
   * The store's question: the row's permission (`geolocation` is `location`'s; a media request
   * arrives qualified as `camera` or `microphone`), the requesting page as the primary URL and
   * the embedding page (or the page itself) as the secondary one; a private tab's question
   * carries its container and is answered from the extensions allowed there, their
   * `incognito_session_only` rules first.
   */
  private readonly override: PermissionOverride = (
    permission: string,
    requestingUrl: string,
    details?: PermissionRequestDetails
  ): ContentDefault | null => {
    const type = contentSettingTypeFor(permission)
    if (!type || type.fixed) return null
    const rule = this.ruleFor(
      type.name,
      requestingUrl,
      details?.embedderUrl ?? requestingUrl,
      details?.privateContainerId !== undefined
    )
    return rule ? decisionOfSetting(rule.setting) : null
  }

  /**
   * The rule that decides a pair of URLs: the extensions in Chrome's order (the most recently
   * installed first; for a private tab only the ones allowed there), each one's rules by
   * pattern specificity, a private tab's incognito rules before its regular ones.
   */
  private ruleFor(
    type: string,
    primaryUrl: string,
    secondaryUrl: string,
    incognito: boolean
  ): ContentSettingRule | null {
    const holders = [...this.holders.values()]
      .filter((holder) => !incognito || holder.allowPrivate)
      .sort((a, b) => b.installedAt - a.installedAt)
    for (const holder of holders) {
      const list = holder.rules.get(type)
      if (!list || list.length === 0) continue
      const rule = matchingRule(
        sortRules(list),
        primaryUrl,
        secondaryUrl,
        incognito ? PRIVATE : REGULAR
      )
      if (rule) return rule
    }
    return null
  }

  /** What the browser decides for the site without an extension's rule, in Chrome's words. */
  private browserSetting(
    type: ContentSettingTypeSpec,
    primaryUrl: string,
    secondaryUrl: string
  ): string {
    if (type.permission === null) return type.fallback ?? 'allow'
    const details: PermissionRequestDetails = {}
    if (secondaryUrl !== primaryUrl) details.embedderUrl = secondaryUrl
    const decision = this.host.permissions.resolve(type.permission, primaryUrl, details)
    const setting = settingOfDecision(decision)
    return type.values.includes(setting) ? setting : type.values[0]
  }

  private holder(ext: AttachedExtension, rules: Map<string, ContentSettingRule[]>): Holder {
    return {
      id: ext.record.id,
      installedAt: ext.record.installedAt,
      allowPrivate: ext.record.allowPrivate === true,
      rules
    }
  }

  /** An extension's persisted rules read back, by type: what is not a known type or not a rule is dropped. */
  private stored(extensionId: string): Map<string, ContentSettingRule[]> {
    const raw = this.host.persistedRules(extensionId)
    const out = new Map<string, ContentSettingRule[]>()
    if (raw === null || typeof raw !== 'object') return out
    for (const [name, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!contentSettingType(name)) continue
      const rules = normalizeStoredRules(list)
      if (rules.length > 0) out.set(name, rules)
    }
    return out
  }

  private persist(holder: Holder): void {
    const out: Record<string, ContentSettingRule[]> = {}
    for (const [name, list] of holder.rules) {
      const kept = persistedRules(list)
      if (kept.length > 0) out[name] = kept
    }
    this.host.persistRules(holder.id, out)
  }

  /** The store's listeners learn the rows whose answers may differ now (the rules service re-asks for the open tabs' next loads). */
  private changed(types: readonly string[]): void {
    const permissions: string[] = []
    for (const name of types) {
      const permission = contentSettingType(name)?.permission
      if (permission && !permissions.includes(permission)) permissions.push(permission)
    }
    if (permissions.length > 0) this.host.permissions.overridesChanged(permissions)
  }
}
