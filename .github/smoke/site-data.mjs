// The profile's `sitedata.json` as the clear-on-exit scenario reads and seeds it, and the
// fixture's request log as it reads the cookie's presence from it. Pure functions only (the
// engine that owns the document is src/core/siteData.ts); unit-tested by site-data.test.mjs.
//
// `SiteDataService` keeps the per-site cookie policy and, under `pendingClear`, the clear the
// last close left owed: the desktop's quit writes the marker before the on-exit run and drops it
// when the run completed inside its budget (`runOnExit` → `done`); a marker still there at the
// next launch is run by `start()` ahead of the windows and dropped then.

/** The document's name under the profile's `zen/` directory. */
export const SITE_DATA_FILE = 'sitedata.json'

/** The policy of a profile that never touched the cookie lists (`DEFAULT_SITE_DATA_POLICY`). */
export const DEFAULT_SITE_DATA_POLICY = { blockAll: false, allow: [], clearOnExit: [], block: [] }

/**
 * An owed clear in the shape `readPendingClear` (src/core/siteData.ts) takes back: the types of
 * `privacy.clearOnExit`, the site patterns of the clear-on-exit and never lists, and when it was
 * written. `at` defaults to `now()`.
 */
export function owedClear({ types, patterns = [], at }, now = Date.now) {
  if (!Array.isArray(types) || types.length === 0) {
    throw new Error('an owed clear names at least one type')
  }
  return { types: [...types], patterns: [...patterns], at: typeof at === 'number' ? at : now() }
}

/**
 * The document to write so the next launch finds `marker` owed: the policy of an existing
 * document stays (`doc` as parsed from the file, or null when there is none), the rest is the
 * engine's `version: 1` shape.
 */
export function withOwedClear(doc, marker) {
  const policy =
    doc && typeof doc === 'object' && doc.policy && typeof doc.policy === 'object'
      ? doc.policy
      : DEFAULT_SITE_DATA_POLICY
  return { version: 1, policy, pendingClear: marker }
}

/**
 * What a parsed document owes: `undefined` for no document at all (a profile whose runs never
 * wrote one: nothing to clear on exit, nothing owed), `null` for a document owing nothing (the
 * marker written and dropped), else the marker itself.
 */
export function owedClearOf(doc) {
  if (doc === null || doc === undefined) return undefined
  if (typeof doc !== 'object' || !('pendingClear' in doc)) return null
  const marker = doc.pendingClear
  return marker && typeof marker === 'object' ? marker : null
}

/**
 * The fixture's requests for `path` from index `from` of its log on, and how many carried a
 * `Cookie` header naming `cookieName`: what the browser sent, read off the wire rather than
 * from the page.
 */
export function cookieRequests(requests, path, cookieName, from = 0) {
  const hits = requests.slice(Math.max(0, from)).filter((r) => r && r.path === path)
  const carried = hits.filter((r) => carriesCookie(r.cookie, cookieName))
  return {
    total: hits.length,
    withCookie: carried.length,
    withoutCookie: hits.length - carried.length,
    cookies: hits.map((r) => r.cookie ?? null)
  }
}

/** Whether a `Cookie` request header (or none) names `cookieName`. */
export function carriesCookie(header, cookieName) {
  if (typeof header !== 'string' || !header) return false
  return header.split(';').some((pair) => pair.trim().split('=')[0] === cookieName)
}

/**
 * The engine's clears from the main-process event log (`hookMain` wraps
 * `session.clearStorageData`, `clearCache` and `clearCodeCaches` into `session-clear` events)
 * that happened at or after `since` – the quit chord's time for the quit's run, 0 for a launch's:
 * each with its method, the partition's path, its options, whether it resolved and how long the
 * engine took. Oldest first.
 */
export function sessionClearsSince(events, since = 0) {
  return (events || [])
    .filter((e) => e && e.type === 'session-clear' && typeof e.t === 'number' && e.t >= since)
    .sort((a, b) => a.t - b.t)
    .map((e) => ({
      t: e.t,
      method: e.method,
      storagePath: e.storagePath ?? null,
      options: e.options,
      ok: e.ok !== false,
      error: e.error,
      ms: e.ms
    }))
}
