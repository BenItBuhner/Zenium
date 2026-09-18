import { PRIVATE_CONTAINER_ID } from '../../../shared/types'
import {
  INCOGNITO_ERROR,
  INCOGNITO_SCOPE_ERROR,
  PRIVACY_PERMISSION_ERROR,
  PRIVACY_SETTINGS,
  effectiveSetting,
  hasValues,
  incognitoSpecific,
  isIncognitoScope,
  isWebRtcIpHandlingPolicy,
  levelOfControlFor,
  normalizeClearDetails,
  normalizeGetDetails,
  normalizeScopedValues,
  normalizeSetDetails,
  persistedValues,
  privacySetting,
  sameEffective,
  settingKey,
  settingResult,
  withValue,
  withoutValue,
  type EffectiveSetting,
  type PrivacyRank,
  type PrivacySettingSpec,
  type PrivacyValue,
  type ScopedValues,
  type SettingResult,
  type WebRtcIpHandlingPolicy
} from '../../../core/extensions/api/privacy'
import type { BlockingResponse, WebRequestDetails } from '../webRequest'
import { ApiError, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'
import type { WebRequestListenerHost } from './webRequest'

/** What the WebRTC policy is applied to: a page's `WebContents`. */
export interface PrivacyPage {
  isDestroyed(): boolean
  setWebRTCIPHandlingPolicy(policy: WebRtcIpHandlingPolicy): void
}

/** The pipeline registrant of the request hooks; ranks above every extension's listeners. */
export const PRIVACY_REGISTRANT = 'zen:privacy'

const PERMISSION = 'privacy'
const HYPERLINK_AUDITING = settingKey('websites', 'hyperlinkAuditingEnabled')
const REFERRERS = settingKey('websites', 'referrersEnabled')
const DO_NOT_TRACK = settingKey('websites', 'doNotTrackEnabled')
const WEB_RTC = settingKey('network', 'webRTCIPHandlingPolicy')
const PASSWORD_SAVING = settingKey('services', 'passwordSavingEnabled')

/**
 * `chrome.privacy` for the browser layer. Every extension holding `privacy` may set every
 * setting; the values are kept per extension, setting and scope (persisted across restarts but
 * for the session-only private-window scope), and resolve per Chrome's precedence rules (the
 * most recently installed enabled extension wins; see `core/extensions/api/privacy.ts`) to one
 * effective value for normal windows and one for private windows. An extension's values reach
 * private windows only when the user allowed it there (`ApiHost.partitionsOf`).
 *
 * What Zenium acts on: the WebRTC IP handling policy goes to every tab page (Electron's
 * `setWebRTCIPHandlingPolicy`, the per-`WebContents` form of Chrome's preference); hyperlink
 * auditing off cancels `ping` requests, referrers off drops the `Referer` header, Do Not Track
 * on adds `DNT: 1`, all in the session's request pipeline and only in the sessions the value
 * applies to. The other settings stand for Chromium features Electron exposes no switch for
 * (network prediction, third-party cookie blocking) or Zenium does not have (Safe Browsing,
 * autofill, the Privacy Sandbox, Google's services): their values are remembered and reported
 * back, so extensions that toggle them at start-up run and see their own value.
 */
export class PrivacyApi {
  /** By setting key, then extension id. */
  private readonly values = new Map<string, Map<string, ScopedValues>>()
  /** The last resolved value per setting, for normal (`false`) and private (`true`) windows. */
  private readonly effective = new Map<string, EffectiveSetting>()
  private readonly pages = new Map<PrivacyPage, boolean>()
  private listenerHost: WebRequestListenerHost | null = null
  private requestHooks: Array<() => void> = []

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    get: (ctx, object, setting, details) => this.get(ctx, object, setting, details),
    set: (ctx, object, setting, details) => this.set(ctx, object, setting, details),
    clear: (ctx, object, setting, details) => this.clear(ctx, object, setting, details)
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /** The session pipeline is created after the API host. */
  attach(listenerHost: WebRequestListenerHost): void {
    this.listenerHost = listenerHost
    this.refreshRequestHooks()
  }

  /** A tab page came up: it follows the WebRTC policy of its kind of window from now on. */
  pageCreated(page: PrivacyPage, incognito: boolean): void {
    this.pages.set(page, incognito)
    const policy = this.effective.get(effectiveKey(WEB_RTC, incognito))?.value
    if (isWebRtcIpHandlingPolicy(policy)) applyWebRtc(page, policy)
  }

  /** An extension was loaded: its persisted values apply again. */
  load(extensionId: string): void {
    for (const spec of PRIVACY_SETTINGS) this.forSetting(spec).delete(extensionId)
    if (!this.hasPermission(extensionId)) {
      this.recompute()
      return
    }
    const stored = this.host.store.privacyValues(extensionId)
    for (const spec of PRIVACY_SETTINGS) {
      const key = settingKey(spec.category, spec.name)
      const values = normalizeScopedValues(spec, stored[key])
      if (hasValues(values)) this.forSetting(spec).set(extensionId, values)
    }
    this.recompute()
  }

  /** Disabled or gone from every session: its values stop applying (the store keeps them). */
  unload(extensionId: string): void {
    for (const byExtension of this.values.values()) byExtension.delete(extensionId)
    this.recompute()
  }

  /** Uninstalled: the values go with it. */
  forget(extensionId: string): void {
    this.unload(extensionId)
    this.host.store.setPrivacyValues(extensionId, {})
  }

  /** A newer install ranks above the older extensions' values. */
  installOrderChanged(): void {
    this.recompute()
  }

  /** The user allowed an extension in private windows, or withdrew that. */
  privateAccessChanged(): void {
    this.recompute()
  }

  /** The value the browser applies for normal or private windows (for diagnostics and tests). */
  effectiveValue(object: string, setting: string, incognito: boolean): PrivacyValue | undefined {
    return this.effective.get(effectiveKey(settingKey(object, setting), incognito))?.value
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private get(ctx: ApiContext, object: unknown, setting: unknown, details: unknown): SettingResult {
    const spec = this.settingFor(ctx, object, setting)
    const { incognito } = wrap(() => normalizeGetDetails(details))
    if (incognito && !this.allowedInPrivate(ctx.extensionId)) throw new ApiError(INCOGNITO_ERROR)
    return settingResult(
      this.forSetting(spec),
      this.browserValue(spec),
      ctx.extensionId,
      incognito,
      this.ranker()
    )
  }

  private set(ctx: ApiContext, object: unknown, setting: unknown, details: unknown): void {
    const spec = this.settingFor(ctx, object, setting)
    const { value, scope } = wrap(() => normalizeSetDetails(spec, details))
    if (isIncognitoScope(scope) && !this.allowedInPrivate(ctx.extensionId)) {
      throw new ApiError(INCOGNITO_ERROR)
    }
    if (scope === 'incognito_session_only' && !this.privateWindowOpen()) {
      throw new ApiError(INCOGNITO_SCOPE_ERROR)
    }
    const byExtension = this.forSetting(spec)
    const own = byExtension.get(ctx.extensionId) ?? {}
    if (!withValue(own, scope, value)) return
    byExtension.set(ctx.extensionId, own)
    this.persist(ctx.extensionId)
    this.recompute()
  }

  private clear(ctx: ApiContext, object: unknown, setting: unknown, details: unknown): void {
    const spec = this.settingFor(ctx, object, setting)
    const { scope } = wrap(() => normalizeClearDetails(details))
    if (isIncognitoScope(scope) && !this.allowedInPrivate(ctx.extensionId)) {
      throw new ApiError(INCOGNITO_ERROR)
    }
    const byExtension = this.forSetting(spec)
    const own = byExtension.get(ctx.extensionId)
    if (!own || !withoutValue(own, scope)) return
    if (!hasValues(own)) byExtension.delete(ctx.extensionId)
    this.persist(ctx.extensionId)
    this.recompute()
  }

  private settingFor(ctx: ApiContext, object: unknown, setting: unknown): PrivacySettingSpec {
    if (!this.hasPermission(ctx.extensionId)) throw new ApiError(PRIVACY_PERMISSION_ERROR)
    const spec = privacySetting(object, setting)
    if (!spec) throw new ApiError(`Unknown privacy setting ${String(object)}.${String(setting)}.`)
    return spec
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  private hasPermission(extensionId: string): boolean {
    return this.host.grants(extensionId).permissions.includes(PERMISSION)
  }

  private allowedInPrivate(extensionId: string): boolean {
    return this.host.partitionsOf(extensionId).includes(PRIVATE_CONTAINER_ID)
  }

  private privateWindowOpen(): boolean {
    return this.host.browser.allWindows().some((win) => win.isPrivate)
  }

  /** Chrome's precedence: installed most recently first, among the loaded extensions. */
  private ranker(): PrivacyRank {
    const order = this.host.browser.extensions
      .list()
      .filter((info) => this.host.loaded(info.id) !== undefined)
      .sort((a, b) => b.installedAt - a.installedAt)
      .map((info) => info.id)
    const ranks = new Map(order.map((id, index) => [id, index]))
    return (extensionId, incognito) => {
      const rank = ranks.get(extensionId)
      if (rank === undefined) return undefined
      if (incognito && !this.allowedInPrivate(extensionId)) return undefined
      return rank
    }
  }

  private browserValue(spec: PrivacySettingSpec): PrivacyValue {
    if (settingKey(spec.category, spec.name) === PASSWORD_SAVING) {
      return this.host.browser.state.settings.passwords.offerToSave
    }
    return spec.browserDefault
  }

  private forSetting(spec: PrivacySettingSpec): Map<string, ScopedValues> {
    const key = settingKey(spec.category, spec.name)
    let byExtension = this.values.get(key)
    if (!byExtension) {
      byExtension = new Map()
      this.values.set(key, byExtension)
    }
    return byExtension
  }

  private persist(extensionId: string): void {
    const out: Record<string, ScopedValues> = {}
    for (const [key, byExtension] of this.values) {
      const own = byExtension.get(extensionId)
      if (!own) continue
      const kept = persistedValues(own)
      if (hasValues(kept)) out[key] = kept
    }
    this.host.store.setPrivacyValues(extensionId, out)
  }

  /**
   * Resolve every setting for both kinds of window; a value that changed is applied and, as in
   * Chrome, reported through `onChange` to every extension holding the permission (the ones
   * allowed in private windows for a private-window change), each with its own level of control.
   */
  private recompute(): void {
    const rank = this.ranker()
    for (const spec of PRIVACY_SETTINGS) {
      const key = settingKey(spec.category, spec.name)
      const values = this.forSetting(spec)
      const browserValue = this.browserValue(spec)
      for (const incognito of [false, true]) {
        const next = effectiveSetting(values, browserValue, incognito, rank)
        const prev = this.effective.get(effectiveKey(key, incognito))
        if (prev && sameEffective(prev, next)) continue
        this.effective.set(effectiveKey(key, incognito), next)
        if (spec.effect === 'webRtc') this.applyWebRtc(next.value, incognito)
        if (!prev) continue
        const details: SettingResult = {
          value: next.value,
          levelOfControl: 'controllable_by_this_extension'
        }
        if (incognito) details.incognitoSpecific = incognitoSpecific(values, rank)
        for (const ext of this.host.allLoaded()) {
          if (!this.hasPermission(ext.id)) continue
          if (incognito && !this.allowedInPrivate(ext.id)) continue
          this.host.dispatch(ext.id, 'privacy', `${key}.onChange`, [
            { ...details, levelOfControl: levelOfControlFor(next.controller, ext.id) }
          ])
        }
      }
    }
    this.refreshRequestHooks()
  }

  // ---------------------------------------------------------------------------
  // Enforcement
  // ---------------------------------------------------------------------------

  private applyWebRtc(value: PrivacyValue, incognito: boolean): void {
    if (!isWebRtcIpHandlingPolicy(value)) return
    for (const [page, isIncognito] of this.pages) {
      if (page.isDestroyed()) {
        this.pages.delete(page)
        continue
      }
      if (isIncognito === incognito) applyWebRtc(page, value)
    }
  }

  /** Whether any request setting differs from the browser's own value somewhere. */
  private requestHooksNeeded(): boolean {
    for (const spec of PRIVACY_SETTINGS) {
      if (spec.effect !== 'request') continue
      const key = settingKey(spec.category, spec.name)
      for (const incognito of [false, true]) {
        const value = this.effective.get(effectiveKey(key, incognito))?.value
        if (value !== undefined && value !== spec.browserDefault) return true
      }
    }
    return false
  }

  /** The request hooks exist only while some request setting is controlled: the pipeline stays lean. */
  private refreshRequestHooks(): void {
    if (!this.listenerHost) return
    const needed = this.requestHooksNeeded()
    if (needed === this.requestHooks.length > 0) return
    if (!needed) {
      for (const off of this.requestHooks) off()
      this.requestHooks = []
      return
    }
    const options = {
      registrant: PRIVACY_REGISTRANT,
      priority: Number.MAX_SAFE_INTEGER,
      blocking: true
    }
    this.requestHooks = [
      this.listenerHost.addListener(
        'onBeforeRequest',
        (details) => this.beforeRequest(details),
        options
      ),
      this.listenerHost.addListener(
        'onBeforeSendHeaders',
        (details) => this.beforeSendHeaders(details),
        options
      )
    ]
  }

  private requestSetting(key: string, details: WebRequestDetails): PrivacyValue | undefined {
    return this.effective.get(effectiveKey(key, details.partition === PRIVATE_CONTAINER_ID))?.value
  }

  /** Hyperlink auditing off: the `<a ping>` requests never leave. */
  private beforeRequest(details: WebRequestDetails): BlockingResponse | undefined {
    if (details.resourceType !== 'ping') return undefined
    return this.requestSetting(HYPERLINK_AUDITING, details) === false ? { cancel: true } : undefined
  }

  /** Referrers off drops `Referer`; Do Not Track on adds `DNT: 1`. */
  private beforeSendHeaders(details: WebRequestDetails): BlockingResponse | undefined {
    const headers = details.requestHeaders
    if (!headers) return undefined
    let changed = false
    const out: Record<string, string> = { ...headers }
    if (this.requestSetting(REFERRERS, details) === false) {
      for (const name of Object.keys(out)) {
        if (name.toLowerCase() === 'referer') {
          delete out[name]
          changed = true
        }
      }
    }
    if (this.requestSetting(DO_NOT_TRACK, details) === true) {
      const existing = Object.keys(out).find((name) => name.toLowerCase() === 'dnt')
      if (existing === undefined || out[existing] !== '1') {
        if (existing !== undefined) delete out[existing]
        out.DNT = '1'
        changed = true
      }
    }
    return changed ? { requestHeaders: out } : undefined
  }
}

function effectiveKey(key: string, incognito: boolean): string {
  return incognito ? `${key}:private` : key
}

function applyWebRtc(page: PrivacyPage, policy: WebRtcIpHandlingPolicy): void {
  try {
    page.setWebRTCIPHandlingPolicy(policy)
  } catch {
    /* the page went away */
  }
}

/** Argument errors from the pure normalizers become API errors (Chrome's messages). */
function wrap<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : String(error))
  }
}
