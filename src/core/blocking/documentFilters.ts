/**
 * The filters of the enabled lists that apply to top-level documents, decided the way uBlock
 * Origin does: a network filter without a type option never blocks the document itself; only
 * `$document` (`$doc`) and `$all` filters do, `$important` blocks beat exceptions, and an
 * `@@…$document` exception whitelists the page and every request it makes. Ghostery's engine
 * folds `$all` into "any type", so the desktop decides navigations here and asks it only about
 * subresources; the Kotlin engine (`NetworkFilter.kt`) applies the same rule natively.
 */

import { hostnameOf } from './domain'
import { isCosmeticFilter } from './lists'
import { compileRegexFilter, compileUrlFilter, type UrlPredicate } from './urlFilter'

export interface DocumentMatch {
  action: 'block' | 'allow'
  /** The filter line that decided. */
  filter: string
}

interface DocumentFilter {
  line: string
  exception: boolean
  important: boolean
  /** `$domain=` / `$to=` hosts the filter is limited to, lowercased. */
  domains: string[] | null
  /** `$domain=~x` / `$denyallow=` hosts it never applies to. */
  excludedDomains: string[] | null
  /** The hostname of a `||host^` pattern (kept in the host map), or null. */
  host: string | null
  /** The pattern predicate of every other filter. */
  test: UrlPredicate | null
}

const OPTIONS_RE = /^[~a-z0-9_-]+(=[^,]*)?(,\s*[~a-z0-9_-]+(=[^,]*)?)*$/i
const HOST_ONLY_RE = /^\|\|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\^?$/i
const DOCUMENT_TYPES = new Set(['document', 'doc', 'all'])
/** Options that make a line something other than a plain block or exception. */
const NOT_A_BLOCK = new Set([
  'csp',
  'removeparam',
  'queryprune',
  'redirect',
  'redirect-rule',
  'rewrite',
  'replace',
  'header',
  'permissions',
  'urltransform',
  'uritransform',
  'urlskip',
  'elemhide',
  'ehide',
  'generichide',
  'ghide',
  'specifichide',
  'shide',
  'genericblock',
  'popup',
  'popunder',
  'inline-script',
  'inline-font',
  'cname',
  'ipaddress'
])
const THIRD_PARTY = new Set(['third-party', '3p', 'strict3p'])
const FIRST_PARTY = new Set(['first-party', '1p', 'strict1p'])

/** Index of the `$` that starts the options, or -1 (a `$` inside a regular expression is skipped). */
export function optionsIndex(line: string): number {
  let i = line.lastIndexOf('$')
  while (i > 0) {
    if (i < line.length - 1 && OPTIONS_RE.test(line.slice(i + 1))) return i
    i = line.lastIndexOf('$', i - 1)
  }
  return -1
}

function hostMatches(host: string, domains: string[]): boolean {
  for (const d of domains) {
    if (
      host === d ||
      (host.length > d.length && host.endsWith(d) && host[host.length - d.length - 1] === '.')
    )
      return true
  }
  return false
}

function applies(f: DocumentFilter, host: string): boolean {
  if (f.excludedDomains && hostMatches(host, f.excludedDomains)) return false
  if (f.domains && !hostMatches(host, f.domains)) return false
  return true
}

function parseLine(raw: string): DocumentFilter | null {
  let line = raw.trim()
  if (!line || line.startsWith('!') || line.startsWith('[') || line.startsWith('#')) return null
  if (isCosmeticFilter(line)) return null
  const at = optionsIndex(line)
  if (at === -1) return null
  let exception = false
  if (line.startsWith('@@')) {
    exception = true
    line = line.slice(2)
  }
  const dollar = at - (exception ? 2 : 0)
  const pattern = line.slice(0, dollar)
  let forDocuments = false
  let important = false
  let caseSensitive = false
  let domains: string[] | null = null
  let excludedDomains: string[] | null = null
  for (const rawOption of line.slice(dollar + 1).split(',')) {
    let option = rawOption.trim()
    if (!option) continue
    const negated = option.startsWith('~')
    if (negated) option = option.slice(1)
    const eq = option.indexOf('=')
    const name = (eq === -1 ? option : option.slice(0, eq)).toLowerCase()
    const value = eq === -1 ? '' : option.slice(eq + 1)
    if (DOCUMENT_TYPES.has(name)) {
      if (negated) return null
      forDocuments = true
    } else if (name === 'badfilter' || NOT_A_BLOCK.has(name)) {
      return null
    } else if (THIRD_PARTY.has(name)) {
      // A document is its own initiator, so a third-party filter can never match it.
      if (!negated) return null
    } else if (FIRST_PARTY.has(name)) {
      if (negated) return null
    } else if (name === 'important') {
      important = true
    } else if (name === 'match-case') {
      caseSensitive = true
    } else if (name === 'domain' || name === 'from' || name === 'to') {
      for (const entry of value.split('|')) {
        const d = entry.trim().toLowerCase()
        if (!d) continue
        if (d.startsWith('~')) (excludedDomains ??= []).push(d.slice(1))
        else (domains ??= []).push(d)
      }
    } else if (name === 'denyallow') {
      for (const entry of value.split('|')) {
        const d = entry.trim().toLowerCase()
        if (d) (excludedDomains ??= []).push(d)
      }
    }
    // Other types (`script`, …) and method options neither add nor remove a document match.
  }
  if (!forDocuments) return null
  const hostOnly = HOST_ONLY_RE.exec(pattern)
  let host: string | null = null
  let test: UrlPredicate | null = null
  if (hostOnly) {
    host = (hostOnly[1] ?? '').toLowerCase()
  } else if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const re = compileRegexFilter(pattern.slice(1, -1), caseSensitive)
    if (!re) return null
    test = (url) => re.test(url)
  } else {
    test = compileUrlFilter(pattern, caseSensitive)
  }
  return { line: raw.trim(), exception, important, domains, excludedDomains, host, test }
}

export class DocumentFilters {
  /** Hostname-only filters (`||host^$document`), by hostname. */
  private readonly hosts = new Map<string, DocumentFilter[]>()
  private readonly patterns: DocumentFilter[] = []
  /** The accepted lines, so a host can cache them and parse the subset instead of the lists. */
  readonly lines: string[] = []

  static readonly EMPTY: DocumentFilters = new DocumentFilters()

  /** Parse the document-level filters out of filter-list text (one or more lists). */
  static parse(texts: Iterable<string>): DocumentFilters {
    const list = [...texts]
    const badfilters = new Set<string>()
    for (const text of list) {
      if (!text.includes('badfilter')) continue
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t.includes('badfilter')) continue
        const at = optionsIndex(t)
        if (at === -1) continue
        const kept = t
          .slice(at + 1)
          .split(',')
          .filter((o) => o.trim() !== 'badfilter')
        badfilters.add(kept.length ? `${t.slice(0, at + 1)}${kept.join(',')}` : t.slice(0, at))
      }
    }
    const out = new DocumentFilters()
    for (const text of list) {
      for (const line of text.split('\n')) {
        const t = line.trim()
        // Document filters always carry options.
        if (!t.includes('$') || (badfilters.size && badfilters.has(t))) continue
        const f = parseLine(t)
        if (!f) continue
        out.lines.push(f.line)
        if (f.host === null) {
          out.patterns.push(f)
        } else {
          const bucket = out.hosts.get(f.host)
          if (bucket) bucket.push(f)
          else out.hosts.set(f.host, [f])
        }
      }
    }
    return out
  }

  get size(): number {
    return this.lines.length
  }

  /** Every filter that applies to `url`, host map first. */
  private matching(url: string, exceptionsOnly: boolean): DocumentFilter[] {
    const host = hostnameOf(url) ?? ''
    const found: DocumentFilter[] = []
    if (host && this.hosts.size) {
      let start = 0
      for (;;) {
        const key = start === 0 ? host : host.slice(start)
        const list = this.hosts.get(key)
        if (list) {
          for (const f of list)
            if ((!exceptionsOnly || f.exception) && applies(f, host)) found.push(f)
        }
        const dot = host.indexOf('.', start)
        if (dot === -1) break
        start = dot + 1
      }
    }
    for (const f of this.patterns) {
      if ((!exceptionsOnly || f.exception) && applies(f, host) && f.test && f.test(url))
        found.push(f)
    }
    return found
  }

  /** The verdict for a navigation to `url`, or null when no document filter applies. */
  decide(url: string): DocumentMatch | null {
    if (this.lines.length === 0) return null
    const found = this.matching(url, false)
    if (found.length === 0) return null
    const important = found.find((f) => f.important && !f.exception)
    if (important) return { action: 'block', filter: important.line }
    const exception = found.find((f) => f.exception)
    if (exception) return { action: 'allow', filter: exception.line }
    const block = found[0]
    return block ? { action: 'block', filter: block.line } : null
  }

  /** The `@@…$document` exception that whitelists the page at `documentUrl`, or null. */
  exception(documentUrl: string): string | null {
    if (this.lines.length === 0) return null
    const found = this.matching(documentUrl, true)
    return found[0]?.line ?? null
  }
}
