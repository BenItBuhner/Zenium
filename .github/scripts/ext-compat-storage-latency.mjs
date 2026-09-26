// The storage round trips of a compat sweep, read off the bridge trace lines its results.json
// keeps (each step's evidence carries the row's last forty lines: `rows[].core.detail.<step>.bridge[]`,
// `bridgeErrors[]` beside them): every `chrome.storage.<area>.<method>` call's `>` line paired
// with the `<` line of its reply, the round trip being the host's receipt of the call to the
// host's send of the reply (`uptimeMillis`, both on the app's main thread – the frame's own hops
// to and from the host are not in it). Compat round 18 §7.1 read `storage.set` median 161 ms /
// p90 306 this way against Chrome's ~1-5 ms, Zoom Video's lost update its consequence; this
// script is that reading made repeatable, so a BEFORE and an AFTER lane read the same way.
//   node .github/scripts/ext-compat-storage-latency.mjs <results.json> [<results.json> …]
// Prints, per file: each storage method's n / median / p90 / max over the lane, then every row's
// own pairs (`<context> <method>=<ms>`). A line that carries the call's id (`id=<n>`, the host's
// debug trace since compat round 19) is paired by it; older lines are paired by order within one
// endpoint context, where a reply behind an unrelated call's in the same context can mis-pair –
// the summary says which pairing it used. A reply carrying the legs (`hop=<ms> run=<ms>
// back=<ms>`: the host's receipt to the runtime's, the runtime's own work, the runtime's post to
// the host's send) has each leg summed the same way, which is where the round trip's time is
// placed – the renderer's queue ahead of the runtime, the runtime, or the app's threads behind it.
import { readFileSync } from 'node:fs'

const LINE = /^(\d+) ([<>]) ([^/ ]+)\/(\S+) (\w+)(?: (.*))?$/

/** The `key=value` tokens of a trace line's tail, numeric ones (`id`, `hop`, `run`, `back`, `chars`). */
const numbers = (tail) => {
  const found = {}
  for (const m of (tail ?? '').matchAll(/(?:^| )(id|hop|run|back|chars)=(-?\d+)(?= |$)/g))
    found[m[1]] = Number(m[2])
  return found
}

/** Every bridge line of a row's evidence, each once, in the order of their stamps. */
const linesOf = (row) => {
  const seen = new Set()
  const out = []
  const take = (list) => {
    if (!Array.isArray(list)) return
    for (const line of list)
      if (typeof line === 'string' && LINE.test(line) && !seen.has(line)) {
        seen.add(line)
        out.push(line)
      }
  }
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      take(node)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'bridge' || key === 'bridgeErrors') take(value)
      else walk(value)
    }
  }
  walk(row)
  return out.sort((a, b) => Number(a.split(' ', 1)[0]) - Number(b.split(' ', 1)[0]))
}

/**
 * The storage pairs of one row: `{ context, method, ms, legs }` each, and whether any pair
 * went by order for want of ids. Calls of every namespace enter the queue (a reply consumes the
 * slot of the call ahead of it), storage's alone are reported.
 */
const pairsOf = (row) => {
  const pending = new Map()
  const pairs = []
  let byOrder = false
  for (const line of linesOf(row)) {
    const m = LINE.exec(line)
    const [, stamp, direction, , context, kind, tail] = m
    const t = Number(stamp)
    const key = `${m[3]}/${context}`
    if (direction === '>' && kind === 'call') {
      const method = (tail ?? '').split(' ', 1)[0]
      const { id } = numbers(tail)
      if (!pending.has(key)) pending.set(key, [])
      pending.get(key).push({ method, id, t })
      continue
    }
    if (direction !== '<' || kind !== 'reply') continue
    const queue = pending.get(key)
    if (!queue || queue.length === 0) continue
    const found = numbers(tail)
    let index = found.id === undefined ? -1 : queue.findIndex((call) => call.id === found.id)
    if (index < 0) {
      if (found.id !== undefined && queue.every((call) => call.id !== undefined)) continue
      index = 0
      byOrder = true
    }
    const [call] = queue.splice(index, 1)
    if (!call.method.startsWith('storage.')) continue
    const legs =
      found.hop !== undefined && found.run !== undefined && found.back !== undefined
        ? { hop: found.hop, run: found.run, back: found.back }
        : null
    pairs.push({ context, method: call.method, ms: t - call.t, legs })
  }
  return { pairs, byOrder }
}

const median = (sorted) => {
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Nearest rank, as the frame budget's readings take their percentiles. */
const percentile = (sorted, p) => sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1]

const stat = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return `n ${sorted.length} median ${median(sorted)} p90 ${percentile(sorted, 0.9)} max ${sorted[sorted.length - 1]}`
}

const report = (file) => {
  const results = JSON.parse(readFileSync(file, 'utf8'))
  const rows = Array.isArray(results.rows) ? results.rows : []
  const byMethod = new Map()
  const legsByMethod = new Map()
  const rowLines = []
  let byOrder = false
  for (const row of rows) {
    const found = pairsOf(row)
    if (found.pairs.length === 0) continue
    byOrder ||= found.byOrder
    for (const pair of found.pairs) {
      if (!byMethod.has(pair.method)) byMethod.set(pair.method, [])
      byMethod.get(pair.method).push(pair.ms)
      if (pair.legs) {
        if (!legsByMethod.has(pair.method))
          legsByMethod.set(pair.method, { hop: [], run: [], back: [] })
        const legs = legsByMethod.get(pair.method)
        legs.hop.push(pair.legs.hop)
        legs.run.push(pair.legs.run)
        legs.back.push(pair.legs.back)
      }
    }
    rowLines.push(
      `  ${row.name ?? row.id}: ${found.pairs
        .map(
          (pair) =>
            `${pair.context} ${pair.method.slice('storage.'.length)}=${pair.ms}${pair.legs ? `(${pair.legs.hop}+${pair.legs.run}+${pair.legs.back})` : ''}`
        )
        .join(' ')}`
    )
  }
  const lines = [
    `${file} (${results.webView ?? 'WebView ?'}${results.isolatedWorlds === undefined ? '' : `, isolated worlds ${results.isolatedWorlds ? 'on' : 'off'}`}): ${rows.length} rows, ${rowLines.length} with storage calls on the bridge lines kept${byMethod.size ? (byOrder ? '; paired by order within a context (no ids on the lines)' : '; paired by id') : ''}`
  ]
  for (const method of [...byMethod.keys()].sort()) {
    lines.push(`  ${method} ${stat(byMethod.get(method))} ms`)
    const legs = legsByMethod.get(method)
    if (legs)
      lines.push(
        `    legs (${legs.hop.length} of them): hop ${stat(legs.hop)}; run ${stat(legs.run)}; back ${stat(legs.back)}`
      )
  }
  lines.push(...rowLines)
  return lines.join('\n')
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node ext-compat-storage-latency.mjs <results.json> [<results.json> …]')
  process.exit(2)
}
console.log(files.map(report).join('\n'))
