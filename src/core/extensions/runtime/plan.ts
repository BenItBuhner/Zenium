import type { ContentScriptDeclaration, RuntimeManifest, RunAt, ScriptWorld } from './manifest'
import { runAtOrder } from './scheduling'

/**
 * Extensions get a synthetic secure origin per id. `.invalid` is reserved (RFC 2606) so a request
 * the host fails to intercept can never reach the network. Every extension page, popup and
 * web-accessible resource is served from it, which gives each extension its own storage,
 * cookies and CSP context, the way `chrome-extension://<id>` does in Chrome.
 */
export const EXTENSION_ORIGIN_SUFFIX = '.ext.zenium.invalid'

export function extensionOrigin(id: string): string {
  return `https://${id}${EXTENSION_ORIGIN_SUFFIX}`
}

/**
 * `chrome.runtime.getURL` semantics: leading slashes collapse onto the origin. Dot segments
 * resolve as a load of the URL resolves them: a manifest's `./background/background.js`
 * (WhatFont's worker) reaches the host as a request for `/background/background.js`, and the host
 * matches its own pages – the generated background document, a popup's hello – by the string.
 */
export function extensionUrl(id: string, path: string): string {
  return `${extensionOrigin(id)}/${resolveDotSegments(path.replace(/^\/+/, ''))}`
}

/**
 * `.` and `..` segments of an extension path resolved against its root, the query and fragment
 * left as they are; a path without them comes back untouched (no percent-encoding, no other
 * normalisation: `runtime.getURL` is a concatenation in Chrome too).
 */
export function resolveDotSegments(path: string): string {
  const cut = path.search(/[?#]/)
  const pathname = cut === -1 ? path : path.slice(0, cut)
  const rest = cut === -1 ? '' : path.slice(cut)
  if (!/(^|\/)\.\.?(\/|$)/.test(pathname)) return path
  const out: string[] = []
  const segments = pathname.split('/')
  for (const segment of segments) {
    if (segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  const last = segments[segments.length - 1]
  if ((last === '.' || last === '..') && (out.length === 0 || out[out.length - 1] !== ''))
    out.push('')
  return out.join('/') + rest
}

/** Inverse of `extensionUrl`; null for URLs that are not on an extension origin. */
export function parseExtensionUrl(url: string): { id: string; path: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith(EXTENSION_ORIGIN_SUFFIX))
    return null
  const id = parsed.hostname.slice(0, -EXTENSION_ORIGIN_SUFFIX.length)
  if (!/^[a-p]{32}$/.test(id)) return null
  return { id, path: decodeURIComponent(parsed.pathname.replace(/^\/+/, '')) }
}

/** A `scripting.registerContentScripts` entry, normalised like a manifest declaration. */
export interface RegisteredContentScript extends ContentScriptDeclaration {
  id: string
  persistAcrossSessions: boolean
}

/**
 * One group of files to inject together: the files of a declaration share a scope (Chrome runs
 * every file of one declaration, and of the whole extension, in a single isolated world).
 */
export interface InjectionGroup {
  /** Stable per (extension, declaration) so the bootstrap can report which groups ran. */
  index: number
  runAt: RunAt
  world: ScriptWorld
  js: string[]
  css: string[]
  declaration: ContentScriptDeclaration
}

export interface InjectionPlan {
  id: string
  origin: string
  groups: InjectionGroup[]
  /** Distinct JS paths across groups, in first-use order (what the host must read). */
  jsFiles: string[]
  cssFiles: string[]
}

/** Plan the content-script injection of one extension (static declarations plus registered ones). */
export function planInjection(
  id: string,
  manifest: RuntimeManifest,
  registered: RegisteredContentScript[] = []
): InjectionPlan {
  const declarations: ContentScriptDeclaration[] = [...manifest.contentScripts, ...registered]
  const groups: InjectionGroup[] = declarations
    .map((declaration, index) => ({
      index,
      runAt: declaration.runAt,
      world: declaration.world,
      js: declaration.js,
      css: declaration.css,
      declaration
    }))
    .filter((group) => group.js.length > 0 || group.css.length > 0)
    .sort((a, b) => runAtOrder(a.runAt) - runAtOrder(b.runAt) || a.index - b.index)
  const jsFiles: string[] = []
  const cssFiles: string[] = []
  for (const group of groups) {
    for (const file of group.js) if (!jsFiles.includes(file)) jsFiles.push(file)
    for (const file of group.css) if (!cssFiles.includes(file)) cssFiles.push(file)
  }
  return { id, origin: extensionOrigin(id), groups, jsFiles, cssFiles }
}

/**
 * Whether `path` inside the extension may be fetched by a page on `pageUrl`
 * (`web_accessible_resources`). MV2 lists are visible to every origin; MV3 sets carry `matches`.
 */
export function isWebAccessible(
  manifest: RuntimeManifest,
  path: string,
  pageMatches: (patterns: string[]) => boolean
): boolean {
  const clean = path.replace(/^\/+/, '')
  for (const set of manifest.webAccessibleResources) {
    const hit = set.resources.some((resource) =>
      resourceGlobMatches(resource.replace(/^\/+/, ''), clean)
    )
    if (!hit) continue
    if (manifest.manifestVersion === 2 || set.matches.length === 0) return true
    if (pageMatches(set.matches)) return true
  }
  return false
}

function resourceGlobMatches(glob: string, path: string): boolean {
  if (!glob.includes('*')) return glob === path
  const re = new RegExp(
    '^' +
      glob
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
        .join('.*') +
      '$'
  )
  return re.test(path)
}
