import { PRIVATE_CONTAINER_ID } from '../../../shared/types'
import {
  INCOGNITO_ERROR,
  INCOGNITO_SCOPE_ERROR,
  PRIVACY_SCOPES,
  effectiveSetting,
  hasValues,
  incognitoSpecific,
  isIncognitoScope,
  levelOfControlFor,
  normalizeClearDetails,
  normalizeGetDetails,
  normalizeSetScope,
  persistedValues,
  sameEffective,
  settingResult,
  withValue,
  withoutValue,
  type EffectiveSetting,
  type LevelOfControl,
  type PrivacyRank,
  type ScopedValues
} from '../../../core/extensions/api/privacy'
import {
  PROXY_PERMISSION_ERROR,
  PROXY_SETTING,
  PROXY_SETTING_CHANGE_EVENT,
  SYSTEM_PROXY_CONFIG,
  normalizeProxyConfig,
  proxyConfigOf,
  proxyConfigValue,
  sessionProxyConfig,
  type ProxyConfig,
  type ProxyErrorDetails,
  type SessionProxyConfig
} from '../../../core/extensions/api/proxy'
import { installOrderRank } from './privacy'
import { ApiError, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

/** What a proxy configuration is applied to: a session (Electron's `Session.setProxy`). */
export interface ProxySession {
  setProxy(config: SessionProxyConfig): Promise<void>
}

/** The sessions, as they come up: the private window's is created with its first window. */
export interface ProxySessionHost {
  configure(hook: (session: ProxySession, incognito: boolean) => void): void
}

/** `proxy.settings.get`'s answer and `onChange`'s argument. */
interface ProxySettingResult {
  value: ProxyConfig
  levelOfControl: LevelOfControl
  incognitoSpecific?: boolean
}

const PERMISSION = 'proxy'
const SYSTEM_VALUE = proxyConfigValue(SYSTEM_PROXY_CONFIG)

/**
 * `chrome.proxy` for the browser layer. `proxy.settings` is one `types.ChromeSetting` whose
 * value is a `ProxyConfig`: every extension holding `proxy` may set it, the values are kept per
 * extension and scope (persisted but for the session-only private-window scope) and resolve per
 * Chrome's precedence rules (the most recently installed enabled extension wins; the private
 * window follows the regular value unless a private-window value exists and the user allowed
 * the extension there) to one configuration for the normal windows' sessions and one for the
 * private window's, each applied through Electron's `setProxy` as the configuration changes and
 * to every session that comes up later. The browser's own value is the system's settings.
 *
 * A configuration a session refuses is reported to the controlling extension as a fatal
 * `onProxyError`, and the setting stands as the extension set it (Chrome reports there the same
 * way, from the network service).
 */
export class ProxyApi {
  /** By extension id. */
  private readonly values = new Map<string, ScopedValues>()
  /** The resolved value for normal (`false`) and private (`true`) windows. */
  private readonly effective = new Map<boolean, EffectiveSetting>()
  private readonly sessions = new Map<ProxySession, boolean>()

  constructor(
    private readonly host: ApiHost,
    sessions: ProxySessionHost
  ) {
    sessions.configure((session, incognito) => {
      this.sessions.set(session, incognito)
      const current = this.effective.get(incognito)
      if (current && current.value !== SYSTEM_VALUE) this.applyTo(session, current)
    })
  }

  readonly handlers: NamespaceHandlers = {
    get: (ctx, setting, details) => this.get(ctx, setting, details),
    set: (ctx, setting, details) => this.set(ctx, setting, details),
    clear: (ctx, setting, details) => this.clear(ctx, setting, details)
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /** An extension was loaded: its persisted value applies again. */
  load(extensionId: string): void {
    this.values.delete(extensionId)
    if (this.hasPermission(extensionId)) {
      const stored = normalizeStored(this.host.store.proxyValues(extensionId))
      if (hasValues(stored)) this.values.set(extensionId, stored)
    }
    this.recompute()
  }

  /** Disabled or gone from every session: its value stops applying (the store keeps it). */
  unload(extensionId: string): void {
    this.values.delete(extensionId)
    this.recompute()
  }

  /** Uninstalled: the value goes with it. */
  forget(extensionId: string): void {
    this.unload(extensionId)
    this.host.store.setProxyValues(extensionId, {})
  }

  /** A newer install ranks above the older extensions' values. */
  installOrderChanged(): void {
    this.recompute()
  }

  /** The user allowed an extension in private windows, or withdrew that. */
  privateAccessChanged(): void {
    this.recompute()
  }

  /** The configuration the browser applies for normal or private windows (diagnostics, tests). */
  effectiveConfig(incognito: boolean): ProxyConfig {
    return proxyConfigOf(this.effective.get(incognito)?.value ?? SYSTEM_VALUE)
  }

  /** The extension whose configuration applies for normal or private windows, if any. */
  controller(incognito: boolean): string | null {
    return this.effective.get(incognito)?.controller ?? null
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private get(ctx: ApiContext, setting: unknown, details: unknown): ProxySettingResult {
    this.check(ctx, setting)
    const { incognito } = wrap(() => normalizeGetDetails(details))
    if (incognito && !this.allowedInPrivate(ctx.extensionId)) throw new ApiError(INCOGNITO_ERROR)
    const result = settingResult(
      this.values,
      SYSTEM_VALUE,
      ctx.extensionId,
      incognito,
      this.ranker()
    )
    return { ...result, value: proxyConfigOf(result.value) }
  }

  private set(ctx: ApiContext, setting: unknown, details: unknown): void {
    this.check(ctx, setting)
    const { value: raw, scope } = wrap(() => normalizeSetScope(details))
    const value = proxyConfigValue(wrap(() => normalizeProxyConfig(raw)))
    if (isIncognitoScope(scope) && !this.allowedInPrivate(ctx.extensionId)) {
      throw new ApiError(INCOGNITO_ERROR)
    }
    if (scope === 'incognito_session_only' && !this.privateWindowOpen()) {
      throw new ApiError(INCOGNITO_SCOPE_ERROR)
    }
    const own = this.values.get(ctx.extensionId) ?? {}
    if (!withValue(own, scope, value)) return
    this.values.set(ctx.extensionId, own)
    this.persist(ctx.extensionId)
    this.recompute()
  }

  private clear(ctx: ApiContext, setting: unknown, details: unknown): void {
    this.check(ctx, setting)
    const { scope } = wrap(() => normalizeClearDetails(details))
    if (isIncognitoScope(scope) && !this.allowedInPrivate(ctx.extensionId)) {
      throw new ApiError(INCOGNITO_ERROR)
    }
    const own = this.values.get(ctx.extensionId)
    if (!own || !withoutValue(own, scope)) return
    if (!hasValues(own)) this.values.delete(ctx.extensionId)
    this.persist(ctx.extensionId)
    this.recompute()
  }

  private check(ctx: ApiContext, setting: unknown): void {
    if (!this.hasPermission(ctx.extensionId)) throw new ApiError(PROXY_PERMISSION_ERROR)
    if (setting !== PROXY_SETTING) throw new ApiError(`Unknown proxy setting ${String(setting)}.`)
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

  private ranker(): PrivacyRank {
    return installOrderRank(this.host, (id) => this.allowedInPrivate(id))
  }

  private persist(extensionId: string): void {
    const own = this.values.get(extensionId)
    const kept = own ? persistedValues(own) : {}
    this.host.store.setProxyValues(extensionId, hasValues(kept) ? kept : {})
  }

  /**
   * Resolve the setting for both kinds of window; a configuration that changed goes to the
   * sessions of that kind and, as in Chrome, to every extension holding the permission through
   * `onChange` (the ones allowed in private windows for a private-window change), each with its
   * own level of control.
   */
  private recompute(): void {
    const rank = this.ranker()
    for (const incognito of [false, true]) {
      const next = effectiveSetting(this.values, SYSTEM_VALUE, incognito, rank)
      const prev = this.effective.get(incognito)
      if (prev && sameEffective(prev, next)) continue
      this.effective.set(incognito, next)
      // The first resolution of a session kind that stays at the system's settings changes nothing.
      if (!prev && next.value === SYSTEM_VALUE) continue
      for (const [session, isIncognito] of this.sessions) {
        if (isIncognito === incognito) this.applyTo(session, next)
      }
      if (!prev) continue
      const details: ProxySettingResult = {
        value: proxyConfigOf(next.value),
        levelOfControl: 'controllable_by_this_extension'
      }
      if (incognito) details.incognitoSpecific = incognitoSpecific(this.values, rank)
      for (const ext of this.host.allLoaded()) {
        if (!this.hasPermission(ext.id)) continue
        if (incognito && !this.allowedInPrivate(ext.id)) continue
        this.host.dispatch(ext.id, 'proxy', PROXY_SETTING_CHANGE_EVENT, [
          { ...details, levelOfControl: levelOfControlFor(next.controller, ext.id) }
        ])
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Enforcement
  // ---------------------------------------------------------------------------

  private applyTo(session: ProxySession, setting: EffectiveSetting): void {
    const config = sessionProxyConfig(proxyConfigOf(setting.value))
    let applying: Promise<void>
    try {
      applying = session.setProxy(config)
    } catch (error) {
      this.refused(setting.controller, error)
      return
    }
    applying.catch((error: unknown) => this.refused(setting.controller, error))
  }

  /** The session would not take the configuration: the extension that set it hears about it. */
  private refused(controller: string | null, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[zen] proxy: the session refused the extension's configuration: ${message}`)
    if (controller === null || !this.host.loaded(controller)) return
    const details: ProxyErrorDetails = {
      fatal: true,
      error: 'net::ERR_PROXY_CONFIGURATION_INVALID',
      details: message
    }
    this.host.dispatch(controller, 'proxy', 'onProxyError', [details])
  }
}

/** Read an extension's entry back from persistence, keeping only readable configurations. */
function normalizeStored(raw: unknown): ScopedValues {
  const out: ScopedValues = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const entry = raw as Record<string, unknown>
  for (const scope of PRIVACY_SCOPES) {
    if (scope === 'incognito_session_only') continue
    const value = entry[scope]
    if (typeof value !== 'string') continue
    try {
      out[scope] = proxyConfigValue(normalizeProxyConfig(JSON.parse(value)))
    } catch {
      /* an unreadable configuration is dropped */
    }
  }
  return out
}

/** Argument errors from the pure normalizers become API errors (Chrome's messages). */
function wrap<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : String(error))
  }
}
