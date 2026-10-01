// The pure arithmetic of the jank audit's harness (perf-audit.mjs): percentiles and the
// five-number summary of a sample, and the pairing of a trigger with the first event that
// answers it. Kept apart from the harness so the unit tests (perf-audit.test.mjs) run them
// without Playwright or a build.

/**
 * The `p`-th percentile of `values` (0–100) by linear interpolation between the nearest ranks –
 * the definition `monitorEventLoopDelay` and most dashboards share, so a chrome-side p95 and a
 * main-side one read alike. `null` on an empty sample.
 */
export function percentile(values, p) {
  const sorted = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b)
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

/**
 * `{ count, p50, p95, max, mean, min }` of a sample; the numbers are `null` when the sample is
 * empty (a scene whose event never came), so a table prints "–" rather than NaN.
 */
export function summarize(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return { count: 0, p50: null, p95: null, max: null, mean: null, min: null }
  return {
    count: nums.length,
    p50: percentile(nums, 50),
    p95: percentile(nums, 95),
    max: Math.max(...nums),
    min: Math.min(...nums),
    mean: nums.reduce((a, b) => a + b, 0) / nums.length
  }
}

/**
 * For every trigger (an epoch-ms stamp), the latency to the first event at or after it and
 * before the next trigger – `null` when none answered within that span. Events and triggers
 * are stamps on the same clock (`performance.timeOrigin + performance.now()` on either side,
 * `Date.now()` in main); a `tolerance` lets an event stamped a hair before its trigger (clocks
 * read in different processes) still pair.
 */
export function pairLatencies(triggers, events, { tolerance = 0 } = {}) {
  const ts = [...triggers].sort((a, b) => a - b)
  const es = [...events].sort((a, b) => a - b)
  return ts.map((t, i) => {
    const next = i + 1 < ts.length ? ts[i + 1] : Infinity
    const hit = es.find((e) => e >= t - tolerance && e < next)
    return hit === undefined ? null : hit - t
  })
}

/**
 * The frame-time picture of a run: the gaps between `requestAnimationFrame` callbacks within
 * `[from, to]`, their summary, and how many ran over the budget (a dropped frame: more than one
 * and a half budgets, so a frame a hair late under a busy observer is not counted), over 32 ms
 * (two budgets) and over 50 ms (the long-task mark).
 */
export function frameStats(frames, budgetMs, from = -Infinity, to = Infinity) {
  const dts = frames.filter((f) => f.at >= from && f.at <= to).map((f) => f.dt)
  return {
    ...summarize(dts),
    dropped: dts.filter((d) => d > budgetMs * 1.5).length,
    over32: dts.filter((d) => d > 32).length,
    over50: dts.filter((d) => d > 50).length
  }
}

/**
 * A V8 CPU profile (`Profiler.stop`'s `profile`: `nodes`, `samples`, `timeDeltas`) boiled down
 * to where the time went: the top functions by self time and by inclusive time (a function on
 * the stack of a sample is charged once however often it recurs), each named by its name and
 * file, and the time by file – so a scene's render reads as "N ms in react-dom, M ms in the
 * chrome's own code, K ms idle". Times in ms; `total` is the profile's span.
 */
export function summarizeCpuProfile(profile, { top = 30 } = {}) {
  const nodes = new Map()
  for (const n of profile.nodes ?? []) nodes.set(n.id, n)
  const parent = new Map()
  for (const n of profile.nodes ?? []) for (const c of n.children ?? []) parent.set(c, n.id)
  const keyOf = (node) => {
    const f = node.callFrame ?? {}
    const file = f.url ? f.url.slice(f.url.lastIndexOf('/') + 1) : ''
    const name = f.functionName || '(anonymous)'
    return file ? `${name} ${file}:${(f.lineNumber ?? -1) + 1}` : name
  }
  const fileOf = (node) => {
    const f = node.callFrame ?? {}
    if (f.url) return f.url.slice(f.url.lastIndexOf('/') + 1)
    return f.functionName || '(program)'
  }
  const self = new Map()
  const inclusive = new Map()
  const byFile = new Map()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  let total = 0
  for (let i = 0; i < samples.length; i++) {
    const node = nodes.get(samples[i])
    if (!node) continue
    const dt = Math.max(0, (deltas[i] ?? 0) / 1000)
    total += dt
    const k = keyOf(node)
    self.set(k, (self.get(k) ?? 0) + dt)
    const file = fileOf(node)
    byFile.set(file, (byFile.get(file) ?? 0) + dt)
    const seen = new Set()
    for (let id = node.id; id !== undefined; id = parent.get(id)) {
      const n = nodes.get(id)
      if (!n) break
      const key = keyOf(n)
      if (seen.has(key)) continue
      seen.add(key)
      inclusive.set(key, (inclusive.get(key) ?? 0) + dt)
    }
  }
  const rank = (m) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([name, ms]) => ({ name, ms: Math.round(ms * 100) / 100 }))
  return {
    totalMs: Math.round(total * 100) / 100,
    self: rank(self),
    inclusive: rank(inclusive),
    byFile: rank(byFile)
  }
}

/** Long tasks within `[from, to]`: how many, their total and their longest. */
export function longTaskStats(tasks, from = -Infinity, to = Infinity) {
  const inWindow = tasks.filter((t) => t.at >= from && t.at <= to)
  return {
    count: inWindow.length,
    totalMs: inWindow.reduce((a, t) => a + t.duration, 0),
    max: inWindow.reduce((a, t) => Math.max(a, t.duration), 0)
  }
}
