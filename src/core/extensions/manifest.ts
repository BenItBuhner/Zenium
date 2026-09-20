/**
 * Chrome extension manifests (MV2 and MV3): a typed model, a validator that mirrors the checks
 * Chrome performs at load time, `__MSG_name__` localisation with Chrome's locale fallback order,
 * and Chrome's version-string rules. Self-contained on purpose so other extension modules can
 * depend on it without pulling anything else in.
 */
import { base64Decode } from './bytes'

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type ManifestVersion = 2 | 3

export type ManifestIcons = Record<string, string>

export interface ManifestAction {
  default_icon?: string | Record<string, string>
  default_title?: string
  default_popup?: string
}

export interface ManifestBackground {
  /** MV2 event/background pages. */
  scripts?: string[]
  page?: string
  persistent?: boolean
  /** MV3 service worker. */
  service_worker?: string
  type?: 'classic' | 'module'
}

export type ManifestRunAt = 'document_start' | 'document_end' | 'document_idle'

export interface ManifestContentScript {
  matches: string[]
  exclude_matches?: string[]
  js?: string[]
  css?: string[]
  run_at?: ManifestRunAt
  all_frames?: boolean
  match_about_blank?: boolean
  match_origin_as_fallback?: boolean
  include_globs?: string[]
  exclude_globs?: string[]
  world?: 'ISOLATED' | 'MAIN'
}

export interface ManifestOptionsUi {
  page: string
  open_in_tab?: boolean
}

export interface ManifestWebAccessibleResourceMv3 {
  resources: string[]
  matches?: string[]
  extension_ids?: string[]
  use_dynamic_url?: boolean
}

export type ManifestWebAccessibleResources = string[] | ManifestWebAccessibleResourceMv3[]

export interface ManifestRuleResource {
  id: string
  enabled: boolean
  path: string
}

export interface ManifestDeclarativeNetRequest {
  rule_resources: ManifestRuleResource[]
}

export type ManifestCommandPlatform = 'default' | 'windows' | 'mac' | 'chromeos' | 'linux'

export interface ManifestCommand {
  suggested_key?: string | Partial<Record<ManifestCommandPlatform, string>>
  description?: string
  global?: boolean
}

export type ManifestContentSecurityPolicy = string | { extension_pages?: string; sandbox?: string }

export type ManifestIncognito = 'spanning' | 'split' | 'not_allowed'

export interface ExtensionManifest {
  manifest_version: ManifestVersion
  name: string
  version: string
  description?: string
  short_name?: string
  version_name?: string
  author?: string | { email: string }
  icons?: ManifestIcons
  permissions?: string[]
  optional_permissions?: string[]
  host_permissions?: string[]
  optional_host_permissions?: string[]
  content_scripts?: ManifestContentScript[]
  background?: ManifestBackground
  action?: ManifestAction
  browser_action?: ManifestAction
  page_action?: ManifestAction
  options_ui?: ManifestOptionsUi
  options_page?: string
  web_accessible_resources?: ManifestWebAccessibleResources
  declarative_net_request?: ManifestDeclarativeNetRequest
  default_locale?: string
  minimum_chrome_version?: string
  update_url?: string
  key?: string
  commands?: Record<string, ManifestCommand>
  incognito?: ManifestIncognito
  content_security_policy?: ManifestContentSecurityPolicy
  homepage_url?: string
  devtools_page?: string
  omnibox?: { keyword: string }
  chrome_url_overrides?: Partial<Record<'newtab' | 'bookmarks' | 'history', string>>
  side_panel?: { default_path?: string }
  offline_enabled?: boolean
  externally_connectable?: { ids?: string[]; matches?: string[]; accepts_tls_channel_id?: boolean }
  sandbox?: { pages: string[]; content_security_policy?: string }
  storage?: { managed_schema: string }
}

/**
 * Chrome's feature system limits some API permissions to a manifest version
 * (`_permission_features.json`): `webRequestBlocking` ends with MV2 (policy-installed extensions
 * excepted, which Zenium has none of), while the MV3 APIs never existed in MV2. A manifest that
 * declares one outside its version gets an install warning and the permission is not granted, so
 * an MV3 extension probing `permissions.contains({ permissions: ['webRequestBlocking'] })` hears
 * `false` and registers its observational listener (Stylus does exactly that).
 */
const MAX_MANIFEST_VERSION: Readonly<Record<string, 2>> = { webRequestBlocking: 2 }
const MIN_MANIFEST_VERSION: Readonly<Record<string, 3>> = {
  scripting: 3,
  offscreen: 3,
  sidePanel: 3,
  userScripts: 3
}

/**
 * Chrome's install warning for a permission outside its manifest version, or `null` when the
 * permission is available to it.
 */
export function permissionVersionWarning(
  permission: string,
  manifestVersion: 2 | 3
): string | null {
  const max = MAX_MANIFEST_VERSION[permission]
  if (max !== undefined && manifestVersion > max)
    return `'${permission}' requires manifest version of ${max} or lower.`
  const min = MIN_MANIFEST_VERSION[permission]
  if (min !== undefined && manifestVersion < min)
    return `'${permission}' requires manifest version of at least ${min}.`
  return null
}

export interface ManifestIssue {
  /** Dotted path into the manifest, e.g. `background.service_worker` or `content_scripts[0].matches`. */
  path: string
  message: string
}

export interface ManifestParseResult {
  /** Present only when there are no errors. */
  manifest: ExtensionManifest | null
  /** The parsed JSON object, unknown keys included (null when the text was not a JSON object). */
  raw: Record<string, unknown> | null
  errors: ManifestIssue[]
  warnings: ManifestIssue[]
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * Chrome's `base::Version` rules: dot-separated unsigned integers, no sign, leading zeros allowed
 * except in the first component. Extensions may use at most four components.
 */
export function parseVersion(text: string, maxComponents = 4): number[] | null {
  if (typeof text !== 'string' || text.length === 0) return null
  const parts = text.split('.')
  if (parts.length > maxComponents) return null
  const components: number[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!/^[0-9]+$/.test(part)) return null
    if (i === 0 && part.length > 1 && part.startsWith('0')) return null
    const value = Number(part)
    if (value > 0xffffffff) return null
    components.push(value)
  }
  return components
}

export function isValidExtensionVersion(text: string): boolean {
  return parseVersion(text, 4) !== null
}

/**
 * Compares two version strings the way Chrome does (missing trailing components count as zero, so
 * `1.0` equals `1`). Throws when either string is not a valid version.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a, Number.POSITIVE_INFINITY)
  const right = parseVersion(b, Number.POSITIVE_INFINITY)
  if (!left) throw new Error(`Invalid version string: ${JSON.stringify(a)}`)
  if (!right) throw new Error(`Invalid version string: ${JSON.stringify(b)}`)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l < r) return -1
    if (l > r) return 1
  }
  return 0
}

/** Whether a browser at `chromiumVersion` satisfies the manifest's `minimum_chrome_version`. */
export function satisfiesMinimumChromeVersion(
  manifest: Pick<ExtensionManifest, 'minimum_chrome_version'>,
  chromiumVersion: string
): boolean {
  if (!manifest.minimum_chrome_version) return true
  return compareVersions(chromiumVersion, manifest.minimum_chrome_version) >= 0
}

// ---------------------------------------------------------------------------
// Match patterns
// ---------------------------------------------------------------------------

const MATCH_SCHEMES = new Set([
  'http',
  'https',
  'file',
  'ftp',
  'ws',
  'wss',
  'urn',
  'chrome-extension',
  'chrome',
  'data'
])

/** Chrome's match-pattern grammar: `<all_urls>` or `<scheme>://<host><path>`. */
export function isMatchPattern(pattern: string): boolean {
  if (pattern === '<all_urls>') return true
  const separator = pattern.indexOf('://')
  if (separator <= 0) {
    // `urn:` and `data:` patterns carry no authority.
    if (pattern.startsWith('urn:') || pattern.startsWith('data:')) return pattern.length > 4
    return false
  }
  const scheme = pattern.slice(0, separator)
  if (scheme !== '*' && !MATCH_SCHEMES.has(scheme)) return false
  const rest = pattern.slice(separator + 3)
  // Chromium's file grammar: the host is optional and ignored (`file://*/*`, which Adobe
  // Acrobat and MetaMask declare, and `file://localhost/x` both stand for `file:///...`), so
  // anything after `file://` is a path glob; only a bare `file://` is refused.
  if (scheme === 'file') return rest !== ''
  const slash = rest.indexOf('/')
  if (slash < 0) return false
  const host = rest.slice(0, slash)
  if (host === '') return false
  if (
    host.includes(':') &&
    !/^\[[0-9a-fA-F:.]+\](:\d+)?$/.test(host) &&
    !/^[^:]+:(\d+|\*)$/.test(host)
  ) {
    return false
  }
  const hostName = host.replace(/:(\d+|\*)$/, '')
  if (hostName !== '*' && hostName.includes('*') && !hostName.startsWith('*.')) return false
  if (hostName.slice(2).includes('*')) return false
  return true
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const KNOWN_KEYS = new Set<string>([
  'manifest_version',
  'name',
  'version',
  'description',
  'short_name',
  'version_name',
  'author',
  'icons',
  'permissions',
  'optional_permissions',
  'host_permissions',
  'optional_host_permissions',
  'content_scripts',
  'background',
  'action',
  'browser_action',
  'page_action',
  'options_ui',
  'options_page',
  'web_accessible_resources',
  'declarative_net_request',
  'default_locale',
  'minimum_chrome_version',
  'update_url',
  'key',
  'commands',
  'incognito',
  'content_security_policy',
  'homepage_url',
  'devtools_page',
  'omnibox',
  'chrome_url_overrides',
  'side_panel',
  'offline_enabled',
  'externally_connectable',
  'sandbox',
  'storage',
  // Accepted without further checks: Chrome knows them, this installer does not act on them.
  'chrome_settings_overrides',
  'cross_origin_embedder_policy',
  'cross_origin_opener_policy',
  'differential_fingerprint',
  'event_rules',
  'export',
  'file_browser_handlers',
  'file_system_provider_capabilities',
  'import',
  'input_components',
  'oauth2',
  'requirements',
  'tts_engine',
  'trial_tokens',
  'browser_specific_settings',
  'applications',
  'converted_from_user_script',
  'current_locale',
  'nacl_modules',
  'platforms',
  'replacement_web_app',
  'system_indicator',
  'natively_connectable',
  'content_capabilities',
  'display_in_launcher',
  'display_in_new_tab_page',
  'kiosk_enabled',
  'kiosk_only',
  'kiosk',
  'signature'
])

const RUN_AT = new Set<string>(['document_start', 'document_end', 'document_idle'])
const INCOGNITO = new Set<string>(['spanning', 'split', 'not_allowed'])
const WORLDS = new Set<string>(['ISOLATED', 'MAIN'])
const BACKGROUND_TYPES = new Set<string>(['classic', 'module'])
const URL_OVERRIDES = new Set<string>(['newtab', 'bookmarks', 'history'])
const COMMAND_PLATFORMS = new Set<string>(['default', 'windows', 'mac', 'chromeos', 'linux'])
const MAX_STATIC_RULESETS = 100
const MESSAGE_REFERENCE = /__MSG_([A-Za-z0-9_@]+)__/g

type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class Checker {
  readonly errors: ManifestIssue[] = []
  readonly warnings: ManifestIssue[] = []

  error(path: string, message: string): void {
    this.errors.push({ path, message })
  }

  warn(path: string, message: string): void {
    this.warnings.push({ path, message })
  }

  string(
    path: string,
    value: unknown,
    options: { required?: boolean; nonEmpty?: boolean } = {}
  ): value is string {
    if (value === undefined) {
      if (options.required) this.error(path, 'Required key is missing')
      return false
    }
    if (typeof value !== 'string') {
      this.error(path, 'Must be a string')
      return false
    }
    if (options.nonEmpty && value.length === 0) {
      this.error(path, 'Must not be empty')
      return false
    }
    return true
  }

  boolean(path: string, value: unknown): value is boolean {
    if (value === undefined) return false
    if (typeof value !== 'boolean') {
      this.error(path, 'Must be a boolean')
      return false
    }
    return true
  }

  object(path: string, value: unknown, required = false): value is Raw {
    if (value === undefined) {
      if (required) this.error(path, 'Required key is missing')
      return false
    }
    if (!isRecord(value)) {
      this.error(path, 'Must be an object')
      return false
    }
    return true
  }

  stringArray(
    path: string,
    value: unknown,
    options: { required?: boolean; nonEmpty?: boolean } = {}
  ): value is string[] {
    if (value === undefined) {
      if (options.required) this.error(path, 'Required key is missing')
      return false
    }
    if (!Array.isArray(value)) {
      this.error(path, 'Must be an array of strings')
      return false
    }
    let ok = true
    value.forEach((item, index) => {
      if (typeof item !== 'string') {
        this.error(`${path}[${index}]`, 'Must be a string')
        ok = false
      }
    })
    if (ok && options.nonEmpty && value.length === 0) {
      this.error(path, 'Must not be empty')
      return false
    }
    return ok
  }

  oneOf(path: string, value: unknown, allowed: Set<string>): boolean {
    if (value === undefined) return true
    if (typeof value !== 'string' || !allowed.has(value)) {
      this.error(path, `Must be one of ${[...allowed].map((v) => JSON.stringify(v)).join(', ')}`)
      return false
    }
    return true
  }

  httpUrl(path: string, value: unknown): void {
    if (!this.string(path, value)) return
    let parsed: URL | null = null
    try {
      parsed = new URL(value)
    } catch {
      parsed = null
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      this.error(path, 'Must be an http(s) URL')
    }
  }

  matchPatterns(path: string, value: unknown, severity: 'error' | 'warning'): void {
    if (!this.stringArray(path, value)) return
    value.forEach((pattern, index) => {
      if (isMatchPattern(pattern)) return
      const message = `Invalid match pattern ${JSON.stringify(pattern)}`
      if (severity === 'error') this.error(`${path}[${index}]`, message)
      else this.warn(`${path}[${index}]`, message)
    })
  }
}

function checkAction(c: Checker, path: string, value: unknown): void {
  if (!c.object(path, value)) return
  const icon = value.default_icon
  if (icon !== undefined && typeof icon !== 'string') {
    if (!isRecord(icon))
      c.error(`${path}.default_icon`, 'Must be a path or an object of size to path')
    else {
      for (const [size, file] of Object.entries(icon)) {
        if (typeof file !== 'string') c.error(`${path}.default_icon.${size}`, 'Must be a path')
      }
    }
  }
  c.string(`${path}.default_title`, value.default_title)
  c.string(`${path}.default_popup`, value.default_popup)
}

function checkBackground(c: Checker, raw: Raw, mv: ManifestVersion): void {
  const value = raw.background
  if (!c.object('background', value)) return
  if (mv === 3) {
    // Since Chrome 121 `scripts` and `page` are ignored (not rejected) next to a service worker,
    // which is how cross-browser manifests declare a Firefox background page.
    const hasWorker = c.string('background.service_worker', value.service_worker, {
      required: true,
      nonEmpty: true
    })
    for (const key of ['scripts', 'page', 'persistent'] as const) {
      if (value[key] === undefined) continue
      if (hasWorker) c.warn(`background.${key}`, "Ignored because 'service_worker' is set")
      else {
        c.error(
          `background.${key}`,
          "Cannot be used with manifest_version 3; use 'background.service_worker'"
        )
      }
    }
    c.oneOf('background.type', value.type, BACKGROUND_TYPES)
    return
  }
  if (value.service_worker !== undefined) {
    // Firefox-style MV2 manifests may carry it; Chrome ignores the key below manifest_version 3.
    c.warn('background.service_worker', 'Requires manifest_version 3; ignored')
  }
  const hasScripts = value.scripts !== undefined
  const hasPage = value.page !== undefined
  if (hasScripts && hasPage) c.error('background', "Only one of 'scripts' and 'page' may be set")
  if (hasScripts) c.stringArray('background.scripts', value.scripts)
  if (hasPage) c.string('background.page', value.page, { nonEmpty: true })
  if (!hasScripts && !hasPage) c.error('background', "Needs 'scripts' or 'page'")
  c.boolean('background.persistent', value.persistent)
}

function checkContentScripts(c: Checker, raw: Raw, mv: ManifestVersion): void {
  const value = raw.content_scripts
  if (value === undefined) return
  if (!Array.isArray(value)) {
    c.error('content_scripts', 'Must be an array')
    return
  }
  value.forEach((script, index) => {
    const path = `content_scripts[${index}]`
    if (!c.object(path, script)) return
    if (c.stringArray(`${path}.matches`, script.matches, { required: true, nonEmpty: true })) {
      c.matchPatterns(`${path}.matches`, script.matches, 'error')
    }
    c.matchPatterns(`${path}.exclude_matches`, script.exclude_matches, 'error')
    c.stringArray(`${path}.js`, script.js)
    c.stringArray(`${path}.css`, script.css)
    if (script.js === undefined && script.css === undefined) {
      c.error(path, "Needs at least one of 'js' or 'css'")
    }
    c.oneOf(`${path}.run_at`, script.run_at, RUN_AT)
    c.boolean(`${path}.all_frames`, script.all_frames)
    c.boolean(`${path}.match_about_blank`, script.match_about_blank)
    c.boolean(`${path}.match_origin_as_fallback`, script.match_origin_as_fallback)
    c.stringArray(`${path}.include_globs`, script.include_globs)
    c.stringArray(`${path}.exclude_globs`, script.exclude_globs)
    if (script.world !== undefined) {
      if (mv < 3) c.error(`${path}.world`, 'Requires manifest_version 3')
      else c.oneOf(`${path}.world`, script.world, WORLDS)
    }
  })
}

function checkWebAccessibleResources(c: Checker, raw: Raw, mv: ManifestVersion): void {
  const value = raw.web_accessible_resources
  if (value === undefined) return
  if (!Array.isArray(value)) {
    c.error('web_accessible_resources', 'Must be an array')
    return
  }
  if (mv === 2) {
    c.stringArray('web_accessible_resources', value)
    return
  }
  value.forEach((entry, index) => {
    const path = `web_accessible_resources[${index}]`
    if (!isRecord(entry)) {
      c.error(
        path,
        'Must be an object with resources and matches or extension_ids in manifest_version 3'
      )
      return
    }
    c.stringArray(`${path}.resources`, entry.resources, { required: true, nonEmpty: true })
    c.matchPatterns(`${path}.matches`, entry.matches, 'error')
    c.stringArray(`${path}.extension_ids`, entry.extension_ids)
    c.boolean(`${path}.use_dynamic_url`, entry.use_dynamic_url)
    if (entry.matches === undefined && entry.extension_ids === undefined) {
      c.error(path, "Needs 'matches' or 'extension_ids'")
    }
  })
}

function checkDeclarativeNetRequest(c: Checker, raw: Raw): void {
  const value = raw.declarative_net_request
  if (!c.object('declarative_net_request', value)) return
  const resources = value.rule_resources
  if (!Array.isArray(resources)) {
    c.error('declarative_net_request.rule_resources', 'Must be an array')
    return
  }
  if (resources.length > MAX_STATIC_RULESETS) {
    c.error(
      'declarative_net_request.rule_resources',
      `At most ${MAX_STATIC_RULESETS} rulesets are allowed`
    )
  }
  const ids = new Set<string>()
  resources.forEach((resource, index) => {
    const path = `declarative_net_request.rule_resources[${index}]`
    if (!c.object(path, resource)) return
    if (c.string(`${path}.id`, resource.id, { required: true, nonEmpty: true })) {
      if (ids.has(resource.id)) c.error(`${path}.id`, 'Ruleset ids must be unique')
      ids.add(resource.id)
    }
    if (resource.enabled === undefined) c.error(`${path}.enabled`, 'Required key is missing')
    else c.boolean(`${path}.enabled`, resource.enabled)
    c.string(`${path}.path`, resource.path, { required: true, nonEmpty: true })
  })
  const permissions = Array.isArray(raw.permissions) ? (raw.permissions as unknown[]) : []
  if (
    !permissions.includes('declarativeNetRequest') &&
    !permissions.includes('declarativeNetRequestWithHostAccess')
  ) {
    c.error(
      'declarative_net_request',
      "Requires the 'declarativeNetRequest' or 'declarativeNetRequestWithHostAccess' permission"
    )
  }
}

function checkCommands(c: Checker, raw: Raw, mv: ManifestVersion): void {
  const value = raw.commands
  if (!c.object('commands', value)) return
  for (const [name, command] of Object.entries(value)) {
    const path = `commands.${name}`
    if (!c.object(path, command)) continue
    const key = command.suggested_key
    if (key !== undefined && typeof key !== 'string') {
      if (!isRecord(key))
        c.error(`${path}.suggested_key`, 'Must be a string or an object of platform to key')
      else {
        for (const [platform, binding] of Object.entries(key)) {
          if (!COMMAND_PLATFORMS.has(platform))
            c.warn(`${path}.suggested_key.${platform}`, 'Unknown platform')
          if (typeof binding !== 'string')
            c.error(`${path}.suggested_key.${platform}`, 'Must be a string')
        }
      }
    }
    const executes = name.startsWith('_execute_')
    if (!executes)
      c.string(`${path}.description`, command.description, { required: true, nonEmpty: true })
    else c.string(`${path}.description`, command.description)
    c.boolean(`${path}.global`, command.global)
    if (mv === 3 && (name === '_execute_browser_action' || name === '_execute_page_action')) {
      c.warn(path, "Use '_execute_action' with manifest_version 3")
    }
    if (mv === 2 && name === '_execute_action') {
      c.warn(path, "Use '_execute_browser_action' with manifest_version 2")
    }
  }
}

function usesMessages(raw: Raw): boolean {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return /__MSG_[A-Za-z0-9_@]+__/.test(value)
    if (typeof value !== 'object' || value === null || seen.has(value)) return false
    seen.add(value)
    return Object.values(value).some(visit)
  }
  return visit(raw)
}

/** Validates an already-parsed manifest object. */
export function validateManifest(input: unknown): ManifestParseResult {
  const c = new Checker()
  if (!isRecord(input)) {
    c.error('', 'Manifest must be a JSON object')
    return { manifest: null, raw: null, errors: c.errors, warnings: c.warnings }
  }
  const raw = input

  const mvRaw = raw.manifest_version
  let mv: ManifestVersion = 3
  if (mvRaw === 2 || mvRaw === 3) mv = mvRaw
  else if (mvRaw === undefined) c.error('manifest_version', 'Required key is missing')
  else if (typeof mvRaw !== 'number' || !Number.isInteger(mvRaw)) {
    c.error('manifest_version', 'Must be an integer')
  } else
    c.error('manifest_version', `Unsupported manifest version ${mvRaw}; only 2 and 3 are accepted`)

  if (c.string('name', raw.name, { required: true, nonEmpty: true }) && raw.name.length > 75) {
    c.warn('name', 'Longer than 75 characters')
  }
  if (
    c.string('version', raw.version, { required: true }) &&
    !isValidExtensionVersion(raw.version)
  ) {
    c.error('version', 'Must be one to four dot-separated integers')
  }
  if (c.string('description', raw.description) && raw.description.length > 132) {
    c.warn('description', 'Longer than 132 characters')
  }
  c.string('short_name', raw.short_name)
  c.string('version_name', raw.version_name)
  if (raw.author !== undefined && typeof raw.author !== 'string') {
    if (!isRecord(raw.author) || typeof raw.author.email !== 'string') {
      c.error('author', 'Must be a string or an object with an email')
    }
  }

  if (c.object('icons', raw.icons)) {
    for (const [size, file] of Object.entries(raw.icons)) {
      if (!/^\d+$/.test(size)) c.warn(`icons.${size}`, 'Icon sizes should be integers')
      if (typeof file !== 'string') c.error(`icons.${size}`, 'Must be a path')
    }
  }

  for (const key of ['permissions', 'optional_permissions'] as const) {
    const entries = raw[key]
    if (!c.stringArray(key, entries)) continue
    entries.forEach((entry, index) => {
      const warning = permissionVersionWarning(entry, mv)
      if (warning) c.warn(`${key}[${index}]`, warning)
    })
  }
  if (raw.host_permissions !== undefined) {
    if (mv === 2)
      c.warn('host_permissions', 'Requires manifest_version 3; ignored in manifest_version 2')
    c.matchPatterns('host_permissions', raw.host_permissions, 'warning')
  }
  if (raw.optional_host_permissions !== undefined) {
    if (mv === 2) c.warn('optional_host_permissions', 'Requires manifest_version 3')
    c.matchPatterns('optional_host_permissions', raw.optional_host_permissions, 'warning')
  }

  checkBackground(c, raw, mv)
  checkContentScripts(c, raw, mv)

  if (raw.action !== undefined) {
    if (mv === 2)
      c.error('action', "Requires manifest_version 3; use 'browser_action' or 'page_action'")
    checkAction(c, 'action', raw.action)
  }
  for (const key of ['browser_action', 'page_action'] as const) {
    if (raw[key] === undefined) continue
    if (mv === 3) c.error(key, "Requires manifest_version 2; use 'action'")
    checkAction(c, key, raw[key])
  }
  if (raw.browser_action !== undefined && raw.page_action !== undefined) {
    c.error('page_action', "Only one of 'browser_action' and 'page_action' may be set")
  }

  if (c.object('options_ui', raw.options_ui)) {
    c.string('options_ui.page', raw.options_ui.page, { required: true, nonEmpty: true })
    c.boolean('options_ui.open_in_tab', raw.options_ui.open_in_tab)
  }
  c.string('options_page', raw.options_page)
  if (raw.options_ui !== undefined && raw.options_page !== undefined) {
    c.warn('options_page', "Ignored because 'options_ui' is set")
  }

  checkWebAccessibleResources(c, raw, mv)
  if (raw.declarative_net_request !== undefined) checkDeclarativeNetRequest(c, raw)

  if (
    c.string('default_locale', raw.default_locale) &&
    !/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/.test(raw.default_locale)
  ) {
    c.error('default_locale', 'Must be a locale code such as "en" or "pt_BR"')
  }
  if (usesMessages(raw) && raw.default_locale === undefined) {
    c.error('default_locale', "Localization used, but 'default_locale' was not specified")
  }
  if (
    c.string('minimum_chrome_version', raw.minimum_chrome_version) &&
    !parseVersion(raw.minimum_chrome_version)
  ) {
    c.error('minimum_chrome_version', 'Must be a version string')
  }
  if (raw.update_url !== undefined) c.httpUrl('update_url', raw.update_url)
  if (raw.homepage_url !== undefined) c.httpUrl('homepage_url', raw.homepage_url)
  if (c.string('key', raw.key)) {
    try {
      if (base64Decode(raw.key).length === 0) c.error('key', 'Must be a base64-encoded public key')
    } catch {
      c.error('key', 'Must be a base64-encoded public key')
    }
  }
  checkCommands(c, raw, mv)
  c.oneOf('incognito', raw.incognito, INCOGNITO)

  const csp = raw.content_security_policy
  if (csp !== undefined) {
    if (mv === 2 && typeof csp !== 'string') {
      c.error('content_security_policy', 'Must be a string in manifest_version 2')
    } else if (mv === 3) {
      if (!isRecord(csp))
        c.error('content_security_policy', 'Must be an object in manifest_version 3')
      else {
        c.string('content_security_policy.extension_pages', csp.extension_pages)
        c.string('content_security_policy.sandbox', csp.sandbox)
      }
    }
  }

  c.string('devtools_page', raw.devtools_page)
  if (c.object('omnibox', raw.omnibox))
    c.string('omnibox.keyword', raw.omnibox.keyword, { required: true, nonEmpty: true })
  if (c.object('chrome_url_overrides', raw.chrome_url_overrides)) {
    const keys = Object.keys(raw.chrome_url_overrides)
    if (keys.length > 1) c.error('chrome_url_overrides', 'Only one page may be overridden')
    for (const key of keys) {
      if (!URL_OVERRIDES.has(key)) c.error(`chrome_url_overrides.${key}`, 'Unknown page')
      c.string(`chrome_url_overrides.${key}`, raw.chrome_url_overrides[key], { nonEmpty: true })
    }
  }
  if (c.object('side_panel', raw.side_panel))
    c.string('side_panel.default_path', raw.side_panel.default_path)
  c.boolean('offline_enabled', raw.offline_enabled)
  if (c.object('externally_connectable', raw.externally_connectable)) {
    c.stringArray('externally_connectable.ids', raw.externally_connectable.ids)
    c.matchPatterns('externally_connectable.matches', raw.externally_connectable.matches, 'error')
    c.boolean(
      'externally_connectable.accepts_tls_channel_id',
      raw.externally_connectable.accepts_tls_channel_id
    )
  }
  if (c.object('sandbox', raw.sandbox)) {
    c.stringArray('sandbox.pages', raw.sandbox.pages, { required: true })
    c.string('sandbox.content_security_policy', raw.sandbox.content_security_policy)
  }
  if (c.object('storage', raw.storage))
    c.string('storage.managed_schema', raw.storage.managed_schema, { required: true })

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) c.warn(key, 'Unrecognized manifest key')
  }

  return {
    manifest: c.errors.length === 0 ? (raw as unknown as ExtensionManifest) : null,
    raw,
    errors: c.errors,
    warnings: c.warnings
  }
}

/**
 * Strips a UTF-8 BOM and the `//` and `/* *\/` comments Chrome tolerates in manifest.json and
 * messages.json, leaving string contents untouched.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let i = 0
  if (text.charCodeAt(0) === 0xfeff) i = 1
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** Parses manifest.json text (comments allowed) and validates it. */
export function parseManifest(text: string): ManifestParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(text))
  } catch (error) {
    return {
      manifest: null,
      raw: null,
      errors: [
        { path: '', message: `manifest.json is not valid JSON: ${(error as Error).message}` }
      ],
      warnings: []
    }
  }
  return validateManifest(parsed)
}

// ---------------------------------------------------------------------------
// Localisation (`_locales/<locale>/messages.json`)
// ---------------------------------------------------------------------------

export interface LocaleMessage {
  message: string
  description?: string
  placeholders?: Record<string, { content: string; example?: string }>
}

export type LocaleMessages = Record<string, LocaleMessage>

/**
 * Chrome's fallback order (`extension_l10n_util::GetAllFallbackLocales`): the requested locale,
 * each of its parents (`pt_BR` then `pt`), then the default locale. BCP 47 hyphens become the
 * underscores the `_locales` directory uses.
 */
export function localeFallbackChain(
  requested: string | null | undefined,
  defaultLocale: string
): string[] {
  const chain: string[] = []
  const push = (locale: string): void => {
    if (locale && !chain.includes(locale)) chain.push(locale)
  }
  if (requested) {
    const normalised = requested.replace(/-/g, '_')
    const parts = normalised.split('_')
    for (let i = parts.length; i >= 1; i--) push(parts.slice(0, i).join('_'))
  }
  push(defaultLocale.replace(/-/g, '_'))
  return chain
}

const PLACEHOLDER_NAME = /^[A-Za-z0-9_@]+$/

/**
 * Expands `$placeholder$` references inside one message. Names are case-insensitive; `$$` yields
 * a literal dollar sign; references with no matching placeholder are left as written.
 */
export function expandPlaceholders(message: LocaleMessage): string {
  const placeholders = new Map<string, string>()
  for (const [name, def] of Object.entries(message.placeholders ?? {})) {
    if (def && typeof def.content === 'string') placeholders.set(name.toLowerCase(), def.content)
  }
  const text = message.message
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== '$') {
      out += ch
      i++
      continue
    }
    if (text[i + 1] === '$') {
      out += '$'
      i += 2
      continue
    }
    const end = text.indexOf('$', i + 1)
    if (end < 0) {
      out += text.slice(i)
      break
    }
    const name = text.slice(i + 1, end)
    const content = PLACEHOLDER_NAME.test(name) ? placeholders.get(name.toLowerCase()) : undefined
    if (content === undefined) {
      out += ch
      i++
      continue
    }
    out += content
    i = end + 1
  }
  return out
}

/**
 * Merges message bundles in fallback order into a catalog of lower-cased message name to expanded
 * text. Earlier bundles win, so pass the most specific locale first.
 */
export function buildMessageCatalog(
  bundles: readonly (LocaleMessages | null | undefined)[]
): Map<string, string> {
  const catalog = new Map<string, string>()
  for (const bundle of bundles) {
    if (!bundle || typeof bundle !== 'object') continue
    for (const [name, entry] of Object.entries(bundle)) {
      const key = name.toLowerCase()
      if (catalog.has(key)) continue
      if (!entry || typeof entry !== 'object' || typeof entry.message !== 'string') continue
      catalog.set(key, expandPlaceholders(entry))
    }
  }
  return catalog
}

/** Replaces every `__MSG_name__` in `text`; unknown names are reported and left in place. */
export function substituteMessages(
  text: string,
  catalog: ReadonlyMap<string, string>,
  missing?: Set<string>
): string {
  return text.replace(MESSAGE_REFERENCE, (whole, name: string) => {
    const value = catalog.get(name.toLowerCase())
    if (value === undefined) {
      missing?.add(name)
      return whole
    }
    return value
  })
}

/** The manifest keys Chrome localises (`extension_l10n_util::LocalizeManifest`). */
const LOCALIZED_STRING_PATHS: readonly string[][] = [
  ['name'],
  ['short_name'],
  ['description'],
  ['action', 'default_title'],
  ['browser_action', 'default_title'],
  ['page_action', 'default_title'],
  ['omnibox', 'keyword'],
  ['chrome_settings_overrides', 'search_provider', 'name'],
  ['chrome_settings_overrides', 'search_provider', 'keyword']
]

export interface LocalizedManifest<T extends Raw = Raw> {
  manifest: T
  /** `__MSG_` names that no bundle in the chain defines. */
  missing: string[]
}

/**
 * Returns a deep copy of `raw` with Chrome's localisable keys substituted from `catalog`
 * (name, short_name, description, action titles, command descriptions, omnibox keyword and
 * search-provider strings).
 */
export function localizeManifest<T extends Raw>(
  raw: T,
  catalog: ReadonlyMap<string, string>
): LocalizedManifest<T> {
  const copy = structuredClone(raw) as Raw
  const missing = new Set<string>()
  for (const path of LOCALIZED_STRING_PATHS) {
    let node: unknown = copy
    for (let i = 0; i < path.length - 1; i++) node = isRecord(node) ? node[path[i]] : undefined
    const leaf = path[path.length - 1]
    if (isRecord(node) && typeof node[leaf] === 'string') {
      node[leaf] = substituteMessages(node[leaf], catalog, missing)
    }
  }
  if (isRecord(copy.commands)) {
    for (const command of Object.values(copy.commands)) {
      if (isRecord(command) && typeof command.description === 'string') {
        command.description = substituteMessages(command.description, catalog, missing)
      }
    }
  }
  return { manifest: copy as T, missing: [...missing] }
}
