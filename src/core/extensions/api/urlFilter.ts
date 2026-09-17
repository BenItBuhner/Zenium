/**
 * Chrome's `events.UrlFilter`, the per-listener filter of `webNavigation.*` (and, in Chrome,
 * `webRequest` and the declarative content API): every condition present in one filter must
 * hold, a list of filters matches when any one of them does, and an empty list (or no filter
 * at all) matches every URL.
 *
 * Host conditions follow `URLMatcherConditionFactory`: the host is compared with a dot in front
 * of it, so `hostContains: '.foo'` matches `www.foobar.com` and `foo.com` but not `barfoo.com`,
 * and `hostSuffix` / `hostEquals` compare whole host names. The fragment is never part of the
 * URL the `url*` conditions see.
 */

export interface UrlFilter {
  hostContains?: string
  hostEquals?: string
  hostPrefix?: string
  hostSuffix?: string
  pathContains?: string
  pathEquals?: string
  pathPrefix?: string
  pathSuffix?: string
  queryContains?: string
  queryEquals?: string
  queryPrefix?: string
  querySuffix?: string
  urlContains?: string
  urlEquals?: string
  urlMatches?: string
  originAndPathMatches?: string
  urlPrefix?: string
  urlSuffix?: string
  schemes?: string[]
  ports?: Array<number | number[]>
}

const STRING_KEYS = [
  'hostContains',
  'hostEquals',
  'hostPrefix',
  'hostSuffix',
  'pathContains',
  'pathEquals',
  'pathPrefix',
  'pathSuffix',
  'queryContains',
  'queryEquals',
  'queryPrefix',
  'querySuffix',
  'urlContains',
  'urlEquals',
  'urlMatches',
  'originAndPathMatches',
  'urlPrefix',
  'urlSuffix'
] as const

const DEFAULT_PORTS: Record<string, number> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ftp: 21
}

interface Parts {
  scheme: string
  host: string
  port: number | null
  path: string
  query: string
  /** The URL without its fragment. */
  url: string
  originAndPath: string
}

function parts(url: string): Parts | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/, '')
  const explicit = parsed.port === '' ? null : Number(parsed.port)
  const port = explicit ?? DEFAULT_PORTS[scheme] ?? null
  const withoutFragment = parsed.href.split('#')[0]
  return {
    scheme,
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port,
    path: parsed.pathname,
    query: parsed.search.replace(/^\?/, ''),
    url: withoutFragment,
    originAndPath: parsed.origin === 'null' ? withoutFragment : parsed.origin + parsed.pathname
  }
}

function regexMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

/** Whether one `UrlFilter` accepts the URL (an empty filter accepts everything). */
export function matchesUrlFilter(url: string, filter: UrlFilter): boolean {
  const p = parts(url)
  if (!p) return false
  const dottedHost = `.${p.host}.`
  if (filter.hostContains !== undefined && !dottedHost.includes(filter.hostContains)) return false
  if (filter.hostEquals !== undefined && p.host !== filter.hostEquals.replace(/^\./, ''))
    return false
  if (filter.hostPrefix !== undefined && !p.host.startsWith(filter.hostPrefix.replace(/^\./, '')))
    return false
  if (filter.hostSuffix !== undefined && !p.host.endsWith(filter.hostSuffix)) return false
  if (filter.pathContains !== undefined && !p.path.includes(filter.pathContains)) return false
  if (filter.pathEquals !== undefined && p.path !== filter.pathEquals) return false
  if (filter.pathPrefix !== undefined && !p.path.startsWith(filter.pathPrefix)) return false
  if (filter.pathSuffix !== undefined && !p.path.endsWith(filter.pathSuffix)) return false
  if (filter.queryContains !== undefined && !p.query.includes(filter.queryContains)) return false
  if (filter.queryEquals !== undefined && p.query !== filter.queryEquals.replace(/^\?/, ''))
    return false
  if (
    filter.queryPrefix !== undefined &&
    !p.query.startsWith(filter.queryPrefix.replace(/^\?/, ''))
  )
    return false
  if (filter.querySuffix !== undefined && !p.query.endsWith(filter.querySuffix)) return false
  if (filter.urlContains !== undefined && !p.url.includes(filter.urlContains)) return false
  if (filter.urlEquals !== undefined && p.url !== filter.urlEquals) return false
  if (filter.urlPrefix !== undefined && !p.url.startsWith(filter.urlPrefix)) return false
  if (filter.urlSuffix !== undefined && !p.url.endsWith(filter.urlSuffix)) return false
  if (filter.urlMatches !== undefined && !regexMatches(filter.urlMatches, p.url)) return false
  if (
    filter.originAndPathMatches !== undefined &&
    !regexMatches(filter.originAndPathMatches, p.originAndPath)
  )
    return false
  if (filter.schemes !== undefined && !filter.schemes.includes(p.scheme)) return false
  if (filter.ports !== undefined) {
    if (p.port === null) return false
    const port = p.port
    const hit = filter.ports.some((entry) =>
      Array.isArray(entry)
        ? entry.length === 2 && port >= entry[0] && port <= entry[1]
        : entry === port
    )
    if (!hit) return false
  }
  return true
}

/** Whether any filter of the list accepts the URL; an empty list accepts everything. */
export function matchesAnyUrlFilter(url: string, filters: readonly UrlFilter[]): boolean {
  if (filters.length === 0) return true
  return filters.some((filter) => matchesUrlFilter(url, filter))
}

/**
 * The `{ url: UrlFilter[] }` argument of `addListener(callback, filters)`, validated. Returns
 * `null` when the listener is unfiltered (no argument, no `url` list, or an empty list) and
 * throws Chrome's error for anything malformed.
 */
export function normalizeEventFilters(raw: unknown): UrlFilter[] | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Invalid filter object.')
  }
  const list = (raw as { url?: unknown }).url
  if (list === undefined || list === null) return null
  if (!Array.isArray(list)) throw new TypeError("Invalid value for 'url': expected an array.")
  const out: UrlFilter[] = []
  for (const entry of list) {
    const filter = normalizeUrlFilter(entry)
    if (!filter) throw new TypeError('Invalid url filter.')
    out.push(filter)
  }
  return out.length === 0 ? null : out
}

/** One `UrlFilter`, keeping only the keys Chrome defines; `null` when it is not an object. */
export function normalizeUrlFilter(raw: unknown): UrlFilter | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const out: UrlFilter = {}
  for (const key of STRING_KEYS) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== 'string') return null
    out[key] = value
  }
  if (input.schemes !== undefined) {
    if (!Array.isArray(input.schemes) || input.schemes.some((s) => typeof s !== 'string'))
      return null
    out.schemes = input.schemes as string[]
  }
  if (input.ports !== undefined) {
    if (!Array.isArray(input.ports)) return null
    const ports: Array<number | number[]> = []
    for (const entry of input.ports) {
      if (typeof entry === 'number' && Number.isInteger(entry)) ports.push(entry)
      else if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every((n) => typeof n === 'number' && Number.isInteger(n))
      )
        ports.push([entry[0], entry[1]])
      else return null
    }
    out.ports = ports
  }
  return out
}
