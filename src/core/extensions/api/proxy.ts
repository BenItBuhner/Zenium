/**
 * `chrome.proxy` without the engine: the `ProxyConfig` an extension gives `proxy.settings.set`
 * (a `types.ChromeSetting`), checked and canonicalised the way Chrome's `ProxyPrefTransformer`
 * turns it into the browser's proxy preference and back for `get`, and the session
 * configuration the browser applies from it (Chromium's proxy rules string, the PAC URL). The
 * setting's precedence between extensions and scopes is `privacy.ts`'s (Chrome keeps both in
 * one `ExtensionPrefValueMap`): a canonical config travels through those functions as its JSON
 * text. The host owns persistence and the sessions; everything here is pure.
 */

export const PROXY_MODES = [
  'direct',
  'auto_detect',
  'pac_script',
  'fixed_servers',
  'system'
] as const

export type ProxyMode = (typeof PROXY_MODES)[number]

export const PROXY_SCHEMES = ['http', 'https', 'quic', 'socks4', 'socks5'] as const

export type ProxyScheme = (typeof PROXY_SCHEMES)[number]

export interface ProxyServer {
  scheme?: ProxyScheme
  host: string
  port?: number
}

/** The five rule slots of `ProxyRules`, in Chrome's order (`singleProxy` excludes the rest). */
export const PROXY_RULE_FIELDS = [
  'singleProxy',
  'proxyForHttp',
  'proxyForHttps',
  'proxyForFtp',
  'fallbackProxy'
] as const

export type ProxyRuleField = (typeof PROXY_RULE_FIELDS)[number]

export type ProxyRules = Partial<Record<ProxyRuleField, ProxyServer>> & { bypassList?: string[] }

export interface PacScript {
  url?: string
  data?: string
  mandatory?: boolean
}

export interface ProxyConfig {
  mode: ProxyMode
  rules?: ProxyRules
  pacScript?: PacScript
}

/**
 * The browser's own value while no extension controls the proxy: the system's settings (the
 * default `ProxyConfigDictionary`, and Electron's default for a session).
 */
export const SYSTEM_PROXY_CONFIG: ProxyConfig = { mode: 'system' }

export const PROXY_PERMISSION_ERROR =
  "You do not have permission to access the preference 'proxy'. Be sure to declare the 'proxy' permission in your manifest."

/** Chrome's `chrome.proxy.onProxyError` details. */
export interface ProxyErrorDetails {
  fatal: boolean
  error: string
  details: string
}

/** The setting's name under `chrome.proxy`, and the one `onChange` fires under. */
export const PROXY_SETTING = 'settings'

/** `proxy.settings.onChange`'s event name as the host dispatches it. */
export const PROXY_SETTING_CHANGE_EVENT = `${PROXY_SETTING}.onChange`

const PAC_DATA_URL_PREFIX = 'data:application/x-ns-proxy-autoconfig;base64,'

/** `net::ProxyServer::GetDefaultPortForScheme`. */
const DEFAULT_PORTS: Readonly<Record<ProxyScheme, number>> = {
  http: 80,
  https: 443,
  quic: 443,
  socks4: 1080,
  socks5: 1080
}

/** The key of each slot in Chromium's proxy rules string (`socks=` is the fallback proxy). */
const RULE_KEYS: Readonly<Record<Exclude<ProxyRuleField, 'singleProxy'>, string>> = {
  proxyForHttp: 'http',
  proxyForHttps: 'https',
  proxyForFtp: 'ftp',
  fallbackProxy: 'socks'
}

export function isProxyMode(value: unknown): value is ProxyMode {
  return typeof value === 'string' && (PROXY_MODES as readonly string[]).includes(value)
}

export function isProxyScheme(value: unknown): value is ProxyScheme {
  return typeof value === 'string' && (PROXY_SCHEMES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Validation: Chrome's binding checks (the schema) and `ProxyPrefTransformer::ExtensionToBrowserPref`
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAscii(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(text)
}

function schemaError(property: string, problem: string): Error {
  return new Error(`Invalid value for argument 1. Property '${property}': ${problem}`)
}

function expectedType(property: string, expected: string, value: unknown): Error {
  const found = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  return schemaError(property, `Invalid type: expected ${expected}, found ${found}.`)
}

/** A slot's server: `host` is required and ASCII, `scheme` defaults to http, `port` to the scheme's. */
function normalizeServer(
  raw: unknown,
  field: ProxyRuleField
): { scheme: ProxyScheme; host: string; port: number } {
  const property = `value.rules.${field}`
  if (!isRecord(raw)) throw expectedType(property, 'object', raw)
  if (!('host' in raw)) throw schemaError(`${property}.host`, 'Property is required.')
  if (typeof raw.host !== 'string') throw expectedType(`${property}.host`, 'string', raw.host)
  if (!isAscii(raw.host)) {
    throw new Error(
      `Invalid 'rules.???.host' entry '${raw.host}'. 'host' field supports only ASCII URLs (encode URLs in Punycode format).`
    )
  }
  let scheme: ProxyScheme = 'http'
  if (raw.scheme !== undefined) {
    if (!isProxyScheme(raw.scheme)) {
      throw schemaError(`${property}.scheme`, `Value must be one of ${PROXY_SCHEMES.join(', ')}.`)
    }
    scheme = raw.scheme
  }
  let port = DEFAULT_PORTS[scheme]
  if (raw.port !== undefined) {
    if (typeof raw.port !== 'number' || !Number.isInteger(raw.port)) {
      throw expectedType(`${property}.port`, 'integer', raw.port)
    }
    port = raw.port
  }
  return { scheme, host: raw.host, port }
}

/** `HostPortPair::ToString`: an IPv6 literal is bracketed. */
function hostPort(host: string, port: number): string {
  const literal = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${literal}:${port}`
}

/** `ProxyServerToProxyUri`: the http scheme is implied, the others spelled out. */
function proxyUri(server: { scheme: ProxyScheme; host: string; port: number }): string {
  const authority = hostPort(server.host, server.port)
  return server.scheme === 'http' ? authority : `${server.scheme}://${authority}`
}

interface NormalizedRules {
  /** Chromium's rules string: `host:port` for `singleProxy`, `http=…;https=…;ftp=…;socks=…` otherwise. */
  proxyRules: string
  /** The bypass list, comma-joined (`ProxyConfigDictionary`'s form). */
  bypassList: string
  /** The rules as `get` reports them: every server with scheme, host and port, `bypassList` always. */
  canonical: ProxyRules
}

/**
 * `GetProxyRulesStringFromExtensionPref` and `GetBypassListFromExtensionPref`, then the way
 * Chromium reads the string back (`ProxyRules::ParseFromString`): a `fallbackProxy` without an
 * explicit scheme is written as `socks=host:port`, which parses as SOCKS4, and that is what
 * Chrome both uses and reports.
 */
function normalizeRules(raw: unknown): NormalizedRules | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw expectedType('value.rules', 'object', raw)
  const servers = new Map<ProxyRuleField, { scheme: ProxyScheme; host: string; port: number }>()
  for (const field of PROXY_RULE_FIELDS) {
    if (raw[field] === undefined) continue
    servers.set(field, normalizeServer(raw[field], field))
  }
  const single = servers.get('singleProxy')
  if (single) {
    for (const field of PROXY_RULE_FIELDS) {
      if (field !== 'singleProxy' && servers.has(field)) {
        throw new Error(`Proxy rule for singleProxy and ${field} cannot be set at the same time.`)
      }
    }
  }
  const canonical: ProxyRules = {}
  const parts: string[] = []
  for (const [field, server] of servers) {
    if (field === 'singleProxy') {
      parts.push(proxyUri(server))
      canonical[field] = { ...server }
      continue
    }
    parts.push(`${RULE_KEYS[field]}=${proxyUri(server)}`)
    canonical[field] =
      field === 'fallbackProxy' && server.scheme === 'http'
        ? { ...server, scheme: 'socks4' }
        : { ...server }
  }
  const bypass = raw.bypassList
  const entries: string[] = []
  if (bypass !== undefined) {
    if (!Array.isArray(bypass)) throw expectedType('value.rules.bypassList', 'array', bypass)
    bypass.forEach((entry, index) => {
      if (typeof entry !== 'string') {
        throw expectedType(`value.rules.bypassList[${index}]`, 'string', entry)
      }
      if (!isAscii(entry)) throw new Error("'rules.bypassList' could not be parsed.")
      const trimmed = entry.trim()
      if (trimmed !== '') entries.push(trimmed)
    })
  }
  canonical.bypassList = entries
  return { proxyRules: parts.join(';'), bypassList: entries.join(','), canonical }
}

interface NormalizedPac {
  /** The URL the sessions fetch: the given one, or a `data:` URL carrying the inline script. */
  url: string
  mandatory: boolean
  canonical: PacScript
}

function normalizePac(raw: unknown): NormalizedPac | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw expectedType('value.pacScript', 'object', raw)
  let mandatory = false
  if (raw.mandatory !== undefined) {
    if (typeof raw.mandatory !== 'boolean') {
      throw expectedType('value.pacScript.mandatory', 'boolean', raw.mandatory)
    }
    mandatory = raw.mandatory
  }
  let url = ''
  if (raw.url !== undefined) {
    if (typeof raw.url !== 'string') throw expectedType('value.pacScript.url', 'string', raw.url)
    if (!isAscii(raw.url)) {
      throw new Error("'pacScript.url' supports only ASCII URLs (encode URLs in Punycode format).")
    }
    url = raw.url
  }
  let data = ''
  if (raw.data !== undefined) {
    if (typeof raw.data !== 'string') throw expectedType('value.pacScript.data', 'string', raw.data)
    data = raw.data
  }
  if (url !== '') return { url, mandatory, canonical: { url, mandatory } }
  if (data !== '') return { url: pacDataUrl(data), mandatory, canonical: { data, mandatory } }
  return undefined
}

/** `CreateDataURLFromPACScript`: the script's UTF-8 bytes, base64. */
export function pacDataUrl(script: string): string {
  const bytes = new TextEncoder().encode(script)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return PAC_DATA_URL_PREFIX + btoa(binary)
}

/** The inline script of a PAC `data:` URL `pacDataUrl` made, or undefined for any other URL. */
export function pacScriptOfDataUrl(url: string): string | undefined {
  if (!url.startsWith(PAC_DATA_URL_PREFIX)) return undefined
  try {
    const binary = atob(url.slice(PAC_DATA_URL_PREFIX.length))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Check a `set` value and return the canonical config `get` reports for it afterwards:
 * `ProxyPrefTransformer::ExtensionToBrowserPref` followed by `BrowserToExtensionPref`. Chrome
 * checks every field that is present, whichever mode is set, and keeps only the ones the mode
 * uses. Throws with Chrome's messages.
 */
export function normalizeProxyConfig(raw: unknown): ProxyConfig {
  if (!isRecord(raw)) throw expectedType('value', 'object', raw)
  if (!('mode' in raw)) throw schemaError('value.mode', 'Property is required.')
  if (!isProxyMode(raw.mode)) {
    throw schemaError('value.mode', `Value must be one of ${PROXY_MODES.join(', ')}.`)
  }
  const rules = normalizeRules(raw.rules)
  const pac = normalizePac(raw.pacScript)
  switch (raw.mode) {
    case 'pac_script':
      if (!pac) {
        throw new Error(
          "Proxy mode 'pac_script' requires a 'pacScript' field with either a 'url' field or a 'data' field."
        )
      }
      return { mode: 'pac_script', pacScript: pac.canonical }
    case 'fixed_servers':
      if (!rules || rules.proxyRules === '') {
        throw new Error("Proxy mode 'fixed_servers' requires a 'rules' field.")
      }
      return { mode: 'fixed_servers', rules: rules.canonical }
    default:
      return { mode: raw.mode }
  }
}

// ---------------------------------------------------------------------------
// The canonical config as a setting value, and what the sessions apply
// ---------------------------------------------------------------------------

/** A canonical config as the setting value the precedence functions carry (its JSON text). */
export function proxyConfigValue(config: ProxyConfig): string {
  return JSON.stringify(config)
}

/** The config a setting value stands for; anything unreadable is the system's settings. */
export function proxyConfigOf(value: unknown): ProxyConfig {
  if (typeof value !== 'string') return SYSTEM_PROXY_CONFIG
  try {
    const parsed: unknown = JSON.parse(value)
    return normalizeProxyConfig(parsed)
  } catch {
    return SYSTEM_PROXY_CONFIG
  }
}

/** Electron's `session.setProxy` argument. */
export interface SessionProxyConfig {
  mode: ProxyMode
  pacScript?: string
  proxyRules?: string
  proxyBypassRules?: string
}

/**
 * What a session is told for a canonical config: Chromium's own representation, so `fixed_servers`
 * rules and the bypass list read as Chrome's preference does and a `pac_script` with inline data
 * becomes the `data:` URL Chromium's PAC fetcher takes. `pacScript.mandatory` has no switch in
 * Electron: a PAC that fails to load falls back to direct connections there.
 */
export function sessionProxyConfig(config: ProxyConfig): SessionProxyConfig {
  switch (config.mode) {
    case 'pac_script': {
      const pac = config.pacScript ?? {}
      const url = pac.url ?? (pac.data !== undefined ? pacDataUrl(pac.data) : '')
      return { mode: 'pac_script', pacScript: url }
    }
    case 'fixed_servers': {
      const rules = normalizeRules(config.rules ?? {})
      return {
        mode: 'fixed_servers',
        proxyRules: rules?.proxyRules ?? '',
        proxyBypassRules: rules?.bypassList ?? ''
      }
    }
    default:
      return { mode: config.mode }
  }
}
