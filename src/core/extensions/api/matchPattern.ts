/**
 * Chrome match patterns (`<all_urls>`, `*://*.example.com/*`, `file:///*`) compiled into URL
 * predicates, with the semantics `tabs.query({ url })`, host permissions and content-script
 * `matches` share: `*` as the scheme means http or https only, `*.host` covers the host itself
 * and every subdomain, the path is a glob where `*` matches any run of characters, and the URL
 * fragment is ignored.
 */

export interface CompiledMatchPattern {
  readonly pattern: string
  test(url: string): boolean
}

const ALL_URL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file', 'data', 'urn'])

const compiled = new Map<string, CompiledMatchPattern | null>()

/** Compile one pattern; `null` when it is not a valid match pattern. */
export function compileMatchPattern(pattern: string): CompiledMatchPattern | null {
  const cached = compiled.get(pattern)
  if (cached !== undefined) return cached
  const result = compileUncached(pattern)
  if (compiled.size > 2000) compiled.clear()
  compiled.set(pattern, result)
  return result
}

function compileUncached(pattern: string): CompiledMatchPattern | null {
  if (pattern === '<all_urls>') {
    return {
      pattern,
      test: (url) => {
        const scheme = schemeOf(url)
        return scheme !== null && ALL_URL_SCHEMES.has(scheme)
      }
    }
  }
  const separator = pattern.indexOf('://')
  if (separator <= 0) {
    if (pattern.startsWith('data:') || pattern.startsWith('urn:')) {
      const scheme = pattern.slice(0, pattern.indexOf(':'))
      const rest = globToRegExp(pattern.slice(scheme.length + 1))
      return {
        pattern,
        test: (url) => schemeOf(url) === scheme && rest.test(url.slice(scheme.length + 1))
      }
    }
    return null
  }
  const scheme = pattern.slice(0, separator)
  const rest = pattern.slice(separator + 3)
  if (scheme === 'file') {
    // Chromium's grammar: a file pattern has no host, so everything after `file://` is the
    // path glob and the URL's host is ignored (`file:///*` and Violentmonkey's
    // `file://*/*.user.js` both match `file:///home/me/a.user.js`).
    if (rest === '') return null
    const pathTest = pathGlobToRegExp(rest)
    return {
      pattern,
      test: (url) => {
        const parsed = parseUrl(url)
        return parsed !== null && parsed.scheme === 'file' && pathTest.test(parsed.path)
      }
    }
  }
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const hostPart = rest.slice(0, slash)
  const pathPart = rest.slice(slash)
  if (hostPart === '') return null
  const schemes = scheme === '*' ? new Set(['http', 'https']) : new Set([scheme])
  const portMatch = hostPart.match(/:(\d+|\*)$/)
  const port = portMatch ? portMatch[1] : null
  const hostName = portMatch ? hostPart.slice(0, -portMatch[0].length) : hostPart
  let hostTest: (host: string) => boolean
  if (hostName === '*') {
    hostTest = () => true
  } else if (hostName.startsWith('*.')) {
    const suffix = hostName.slice(2).toLowerCase()
    hostTest = (host) => host === suffix || host.endsWith(`.${suffix}`)
  } else if (hostName.includes('*')) {
    return null
  } else {
    const exact = hostName.toLowerCase()
    hostTest = (host) => host === exact
  }
  const pathTest = pathGlobToRegExp(pathPart)
  return {
    pattern,
    test: (url) => {
      const parsed = parseUrl(url)
      if (!parsed || !schemes.has(parsed.scheme)) return false
      if (!hostTest(parsed.host)) return false
      if (port !== null && port !== '*' && parsed.port !== port) return false
      return pathTest.test(parsed.path)
    }
  }
}

/** Whether `url` matches any of the given patterns (invalid patterns match nothing). */
export function matchesAnyPattern(url: string, patterns: string | readonly string[]): boolean {
  const list = typeof patterns === 'string' ? [patterns] : patterns
  for (const pattern of list) {
    const compiled = compileMatchPattern(pattern)
    if (compiled && compiled.test(url)) return true
  }
  return false
}

/** Whether every URL matched by `inner` is also matched by `outer` (best-effort containment). */
export function patternContains(outer: string, inner: string): boolean {
  if (outer === inner) return true
  if (outer === '<all_urls>') return compileMatchPattern(inner) !== null
  if (inner === '<all_urls>') return false
  const o = splitPattern(outer)
  const i = splitPattern(inner)
  if (!o || !i) return false
  const schemeOk =
    o.scheme === i.scheme || (o.scheme === '*' && (i.scheme === 'http' || i.scheme === 'https'))
  if (!schemeOk) return false
  const hostOk =
    o.host === '*' ||
    o.host === i.host ||
    (o.host.startsWith('*.') &&
      (i.host === o.host.slice(2) || i.host.endsWith(o.host.slice(1)) || i.host === o.host))
  if (!hostOk) return false
  if (o.path === '/*') return true
  return o.path === i.path
}

interface SplitPattern {
  scheme: string
  host: string
  path: string
}

function splitPattern(pattern: string): SplitPattern | null {
  const separator = pattern.indexOf('://')
  if (separator <= 0) return null
  const rest = pattern.slice(separator + 3)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  return {
    scheme: pattern.slice(0, separator),
    host: rest.slice(0, slash).toLowerCase(),
    path: rest.slice(slash)
  }
}

/** Glob where `*` matches any run of characters and `?` one (Chrome's title and include globs). */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (const ch of glob) {
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.+^${}()|[\]\\]/, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** The path part of a match pattern: only `*` is a wildcard, `?` starts the query and is literal. */
function pathGlobToRegExp(glob: string): RegExp {
  let source = ''
  for (const ch of glob) {
    if (ch === '*') source += '.*'
    else source += ch.replace(/[.+?^${}()|[\]\\]/, '\\$&')
  }
  return new RegExp(`^${source}$`, 's')
}

interface ParsedUrl {
  scheme: string
  host: string
  port: string
  path: string
}

function schemeOf(url: string): string | null {
  const colon = url.indexOf(':')
  if (colon <= 0) return null
  const scheme = url.slice(0, colon).toLowerCase()
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? scheme : null
}

function parseUrl(url: string): ParsedUrl | null {
  const scheme = schemeOf(url)
  if (!scheme) return null
  const withoutFragment = url.split('#')[0]
  const afterScheme = withoutFragment.slice(scheme.length + 1)
  if (!afterScheme.startsWith('//')) {
    return { scheme, host: '', port: '', path: afterScheme }
  }
  const authorityEnd = afterScheme.indexOf('/', 2)
  const authority = authorityEnd < 0 ? afterScheme.slice(2) : afterScheme.slice(2, authorityEnd)
  const path = authorityEnd < 0 ? '/' : afterScheme.slice(authorityEnd)
  const hostPort = authority.includes('@')
    ? authority.slice(authority.lastIndexOf('@') + 1)
    : authority
  let host = hostPort
  let port = ''
  const ipv6End = hostPort.startsWith('[') ? hostPort.indexOf(']') : -1
  const portColon = hostPort.lastIndexOf(':')
  if (portColon > ipv6End) {
    host = hostPort.slice(0, portColon)
    port = hostPort.slice(portColon + 1)
  }
  return { scheme, host: host.toLowerCase(), port, path }
}

// ---------------------------------------------------------------------------
// Structured patterns and content-script matching (hosts that plan injection themselves)
// ---------------------------------------------------------------------------

/** A match pattern taken apart, for hosts that plan injection by origin (`parseMatchPattern`). */
export interface MatchPattern {
  /** `*` stands for http and https; `<all_urls>` lists every scheme it covers. */
  schemes: string[]
  /** Lower-case host; `*` alone matches every host, `*.` prefix matches the domain and subdomains. */
  host: string
  /** null when the pattern has no explicit port (matches any). `*` matches any port too. */
  port: string | null
  /** Glob over path and query with `*` wildcards; starts with `/` except for `file:` patterns. */
  path: string
  matchesAllUrls: boolean
}

const STRUCTURED_PATTERN = /^([a-z*][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/is
const STRUCTURED_SCHEMES = new Set([...ALL_URL_SCHEMES, 'chrome-extension', 'chrome', 'about'])

/** Take a pattern apart (`null` when invalid); `compileMatchPattern` is the URL predicate. */
export function parseMatchPattern(pattern: string): MatchPattern | null {
  if (pattern === '<all_urls>') {
    return {
      schemes: [...ALL_URL_SCHEMES],
      host: '*',
      port: null,
      path: '/*',
      matchesAllUrls: true
    }
  }
  if (/^file:\/\/./i.test(pattern)) {
    // No host in a file pattern: the path glob is everything after `file://` (see
    // `compileMatchPattern`), which need not start with `/`.
    return {
      schemes: ['file'],
      host: '',
      port: null,
      path: pattern.slice(7),
      matchesAllUrls: false
    }
  }
  const m = STRUCTURED_PATTERN.exec(pattern)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  if (scheme !== '*' && !STRUCTURED_SCHEMES.has(scheme)) return null
  const hostPart = m[2]
  const path = m[3] ?? ''
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
  return {
    schemes: scheme === '*' ? ['http', 'https'] : [scheme],
    host,
    port,
    path,
    matchesAllUrls: false
  }
}

/** The declaration fields Chrome consults when deciding whether a content script runs in a frame. */
export interface ContentScriptMatch {
  matches: readonly string[]
  excludeMatches?: readonly string[]
  includeGlobs?: readonly string[]
  excludeGlobs?: readonly string[]
  allFrames?: boolean
  matchAboutBlank?: boolean
  matchOriginAsFallback?: boolean
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
export function effectiveMatchUrl(script: ContentScriptMatch, frame: FrameContext): string | null {
  const url = frame.url
  if (url === 'about:blank' || url === 'about:srcdoc' || url.startsWith('about:blank?')) {
    return script.matchAboutBlank || script.matchOriginAsFallback ? frame.precursorUrl : null
  }
  const scheme = schemeOf(url)
  if (scheme === 'data' || scheme === 'blob' || scheme === 'filesystem') {
    return script.matchOriginAsFallback ? frame.precursorUrl : null
  }
  return url
}

/** Chrome's decision for one declaration in one frame: matches, exclusions and the globs. */
export function contentScriptAppliesTo(script: ContentScriptMatch, frame: FrameContext): boolean {
  if (!frame.isTopFrame && !script.allFrames) return false
  const url = effectiveMatchUrl(script, frame)
  if (!url) return false
  if (!matchesAnyPattern(url, script.matches)) return false
  if (script.excludeMatches?.length && matchesAnyPattern(url, script.excludeMatches)) return false
  if (script.includeGlobs?.length && !script.includeGlobs.some((g) => globToRegExp(g).test(url)))
    return false
  if (script.excludeGlobs?.length && script.excludeGlobs.some((g) => globToRegExp(g).test(url)))
    return false
  return true
}
