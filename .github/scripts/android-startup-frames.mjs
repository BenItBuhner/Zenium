#!/usr/bin/env node
// Reads a startup scene's recording and stills (android-startup-demo.sh) for their sequence
// (ruling 2: the recording's frames are read, not the clock). Every frame is decoded at a
// quarter of the display through ffmpeg and read at three points of the page slot the seed
// act reported (`slot: left top right bottom` in display pixels): a point near each side edge
// at the slot's middle height, and the slot's centre. The colours are the scene's own:
//
//   splash   both edges indigo (#6264DC, the splash's brand background covers the window)
//   picture  both edges teal (#1F9D7A, the fixture) and the centre not amber: the restored
//            tab's picture, or the live page before its mark – told apart by the mark below
//   page     both edges teal and the centre amber (#FFB000): the live page's own paint, which
//            carries the mark only when the runner held the answer (the cold start's serve)
//   blank    both edges the window's background (light or dark, or plain white or near-black):
//            the page slot with nothing in it, the plain window
//   fade     between the splash's last frame and the chrome's first: the exit's blend
//   other    anything else (the launcher, a task switch)
//
// The cold start's rules: a splash was seen; the chrome's first frame after it shows the
// picture (not a blank slot, not yet the page); no blank frame after the splash; the page's
// paint comes after its picture; no splash frame after the chrome's first. The hot start's: no
// splash frame, no blank frame, the page on the chrome's first frame. Each still named on the
// command line is read the same way and must show its class.
//
//   node android-startup-frames.mjs <cold|hot> <video|-> <slot "l t r b"> <display WxH> <findings.txt>
//        [--still <class>=<png>]... [--tile <png>]
//
// The findings carry the timeline (runs of frames), the verdicts and each still's reading; the
// exit code is 1 when a rule failed, 2 for a usage error. `--tile` writes a contact sheet of the
// recording (three rows of six frames from the start to a second past the page's paint).
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const SCALE = 4
const FPS = 20
/** Per-channel distance a frame's colour may sit from the scene's, the encoder's noise included. */
const TOLERANCE = 44
const INDIGO = [0x62, 0x64, 0xdc]
const TEAL = [0x1f, 0x9d, 0x7a]
const AMBER = [0xff, 0xb0, 0x00]
/** The window backgrounds (colors.xml zen_background, zen_background_dark), white and near-black within the tolerance. */
const BLANKS = [
  [0xf2, 0xf1, 0xf5],
  [0x16, 0x16, 0x1b]
]

const args = process.argv.slice(2)
const positional = []
const stills = []
let tile = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--still') {
    const [cls, path] = (args[++i] ?? '').split('=')
    if (!cls || !path) usage()
    stills.push({ cls, path })
  } else if (args[i] === '--tile') {
    tile = args[++i] ?? usage()
  } else positional.push(args[i])
}
const [kind, video, slotArg, displayArg, outPath] = positional
if (!kind || !video || !slotArg || !displayArg || !outPath || !['cold', 'hot'].includes(kind)) usage()

function usage() {
  console.error(
    'usage: android-startup-frames.mjs <cold|hot> <video|-> <slot "l t r b"> <display WxH> <findings.txt> [--still <class>=<png>]... [--tile <png>]'
  )
  process.exit(2)
}

const slot = slotArg.trim().split(/\s+/).map(Number)
const [displayW, displayH] = displayArg.split('x').map(Number)
if (slot.length !== 4 || slot.some((n) => !Number.isFinite(n)) || !displayW || !displayH) usage()
const width = Math.floor(displayW / SCALE)
const height = Math.floor(displayH / SCALE)
const sx = width / displayW
const sy = height / displayH
const [l, t, r, b] = slot
const points = {
  left: [Math.round((l + 24) * sx), Math.round(((t + b) / 2) * sy)],
  right: [Math.round((r - 24) * sx), Math.round(((t + b) / 2) * sy)],
  centre: [Math.round(((l + r) / 2) * sx), Math.round(((t + b) / 2) * sy)]
}

const lines = []
const say = (line) => {
  lines.push(line)
  console.log(line)
}
const failures = []
const verdict = (rule, holds, detail) => {
  say(`${holds ? 'PASS' : 'FAIL'}: ${rule} (${detail})`)
  if (!holds) failures.push(rule)
}

/** Mean colour of the 5 x 5 block around (x, y) of a frame at `offset` in rgb24 `buffer`. */
function sample(buffer, offset, [x, y]) {
  let r = 0
  let g = 0
  let bl = 0
  let n = 0
  for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++) {
    for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) {
      const at = offset + (yy * width + xx) * 3
      r += buffer[at]
      g += buffer[at + 1]
      bl += buffer[at + 2]
      n++
    }
  }
  return [r / n, g / n, bl / n]
}

const near = (c, ref) => c.every((v, i) => Math.abs(v - ref[i]) <= TOLERANCE)
const blank = (c) => BLANKS.some((ref) => near(c, ref))
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

function classify(left, right, centre) {
  if (near(left, INDIGO) && near(right, INDIGO)) return 'splash'
  if (near(left, TEAL) && near(right, TEAL)) return near(centre, AMBER) ? 'page' : 'picture'
  if (blank(left) && blank(right)) return 'blank'
  return 'other'
}

/** Decode `input` (a video or a still) to rgb24 frames at the reduced size; null when ffmpeg fails. */
function decode(input, filters = []) {
  const vf = [...filters, `scale=${width}:${height}`].join(',')
  const ffmpeg = spawnSync(
    'ffmpeg',
    ['-nostdin', '-loglevel', 'error', '-i', input, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { maxBuffer: 1 << 30 }
  )
  if (ffmpeg.status !== 0) {
    say(`ffmpeg could not decode ${input}: ${String(ffmpeg.stderr).trim()}`)
    return null
  }
  return ffmpeg.stdout
}

function readFrames(buffer) {
  const frameBytes = width * height * 3
  const count = Math.floor(buffer.length / frameBytes)
  const frames = []
  for (let k = 0; k < count; k++) {
    const offset = k * frameBytes
    const left = sample(buffer, offset, points.left)
    const right = sample(buffer, offset, points.right)
    const centre = sample(buffer, offset, points.centre)
    frames.push({ k, cls: classify(left, right, centre), left, right, centre })
  }
  return frames
}

say(`startup frames (${kind}): slot ${slot.join(' ')} of ${displayW}x${displayH}; read at ${width}x${height}, ${FPS} fps`)
say(`sample points (reduced px): left ${points.left.join(',')} right ${points.right.join(',')} centre ${points.centre.join(',')}`)

let frames = []
if (video !== '-') {
  // The fps filter samples the recording on its own clock (an input -r would duplicate frames).
  const buffer = decode(video, [`fps=${FPS}`])
  if (buffer) frames = readFrames(buffer)
}
// A frame between the splash's last and the chrome's first that is neither is the exit's blend.
const lastSplash = frames.map((f) => f.cls).lastIndexOf('splash')
const firstChrome = frames.findIndex((f, i) => i > lastSplash && ['picture', 'page', 'blank'].includes(f.cls))
if (lastSplash >= 0 && firstChrome > lastSplash) {
  for (let i = lastSplash + 1; i < firstChrome; i++) if (frames[i].cls === 'other') frames[i].cls = 'fade'
}

if (frames.length) {
  // The timeline as runs: `0.00-0.35 other x7`.
  const runs = []
  for (const f of frames) {
    const last = runs[runs.length - 1]
    if (last && last.cls === f.cls) last.n++
    else runs.push({ cls: f.cls, from: f.k, n: 1 })
  }
  say(`${frames.length} frames (${(frames.length / FPS).toFixed(2)} s):`)
  for (const run of runs) {
    const sampleFrame = frames[run.from]
    say(
      `  ${(run.from / FPS).toFixed(2)}-${((run.from + run.n) / FPS).toFixed(2)} s ${run.cls} x${run.n} (left ${hex(sampleFrame.left)} right ${hex(sampleFrame.right)} centre ${hex(sampleFrame.centre)})`
    )
  }
  const classes = frames.map((f) => f.cls)
  const count = (cls) => classes.filter((c) => c === cls).length
  const firstOf = (cls) => classes.indexOf(cls)
  const at = (i) => (i < 0 ? 'never' : `${(i / FPS).toFixed(2)} s`)
  if (kind === 'cold') {
    verdict('the splash was on screen', count('splash') > 0, `${count('splash')} splash frames, the last at ${at(lastSplash)}`)
    const first = firstChrome >= 0 ? classes[firstChrome] : 'none'
    verdict(
      "the chrome's first frame after the splash shows the restored picture",
      first === 'picture',
      `first chrome frame at ${at(firstChrome)} is ${first}`
    )
    const blanks = classes.filter((c, i) => i > lastSplash && c === 'blank').length
    verdict('no blank page slot after the splash', blanks === 0, `${blanks} blank frames after the splash`)
    verdict(
      'the page painted after its picture',
      firstOf('page') > firstOf('picture') && firstOf('picture') >= 0,
      `picture from ${at(firstOf('picture'))}, page from ${at(firstOf('page'))}`
    )
    verdict(
      "no splash frame after the chrome's first",
      firstChrome < 0 || lastSplash < firstChrome,
      `last splash at ${at(lastSplash)}, first chrome frame at ${at(firstChrome)}`
    )
  } else {
    verdict('no splash frame on the hot start', count('splash') === 0, `${count('splash')} splash frames`)
    verdict('no blank page slot on the hot start', count('blank') === 0, `${count('blank')} blank frames`)
    const first = frames.find((f) => ['picture', 'page', 'blank'].includes(f.cls))
    verdict(
      "the page is on the chrome's first frame",
      first?.cls === 'page',
      first ? `first chrome frame at ${at(first.k)} is ${first.cls}` : 'no chrome frame seen'
    )
  }
  if (tile) {
    // Three rows of six frames from the start to a second past the page's paint (or the end).
    const untilS = Math.min(frames.length / FPS, (Math.max(firstOf('page'), 0) + FPS) / FPS)
    const fps = 18 / Math.max(untilS, 1)
    const result = spawnSync('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y', '-t', untilS.toFixed(2), '-i', video,
      '-vf', `fps=${fps.toFixed(4)},scale=${width}:-1,tile=6x3:padding=4:color=black`, '-frames:v', '1', tile
    ])
    say(result.status === 0 ? `tile: ${tile} (${untilS.toFixed(2)} s over 18 frames)` : `the tile could not be written: ${String(result.stderr).trim()}`)
  }
} else if (video !== '-') {
  verdict('the recording could be read', false, `no frames decoded from ${video}`)
}

for (const still of stills) {
  const buffer = decode(still.path)
  if (!buffer) {
    verdict(`the ${still.cls} still shows the ${still.cls}`, false, `${still.path} could not be decoded`)
    continue
  }
  const [frame] = readFrames(buffer)
  const detail = `${still.path}: ${frame.cls} (left ${hex(frame.left)} right ${hex(frame.right)} centre ${hex(frame.centre)})`
  verdict(`the ${still.cls} still shows the ${still.cls}`, frame.cls === still.cls, detail)
}

writeFileSync(outPath, lines.join('\n') + '\n')
process.exit(failures.length ? 1 : 0)
