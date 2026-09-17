/**
 * `chrome.declarativeNetRequest` `urlFilter` patterns compiled to predicates. The syntax is the
 * ABP network-filter pattern language: `||` anchors to the start of a (sub)domain, `|` anchors
 * to the start or end of the URL, `^` is a separator and `*` a wildcard.
 */

export type UrlPredicate = (url: string) => boolean

const SEPARATOR = '(?:[^a-zA-Z0-9_\\-.%]|$)'
const HOSTNAME_ANCHOR = '^[a-zA-Z][a-zA-Z0-9+.\\-]*://(?:[^/?#]*\\.)?'

function escapeRegExp(s: string): string {
  return s.replace(/[.+?${}()[\]\\/]/g, '\\$&')
}

/**
 * Translate a `urlFilter` into a regular expression source. Exported so the Kotlin engine's tests
 * can be cross-checked against the same expectations.
 */
export function urlFilterToRegExpSource(filter: string): string {
  let body = filter
  let prefix = ''
  let suffix = ''
  if (body.startsWith('||')) {
    prefix = HOSTNAME_ANCHOR
    body = body.slice(2)
  } else if (body.startsWith('|')) {
    prefix = '^'
    body = body.slice(1)
  }
  if (body.endsWith('|')) {
    suffix = '$'
    body = body.slice(0, -1)
  }
  let out = ''
  for (const ch of body) {
    if (ch === '*') out += '.*'
    else if (ch === '^') out += SEPARATOR
    else out += escapeRegExp(ch)
  }
  return prefix + out + suffix
}

/**
 * Compile a `urlFilter` to a predicate. An empty filter matches every URL. Plain substrings
 * (no anchors or wildcards) skip the regular expression entirely.
 */
export function compileUrlFilter(filter: string, caseSensitive = false): UrlPredicate {
  if (!filter) return () => true
  const plain = !/[|^*]/.test(filter)
  if (plain) {
    if (caseSensitive) return (url) => url.includes(filter)
    const needle = filter.toLowerCase()
    return (url) => url.toLowerCase().includes(needle)
  }
  const re = new RegExp(urlFilterToRegExpSource(filter), caseSensitive ? '' : 'i')
  return (url) => re.test(url)
}

/** Compile a `regexFilter`; returns `null` when the expression is invalid. */
export function compileRegexFilter(source: string, caseSensitive = false): RegExp | null {
  try {
    return new RegExp(source, caseSensitive ? '' : 'i')
  } catch {
    return null
  }
}

/** Apply a `regexSubstitution` (`\1`-style groups) after `regex` matched `url`. */
export function applyRegexSubstitution(regex: RegExp, url: string, substitution: string): string | null {
  const match = regex.exec(url)
  if (!match) return null
  return substitution.replace(/\\(\d)/g, (_, digit: string) => match[Number(digit)] ?? '')
}
