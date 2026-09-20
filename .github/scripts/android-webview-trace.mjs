#!/usr/bin/env node
// Reads the chrome WebView's own Chromium traces a profiling driver captured per scene through
// android.webkit.TracingController (`webview-<scene>.json.gz`, Trace Event JSON) together with
// the driver's probe record (`chrome-<scene>.json.txt`: pointer taps, one sample per animation
// frame of the inline `--zen-recede` and the sheet's transform while a sheet moved, long tasks,
// Event Timing entries) and writes, per scene, what the chrome renderer's main thread did:
//  - per motion (a tap to the sheet at rest; a drag to its detent): the wait from the tap to the
//    first frame that moved, the motion's length, its frames and their intervals (the stutter),
//    and the main thread's time per frame in style recalc, layout, pre-paint, paint / commit,
//    script and the rest;
//  - over the scene: the top events by self time, layouts and style recalcs per frame with their
//    element counts, the invalidation reasons (what dirtied style, layout and paint), the long
//    tasks, and how busy the compositor, the page's renderer and the browser's threads were.
// The chrome renderer is the one whose main thread carries the probe's `menu-perf:*` user-timing
// marks; the probe's clock (performance.now) is aligned to the trace's through those marks.
//
// Usage: node --max-old-space-size=8192 android-webview-trace.mjs <dir> [--json <file>]
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const dir = process.argv[2] || '.'
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–')
const median = (xs) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}
const pct = (xs, p) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0)

const BUCKETS = [
  ['style', /^(UpdateLayoutTree|RecalcStyle|StyleRecalc|ScheduleStyleRecalculation|StyleEngine::|Document::UpdateStyle)/],
  ['layout', /^(Layout|LayoutView::|LocalFrameView::(Perform|Update)Layout|IntersectionObserver|ResizeObserver|PostLayoutTasks)/],
  ['prepaint', /^(PrePaint|LocalFrameView::RunPrePaintLifecyclePhase|PaintPropertyTreeBuilder|PaintInvalidator)/],
  ['paint', /^(Paint|PaintImage|Decode Image|Draw LazyPixelRef|UpdateLayer|UpdateLayerTree|Commit|Layerize|LocalFrameView::RunPaintLifecyclePhase|ProxyMain::Commit|ThreadProxy::Commit|PaintArtifactCompositor|GraphicsLayer)/],
  ['gc', /^(MinorGC|MajorGC|V8\.GC|BlinkGC|ThreadState::|Heap::|V8\.Scavenge|V8\.MarkCompact)/],
  ['hittest', /^HitTest/],
  ['script', /^(FunctionCall|EvaluateScript|v8\.|V8\.|TimerFire|FireAnimationFrame|EventDispatch|RunMicrotasks|Microtasks|CallFunction|XHR|ParseHTML|RequestAnimationFrame|ScheduledAction|DOMTimer|blink\.console|WebViewClient|JavaScript)/]
]
function bucketOf(name) {
  for (const [b, re] of BUCKETS) if (re.test(name)) return b
  return 'other'
}

function loadTrace(file) {
  const raw = gunzipSync(readFileSync(file)).toString('utf8')
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    // A stream cut short: close what is open.
    const fixed = raw.replace(/,\s*$/, '') + (raw.trimStart().startsWith('{') ? ']}' : ']')
    data = JSON.parse(fixed)
  }
  return Array.isArray(data) ? data : data.traceEvents || []
}

function loadProbe(file) {
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function loadScenes(file) {
  const scenes = {}
  if (!existsSync(file)) return scenes
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const p = line.trim().split(/\s+/)
    if (p.length >= 5) scenes[p[0]] = { startMonoUs: Number(p[3]) / 1000, endMonoUs: Number(p[4]) / 1000 }
  }
  return scenes
}

/** Complete events (X, and B/E folded) per thread, with self time computed from nesting. */
function buildThreads(events) {
  const procNames = new Map()
  const threadNames = new Map()
  const perThread = new Map()
  const openB = new Map()
  const marks = []
  for (const e of events) {
    if (e.ph === 'M') {
      if (e.name === 'process_name') procNames.set(e.pid, e.args?.name)
      if (e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args?.name)
      continue
    }
    if (typeof e.name === 'string' && e.name.startsWith('menu-perf:')) marks.push({ name: e.name.slice('menu-perf:'.length), ts: e.ts, pid: e.pid, tid: e.tid })
    const key = `${e.pid}:${e.tid}`
    if (e.ph === 'X') {
      if (!(e.dur >= 0)) continue
      ;(perThread.get(key) || perThread.set(key, []).get(key)).push({ name: e.name, cat: e.cat, ts: e.ts, dur: e.dur, args: e.args })
    } else if (e.ph === 'B') {
      ;(openB.get(key) || openB.set(key, []).get(key)).push(e)
    } else if (e.ph === 'E') {
      const stack = openB.get(key)
      const b = stack?.pop()
      if (b) (perThread.get(key) || perThread.set(key, []).get(key)).push({ name: b.name, cat: b.cat, ts: b.ts, dur: e.ts - b.ts, args: { ...(b.args || {}), ...(e.args || {}) } })
    } else if (e.ph === 'I' || e.ph === 'i' || e.ph === 'R' || e.ph === 'n') {
      ;(perThread.get(key) || perThread.set(key, []).get(key)).push({ name: e.name, cat: e.cat, ts: e.ts, dur: 0, args: e.args, instant: true })
    }
  }
  for (const [, list] of perThread) {
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur)
    const stack = []
    for (const ev of list) {
      if (ev.instant) {
        ev.depth = stack.length
        continue
      }
      while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= ev.ts) stack.pop()
      ev.depth = stack.length
      ev.self = ev.dur
      if (stack.length) {
        const parent = stack[stack.length - 1]
        parent.self -= Math.min(ev.dur, parent.ts + parent.dur - ev.ts)
        ev.parent = parent
      }
      stack.push(ev)
    }
  }
  return { procNames, threadNames, perThread, marks }
}

function inWindow(ev, a, b) {
  return ev.ts >= a && ev.ts < b
}

function busy(list, a, b) {
  // Top-level time inside [a, b): depth-0 events clipped to the window.
  let t = 0
  for (const ev of list) {
    if (ev.depth !== 0 || ev.instant) continue
    if (ev.ts >= b) break
    const end = ev.ts + ev.dur
    if (end <= a) continue
    t += Math.min(end, b) - Math.max(ev.ts, a)
  }
  return t
}

function analyseScene(scene, events, probe, clocks) {
  const { procNames, threadNames, perThread, marks } = buildThreads(events)
  const out = { scene, notes: [] }

  // The chrome renderer: the thread carrying the probe's marks, else the renderer main thread with the most rAFs.
  let mainKey = null
  const markCounts = new Map()
  for (const m of marks) markCounts.set(`${m.pid}:${m.tid}`, (markCounts.get(`${m.pid}:${m.tid}`) || 0) + 1)
  if (markCounts.size) mainKey = [...markCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  if (!mainKey) {
    let best = 0
    for (const [key, list] of perThread) {
      if (threadNames.get(key) !== 'CrRendererMain') continue
      const n = list.filter((e) => e.name === 'FireAnimationFrame').length
      if (n > best) {
        best = n
        mainKey = key
      }
    }
    out.notes.push('no menu-perf marks in the trace; the chrome renderer was taken as the one with the most animation frames')
  }
  if (!mainKey) {
    out.notes.push('no renderer main thread found')
    return out
  }
  const [chromePid] = mainKey.split(':').map(Number)
  const main = perThread.get(mainKey)
  out.chromePid = chromePid

  // The scene window.
  let a = -Infinity
  let b = Infinity
  const startMark = marks.find((m) => m.name === `${scene}:start`)
  const endMark = marks.find((m) => m.name === `${scene}:end`)
  if (startMark && endMark) {
    a = startMark.ts
    b = endMark.ts
  } else if (clocks) {
    a = clocks.startMonoUs
    b = clocks.endMonoUs
    out.notes.push('scene window from the driver clocks (no start / end marks in the trace)')
  } else {
    a = main[0]?.ts ?? 0
    b = (main[main.length - 1]?.ts ?? 0) + 1
    out.notes.push('scene window is the whole trace')
  }
  out.windowMs = (b - a) / 1000

  // Align the probe's clock to the trace through the marks both saw.
  let offset = null
  if (probe && probe.marks?.length) {
    const deltas = []
    for (const pm of probe.marks) {
      const tm = marks.find((m) => m.name === pm.n)
      if (tm) deltas.push(tm.ts - pm.t * 1000)
    }
    if (deltas.length) offset = median(deltas)
  }
  const toTs = (t) => (offset === null ? null : offset + t * 1000)

  // Motions: from the tap (pointer up, the sheet opens on the click; the down for a drag) to rest.
  const motions = []
  if (probe && offset !== null) {
    const taps = probe.taps || []
    const samples = probe.motion || []
    const starts = probe.marks.filter((m) => /:start$/.test(m.n) && !m.n.startsWith(scene))
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i]
      const kind = s.n.split(':')[0]
      const next = starts[i + 1]?.t ?? Infinity
      const endMarkT = probe.marks.find((m) => m.n === s.n.replace(':start', ':end'))?.t ?? next
      const drag = kind.startsWith('drag')
      const tap = taps.find((t) => t.t >= s.t && t.t < endMarkT && t.k === (drag ? 'down' : 'up'))
      if (!tap) continue
      const release = drag ? taps.find((t) => t.t >= tap.t && t.k === 'up') : tap
      const inRange = samples.filter((m) => m.t >= tap.t && m.t < Math.min(next, endMarkT + 3000))
      if (inRange.length < 3) continue
      // First frame that moved: the recede or the transform differs from the sample at the tap.
      const base = inRange[0]
      const moved = inRange.find((m) => m.p !== base.p || m.tr !== base.tr || m.s !== base.s)
      // At rest: six samples in a row alike after the finger left.
      let rest = null
      for (let k = 0; k + 6 <= inRange.length; k++) {
        if (inRange[k].t < (release?.t ?? tap.t)) continue
        if (moved && inRange[k].t <= moved.t) continue
        let same = true
        for (let j = k + 1; j < k + 6; j++) {
          if (inRange[j].p !== inRange[k].p || inRange[j].tr !== inRange[k].tr || inRange[j].s !== inRange[k].s) {
            same = false
            break
          }
        }
        if (same) {
          rest = inRange[k]
          break
        }
      }
      if (!moved || !rest) continue
      const frames = inRange.filter((m) => m.t >= moved.t && m.t <= rest.t)
      const intervals = []
      for (let k = 1; k < frames.length; k++) intervals.push(frames[k].t - frames[k - 1].t)
      motions.push({
        kind,
        tapT: tap.t,
        movedT: moved.t,
        restT: rest.t,
        waitMs: moved.t - (release?.t ?? tap.t),
        motionMs: rest.t - moved.t,
        frames: frames.length,
        intervalP50: median(intervals),
        intervalMax: intervals.length ? Math.max(...intervals) : NaN,
        dropped: intervals.filter((d) => d > 33).length,
        tsFrom: toTs(tap.t),
        tsTo: toTs(rest.t)
      })
    }
  } else if (probe && offset === null) {
    out.notes.push('probe clock could not be aligned to the trace (no shared marks)')
  }

  // Main-thread time per bucket inside each motion, and the rAF frames the trace saw.
  const perKind = {}
  for (const mo of motions) {
    const evs = main.filter((e) => !e.instant && inWindow(e, mo.tsFrom, mo.tsTo))
    const buckets = {}
    for (const e of evs) buckets[bucketOf(e.name)] = (buckets[bucketOf(e.name)] || 0) + e.self
    const rafs = evs.filter((e) => e.name === 'FireAnimationFrame' || e.name === 'BeginMainThreadFrame').length
    const layouts = evs.filter((e) => e.name === 'Layout').length
    const recalcs = evs.filter((e) => e.name === 'UpdateLayoutTree')
    const paints = evs.filter((e) => e.name === 'Paint').length
    const elements = sum(recalcs.map((e) => Number(e.args?.elementCount ?? e.args?.data?.elementCount ?? 0)))
    mo.mainBusyMs = busy(main, mo.tsFrom, mo.tsTo) / 1000
    mo.buckets = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v / 1000]))
    mo.traceFrames = rafs
    mo.layouts = layouts
    mo.recalcs = recalcs.length
    mo.recalcElements = elements
    mo.paints = paints
    ;(perKind[mo.kind] ||= []).push(mo)
  }
  out.motions = Object.fromEntries(
    Object.entries(perKind).map(([kind, list]) => {
      const agg = (f) => median(list.map(f))
      const framesTotal = sum(list.map((m) => Math.max(1, m.traceFrames || m.frames)))
      const bucketPerFrame = {}
      for (const m of list) for (const [k, v] of Object.entries(m.buckets)) bucketPerFrame[k] = (bucketPerFrame[k] || 0) + v
      for (const k of Object.keys(bucketPerFrame)) bucketPerFrame[k] /= framesTotal
      return [
        kind,
        {
          count: list.length,
          waitMs: agg((m) => m.waitMs),
          waitMaxMs: Math.max(...list.map((m) => m.waitMs)),
          motionMs: agg((m) => m.motionMs),
          frames: agg((m) => m.frames),
          intervalP50: agg((m) => m.intervalP50),
          intervalMax: Math.max(...list.map((m) => m.intervalMax)),
          droppedPerMotion: agg((m) => m.dropped),
          mainBusyShare: sum(list.map((m) => m.mainBusyMs)) / sum(list.map((m) => m.motionMs + m.waitMs)),
          layoutsPerFrame: sum(list.map((m) => m.layouts)) / framesTotal,
          recalcsPerFrame: sum(list.map((m) => m.recalcs)) / framesTotal,
          elementsPerRecalc: sum(list.map((m) => m.recalcElements)) / Math.max(1, sum(list.map((m) => m.recalcs))),
          paintsPerFrame: sum(list.map((m) => m.paints)) / framesTotal,
          msPerFrame: bucketPerFrame
        }
      ]
    })
  )

  // Over the scene: top self-time names, invalidation reasons, long tasks.
  const inScene = main.filter((e) => inWindow(e, a, b))
  const byName = new Map()
  for (const e of inScene) {
    if (e.instant) continue
    const cur = byName.get(e.name) || { self: 0, count: 0 }
    cur.self += e.self
    cur.count++
    byName.set(e.name, cur)
  }
  out.mainBusyMs = busy(main, a, b) / 1000
  out.topSelf = [...byName.entries()]
    .sort((x, y) => y[1].self - x[1].self)
    .slice(0, 14)
    .map(([name, v]) => ({ name, selfMs: v.self / 1000, count: v.count }))
  const reasons = (name, pick) => {
    const m = new Map()
    for (const e of inScene) {
      if (e.name !== name) continue
      const k = pick(e.args?.data || e.args || {})
      m.set(k, (m.get(k) || 0) + 1)
    }
    return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => ({ what: k, count: n }))
  }
  out.layoutInvalidations = reasons('LayoutInvalidationTracking', (d) => `${d.reason || '?'} on ${d.nodeName || '?'}`)
  out.styleInvalidations = reasons('StyleRecalcInvalidationTracking', (d) => `${d.reason || '?'}${d.extraData ? ' ' + d.extraData : ''} on ${d.nodeName || '?'}`)
  out.styleInvalidators = reasons('StyleInvalidatorInvalidationTracking', (d) => `${d.reason || '?'}${d.selectorPart ? ' ' + d.selectorPart : ''}`)
  out.paintInvalidations = reasons('PaintInvalidationTracking', (d) => `${d.reason || '?'} on ${d.nodeName || '?'}`)
  out.scheduleStyleRecalcs = inScene.filter((e) => e.name === 'ScheduleStyleRecalculation').length
  out.layouts = inScene.filter((e) => e.name === 'Layout').length
  const layoutRoots = inScene.filter((e) => e.name === 'Layout').map((e) => Number(e.args?.beginData?.dirtyObjects ?? 0))
  out.layoutDirtyObjectsMedian = median(layoutRoots)
  out.longTasks = inScene
    .filter((e) => !e.instant && e.depth === 0 && e.dur > 50000)
    .sort((x, y) => y.dur - x.dur)
    .slice(0, 8)
    .map((e) => {
      const kids = main.filter((k) => k.parent === e)
      const big = kids.sort((x, y) => y.dur - x.dur)[0]
      return { name: e.name, ms: e.dur / 1000, atMs: (e.ts - a) / 1000, child: big ? `${big.name} ${(big.dur / 1000).toFixed(1)} ms` : '' }
    })

  // Other threads' business in the scene.
  const threads = []
  for (const [key, list] of perThread) {
    const [pid] = key.split(':').map(Number)
    const t = busy(list, a, b) / 1000
    if (t < 20) continue
    threads.push({ process: `${procNames.get(pid) || 'process'} ${pid}${pid === chromePid ? ' (chrome)' : ''}`, thread: threadNames.get(key) || key, busyMs: t, share: t / out.windowMs })
  }
  threads.sort((x, y) => y.busyMs - x.busyMs)
  out.threads = threads.slice(0, 12)
  out.probe = probe
    ? {
        longTasks: (probe.long || []).length,
        longTaskMs: sum((probe.long || []).map((l) => l.d)),
        eventEntries: (probe.events || []).length,
        eventDurationP90: pct((probe.events || []).map((e) => e.d), 90)
      }
    : null
  return out
}

const scenes = loadScenes(join(dir, 'scenes.txt'))
const files = readdirSync(dir).filter((f) => /^webview-.*\.json\.gz$/.test(f)).sort()
const results = {}
for (const file of files) {
  const scene = file.replace(/^webview-/, '').replace(/\.json\.gz$/, '')
  try {
    const events = loadTrace(join(dir, file))
    const probe = loadProbe(join(dir, `chrome-${scene}.json.txt`))
    results[scene] = analyseScene(scene, events, probe, scenes[scene])
    results[scene].events = events.length
  } catch (e) {
    results[scene] = { scene, error: String(e && e.message ? e.message : e) }
  }
}

let md = ''
md += '| scene | motion | n | tap → first frame that moved (median / max) | motion | frames | frame interval p50 / max | frames > 33 ms | main busy | layouts / frame | recalcs / frame (elements) | paints / frame | ms per frame: style · layout · prepaint · paint · script · gc · other |\n'
md += '|---|---|---|---|---|---|---|---|---|---|---|---|---|\n'
for (const [scene, r] of Object.entries(results)) {
  if (r.error) {
    md += `| ${scene} | error | | ${r.error} | | | | | | | | | |\n`
    continue
  }
  for (const [kind, m] of Object.entries(r.motions || {})) {
    const b = m.msPerFrame
    md += `| ${scene} | ${kind} | ${m.count} | ${fmt(m.waitMs, 0)} / ${fmt(m.waitMaxMs, 0)} ms | ${fmt(m.motionMs, 0)} ms | ${fmt(m.frames, 0)} | ${fmt(m.intervalP50, 0)} / ${fmt(m.intervalMax, 0)} ms | ${fmt(m.droppedPerMotion, 0)} | ${fmt(100 * m.mainBusyShare, 0)} % | ${fmt(m.layoutsPerFrame, 2)} | ${fmt(m.recalcsPerFrame, 2)} (${fmt(m.elementsPerRecalc, 0)}) | ${fmt(m.paintsPerFrame, 2)} | ${fmt(b.style)} · ${fmt(b.layout)} · ${fmt(b.prepaint)} · ${fmt(b.paint)} · ${fmt(b.script)} · ${fmt(b.gc)} · ${fmt(b.other)} |\n`
  }
}
for (const [scene, r] of Object.entries(results)) {
  if (r.error) continue
  md += `\n**${scene}** – ${fmt(r.windowMs / 1000, 1)} s, ${r.events} events, chrome renderer pid ${r.chromePid}, main thread busy ${fmt(r.mainBusyMs, 0)} ms (${fmt((100 * r.mainBusyMs * 1000) / (r.windowMs * 1000), 0)} %)`
  if (r.notes.length) md += ` – ${r.notes.join('; ')}`
  md += '\n\n'
  md += `- top self time: ${r.topSelf.map((t) => `${t.name} ${fmt(t.selfMs, 0)} ms ×${t.count}`).join(', ')}\n`
  md += `- layouts ${r.layouts} (median dirty objects ${fmt(r.layoutDirtyObjectsMedian, 0)}), style recalcs scheduled ${r.scheduleStyleRecalcs}\n`
  if (r.layoutInvalidations.length) md += `- layout invalidations: ${r.layoutInvalidations.map((x) => `${x.what} ×${x.count}`).join('; ')}\n`
  if (r.styleInvalidations.length) md += `- style invalidations: ${r.styleInvalidations.map((x) => `${x.what} ×${x.count}`).join('; ')}\n`
  if (r.styleInvalidators.length) md += `- style invalidators: ${r.styleInvalidators.map((x) => `${x.what} ×${x.count}`).join('; ')}\n`
  if (r.paintInvalidations.length) md += `- paint invalidations: ${r.paintInvalidations.map((x) => `${x.what} ×${x.count}`).join('; ')}\n`
  if (r.longTasks.length) md += `- long tasks (> 50 ms): ${r.longTasks.map((t) => `${t.name} ${fmt(t.ms, 0)} ms at +${fmt(t.atMs / 1000, 1)} s${t.child ? ` (${t.child})` : ''}`).join('; ')}\n`
  if (r.probe) md += `- probe: ${r.probe.longTasks} long tasks (${fmt(r.probe.longTaskMs, 0)} ms), ${r.probe.eventEntries} slow input events, p90 event duration ${fmt(r.probe.eventDurationP90, 0)} ms\n`
  md += `- threads busy: ${r.threads.map((t) => `${t.thread} [${t.process}] ${fmt(t.busyMs, 0)} ms (${fmt(100 * t.share, 0)} %)`).join('; ')}\n`
}
process.stdout.write(md)
if (jsonOut) {
  for (const r of Object.values(results)) delete r.probe
  writeFileSync(jsonOut, JSON.stringify(results, null, 1))
}
