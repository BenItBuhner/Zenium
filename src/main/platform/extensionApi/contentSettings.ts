import { PRIVATE_CONTAINER_ID } from '../../../shared/types'
import type { ContentDefault } from '../../../shared/contentSettings'
import type { PermissionOverride, PermissionRequestDetails } from '../../../core/permissions'
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
} from '../../../core/extensions/api/contentSettings'
import { INCOGNITO_ERROR } from '../../../core/extensions/api/privacy'
import { installOrderRank } from './privacy'
import { ApiError, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

const PERMISSION = 'contentSettings'
const REGULAR: readonly ContentSettingScope[] = ['regular']
const PRIVATE: readonly ContentSettingScope[] = ['incognito_session_only', 'regular']

/**
 * `chrome.contentSettings` for the browser layer: every extension holding `contentSettings`
 * keeps rules per type (`cookies`, `javascript`, `location`, `notifications`, `popups`, the
 * camera and microphone…), each a pair of content-settings patterns, a value and a scope; the
 * regular-scope rules persist, the private-window ones end with the session. `get` answers with
 * the first rule covering the pair of URLs, the extensions ordered as Chrome orders them (the
 * most recently installed first) and one extension's rules by pattern specificity; without a
 * rule, with what the browser itself decided for the site (the user's answer or the type's
 * default), in Chrome's words (`block` for a refusal).
 *
 * The rules reach the engine through the permission store's override: the store resolves the
 * catalogue row each type stands for (`location` is `geolocation`) against the extensions' rules
 * before the user's answers, so a `block` refuses the site's requests without a prompt wherever
 * the desktop enforces the row (notifications, location, the capture devices, pop-ups; the rows
 * the desktop only stores are stored). The private-window rules are reported by `get` but the
 * store has no private-window dimension yet, so they decide nothing in the engine. The retired
 * types (plugins, fullscreen, mouselock) answer Chrome's fixed value and accept `set` as a no-op.
 */
export class ContentSettingsApi {
  /** By extension id, then type name; each list in the order it was set. */
  private readonly rules = new Map<string, Map<string, ContentSettingRule[]>>()

  constructor(private readonly host: ApiHost) {
    host.browser.permissions.setOverride(this.override)
  }

  readonly handlers: NamespaceHandlers = {
    get: (ctx, type, details) => this.get(ctx, type, details),
    set: (ctx, type, details) => this.set(ctx, type, details),
    clear: (ctx, type, details) => this.clear(ctx, type, details),
    getResourceIdentifiers: (ctx, type) => this.getResourceIdentifiers(ctx, type)
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /** An extension was loaded: its persisted rules apply again. */
  load(extensionId: string): void {
    this.rules.delete(extensionId)
    if (this.hasPermission(extensionId)) {
      const stored = this.host.store.contentSettingRules(extensionId)
      const byType = new Map<string, ContentSettingRule[]>()
      for (const [name, raw] of Object.entries(stored)) {
        if (!contentSettingType(name)) continue
        const rules = normalizeStoredRules(raw)
        if (rules.length > 0) byType.set(name, rules)
      }
      if (byType.size > 0) {
        this.rules.set(extensionId, byType)
        this.changed([...byType.keys()])
      }
    }
  }

  /** Disabled or gone from every session: its rules stop applying (the store keeps them). */
  unload(extensionId: string): void {
    const had = this.rules.get(extensionId)
    this.rules.delete(extensionId)
    if (had) this.changed([...had.keys()])
  }

  /** Uninstalled: the rules go with it. */
  forget(extensionId: string): void {
    this.unload(extensionId)
    this.host.store.setContentSettingRules(extensionId, {})
  }

  /** A newer install ranks above the older extensions' rules. */
  installOrderChanged(): void {
    const types = new Set<string>()
    for (const byType of this.rules.values()) for (const name of byType.keys()) types.add(name)
    if (types.size > 0) this.changed([...types])
  }

  /** The rules one extension holds for a type, in the order set (diagnostics, tests). */
  rulesOf(extensionId: string, type: string): readonly ContentSettingRule[] {
    return this.rules.get(extensionId)?.get(type) ?? []
  }

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  private get(ctx: ApiContext, typeName: unknown, raw: unknown): { setting: string } {
    const type = this.type(typeName)
    const details = normalizeGetDetails(raw)
    if (typeof details === 'string') throw new ApiError(details)
    if (details.incognito) {
      if (!this.allowedInPrivate(ctx.extensionId)) throw new ApiError(INCOGNITO_ERROR)
      if (!this.privateWindowOpen()) throw new ApiError(NO_INCOGNITO_WINDOW_ERROR)
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

  private set(ctx: ApiContext, typeName: unknown, raw: unknown): void {
    const type = this.type(typeName)
    const details = normalizeSetDetails(type, raw)
    if (typeof details === 'string') throw new ApiError(details)
    if (details.scope === 'incognito_session_only' && !this.allowedInPrivate(ctx.extensionId))
      throw new ApiError(INCOGNITO_ERROR)
    if (type.fixed) return
    const rule: ContentSettingRule = {
      primaryPattern: details.primary.source,
      secondaryPattern: details.secondary.source,
      setting: details.setting,
      scope: details.scope
    }
    const byType = this.rules.get(ctx.extensionId) ?? new Map<string, ContentSettingRule[]>()
    this.rules.set(ctx.extensionId, byType)
    const list = (byType.get(type.name) ?? []).filter((other) => !sameRulePatterns(other, rule))
    list.push(rule)
    byType.set(type.name, list)
    this.persist(ctx.extensionId)
    this.changed([type.name])
  }

  private clear(ctx: ApiContext, typeName: unknown, raw: unknown): void {
    const type = this.type(typeName)
    const details = normalizeClearDetails(raw)
    if (typeof details === 'string') throw new ApiError(details)
    if (details.scope === 'incognito_session_only' && !this.allowedInPrivate(ctx.extensionId))
      throw new ApiError(INCOGNITO_ERROR)
    const byType = this.rules.get(ctx.extensionId)
    const list = byType?.get(type.name)
    if (!byType || !list) return
    const kept = list.filter((rule) => rule.scope !== details.scope)
    if (kept.length > 0) byType.set(type.name, kept)
    else byType.delete(type.name)
    if (byType.size === 0) this.rules.delete(ctx.extensionId)
    this.persist(ctx.extensionId)
    this.changed([type.name])
  }

  /** Resource identifiers were plug-ins' (retired with them): no type has any. */
  private getResourceIdentifiers(_ctx: ApiContext, typeName: unknown): undefined {
    this.type(typeName)
    return undefined
  }

  private type(name: unknown): ContentSettingTypeSpec {
    const type = contentSettingType(name)
    if (!type) throw new ApiError(`Unknown content setting ${String(name)}.`)
    return type
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /**
   * The engine's question: the row's type, the requesting page as the primary URL and the
   * embedding page (or the page itself) as the secondary one, regular-window rules only.
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
      false
    )
    return rule ? decisionOfSetting(rule.setting) : null
  }

  /**
   * The rule that decides a pair of URLs: the extensions in Chrome's order (the most recently
   * installed first; for a private window only the ones allowed there), each one's rules by
   * pattern specificity, a private window's incognito rules before its regular ones.
   */
  private ruleFor(
    type: string,
    primaryUrl: string,
    secondaryUrl: string,
    incognito: boolean
  ): ContentSettingRule | null {
    const rank = installOrderRank(this.host, (id) => this.allowedInPrivate(id))
    const holders = [...this.rules.keys()]
      .map((id) => ({ id, rank: rank(id, incognito) }))
      .filter((entry): entry is { id: string; rank: number } => entry.rank !== undefined)
      .sort((a, b) => a.rank - b.rank)
    for (const holder of holders) {
      const list = this.rules.get(holder.id)?.get(type)
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
    const decision = this.host.browser.permissions.resolve(type.permission, primaryUrl, details)
    const setting = settingOfDecision(decision)
    return type.values.includes(setting) ? setting : type.values[0]
  }

  private hasPermission(extensionId: string): boolean {
    return this.host.grants(extensionId).permissions.includes(PERMISSION)
  }

  private allowedInPrivate(extensionId: string): boolean {
    return this.host.partitionsOf(extensionId).includes(PRIVATE_CONTAINER_ID)
  }

  private privateWindowOpen(): boolean {
    return this.host.browser.allWindows().some((win) => win.isPrivate)
  }

  private persist(extensionId: string): void {
    const byType = this.rules.get(extensionId)
    const out: Record<string, ContentSettingRule[]> = {}
    for (const [name, list] of byType ?? []) {
      const kept = persistedRules(list)
      if (kept.length > 0) out[name] = kept
    }
    this.host.store.setContentSettingRules(extensionId, out)
  }

  /** The store's listeners learn the rows whose answers may differ now. */
  private changed(types: readonly string[]): void {
    const permissions: string[] = []
    for (const name of types) {
      const permission = contentSettingType(name)?.permission
      if (permission) permissions.push(permission)
    }
    this.host.browser.permissions.overridesChanged(permissions)
  }
}
