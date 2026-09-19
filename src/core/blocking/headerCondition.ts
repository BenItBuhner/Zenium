/**
 * Response header conditions of declarativeNetRequest rules (`condition.responseHeaders` /
 * `condition.excludedResponseHeaders`), evaluated the way Chromium's
 * `MatchesHeaderConditions` (`ruleset_matcher_base.cc`) does: header names without regard to
 * case, values as `base::MatchPattern` globs (`*` any run, `?` zero or one character, `\`
 * escapes the next character) compared without regard to case.
 */
import type { HeaderCondition } from './rules'

interface CompiledHeaderCondition {
  /** Lowercase header name. */
  header: string
  values: RegExp[] | null
  excludedValues: RegExp[] | null
}

/** Received headers indexed by lowercase name. */
export type ReceivedHeaders = Map<string, string[]>

/** `base::MatchPattern` as a regular expression over the lowercase value. */
export function compileHeaderGlob(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') out += '.*'
    else if (c === '?') out += '.?'
    else {
      const literal = c === '\\' && i + 1 < pattern.length ? pattern[++i]! : c
      out += literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`, 'is')
}

function compileList(patterns: string[] | undefined): RegExp[] | null {
  return patterns && patterns.length > 0 ? patterns.map(compileHeaderGlob) : null
}

export function compileHeaderConditions(
  conditions: HeaderCondition[] | undefined
): CompiledHeaderCondition[] | null {
  if (!conditions || conditions.length === 0) return null
  return conditions.map((c) => ({
    header: c.header.toLowerCase(),
    values: compileList(c.values),
    excludedValues: compileList(c.excludedValues)
  }))
}

/** Index a host's header record (any name case, one entry per line) for matching. */
export function indexReceivedHeaders(headers: Record<string, string[]>): ReceivedHeaders {
  const out: ReceivedHeaders = new Map()
  for (const [name, values] of Object.entries(headers)) {
    const key = name.toLowerCase()
    out.set(key, [...(out.get(key) ?? []), ...values])
  }
  return out
}

function anyValueMatches(values: readonly string[], patterns: readonly RegExp[]): boolean {
  return values.some((value) => patterns.some((pattern) => pattern.test(value.toLowerCase())))
}

/**
 * At least one condition matches: its header is present and, when it names values, none of the
 * `excludedValues` matches a line and (without `values`, or) one of the `values` does.
 */
export function matchesHeaderConditions(
  headers: ReceivedHeaders,
  conditions: readonly CompiledHeaderCondition[]
): boolean {
  for (const condition of conditions) {
    const values = headers.get(condition.header)
    if (!values) continue
    if (!condition.values && !condition.excludedValues) return true
    if (condition.excludedValues && anyValueMatches(values, condition.excludedValues)) continue
    if (!condition.values || anyValueMatches(values, condition.values)) return true
  }
  return false
}

/** The rule's header stage: `excludedResponseHeaders` first, then `responseHeaders`. */
export function matchesHeaderStage(
  headers: ReceivedHeaders,
  responseHeaders: readonly CompiledHeaderCondition[] | null,
  excludedResponseHeaders: readonly CompiledHeaderCondition[] | null
): boolean {
  if (excludedResponseHeaders && matchesHeaderConditions(headers, excludedResponseHeaders))
    return false
  if (responseHeaders && !matchesHeaderConditions(headers, responseHeaders)) return false
  return true
}
