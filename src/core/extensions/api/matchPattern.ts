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
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const hostPart = rest.slice(0, slash)
  const pathPart = rest.slice(slash)
  if (scheme === 'file') {
    if (hostPart !== '') return null
  } else if (hostPart === '') {
    return null
  }
  const schemes = scheme === '*' ? new Set(['http', 'https']) : new Set([scheme])
  const portMatch = hostPart.match(/:(\d+|\*)$/)
  const port = portMatch ? portMatch[1] : null
  const hostName = portMatch ? hostPart.slice(0, -portMatch[0].length) : hostPart
  let hostTest: (host: string) => boolean
  if (hostName === '*' || scheme === 'file') {
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
  const pathTest = globToRegExp(pathPart)
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

/** Glob where `*` matches any run of characters (Chrome's title and path globs). */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (const ch of glob) {
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.+^${}()|[\]\\]/, '\\$&')
  }
  return new RegExp(`^${source}$`)
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
