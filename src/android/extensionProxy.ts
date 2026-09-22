/**
 * `chrome.proxy.settings` on the phone: Chrome's `types.ChromeSetting` over the one proxy
 * override the WebView takes per app process (`androidx.webkit.ProxyController`).
 *
 * The setting's value is a `ProxyConfig` (`direct`, `auto_detect`, `pac_script`,
 * `fixed_servers`, `system`). Every extension holding `proxy` may set it; the values are kept
 * per extension and scope (persisted but for the session-only private scope, as Chrome's
 * `ExtensionPrefs` keep them) and resolve per Chrome's precedence (the most recently installed
 * enabled extension wins) to one configuration, applied through Kotlin's `ProxyController`
 * (`ext.proxy.set` / `ext.proxy.clear`) as it changes and again when the process comes back
 * (the override is the process's, not persisted by the WebView). The browser's own value is
 * the system's settings.
 *
 * What the WebView applies: fixed rules (one proxy for every scheme, or one for `http` and one
 * for `https`, with a fallback, as Chrome's `ProxyRules` name them; `proxyForFtp` has nothing to
 * apply to), a bypass list with Chrome's `<local>` and `<-loopback>` tokens, and `direct`. It
 * applies no PAC script and no auto-detect: a `set` of `pac_script` or `auto_detect` fails with
 * the message below, so the extension shows its connection error instead of believing it is
 * connected while the traffic goes direct (Touch VPN and 1VPN set `fixed_servers`; VeePN,
 * NordVPN and Browsec set `pac_script`). The override is one for the process, so the private
 * tabs follow the regular value; the private scopes are kept and answered per Chrome for
 * `get` and `onChange`, but no separate configuration can be applied for them.
 *
 * A configuration the WebView refuses is reported to the controlling extension as a fatal
 * `onProxyError`, and the setting stands as the extension set it (Chrome reports there the same
 * way, from the network service).
 */
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
} from '../core/extensions/api/privacy'
import {
  PROXY_PERMISSION_ERROR,
  PROXY_SETTING,
  PROXY_SETTING_CHANGE_EVENT,
  SYSTEM_PROXY_CONFIG,
  normalizeProxyConfig,
  proxyConfigOf,
  proxyConfigValue,
  type ProxyConfig,
  type ProxyErrorDetails,
  type ProxyRuleField
} from '../core/extensions/api/proxy'
import type { AttachedExtension } from './extensionApi'

export const PROXY_PERMISSION = 'proxy'

/** The `set` of a configuration the WebView has no way to apply. */
export const PROXY_NOT_APPLICABLE_ERROR =
  'The WebView applies no PAC script or auto-detect proxy configuration on Zenium for Android; only fixed servers, direct and the system settings can be set.'

/** The WebView's scheme filters (`ProxyConfig.MATCH_HTTP` / `MATCH_HTTPS` / `MATCH_ALL_SCHEMES`). */
export type WebViewSchemeFilter = 'http' | 'https' | '*'

/** One `ProxyConfig.Builder` rule: a proxy URL (`direct://` for a direct connection) and its scheme filter. */
export interface WebViewProxyRule {
  url: string
  scheme: WebViewSchemeFilter
}

/** What `ext.proxy.set` carries to `ProxyController.setProxyOverride`. */
export interface WebViewProxyOverride {
  rules: WebViewProxyRule[]
  bypass: string[]
  /** Chrome's `<local>` bypass token: `ProxyConfig.Builder.bypassSimpleHostnames()`. */
  bypassSimpleHostnames: boolean
  /** Chrome's `<-loopback>` bypass token: `ProxyConfig.Builder.removeImplicitRules()`. */
  removeImplicitRules: boolean
}

export const DIRECT_PROXY_URL = 'direct://'

const SYSTEM_VALUE = proxyConfigValue(SYSTEM_PROXY_CONFIG)

/** The scheme filter each of Chrome's rule slots stands for (`proxyForFtp` has nothing to apply to). */
const SCHEME_FILTERS: Readonly<Record<ProxyRuleField, WebViewSchemeFilter | null>> = {
  singleProxy: '*',
  proxyForHttp: 'http',
  proxyForHttps: 'https',
  proxyForFtp: null,
  fallbackProxy: '*'
}

/**
 * The WebView override a configuration stands for, or null for the system's settings (the
 * override is cleared). Rules go in Chrome's slot order; the WebView tries them in order for a
 * URL's scheme, so the fallback is last.
 */
export function webViewProxyOverride(config: ProxyConfig): WebViewProxyOverride | null {
  switch (config.mode) {
    case 'system':
      return null
    case 'direct':
      return {
        rules: [{ url: DIRECT_PROXY_URL, scheme: '*' }],
        bypass: [],
        bypassSimpleHostnames: false,
        removeImplicitRules: false
      }
    case 'fixed_servers': {
      const rules: WebViewProxyRule[] = []
      const canonical = config.rules ?? {}
      for (const field of Object.keys(SCHEME_FILTERS) as ProxyRuleField[]) {
        const server = canonical[field]
        const scheme = SCHEME_FILTERS[field]
        if (!server || scheme === null) continue
        const port = server.port !== undefined ? `:${server.port}` : ''
        rules.push({ url: `${server.scheme ?? 'http'}://${server.host}${port}`, scheme })
      }
      const override: WebViewProxyOverride = {
        rules,
        bypass: [],
        bypassSimpleHostnames: false,
        removeImplicitRules: false
      }
      for (const entry of canonical.bypassList ?? []) {
        if (entry === '<local>') override.bypassSimpleHostnames = true
        else if (entry === '<-loopback>') override.removeImplicitRules = true
        else override.bypass.push(entry)
      }
      return override
    }
    default:
      // `pac_script` and `auto_detect` never get this far: `set` refuses them.
      return null
  }
}

export interface ProxyHost {
  attached(id: string): AttachedExtension | undefined
  allAttached(): AttachedExtension[]
  /** Whether the user allowed the extension in private tabs (`allowPrivate`). */
  allowedInPrivate(id: string): boolean
  /** Whether a private tab is open (Chrome's `incognito_session_only` needs an incognito window). */
  privateTabOpen(): boolean
  persistedValues(id: string): unknown
  persistValues(id: string, values: ScopedValues): void
  /** Apply the configuration to the process's WebViews (`system` clears the override); rejects when the WebView refuses it. */
  apply(config: ProxyConfig): Promise<void>
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void
  warn(message: string): void
}

/** `proxy.settings.get`'s answer and `onChange`'s argument. */
interface ProxySettingResult {
  value: ProxyConfig
  levelOfControl: LevelOfControl
  incognitoSpecific?: boolean
}

export class AndroidProxy {
  /** By extension id. */
  private readonly values = new Map<string, ScopedValues>()
  /** The resolved value for regular (`false`) and private (`true`) tabs. */
  private readonly effective = new Map<boolean, EffectiveSetting>()

  constructor(private readonly host: ProxyHost) {}

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  /** The extension attached: its persisted value applies again (and the override comes back after a process restart). */
  load(ext: AttachedExtension): void {
    this.values.delete(ext.record.id)
    if (this.hasPermission(ext)) {
      const stored = normalizeStored(this.host.persistedValues(ext.record.id))
      if (hasValues(stored)) this.values.set(ext.record.id, stored)
    }
    this.recompute()
  }

  /** Disabled or detached: its value stops applying (the store keeps it). */
  unload(extensionId: string): void {
    this.values.delete(extensionId)
    this.recompute()
  }

  /** Uninstalled: the value goes with it. */
  forget(extensionId: string): void {
    this.unload(extensionId)
    this.host.persistValues(extensionId, {})
  }

  /** The configuration the WebView applies (diagnostics, tests). */
  effectiveConfig(): ProxyConfig {
    return proxyConfigOf(this.effective.get(false)?.value ?? SYSTEM_VALUE)
  }

  /** The extension whose configuration applies, if any. */
  controller(): string | null {
    return this.effective.get(false)?.controller ?? null
  }

  // ---------------------------------------------------------------------------
  // The calls: `chrome.proxy.<method>(setting, details)` as the shim routes a ChromeSetting
  // ---------------------------------------------------------------------------

  call(ext: AttachedExtension, method: string, args: readonly unknown[]): unknown {
    const [setting, details] = args
    if (!this.hasPermission(ext)) throw new Error(PROXY_PERMISSION_ERROR)
    if (setting !== PROXY_SETTING) throw new Error(`Unknown proxy setting ${String(setting)}.`)
    switch (method) {
      case 'get':
        return this.get(ext, details)
      case 'set':
        return this.set(ext, details)
      case 'clear':
        return this.clear(ext, details)
      default:
        throw new Error(`chrome.proxy.settings.${method} is not implemented on Zenium for Android`)
    }
  }

  private get(ext: AttachedExtension, details: unknown): ProxySettingResult {
    const { incognito } = normalizeGetDetails(details)
    if (incognito && !this.host.allowedInPrivate(ext.record.id)) throw new Error(INCOGNITO_ERROR)
    const result = settingResult(this.values, SYSTEM_VALUE, ext.record.id, incognito, this.rank())
    return { ...result, value: proxyConfigOf(result.value) }
  }

  private set(ext: AttachedExtension, details: unknown): void {
    const { value: raw, scope } = normalizeSetScope(details)
    const config = normalizeProxyConfig(raw)
    if (isIncognitoScope(scope) && !this.host.allowedInPrivate(ext.record.id))
      throw new Error(INCOGNITO_ERROR)
    if (scope === 'incognito_session_only' && !this.host.privateTabOpen())
      throw new Error(INCOGNITO_SCOPE_ERROR)
    // Chrome's checks passed; the WebView's come next, before anything is stored: a PAC or an
    // auto-detect configuration would stand as set while the traffic went direct.
    if (config.mode === 'pac_script' || config.mode === 'auto_detect')
      throw new Error(PROXY_NOT_APPLICABLE_ERROR)
    const own = this.values.get(ext.record.id) ?? {}
    if (!withValue(own, scope, proxyConfigValue(config))) return
    this.values.set(ext.record.id, own)
    this.persist(ext.record.id)
    this.recompute()
  }

  private clear(ext: AttachedExtension, details: unknown): void {
    const { scope } = normalizeClearDetails(details)
    if (isIncognitoScope(scope) && !this.host.allowedInPrivate(ext.record.id))
      throw new Error(INCOGNITO_ERROR)
    const own = this.values.get(ext.record.id)
    if (!own || !withoutValue(own, scope)) return
    if (!hasValues(own)) this.values.delete(ext.record.id)
    this.persist(ext.record.id)
    this.recompute()
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  private hasPermission(ext: AttachedExtension): boolean {
    return (
      ext.manifest.permissions.includes(PROXY_PERMISSION) ||
      ext.manifest.optionalPermissions.includes(PROXY_PERMISSION)
    )
  }

  /** Chrome's precedence: the most recently installed extension ranks first. */
  private rank(): PrivacyRank {
    const order = [...this.host.allAttached()]
      .sort((a, b) => b.record.installedAt - a.record.installedAt)
      .map((ext) => ext.record.id)
    const ranks = new Map(order.map((id, index) => [id, index]))
    return (extensionId, incognito) => {
      const rank = ranks.get(extensionId)
      if (rank === undefined) return undefined
      if (incognito && !this.host.allowedInPrivate(extensionId)) return undefined
      return rank
    }
  }

  private persist(extensionId: string): void {
    const own = this.values.get(extensionId)
    const kept = own ? persistedValues(own) : {}
    this.host.persistValues(extensionId, hasValues(kept) ? kept : {})
  }

  /**
   * Resolve the setting for regular and private tabs; the regular configuration that changed
   * goes to the WebView and, as in Chrome, every extension holding the permission hears of a
   * change through `onChange` (the ones allowed in private tabs for a private change), each
   * with its own level of control.
   */
  private recompute(): void {
    const rank = this.rank()
    for (const incognito of [false, true]) {
      const next = effectiveSetting(this.values, SYSTEM_VALUE, incognito, rank)
      const prev = this.effective.get(incognito)
      if (prev && sameEffective(prev, next)) continue
      this.effective.set(incognito, next)
      // The first resolution that stays at the system's settings changes nothing.
      if (!prev && next.value === SYSTEM_VALUE) continue
      if (!incognito) this.applyTo(next)
      if (!prev) continue
      const details: ProxySettingResult = {
        value: proxyConfigOf(next.value),
        levelOfControl: 'controllable_by_this_extension'
      }
      if (incognito) details.incognitoSpecific = incognitoSpecific(this.values, rank)
      for (const ext of this.host.allAttached()) {
        if (!this.hasPermission(ext)) continue
        if (incognito && !this.host.allowedInPrivate(ext.record.id)) continue
        this.host.emit(ext.record.id, 'proxy', PROXY_SETTING_CHANGE_EVENT, [
          { ...details, levelOfControl: levelOfControlFor(next.controller, ext.record.id) }
        ])
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Enforcement
  // ---------------------------------------------------------------------------

  private applyTo(setting: EffectiveSetting): void {
    let applying: Promise<void>
    try {
      applying = this.host.apply(proxyConfigOf(setting.value))
    } catch (error) {
      this.refused(setting.controller, error)
      return
    }
    applying.catch((error: unknown) => this.refused(setting.controller, error))
  }

  /** The WebView would not take the configuration: the extension that set it hears about it. */
  private refused(controller: string | null, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.host.warn(`proxy: the WebView refused the extension's configuration: ${message}`)
    if (controller === null || !this.host.attached(controller)) return
    const details: ProxyErrorDetails = {
      fatal: true,
      error: 'net::ERR_PROXY_CONFIGURATION_INVALID',
      details: message
    }
    this.host.emit(controller, 'proxy', 'onProxyError', [details])
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
