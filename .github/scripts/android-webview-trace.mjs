#!/usr/bin/env node
// Reads the chrome WebView's own Chromium traces a profiling driver captured per scene through
// android.webkit.TracingController (`webview-<scene>.json.gz`, Trace Event JSON) together with
// the driver's probe record (`chrome-<scene>.json.txt`: pointer taps, one sample per animation
// frame of the inline `--zen-recede` and the sheet's transform and height while a sheet moved,
// the sheet's and the page picture's mount / unmount moments, long tasks, Event Timing entries)
// and writes, per scene, what the chrome renderer's main thread did:
//  - per motion (a tap to the sheet at rest; a drag to its detent): the wait from the tap to the
//    first frame that moved and what filled it (the sheet's mount, the picture's mount, the main
//    thread's busy time and its top events), the motion's length, its frames and their
//    intervals (the stutter), the main thread's time per frame – in all, and in style recalc,
//    layout, pre-paint, paint, commit, accessibility, script, GC and the rest – with the layout,
//    style-recalc and paint counts per frame and the top events by self time in the motion;
//  - over the scene: the top events by self time, layouts and style recalcs, the long tasks,
//    and how busy the compositor, the page's renderer and the browser's threads were.
// The chrome renderer is the one whose main thread carries the probe's `menu-perf:*` user-timing
// marks; the probe's clock (performance.now) is aligned to the trace's through those marks.
// The trace is read as a stream, event by event: a scene over the github.com copy is hundreds
// of MB of JSON, more than one JS string holds (run 35540328965).
//
// Usage: node --max-old-space-size=8192 android-webview-trace.mjs <dir> [--json <file>]
import { readdirSync, readFileSync, existsSync, writeFileSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'

const dir = process.argv[2] || '.'
const jsonOut = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : null
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
const max = (xs) => (xs.length ? Math.max(...xs) : NaN)

/** Where a main-thread event's self time is booked; the first match wins. */
const BUCKETS = [
  [
    'style',
    /^(UpdateLayoutTree|Document::(recalcStyle|RecalcStyle|UpdateStyle)|RecalcStyle|StyleRecalc|StyleEngine::|Blink\.Style\.UpdateTime|ScheduleStyleRecalculation|StyleInvalidator|RuleFeatureSet|Element::RecalcStyle|StyleResolver)/
  ],
  [
    'layout',
    /^(Layout$|Layout |LayoutView::|LocalFrameView::(Perform|Update)Layout|LocalFrameView::UpdateStyleAndLayout|Blink\.Layout\.UpdateTime|IntersectionObserver|ResizeObserver|PostLayoutTasks|LayoutNG|LayoutBox|LayoutBlock)/
  ],
  [
    'prepaint',
    /^(PrePaint|Blink\.PrePaint\.UpdateTime|LocalFrameView::RunPrePaintLifecyclePhase|PaintPropertyTreeBuilder|PaintInvalidator)/
  ],
  [
    'paint',
    /^(Paint$|Paint |PaintImage|Blink\.Paint\.UpdateTime|LocalFrameView::RunPaintLifecyclePhase|PaintArtifactCompositor|Layerize|UpdateLayer|GraphicsLayer|Decode Image|Draw LazyPixelRef|PaintController|LocalFrameView::PaintTree|Blink\.Compositing\.UpdateTime|CompositingInputsUpdater|Compositing)/
  ],
  [
    'commit',
    /^(Commit$|ProxyMain::BeginMainFrame::commit|ProxyMain::Commit|LayerTreeHost::|ThreadProxy::Commit|LayerTreeHostImpl::|ProxyImpl::|SingleThreadProxy::|cc::|LayerTreeHost )/
  ],
  [
    'a11y',
    /^(Blink\.Accessibility|AXObjectCache|RenderAccessibilityImpl|AXTree|Accessibility|BlinkAX)/
  ],
  [
    'gc',
    /^(MinorGC|MajorGC|V8\.GC|BlinkGC|ThreadState::|Heap::|V8\.Scavenge|V8\.MarkCompact|V8\.External|V8\.GCScavenger|V8\.GCIncremental|V8\.GCFinalize)/
  ],
  ['hittest', /^HitTest/],
  [
    'script',
    /^(FunctionCall|EvaluateScript|v8\.|V8\.|TimerFire|FireAnimationFrame|EventDispatch|RunMicrotasks|Microtasks|CallFunction|XHR|ParseHTML|RequestAnimationFrame|ScheduledAction|DOMTimer|blink\.console|WebViewClient|JavaScript|PageAnimator::serviceScriptedAnimations|MessagePort::|PostMessage|Window::|EventTarget|ScriptRunner|CompileScript|v8|ExecuteScript)/
  ]
]
function bucketOf(name) {
  for (const [b, re] of BUCKETS) if (re.test(name)) return b
  return 'other'
}
const BUCKET_ORDER = [
  'style',
  'layout',
  'prepaint',
  'paint',
  'commit',
  'a11y',
  'script',
  'gc',
  'other'
]

/**
 * The trace's events, read from the gzip stream one object at a time: a `{` met inside the
 * events array (the top-level array, or `traceEvents` of the top-level object) opens an event,
 * its matching `}` closes it. A stream cut short simply ends with its last whole event.
 */
async function loadTrace(file) {
  const events = []
  const gunzip = createGunzip()
  createReadStream(file).pipe(gunzip)
  const stack = [] // container chars on the way in: '{' or '['
  let inStr = false
  let esc = false
  let eventDepth = -1 // stack length at which an event object opens; -1 until the array is found
  let parts = null // chunks of the event being read
  let start = -1 // where in the current chunk the event began
  let malformed = 0
  for await (const chunk of gunzip) {
    if (parts) start = 0
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === 0x5c) esc = true
        else if (c === 0x22) inStr = false
        continue
      }
      if (c === 0x22) {
        inStr = true
        continue
      }
      if (c === 0x5b) {
        // [ – the events array is the first array within the first two levels.
        if (eventDepth < 0 && stack.length <= 1) eventDepth = stack.length + 1
        stack.push(c)
      } else if (c === 0x7b) {
        // {
        if (stack.length === eventDepth && stack[stack.length - 1] === 0x5b && !parts) {
          parts = []
          start = i
        }
        stack.push(c)
      } else if (c === 0x5d || c === 0x7d) {
        // ] }
        stack.pop()
        if (parts && c === 0x7d && stack.length === eventDepth) {
          parts.push(chunk.subarray(start, i + 1))
          const text = Buffer.concat(parts).toString('utf8')
          parts = null
          try {
            events.push(JSON.parse(text))
          } catch {
            malformed++
          }
        }
      }
    }
    if (parts) parts.push(chunk.subarray(start))
  }
  return { events, malformed, truncated: parts !== null }
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
    if (p.length >= 5)
      scenes[p[0]] = { startMonoUs: Number(p[3]) / 1000, endMonoUs: Number(p[4]) / 1000 }
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
    if (typeof e.name === 'string' && e.name.startsWith('menu-perf:'))
      marks.push({ name: e.name.slice('menu-perf:'.length), ts: e.ts, pid: e.pid, tid: e.tid })
    const key = `${e.pid}:${e.tid}`
    if (e.ph === 'X') {
      if (!(e.dur >= 0)) continue
      ;(perThread.get(key) || perThread.set(key, []).get(key)).push({
        name: e.name,
        cat: e.cat,
        ts: e.ts,
        dur: e.dur,
        args: e.args
      })
    } else if (e.ph === 'B') {
      ;(openB.get(key) || openB.set(key, []).get(key)).push(e)
    } else if (e.ph === 'E') {
      const stack = openB.get(key)
      const b = stack?.pop()
      if (b)
        (perThread.get(key) || perThread.set(key, []).get(key)).push({
          name: b.name,
          cat: b.cat,
          ts: b.ts,
          dur: e.ts - b.ts,
          args: { ...(b.args || {}), ...(e.args || {}) }
        })
    } else if (e.ph === 'I' || e.ph === 'i' || e.ph === 'R' || e.ph === 'n') {
      ;(perThread.get(key) || perThread.set(key, []).get(key)).push({
        name: e.name,
        cat: e.cat,
        ts: e.ts,
        dur: 0,
        args: e.args,
        instant: true
      })
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
      while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= ev.ts)
        stack.pop()
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

/** The names with the most self time among `evs`, as "name ms ×n". */
function topSelf(evs, n) {
  const byName = new Map()
  for (const e of evs) {
    if (e.instant) continue
    const cur = byName.get(e.name) || { self: 0, count: 0 }
    cur.self += e.self
    cur.count++
    byName.set(e.name, cur)
  }
  return [...byName.entries()]
    .sort((x, y) => y[1].self - x[1].self)
    .slice(0, n)
    .map(([name, v]) => ({ name, selfMs: v.self / 1000, count: v.count }))
}

/**
 * One style recalc: the DevTools `UpdateLayoutTree` event, which wraps Blink's
 * `Document::recalcStyle` (counting both would double it); the inner one when the DevTools
 * timeline category was not on.
 */
const under = (e, name) => {
  for (let p = e.parent; p; p = p.parent) if (p.name === name) return true
  return false
}
const isRecalc = (e) =>
  !e.instant &&
  (e.name === 'UpdateLayoutTree' ||
    (e.name === 'Document::recalcStyle' && !under(e, 'UpdateLayoutTree')))

function sameSample(x, y) {
  return x.p === y.p && x.tr === y.tr && (x.h ?? '') === (y.h ?? '') && x.s === y.s
}

// The first probe sample that is real motion for a half-cycle kind (see the caller).
function firstMoved(kind, inRange) {
  if (kind === 'open') {
    const mountAt = inRange.findIndex((m) => m.s === 1)
    if (mountAt < 0) return null
    const mount = inRange[mountAt]
    return (
      inRange
        .slice(mountAt + 1)
        .find((m) => m.s === 1 && ((m.p > 0 && m.p !== mount.p) || m.tr !== mount.tr)) ?? null
    )
  }
  const base = inRange[0]
  return (
    inRange.find(
      (m) => m.tr !== base.tr || (m.h ?? '') !== (base.h ?? '') || m.p !== base.p || m.s !== base.s
    ) ?? null
  )
}

function analyseScene(scene, loaded, probe, clocks) {
  const { events, malformed, truncated } = loaded
  const { procNames, threadNames, perThread, marks } = buildThreads(events)
  const out = { scene, notes: [] }
  if (truncated) out.notes.push('the trace stream was cut short (its last event was incomplete)')
  if (malformed) out.notes.push(`${malformed} events did not parse`)

  // The chrome renderer: the thread carrying the probe's marks, else the renderer main thread with the most rAFs.
  let mainKey = null
  const markCounts = new Map()
  for (const m of marks)
    markCounts.set(`${m.pid}:${m.tid}`, (markCounts.get(`${m.pid}:${m.tid}`) || 0) + 1)
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
    out.notes.push(
      'no menu-perf marks in the trace; the chrome renderer was taken as the one with the most animation frames'
    )
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
  // A ring buffer that filled drops the oldest events: say so, since the early motions would then
  // have no trace behind their probe record.
  const firstTs = main[0]?.ts ?? a
  if (firstTs > a + 1_000_000) {
    out.notes.push(
      `the trace starts ${((firstTs - a) / 1000).toFixed(0)} ms into the scene's ${out.windowMs.toFixed(0)} ms window (the buffer overran): motions before that have probe numbers only`
    )
  }

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
    const pmarks = probe.marks || []
    const starts = pmarks.filter((m) => /:\d+:start$/.test(m.n))
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i]
      const kind = s.n.split(':')[0]
      const next = starts[i + 1]?.t ?? Infinity
      const endMarkT = pmarks.find((m) => m.n === s.n.replace(':start', ':end'))?.t ?? next
      const drag = kind.startsWith('drag')
      // The finger event the half-cycle acts on: the click (the up) opens the menu; the scrim
      // dismisses on the pointerdown (§9.20); a drag follows the finger from its down.
      const onDown = drag || kind === 'close'
      const tap = taps.find((t) => t.t >= s.t && t.t < endMarkT && t.k === (onDown ? 'down' : 'up'))
      if (!tap) continue
      const release = onDown ? taps.find((t) => t.t >= tap.t && t.k === 'up') : tap
      const inRange = samples.filter((m) => m.t >= tap.t && m.t < Math.min(next, endMarkT + 3000))
      if (inRange.length < 3) continue
      // First frame that moved: true motion only. On the open the sheet first MOUNTS at rest
      // (p 0, translated fully below the screen); the motion is the first frame after that whose
      // recede or transform differs from the mount pose. On the close and the drags the pose at
      // the finger is the base and the first frame whose transform, height or recede differs is
      // the motion; the sheet vanishing counts as moved too (a close that never animated).
      const moved = firstMoved(kind, inRange)
      // At rest: six samples in a row alike after the finger left (a drag settles after the up).
      const from = onDown ? tap.t : (release?.t ?? tap.t)
      let rest = null
      for (let k = 0; k + 6 <= inRange.length; k++) {
        if (inRange[k].t < (release?.t ?? tap.t)) continue
        if (moved && inRange[k].t <= moved.t) continue
        let same = true
        for (let j = k + 1; j < k + 6; j++) {
          if (!sameSample(inRange[j], inRange[k])) {
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
      // The open's picture may be mounted before the click: the press on the menu button takes
      // the capture (`prepareMenu`) and the chassis mounts it under the live page as it lands
      // (`coverPrimed`), so its mark is looked for from the pointerdown that began the tap; a
      // negative number then says how long before the click it was there.
      const press =
        kind === 'open' ? taps.filter((t) => t.k === 'down' && t.t <= tap.t).at(-1) : null
      const markAfter = (name, since = tap.t - 5) => {
        const m = pmarks.find(
          (x) => x.n === name && x.t >= since && x.t < Math.min(next, endMarkT + 3000)
        )
        return m ? m.t - from : NaN
      }
      motions.push({
        kind,
        tapT: tap.t,
        movedT: moved.t,
        restT: rest.t,
        waitMs: moved.t - from,
        motionMs: rest.t - moved.t,
        frames: frames.length,
        intervalP50: median(intervals),
        intervalMax: max(intervals),
        dropped: intervals.filter((d) => d > 33).length,
        sheetMountedMs: markAfter(kind === 'open' ? 'sheet-mounted' : 'sheet-unmounted'),
        coverMountedMs:
          kind === 'open'
            ? markAfter('cover-mounted', press ? press.t - 5 : tap.t - 5)
            : markAfter('cover-unmounted'),
        tsTap: toTs(from),
        tsFrom: toTs(moved.t),
        tsTo: toTs(rest.t)
      })
    }
  } else if (probe && offset === null) {
    out.notes.push('probe clock could not be aligned to the trace (no shared marks)')
  }

  // Main-thread time per bucket inside each motion, and the frames the trace saw.
  const perKind = {}
  for (const mo of motions) {
    const evs = main.filter((e) => !e.instant && inWindow(e, mo.tsFrom, mo.tsTo))
    const buckets = {}
    for (const e of evs) buckets[bucketOf(e.name)] = (buckets[bucketOf(e.name)] || 0) + e.self
    const bmf = evs
      .filter((e) => e.name === 'ProxyMain::BeginMainFrame' || e.name === 'BeginMainThreadFrame')
      .map((e) => e.dur / 1000)
    const rafs = evs.filter(
      (e) => e.name === 'FireAnimationFrame' || e.name === 'BeginMainThreadFrame'
    ).length
    mo.mainBusyMs = busy(main, mo.tsFrom, mo.tsTo) / 1000
    mo.buckets = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v / 1000]))
    mo.traceFrames = Math.max(bmf.length, rafs)
    mo.mainFrameP50 = median(bmf)
    mo.mainFrameMax = max(bmf)
    mo.mainFramesOver16 = bmf.filter((d) => d > 16.7).length
    mo.layouts = evs.filter((e) => e.name === 'Layout').length
    mo.recalcs = evs.filter(isRecalc).length
    mo.paints = evs.filter((e) => e.name === 'Paint').length
    mo.top = topSelf(evs, 6)
    // The wait: from the finger to the first frame that moved.
    const waitEvs = main.filter((e) => !e.instant && inWindow(e, mo.tsTap, mo.tsFrom))
    mo.waitBusyMs = busy(main, mo.tsTap, mo.tsFrom) / 1000
    mo.waitTop = topSelf(waitEvs, 5)
    mo.waitLayouts = waitEvs.filter((e) => e.name === 'Layout').length
    mo.waitRecalcs = waitEvs.filter(isRecalc).length
    ;(perKind[mo.kind] ||= []).push(mo)
  }
  out.motions = Object.fromEntries(
    Object.entries(perKind).map(([kind, list]) => {
      const agg = (f) => median(list.map(f))
      const framesTotal = sum(list.map((m) => Math.max(1, m.traceFrames || m.frames)))
      const bucketPerFrame = {}
      for (const m of list)
        for (const [k, v] of Object.entries(m.buckets))
          bucketPerFrame[k] = (bucketPerFrame[k] || 0) + v
      for (const k of Object.keys(bucketPerFrame)) bucketPerFrame[k] /= framesTotal
      const mergeTop = (pick, n) => {
        const m = new Map()
        for (const mo of list)
          for (const t of pick(mo)) {
            const cur = m.get(t.name) || { selfMs: 0, count: 0 }
            cur.selfMs += t.selfMs
            cur.count += t.count
            m.set(t.name, cur)
          }
        return [...m.entries()]
          .sort((x, y) => y[1].selfMs - x[1].selfMs)
          .slice(0, n)
          .map(([name, v]) => ({
            name,
            selfMs: v.selfMs / list.length,
            count: v.count / list.length
          }))
      }
      return [
        kind,
        {
          count: list.length,
          waitMs: agg((m) => m.waitMs),
          waitMaxMs: max(list.map((m) => m.waitMs)),
          sheetMountedMs: agg((m) => m.sheetMountedMs),
          coverMountedMs: agg((m) => m.coverMountedMs),
          waitBusyMs: agg((m) => m.waitBusyMs),
          waitLayouts: agg((m) => m.waitLayouts),
          waitRecalcs: agg((m) => m.waitRecalcs),
          waitTop: mergeTop((m) => m.waitTop, 5),
          motionMs: agg((m) => m.motionMs),
          frames: agg((m) => m.frames),
          traceFrames: agg((m) => m.traceFrames),
          intervalP50: agg((m) => m.intervalP50),
          intervalMax: max(list.map((m) => m.intervalMax)),
          droppedPerMotion: agg((m) => m.dropped),
          mainBusyShare: sum(list.map((m) => m.mainBusyMs)) / sum(list.map((m) => m.motionMs)),
          mainMsPerFrame: sum(list.map((m) => m.mainBusyMs)) / framesTotal,
          mainFrameP50: agg((m) => m.mainFrameP50),
          mainFrameMax: max(list.map((m) => m.mainFrameMax)),
          mainFramesOver16: sum(list.map((m) => m.mainFramesOver16)) / list.length,
          layoutsPerFrame: sum(list.map((m) => m.layouts)) / framesTotal,
          recalcsPerFrame: sum(list.map((m) => m.recalcs)) / framesTotal,
          paintsPerFrame: sum(list.map((m) => m.paints)) / framesTotal,
          msPerFrame: bucketPerFrame,
          top: mergeTop((m) => m.top, 6)
        }
      ]
    })
  )

  // Over the scene: top self-time names, invalidation reasons, long tasks.
  const inScene = main.filter((e) => inWindow(e, a, b))
  out.mainBusyMs = busy(main, a, b) / 1000
  out.topSelf = topSelf(inScene, 14)
  const reasons = (name, pick) => {
    const m = new Map()
    for (const e of inScene) {
      if (e.name !== name) continue
      const k = pick(e.args?.data || e.args || {})
      m.set(k, (m.get(k) || 0) + 1)
    }
    return [...m.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8)
      .map(([k, n]) => ({ what: k, count: n }))
  }
  out.layoutInvalidations = reasons(
    'LayoutInvalidationTracking',
    (d) => `${d.reason || '?'} on ${d.nodeName || '?'}`
  )
  out.styleInvalidations = reasons(
    'StyleRecalcInvalidationTracking',
    (d) => `${d.reason || '?'}${d.extraData ? ' ' + d.extraData : ''} on ${d.nodeName || '?'}`
  )
  out.styleInvalidators = reasons(
    'StyleInvalidatorInvalidationTracking',
    (d) => `${d.reason || '?'}${d.selectorPart ? ' ' + d.selectorPart : ''}`
  )
  out.paintInvalidations = reasons(
    'PaintInvalidationTracking',
    (d) => `${d.reason || '?'} on ${d.nodeName || '?'}`
  )
  out.scheduleStyleRecalcs = inScene.filter((e) => e.name === 'ScheduleStyleRecalculation').length
  out.recalcs = inScene.filter(isRecalc).length
  out.layouts = inScene.filter((e) => !e.instant && e.name === 'Layout').length
  out.paints = inScene.filter((e) => !e.instant && e.name === 'Paint').length
  const layoutRoots = inScene
    .filter((e) => e.name === 'Layout')
    .map((e) => Number(e.args?.beginData?.dirtyObjects ?? 0))
  out.layoutDirtyObjectsMedian = median(layoutRoots)
  out.longTasks = inScene
    .filter((e) => !e.instant && e.depth === 0 && e.dur > 50000)
    .sort((x, y) => y.dur - x.dur)
    .slice(0, 8)
    .map((e) => {
      const kids = main.filter((k) => k.parent === e)
      const big = kids.sort((x, y) => y.dur - x.dur)[0]
      return {
        name: e.name,
        ms: e.dur / 1000,
        atMs: (e.ts - a) / 1000,
        child: big ? `${big.name} ${(big.dur / 1000).toFixed(1)} ms` : ''
      }
    })

  // Other threads' business in the scene.
  const threads = []
  for (const [key, list] of perThread) {
    const [pid] = key.split(':').map(Number)
    const t = busy(list, a, b) / 1000
    if (t < 20) continue
    threads.push({
      process: `${procNames.get(pid) || 'process'} ${pid}${pid === chromePid ? ' (chrome)' : ''}`,
      thread: threadNames.get(key) || key,
      busyMs: t,
      share: t / out.windowMs
    })
  }
  threads.sort((x, y) => y.busyMs - x.busyMs)
  out.threads = threads.slice(0, 12)
  out.probe = probe
    ? {
        longTasks: (probe.long || []).length,
        longTaskMs: sum((probe.long || []).map((l) => l.d)),
        eventEntries: (probe.events || []).length,
        eventDurationP90: pct(
          (probe.events || []).map((e) => e.d),
          90
        )
      }
    : null
  return out
}

const scenes = loadScenes(join(dir, 'scenes.txt'))
const files = readdirSync(dir)
  .filter((f) => /^webview-.*\.json\.gz$/.test(f))
  .sort()
const results = {}
for (const file of files) {
  const scene = file.replace(/^webview-/, '').replace(/\.json\.gz$/, '')
  try {
    const loaded = await loadTrace(join(dir, file))
    const probe = loadProbe(join(dir, `chrome-${scene}.json.txt`))
    results[scene] = analyseScene(scene, loaded, probe, scenes[scene])
    results[scene].events = loaded.events.length
  } catch (e) {
    results[scene] = { scene, error: String(e && e.message ? e.message : e) }
  }
}

const topText = (list) =>
  list.map((t) => `${t.name} ${fmt(t.selfMs, 1)} ms ×${fmt(t.count, 0)}`).join(', ')
let md = ''
md +=
  "Per motion (medians over the cycles; the chrome renderer's main thread): the frames are the probe's animation frames from the first that moved to rest; \"main ms / frame\" is the main thread's busy time over the motion per frame; BeginMainFrame is the main thread's part of a compositor frame.\n\n"
md +=
  '| scene | motion | n | finger → first frame that moved (median / max; the click for the open, the down for the close and the drags) | motion | frames | frame interval p50 / max (emulator) | main ms / frame | BeginMainFrame p50 / max, > 16.7 ms per motion | layouts / frame | recalcs / frame | paints / frame | ms per frame: style · layout · prepaint · paint · commit · a11y · script · gc · other |\n'
md += '|---|---|---|---|---|---|---|---|---|---|---|---|---|\n'
for (const [scene, r] of Object.entries(results)) {
  if (r.error) {
    md += `| ${scene} | error | | ${r.error} | | | | | | | | | |\n`
    continue
  }
  for (const [kind, m] of Object.entries(r.motions || {})) {
    const b = m.msPerFrame
    md += `| ${scene} | ${kind} | ${m.count} | ${fmt(m.waitMs, 0)} / ${fmt(m.waitMaxMs, 0)} ms | ${fmt(m.motionMs, 0)} ms | ${fmt(m.frames, 0)} | ${fmt(m.intervalP50, 0)} / ${fmt(m.intervalMax, 0)} ms | ${fmt(m.mainMsPerFrame, 1)} | ${fmt(m.mainFrameP50, 1)} / ${fmt(m.mainFrameMax, 0)} ms, ${fmt(m.mainFramesOver16, 1)} | ${fmt(m.layoutsPerFrame, 2)} | ${fmt(m.recalcsPerFrame, 2)} | ${fmt(m.paintsPerFrame, 2)} | ${BUCKET_ORDER.map((k) => fmt(b[k] ?? 0)).join(' · ')} |\n`
  }
}
md +=
  "\nThe wait before the first frame that moved (medians): what the main thread did between the finger and the motion, and when the DOM saw the sheet and the page's picture come (the open) or go (the close).\n\n"
md +=
  '| scene | motion | tap → sheet mounted / unmounted | tap → picture mounted / unmounted | tap → first moved frame | main busy in the wait | layouts / recalcs in the wait | top self time in the wait |\n|---|---|---|---|---|---|---|---|\n'
for (const [scene, r] of Object.entries(results)) {
  if (r.error) continue
  for (const [kind, m] of Object.entries(r.motions || {})) {
    md += `| ${scene} | ${kind} | ${fmt(m.sheetMountedMs, 0)} ms | ${fmt(m.coverMountedMs, 0)} ms | ${fmt(m.waitMs, 0)} ms | ${fmt(m.waitBusyMs, 0)} ms | ${fmt(m.waitLayouts, 0)} / ${fmt(m.waitRecalcs, 0)} | ${topText(m.waitTop)} |\n`
  }
}
md += '\nTop self time inside the motions (mean per motion):\n\n'
for (const [scene, r] of Object.entries(results)) {
  if (r.error) continue
  for (const [kind, m] of Object.entries(r.motions || {}))
    md += `- ${scene} ${kind}: ${topText(m.top)}\n`
}
for (const [scene, r] of Object.entries(results)) {
  if (r.error) continue
  if (!r.topSelf) {
    md += `\n**${scene}** – ${r.events} events: ${r.notes.join('; ') || 'nothing to read'}\n`
    continue
  }
  md += `\n**${scene}** – ${fmt(r.windowMs / 1000, 1)} s, ${r.events} events, chrome renderer pid ${r.chromePid}, main thread busy ${fmt(r.mainBusyMs, 0)} ms (${fmt((100 * r.mainBusyMs * 1000) / (r.windowMs * 1000), 0)} %)`
  if (r.notes.length) md += ` – ${r.notes.join('; ')}`
  md += '\n\n'
  md += `- top self time: ${r.topSelf.map((t) => `${t.name} ${fmt(t.selfMs, 0)} ms ×${t.count}`).join(', ')}\n`
  md += `- layouts ${r.layouts} (median dirty objects ${fmt(r.layoutDirtyObjectsMedian, 0)}), style recalcs ${r.recalcs} (${r.scheduleStyleRecalcs} scheduled), paints ${r.paints}\n`
  if (r.layoutInvalidations.length)
    md += `- layout invalidations: ${r.layoutInvalidations.map((x) => `${x.what} ×${x.count}`).join('; ')}\n`
  if (r.styleInvalidations.length)
    md += `- style invalidations: ${r.styleInvalidations.map((x) => `${x.what} ×${x.count}`).join('; ')}\n`
  if (r.styleInvalidators.length)
    md += `- style invalidators: ${r.styleInvalidators.map((x) => `${x.what} ×${x.count}`).join('; ')}\n`
  if (r.paintInvalidations.length)
    md += `- paint invalidations: ${r.paintInvalidations.map((x) => `${x.what} ×${x.count}`).join('; ')}\n`
  if (r.longTasks.length)
    md += `- long tasks (> 50 ms): ${r.longTasks.map((t) => `${t.name} ${fmt(t.ms, 0)} ms at +${fmt(t.atMs / 1000, 1)} s${t.child ? ` (${t.child})` : ''}`).join('; ')}\n`
  if (r.probe)
    md += `- probe: ${r.probe.longTasks} long tasks (${fmt(r.probe.longTaskMs, 0)} ms), ${r.probe.eventEntries} slow input events, p90 event duration ${fmt(r.probe.eventDurationP90, 0)} ms\n`
  md += `- threads busy: ${r.threads.map((t) => `${t.thread} [${t.process}] ${fmt(t.busyMs, 0)} ms (${fmt(100 * t.share, 0)} %)`).join('; ')}\n`
}
process.stdout.write(md)
if (jsonOut) {
  for (const r of Object.values(results)) delete r.probe
  writeFileSync(jsonOut, JSON.stringify(results, null, 1))
}
