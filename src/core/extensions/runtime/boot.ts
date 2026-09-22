import type { LocaleMessages, RunAt, RuntimeManifest, ScriptWorld } from './manifest'
import { planInjection, resolveDotSegments, type RegisteredContentScript } from './plan'

/**
 * What the host hands the content bootstrap (the script injected at document start into tab
 * frames) and the extension-page bootstrap (background page, popup, options page). It is JSON:
 * the host embeds it verbatim into the injected script, next to the content-script sources.
 *
 * How content scripts are kept apart from the page:
 *  - `world`: the unit runs in a real Chromium isolated world of its own (androidx.webkit
 *    `JS_INJECTION_IN_FRAME_AND_WORLD`, Chromium 146+ WebView). The world's global is the
 *    content scripts' `window`, `chrome` simply lives on it, and the page's script cannot reach
 *    either. The default wherever the WebView has worlds.
 *  - `with`: the fallback for older WebViews. Every file of a declaration runs inside one
 *    function whose body sits in `with (window)`, where `window` is a Proxy over the real window:
 *    expandos land in a per-extension store, reads of browser globals fall through to the real
 *    window, page globals read as undefined, and bare identifiers resolve through the store and
 *    the browser's globals first. Faithful for the expando pattern, but the page shares the
 *    prototypes and can observe the scripts' DOM work: the host reports `reducedIsolation`.
 *  - `none`: run against the real window (what `world: "MAIN"` declarations get).
 */
export type IsolationMode = 'with' | 'none' | 'world'

/**
 * Which of an extension's worlds a content unit belongs to: its isolated world (content scripts),
 * the page's main world (`world: "MAIN"` declarations) or its user-script world
 * (`chrome.userScripts`, messaging only).
 */
export type UnitWorld = 'isolated' | 'main' | 'user'

/** The isolated world an extension's scripts run in on hosts that have real worlds. */
export function worldNameFor(extensionId: string, world: 'isolated' | 'user' = 'isolated'): string {
  return world === 'user' ? `zenium-ext-${extensionId}-user` : `zenium-ext-${extensionId}`
}

export interface BootGroup {
  index: number
  runAt: RunAt
  world: ScriptWorld
  matches: string[]
  excludeMatches: string[]
  includeGlobs: string[]
  excludeGlobs: string[]
  allFrames: boolean
  matchAboutBlank: boolean
  matchOriginAsFallback: boolean
  /** Extension-relative paths; the host embeds their sources as one function per group. */
  js: string[]
  /** Extension-relative paths; the host embeds their texts in the config. */
  css: string[]
}

export interface ExtensionBoot {
  id: string
  name: string
  version: string
  manifestVersion: 2 | 3
  /**
   * The API permissions the extension holds: the manifest's required ones and the optional
   * ones `permissions.request` granted so far (Chrome's granted set, what `permissions.getAll`
   * lists). A context's `chrome.<namespace>` exists for these.
   */
  permissions: string[]
  /**
   * The manifest's `optional_permissions` (API ones), not granted yet: the namespaces a later
   * `permissions.request` may define in a running context, as Chrome's bindings do on a grant.
   */
  optionalPermissions: string[]
  hostPermissions: string[]
  /** The raw manifest, for `chrome.runtime.getManifest()`. */
  manifest: Record<string, unknown>
  messages: LocaleMessages | null
  groups: BootGroup[]
  isolation: IsolationMode
}

export interface ContentBootConfig {
  kind: 'content'
  token: string
  uiLanguage: string
  /** The world this unit runs in; `user` units build a user-script engine (messaging only). */
  world: UnitWorld
  /** `user` units: `userScripts.configureWorld({ messaging })`, off by default like Chrome. */
  userScriptMessaging?: boolean
  /**
   * A late boot: the host evaluates the bootstrap in the main world of a document that predates
   * the extension's world (or on a WebView without worlds) so that `scripting.executeScript` /
   * `insertCSS` have a scope to run in. No groups, `with` isolation, reduced isolation.
   */
  late?: boolean
  extension: ExtensionBoot
}

/** One content-script group's run, as the debug bootstrap records it (`__zenExtStats`). */
export interface BootGroupStat {
  ext: string
  group: number
  runAt: RunAt
  /** ms since the bootstrap started when the group ran. */
  at: number
  /** ms the group's own code took. */
  ms: number
  /** `document.readyState` and the number of nodes under `<html>` when the group ran. */
  readyState: string
  nodes: number
  error: string | null
}

/** What a debug bootstrap exposes per world as `__zenExtStats` (the doc-start budget). */
export interface BootStats {
  frame: string
  world: UnitWorld | 'page'
  isolation: IsolationMode
  /** ms after the navigation started when the bootstrap began running. */
  startedAt: number
  /** ms spent matching declarations against the frame. */
  matchMs: number
  /** ms the bootstrap itself took (transport, matching, scheduling; not the scripts). */
  bootMs: number
  applied: number
  groups: BootGroupStat[]
  /** The Trusted Types shield of an isolated world: policy created, sinks patched. */
  trustedTypes: { policy: boolean; patched: number } | null
  /**
   * This copy's bridge traffic so far: messages it posted to the host (`hostBound`) and messages
   * the host delivered to it (`pageBound`), every unit of the world counted together. The frame
   * budget reads the two around a scroll for the messages per second the runtime moved.
   */
  bridge: { hostBound: number; pageBound: number }
  /**
   * The first uncaught errors of the document after the bootstrap ran (a debug world's
   * capturing `error` listener), with the stack and, for a script the page holds inline (an
   * element a content script wrote), the source around the throw: a console line names such a
   * script `<document URL>:1` only.
   */
  errors?: BootErrorStat[]
  /**
   * The same for the sub-frames the bootstrap left alone (an inherited-origin frame under the
   * `with` fallback with no declaration opting in): an uncaught error inside such a frame is
   * dispatched to the frame's own window, never to the parent's listeners, so the frame's copy
   * of the bootstrap records it here, on the parent's stats.
   */
  frameErrors?: BootErrorStat[]
  /**
   * The sub-frames the bootstrap left alone, `"<frame URL> < <precursor URL>"` each, in the
   * order their copies ran (the sweep's proof that the frame filter met a given frame).
   */
  untouchedFrames?: string[]
}

export interface BootErrorStat {
  message: string
  source: string
  line: number
  column: number
  stack: string | null
  /** ms after the navigation started. */
  at: number
  /** The throwing inline script's text around the column (`document.currentScript`). */
  inline: string | null
  /** The sub-frame's document URL when the error is a sub-frame's; null for the document's own. */
  frame: string | null
}

export type PageContext = 'background' | 'popup' | 'options' | 'offscreen' | 'page'

export interface PageBootConfig {
  kind: 'page'
  token: string
  uiLanguage: string
  context: PageContext
  extension: ExtensionBoot
}

export type BootConfig = ContentBootConfig | PageBootConfig

/**
 * Build the per-extension boot record from a parsed manifest (static plus registered scripts).
 * `grantedOptional`: the optional API permissions the host holds as granted (a
 * `permissions.request` answered, kept across sessions); they join the required ones in the
 * boot's granted set and leave the optional list.
 */
export function buildExtensionBoot(
  id: string,
  manifest: RuntimeManifest,
  messages: LocaleMessages | null,
  registered: RegisteredContentScript[],
  isolation: IsolationMode,
  grantedOptional: readonly string[] = []
): ExtensionBoot {
  const plan = planInjection(id, manifest, registered)
  const granted = manifest.optionalPermissions.filter((p) => grantedOptional.includes(p))
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    manifestVersion: manifest.manifestVersion,
    permissions: granted.length > 0 ? [...manifest.permissions, ...granted] : manifest.permissions,
    optionalPermissions: manifest.optionalPermissions.filter((p) => !granted.includes(p)),
    hostPermissions: manifest.hostPermissions,
    manifest: manifest.raw,
    messages,
    groups: plan.groups.map((group) => ({
      index: group.index,
      runAt: group.runAt,
      world: group.world,
      matches: group.declaration.matches,
      excludeMatches: group.declaration.excludeMatches,
      includeGlobs: group.declaration.includeGlobs,
      excludeGlobs: group.declaration.excludeGlobs,
      allFrames: group.declaration.allFrames,
      matchAboutBlank: group.declaration.matchAboutBlank,
      matchOriginAsFallback: group.declaration.matchOriginAsFallback,
      js: group.js,
      css: group.css
    })),
    isolation
  }
}

/**
 * The HTML of the generated background page (Chrome's `_generated_background_page.html`). The
 * bootstrap arrives through the host's document-start injection, so the page only needs the
 * scripts; a module service worker keeps `type="module"` so its imports resolve.
 */
export function backgroundPageHtml(manifest: RuntimeManifest): string {
  const background = manifest.background
  const tags: string[] = []
  if (background?.kind === 'service_worker') {
    const type = background.module ? ' type="module"' : ''
    tags.push(`<script${type} src="${escapeAttribute(absolutePath(background.script))}"></script>`)
  } else if (background?.kind === 'scripts') {
    for (const script of background.scripts)
      tags.push(`<script src="${escapeAttribute(absolutePath(script))}"></script>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeText(manifest.name)}</title></head><body>${tags.join('')}</body></html>`
}

export function absolutePath(path: string): string {
  return '/' + resolveDotSegments(path.replace(/^\/+/, ''))
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}
