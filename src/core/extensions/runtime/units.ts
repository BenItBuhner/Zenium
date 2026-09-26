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

/**
 * How the host assembles a unit's script (`ExtensionScripts.documentStart`). The WebView keeps
 * every registered script whole once per tab view in the app process and once per live frame in
 * the renderer, whatever its origin rules, so a bootstrap copy per rule set is that many copies of
 * 163 K chars per view and per frame (compat round 19: 21 units across the frame budget's six
 * extensions, 3.4 M of their 17.6 M chars). In an isolated world of the extension's own, one unit
 * carries the bootstrap and the world's other rule sets attach to it:
 *
 *  - `whole`: config, CSS, sources and the bootstrap, run at once (the main world's shape, and a
 *    world with one unit);
 *  - `carrier`: the same, and the bootstrap also left on the world's global as
 *    `__zenExtCarrier(boot)` for the thin units after it (the world's `*`-rule unit, first in
 *    registration order, so it has run before any of them);
 *  - `holder`: the carrier alone – defined, never run – added where the world has several rule
 *    sets and none over every origin, so a frame no set matches boots nothing;
 *  - `thin`: config, CSS and sources without the bootstrap: the unit attaches to the world's
 *    runtime (`__zenExtRuntime.attach`, the bootstrap's own hand-off, token-checked) or boots
 *    through the carrier when it is the first of the world to match the frame.
 */
export type UnitShape = 'whole' | 'carrier' | 'holder' | 'thin'

export interface ContentUnit {
  /** Stable within the extension: the world and the sorted origin rules. */
  key: string
  world: UnitWorld
  /** The isolated world to inject into, or null for the page's main world. */
  worldName: string | null
  /** `addDocumentStartJavaScript` origin rules (`*` for every origin). */
  origins: string[]
  isolation: IsolationMode
  shape: UnitShape
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
  /**
   * Chars a serialized message may have on the bridge (the host's, from its heap); absent, the
   * engine keeps Chrome's 64 MB. See `EngineConfig.maxMessageLength`.
   */
  messageLimit?: number
  /**
   * The sizes in bytes of the extension's content-script files by the path the groups name them
   * by, as the host answers `ext.fileSizes` (a UTF-8 file has at most as many chars as bytes);
   * asked for when the plan would fold units (`foldFilesFor`), absent otherwise. A path the host
   * could not size is left out, and the unit naming it is never folded.
   */
  fileChars?: Readonly<Record<string, number>>
}

/**
 * Beyond this many whole units with sources over hostname rules in one world, the planner folds
 * them by size (`foldUnits`). Up to it, one bootstrap copy per rule set is what compat round 19
 * budgeted (21 units across six extensions); Adblock Ad Blocker Pro's 58 registered scriptlet
 * sets (compat round 21) were 58 copies of the 165 K bootstrap over 0.7 M chars of sources –
 * 9.9 M of the 14.1 M chars of its plan, held 16-bit on the phone, and the compile of them was
 * the allocation that ended the app process on the 192 MB heap.
 */
export const FOLD_ABOVE_UNITS = 8

/**
 * The most chars of sources and CSS one folded unit carries: what every frame matching any of
 * its rules receives beside the bootstrap. Round 18's lesson bounds it (tl;dv's three 6-8 MB
 * units folded into one 20.7 M-char script for every frame took the renderer down): a unit over
 * the cap alone is never folded, and the cap is a quarter of what an ad blocker's own
 * every-origin units put into every frame anyway.
 */
export const FOLD_UNIT_CHARS = 512 * 1024

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

/**
 * Groups alike in everything but their `matches` – the same files, world, `run_at`, frame and
 * exclusion rules – become one group over the union of their patterns. An extension that lists
 * the same bundle under several `content_scripts` entries, one per site family (Grammarly's
 * 2.67 M-char pair under its Outlook set and its classroom set), otherwise embeds it once per
 * rule set, and every tab view and live frame holds each copy. Chrome would inject such a pair
 * twice into a frame both entries match; the merged group runs once there – the one difference,
 * in the overlap alone. The first group of a kind keeps its index (the stats' and the console's
 * name for it); the others' patterns join it in order.
 */
export function mergeAlikeGroups(groups: readonly BootGroup[]): BootGroup[] {
  const kept = new Map<string, BootGroup>()
  const out: BootGroup[] = []
  for (const group of groups) {
    if (group.js.length === 0 && group.css.length === 0) {
      out.push(group)
      continue
    }
    const alike = JSON.stringify([
      group.runAt,
      group.world,
      group.js,
      group.css,
      group.excludeMatches,
      group.includeGlobs,
      group.excludeGlobs,
      group.allFrames,
      group.matchAboutBlank,
      group.matchOriginAsFallback
    ])
    const first = kept.get(alike)
    if (!first) {
      const copy = { ...group, matches: [...group.matches] }
      kept.set(alike, copy)
      out.push(copy)
      continue
    }
    for (const pattern of group.matches)
      if (!first.matches.includes(pattern)) first.matches.push(pattern)
  }
  return out
}

/** A unit in the making: its world and rules, the groups gathered under them, its shape once decided. */
interface Draft {
  world: UnitWorld
  origins: string[]
  groups: BootGroup[]
  shape: UnitShape
}

const hasSources = (draft: Draft): boolean =>
  draft.groups.some((group) => group.js.length > 0 || group.css.length > 0)

const everyOrigin = (draft: Draft): boolean =>
  draft.origins.length === 1 && draft.origins[0] === '*'

/** The files a draft's script would embed, in group order. */
const draftFiles = (draft: Draft): string[] =>
  draft.groups.flatMap((group) => [...group.js, ...group.css])

/**
 * The drafts `foldUnits` weighs, by world: whole units (the main world's; every world's where
 * the host has no isolated worlds – with them the other worlds' rule sets go thin and carry no
 * bootstrap to save) with sources of their own over hostname rules, in a world that has more
 * than `FOLD_ABOVE_UNITS` of them.
 */
function foldCandidates(drafts: Map<string, Draft>, env: UnitEnvironment): Map<UnitWorld, Draft[]> {
  const byWorld = new Map<UnitWorld, Draft[]>()
  for (const draft of drafts.values()) {
    if (draft.world !== 'main' && env.isolatedWorlds) continue
    if (everyOrigin(draft) || !hasSources(draft)) continue
    const list = byWorld.get(draft.world)
    if (list) list.push(draft)
    else byWorld.set(draft.world, [draft])
  }
  for (const [world, list] of [...byWorld])
    if (list.length <= FOLD_ABOVE_UNITS) byWorld.delete(world)
  return byWorld
}

/**
 * Fold a world's many hostname units into few: the candidates (`foldCandidates`) whose files
 * the host sized (`env.fileChars`) and that fit `FOLD_UNIT_CHARS` alone are packed, smallest
 * first, into units of at most that many chars of sources, each over the union of its members'
 * rules with all their groups. A frame matching any of the rules receives the folded script
 * and the bootstrap runs the groups whose own patterns match it – `decideFrameBoot` decides
 * per group in the frame, the rules only pre-filter the injection – so what runs where is what
 * ran before; the frame holds the bucket's other sources besides, which the cap bounds. A unit
 * over the cap alone, or naming a file the host could not size, keeps its own rules.
 */
function foldUnits(drafts: Map<string, Draft>, env: UnitEnvironment): void {
  const fileChars = env.fileChars
  if (!fileChars) return
  for (const [world, candidates] of foldCandidates(drafts, env)) {
    const measured = candidates
      .map((draft) => {
        let chars = 0
        for (const path of draftFiles(draft)) {
          const size = fileChars[path]
          if (size === undefined) return { draft, chars: Infinity }
          chars += size
        }
        return { draft, chars }
      })
      .filter(({ chars }) => chars <= FOLD_UNIT_CHARS)
      .sort(
        (a, b) =>
          a.chars - b.chars ||
          unitKey(world, a.draft.origins).localeCompare(unitKey(world, b.draft.origins))
      )
    const buckets: Array<{ members: Draft[]; chars: number }> = []
    for (const { draft, chars } of measured) {
      const open = buckets[buckets.length - 1]
      if (open && open.chars + chars <= FOLD_UNIT_CHARS) {
        open.members.push(draft)
        open.chars += chars
      } else buckets.push({ members: [draft], chars })
    }
    for (const { members } of buckets) {
      if (members.length < 2) continue
      for (const member of members) drafts.delete(unitKey(world, member.origins))
      const origins = sortedOrigins(members.flatMap((member) => member.origins))
      const groups = members.flatMap((member) => member.groups)
      const key = unitKey(world, origins)
      const standing = drafts.get(key)
      if (standing) standing.groups.push(...groups)
      else drafts.set(key, { world, origins, groups, shape: 'whole' })
    }
  }
}

/**
 * The files whose sizes `planUnits` needs to fold this extension's units, sorted, or null when
 * the plan has nothing to fold: the runtime asks the host for them (`ext.fileSizes`) and plans
 * with `env.fileChars` set; a plan made without them folds nothing.
 */
export function foldFilesFor(
  boot: ExtensionBoot,
  manifest: RuntimeManifest,
  env: UnitEnvironment
): string[] | null {
  const candidates = foldCandidates(draftUnits(boot, manifest, env), env)
  if (candidates.size === 0) return null
  const files = new Set<string>()
  for (const list of candidates.values())
    for (const draft of list) for (const path of draftFiles(draft)) files.add(path)
  return [...files].sort()
}

/** The units before their shapes: one draft per world and rule set, the sourceless ones folded into the world's `*` unit. */
function draftUnits(
  boot: ExtensionBoot,
  manifest: RuntimeManifest,
  env: UnitEnvironment
): Map<string, Draft> {
  const drafts = new Map<string, Draft>()
  const add = (world: UnitWorld, origins: string[], groups: BootGroup[]): void => {
    const key = unitKey(world, origins)
    const draft = drafts.get(key)
    if (draft) draft.groups.push(...groups)
    else drafts.set(key, { world, origins, groups: [...groups], shape: 'whole' })
  }
  for (const group of mergeAlikeGroups(boot.groups)) {
    add(worldOf(group), sortedOrigins(originRulesFor(group.matches)), [group])
  }
  // The pages `externally_connectable.matches` lets speak to the extension need a main-world
  // copy of the bootstrap: it installs the page API (`chrome.runtime.sendMessage` / `connect`
  // taking the extension's id) on the page's own `chrome` where a pattern covers the frame, and
  // an engine behind it for the extension's `onMessageExternal` / `onConnectExternal`. Every
  // main-world unit carries the patterns, so origins a `world: "MAIN"` declaration's unit
  // already covers need no second copy (Speak Subtitles' MAIN scripts and its connectable pages
  // are both www.youtube.com); the rest get one unit without sources.
  if (boot.externallyConnectable && boot.externallyConnectable.length > 0) {
    const covered = new Set<string>()
    for (const draft of drafts.values())
      if (draft.world === 'main') for (const origin of draft.origins) covered.add(origin)
    if (!covered.has('*')) {
      const wanted = sortedOrigins(originRulesFor(boot.externallyConnectable))
      const missing = wanted.filter((origin) => !covered.has(origin))
      if (missing.length > 0) add('main', missing, [])
    }
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
  // A unit over every origin runs everywhere anyway: that world's units WITHOUT sources of their
  // own (the transport over the host permissions, the connectable pages' copy) fold into it, so
  // a page receives one copy of the bootstrap per world rather than one per origin rule set. A
  // unit with sources keeps its own rules, as Chrome hands a frame the scripts whose patterns it
  // matches alone: folded, its files ride into every frame of every origin – tl;dv's
  // meet.google.com and calendar.google.com scripts (8.1 and 6.7 MB) beside its `<all_urls>`
  // one (8.1 MB) made one 20.7 M-char unit for every frame, and the WebView's one renderer grew
  // to 2.3 GB on a Meet page until the guest's low-memory killer took it, and the chrome and
  // every tab with it (compat round 18). A frame matching several rule sets pays one more copy
  // of the bootstrap (162 KB) per set instead.
  for (const world of ['isolated', 'main', 'user'] as const) {
    const everywhere = drafts.get(unitKey(world, ['*']))
    if (!everywhere) continue
    for (const [key, draft] of [...drafts]) {
      if (draft.world !== world || draft === everywhere) continue
      if (hasSources(draft)) continue
      everywhere.groups.push(...draft.groups)
      drafts.delete(key)
    }
  }
  return drafts
}

/** Plan the units and served files of one extension from its boot record. */
export function planUnits(
  boot: ExtensionBoot,
  manifest: RuntimeManifest,
  env: UnitEnvironment
): ExtensionUnits {
  const drafts = draftUnits(boot, manifest, env)
  // Many hostname rule sets with sources in one world: folded by size, where the host sized
  // the files (see `foldUnits` and `FOLD_ABOVE_UNITS`).
  foldUnits(drafts, env)
  // The extension's isolated world with several rule sets: one bootstrap for the world (see
  // `UnitShape`). Its `*`-rule unit carries it and runs as before; a world without one gets a
  // holder that only defines it; the other sets attach. The main world keeps whole units: its
  // global is the page's, and a carrier there would be a name the page can see.
  if (env.isolatedWorlds) {
    const isolated = [...drafts.values()].filter((draft) => draft.world === 'isolated')
    if (isolated.length >= 2) {
      const everywhereKey = unitKey('isolated', ['*'])
      let everywhere = drafts.get(everywhereKey)
      if (everywhere) everywhere.shape = 'carrier'
      else {
        everywhere = { world: 'isolated', origins: ['*'], groups: [], shape: 'holder' }
        drafts.set(everywhereKey, everywhere)
      }
      for (const draft of isolated) if (draft !== everywhere) draft.shape = 'thin'
    }
  }
  const isolationFor = (world: UnitWorld): IsolationMode =>
    world === 'main' ? 'none' : env.isolatedWorlds ? 'world' : 'with'
  const bootstrapsFirst = (shape: UnitShape): number =>
    shape === 'carrier' || shape === 'holder' ? 0 : 1
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
        ...(draft.world === 'user' ? { userScriptMessaging: env.userScriptMessaging } : {}),
        ...(env.messageLimit ? { messageLimit: env.messageLimit } : {})
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
        shape: draft.shape,
        config,
        groups: groups
          .filter((group) => group.js.length > 0)
          .map((group) => ({ ext: boot.id, index: group.index, js: group.js, isolation })),
        css: groups.flatMap((group) => group.css.map((path) => ({ ext: boot.id, path })))
      }
    })
    // The host registers the units in this order and the WebView runs them in it: a world's
    // carrier or holder ahead of the units that attach to it.
    .sort(
      (a, b) =>
        a.world.localeCompare(b.world) ||
        bootstrapsFirst(a.shape) - bootstrapsFirst(b.shape) ||
        a.key.localeCompare(b.key)
    )
  const background = manifest.background
  const page: Omit<PageBootConfig, 'context'> = {
    kind: 'page',
    token: env.token,
    uiLanguage: env.uiLanguage,
    extension: { ...boot, groups: [] },
    ...(env.messageLimit ? { messageLimit: env.messageLimit } : {})
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
