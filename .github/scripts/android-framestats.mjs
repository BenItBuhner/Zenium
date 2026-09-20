#!/usr/bin/env node
// Reads the `dumpsys gfxinfo <app> framestats` dumps a profiling driver wrote per scene
// (`framestats-<scene>.txt`: `=== <scene> <step> ===` sections, each one dump taken after a
// settled half-cycle, the last one at the scene's end) and writes one Markdown table per run:
// per scene the frames HWUI drew, the share over the 60 Hz interval (and HWUI's own janky
// count), the 50 / 90 / 95 / 99th percentiles of the frame time (IntendedVsync to
// FrameCompleted), and the stage that was longest in the long frames, from the per-frame
// columns of the PROFILEDATA block:
//   vsync-delay  IntendedVsync -> HandleInputStart   (the UI thread started late: busy elsewhere)
//   input        HandleInputStart -> AnimationStart
//   animation    AnimationStart -> PerformTraversalsStart
//   layout       PerformTraversalsStart -> DrawStart  (measure / layout)
//   draw         DrawStart -> SyncQueued              (recording the display list)
//   sync-wait    SyncQueued -> SyncStart              (waiting for the RenderThread)
//   sync         SyncStart -> IssueDrawCommandsStart  (sync and uploads)
//   issue        IssueDrawCommandsStart -> SwapBuffers (GPU commands; the WebView functor draws here)
//   swap         SwapBuffers -> FrameCompleted
// The profile ring holds 120 frames, hence a dump per half-cycle; frames are told apart by their
// IntendedVsync. A frame flagged WindowLayoutChanged (bit 0) or SkippedFrame (bit 3) is left out,
// as HWUI's jank tracker leaves it out. Steps (`<n>-open`, `<n>-close`, `<n>-up`, `<n>-down`) are
// summed by kind, so the open and the close halves of a cycle are told apart.
//
// Usage: node android-framestats.mjs <dir> [--json <file>]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || '.'
const jsonOut = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : null

const STAGES = [
  ['vsync-delay', 'IntendedVsync', 'HandleInputStart'],
  ['input', 'HandleInputStart', 'AnimationStart'],
  ['animation', 'AnimationStart', 'PerformTraversalsStart'],
  ['layout', 'PerformTraversalsStart', 'DrawStart'],
  ['draw', 'DrawStart', 'SyncQueued'],
  ['sync-wait', 'SyncQueued', 'SyncStart'],
  ['sync', 'SyncStart', 'IssueDrawCommandsStart'],
  ['issue', 'IssueDrawCommandsStart', 'SwapBuffers'],
  ['swap', 'SwapBuffers', 'FrameCompleted']
]

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}
const ms = (ns) => ns / 1e6
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–')

function parseDump(text) {
  const summary = {}
  for (const [key, re] of [
    ['total', /Total frames rendered: (\d+)/],
    ['janky', /Janky frames: (\d+) \(([\d.]+)%\)/],
    ['p50', /50th percentile: (\d+)ms/],
    ['p90', /90th percentile: (\d+)ms/],
    ['p95', /95th percentile: (\d+)ms/],
    ['p99', /99th percentile: (\d+)ms/],
    ['missedVsync', /Number Missed Vsync: (\d+)/],
    ['slowUi', /Number Slow UI thread: (\d+)/],
    ['slowIssue', /Number Slow issue draw commands: (\d+)/],
    ['slowUploads', /Number Slow bitmap uploads: (\d+)/],
    ['deadlineMissed', /Number Frame deadline missed: (\d+)/]
  ]) {
    const m = text.match(re)
    if (m) summary[key] = key === 'janky' ? { count: +m[1], pct: +m[2] } : +m[1]
  }
  const frames = []
  const blocks = text.split('---PROFILEDATA---')
  for (let i = 1; i < blocks.length; i += 2) {
    const lines = blocks[i].trim().split('\n')
    const header = lines[0]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const line of lines.slice(1)) {
      const cells = line
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      if (cells.length < header.length - 1) continue
      const row = {}
      header.forEach((name, j) => (row[name] = Number(cells[j])))
      frames.push(row)
    }
  }
  return { summary, frames }
}

function stageOf(frame) {
  const stages = {}
  for (const [name, a, b] of STAGES) {
    const d = frame[b] - frame[a]
    stages[name] = Number.isFinite(d) && d > 0 ? d : 0
  }
  return stages
}

/**
 * The display's frame interval (ms). HWUI's dump has the FrameInterval and FrameStartTime
 * columns the other way round from its header (the interval, 16666666 ns at 60 Hz, sits under
 * FrameStartTime; a timestamp under FrameInterval – run 35540328965 read the timestamp as the
 * interval and found no frame long). Take whichever of the two is a plausible interval.
 */
function frameInterval(frames) {
  for (const f of frames) {
    for (const v of [f.FrameInterval, f.FrameStartTime]) if (v > 1e6 && v < 1e9) return ms(v)
  }
  return 16.667
}

function analyse(frames) {
  const totals = frames.map((f) => ms(f.FrameCompleted - f.IntendedVsync)).sort((a, b) => a - b)
  const interval = frameInterval(frames)
  const long = frames.filter((f) => ms(f.FrameCompleted - f.IntendedVsync) > interval)
  const longStage = {}
  const stageSumLong = {}
  const stageSumAll = {}
  for (const f of frames) {
    const s = stageOf(f)
    for (const k of Object.keys(s)) stageSumAll[k] = (stageSumAll[k] || 0) + s[k]
  }
  for (const f of long) {
    const s = stageOf(f)
    let best = null
    for (const k of Object.keys(s)) {
      stageSumLong[k] = (stageSumLong[k] || 0) + s[k]
      if (best === null || s[k] > s[best]) best = k
    }
    if (best) longStage[best] = (longStage[best] || 0) + 1
  }
  const ranked = Object.entries(longStage).sort((a, b) => b[1] - a[1])
  return {
    frames: frames.length,
    interval,
    long: long.length,
    longPct: frames.length ? (100 * long.length) / frames.length : NaN,
    p50: percentile(totals, 50),
    p90: percentile(totals, 90),
    p95: percentile(totals, 95),
    p99: percentile(totals, 99),
    max: totals.length ? totals[totals.length - 1] : NaN,
    mean: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : NaN,
    longStage: ranked.map(([k, n]) => ({ stage: k, count: n, share: n / (long.length || 1) })),
    stageMeanLong: Object.fromEntries(
      Object.entries(stageSumLong).map(([k, v]) => [k, ms(v) / (long.length || 1)])
    ),
    stageMeanAll: Object.fromEntries(
      Object.entries(stageSumAll).map(([k, v]) => [k, ms(v) / (frames.length || 1)])
    )
  }
}

const results = {}
const files = readdirSync(dir)
  .filter((f) => /^framestats-.*\.txt$/.test(f))
  .sort()
for (const file of files) {
  const scene = file.replace(/^framestats-/, '').replace(/\.txt$/, '')
  const text = readFileSync(join(dir, file), 'utf8')
  const sections = text.split(/^=== .*? (\S+) ===$/m)
  // split() leaves [prelude, step1, body1, step2, body2, ...]
  const seen = new Set()
  const all = []
  const byKind = {}
  let lastSummary = {}
  for (let i = 1; i < sections.length; i += 2) {
    const step = sections[i]
    const { summary, frames } = parseDump(sections[i + 1] || '')
    if (Object.keys(summary).length) lastSummary = summary
    const kind = step.replace(/^\d+-/, '')
    const fresh = []
    for (const f of frames) {
      if (!(f.Flags & 1) && !(f.Flags & 8) && f.FrameCompleted > 0 && f.IntendedVsync > 0) {
        const key = `${f.IntendedVsync}`
        if (seen.has(key)) continue
        seen.add(key)
        fresh.push(f)
        all.push(f)
      }
    }
    if (kind !== 'end') (byKind[kind] ||= []).push(...fresh)
  }
  results[scene] = {
    hwui: lastSummary,
    all: analyse(all),
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, analyse(v)]))
  }
}

function stageText(a) {
  if (!a.longStage.length) return '–'
  return a.longStage
    .slice(0, 2)
    .map((s) => `${s.stage} ${Math.round(100 * s.share)} % (${fmt(a.stageMeanLong[s.stage])} ms)`)
    .join(', ')
}

let md = ''
md +=
  '| scene | frames | > 16.7 ms (HWUI janky) | p50 | p90 | p95 | p99 | max | long stage (share of long frames, mean in them) |\n'
md += '|---|---|---|---|---|---|---|---|---|\n'
for (const [scene, r] of Object.entries(results)) {
  const a = r.all
  const hw = r.hwui.janky ? ` (${r.hwui.janky.count}/${r.hwui.total}, ${r.hwui.janky.pct} %)` : ''
  md += `| ${scene} | ${a.frames} | ${a.long} (${fmt(a.longPct, 0)} %)${hw} | ${fmt(a.p50)} | ${fmt(a.p90)} | ${fmt(a.p95)} | ${fmt(a.p99)} | ${fmt(a.max, 0)} | ${stageText(a)} |\n`
}
md += '\nBy half-cycle kind (frames drawn from the touch to the settled sheet or page):\n\n'
md +=
  '| scene | step | frames | > 16.7 ms | p50 | p90 | p99 | max | long stage |\n|---|---|---|---|---|---|---|---|---|\n'
for (const [scene, r] of Object.entries(results)) {
  for (const [kind, a] of Object.entries(r.byKind)) {
    md += `| ${scene} | ${kind} | ${a.frames} | ${a.long} (${fmt(a.longPct, 0)} %) | ${fmt(a.p50)} | ${fmt(a.p90)} | ${fmt(a.p99)} | ${fmt(a.max, 0)} | ${stageText(a)} |\n`
  }
}
md += '\nMean stage time per frame, ms (all frames of the scene):\n\n'
const stageNames = STAGES.map((s) => s[0])
md += `| scene | ${stageNames.join(' | ')} |\n|---|${stageNames.map(() => '---').join('|')}|\n`
for (const [scene, r] of Object.entries(results)) {
  md += `| ${scene} | ${stageNames.map((s) => fmt(r.all.stageMeanAll[s] ?? NaN, 2)).join(' | ')} |\n`
}
for (const [scene, r] of Object.entries(results)) {
  const h = r.hwui
  if (h.total !== undefined) {
    md += `\n${scene}: HWUI since reset: ${h.total} frames, janky ${h.janky?.count ?? '?'} (${h.janky?.pct ?? '?'} %), p50/90/95/99 ${h.p50}/${h.p90}/${h.p95}/${h.p99} ms, missed vsync ${h.missedVsync}, slow UI thread ${h.slowUi}, slow issue ${h.slowIssue}, slow uploads ${h.slowUploads}, deadline missed ${h.deadlineMissed}\n`
  }
}
process.stdout.write(md)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1))
