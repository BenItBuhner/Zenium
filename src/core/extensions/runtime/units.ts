import { parseMatchPattern } from '../api/matchPattern'
import {
  backgroundPageHtml,
  worldNameFor,
  type BootGroup,
  type ContentBootConfig,
  type ExtensionBoot,
  type IsolationMode,
  type PageBootConfig,
  type UnitWorld
} from './boot'
import type { RuntimeManifest } from './manifest'
import { extensionUrl } from './plan'

/**
 * What one attached extension asks the host to inject and serve: its content-script units and
 * the files of its pages. A unit is one document-start script (the bootstrap plus the sources of
 * some content-script groups) that the host registers on every tab WebView under an origin
 * rule set, so a page only ever receives the units of extensions that could match it, and in a
 * world of its own where the WebView has isolated worlds. Units are planned per extension, so
 * attaching, detaching or reconfiguring one extension leaves every other extension's units (and
 * the host's compiled copies of them) alone.
 */
export interface UnitGroup {
  ext: string
  index: number
  /** Extension-relative paths of the group's files; the host reads and embeds them. */
  js: string[]
  isolation: IsolationMode
}

export interface UnitCss {
  ext: string
  path: string
}

export interface ContentUnit {
  /** Stable within the extension: the world and the sorted origin rules. */
  key: string
  world: UnitWorld
  /** The isolated world to inject into, or null for the page's main world. */
  worldName: string | null
  /** `addDocumentStartJavaScript` origin rules (`*` for every origin). */
  origins: string[]
  isolation: IsolationMode
  config: ContentBootConfig
  groups: UnitGroup[]
  css: UnitCss[]
}

export interface ServedConfig {
  /** `web_accessible_resources` globs (tab pages may only fetch these). */
  webAccessible: string[]
  /** `host_permissions` (MV2 origin permissions included): the hosts the CORS proxy reaches for the extension's pages. */
  hosts: string[]
  /** The generated background page, or null when the extension has none or an MV2 page. */
  backgroundHtml: string | null
  backgroundUrl: string | null
  /** Page-mode boot config (JSON) without `context`; the host sets it per page kind. */
  page: string
}

export interface ExtensionUnits {
  id: string
  version: string
  units: ContentUnit[]
  served: ServedConfig
}

export interface UnitEnvironment {
  token: string
  uiLanguage: string
  /** The WebView can inject into named isolated worlds (Chromium 146+, androidx.webkit 1.17). */
  isolatedWorlds: boolean
  /** `userScripts.configureWorld({ messaging })`: whether user scripts get `runtime.sendMessage`. */
  userScriptMessaging: boolean
}

/**
 * `addDocumentStartJavaScript` filters by origin rule (`scheme://host[:port]`, `*` wildcards in
 * the host's leftmost label, or `*` for everything). A match pattern with a path is wider than
 * its origin, so the rule is the origin; anything the rule grammar cannot express becomes `*`
 * and the bootstrap's own matcher decides in the frame.
 */
export function originRulesFor(patterns: string[]): Set<string> {
  const rules = new Set<string>()
  for (const raw of patterns) {
    if (raw === '<all_urls>') return new Set(['*'])
    const pattern = parseMatchPattern(raw)
    if (!pattern) continue
    if (pattern.matchesAllUrls || pattern.host === '*' || pattern.host === '') return new Set(['*'])
    for (const scheme of pattern.schemes) {
      if (scheme !== 'http' && scheme !== 'https') return new Set(['*'])
      const port = pattern.port && pattern.port !== '*' ? `:${pattern.port}` : ''
      rules.add(`${scheme}://${pattern.host}${port}`)
    }
  }
  return rules.size === 0 ? new Set(['*']) : rules
}

const worldOf = (group: BootGroup): UnitWorld =>
  group.world === 'MAIN' ? 'main' : group.world === 'USER_SCRIPT' ? 'user' : 'isolated'

const sortedOrigins = (origins: Iterable<string>): string[] => [...new Set(origins)].sort()

const unitKey = (world: UnitWorld, origins: string[]): string => `${world}:${origins.join(' ')}`

/**
 * Whether the extension can inject scripts on demand (`scripting.executeScript`, `userScripts`,
 * MV2 `tabs.executeScript`) into pages none of its declarations match. Such pages need the
 * extension's world and bridge ready before the script arrives, which a unit without sources
 * over the host permissions provides on hosts with isolated worlds; without worlds the host
 * boots the extension's scope late, in the main world, when the injection arrives.
 */
export function injectsProgrammatically(manifest: RuntimeManifest): boolean {
  return (
    manifest.permissions.includes('scripting') ||
    manifest.permissions.includes('userScripts') ||
    (manifest.manifestVersion === 2 && manifest.hostPermissions.length > 0)
  )
}

/** Plan the units and served files of one extension from its boot record. */
export function planUnits(
  boot: ExtensionBoot,
  manifest: RuntimeManifest,
  env: UnitEnvironment
): ExtensionUnits {
  const drafts = new Map<string, { world: UnitWorld; origins: string[]; groups: BootGroup[] }>()
  const add = (world: UnitWorld, origins: string[], groups: BootGroup[]): void => {
    const key = unitKey(world, origins)
    const draft = drafts.get(key)
    if (draft) draft.groups.push(...groups)
    else drafts.set(key, { world, origins, groups: [...groups] })
  }
  for (const group of boot.groups) {
    add(worldOf(group), sortedOrigins(originRulesFor(group.matches)), [group])
  }
  if (env.isolatedWorlds && injectsProgrammatically(manifest)) {
    const wanted = sortedOrigins(originRulesFor(manifest.hostPermissions))
    const covered = new Set<string>()
    for (const draft of drafts.values())
      if (draft.world === 'isolated') for (const origin of draft.origins) covered.add(origin)
    if (!covered.has('*')) {
      const missing = wanted.filter((origin) => !covered.has(origin))
      if (missing.length > 0) add('isolated', missing, [])
    }
  }
  // A unit over every origin runs everywhere anyway: fold that world's other units into it, so a
  // page receives one copy of the bootstrap per world rather than one per origin rule set.
  for (const world of ['isolated', 'main', 'user'] as const) {
    const everywhere = drafts.get(unitKey(world, ['*']))
    if (!everywhere) continue
    for (const [key, draft] of [...drafts]) {
      if (draft.world !== world || draft === everywhere) continue
      everywhere.groups.push(...draft.groups)
      drafts.delete(key)
    }
  }
  const isolationFor = (world: UnitWorld): IsolationMode =>
    world === 'main' ? 'none' : env.isolatedWorlds ? 'world' : 'with'
  const units: ContentUnit[] = [...drafts.values()]
    .map((draft) => {
      const isolation = isolationFor(draft.world)
      const groups = [...draft.groups].sort((a, b) => a.index - b.index)
      const config: ContentBootConfig = {
        kind: 'content',
        token: env.token,
        uiLanguage: env.uiLanguage,
        world: draft.world,
        extension: { ...boot, groups, isolation },
        ...(draft.world === 'user' ? { userScriptMessaging: env.userScriptMessaging } : {})
      }
      return {
        key: unitKey(draft.world, draft.origins),
        world: draft.world,
        worldName:
          env.isolatedWorlds && draft.world !== 'main'
            ? worldNameFor(boot.id, draft.world === 'user' ? 'user' : 'isolated')
            : null,
        origins: draft.origins,
        isolation,
        config,
        groups: groups
          .filter((group) => group.js.length > 0)
          .map((group) => ({ ext: boot.id, index: group.index, js: group.js, isolation })),
        css: groups.flatMap((group) => group.css.map((path) => ({ ext: boot.id, path })))
      }
    })
    .sort((a, b) => a.key.localeCompare(b.key))
  const background = manifest.background
  const page: Omit<PageBootConfig, 'context'> = {
    kind: 'page',
    token: env.token,
    uiLanguage: env.uiLanguage,
    extension: { ...boot, groups: [] }
  }
  return {
    id: boot.id,
    version: boot.version,
    units,
    served: {
      webAccessible: manifest.webAccessibleResources.flatMap((set) => set.resources),
      hosts: manifest.hostPermissions,
      backgroundHtml:
        background && background.kind !== 'page' ? backgroundPageHtml(manifest) : null,
      // An MV3 worker's `self.location` is its script's URL in Chrome: the page that stands in
      // for it lives there too (relative `importScripts`, Web Locks named after the path). The
      // host serves the generated HTML for the background view's document at that URL.
      backgroundUrl: background
        ? background.kind === 'page'
          ? extensionUrl(boot.id, background.page)
          : background.kind === 'service_worker'
            ? extensionUrl(boot.id, background.script)
            : extensionUrl(boot.id, '_generated_background_page.html')
        : null,
      page: JSON.stringify(page)
    }
  }
}

/** Whether a reconfigure changed anything the host has to recompile or re-register. */
export function sameUnits(a: ExtensionUnits | null, b: ExtensionUnits): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b)
}
