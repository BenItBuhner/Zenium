import type { Credential } from '../../shared/types'
import { sha1Hex, sha256Hex } from './crypto'

/**
 * Password Checkup, the way Chrome and Firefox do it without a server of their own:
 *
 *  - compromised: Have I Been Pwned's Pwned Passwords range API (k-anonymity). Only the first
 *    five hex characters of a password's SHA-1 leave the device; the response lists every known
 *    hash suffix with that prefix and we look ours up locally. `Add-Padding: true` makes every
 *    response the same size class so its length reveals nothing either. No key, no account.
 *  - weak: a zxcvbn score below 3 (Chrome's threshold), computed locally.
 *  - reused: the same password (compared by SHA-256) on more than one login.
 */

export const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/'
/** zxcvbn scores run 0 to 4; Chrome flags anything under 3 as weak. */
export const WEAK_SCORE_THRESHOLD = 3
/** Range requests in flight at once; HIBP asks for gentle clients and pads responses anyway. */
export const RANGE_CONCURRENCY = 4
export const RANGE_TIMEOUT_MS = 15_000
const RANGE_RETRIES = 2

/** Parse a range response into suffix → count; padding lines (count 0) are dropped. */
export function parseRange(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon !== 35) continue
    const suffix = line.slice(0, 35).toUpperCase()
    if (!/^[0-9A-F]{35}$/.test(suffix)) continue
    const count = parseInt(line.slice(colon + 1), 10)
    if (!Number.isFinite(count) || count <= 0) continue
    out.set(suffix, count)
  }
  return out
}

/** How often a password (given as its SHA-1) appears in the breach corpus covered by `range`. */
export function breachCount(sha1: string, range: Map<string, number>): number {
  return range.get(sha1.slice(5).toUpperCase()) ?? 0
}

export interface CheckupDeps {
  /** GET `${HIBP_RANGE_URL}${prefix}` with padding; null when the network failed for good. */
  fetchRange(prefix: string, signal: AbortSignal): Promise<string | null>
  /** zxcvbn score 0–4 for a password. */
  score(password: string): Promise<number>
}

export interface CheckupProgress {
  checked: number
  total: number
}

export interface CheckupResult {
  compromised: string[]
  weak: string[]
  reused: string[][]
  /** Logins whose breach lookup did not complete (network). */
  unchecked: string[]
  /** The breach service could not be reached at all. */
  offline: boolean
  /**
   * Every login whose lookup completed: how often its password appears in the corpus, 0 when
   * clean (what the service records on the login as `breached` / `checkedAt`).
   */
  breachCounts: Map<string, number>
}

/**
 * The sign-in leak check (ID-31): how often one password appears in the breach corpus, by the
 * same range request as the checkup (the hash prefix only, padded), retried like it; null when
 * the network failed for good, which the caller treats as "not checked" (no warning, nothing
 * recorded, the next sign-in tries again).
 */
export async function lookupBreachCount(
  password: string,
  deps: Pick<CheckupDeps, 'fetchRange'>,
  signal: AbortSignal
): Promise<number | null> {
  if (!password) return null
  const hash = (await sha1Hex(password)).toUpperCase()
  const text = await fetchWithRetry(deps, hash.slice(0, 5), signal)
  if (text === null) return null
  return breachCount(hash, parseRange(text))
}

/** Group logins by identical password; only groups with two or more members are reported. */
export async function findReused(credentials: Credential[]): Promise<string[][]> {
  const byHash = new Map<string, string[]>()
  for (const c of credentials) {
    if (!c.password) continue
    const hash = await sha256Hex(c.password)
    const group = byHash.get(hash)
    if (group) group.push(c.id)
    else byHash.set(hash, [c.id])
  }
  return [...byHash.values()].filter((g) => g.length > 1)
}

/** Weak logins: zxcvbn score under the threshold. */
export async function findWeak(
  credentials: Credential[],
  score: CheckupDeps['score'],
  signal?: AbortSignal
): Promise<string[]> {
  const weak: string[] = []
  const cache = new Map<string, number>()
  for (const c of credentials) {
    if (signal?.aborted) break
    if (!c.password) {
      weak.push(c.id)
      continue
    }
    let s = cache.get(c.password)
    if (s === undefined) {
      s = await score(c.password)
      cache.set(c.password, s)
    }
    if (s < WEAK_SCORE_THRESHOLD) weak.push(c.id)
  }
  return weak
}

/**
 * Run every check. Breach lookups are batched by hash prefix (identical prefixes, and identical
 * passwords, cost one request), a few at a time; `onProgress` fires per finished login.
 */
export async function runCheckup(
  credentials: Credential[],
  deps: CheckupDeps,
  onProgress: (p: CheckupProgress) => void,
  signal: AbortSignal
): Promise<CheckupResult> {
  const total = credentials.length
  const result: CheckupResult = {
    compromised: [],
    weak: [],
    reused: [],
    unchecked: [],
    offline: false,
    breachCounts: new Map()
  }
  result.reused = await findReused(credentials)
  result.weak = await findWeak(credentials, deps.score, signal)
  if (signal.aborted) return result

  const hashes = new Map<string, string>()
  const byPrefix = new Map<string, string[]>()
  for (const c of credentials) {
    if (!c.password) continue
    const hash = (await sha1Hex(c.password)).toUpperCase()
    hashes.set(c.id, hash)
    const prefix = hash.slice(0, 5)
    const ids = byPrefix.get(prefix)
    if (ids) ids.push(c.id)
    else byPrefix.set(prefix, [c.id])
  }
  let checked = total - hashes.size
  onProgress({ checked, total })

  const prefixes = [...byPrefix.keys()]
  let failures = 0
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < prefixes.length && !signal.aborted) {
      const prefix = prefixes[next++]
      const ids = byPrefix.get(prefix) ?? []
      const text = await fetchWithRetry(deps, prefix, signal)
      if (text === null) {
        failures++
        result.unchecked.push(...ids)
      } else {
        const range = parseRange(text)
        for (const id of ids) {
          const hash = hashes.get(id)
          if (!hash) continue
          const count = breachCount(hash, range)
          result.breachCounts.set(id, count)
          if (count > 0) result.compromised.push(id)
        }
      }
      checked += ids.length
      onProgress({ checked, total })
    }
  }
  await Promise.all(Array.from({ length: RANGE_CONCURRENCY }, () => worker()))
  if (signal.aborted) {
    const done = new Set([...result.compromised, ...result.unchecked])
    for (const id of hashes.keys()) if (!done.has(id)) result.unchecked.push(id)
  }
  result.offline = prefixes.length > 0 && failures === prefixes.length
  return result
}

async function fetchWithRetry(
  deps: Pick<CheckupDeps, 'fetchRange'>,
  prefix: string,
  signal: AbortSignal
): Promise<string | null> {
  for (let attempt = 0; attempt <= RANGE_RETRIES; attempt++) {
    if (signal.aborted) return null
    try {
      const text = await deps.fetchRange(prefix, signal)
      if (text !== null) return text
    } catch {
      // Treated like a null result; retried below.
    }
    if (attempt < RANGE_RETRIES) await sleep(400 * (attempt + 1), signal)
  }
  return null
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** The zxcvbn scorer, loaded on first use (its dictionaries weigh more than the rest of the core). */
let scorer: Promise<(password: string) => number> | null = null

export function zxcvbnScorer(): Promise<(password: string) => number> {
  scorer ??= (async () => {
    const [{ ZxcvbnFactory }, common, en] = await Promise.all([
      import('@zxcvbn-ts/core'),
      import('@zxcvbn-ts/language-common'),
      import('@zxcvbn-ts/language-en')
    ])
    const factory = new ZxcvbnFactory({
      dictionary: { ...common.dictionary, ...en.dictionary },
      graphs: common.adjacencyGraphs,
      translations: en.translations
    })
    return (password: string) => factory.check(password.slice(0, 100)).score
  })()
  return scorer
}

/** The EFF large wordlist used for passphrases, loaded on first use. */
let wordlist: Promise<readonly string[]> | null = null

export function passphraseWordlist(): Promise<readonly string[]> {
  wordlist ??= import('@zxcvbn-ts/language-common').then((m) => m.dictionary['diceware-common'])
  return wordlist
}
