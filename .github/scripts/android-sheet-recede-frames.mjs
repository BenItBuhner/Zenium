#!/usr/bin/env node
// Reads a sheet recede recording (android-sheet-recede-demo.sh) the way the driver
// (SheetRecedeDemo.kt) read its own screenshots, but at the recorder's frame rate: from every
// event in marks.txt to the next it decodes two regions (geometry.txt, in display pixels,
// scaled to the video) – the band of the page that no sheet reaches, and the progress swatch
// the driver put into the chrome, a bar whose width is `--zen-recede` times a known length –
// and judges every frame by two rules that need no clock, because the emulator paints two to
// five frames a second and a step's size over time says nothing there:
//
//  - the band is the page or its picture, never the window gradient (the swap was seen);
//  - how far the band has gone dark, against the same band with no sheet up (`p` 0) and under a
//    sheet fully up (`p` 1) elsewhere in the recording, agrees with the sheet's progress the
//    swatch shows in the same frame, within TOLERANCE of the way. The page and the sheet are
//    painted from one value, so a frame in which they disagree is the page popping, stalling
//    or lagging on its own: the old close (the scrim went with the sheet, then the page popped
//    bright when its picture did), the old open (dark in one step before the sheet was up).
//    The recording is not the screen: its encoder can leave one frame between two of the
//    emulator's that is a mix of both, in which the band is half-way while the swatch's bar
//    reads as one or the other. So a frame is judged against the span of its own progress and
//    that of the nearest frames that differ from it either way; a stall or a pop lasts many
//    frames past both and still fails.
//
// The second sheet of a stack is fine by the rule: the page holds its recede and the stack's
// one scrim while it comes and goes. (Two sheets moving at once would dim the page by their
// summed presence while the swatch shows the larger; no window of this demo does that.)
//
// An event marked `record` is one the driver judges by a rule of its own – the keyboard growing
// a sheet up towards the band, the bar docked at the top edge with the page moved down under
// it – so its window is cut for looking at (the shell script) but read by neither rule here,
// and its frames do not enter the brightness references; the window still ends the one before.
//
//   node android-sheet-recede-frames.mjs <video.mp4> <marks.txt> <geometry.txt> <findings.txt>
//
// The findings carry every frame's numbers; the exit code is 1 when any frame failed. The
// driver's sequence starts about OFFSET_S into the video (see the shell script).
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const FPS = 30
const OFFSET_S = 2.5
/** A window runs from this long before its event to just before the next (or this long after the last). */
const BEFORE_S = 0.3
const LAST_S = 6.5
/** Brightness (0…255) two frames of the same picture differ by, encoder noise included. */
const NOISE = 2.0
/**
 * How far apart, as a share of the whole way, the page's darkness and the sheet's progress may
 * be in one frame: the picture's brightness differs from the live page's by under a hundredth
 * of the way, the receded frame's content shifts by less, the encoder adds its noise; the old
 * close and open were half the way or more apart.
 */
const TOLERANCE = 0.08

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
      return [key, rest]
    })
)
const marks = readFileSync(marksPath, 'utf8')
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .filter((parts) => parts.length >= 2 && /^\d+$/.test(parts[0]))
  .map(([ms, name, kind]) => ({
    at: Number(ms) / 1000 + OFFSET_S,
    name,
    held: kind === 'held',
    judged: kind !== 'record'
  }))

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
if (!geometry.swatch) {
  console.error('geometry.txt has no swatch line: the driver did not place the progress swatch')
  process.exit(2)
}
const [displayWidth, displayHeight] = geometry.size.map(Number)
const sx = videoWidth / displayWidth
const sy = videoHeight / displayHeight
const [bl, bt, br, bb] = geometry.band.map(Number)
const [swl, swt, sww, swh] = geometry.swatch.slice(0, 4).map(Number)
const swatchWhite = geometry.swatch[4] === 'white'
/** One crop holds both regions; each is read inside it. */
const even = (n) => Math.max(2, Math.floor(n / 2) * 2)
const cropLeft = even(Math.min(bl, swl) * sx)
const cropTop = even(Math.min(bt, swt) * sy)
const crop = {
  x: cropLeft,
  y: cropTop,
  w: even(Math.max(br, swl + sww) * sx - cropLeft),
  h: even(Math.max(bb, swt + swh) * sy - cropTop)
}
const inCrop = (l, t, w, h) => ({
  x: Math.round(l * sx) - crop.x,
  y: Math.round(t * sy) - crop.y,
  w: Math.max(1, Math.round(w * sx)),
  h: Math.max(1, Math.round(h * sy))
})
const band = inCrop(bl, bt, br - bl, bb - bt)
const swatch = inCrop(swl, swt, sww, swh)

const lines = []
const failures = []
const say = (line) => {
  lines.push(line)
  console.log(line)
}
say(
  `${video}: ${videoWidth}x${videoHeight} (display ${displayWidth}x${displayHeight}), band ${band.w}x${band.h} at ${bl},${bt}, swatch ${swatch.w}x${swatch.h} at ${swl},${swt} (${swatchWhite ? 'white' : 'black'}), ${FPS} fps`
)

const lum = (buf, i) => 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2]

/** Mean luminance, mean chroma, edge density and the share of page-like pixels of the band in one rgb24 frame. */
function measureBand(buf, offset) {
  let n = 0
  let l = 0
  let chroma = 0
  let edges = 0
  let pageLike = 0
  for (let y = band.y; y < band.y + band.h; y += 3) {
    let i = offset + (y * crop.w + band.x) * 3
    for (let x = 0; x < band.w; x += 3, i += 9) {
      const r = buf[i]
      const g = buf[i + 1]
      const b = buf[i + 2]
      const li = 0.299 * r + 0.587 * g + 0.114 * b
      const c = Math.max(r, g, b) - Math.min(r, g, b)
      l += li
      chroma += c
      if (li > 90 && c < 24) pageLike++
      if (x + 3 < band.w && Math.abs(li - lum(buf, i + 9)) > 40) edges++
      n++
    }
  }
  return { luminance: l / n, chroma: chroma / n, edges: edges / n, pageLike: pageLike / n }
}

/**
 * The sheet's progress the swatch shows: columns of its middle rows that are its colour, in at
 * least two of three rows, over its full length.
 */
function measureProgress(buf, offset) {
  const mid = swatch.y + Math.floor(swatch.h / 2)
  const rows = [mid - 1, mid, mid + 1].filter((y) => y >= 0 && y < crop.h)
  let count = 0
  for (let x = 0; x < swatch.w; x++) {
    let hits = 0
    for (const y of rows) {
      const li = lum(buf, offset + (y * crop.w + swatch.x + x) * 3)
      if (swatchWhite ? li > 175 : li < 90) hits++
    }
    if (hits >= 2) count++
  }
  return count / swatch.w
}

const isGradient = (b) => b.chroma > 18 && b.edges < 0.004 && b.pageLike < 0.3

// Pass one: every window's frames.
const windows = []
for (let i = 0; i < marks.length; i++) {
  const mark = marks[i]
  const start = Math.max(0, mark.at - BEFORE_S)
  const next = marks[i + 1]
  const end = next ? next.at - 0.02 : mark.at + LAST_S
  if (end <= start) continue
  if (!mark.judged) {
    say(`${mark.name}: recorded only; judged by the driver's own rule`)
    continue
  }
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
      `fps=${FPS},crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`,
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
  const frameBytes = crop.w * crop.h * 3
  const count = Math.floor(ffmpeg.stdout.length / frameBytes)
  const frames = []
  for (let k = 0; k < count; k++) {
    // A frame's time relative to the event, in ms; negative before it.
    const at = Math.round((start - mark.at + k / FPS) * 1000)
    const offset = k * frameBytes
    frames.push({
      at,
      band: measureBand(ffmpeg.stdout, offset),
      progress: measureProgress(ffmpeg.stdout, offset)
    })
  }
  windows.push({ name: mark.name, frames })
}

// The band's brightness with no sheet and under one fully up, from the recording itself: the
// medians over the frames whose swatch says 0 and 1 (the swap between the live page and its
// picture, and the encoder, move it by less than the noise).
const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN
}
const all = windows.flatMap((w) => w.frames).filter((f) => !isGradient(f.band))
const bright = median(all.filter((f) => f.progress <= 0.01).map((f) => f.band.luminance))
const dark = median(all.filter((f) => f.progress >= 0.99).map((f) => f.band.luminance))
const range = bright - dark
say(
  `band brightness ${Number.isNaN(bright) ? '?' : bright.toFixed(1)} with no sheet, ${Number.isNaN(dark) ? '?' : dark.toFixed(1)} under a sheet fully up (${all.length} frames)`
)
if (!(range > 6 * NOISE)) {
  failures.push(
    `the recording does not tell the page dark from bright: ${bright} with no sheet, ${dark} under a sheet fully up (the swatch may not have been read)`
  )
}
const darkness = (l) => (range > 0 ? (bright - l) / range : NaN)

// Pass two: judge.
for (const { name, frames } of windows) {
  say(`${name}: ${frames.length} frames`)
  for (const f of frames) {
    const d = darkness(f.band.luminance)
    say(
      `  ${String(f.at).padStart(6)} ms  p ${f.progress.toFixed(3)} dark ${Number.isNaN(d) ? '    ?' : d.toFixed(3)}  lum ${f.band.luminance.toFixed(1).padStart(5)} chroma ${f.band.chroma.toFixed(1).padStart(5)} edges ${f.band.edges.toFixed(4)} page-like ${f.band.pageLike.toFixed(2)}`
    )
  }
  if (frames.length === 0) {
    failures.push(`${name}: no frame in the window`)
    continue
  }
  /** The same picture, as far as the recorder is concerned. */
  const same = (a, b) =>
    Math.abs(a.progress - b.progress) <= 0.005 &&
    Math.abs(a.band.luminance - b.band.luminance) <= NOISE
  /** The progress of the nearest frame before (`step` −1) or after (+1) `k` that differs from it; its own when none does. */
  const neighbour = (k, step) => {
    for (let j = k + step; j >= 0 && j < frames.length; j += step) {
      if (!same(frames[j], frames[k])) return frames[j].progress
    }
    return frames[k].progress
  }
  let worst = 0
  let firstMove = null
  frames.forEach((f, k) => {
    if (isGradient(f.band)) {
      failures.push(
        `${name} at ${f.at} ms: the window gradient where the page was (band chroma ${f.band.chroma.toFixed(1)} edges ${f.band.edges.toFixed(4)} page-like ${f.band.pageLike.toFixed(2)})`
      )
      return
    }
    if (!(range > 0)) return
    const d = darkness(f.band.luminance)
    const span = [f.progress, neighbour(k, -1), neighbour(k, 1)]
    const gap = Math.max(0, Math.min(...span) - d, d - Math.max(...span))
    worst = Math.max(worst, gap)
    if (firstMove === null && Math.abs(f.progress - frames[0].progress) > 0.02) firstMove = f.at
    if (gap > TOLERANCE + NOISE / range) {
      failures.push(
        `${name} at ${f.at} ms: the page is ${(d * 100).toFixed(0)}% of the way dark while the sheet's progress is ${(f.progress * 100).toFixed(0)}% (${(Math.min(...span) * 100).toFixed(0)}–${(Math.max(...span) * 100).toFixed(0)}% with the frames either side)`
      )
    }
  })
  const first = frames[0]
  const last = frames[frames.length - 1]
  say(
    `  progress ${first.progress.toFixed(2)} → ${last.progress.toFixed(2)}, darkness ${darkness(first.band.luminance).toFixed(2)} → ${darkness(last.band.luminance).toFixed(2)}, largest disagreement ${(worst * 100).toFixed(0)}% of the way, first move at ${firstMove} ms`
  )
}

say(
  failures.length
    ? `FAILED:\n${failures.join('\n')}`
    : 'every frame is the page or its picture, as dark as its sheet is up'
)
writeFileSync(outPath, lines.join('\n') + '\n')
process.exit(failures.length ? 1 : 0)
