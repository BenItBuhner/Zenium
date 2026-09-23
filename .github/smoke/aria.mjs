// The accessibility step of the desktop smoke's walkthrough (.github/smoke/smoke.mjs; parity row
// ci-13): the chrome's aria snapshots against the baselines checked in under .github/smoke/aria/,
// and axe-core's verdict on the same states. Pure functions only – the reading of the tree and the
// running of axe are the harness's – unit-tested by aria.test.mjs.

/**
 * The states the walkthrough snapshots, in order; one baseline file per state under `aria/`.
 * The first five are surfaces at rest (`web-capture` W4-4's overlay); the last four (a11y pass
 * 2, W4-6) are the chrome's accessibility wiring the snapshot alone does not show, so each
 * carries facts under it ({@link formatAriaFacts}): `dialog-cover` the inert chrome and frame
 * behind the hosted dialog
 * (a11y-32), `tooltip-focus` the tooltip a toolbar control shows on keyboard focus and the
 * `aria-describedby` that ties it to the control (a11y-26), `tab-row` the tab rows' places in
 * their list and the states a reader hears – muted, pinned, sleeping (a11y-31), `find-status`
 * the find bar's own live region reading the count in words (a11y-35).
 */
export const ARIA_STATES = [
  'resting-window',
  'app-menu',
  'urlbar',
  'hosted-dialog',
  'web-capture',
  'dialog-cover',
  'tooltip-focus',
  'tab-row',
  'find-status'
]

/** The line that opens the facts under a snapshot in a baseline file. */
export const ARIA_FACTS_HEADER = '# facts'

/**
 * What Playwright's aria snapshot leaves out, written under it in lines of the same shape, one
 * per element: its role, its name in double quotes, then in brackets its states (`focused`,
 * `selected`, `inert`) and the attributes the state is about (`posinset=2 setsize=2`,
 * `describedby=zen-tooltip`), then after a colon its accessible description. The reading is the
 * harness's (the DOM, or the computed tree); this is the writing. Nothing here is parsed back:
 * a baseline is compared line by line, so the order given is the order kept.
 * @param {Array<{role: string, name?: string | null, flags?: string[], attrs?: Record<string, string | number | boolean | null | undefined>, description?: string | null}>} facts
 */
export function formatAriaFacts(facts) {
  const lines = []
  for (const fact of facts ?? []) {
    let line = `- ${fact.role}`
    if (fact.name) line += ` "${String(fact.name).replace(/"/g, '\\"')}"`
    const inside = [...(fact.flags ?? [])]
    for (const [key, value] of Object.entries(fact.attrs ?? {})) {
      if (value === null || value === undefined || value === false || value === '') continue
      inside.push(value === true ? key : `${key}=${value}`)
    }
    if (inside.length) line += ` [${inside.join(' ')}]`
    if (fact.description) line += `: ${fact.description}`
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * A state's text as its baseline stores it: the normalised snapshot, then – when the state has
 * facts – a blank line, {@link ARIA_FACTS_HEADER} and the facts. A state without facts is the
 * snapshot alone, as before.
 */
export function withAriaFacts(snapshot, facts) {
  const body = formatAriaFacts(facts)
  if (!body) return snapshot
  return `${snapshot.trimEnd()}\n\n${ARIA_FACTS_HEADER}\n${body}\n`
}

/** The impacts an axe violation fails the step at; anything milder is reported and tolerated. */
export const AXE_GATE = ['serious', 'critical']

/** The baseline file of a state. */
export function ariaBaselineName(state) {
  return `${state}.aria.yaml`
}

/**
 * A snapshot as the baseline stores it: LF line ends, no trailing blank lines, one newline at
 * the end, and what varies from run to run taken out – the fixture server's origin, bound to an
 * ephemeral port, wherever it shows (the pill reads `127.0.0.1:PORT/first.html`, the omnibox
 * rows the full URL): the host and port become `fixture`.
 */
export function normalizeAriaSnapshot(text, { origin } = {}) {
  let out = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trimEnd()
  if (origin) {
    const host = String(origin).replace(/^[a-z]+:\/\//i, '')
    if (host) out = out.split(host).join('fixture')
  }
  return `${out}\n`
}

/**
 * Where two snapshots part: null when equal, else the first line that differs with a few lines
 * of context from each side, for the failure message (the whole actual snapshot goes to the
 * artifact directory beside it).
 */
export function ariaDiff(expected, actual, context = 3) {
  const a = String(expected).split('\n')
  const b = String(actual).split('\n')
  const n = Math.max(a.length, b.length)
  let at = -1
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      at = i
      break
    }
  }
  if (at === -1) return null
  const from = Math.max(0, at - context)
  const slice = (lines) => lines.slice(from, at + context + 1)
  return {
    line: at + 1,
    expected: slice(a),
    actual: slice(b),
    expectedLines: a.length,
    actualLines: b.length
  }
}

/** One line of the diff for a log or an error message. */
export function formatAriaDiff(state, diff) {
  const show = (lines) => lines.map((l) => `    ${l}`).join('\n')
  return (
    `aria snapshot "${state}" differs from its baseline at line ${diff.line} ` +
    `(${diff.expectedLines} lines expected, ${diff.actualLines} read)\n` +
    `  expected:\n${show(diff.expected)}\n  actual:\n${show(diff.actual)}`
  )
}

/**
 * axe's violations flattened to one record per offending node: the rule, its impact, the node's
 * selector (axe's first target) and the failure summary, so the result JSON and the allowlist
 * name the same thing.
 * @param {{violations?: Array<{id: string, impact?: string, help?: string, helpUrl?: string, nodes?: Array<{target?: unknown[], html?: string, failureSummary?: string}>}>}} results
 */
export function flattenAxe(results) {
  const out = []
  for (const violation of results?.violations ?? []) {
    for (const node of violation.nodes ?? []) {
      out.push({
        rule: violation.id,
        impact: violation.impact ?? 'unknown',
        help: violation.help ?? '',
        helpUrl: violation.helpUrl ?? '',
        target: (node.target ?? [])
          .map((t) => (Array.isArray(t) ? t.join(' >> ') : String(t)))
          .join(' '),
        html: String(node.html ?? '').slice(0, 200),
        summary: String(node.failureSummary ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400)
      })
    }
  }
  return out
}

/**
 * Validate the axe allowlist (`.github/smoke/aria/axe-known.json`): entries for violations on
 * surfaces another program owns (services, extensions), never for the chrome's own. Each names a
 * rule and a regular expression over the node's target selector; `states` narrows it.
 * @param {unknown} doc
 * @returns {Array<{id: string, rule: string, target: RegExp, targetPattern: string, states?: string[], note?: string}>}
 */
export function parseAxeAllowlist(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) {
    throw new Error('axe-known: document must be an object with an "entries" array')
  }
  const ids = new Set()
  return doc.entries.map((raw, i) => {
    const where = `axe-known: entries[${i}]`
    if (!raw || typeof raw !== 'object') throw new Error(`${where} must be an object`)
    if (typeof raw.id !== 'string' || !raw.id.trim()) throw new Error(`${where} needs a string id`)
    if (ids.has(raw.id)) throw new Error(`${where} duplicates id ${raw.id}`)
    ids.add(raw.id)
    if (typeof raw.rule !== 'string' || !raw.rule) {
      throw new Error(`${where} (${raw.id}) needs the axe rule id as "rule"`)
    }
    if (typeof raw.target !== 'string' || !raw.target) {
      throw new Error(`${where} (${raw.id}) needs a non-empty regex "target"`)
    }
    let target
    try {
      target = new RegExp(raw.target)
    } catch (e) {
      throw new Error(`${where} (${raw.id}) target does not compile: ${e.message}`)
    }
    const entry = { id: raw.id, rule: raw.rule, target, targetPattern: raw.target }
    if (raw.states !== undefined) {
      if (!Array.isArray(raw.states) || !raw.states.every((s) => ARIA_STATES.includes(s))) {
        throw new Error(
          `${where} (${raw.id}) "states" must list states from ${ARIA_STATES.join(', ')}`
        )
      }
      entry.states = raw.states
    }
    if (raw.note !== undefined) entry.note = String(raw.note)
    return entry
  })
}

/**
 * The verdict on one state's flattened violations: `failing` are the serious and critical ones
 * no allowlist entry names (they fail the step), `tolerated` the gated ones an entry names (each
 * with the entry's id), `other` everything milder (reported, never gating).
 */
export function axeVerdict(state, violations, allowlist = []) {
  const failing = []
  const tolerated = []
  const other = []
  for (const v of violations) {
    if (!AXE_GATE.includes(v.impact)) {
      other.push(v)
      continue
    }
    const entry = allowlist.find(
      (e) => e.rule === v.rule && e.target.test(v.target) && (!e.states || e.states.includes(state))
    )
    if (entry) tolerated.push({ ...v, knownAs: entry.id })
    else failing.push(v)
  }
  return { failing, tolerated, other }
}

/** One line per violation, for the log. */
export function formatAxeViolation(v) {
  return `${v.impact} ${v.rule} at ${v.target}${v.knownAs ? ` (known: ${v.knownAs})` : ''}: ${v.help}`
}
