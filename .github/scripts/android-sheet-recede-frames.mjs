#!/usr/bin/env node
// Measures the page in a sheet recede recording (android-sheet-recede-demo.sh) the way the
// driver (SheetRecedeDemo.kt) measured its own screenshots, but at the recorder's frame rate:
// around every event in marks.txt it decodes the band of the page that no sheet reaches
// (geometry.txt, in display pixels, scaled to the video) and judges every frame by the same two
// rules – a frame in which the band is the window gradient rather than the page or its picture
// (the swap was seen), and a step in the band's brightness larger than a spring could make over
// the time since the previous distinct frame, or any movement at all after the page had stood
// still for a while following a transition (a pop after the sheet had settled). A finger's hold
// (`held` in marks.txt) is exempt from the plateau clause: letting go is a second transition.
//
//   node android-sheet-recede-frames.mjs <video.mp4> <marks.txt> <geometry.txt> <findings.txt>
//
// The findings carry every frame's numbers; the exit code is 1 when any frame failed. The
// driver's sequence starts about OFFSET_S into the video (see the shell script), and a window
// runs from BEFORE_S before an event to AFTER_S after it, cut short at the next event.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const FPS = 30
const OFFSET_S = 2.5
const BEFORE_S = 1.0
const AFTER_S = 3.4
/** Brightness (0…255) two frames of the same picture differ by, encoder noise included. */
const NOISE = 2.0
/** The fastest a sheet spring moves anything driven by it, as a share of the whole way per second. */
const RATE_PER_S = 10.0
/** Standing still this long after a change is the sheet having settled. */
const PLATEAU_MS = 400

const [video, marksPath, geometryPath, outPath] = process.argv.slice(2)
if (!video || !marksPath || !geometryPath || !outPath) {
  console.error(
    'usage: android-sheet-recede-frames.mjs <video> <marks.txt> <geometry.txt> <findings.txt>'
  )
  process.exit(2)
}

const geometry = Object.fromEntries(
  readFileSync(geometryPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.trim().split(/\s+/)
      return [key, rest.map(Number)]
    })
)
const marks = readFileSync(marksPath, 'utf8')
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .filter((parts) => parts.length >= 2 && /^\d+$/.test(parts[0]))
  .map(([ms, name, kind]) => ({ at: Number(ms) / 1000 + OFFSET_S, name, held: kind === 'held' }))

const probe = spawnSync(
  'ffprobe',
  [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    video
  ],
  { encoding: 'utf8' }
)
const [videoWidth, videoHeight] = probe.stdout.trim().split(',').map(Number)
if (!videoWidth || !videoHeight) {
  console.error(`could not read the video's size: ${probe.stderr}`)
  process.exit(2)
}
const [displayWidth, displayHeight] = geometry.size
const sx = videoWidth / displayWidth
const sy = videoHeight / displayHeight
const even = (n) => Math.max(2, Math.floor(n / 2) * 2)
const [bl, bt, br, bb] = geometry.band
const band = {
  x: even(bl * sx),
  y: even(bt * sy),
  w: even((br - bl) * sx),
  h: even((bb - bt) * sy)
}

const lines = []
const failures = []
const say = (line) => {
  lines.push(line)
  console.log(line)
}
say(
  `${video}: ${videoWidth}x${videoHeight} (display ${displayWidth}x${displayHeight}), band ${band.w}x${band.h} at ${band.x},${band.y}, ${FPS} fps`
)

/** Mean luminance, mean chroma, edge density and the share of page-like pixels of one rgb24 frame. */
function measure(buf, offset, w, h) {
  let n = 0
  let lum = 0
  let chroma = 0
  let edges = 0
  let pageLike = 0
  for (let y = 0; y < h; y += 3) {
    let i = offset + y * w * 3
    for (let x = 0; x < w; x += 3, i += 9) {
      const r = buf[i]
      const g = buf[i + 1]
      const b = buf[i + 2]
      const l = 0.299 * r + 0.587 * g + 0.114 * b
      const c = Math.max(r, g, b) - Math.min(r, g, b)
      lum += l
      chroma += c
      if (l > 90 && c < 24) pageLike++
      if (x + 3 < w) {
        const lq = 0.299 * buf[i + 9] + 0.587 * buf[i + 10] + 0.114 * buf[i + 11]
        if (Math.abs(l - lq) > 40) edges++
      }
      n++
    }
  }
  return { luminance: lum / n, chroma: chroma / n, edges: edges / n, pageLike: pageLike / n }
}

function judge(name, held, frames) {
  say(`${name}: ${frames.length} frames`)
  for (const f of frames) {
    say(
      `  ${String(f.at).padStart(6)} ms  lum ${f.band.luminance.toFixed(1).padStart(5)} chroma ${f.band.chroma.toFixed(1).padStart(5)} edges ${f.band.edges.toFixed(4)} page-like ${f.band.pageLike.toFixed(2)}`
    )
  }
  if (frames.length === 0) {
    failures.push(`${name}: no frame in the window`)
    return
  }
  for (const f of frames) {
    const b = f.band
    if (b.chroma > 18 && b.edges < 0.004 && b.pageLike < 0.3) {
      failures.push(
        `${name} at ${f.at} ms: the window gradient where the page was (band chroma ${b.chroma.toFixed(1)} edges ${b.edges.toFixed(4)} page-like ${b.pageLike.toFixed(2)})`
      )
    }
  }
  const lows = Math.min(...frames.map((f) => f.band.luminance))
  const highs = Math.max(...frames.map((f) => f.band.luminance))
  const amplitude = highs - lows
  if (amplitude < 3 * NOISE) {
    say("  (the page's brightness never moved: did the surface come up?)")
    return
  }
  let last = frames[0]
  let moved = false
  let worst = 0
  let firstChange = null
  for (const f of frames.slice(1)) {
    const d = f.band.luminance - last.band.luminance
    if (Math.abs(d) <= NOISE) continue
    const dt = f.at - last.at
    const share = Math.abs(d) / amplitude
    const allowed = (RATE_PER_S * dt) / 1000 + NOISE / amplitude
    worst = Math.max(worst, share)
    if (share > allowed) {
      failures.push(
        `${name} at ${f.at} ms: brightness stepped ${(share * 100).toFixed(0)}% of the way in ${dt} ms (a spring moves at most ${(Math.min(1, allowed) * 100).toFixed(0)}% in that time)`
      )
    }
    // The plateau clause counts stillness that began after the event: the window's lead-in may
    // hold a finger's swipe and its hold (the commit of a back gesture is the finger letting go).
    if (!held && moved && dt >= PLATEAU_MS && last.at >= 0) {
      failures.push(
        `${name} at ${f.at} ms: the page moved again (${d.toFixed(1)}) after standing still for ${dt} ms – a pop after the sheet had settled`
      )
    }
    if (!moved) firstChange = f.at
    moved = true
    last = f
  }
  say(
    `  brightness ${frames[0].band.luminance.toFixed(1)} → ${frames[frames.length - 1].band.luminance.toFixed(1)} (range ${amplitude.toFixed(1)}), biggest step ${(worst * 100).toFixed(0)}% of the range, first change at ${firstChange} ms`
  )
}

for (let i = 0; i < marks.length; i++) {
  const mark = marks[i]
  const start = Math.max(0, mark.at - BEFORE_S)
  const next = marks[i + 1]
  const end = Math.min(mark.at + AFTER_S, next ? next.at - 0.05 : Infinity)
  if (end <= start) continue
  const ffmpeg = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-ss',
      start.toFixed(3),
      '-t',
      (end - start).toFixed(3),
      '-i',
      video,
      '-vf',
      `fps=${FPS},crop=${band.w}:${band.h}:${band.x}:${band.y}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ],
    { maxBuffer: 1 << 30 }
  )
  if (ffmpeg.status !== 0) {
    say(`${mark.name}: ffmpeg failed: ${ffmpeg.stderr}`)
    failures.push(`${mark.name}: the frames could not be decoded`)
    continue
  }
  const frameBytes = band.w * band.h * 3
  const count = Math.floor(ffmpeg.stdout.length / frameBytes)
  const frames = []
  for (let k = 0; k < count; k++) {
    // A frame's time relative to the event, in ms; negative before it.
    const at = Math.round((start - mark.at + k / FPS) * 1000)
    frames.push({ at, band: measure(ffmpeg.stdout, k * frameBytes, band.w, band.h) })
  }
  judge(mark.name, mark.held, frames)
}

say(
  failures.length
    ? `FAILED:\n${failures.join('\n')}`
    : 'every frame in every window is the page or its picture, moving only as a spring moves it'
)
writeFileSync(outPath, lines.join('\n') + '\n')
process.exit(failures.length ? 1 : 0)
