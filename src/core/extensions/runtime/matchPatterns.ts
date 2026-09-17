import type { ContentScriptDeclaration } from './manifest'

/**
 * Chrome match patterns (`<scheme>://<host><path>`, `<all_urls>`) and the globs of
 * `include_globs` / `exclude_globs`, evaluated the way the extensions system evaluates them for
 * content scripts. Everything here is pure so it can run inside the page bootstrap as well as in
 * the browser core.
 */
export interface MatchPattern {
  /** `*` stands for http and https. */
  schemes: string[]
  /** Lower-case host; `*` alone matches every host, `*.` prefix matches the domain and subdomains. */
  host: string
  /** null when the pattern has no explicit port (matches any). `*` matches any port too. */
  port: string | null
  /** Glob over path and query with `*` wildcards; always starts with `/`. */
  path: string
  matchesAllUrls: boolean
}

const ALL_URL_SCHEMES = ['http', 'https', 'file', 'ftp', 'ws', 'wss']
const KNOWN_SCHEMES = new Set([
  ...ALL_URL_SCHEMES,
  'chrome-extension',
  'urn',
  'data',
  'chrome',
  'about'
])
const PATTERN = /^([a-z*][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i

export function parseMatchPattern(pattern: string): MatchPattern | null {
  if (pattern === '<all_urls>') {
    return { schemes: ALL_URL_SCHEMES, host: '*', port: null, path: '/*', matchesAllUrls: true }
  }
  const m = PATTERN.exec(pattern)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  if (scheme !== '*' && !KNOWN_SCHEMES.has(scheme)) return null
  const hostPart = m[2]
  let path = m[3] ?? ''
  if (scheme === 'file') {
    if (hostPart !== '') return null
    if (path === '') return null
    return { schemes: ['file'], host: '', port: null, path, matchesAllUrls: false }
  }
  if (path === '') return null
  let host = hostPart.toLowerCase()
  let port: string | null = null
  const colon = host.lastIndexOf(':')
  if (colon !== -1 && !host.endsWith(']')) {
    port = host.slice(colon + 1)
    host = host.slice(0, colon)
    if (port !== '*' && !/^\d+$/.test(port)) return null
  }
  if (host === '') return null
  if (host.includes('*') && host !== '*' && !host.startsWith('*.')) return null
  if (host.startsWith('*.') && host.slice(2).includes('*')) return null
  if (!path.startsWith('/')) path = '/' + path
  return {
    schemes: scheme === '*' ? ['http', 'https'] : [scheme],
    host,
    port,
    path,
    matchesAllUrls: false
  }
}

/** Escape for RegExp, then turn `*` into `.*` (and `?` into `.` when `questionMark` is set). */
function globToRegExp(glob: string, questionMark: boolean): RegExp {
  let out = '^'
  for (const ch of glob) {
    if (ch === '*') out += '.*'
    else if (ch === '?' && questionMark) out += '.'
    else out += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(out + '$', 's')
}

const pathCache = new Map<string, RegExp>()
function pathRegExp(path: string): RegExp {
  let re = pathCache.get(path)
  if (!re) {
    re = globToRegExp(path, false)
    pathCache.set(path, re)
  }
  return re
}

export interface UrlParts {
  scheme: string
  host: string
  port: string
  /** Path plus query (`?…`), no fragment – what Chrome matches the path pattern against. */
  pathAndQuery: string
  href: string
}

export function splitUrl(url: string): UrlParts | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  return {
    scheme,
    host: parsed.hostname.toLowerCase(),
    port: parsed.port,
    pathAndQuery: parsed.pathname + parsed.search,
    href: parsed.href
  }
}

export function matchPatternTest(pattern: MatchPattern, parts: UrlParts): boolean {
  if (!pattern.schemes.includes(parts.scheme)) return false
  if (pattern.matchesAllUrls) return true
  if (pattern.schemes[0] !== 'file' || pattern.schemes.length > 1) {
    if (pattern.host !== '*') {
      if (pattern.host.startsWith('*.')) {
        const domain = pattern.host.slice(2)
        if (parts.host !== domain && !parts.host.endsWith('.' + domain)) return false
      } else if (parts.host !== pattern.host) {
        return false
      }
    }
    if (
      pattern.port !== null &&
      pattern.port !== '*' &&
      pattern.port !== (parts.port || defaultPort(parts.scheme))
    ) {
      return false
    }
  }
  return pathRegExp(pattern.path).test(parts.pathAndQuery)
}

function defaultPort(scheme: string): string {
  switch (scheme) {
    case 'http':
    case 'ws':
      return '80'
    case 'https':
    case 'wss':
      return '443'
    case 'ftp':
      return '21'
    default:
      return ''
  }
}

/** True when any of `patterns` (already parsed, invalid ones skipped) matches `url`. */
export function anyPatternMatches(patterns: string[], parts: UrlParts): boolean {
  for (const raw of patterns) {
    const pattern = parseMatchPattern(raw)
    if (pattern && matchPatternTest(pattern, parts)) return true
  }
  return false
}

export function globMatches(glob: string, url: string): boolean {
  return globToRegExp(glob, true).test(url)
}

export interface FrameContext {
  /** The frame's own URL. */
  url: string
  isTopFrame: boolean
  /**
   * For `about:blank` / `about:srcdoc` frames (match_about_blank) and data:/blob: frames
   * (match_origin_as_fallback): the URL whose origin the frame inherited (parent or opener).
   */
  precursorUrl: string | null
}

/** The URL a content script declaration is matched against for this frame, or null when none applies. */
export function effectiveMatchUrl(
  script: ContentScriptDeclaration,
  frame: FrameContext
): string | null {
  const parts = splitUrl(frame.url)
  const isAboutBlank =
    frame.url === 'about:blank' ||
    frame.url === 'about:srcdoc' ||
    frame.url.startsWith('about:blank?')
  if (isAboutBlank) {
    return script.matchAboutBlank || script.matchOriginAsFallback ? frame.precursorUrl : null
  }
  if (
    parts &&
    (parts.scheme === 'data' || parts.scheme === 'blob' || parts.scheme === 'filesystem')
  ) {
    return script.matchOriginAsFallback ? frame.precursorUrl : null
  }
  return frame.url
}

/** Chrome's decision for one declaration in one frame. */
export function contentScriptAppliesTo(
  script: ContentScriptDeclaration,
  frame: FrameContext
): boolean {
  if (!frame.isTopFrame && !script.allFrames) return false
  const url = effectiveMatchUrl(script, frame)
  if (!url) return false
  const parts = splitUrl(url)
  if (!parts) return false
  if (!anyPatternMatches(script.matches, parts)) return false
  if (script.excludeMatches.length && anyPatternMatches(script.excludeMatches, parts)) return false
  if (script.includeGlobs.length && !script.includeGlobs.some((g) => globMatches(g, parts.href)))
    return false
  if (script.excludeGlobs.length && script.excludeGlobs.some((g) => globMatches(g, parts.href)))
    return false
  return true
}

/**
 * Host permission check for a URL (`chrome.scripting`, `tabs.executeScript`, DNR host access):
 * any pattern in `hostPermissions` or, for MV2, the union with `<all_urls>` style permissions.
 */
export function hasHostPermission(hostPermissions: string[], url: string): boolean {
  const parts = splitUrl(url)
  return parts ? anyPatternMatches(hostPermissions, parts) : false
}
