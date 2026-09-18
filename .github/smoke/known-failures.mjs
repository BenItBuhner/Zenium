// Allowlist of known desktop smoke failures (.github/smoke/known-failures.json).
//
// The smoke harness records every JS error, crash and failed step as a "failure" record. A failure
// that matches an allowlist entry is reported by the entry's id (a bug the team is fixing) and does
// not fail the job; anything else does. The PR that fixes a bug removes its entry, so the allowlist
// is normally empty. Pure functions only: unit-tested by known-failures.test.mjs.
import fs from 'node:fs'

/** Every failure kind the harness emits; an entry may only name kinds from this list. */
export const FAILURE_KINDS = [
  // A harness step (an assertion or a wait) failed.
  'step',
  // console.error / uncaught error in a BrowserWindow's own chrome page.
  'chrome-console-error',
  'chrome-pageerror',
  // console.error in a tab view that comes from Electron / the preload rather than the web page.
  'view-console-error',
  // uncaughtException / unhandledRejection in the main process.
  'main-exception',
  // render-process-gone / child-process-gone with an abnormal reason, or an unresponsive view.
  'process-gone',
  'preload-error',
  // A blocking native dialog appeared and had to be dismissed.
  'dialog',
  // An installed build was expected at a path that does not exist (Windows NSIS).
  'install',
  // The harness itself failed (watchdog, launch crash).
  'harness'
]

const FILTERS = ['platforms', 'archs', 'labels', 'scenarios', 'steps']

/**
 * Validate the parsed allowlist document and compile its patterns.
 * @param {unknown} doc parsed JSON
 * @returns {Array<{id: string, kinds: string[], regex: RegExp, pattern: string, fixedBy?: string, note?: string, platforms?: string[], archs?: string[], labels?: string[], scenarios?: string[], steps?: string[]}>}
 */
export function parseKnownFailures(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) {
    throw new Error('known-failures: document must be an object with an "entries" array')
  }
  const ids = new Set()
  return doc.entries.map((raw, i) => {
    const where = `known-failures: entries[${i}]`
    if (!raw || typeof raw !== 'object') throw new Error(`${where} must be an object`)
    if (typeof raw.id !== 'string' || !raw.id.trim()) throw new Error(`${where} needs a string id`)
    if (ids.has(raw.id)) throw new Error(`${where} duplicates id ${raw.id}`)
    ids.add(raw.id)
    const kinds = Array.isArray(raw.kind) ? raw.kind : [raw.kind]
    for (const k of kinds) {
      if (!FAILURE_KINDS.includes(k)) {
        throw new Error(`${where} (${raw.id}) has unknown kind ${JSON.stringify(k)}`)
      }
    }
    if (typeof raw.pattern !== 'string' || !raw.pattern) {
      throw new Error(`${where} (${raw.id}) needs a non-empty regex "pattern"`)
    }
    let regex
    try {
      regex = new RegExp(raw.pattern, 'i')
    } catch (e) {
      throw new Error(`${where} (${raw.id}) pattern does not compile: ${e.message}`)
    }
    const entry = { id: raw.id, kinds, pattern: raw.pattern, regex }
    if (raw.fixedBy !== undefined) entry.fixedBy = String(raw.fixedBy)
    if (raw.note !== undefined) entry.note = String(raw.note)
    for (const f of FILTERS) {
      if (raw[f] === undefined) continue
      if (!Array.isArray(raw[f]) || !raw[f].every((v) => typeof v === 'string' && v)) {
        throw new Error(`${where} (${raw.id}) "${f}" must be an array of strings`)
      }
      entry[f] = raw[f]
    }
    return entry
  })
}

/** Read and parse the allowlist file; a missing file means an empty allowlist. */
export function loadKnownFailures(file) {
  if (!fs.existsSync(file)) return []
  return parseKnownFailures(JSON.parse(fs.readFileSync(file, 'utf8')))
}

/**
 * Does an allowlist entry cover a failure on this platform?
 * @param {ReturnType<typeof parseKnownFailures>[number]} entry
 * @param {{kind: string, message: string, scenario?: string, step?: string, source?: string}} failure
 * @param {{platform: string, arch: string, label?: string}} context
 */
export function matchesEntry(entry, failure, context) {
  if (!entry.kinds.includes(failure.kind)) return false
  if (entry.platforms && !entry.platforms.includes(context.platform)) return false
  if (entry.archs && !entry.archs.includes(context.arch)) return false
  if (entry.labels && !entry.labels.includes(context.label ?? '')) return false
  if (entry.scenarios && !entry.scenarios.includes(failure.scenario ?? '')) return false
  if (entry.steps && !entry.steps.includes(failure.step ?? '')) return false
  const haystack = [failure.message, failure.source].filter(Boolean).join('\n')
  return entry.regex.test(haystack)
}

/**
 * Split failures into known (allowlisted, reported by id) and unexpected (fail the job), and
 * name the entries nothing matched so a stale allowlist is visible in the summary.
 */
export function classifyFailures(failures, entries, context) {
  const known = []
  const unexpected = []
  const used = new Set()
  for (const failure of failures) {
    const entry = entries.find((e) => matchesEntry(e, failure, context))
    if (entry) {
      used.add(entry.id)
      known.push({ id: entry.id, failure })
    } else {
      unexpected.push(failure)
    }
  }
  const unused = entries.filter((e) => !used.has(e.id)).map((e) => e.id)
  return { known, unexpected, unused, ok: unexpected.length === 0 }
}

/** One-line description of a failure for logs and the step summary. */
export function formatFailure(failure, max = 200) {
  const where = [failure.scenario, failure.step].filter(Boolean).join('/')
  const message = String(failure.message ?? '')
    .split('\n')[0]
    .slice(0, max)
  return `${failure.kind}${where ? ` [${where}]` : ''}: ${message}`
}
