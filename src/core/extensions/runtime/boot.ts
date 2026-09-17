import type { LocaleMessages, RunAt, RuntimeManifest, ScriptWorld } from './manifest'
import { planInjection, type RegisteredContentScript } from './plan'

/**
 * What the host hands the page bootstrap (the script injected at document start into every tab)
 * and the extension-page bootstrap (background page, popup, options page). It is JSON: the host
 * embeds it verbatim into the injected script, next to the content-script sources.
 *
 * Isolation of content scripts in the page's (only) JavaScript world:
 *  - `shadow`: every file of a declaration runs inside one function whose `window`, `self` and
 *    `globalThis` parameters are a Proxy over the real window. Expandos land in a per-extension
 *    store, reads of browser globals fall through to the real window, page globals read as
 *    undefined; bare identifiers still resolve through the real global scope, so a file reading
 *    `forTrusted` after another wrote `globalThis.forTrusted` throws (Vimium). Cheap: no dynamic
 *    scope.
 *  - `with`: the same function body sits inside `with (window)` where `window` is that Proxy, so
 *    bare identifiers resolve through the store and the browser's globals first. Faithful for the
 *    expando pattern; every free identifier lookup becomes a `has` plus a `get` trap. The default.
 *  - `none`: run against the real window (what `world: "MAIN"` declarations get).
 *  - `world`: the host injects the unit into a real Chromium isolated world (androidx.webkit
 *    `JS_INJECTION_IN_FRAME_AND_WORLD`, Chromium 146+ WebView). The world's own global is the
 *    content scripts' `window`; the bootstrap adds `chrome` to it and no proxy is involved. Used
 *    when the host reports the capability, otherwise `with`.
 */
export type IsolationMode = 'shadow' | 'with' | 'none' | 'world'

/** The isolated world an extension's content scripts run in on hosts that have real worlds. */
export const worldNameFor = (extensionId: string): string => `zenium-ext-${extensionId}`

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
  manifestVersion: 2 | 3
  permissions: string[]
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
  extensions: ExtensionBoot[]
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

/** Build the per-extension boot record from a parsed manifest (static plus registered scripts). */
export function buildExtensionBoot(
  id: string,
  manifest: RuntimeManifest,
  messages: LocaleMessages | null,
  registered: RegisteredContentScript[],
  isolation: IsolationMode
): ExtensionBoot {
  const plan = planInjection(id, manifest, registered)
  return {
    id,
    name: manifest.name,
    manifestVersion: manifest.manifestVersion,
    permissions: manifest.permissions,
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
  return '/' + path.replace(/^\/+/, '')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}
