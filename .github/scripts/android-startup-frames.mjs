#!/usr/bin/env node
// Reads a startup scene's recording and stills (android-startup-demo.sh) for their sequence
// (ruling 2: the recording's frames are read, not the clock). Every frame is decoded at a
// quarter of the display through ffmpeg and read at three points of the page slot the seed
// act reported (`slot: left top right bottom` in display pixels): a point near each side edge
// a quarter of the way down the slot, and the slot's centre. The edges sit at the quarter, not
// the middle, for the launcher's sake: the emulator's wallpaper is sky on the left and night on
// the right at that height, so a launcher frame (the recording's lead-in, the hot start's
// starting point) is never read as a blank slot, while the fixture is one colour there and the
// dark middle of the wallpaper would pass for the dark theme's background. Two more points tell
// the windows apart: the display's centre (`mark`), where the splash's icon is white, and the
// status bar's middle (`bar`), which only the web app's own window paints in its theme colour.
// The colours are the scene's own:
//
//   splash   both edges indigo (#6264DC, the splash's brand background) and the icon at the
//            display's centre: the platform's starting window, then the transferred splash view
//   ground   both edges indigo and no icon: the app window's own first frame between those two,
//            the hand-over frame, in Theme.Zen.Boot's window background (the splash's colour;
//            before the boot theme this frame was `blank`, Theme.Zen's plain window)
//   picture  both edges teal (#1F9D7A, the fixture) and the centre not amber: the restored
//            tab's picture, or the live page before its mark – told apart by the mark below
//   page     both edges teal and the centre amber (#FFB000): the live page's own paint, which
//            carries the mark only when the runner held the answer (the cold start's serve)
//   blank    both edges the window's background (light or dark, or plain white or near-black):
//            the page slot with nothing in it, the plain window
//   fade     between the splash's last frame and the chrome's first: the exit's blend (the
//            icon's fade leaves the splash's ground bare for a moment, then the reveal)
//   other    anything else: the launcher (the edges' two colours), a task switch, a window's
//            open transition mid-way
//
// The cold start's rules: a splash was seen; the chrome's first frame after it shows the
// picture (not a blank slot, not yet the page); no blank frame from the splash's FIRST frame on
// (the hand-over frame sits between the starting window's splash and the transferred view's – a
// count from the last splash frame never saw the plain window there); the page's paint comes
// after its picture; no splash frame, nor its ground, after the chrome's first. The frames of
// the splash's run that are not the splash – blank or ground – are the hand-over gap, reported
// as a reading (`gap:`) for the table whichever colour they have. The hot start's: no splash
// frame, no blank or ground frame, the page on the chrome's first frame. Each still named on
// the command line is read the same way and must show its class.
//
// The web app's launch (PWA-06, `webapp`; the slot is the whole display, the centre the icon's)
// has classes of its own, the fixture app's colours (StartupDemo.seedWebApp). Its own window is
// known by the status bar in the manifest's theme_color (#E65100), which the platform's starting
// window never has and the splash view covers:
//
//   plain    both edges the window's page colour, light or dark (the theme's fixed ground: the
//            platform's starting window before the hand-over) – read as `blank` above
//   ground   the bar in the theme colour and both edges the app's purple: the app's own window
//            before its splash view attaches (the hand-over), the page view's background
//            standing in for the splash's ground until the first paint
//   bare     the bar in the theme colour and both edges white or the plain page colour: the
//            app's own window showing the page view unpainted – the hand-over as it was
//   splash   both edges the app's purple (#7A1FA2, its manifest background_color) and the
//            centre its cyan tile (#00B8D9): the dressed splash, held (it covers the bar)
//   window   both edges purple and the centre purple too, the bar not the theme's: the splash
//            view without its tile – allowed only as the dress blend before the tile and the
//            exit's icon fade after the last splash frame
//   page     both edges the page's green (#2E7D32)
//   dress    between the plain ground and the tile: the blend to the app's colour (150 ms)
//
// Its rules: the tile was on screen on the app's ground; the window never stood bare before the
// tile beyond the dress; the app's own window never showed the page view unpainted (`bare`);
// the page's first frame came after the last splash frame within the exit's motion; nothing
// bare, plain or ground after the page; no splash frame after the page's first. Its gap
// (`gap:`) runs from the fixed ground's first frame to the tile – the plain frames (the
// platform's starting window before the hand-over), the dress, and the app's own window's
// ground and bare frames – with the hand-over's own share (`hand-over:`) named apart.
//
// Two readings hold for every kind. `black`: every point near black (tighter than the
// tolerance, so the dark theme's near-black window stays `blank`) – a display with nothing on
// it. The navigation bar's glyphs (`nav`): the bottom band's ground (the median colour) and its
// ink (the pixels far from that ground), light or dark by the ink's own luminance, `none` when
// too little ink is there; at the dressed splash and on every splash still the glyphs must
// take the tone the ground's luminance asks for (light on a dark ground, dark on a light one:
// the platform's own rule for its starting window, the app's for its bars). SystemUI decides
// the glyphs last, and its LightBarController forces their tone while it counts the shade's
// scrim as standing (`mForceLightForScrim` / `mForceDarkForScrim`, API 35); when the scene's
// dump of it says so, `--nav-forced <reason>` tells the reader: a tone against the ground is
// then a `NOTE:` line naming the force, not a failed verdict (SystemUI's reading on the device,
// not the app's failure), and a matching tone is a PASS that says the force agreed with it.
//
// The lead (`lead:`, with `--anchor ready=<ms>`): how long after the start request the splash
// – or, for the web app, any window of the app's – first showed, and what showed until then.
// The recording carries no clock of the request's, so it is anchored on the splash's lift: the
// READY line's distance from the request on logcat's clock (`<ms>`) is laid back from the
// frame after the last splash frame, which the lift draws within a frame or two. The lead
// therefore reads short by up to two frames (100 ms), the same for every way of starting, and
// the ways are compared, not the absolute. The `lead` kind is that reading alone (the link
// path, the warm launch's flash): the timeline, the splash frames counted, no rule but that the
// recording was read.
//
//   node android-startup-frames.mjs <cold|hot|webapp|lead> <video|-> <slot "l t r b"> <display WxH> <findings.txt>
//        [--still <class>=<png>]... [--tile <png>] [--anchor ready=<ms>] [--nav-forced <reason>]
//
// The findings carry the timeline (runs of frames), the verdicts (and the NOTE lines) and each
// still's reading; the exit code is 1 when a rule failed, 2 for a usage error. `--tile` writes a
// contact sheet of the recording (three rows of six frames from the start to a second past the
// page's paint).
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
/** The fixture web app's (StartupDemo.WEBAPP_*): its ground, its tile, its page, its theme colour (the bars of its own window). */
const PURPLE = [0x7a, 0x1f, 0xa2]
const CYAN = [0x00, 0xb8, 0xd9]
const GREEN = [0x2e, 0x7d, 0x32]
const THEME = [0xe6, 0x51, 0x00]
/** Where the status bar is read: the display's middle, this far down (inside the bar at any density the recipe uses). */
const BAR_Y = 12
/** Frames before the tile that may be the dress blend (150 ms), and after the last splash frame that may be the exit (482 ms), at FPS. */
const DRESS_FRAMES = 6
const EXIT_FRAMES = 14
/** A point is black within this per-channel distance of 0: under the dark window's #16161b, over the encoder's noise. */
const BLACK_TOLERANCE = 10
/** The navigation bar's band: the display's bottom 5 % (48 dp at the recipe's density is 84 of 1600 px), its lowest rows skipped. */
const NAV_BAND = 0.05
const NAV_SKIP_ROWS = 2
/** A band pixel this far (max channel) from the band's ground is ink; fewer ink pixels than this is no glyph at all. */
const NAV_INK_DISTANCE = 60
const NAV_INK_MIN = 20
/** The lift draws the frame after the last splash frame within this many frames: the lead's error, stated with it. */
const LEAD_ERROR_FRAMES = 2

const args = process.argv.slice(2)
const positional = []
const stills = []
let tile = null
let anchorMs = null
/** SystemUI's force on the navigation glyphs' tone at the scene, as the scene's dump named it; null when none. */
let navForced = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--still') {
    const [cls, path] = (args[++i] ?? '').split('=')
    if (!cls || !path) usage()
    stills.push({ cls, path })
  } else if (args[i] === '--tile') {
    tile = args[++i] ?? usage()
  } else if (args[i] === '--anchor') {
    const [what, ms] = (args[++i] ?? '').split('=')
    if (what !== 'ready' || !Number.isFinite(Number(ms))) usage()
    anchorMs = Number(ms)
  } else if (args[i] === '--nav-forced') {
    navForced = args[++i] || usage()
  } else positional.push(args[i])
}
const [kind, video, slotArg, displayArg, outPath] = positional
if (
  !kind ||
  !video ||
  !slotArg ||
  !displayArg ||
  !outPath ||
  !['cold', 'hot', 'webapp', 'lead'].includes(kind)
)
  usage()

function usage() {
  console.error(
    'usage: android-startup-frames.mjs <cold|hot|webapp|lead> <video|-> <slot "l t r b"> <display WxH> <findings.txt> [--still <class>=<png>]... [--tile <png>] [--anchor ready=<ms>] [--nav-forced <reason>]'
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
const edgeY = Math.round((t + (b - t) / 4) * sy)
const points = {
  left: [Math.round((l + 24) * sx), edgeY],
  right: [Math.round((r - 24) * sx), edgeY],
  centre: [Math.round(((l + r) / 2) * sx), Math.round(((t + b) / 2) * sy)],
  // The splash icon's centre (the display's, whatever the slot) and the status bar's middle.
  mark: [Math.round((displayW / 2) * sx), Math.round((displayH / 2) * sy)],
  bar: [Math.round((displayW / 2) * sx), Math.round(BAR_Y * sy)]
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
/**
 * A verdict on the navigation glyphs' tone: judged as any other unless SystemUI's force on the
 * tone was named (`--nav-forced`) – then a tone against the ground is a NOTE (the force's
 * reading, not the app's failure) and a matching one a PASS that says so.
 */
const navVerdict = (rule, holds, detail) => {
  if (!navForced) return verdict(rule, holds, detail)
  if (holds) return verdict(rule, true, `${detail}; SystemUI's force agreed with it: ${navForced}`)
  say(`NOTE: ${rule} – not judged, SystemUI forces the glyphs' tone here: ${navForced} (${detail})`)
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
const black = (c) => c.every((v) => v <= BLACK_TOLERANCE)
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
/** Relative luminance of an sRGB colour (0..1), the platform's `ColorUtils.calculateLuminance`. */
function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
/** The glyph tone a ground asks for: light glyphs on a dark ground, dark on a light one (luminance over a half). */
const toneFor = (ground) => (luminance(ground) > 0.5 ? 'dark' : 'light')

/**
 * The navigation bar's band of a frame: its ground (the median colour of the band) and its
 * glyphs' tone – the ink pixels far from the ground, light or dark by their mean luminance
 * (the bytes' weighted mean against the middle grey), `none` with too few of them.
 */
function navBand(buffer, offset) {
  const rows = Math.max(3, Math.round(height * NAV_BAND))
  const y0 = height - rows
  const y1 = height - NAV_SKIP_ROWS
  const x0 = Math.round(width * 0.05)
  const x1 = Math.round(width * 0.95)
  const channels = [[], [], []]
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = offset + (y * width + x) * 3
      channels[0].push(buffer[at])
      channels[1].push(buffer[at + 1])
      channels[2].push(buffer[at + 2])
    }
  }
  const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const ground = channels.map(median)
  let ink = 0
  let inkLuma = 0
  for (let i = 0; i < channels[0].length; i++) {
    const r = channels[0][i]
    const g = channels[1][i]
    const b = channels[2][i]
    const distance = Math.max(
      Math.abs(r - ground[0]),
      Math.abs(g - ground[1]),
      Math.abs(b - ground[2])
    )
    if (distance > NAV_INK_DISTANCE) {
      ink++
      inkLuma += 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
  }
  const tone = ink < NAV_INK_MIN ? 'none' : inkLuma / ink >= 128 ? 'light' : 'dark'
  return { ground, tone, ink }
}

function classify(left, right, centre, mark, bar) {
  if ([left, right, centre, mark, bar].every(black)) return 'black'
  if (kind === 'webapp') {
    if (near(bar, THEME)) {
      // The app's own window: only it paints the bar in the theme colour (the splash view covers it).
      if (near(left, GREEN) && near(right, GREEN)) return 'page'
      if (near(left, PURPLE) && near(right, PURPLE)) return 'ground'
      if (blank(left) && blank(right)) return 'bare'
      return 'other'
    }
    if (near(left, PURPLE) && near(right, PURPLE))
      return near(centre, CYAN) ? 'splash' : near(centre, PURPLE) ? 'window' : 'other'
    if (near(left, GREEN) && near(right, GREEN)) return 'page'
    if (blank(left) && blank(right)) return 'plain'
    return 'other'
  }
  // The splash's icon is white at the display's centre; the boot theme's window is indigo through.
  if (near(left, INDIGO) && near(right, INDIGO)) return near(mark, INDIGO) ? 'ground' : 'splash'
  if (near(left, TEAL) && near(right, TEAL)) return near(centre, AMBER) ? 'page' : 'picture'
  if (blank(left) && blank(right)) return 'blank'
  return 'other'
}

/** Decode `input` (a video or a still) to rgb24 frames at the reduced size; null when ffmpeg fails. */
function decode(input, filters = []) {
  const vf = [...filters, `scale=${width}:${height}`].join(',')
  const ffmpeg = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      input,
      '-vf',
      vf,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ],
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
    const mark = sample(buffer, offset, points.mark)
    const bar = sample(buffer, offset, points.bar)
    frames.push({
      k,
      cls: classify(left, right, centre, mark, bar),
      left,
      right,
      centre,
      mark,
      bar,
      nav: navBand(buffer, offset)
    })
  }
  return frames
}

/** A frame's readings for the findings: the three slot points and the one that told its window. */
const readings = (f) =>
  `left ${hex(f.left)} right ${hex(f.right)} centre ${hex(f.centre)} ${kind === 'webapp' ? `bar ${hex(f.bar)}` : `mark ${hex(f.mark)}`}`
/** The navigation band's reading: its ground and its glyphs' tone. */
const navReading = (f) =>
  `nav ${hex(f.nav.ground)} glyphs ${f.nav.tone}${f.nav.tone === 'none' ? '' : ` (${f.nav.ink} px)`}`
/** The tone most of `frames` read in the navigation band, with the count of each. */
function navTone(frames) {
  const counts = { light: 0, dark: 0, none: 0 }
  for (const f of frames) counts[f.nav.tone]++
  const tone = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a))
  return {
    tone,
    counts,
    detail: `${counts.light} light, ${counts.dark} dark, ${counts.none} none of ${frames.length}`
  }
}

say(
  `startup frames (${kind}): slot ${slot.join(' ')} of ${displayW}x${displayH}; read at ${width}x${height}, ${FPS} fps`
)
say(
  `sample points (reduced px): left ${points.left.join(',')} right ${points.right.join(',')} centre ${points.centre.join(',')} mark ${points.mark.join(',')} bar ${points.bar.join(',')}`
)

let frames = []
if (video !== '-') {
  // The fps filter samples the recording on its own clock (an input -r would duplicate frames).
  const buffer = decode(video, [`fps=${FPS}`])
  if (buffer) frames = readFrames(buffer)
}
// A frame between the splash's last and the chrome's first that is neither is the exit's blend
// (the splash's ground without its icon there is the icon's fade done, the reveal not yet) –
// within the exit's window; ground standing longer than the exit stays in the timeline as ground.
const lastSplash = frames.map((f) => f.cls).lastIndexOf('splash')
const firstSplash = frames.findIndex((f) => f.cls === 'splash')
const firstChrome = frames.findIndex(
  (f, i) => i > lastSplash && ['picture', 'page', 'blank'].includes(f.cls)
)
if (kind !== 'webapp' && lastSplash >= 0 && firstChrome > lastSplash) {
  for (let i = lastSplash + 1; i < Math.min(firstChrome, lastSplash + 1 + EXIT_FRAMES); i++)
    if (['other', 'ground'].includes(frames[i].cls)) frames[i].cls = 'fade'
}
// The web app's: the dress blend just before the tile, the exit (the icon's fade leaves the
// window's colour bare for its 133 ms, then the reveal blends it into the page) just after the
// last splash frame – within their windows and no further.
if (kind === 'webapp' && firstSplash >= 0) {
  for (let i = Math.max(0, firstSplash - DRESS_FRAMES); i < firstSplash; i++)
    if (['other', 'window'].includes(frames[i].cls)) frames[i].cls = 'dress'
  for (let i = lastSplash + 1; i < Math.min(frames.length, lastSplash + 1 + EXIT_FRAMES); i++) {
    if (frames[i].cls === 'page') break
    if (['other', 'window'].includes(frames[i].cls)) frames[i].cls = 'fade'
  }
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
      `  ${(run.from / FPS).toFixed(2)}-${((run.from + run.n) / FPS).toFixed(2)} s ${run.cls} x${run.n} (${readings(sampleFrame)})`
    )
  }
  const classes = frames.map((f) => f.cls)
  const count = (cls) => classes.filter((c) => c === cls).length
  const firstOf = (cls) => classes.indexOf(cls)
  const at = (i) => (i < 0 ? 'never' : `${(i / FPS).toFixed(2)} s`)
  const ms = (n) => `${n} frames (${Math.round((n * 1000) / FPS)} ms)`

  // The lead: the start request laid back from the lift (the frame after the last splash
  // frame, READY's distance from the request before it), then the frames from there to the
  // first splash frame – for the web app, to the first frame of any window of the app's (the
  // platform's fixed ground is its starting window) – and what they showed.
  const shown =
    kind === 'webapp' ? ['plain', 'dress', 'splash', 'window', 'ground', 'bare'] : ['splash']
  const firstShown = classes.findIndex((c) => shown.includes(c))
  if (kind !== 'hot') {
    if (anchorMs === null) say('lead: unread (no --anchor ready=<ms>)')
    else if (lastSplash < 0) say('lead: unread (no splash frame to anchor the lift on)')
    else if (firstShown < 0) say('lead: unread (nothing of the app was shown)')
    else {
      const tapFrame = lastSplash + 1 - (anchorMs * FPS) / 1000
      const leadFrames = firstShown - tapFrame
      const between = []
      for (let i = Math.max(0, Math.ceil(tapFrame)); i < firstShown; i++) {
        const last = between[between.length - 1]
        if (last && last.cls === frames[i].cls) last.n++
        else between.push({ cls: frames[i].cls, n: 1, sample: frames[i] })
      }
      const what = between.length
        ? between.map((r) => `${r.cls} x${r.n} (${readings(r.sample)})`).join(', ')
        : 'nothing: the first frame after the request already showed it'
      say(
        `lead: ${Math.round((leadFrames * 1000) / FPS)} ms (${leadFrames.toFixed(1)} frames) from the start request to the first ${kind === 'webapp' ? "frame of the app's window" : 'splash frame'} at ${at(firstShown)}; the request laid back ${anchorMs} ms from the lift at ${at(lastSplash + 1)}, so up to ${LEAD_ERROR_FRAMES} frames (${Math.round((LEAD_ERROR_FRAMES * 1000) / FPS)} ms) short; between: ${what}`
      )
    }
  }

  // The navigation bar's glyphs over the splash: the frames of the dressed splash past the
  // dress and the bars' own write (DRESS_FRAMES in), light or dark as most of them read.
  const splashFrames = frames.filter(
    (f, i) => f.cls === 'splash' && i >= firstSplash + DRESS_FRAMES && i <= lastSplash
  )
  if (splashFrames.length) {
    const { tone, detail } = navTone(splashFrames)
    const ground = splashFrames[Math.floor(splashFrames.length / 2)].nav.ground
    const expected = toneFor(ground)
    say(
      `nav over the splash: ${tone} glyphs on ${hex(ground)} (${detail}; the ground's luminance ${luminance(ground).toFixed(3)} asks for ${expected})`
    )
    if (kind === 'webapp')
      navVerdict(
        "the navigation bar's glyphs take the tone the dressed splash's ground asks for",
        tone === expected,
        `${tone} glyphs on ${hex(ground)}, ${expected} asked for (${detail})`
      )
  }
  if (kind === 'webapp') {
    const plainFrames = frames.filter((f) => f.cls === 'plain')
    if (plainFrames.length) {
      const { tone, detail } = navTone(plainFrames)
      const ground = plainFrames[Math.floor(plainFrames.length / 2)].nav.ground
      say(
        `nav over the fixed ground: ${tone} glyphs on ${hex(ground)} (${detail}; the platform's own, the ground's luminance ${luminance(ground).toFixed(3)} asks for ${toneFor(ground)})`
      )
    }
  }

  if (kind === 'lead') {
    say(
      `splash frames: ${count('splash')}${count('splash') ? ` from ${at(firstSplash)} to ${at(lastSplash)}` : ''}; black frames: ${count('black')}`
    )
  } else if (kind === 'webapp') {
    verdict(
      "the splash showed the app's tile on its ground",
      count('splash') > 0,
      `${count('splash')} splash frames from ${at(firstSplash)} to ${at(lastSplash)}`
    )
    const bareBefore = classes.filter((c, i) => c === 'window' && i < firstSplash).length
    verdict(
      "the app's window never stood bare before its tile",
      firstSplash >= 0 && bareBefore === 0,
      `${bareBefore} bare frames before the tile beyond the dress (plain ground until ${at(classes.lastIndexOf('plain'))})`
    )
    // The gap to the tile: from the fixed ground's first frame (the platform's starting window)
    // to the dressed splash – the plain frames, the dress, and the hand-over's own share: the
    // app's own window (its bar in the theme colour) before its splash view, its ground standing
    // in for the splash's, or the page view unpainted as it was.
    const before = (cls) =>
      classes.filter((c, i) => c === cls && i < firstSplash && i >= firstShown).length
    const groundBefore = before('ground')
    const bareOwn = before('bare')
    const plainBefore = before('plain')
    const dressBefore = before('dress')
    const toTile = firstSplash >= 0 && firstShown >= 0 ? firstSplash - firstShown : 0
    say(
      `gap: ${ms(toTile)} from the fixed ground's first frame to the tile: ${plainBefore} plain, ${dressBefore} dress, ${groundBefore} ground, ${bareOwn} bare`
    )
    say(
      `hand-over: ${ms(groundBefore + bareOwn)}: ${groundBefore} ground, ${bareOwn} bare (the app's own window before its splash view)`
    )
    verdict(
      "the app's own window never showed the page view unpainted",
      count('bare') === 0,
      `${count('bare')} bare frames (the page view white under the theme-coloured bar); its ground stood in for ${groundBefore} before the splash`
    )
    const page = firstOf('page')
    verdict(
      "the page's first frame came after the splash, within the exit's motion",
      page > lastSplash && lastSplash >= 0 && page - lastSplash <= EXIT_FRAMES,
      `last splash at ${at(lastSplash)}, page from ${at(page)}`
    )
    const bareAfter = classes.filter(
      (c, i) => page >= 0 && i > page && ['window', 'plain', 'bare', 'ground'].includes(c)
    ).length
    verdict(
      'nothing bare, plain or ground after the page',
      page >= 0 && bareAfter === 0,
      `${bareAfter} bare, plain or ground frames after the page's first`
    )
    verdict(
      "no splash frame after the page's first",
      page >= 0 && lastSplash < page,
      `last splash at ${at(lastSplash)}, page from ${at(page)}`
    )
  } else if (kind === 'cold') {
    verdict(
      'the splash was on screen',
      count('splash') > 0,
      `${count('splash')} splash frames, the first at ${at(firstSplash)}, the last at ${at(lastSplash)}`
    )
    const first = firstChrome >= 0 ? classes[firstChrome] : 'none'
    verdict(
      "the chrome's first frame after the splash shows the restored picture",
      first === 'picture',
      `first chrome frame at ${at(firstChrome)} is ${first}`
    )
    // The hand-over gap: the frames of the splash's run that are not the splash, the app
    // window's first frame(s) between the starting window and the transferred view.
    const inRun = (i) => i > firstSplash && i < lastSplash
    const gapBlank = classes.filter((c, i) => inRun(i) && c === 'blank').length
    const gapGround = classes.filter((c, i) => inRun(i) && c === 'ground').length
    say(`gap: ${ms(gapBlank + gapGround)}: ${gapBlank} blank, ${gapGround} ground`)
    const blanks = classes.filter((c, i) => i > firstSplash && c === 'blank').length
    verdict(
      "no blank page slot from the splash's first frame on",
      firstSplash >= 0 && blanks === 0,
      `${blanks} blank frames from the splash's first frame, ${gapBlank} of them inside the splash's run (the hand-over frame)`
    )
    verdict(
      'the page painted after its picture',
      firstOf('page') > firstOf('picture') && firstOf('picture') >= 0,
      `picture from ${at(firstOf('picture'))}, page from ${at(firstOf('page'))}`
    )
    const lastIndigo = Math.max(lastSplash, classes.lastIndexOf('ground'))
    verdict(
      "no splash frame, nor its ground, after the chrome's first",
      firstChrome < 0 || lastIndigo < firstChrome,
      `last splash at ${at(lastSplash)}, last ground at ${at(classes.lastIndexOf('ground'))}, first chrome frame at ${at(firstChrome)}`
    )
  } else {
    verdict(
      'no splash frame on the hot start',
      count('splash') === 0,
      `${count('splash')} splash frames`
    )
    verdict(
      'no blank page slot on the hot start',
      count('blank') + count('ground') === 0,
      `${count('blank')} blank frames, ${count('ground')} of the boot theme's ground`
    )
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
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-t',
      untilS.toFixed(2),
      '-i',
      video,
      '-vf',
      `fps=${fps.toFixed(4)},scale=${width}:-1,tile=6x3:padding=4:color=black`,
      '-frames:v',
      '1',
      tile
    ])
    say(
      result.status === 0
        ? `tile: ${tile} (${untilS.toFixed(2)} s over 18 frames)`
        : `the tile could not be written: ${String(result.stderr).trim()}`
    )
  }
} else if (video !== '-') {
  verdict('the recording could be read', false, `no frames decoded from ${video}`)
}

for (const still of stills) {
  const buffer = decode(still.path)
  if (!buffer) {
    verdict(
      `the ${still.cls} still shows the ${still.cls}`,
      false,
      `${still.path} could not be decoded`
    )
    continue
  }
  const [frame] = readFrames(buffer)
  const detail = `${still.path}: ${frame.cls} (${readings(frame)}; ${navReading(frame)})`
  verdict(`the ${still.cls} still shows the ${still.cls}`, frame.cls === still.cls, detail)
  if (still.cls === 'splash') {
    // The bars over the dressed splash (the material nit of round 3's light web-app still: dark
    // glyphs on the purple ground where the code asked for white).
    const expected = toneFor(frame.nav.ground)
    navVerdict(
      `the ${still.cls} still's navigation glyphs take the tone its ground asks for`,
      frame.nav.tone === expected,
      `${navReading(frame)}; the ground's luminance ${luminance(frame.nav.ground).toFixed(3)} asks for ${expected}`
    )
  }
}

writeFileSync(outPath, lines.join('\n') + '\n')
process.exit(failures.length ? 1 : 0)
