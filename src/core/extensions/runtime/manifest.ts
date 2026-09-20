/**
 * The subset of a Chrome extension manifest the emulation layer needs, normalised across MV2 and
 * MV3. Kept deliberately small: the store-install core owns the complete manifest type; this
 * runtime model is what the injection planner, the chrome.* shim and the hosts consume.
 */
import { getMessage, localeCandidates, substituteMessages, type LocaleMessages } from '../api/i18n'
import { availablePermissions } from '../api/permissions'
import { buildMessageCatalog, localizeManifest } from '../manifest'

export type ManifestVersion = 2 | 3

export type RunAt = 'document_start' | 'document_end' | 'document_idle'

/**
 * Where a script runs: the extension's isolated world, the page's main world, or (for
 * `chrome.userScripts` registrations) the extension's user-script world, which gets messaging only.
 */
export type ScriptWorld = 'ISOLATED' | 'MAIN' | 'USER_SCRIPT'

export interface ContentScriptDeclaration {
  matches: string[]
  excludeMatches: string[]
  includeGlobs: string[]
  excludeGlobs: string[]
  js: string[]
  css: string[]
  runAt: RunAt
  allFrames: boolean
  matchAboutBlank: boolean
  matchOriginAsFallback: boolean
  world: ScriptWorld
}

export type BackgroundDeclaration =
  | { kind: 'service_worker'; script: string; module: boolean }
  | { kind: 'scripts'; scripts: string[]; persistent: boolean }
  | { kind: 'page'; page: string; persistent: boolean }

export interface ActionDeclaration {
  /** `action` (MV3) or `browser_action` (MV2); `page_action` is folded in as well. */
  source: 'action' | 'browser_action' | 'page_action'
  title: string | null
  popup: string | null
  /** Size → path, both as declared. */
  icons: Record<string, string>
}

export interface OptionsDeclaration {
  page: string
  openInTab: boolean
}

export interface WebAccessibleResourceSet {
  resources: string[]
  /** Match patterns (MV3); MV2 entries are exposed to every origin. */
  matches: string[]
  useDynamicUrl: boolean
}

export interface RulesetDeclaration {
  id: string
  path: string
  enabled: boolean
}

export interface CommandDeclaration {
  name: string
  description: string
  suggestedKey: string | null
}

export interface RuntimeManifest {
  manifestVersion: ManifestVersion
  name: string
  version: string
  description: string
  defaultLocale: string | null
  /** Size → path. */
  icons: Record<string, string>
  permissions: string[]
  optionalPermissions: string[]
  hostPermissions: string[]
  optionalHostPermissions: string[]
  contentScripts: ContentScriptDeclaration[]
  background: BackgroundDeclaration | null
  action: ActionDeclaration | null
  options: OptionsDeclaration | null
  webAccessibleResources: WebAccessibleResourceSet[]
  rulesets: RulesetDeclaration[]
  commands: CommandDeclaration[]
  /** `content_security_policy.extension_pages` (MV3) or the MV2 string, when declared. */
  extensionPagesCsp: string | null
  minimumChromeVersion: string | null
  incognito: 'spanning' | 'split' | 'not_allowed'
  /**
   * The document for `chrome.runtime.getManifest()`: as written, with Chrome's localisable
   * strings (`name`, `short_name`, `description`, action titles, command descriptions, omnibox
   * and search-provider strings) resolved from `_locales` the way Chrome resolves them at load.
   * Adblock Plus reads `short_name` from it and refuses to start on `__MSG_name__`.
   */
  raw: Record<string, unknown>
}

/** The message helpers moved to the shared api layer; re-exported for the runtime's callers. */
export type { LocaleMessages }
export { getMessage, localeCandidates, substituteMessages }

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

const RUN_AT: readonly RunAt[] = ['document_start', 'document_end', 'document_idle']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v
  return out
}

function parseContentScript(entry: unknown, index: number): ContentScriptDeclaration {
  if (!isRecord(entry)) throw new ManifestError(`content_scripts[${index}] is not an object`)
  const matches = strings(entry.matches)
  if (matches.length === 0) throw new ManifestError(`content_scripts[${index}] has no matches`)
  const runAt = str(entry.run_at, 'document_idle')
  if (!RUN_AT.includes(runAt as RunAt))
    throw new ManifestError(`content_scripts[${index}].run_at "${runAt}" is invalid`)
  const world = str(entry.world, 'ISOLATED')
  return {
    matches,
    excludeMatches: strings(entry.exclude_matches),
    includeGlobs: strings(entry.include_globs),
    excludeGlobs: strings(entry.exclude_globs),
    js: strings(entry.js),
    css: strings(entry.css),
    runAt: runAt as RunAt,
    allFrames: entry.all_frames === true,
    matchAboutBlank: entry.match_about_blank === true,
    matchOriginAsFallback: entry.match_origin_as_fallback === true,
    world: world === 'MAIN' ? 'MAIN' : 'ISOLATED'
  }
}

function parseBackground(value: unknown, mv: ManifestVersion): BackgroundDeclaration | null {
  if (!isRecord(value)) return null
  if (typeof value.service_worker === 'string') {
    return { kind: 'service_worker', script: value.service_worker, module: value.type === 'module' }
  }
  const scripts = strings(value.scripts)
  const persistent = mv === 2 ? value.persistent !== false : false
  if (scripts.length > 0) return { kind: 'scripts', scripts, persistent }
  if (typeof value.page === 'string') return { kind: 'page', page: value.page, persistent }
  return null
}

function parseAction(
  raw: Record<string, unknown>,
  messages: LocaleMessages | null
): ActionDeclaration | null {
  const sources: ActionDeclaration['source'][] = ['action', 'browser_action', 'page_action']
  for (const source of sources) {
    const value = raw[source]
    if (!isRecord(value)) continue
    const iconValue = value.default_icon
    return {
      source,
      title:
        typeof value.default_title === 'string'
          ? substituteMessages(value.default_title, messages)
          : null,
      popup:
        typeof value.default_popup === 'string' && value.default_popup !== ''
          ? value.default_popup
          : null,
      icons: typeof iconValue === 'string' ? { '19': iconValue } : stringMap(iconValue)
    }
  }
  return null
}

function parseOptions(raw: Record<string, unknown>): OptionsDeclaration | null {
  const ui = raw.options_ui
  if (isRecord(ui) && typeof ui.page === 'string')
    return { page: ui.page, openInTab: ui.open_in_tab === true }
  if (typeof raw.options_page === 'string') return { page: raw.options_page, openInTab: true }
  return null
}

function parseWebAccessibleResources(
  value: unknown,
  mv: ManifestVersion
): WebAccessibleResourceSet[] {
  if (!Array.isArray(value)) return []
  if (mv === 2) {
    const resources = strings(value)
    return resources.length ? [{ resources, matches: ['<all_urls>'], useDynamicUrl: false }] : []
  }
  const out: WebAccessibleResourceSet[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const resources = strings(entry.resources)
    if (!resources.length) continue
    out.push({
      resources,
      matches: strings(entry.matches),
      useDynamicUrl: entry.use_dynamic_url === true
    })
  }
  return out
}

function parseRulesets(value: unknown): RulesetDeclaration[] {
  if (!isRecord(value) || !Array.isArray(value.rule_resources)) return []
  const out: RulesetDeclaration[] = []
  for (const entry of value.rule_resources) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.path !== 'string') continue
    out.push({ id: entry.id, path: entry.path, enabled: entry.enabled === true })
  }
  return out
}

function parseCommands(value: unknown, messages: LocaleMessages | null): CommandDeclaration[] {
  if (!isRecord(value)) return []
  const out: CommandDeclaration[] = []
  for (const [name, entry] of Object.entries(value)) {
    const record = isRecord(entry) ? entry : {}
    const suggested = isRecord(record.suggested_key) ? record.suggested_key : null
    out.push({
      name,
      description: substituteMessages(str(record.description), messages),
      suggestedKey: suggested ? str(suggested.default, '') || null : null
    })
  }
  return out
}

function parseCsp(value: unknown, mv: ManifestVersion): string | null {
  if (mv === 2) return typeof value === 'string' ? value : null
  return isRecord(value) && typeof value.extension_pages === 'string' ? value.extension_pages : null
}

/**
 * Parse and normalise a manifest. `messages` is the resolved `_locales` table (or null) used
 * for `__MSG_x__` substitution in the user-visible fields.
 */
export function parseRuntimeManifest(
  source: unknown,
  messages: LocaleMessages | null
): RuntimeManifest {
  if (!isRecord(source)) throw new ManifestError('manifest.json is not a JSON object')
  const mv = source.manifest_version
  if (mv !== 2 && mv !== 3)
    throw new ManifestError(`manifest_version must be 2 or 3 (got ${String(mv)})`)
  const name = substituteMessages(str(source.name), messages)
  if (!name) throw new ManifestError('manifest has no name')
  const version = str(source.version)
  if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new ManifestError(`version "${version}" is invalid`)
  const rawContentScripts = Array.isArray(source.content_scripts) ? source.content_scripts : []
  const permissions = strings(source.permissions)
  const hostPermissions = strings(source.host_permissions)
  const isHostPattern = (p: string): boolean =>
    p === '<all_urls>' || /^(\*|https?|file|ftp|wss?):\/\//.test(p)
  const incognitoRaw = str(source.incognito, 'spanning')
  return {
    manifestVersion: mv,
    name,
    version,
    description: substituteMessages(str(source.description), messages),
    defaultLocale: typeof source.default_locale === 'string' ? source.default_locale : null,
    icons: stringMap(source.icons),
    // MV2 keeps host patterns inside `permissions`; split them the MV3 way. An API permission
    // outside its manifest version (`webRequestBlocking` on MV3, `scripting` on MV2) is not
    // granted, as Chrome's feature system refuses it with an install warning: an MV3 extension
    // asking `permissions.contains({ permissions: ['webRequestBlocking'] })` hears `false`
    // (Stylus does, and registers its observational listener on that answer).
    permissions: availablePermissions(
      permissions.filter((p) => !isHostPattern(p)),
      mv
    ),
    optionalPermissions: availablePermissions(
      strings(source.optional_permissions).filter((p) => !isHostPattern(p)),
      mv
    ),
    hostPermissions: [...hostPermissions, ...permissions.filter(isHostPattern)],
    optionalHostPermissions: [
      ...strings(source.optional_host_permissions),
      ...strings(source.optional_permissions).filter(isHostPattern)
    ],
    contentScripts: rawContentScripts.map(parseContentScript),
    background: parseBackground(source.background, mv),
    action: parseAction(source, messages),
    options: parseOptions(source),
    webAccessibleResources: parseWebAccessibleResources(source.web_accessible_resources, mv),
    rulesets: parseRulesets(source.declarative_net_request),
    commands: parseCommands(source.commands, messages),
    extensionPagesCsp: parseCsp(source.content_security_policy, mv),
    minimumChromeVersion:
      typeof source.minimum_chrome_version === 'string' ? source.minimum_chrome_version : null,
    incognito:
      incognitoRaw === 'split' || incognitoRaw === 'not_allowed' ? incognitoRaw : 'spanning',
    raw: messages ? localizeManifest(source, buildMessageCatalog([messages])).manifest : source
  }
}

/** The largest declared icon path, for the management UI. */
export function largestIcon(icons: Record<string, string>): string | null {
  let best: { size: number; path: string } | null = null
  for (const [size, path] of Object.entries(icons)) {
    const n = Number(size)
    if (!Number.isFinite(n)) continue
    if (!best || n > best.size) best = { size: n, path }
  }
  return best?.path ?? null
}
