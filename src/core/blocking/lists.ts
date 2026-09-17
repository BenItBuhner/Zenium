/**
 * Filter-list text utilities shared by the updater, the persistence layer and the Settings UI:
 * header parsing, filter classification and normalisation of the hosts-file style lists people
 * paste in as custom lists.
 */

export interface ListHeader {
  title: string | null
  version: string | null
  /** `! Expires:` in milliseconds, or null when the list has none. */
  expiresMs: number | null
  homepage: string | null
  licence: string | null
}

const HEADER_RE = /^!\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(.+?)\s*$/

/** Read the `! Key: value` header block that starts every ABP list (stops at the first filter). */
export function parseListHeader(text: string): ListHeader {
  const out: ListHeader = {
    title: null,
    version: null,
    expiresMs: null,
    homepage: null,
    licence: null
  }
  let seen = 0
  for (const line of lines(text, 60)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('[')) continue
    if (!trimmed.startsWith('!')) {
      // The header ends with the first filter; a few lists put comments after it, so keep going
      // a little for late `! Expires:` lines but never far.
      if (++seen > 5) break
      continue
    }
    const m = HEADER_RE.exec(trimmed)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2]
    if (key === 'title' && !out.title) out.title = value
    else if (key === 'version' && !out.version) out.version = value
    else if (key === 'homepage' && !out.homepage) out.homepage = value
    else if ((key === 'licence' || key === 'license') && !out.licence) out.licence = value
    else if (key === 'expires' && out.expiresMs === null) out.expiresMs = parseExpires(value)
  }
  return out
}

/** `4 days`, `12 hours (update frequency)`, `1 day` → milliseconds. */
export function parseExpires(value: string): number | null {
  const m = /^(\d+)\s*(day|days|d|hour|hours|h)\b/i.exec(value.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return m[2].toLowerCase().startsWith('h') ? n * 3_600_000 : n * 86_400_000
}

function* lines(text: string, max = Infinity): Generator<string> {
  let start = 0
  let count = 0
  while (start < text.length && count < max) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    yield text.slice(start, end)
    start = end + 1
    count++
  }
}

/** Cosmetic (element hiding / scriptlet / HTML filtering) separators. */
const COSMETIC_RE = /#[@?$%]{0,2}#/

export function isCosmeticFilter(line: string): boolean {
  return COSMETIC_RE.test(line)
}

/**
 * Is this line a network filter (something the request engines act on)? Comments, cosmetic
 * filters and uBlock-only directives are not.
 */
export function isNetworkFilter(line: string): boolean {
  const t = line.trim()
  if (!t || t.startsWith('!') || t.startsWith('[') || t.startsWith('#')) return false
  if (COSMETIC_RE.test(t)) return false
  return true
}

/** Count network filters in a list – what Settings shows next to each list. */
export function countNetworkFilters(text: string): number {
  let count = 0
  for (const line of lines(text)) if (isNetworkFilter(line)) count++
  return count
}

const HOSTS_LINE_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+([a-z0-9][a-z0-9.-]*)(?:\s+.*)?$/i
const BARE_HOST_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i
const LOCAL_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'local',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
  'ip6-localnet',
  'ip6-mcastprefix',
  'ip6-allnodes',
  'ip6-allrouters',
  'ip6-allhosts',
  '0.0.0.0'
])

export interface PreparedList {
  /** Network filters only, one per line, LF separated. */
  text: string
  count: number
}

/**
 * What both engines store for a list: its network filters, one per line. Comments, headers and
 * cosmetic filters are dropped (neither request engine acts on them, and they are a large share
 * of EasyList); hosts-file lines (`0.0.0.0 ads.example`) and bare hostnames become `||host^`
 * filters so a pasted hosts list works as a filter list, as it does in uBlock Origin.
 */
export function prepareListText(raw: string): PreparedList {
  const out: string[] = []
  for (const line of lines(raw)) {
    const t = line.trim()
    if (!t || t.startsWith('!') || t.startsWith('[') || t.startsWith('#')) continue
    if (COSMETIC_RE.test(t)) continue
    const hosts = HOSTS_LINE_RE.exec(t)
    if (hosts) {
      const host = hosts[1].toLowerCase()
      if (!LOCAL_HOSTS.has(host)) out.push(`||${host}^`)
      continue
    }
    if (BARE_HOST_RE.test(t)) {
      out.push(`||${t.toLowerCase()}^`)
      continue
    }
    out.push(t)
  }
  return { text: out.join('\n'), count: out.length }
}

export interface FilterSyntaxError {
  /** 1-based line number. */
  line: number
  message: string
}

const KNOWN_OPTIONS = new Set([
  'script',
  'image',
  'stylesheet',
  'object',
  'xmlhttprequest',
  'xhr',
  'subdocument',
  'frame',
  'document',
  'doc',
  'websocket',
  'ping',
  'beacon',
  'media',
  'font',
  'other',
  'popup',
  'popunder',
  'third-party',
  '3p',
  'first-party',
  '1p',
  'important',
  'match-case',
  'elemhide',
  'ehide',
  'generichide',
  'ghide',
  'genericblock',
  'specifichide',
  'shide',
  'badfilter',
  'all',
  'inline-script',
  'inline-font',
  'strict1p',
  'strict3p',
  'webrtc',
  'cname',
  'csp_report',
  'object-subrequest',
  'empty',
  'mp4',
  'ipaddress'
])
const VALUE_OPTIONS = new Set([
  'domain',
  'from',
  'to',
  'redirect',
  'redirect-rule',
  'rewrite',
  'csp',
  'removeparam',
  'queryprune',
  'method',
  'header',
  'permissions',
  'replace',
  'urltransform',
  'uritransform',
  'denyallow',
  'ipaddress',
  'reason'
])

/**
 * Cheap validation of the user's own filters so Settings can point at the broken line. Accepts
 * everything either engine understands and flags what neither will ever act on.
 */
export function validateFilterText(text: string): FilterSyntaxError[] {
  const errors: FilterSyntaxError[] = []
  let n = 0
  for (const raw of lines(text)) {
    n++
    const line = raw.trim()
    if (!line || line.startsWith('!') || line.startsWith('[')) continue
    if (COSMETIC_RE.test(line)) continue
    let body = line.startsWith('@@') ? line.slice(2) : line
    if (body.startsWith('/') && body.length > 2) {
      const close = body.lastIndexOf('/')
      if (close > 0) {
        const source = body.slice(1, close)
        try {
          new RegExp(source)
        } catch {
          errors.push({ line: n, message: 'Invalid regular expression' })
          continue
        }
        body = body.slice(close + 1)
        if (body && !body.startsWith('$')) {
          errors.push({ line: n, message: 'Text after the closing / of a regular expression' })
          continue
        }
      }
    }
    const dollar = body.lastIndexOf('$')
    if (dollar > 0 && !body.startsWith('/')) {
      const options = body.slice(dollar + 1).split(',')
      for (const raw of options) {
        const opt = raw.trim()
        if (!opt) {
          errors.push({ line: n, message: 'Empty option' })
          break
        }
        const eq = opt.indexOf('=')
        const name = (eq === -1 ? opt : opt.slice(0, eq)).replace(/^~/, '').toLowerCase()
        if (eq === -1 ? !KNOWN_OPTIONS.has(name) : !VALUE_OPTIONS.has(name)) {
          errors.push({ line: n, message: `Unknown option "${name}"` })
          break
        }
      }
      body = body.slice(0, dollar)
    }
    if (!body || body === '||' || body === '|' || body === '*') {
      errors.push({ line: n, message: 'The filter matches every request' })
    }
  }
  return errors
}
