/**
 * The filters of the enabled lists that apply to top-level documents, decided the way uBlock
 * Origin does: a network filter without a type option never blocks the document itself; only
 * `$document` (`$doc`) and `$all` filters do, `$important` blocks beat exceptions, and an
 * `@@…$document` exception whitelists the page and every request it makes. Ghostery's engine
 * folds `$all` into "any type", so the desktop decides navigations here and asks it only about
 * subresources; the Kotlin engine (`NetworkFilter.kt`) applies the same rule natively.
 *
 * Two forms. {@link DocumentFilters.parse} reads filter-list text; {@link DocumentFilters.serialize}
 * writes the accepted filters out as they were read – each line once, with what its parse
 * decided (its flags, where its pattern ends, the host it is anchored to, its domain options) –
 * and {@link DocumentFilters.deserialize} reads that back without parsing a line again, so a
 * host can parse the lists once off its main thread and adopt the result in milliseconds. A
 * pattern's predicate is compiled on first use in either form: a `||host…` pattern waits in the
 * host map for a navigation to its host, so a deserialise compiles nothing and a navigation
 * compiles only its own host's few patterns.
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
  /** Index in `line` of the `$` that starts the options: the pattern is what comes before it. */
  patternEnd: number
  exception: boolean
  important: boolean
  /** `$match-case`: the pattern is matched case-sensitively. */
  caseSensitive: boolean
  /** `$domain=` / `$to=` hosts the filter is limited to, lowercased. */
  domains: string[] | null
  /** `$domain=~x` / `$denyallow=` hosts it never applies to. */
  excludedDomains: string[] | null
  /**
   * The hostname a `||host…` pattern is anchored to, lowercased – its bucket in the host map,
   * where a navigation finds it by the hostname's suffixes – or null for every other pattern.
   */
  host: string | null
  /**
   * The pattern the URL is tested against: a `urlFilter` or a `/regex/`. Null for a plain
   * `||host^` filter, which its host decides alone.
   */
  pattern: string | null
  /** `pattern` compiled, on first use ({@link testOf}). */
  test: UrlPredicate | null
}

/**
 * The serialised form's format number, the first element of the JSON array
 * {@link DocumentFilters.serialize} writes. Bumped when the form's shape changes, so a blob an
 * older build wrote is refused by {@link DocumentFilters.deserialize} (the caller then parses
 * the text) rather than read wrong.
 */
export const DOCUMENT_FILTERS_FORMAT = 1

/** The flag bits of a serialised filter. */
const FLAG_EXCEPTION = 1
const FLAG_IMPORTANT = 2
const FLAG_CASE_SENSITIVE = 4
/** A plain `||host^` filter: its host decides alone, it has no pattern to test. */
const FLAG_HOST_ONLY = 8

const OPTIONS_RE = /^[~a-z0-9_-]+(=[^,]*)?(,\s*[~a-z0-9_-]+(=[^,]*)?)*$/i
const HOST_ONLY_RE = /^\|\|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\^?$/i
/**
 * A `||host` anchor with more pattern after the hostname – `||host/path`, `||host^x`,
 * `||host|`, `||host?q`, `||host:8080` – where the character after the hostname cannot be part
 * of one, so a URL the pattern matches has that hostname or one under it. `||host*` is not one
 * (`||example.com*` matches `example.community`), nor is `||host` cut short before a separator.
 */
const HOST_ANCHOR_RE = /^\|\|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?=[/^|?:])/i
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

function isRegexPattern(pattern: string): boolean {
  return pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')
}

/**
 * The filter's pattern predicate, compiled the first time it is asked for. A `/regex/` the
 * parse accepted compiles; one a serialised form carries that does not (another build's
 * engine, in principle) matches nothing rather than throwing into a navigation.
 */
function testOf(f: DocumentFilter): UrlPredicate {
  if (f.test) return f.test
  const pattern = f.pattern ?? ''
  if (isRegexPattern(pattern)) {
    const re = compileRegexFilter(pattern.slice(1, -1), f.caseSensitive)
    f.test = re ? (url) => re.test(url) : () => false
  } else {
    f.test = compileUrlFilter(pattern, f.caseSensitive)
  }
  return f.test
}

/** Whether `f`, found by its host or among the patterns, matches `url` (its host already did). */
function matches(f: DocumentFilter, url: string): boolean {
  return f.pattern === null || testOf(f)(url)
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
  let kept: string | null = pattern
  let test: UrlPredicate | null = null
  if (hostOnly) {
    host = (hostOnly[1] ?? '').toLowerCase()
    kept = null
  } else if (isRegexPattern(pattern)) {
    // Compiled now: a regular expression that does not compile is not a filter.
    const re = compileRegexFilter(pattern.slice(1, -1), caseSensitive)
    if (!re) return null
    test = (url) => re.test(url)
  } else {
    const anchored = HOST_ANCHOR_RE.exec(pattern)
    if (anchored) host = (anchored[1] ?? '').toLowerCase()
  }
  return {
    line: raw.trim(),
    patternEnd: at,
    exception,
    important,
    caseSensitive,
    domains,
    excludedDomains,
    host,
    pattern: kept,
    test
  }
}

/**
 * The serialised form: the format number, then the filters column by column – every accepted
 * line, and per line its flag bits, where its pattern ends and how long the hostname its `||`
 * anchors to is (0 when none) – and, for the few filters with `$domain=`-style options, their
 * lists by the filter's index. A line is written once; the pattern and the host are read back
 * out of it by those offsets, so the form is about the size of the lines and decodes as fast as
 * JSON does, and the same filters always give the same bytes.
 */
type SerialisedForm = [
  format: number,
  lines: string[],
  flags: number[],
  patternEnds: number[],
  hostLengths: number[],
  domainOptions: SerialisedDomains[]
]
type SerialisedDomains = [index: number, domains: string[] | null, excludedDomains: string[] | null]

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isColumn<T>(
  value: unknown,
  length: number,
  ok: (entry: unknown) => entry is T
): value is T[] {
  return Array.isArray(value) && value.length === length && value.every(ok)
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/** The domain lists of a serialised form by filter index, or null when an entry is malformed. */
function domainsOf(
  entries: unknown,
  count: number
): Map<number, [string[] | null, string[] | null]> | null {
  if (!Array.isArray(entries)) return null
  const out = new Map<number, [string[] | null, string[] | null]>()
  for (const entry of entries as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3) return null
    const [index, domains, excludedDomains] = entry as unknown[]
    if (!isIndex(index) || index >= count) return null
    if (domains !== null && !isStringList(domains)) return null
    if (excludedDomains !== null && !isStringList(excludedDomains)) return null
    out.set(index, [domains, excludedDomains])
  }
  return out
}

/**
 * The filter at `index` of a serialised form whose columns were checked, or null when its
 * offsets do not fit its line or it is host-only without a host (it would match every URL).
 */
function filterOf(
  form: SerialisedForm,
  index: number,
  domainOptions: Map<number, [string[] | null, string[] | null]>
): DocumentFilter | null {
  const line = form[1][index] ?? ''
  const flags = form[2][index] ?? 0
  const patternEnd = form[3][index] ?? 0
  const hostLength = form[4][index] ?? 0
  const exception = (flags & FLAG_EXCEPTION) !== 0
  const start = exception ? 2 : 0
  if (patternEnd < start || patternEnd > line.length) return null
  const body = line.slice(start, patternEnd)
  // A host sits after the `||`; a pattern without one may be as short as `a`, `*` or nothing.
  if (hostLength !== 0 && 2 + hostLength > body.length) return null
  const hostOnly = (flags & FLAG_HOST_ONLY) !== 0
  if (hostOnly && hostLength === 0) return null
  const host = hostLength === 0 ? null : body.slice(2, 2 + hostLength).toLowerCase()
  const options = domainOptions.get(index)
  return {
    line,
    patternEnd,
    exception,
    important: (flags & FLAG_IMPORTANT) !== 0,
    caseSensitive: (flags & FLAG_CASE_SENSITIVE) !== 0,
    domains: options ? options[0] : null,
    excludedDomains: options ? options[1] : null,
    host,
    pattern: hostOnly ? null : body,
    test: null
  }
}

export class DocumentFilters {
  /** Every accepted filter, in the order its line was read (the order {@link lines} keeps). */
  private readonly filters: DocumentFilter[] = []
  /** The filters anchored to a hostname (`||host^`, `||host/path`, …), by that hostname. */
  private readonly hosts = new Map<string, DocumentFilter[]>()
  /** The filters no hostname anchors: tested against every navigation. */
  private readonly patterns: DocumentFilter[] = []
  /** The accepted lines, so a host can cache them and parse the subset instead of the lists. */
  readonly lines: string[] = []

  static readonly EMPTY: DocumentFilters = new DocumentFilters()

  private add(f: DocumentFilter): void {
    this.filters.push(f)
    this.lines.push(f.line)
    if (f.host === null) {
      this.patterns.push(f)
    } else {
      const bucket = this.hosts.get(f.host)
      if (bucket) bucket.push(f)
      else this.hosts.set(f.host, [f])
    }
  }

  /**
   * The accepted filters as bytes (UTF-8 JSON, the {@link SerialisedForm}: the format number,
   * then the filters column by column in line order), for {@link deserialize}. The same lines
   * give the same bytes, so a digest can name the result; a parse and the form it was read back
   * from write the same bytes.
   */
  serialize(): Uint8Array {
    const form: SerialisedForm = [DOCUMENT_FILTERS_FORMAT, [], [], [], [], []]
    this.filters.forEach((f, index) => {
      form[1].push(f.line)
      form[2].push(
        (f.exception ? FLAG_EXCEPTION : 0) |
          (f.important ? FLAG_IMPORTANT : 0) |
          (f.caseSensitive ? FLAG_CASE_SENSITIVE : 0) |
          (f.pattern === null ? FLAG_HOST_ONLY : 0)
      )
      form[3].push(f.patternEnd)
      // The hostname the regular expressions accept is ASCII, so lowercasing kept its length.
      form[4].push(f.host === null ? 0 : f.host.length)
      if (f.domains || f.excludedDomains) form[5].push([index, f.domains, f.excludedDomains])
    })
    return new TextEncoder().encode(JSON.stringify(form))
  }

  /**
   * The filters {@link serialize} wrote, read back without parsing a line: the same lines in
   * the same order, deciding the same. Throws on bytes that are not a serialised form, on
   * another {@link DOCUMENT_FILTERS_FORMAT} (a blob another build wrote), and on a form whose
   * columns do not describe filters: the caller falls back to {@link parse} of the text it
   * keeps beside the bytes.
   */
  static deserialize(bytes: Uint8Array): DocumentFilters {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!Array.isArray(parsed) || parsed.length === 0)
      throw new Error('document filters: not a serialised form')
    if (parsed[0] !== DOCUMENT_FILTERS_FORMAT)
      throw new Error(
        `document filters: format ${String(parsed[0])}, this build reads ${DOCUMENT_FILTERS_FORMAT}`
      )
    const malformed = (): Error => new Error('document filters: malformed form')
    const [, lines, flags, patternEnds, hostLengths, domainOptions] = parsed as unknown[]
    if (parsed.length !== 6 || !Array.isArray(lines) || !lines.every(isString)) throw malformed()
    const count = lines.length
    if (
      !isColumn(flags, count, isIndex) ||
      !isColumn(patternEnds, count, isIndex) ||
      !isColumn(hostLengths, count, isIndex)
    )
      throw malformed()
    const domains = domainsOf(domainOptions, count)
    if (!domains) throw malformed()
    const form: SerialisedForm = [
      DOCUMENT_FILTERS_FORMAT,
      lines,
      flags,
      patternEnds,
      hostLengths,
      []
    ]
    const out = new DocumentFilters()
    for (let index = 0; index < count; index++) {
      const f = filterOf(form, index, domains)
      if (!f) throw malformed()
      out.add(f)
    }
    return out
  }

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
        if (f) out.add(f)
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
            if ((!exceptionsOnly || f.exception) && applies(f, host) && matches(f, url))
              found.push(f)
        }
        const dot = host.indexOf('.', start)
        if (dot === -1) break
        start = dot + 1
      }
    }
    for (const f of this.patterns) {
      if ((!exceptionsOnly || f.exception) && applies(f, host) && matches(f, url)) found.push(f)
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
