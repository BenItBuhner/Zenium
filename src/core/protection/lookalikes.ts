import { hostnameOf, registrableDomain } from '../blocking/domain'
import { isNonUniqueHost } from '../../shared/nonUniqueHost'
import type { LookalikeReason, LookalikeVerdict } from '../../shared/privacy'

/**
 * The lookalike-domain check behind the `zen://error?kind=lookalike` warning (PS-18; Chrome's
 * lookalike interstitial, Edge's website typo protection): the registrable domain of a main-frame
 * http(s) navigation is held against the sites the user knows – a bundled list of the most
 * visited registrable domains on the web (Tranco, `resources/lookalikes/tranco-top.txt.gz`) and
 * the sites with engagement in the user's own history – by the three tests Chrome runs, each
 * named after Chrome's:
 *
 * - **edit distance one** (`edit-distance`): one substitution, one dropped or inserted character
 *   or one adjacent swap away from a target whose name is at least {@link MIN_EDIT_TARGET_LENGTH}
 *   characters long (`gooogle.com`, `amazom.com`; never a difference in the suffix alone –
 *   `google.co` is not a lookalike of `google.com`);
 * - **target embedding** (`embedding`): a target as a run of labels inside a longer host
 *   (`paypal.com.secure-login.example`) or as the hyphen-joined start of a label
 *   (`paypal-login.com`), unless the target itself owns the host's registrable domain;
 * - **IDN skeleton** (`skeleton`): the host with every confusable character replaced by the
 *   character it looks like (Unicode's `confusables.txt`, the rows whose prototype is a Latin
 *   letter, a digit or a hyphen – `resources/lookalikes/confusables.txt.gz`) equals a target:
 *   `аpple.com` with a Cyrillic а, `g00gle.com` with zeros, `rnicrosoft.com`.
 *
 * Never a word about a target itself, a site with engagement (`engaged`), a host the user chose to
 * continue to once (`allowed`, the `lookalike` permission), a non-unique host (an IP literal,
 * `localhost`, a name without a registrable suffix) or anything but http(s) – the callers keep
 * subframes and other schemes away. Cost: two `Set` lookups, one skeleton pass over the host and
 * a bounded scan of the targets (the top list, about {@link MAX_TOP_DOMAINS} short strings, plus
 * the engaged sites) with an early-exit distance-one test each – tens of microseconds, once per
 * main-frame navigation in the core, never per frame or per request of a page.
 */

/** A target's name (its registrable domain without the public suffix) must be this long to count for the edit-distance test. */
export const MIN_EDIT_TARGET_LENGTH = 5
/** The top list is cut here at load, whatever the file holds. */
export const MAX_TOP_DOMAINS = 2_500

export type { LookalikeReason, LookalikeVerdict }

/** The two bundled tables, as text: one registrable domain per line; `source ; target` rows. */
export interface LookalikeTables {
  topDomains: string
  confusables: string
}

/**
 * The confusables table: a source run of one or two code points → its prototype (lowercase ASCII).
 * Multi-character sources (`rn` → `m`, `vv` → `w`) are tried before single ones.
 */
export type ConfusableMap = Map<string, string>

const ASCII_TARGET = /^[a-z0-9-]+$/

/**
 * Parse the bundled `confusables.txt` subset (Unicode's format: `source ; target ; type # …`,
 * code points in hex): only rows whose lowercased target is made of Latin letters, digits and
 * hyphens are kept – the ones that can spell a hostname – and rows that map a character to itself.
 */
export function parseConfusables(text: string): ConfusableMap {
  const out: ConfusableMap = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(';')
    if (fields.length < 2) continue
    const source = codePoints(fields[0])
    const target = codePoints(fields[1]).toLowerCase()
    if (!source || !target || !ASCII_TARGET.test(target)) continue
    if (source === target) continue
    // Two code points at most on the source side: `rn`, `vv`, `cl`; longer runs never occur in
    // the Latin-target rows and would only slow the skeleton pass.
    if ([...source].length > 2) continue
    out.set(source, target)
  }
  return out
}

function codePoints(field: string): string {
  let out = ''
  for (const hex of field.trim().split(/\s+/)) {
    if (!/^[0-9A-Fa-f]{4,6}$/.test(hex)) return ''
    out += String.fromCodePoint(parseInt(hex, 16))
  }
  return out
}

/**
 * The skeleton of a lowercase host (UTS #39 §4): NFD, every confusable run replaced by its
 * prototype, NFD again. A host made of nothing but prototypes is its own skeleton.
 */
export function skeletonOf(host: string, confusables: ConfusableMap): string {
  const chars = [...host.normalize('NFD')]
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    const pair = i + 1 < chars.length ? chars[i] + chars[i + 1] : null
    const two = pair ? confusables.get(pair) : undefined
    if (two !== undefined) {
      out += two
      i++
      continue
    }
    const one = confusables.get(chars[i])
    out += one !== undefined ? one : chars[i]
  }
  return out.normalize('NFD')
}

/**
 * Damerau–Levenshtein distance of exactly one between two strings (a substitution, a deletion,
 * an insertion or one adjacent transposition), in one pass with an early exit; false for equal
 * strings and for anything further apart.
 */
export function isEditDistanceOne(a: string, b: string): boolean {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (a === b) return false
  let i = 0
  while (i < la && i < lb && a.charCodeAt(i) === b.charCodeAt(i)) i++
  if (la === lb) {
    // A substitution, or an adjacent swap.
    if (a.slice(i + 1) === b.slice(i + 1)) return true
    return (
      i + 1 < la &&
      a.charCodeAt(i) === b.charCodeAt(i + 1) &&
      a.charCodeAt(i + 1) === b.charCodeAt(i) &&
      a.slice(i + 2) === b.slice(i + 2)
    )
  }
  // One dropped (or inserted) character: the rest must agree.
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

/**
 * The name of a registrable domain – its first label, the public suffix being the rest
 * (`google.com` → `google`, `bbc.co.uk` → `bbc`).
 */
function nameOf(domain: string): string {
  const dot = domain.indexOf('.')
  return dot === -1 ? domain : domain.slice(0, dot)
}

/** The public suffix of a registrable domain (`google.com` → `com`, `bbc.co.uk` → `co.uk`). */
function suffixOf(domain: string): string {
  const dot = domain.indexOf('.')
  return dot === -1 ? '' : domain.slice(dot + 1)
}

/**
 * RFC 3492 Punycode, one label: `xn--pple-43d` → `аpple`. The URL parser hands hostnames over in
 * their ASCII form, and the skeleton needs the characters the user saw. A malformed label comes
 * back as it was.
 */
export function decodePunycodeLabel(label: string): string {
  if (!label.startsWith('xn--')) return label
  const input = label.slice(4)
  if (!input) return label
  const base = 36
  const tMin = 1
  const tMax = 26
  const skew = 38
  const damp = 700
  let n = 128
  let i = 0
  let bias = 72
  const basic = input.lastIndexOf('-')
  const output: number[] = []
  for (let j = 0; j < Math.max(basic, 0); j++) {
    const c = input.charCodeAt(j)
    if (c >= 0x80) return label
    output.push(c)
  }
  const digit = (c: number): number =>
    c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base
  const adapt = (delta: number, numPoints: number, first: boolean): number => {
    let d = first ? Math.floor(delta / damp) : delta >> 1
    d += Math.floor(d / numPoints)
    let k = 0
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin))
      k += base
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + skew))
  }
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length;) {
    const oldI = i
    let w = 1
    for (let k = base; ; k += base) {
      if (index >= input.length) return label
      const d = digit(input.charCodeAt(index++))
      if (d >= base) return label
      i += d * w
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias
      if (d < t) break
      w *= base - t
    }
    const len = output.length + 1
    bias = adapt(i - oldI, len, oldI === 0)
    n += Math.floor(i / len)
    i %= len
    if (n > 0x10ffff) return label
    output.splice(i++, 0, n)
  }
  return String.fromCodePoint(...output)
}

/** A hostname with its IDN labels decoded to the characters they show (`xn--…` → Unicode). */
export function unicodeHost(host: string): string {
  return host.includes('xn--') ? host.split('.').map(decodePunycodeLabel).join('.') : host
}

/** What `check` needs from the browser besides the URL. */
export interface LookalikeContext {
  /** Registrable domains with engagement (typed visits in history): never warned about, and targets in their own right. */
  engaged: ReadonlySet<string>
  /** The user continued to this host once (the `lookalike` permission). */
  allowed(host: string): boolean
}

/**
 * The tables and the three tests. Built once from the bundled text (`load`); `check` is
 * synchronous and cheap thereafter – until the tables are loaded it answers null, as Chrome's
 * throttle does before its top-domain data is ready.
 */
export class LookalikeChecker {
  private top = new Set<string>()
  /** The top domains that qualify as edit-distance targets, once, so the scan carries no repeated length checks. */
  private editTargets: string[] = []
  /** Each top domain by its own skeleton (`microsoft.com` → `rnicrosoft.corn`, since Unicode's prototype of `m` is `rn`). */
  private topBySkeleton = new Map<string, string>()
  private confusables: ConfusableMap = new Map()
  private loaded = false

  get ready(): boolean {
    return this.loaded
  }

  /** How many registrable domains the top list holds (the status card, the tests). */
  get topCount(): number {
    return this.top.size
  }

  load(tables: LookalikeTables): void {
    const top = new Set<string>()
    for (const raw of tables.topDomains.split('\n')) {
      const line = raw.trim().toLowerCase()
      if (!line || line.startsWith('#')) continue
      // A ranked CSV row (`1,google.com`) or a bare domain.
      const domain = line.includes(',') ? line.slice(line.lastIndexOf(',') + 1) : line
      if (!domain.includes('.') || domain.includes('/')) continue
      top.add(domain)
      if (top.size >= MAX_TOP_DOMAINS) break
    }
    this.top = top
    this.editTargets = [...top].filter((d) => nameOf(d).length >= MIN_EDIT_TARGET_LENGTH)
    this.confusables = parseConfusables(tables.confusables)
    this.topBySkeleton = new Map()
    for (const domain of top) {
      const skeleton = skeletonOf(domain, this.confusables)
      if (!this.topBySkeleton.has(skeleton)) this.topBySkeleton.set(skeleton, domain)
    }
    this.loaded = true
  }

  isTopDomain(domain: string): boolean {
    return this.top.has(domain)
  }

  /**
   * The verdict on a main-frame navigation to `url`: the target it looks like and why, or null
   * when it is nobody's lookalike (or the tables are not loaded yet).
   */
  check(url: string, context: LookalikeContext): LookalikeVerdict | null {
    if (!this.loaded || !/^https?:\/\//i.test(url)) return null
    const ascii = hostnameOf(url)
    if (!ascii || isNonUniqueHost(ascii) || !ascii.includes('.')) return null
    const host = unicodeHost(ascii)
    const domain = registrableDomain(host)
    if (this.top.has(domain) || context.engaged.has(domain)) return null
    if (context.allowed(ascii) || context.allowed(domain) || context.allowed(host)) return null
    return (
      this.skeletonMatch(domain, context) ??
      this.editDistanceMatch(domain, context) ??
      this.embeddingMatch(host, domain, context)
    )
  }

  private isTarget(domain: string, context: LookalikeContext): boolean {
    return this.top.has(domain) || context.engaged.has(domain)
  }

  /**
   * Skeletons are compared to skeletons (UTS #39: `m`'s prototype is `rn`, so `microsoft.com`
   * and `rnicrosoft.com` share one), the top list's precomputed at load, the engaged sites' –
   * a handful – here.
   */
  private skeletonMatch(domain: string, context: LookalikeContext): LookalikeVerdict | null {
    const skeleton = skeletonOf(domain, this.confusables)
    const top = this.topBySkeleton.get(skeleton)
    if (top && top !== domain) return { target: top, reason: 'skeleton' }
    for (const site of context.engaged)
      if (site !== domain && skeletonOf(site, this.confusables) === skeleton)
        return { target: site, reason: 'skeleton' }
    return null
  }

  private editDistanceMatch(domain: string, context: LookalikeContext): LookalikeVerdict | null {
    const name = nameOf(domain)
    // A one-character name can be nothing's neighbour worth a warning; a difference in the
    // suffix alone (`google.co`) is a sibling site, not a lookalike.
    const near = (target: string): boolean =>
      isEditDistanceOne(domain, target) && nameOf(target) !== name
    for (const target of context.engaged)
      if (nameOf(target).length >= MIN_EDIT_TARGET_LENGTH && near(target))
        return { target, reason: 'edit-distance' }
    for (const target of this.editTargets)
      if (near(target)) return { target, reason: 'edit-distance' }
    return null
  }

  private embeddingMatch(
    host: string,
    domain: string,
    context: LookalikeContext
  ): LookalikeVerdict | null {
    const labels = host.split('.')
    const domainStart = labels.length - domain.split('.').length
    for (let i = 0; i < labels.length; i++) {
      // A target as a run of labels: `paypal.com` inside `paypal.com.secure-login.example`. The
      // run that starts at the host's own registrable domain is that domain, not an embedding
      // (`google.com.br` is no lookalike of `google.com` – the target's name owns the suffix).
      if (i !== domainStart) {
        for (let take = 2; take <= Math.min(4, labels.length - i - 1); take++) {
          const run = labels.slice(i, i + take).join('.')
          if (this.isTarget(run, context) && run !== domain)
            return { target: run, reason: 'embedding' }
        }
      }
      // A target's name as the hyphen-joined start of a label: `paypal-login.com`,
      // `google-secure.example`. The name must be a target's under the host's own suffix or
      // under `.com`, the suffix the imitated names overwhelmingly carry.
      const hyphen = labels[i].indexOf('-')
      if (hyphen >= MIN_EDIT_TARGET_LENGTH) {
        const name = labels[i].slice(0, hyphen)
        for (const suffix of new Set([suffixOf(domain), 'com'])) {
          const target = suffix ? `${name}.${suffix}` : name
          if (target !== domain && this.isTarget(target, context))
            return { target, reason: 'embedding' }
        }
      }
    }
    return null
  }
}

/** The reason in the warning page's words. */
export function describeLookalikeReason(
  reason: LookalikeReason,
  lookalike: string,
  target: string
): string {
  switch (reason) {
    case 'edit-distance':
      return `${lookalike} is one character off ${target}.`
    case 'embedding':
      return `${lookalike} contains the name ${target}, but is not part of that site.`
    case 'skeleton':
      return `${lookalike} is spelled with characters that look like those of ${target}.`
  }
}
