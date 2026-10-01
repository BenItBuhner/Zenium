// The desktop jank audit's harness (W8-A1-PERF): frame times and latencies of the chrome under
// the three scenes the audit names – a tab switch and a wake from sleep, the chrome's springs
// while a heavy page loads, and the prompts – measured on a launched build so a fix has a
// before and an after on the same machine.
//
//   xvfb-run -a -s "-screen 0 1600x1000x24" node .github/smoke/perf-audit.mjs \
//        --exe <zenium | node_modules/electron/dist/electron> [--app <dir>] --out <dir> \
//        [--scenarios switch,wake,load,prompts] [--runs 5] [--tabs 8] [--label before] \
//        [--cpu-throttle 4] [--profile] [--settle-ms 1500] [--extra-args "--flag ..."]
//
// `--exe` is the packaged executable, or Electron's own binary with `--app <dir>` naming the
// built tree (`electron-vite build`; `package.json`'s `main` is `out/main/index.js`). The run
// writes `<out>/<label>.json` with every sample and its p50 / p95 / max, and prints a table.
// `--cpu-throttle N` slows the chrome renderer N times (DevTools' CPU throttling, through CDP)
// to stand in for a slower machine; `--profile` brackets every sample with a CPU profile of the
// chrome renderer and of main, boiled down to the top functions by self and inclusive time.
//
// What is read, and where:
//   - the chrome renderer's frame times: a `requestAnimationFrame` loop in the chrome page records
//     the gap between frames while a scene runs (`__zenPerf.frames`); a gap over the frame budget
//     is a dropped frame; `longtask` entries name the tasks that held the thread (`longTasks`);
//     Event Timing (`PerformanceEventTiming`) says how long a click took to its next paint
//   - the switch's path: the click (`pointerdown`, captured) → the `state` event that carries the
//     new active tab (`window.zen.on('state')`) → the row's `data-active` flipped and painted
//     (a MutationObserver + a frame) → `layout.applied` naming the view shown (the view is on
//     screen) → the woken page's own first paint (its performance timeline, read off the
//     Playwright page its WebContents is)
//   - the main process: `perf_hooks.monitorEventLoopDelay` for the event-loop lag, every
//     `webContents.send('zen:event', 'state', …)` timed and sized (the serialisation runs on the
//     main thread), and `View.setVisible` stamped so the moment main shows the view is on record
//
// Everything is read from the outside – no build flag, no code path of the app's is changed by
// the harness; the probes are plain JavaScript evaluated in the chrome page and the main process.
// Unit tests of the pure parts (the statistics, the latency pairing): perf-audit.test.mjs.

import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  summarize,
  summarizeCpuProfile,
  frameStats as frameStatsOf,
  longTaskStats
} from './perf-audit-stats.mjs'

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 2) {
      out[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else out[key] = true
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.exe || !opts.out) {
  console.error(
    'usage: node perf-audit.mjs --exe <exe> [--app <dir>] --out <dir> [--scenarios a,b] [--runs N]'
  )
  process.exit(2)
}
const outDir = path.resolve(opts.out)
fs.mkdirSync(outDir, { recursive: true })
const label = String(opts.label ?? 'perf')
const RUNS = Number(opts.runs ?? 5)
const TABS = Number(opts.tabs ?? 8)
const scenarios = String(opts.scenarios ?? 'switch,wake,load,prompts')
  .split(',')
  .filter(Boolean)
const EXTRA_ARGS =
  typeof opts['extra-args'] === 'string' ? opts['extra-args'].split(' ').filter(Boolean) : []
/** The frame budget a 60 Hz display gives (ms); a longer gap between frames is a dropped frame. */
const FRAME_BUDGET_MS = 1000 / 60
/** How long after a trigger the chrome is watched for its settling (ms). */
const SETTLE_WINDOW_MS = Number(opts['settle-ms'] ?? 1500)
/** DevTools-style CPU throttling of the chrome renderer (1 = none). */
const CPU_THROTTLE = Number(opts['cpu-throttle'] ?? 1)
/** With `--profile`, a CPU profile of the chrome renderer and of main brackets every sample. */
const PROFILE = Boolean(opts.profile)

function log(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`)
}

// ---------------------------------------------------------------------------------------------
// The fixture server: light pages for the tabs, one heavy page, one page that raises prompts.
// ---------------------------------------------------------------------------------------------

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

function lightPage(n) {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Page ${n}</title>` +
    `<link rel="icon" href="/icon-${n}.png"></head>` +
    `<body style="margin:0;font:16px system-ui;padding:40px;background:#fafafa;color:#111">` +
    `<h1>Page ${n}</h1><p>A light page for the audit.</p>` +
    Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i} of page ${n}.</p>`).join('') +
    `</body></html>`
  )
}

/**
 * The heavy page: a load that keeps the throbber, the title and the favicon churning for about
 * three seconds the way a news site's does – a large DOM, a run of subresources each answered
 * after a delay, the title rewritten as each lands, a favicon swap, and script that lays the
 * document out again between them. What it is for: the chrome's springs must run while this
 * loads in a tab (the two motions of the load scene take about two seconds together, so the
 * load outlasts them), and the main process must carry the load's events.
 */
function heavyPage() {
  const blocks = Array.from(
    { length: 1500 },
    (_, i) =>
      `<div class="card"><h3>Card ${i}</h3><p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(3)}</p>` +
      `<img src="/img-${i % 12}.png" width="64" height="64" alt=""></div>`
  ).join('')
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Heavy 0</title>` +
    `<link id="icon" rel="icon" href="/icon-h0.png">` +
    `<style>body{margin:0;font:14px system-ui;background:#fff;color:#111}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:16px}.card{border:1px solid #ddd;padding:8px;border-radius:6px}</style>` +
    `</head><body><h1 style="padding:16px;margin:0">Heavy page</h1><div class="grid">${blocks}</div>` +
    Array.from(
      { length: 24 },
      (_, i) => `<script src="/slow-${i}.js?d=${150 + i * 110}"></script>`
    ).join('') +
    `</body></html>`
  )
}

function slowScript(i) {
  // Each script rewrites the title (a `page-title-updated` to the main process), swaps the icon
  // every third time (a `page-favicon-updated`), and forces a layout of the big grid.
  return (
    `document.title = 'Heavy ${i + 1}';` +
    (i % 3 === 0 ? `document.getElementById('icon').href = '/icon-h${i}.png';` : '') +
    `(function(){var t=performance.now();var n=0;while(performance.now()-t<12){n+=document.body.offsetHeight;document.body.style.paddingBottom=(n%3)+'px';}})();`
  )
}

function promptPage() {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Prompts</title></head>` +
    `<body style="margin:0;font:16px system-ui;padding:40px">` +
    `<h1>Prompts</h1>` +
    `<button id="alert" onclick="window.__t=performance.timeOrigin+performance.now();alert('Hello from the page')">alert</button>` +
    `<button id="geo" onclick="window.__t=performance.timeOrigin+performance.now();navigator.geolocation.getCurrentPosition(function(){},function(){})">geolocation</button>` +
    `<button id="notify" onclick="window.__t=performance.timeOrigin+performance.now();Notification.requestPermission()">notification</button>` +
    `<p id="text">Some selectable text for the context menu, and a <a href="/page/1">link</a>.</p>` +
    `</body></html>`
  )
}

function startFixture() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    if (/^\/(icon|img)-/.test(p)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_1PX.length })
      res.end(PNG_1PX)
      return
    }
    if (p === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_1PX.length })
      res.end(PNG_1PX)
      return
    }
    const slow = /^\/slow-(\d+)\.js$/.exec(p)
    if (slow) {
      const delay = Number(url.searchParams.get('d') ?? 200)
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/javascript' })
        res.end(slowScript(Number(slow[1])))
      }, delay)
      return
    }
    if (p === '/heavy') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(heavyPage())
      return
    }
    if (p === '/prompts') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(promptPage())
      return
    }
    const page = /^\/page\/(\d+)$/.exec(p)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(lightPage(page ? Number(page[1]) : 0))
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })
    )
  )
}

// ---------------------------------------------------------------------------------------------
// Launch: a fresh profile past onboarding, isolated XDG directories, the smoke's launch flags.
// ---------------------------------------------------------------------------------------------

const HARNESS_SETTINGS = {
  updates: { autoCheck: false, autoDownload: false, channel: 'stable' },
  shortcutPreset: 'chrome',
  onboardingDone: true,
  // The page's keyboard is not asked for: the chrome keeps it so the harness's key chords land.
  searchSuggestions: false
}

function freshProfile(root, extraSettings = {}) {
  const dir = path.join(root, 'profile')
  fs.mkdirSync(path.join(dir, 'zen'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'zen', 'state.json'),
    JSON.stringify({ version: 2, settings: { ...HARNESS_SETTINGS, ...extraSettings } })
  )
  return dir
}

function isWindowChromeUrl(url) {
  const value = String(url ?? '')
  return /^file:.*index\.html/.test(value) && !/[?&]surface=/.test(value)
}

async function launch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `zenium-perf-${label}-`))
  const isolation =
    process.platform === 'linux'
      ? {
          XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
          XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
          XDG_DATA_HOME: path.join(root, 'xdg-data')
        }
      : {}
  for (const d of Object.values(isolation)) fs.mkdirSync(d, { recursive: true })
  const userData = freshProfile(root)
  const appArgs = opts.app ? [path.resolve(opts.app)] : []
  const args = [
    ...appArgs,
    '--no-sandbox',
    `--user-data-dir=${userData}`,
    '--force-device-scale-factor=1',
    '--disable-gpu',
    ...EXTRA_ARGS
  ]
  log(`launching ${opts.exe} ${args.join(' ')}`)
  const app = await electron.launch({
    executablePath: opts.exe,
    args,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...isolation },
    chromiumSandbox: true,
    colorScheme: null,
    timeout: 90000
  })
  const stderr = []
  app.process().stderr?.on('data', (d) => stderr.push(d.toString()))
  const deadline = Date.now() + 60000
  let chrome = null
  while (Date.now() < deadline) {
    chrome = app.windows().find((p) => isWindowChromeUrl(p.url())) ?? null
    if (chrome) break
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!chrome) throw new Error('no chrome page came up')
  await chrome.locator('[data-testid="chrome-root"]').waitFor({ state: 'attached', timeout: 60000 })
  // The chrome renderer slowed down the way DevTools' CPU throttling does it, so a machine
  // several times slower than this one is stood in for (`--cpu-throttle 4`): the renderer's
  // own work shows at that scale, the main process's and the pages' do not change.
  let cdp = null
  if (CPU_THROTTLE > 1 || PROFILE) cdp = await app.context().newCDPSession(chrome)
  if (CPU_THROTTLE > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })
    log(`chrome renderer CPU throttled ${CPU_THROTTLE}x`)
  }
  if (PROFILE) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  }
  return { app, chrome, root, stderr, cdp }
}

// ---------------------------------------------------------------------------------------------
// CPU profiles (`--profile`): the chrome renderer's through CDP, main's through its own
// `node:inspector` session; each boiled down to the top functions by self and inclusive time.
// ---------------------------------------------------------------------------------------------

async function profileStart(session) {
  if (!PROFILE) return
  await session.cdp.send('Profiler.start')
  await session.app.evaluate(() => {
    const g = globalThis
    if (!g.__zenPerfInspector) {
      const builtin = (name) =>
        typeof process.getBuiltinModule === 'function'
          ? process.getBuiltinModule(name)
          : process.mainModule.require(name)
      const { Session } = builtin('node:inspector')
      const s = new Session()
      s.connect()
      g.__zenPerfInspector = s
      const post = (method, params) =>
        new Promise((resolve, reject) =>
          s.post(method, params ?? {}, (err, result) => (err ? reject(err) : resolve(result)))
        )
      g.__zenPerfPost = post
      return post('Profiler.enable')
        .then(() => post('Profiler.setSamplingInterval', { interval: 200 }))
        .then(() => post('Profiler.start'))
    }
    return g.__zenPerfPost('Profiler.start')
  })
}

async function profileStop(session) {
  if (!PROFILE) return null
  const chromeProfile = await session.cdp.send('Profiler.stop')
  const mainProfile = await session.app.evaluate(() => globalThis.__zenPerfPost('Profiler.stop'))
  return {
    chrome: summarizeCpuProfile(chromeProfile.profile, { top: 40 }),
    main: summarizeCpuProfile(mainProfile.profile, { top: 40 })
  }
}

// ---------------------------------------------------------------------------------------------
// The chrome probe: frame times, long tasks, event timing, the state / layout events, the
// active row's flip. Installed once; `start()` / `stop()` bracket a scene.
// ---------------------------------------------------------------------------------------------

function chromeProbeSource() {
  const g = globalThis
  if (g.__zenPerf) return
  const P = (g.__zenPerf = {
    recording: false,
    frames: [],
    longTasks: [],
    events: [],
    states: [],
    layouts: [],
    inputs: [],
    actives: [],
    mutations: [],
    marks: [],
    epoch: () => performance.timeOrigin + performance.now()
  })
  let last = 0
  const tick = (now) => {
    if (!P.recording) return
    if (last) P.frames.push({ at: performance.timeOrigin + now, dt: now - last })
    last = now
    requestAnimationFrame(tick)
  }
  P.start = () => {
    P.frames = []
    P.longTasks = []
    P.events = []
    P.states = []
    P.layouts = []
    P.inputs = []
    P.actives = []
    P.mutations = []
    P.marks = []
    P.recording = true
    last = 0
    requestAnimationFrame(tick)
  }
  P.stop = () => {
    P.recording = false
  }
  P.take = () => ({
    frames: P.frames,
    longTasks: P.longTasks,
    events: P.events,
    states: P.states,
    layouts: P.layouts,
    inputs: P.inputs,
    actives: P.actives,
    mutations: P.mutations,
    marks: P.marks
  })
  try {
    new PerformanceObserver((list) => {
      if (!P.recording) return
      for (const e of list.getEntries())
        P.longTasks.push({ at: performance.timeOrigin + e.startTime, duration: e.duration })
    }).observe({ type: 'longtask', buffered: false })
  } catch {
    /* no long task timing on this build */
  }
  try {
    new PerformanceObserver((list) => {
      if (!P.recording) return
      for (const e of list.getEntries())
        P.events.push({
          at: performance.timeOrigin + e.startTime,
          name: e.name,
          duration: e.duration,
          processing: e.processingEnd - e.processingStart,
          delay: e.processingStart - e.startTime
        })
    }).observe({ type: 'event', durationThreshold: 16, buffered: false })
  } catch {
    /* no event timing on this build */
  }
  const zen = g.zen
  if (zen && typeof zen.on === 'function') {
    zen.on('state', (state) => {
      // What the waits read (`waitForIdle`, `waitForDiscarded`): a count and a map from the
      // latest snapshot, so a wait costs the chrome a number and not a snapshot per poll.
      const tabs = Object.values(state.tabs ?? {})
      P.lastLoading = tabs.filter((t) => t.loading).length
      const discarded = {}
      for (const t of tabs) discarded[t.id] = Boolean(t.discarded)
      P.lastDiscarded = discarded
      if (!P.recording) return
      const at = P.epoch()
      let active = null
      try {
        const space = state.spaces.find((s) => s.id === state.activeSpaceId)
        active = space ? space.activeTabId : null
      } catch {
        active = null
      }
      const loading = Object.values(state.tabs ?? {}).filter((t) => t.loading).length
      P.states.push({ at, active, tabs: Object.keys(state.tabs ?? {}).length, loading })
    })
    zen.on('layout.applied', (e) => {
      if (!P.recording) return
      P.layouts.push({ at: P.epoch(), shown: e.shown, hid: e.hid, hidden: e.contentHidden })
    })
    zen.on('menu.show', () => {
      if (P.recording) P.marks.push({ at: P.epoch(), name: 'menu.show' })
    })
  }
  const input = (e) => {
    if (!P.recording) return
    P.inputs.push({
      at: P.epoch(),
      type: e.type,
      key: e.key ?? null,
      button: e.button ?? null,
      target: e.target && e.target.getAttribute ? e.target.getAttribute('data-tab-id') : null
    })
  }
  window.addEventListener('pointerdown', input, true)
  window.addEventListener('keydown', input, true)
  // The active row flipping, and the frame that paints it: a MutationObserver sees the attribute
  // change in the task that made it; `requestAnimationFrame` then runs at the start of the frame
  // that paints it, and a timeout queued from there lands after that frame's paint.
  const mo = new MutationObserver((records) => {
    if (!P.recording) return
    const at = P.epoch()
    for (const r of records) {
      if (r.type !== 'attributes') continue
      const el = r.target
      if (r.attributeName === 'data-active' && el.getAttribute('data-active') === 'true') {
        const entry = { at, tabId: el.getAttribute('data-tab-id'), frameAt: null, paintedAt: null }
        P.actives.push(entry)
        requestAnimationFrame(() => {
          entry.frameAt = P.epoch()
          setTimeout(() => {
            entry.paintedAt = P.epoch()
          }, 0)
        })
      }
    }
  })
  mo.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-active']
  })
  // A prompt, a menu or a dialog arriving: the first element matching a watched selector that is
  // added to the document, with the frame that paints it.
  const watched = []
  P.watch = (name, selector) => watched.push({ name, selector, seen: false })
  P.unwatch = () => watched.splice(0, watched.length)
  const additions = new MutationObserver(() => {
    if (!P.recording || watched.length === 0) return
    const at = P.epoch()
    for (const w of watched) {
      if (w.seen) continue
      const el = document.querySelector(w.selector)
      if (!el) continue
      w.seen = true
      const entry = { at, name: w.name, frameAt: null, paintedAt: null }
      P.mutations.push(entry)
      requestAnimationFrame(() => {
        entry.frameAt = P.epoch()
        setTimeout(() => {
          entry.paintedAt = P.epoch()
        }, 0)
      })
    }
  })
  additions.observe(document.documentElement, { subtree: true, childList: true, attributes: true })
}

// ---------------------------------------------------------------------------------------------
// The main-process probe: event-loop lag, `state` sends timed and sized, `View.setVisible`.
// ---------------------------------------------------------------------------------------------

function mainProbeSource(electron) {
  const g = globalThis
  if (g.__zenPerfMain) return { ok: true, already: true }
  // No `require` in Playwright's main-process evaluate: the builtins come through
  // `process.getBuiltinModule` (Node 22, Electron 44's), else the main module's `require`.
  const builtin = (name) =>
    typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule(name)
      : process.mainModule.require(name)
  const { monitorEventLoopDelay, performance } = builtin('node:perf_hooks')
  const { webContents } = electron
  const M = (g.__zenPerfMain = {
    recording: false,
    sends: [],
    visibles: [],
    lag: monitorEventLoopDelay({ resolution: 4 }),
    sizes: false
  })
  M.lag.enable()
  M.start = ({ sizes = false } = {}) => {
    M.sends = []
    M.visibles = []
    M.sizes = sizes
    M.lag.reset()
    M.recording = true
  }
  M.stop = () => {
    M.recording = false
    const h = M.lag
    const lag = {
      p50: h.percentile(50) / 1e6,
      p95: h.percentile(95) / 1e6,
      p99: h.percentile(99) / 1e6,
      max: h.max / 1e6,
      mean: h.mean / 1e6,
      count: h.count
    }
    return { sends: M.sends, visibles: M.visibles, lag }
  }
  // Every event the core sends a window's chrome: `webContents.send('zen:event', name, payload)`.
  // The send serialises the payload on this thread; the time around the original call is the
  // serialisation's cost, the stringified length the payload's size (read only when asked for,
  // since the stringify is a cost of its own).
  const all = webContents.getAllWebContents()
  const proto = all.length ? Object.getPrototypeOf(all[0]) : null
  let patched = false
  if (proto && typeof proto.send === 'function' && !proto.__zenPerfPatched) {
    const original = proto.send
    proto.send = function (channel, ...args) {
      if (M.recording && channel === 'zen:event') {
        const t = performance.now()
        const r = original.call(this, channel, ...args)
        const dt = performance.now() - t
        let size = null
        if (M.sizes) {
          try {
            size = JSON.stringify(args[1]).length
          } catch {
            size = null
          }
        }
        M.sends.push({ at: Date.now(), name: args[0], ms: dt, size, wc: this.id })
        return r
      }
      return original.call(this, channel, ...args)
    }
    proto.__zenPerfPatched = true
    patched = true
  }
  // The moment main shows or hides a view (`WebContentsView.setVisible`, on `View`'s prototype).
  let visiblePatched = false
  const ViewProto = electron.View && electron.View.prototype
  if (ViewProto && typeof ViewProto.setVisible === 'function') {
    const original = ViewProto.setVisible
    ViewProto.setVisible = function (visible) {
      if (M.recording) {
        let wc = null
        try {
          wc = this.webContents ? this.webContents.id : null
        } catch {
          wc = null
        }
        M.visibles.push({ at: Date.now(), visible, wc })
      }
      return original.call(this, visible)
    }
    visiblePatched = true
  }
  return { ok: true, patched, visiblePatched }
}

// ---------------------------------------------------------------------------------------------
// Scene helpers
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function invoke(chrome, name, args) {
  return chrome.evaluate(([n, a]) => window.zen.invoke(n, a), [name, args ?? null])
}

async function getState(chrome) {
  return invoke(chrome, 'app.getState')
}

function activeTabIdOf(state) {
  const space = state.spaces.find((s) => s.id === state.activeSpaceId)
  return space ? space.activeTabId : null
}

/** Open `n` tabs on light fixture pages and wait for their loads to end. */
async function openTabs(session, origin, n) {
  const ids = []
  for (let i = 1; i <= n; i++) {
    const id = await invoke(session.chrome, 'tab.create', {
      url: `${origin}/page/${i}`,
      active: true
    })
    ids.push(id)
    await sleep(120)
  }
  await waitForIdle(session.chrome, 8000)
  return ids
}

/**
 * Wait until no tab is loading (or `ms` has passed). The first reading is the core's own
 * (`app.getState`, ordered after the commands before it); the polls after it read the count the
 * probe keeps from the latest state event. A snapshot per poll would cost main a serialisation,
 * the chrome a bridge copy and Playwright another – 70 KB every 100 ms inside the very window
 * being measured (it read as 1.6 s of the chrome's time over a 7 s load at 4x).
 */
async function waitForIdle(chrome, ms) {
  const deadline = Date.now() + ms
  const countLoading = (state) => Object.values(state.tabs).filter((t) => t.loading).length
  if (countLoading(await getState(chrome)) === 0) return true
  while (Date.now() < deadline) {
    await sleep(100)
    const loading = await chrome.evaluate(() => globalThis.__zenPerf?.lastLoading ?? null)
    if ((loading ?? countLoading(await getState(chrome))) === 0) return true
  }
  return false
}

/** Wait until the page of `tabId` reads `discarded` (or the deadline passes); as `waitForIdle`. */
async function waitForDiscarded(chrome, tabId, ms) {
  const deadline = Date.now() + ms
  if ((await getState(chrome)).tabs[tabId]?.discarded) return true
  while (Date.now() < deadline) {
    await sleep(50)
    const discarded = await chrome.evaluate(
      (id) => globalThis.__zenPerf?.lastDiscarded?.[id] ?? null,
      tabId
    )
    if (discarded ?? (await getState(chrome)).tabs[tabId]?.discarded) return true
  }
  return false
}

async function probeStart(session, { sizes = false } = {}) {
  await session.chrome.evaluate(() => globalThis.__zenPerf.start())
  await session.app.evaluate(
    (_electron, o) => {
      const g = globalThis
      if (!g.__zenPerfMain) return null
      return g.__zenPerfMain.start(o)
    },
    { sizes }
  )
}

async function probeStop(session) {
  const chromeSide = await session.chrome.evaluate(() => {
    const P = globalThis.__zenPerf
    P.stop()
    return P.take()
  })
  const mainSide = await session.app.evaluate(() => {
    const g = globalThis
    return g.__zenPerfMain ? g.__zenPerfMain.stop() : null
  })
  return { chrome: chromeSide, main: mainSide }
}

/** The frame-time distribution of a recording window, restricted to [from, to] epoch ms. */
function frameStats(frames, from = -Infinity, to = Infinity) {
  return frameStatsOf(frames, FRAME_BUDGET_MS, from, to)
}

/** The woken page's first paint, read off the Playwright page whose URL is `url`. */
async function readPagePaint(app, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = app.windows().find((p) => p.url() === url)
    if (page) {
      try {
        const r = await page.evaluate(
          (limit) =>
            new Promise((resolve) => {
              const latest = () => {
                const paints = performance.getEntriesByType('paint')
                return paints.length ? Math.max(...paints.map((p) => p.startTime)) : null
              }
              const finish = () => resolve({ timeOrigin: performance.timeOrigin, paint: latest() })
              if (latest() !== null) return finish()
              try {
                const o = new PerformanceObserver(() => {
                  o.disconnect()
                  finish()
                })
                o.observe({ type: 'paint', buffered: true })
              } catch {
                /* fall through to the deadline */
              }
              setTimeout(finish, limit)
            }),
          Math.max(0, deadline - Date.now())
        )
        if (r && typeof r.paint === 'number') return r.timeOrigin + r.paint
        if (r) return null
      } catch {
        /* the page went or has not navigated yet */
      }
    }
    await sleep(20)
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------------------------

/**
 * One tab switch by a click on the row of `targetId`: the latencies from the click to the
 * state's arrival, the row's painted flip, the view shown by main, and the layout applied; the
 * chrome's frame times and long tasks over the settle window; main's lag and sends.
 */
async function switchOnce(session, targetId, { wake = false } = {}) {
  const { chrome } = session
  const row = chrome.locator(`[data-testid="tab"][data-tab-id="${targetId}"]`)
  await row.waitFor({ state: 'visible', timeout: 10000 })
  let targetUrl = null
  if (wake) {
    const state = await getState(chrome)
    targetUrl = state.tabs[targetId]?.url ?? null
  }
  await probeStart(session)
  await profileStart(session)
  const t0 = Date.now()
  await row.click()
  // The woken page's first paint, read while the chrome settles.
  const paintRead =
    wake && targetUrl ? readPagePaint(session.app, targetUrl, SETTLE_WINDOW_MS) : null
  await sleep(SETTLE_WINDOW_MS)
  const pagePaintAt = paintRead ? await paintRead : null
  const profile = await profileStop(session)
  const r = await probeStop(session)
  const click = r.chrome.inputs.find((i) => i.type === 'pointerdown') ?? { at: t0 }
  const clickAt = click.at
  const stateAt = r.chrome.states.find((s) => s.active === targetId)?.at ?? null
  const active = r.chrome.actives.find((a) => a.tabId === targetId) ?? null
  const layout = r.chrome.layouts.find((l) => l.shown.includes(targetId)) ?? null
  // Main's first `setVisible(true)` after the click, for a view it did not show before it.
  const shownByMain = r.main?.visibles.find((v) => v.visible && v.at >= clickAt - 5)?.at ?? null
  const first = (x) => (typeof x === 'number' ? Math.round((x - clickAt) * 10) / 10 : null)
  return {
    clickAt,
    stateMs: first(stateAt),
    rowFlipMs: first(active?.at),
    rowPaintedMs: first(active?.paintedAt ?? active?.frameAt),
    mainShowMs: first(shownByMain),
    layoutAppliedMs: first(layout?.at),
    pagePaintMs: first(pagePaintAt),
    frames: frameStats(r.chrome.frames, clickAt, clickAt + SETTLE_WINDOW_MS),
    longTasks: longTaskStats(r.chrome.longTasks, clickAt, clickAt + SETTLE_WINDOW_MS),
    eventTiming: r.chrome.events.filter((e) => e.name === 'pointerdown' || e.name === 'click'),
    stateEvents: r.chrome.states.length,
    mainLag: r.main?.lag ?? null,
    mainSends: r.main
      ? {
          count: r.main.sends.length,
          totalMs: r.main.sends.reduce((a, s) => a + s.ms, 0),
          maxMs: r.main.sends.reduce((a, s) => Math.max(a, s.ms), 0)
        }
      : null,
    ...(profile ? { profile } : {})
  }
}

async function sceneSwitch(session, origin, ids) {
  const samples = []
  // Alternate between the two last tabs so every switch is between loaded pages.
  for (let i = 0; i < RUNS; i++) {
    const target = ids[i % 2 === 0 ? ids.length - 2 : ids.length - 1]
    const sample = await switchOnce(session, target)
    samples.push(sample)
    log(
      `switch #${i + 1}: state ${sample.stateMs} ms, row painted ${sample.rowPaintedMs} ms, ` +
        `main show ${sample.mainShowMs} ms, layout ${sample.layoutAppliedMs} ms, ` +
        `frames p95 ${sample.frames.p95?.toFixed(1)} max ${sample.frames.max?.toFixed(1)} dropped ${sample.frames.dropped}`
    )
    await sleep(400)
  }
  return summarizeSamples(samples)
}

async function sceneWake(session, origin, ids) {
  const samples = []
  for (let i = 0; i < RUNS; i++) {
    // The target: a background tab, put to sleep first; the active one stays awake.
    const state = await getState(session.chrome)
    const activeId = activeTabIdOf(state)
    const target = ids.find((id) => id !== activeId && id !== ids[0]) ?? ids[1]
    await invoke(session.chrome, 'tab.unload', { tabId: target })
    const asleep = await waitForDiscarded(session.chrome, target, 5000)
    if (!asleep) log(`wake #${i + 1}: the tab did not read discarded in time`)
    await sleep(300)
    const sample = await switchOnce(session, target, { wake: true })
    samples.push(sample)
    log(
      `wake #${i + 1}: state ${sample.stateMs} ms, row painted ${sample.rowPaintedMs} ms, ` +
        `main show ${sample.mainShowMs} ms, layout ${sample.layoutAppliedMs} ms, page paint ${sample.pagePaintMs} ms, ` +
        `frames p95 ${sample.frames.p95?.toFixed(1)} max ${sample.frames.max?.toFixed(1)} dropped ${sample.frames.dropped}`
    )
    await waitForIdle(session.chrome, 5000)
    // Switch back to the first tab so the next run wakes a background tab again.
    await invoke(session.chrome, 'tab.activate', { tabId: ids[0] })
    await sleep(500)
  }
  return summarizeSamples(samples)
}

/**
 * The chrome's motion under a heavy load: the omnibox opened (Ctrl+L, its popup's spring) and
 * a tab closed from its row (the list's slide), each while the heavy page loads in the active
 * tab and once more at idle, with the frame times over each motion's window.
 */
async function sceneLoad(session, origin, ids) {
  const { chrome } = session
  const out = { idle: {}, loading: {} }
  const motionWindowMs = 700
  const measureMotion = async (name, act) => {
    await probeStart(session, { sizes: true })
    await profileStart(session)
    const t0 = Date.now()
    await act()
    await sleep(motionWindowMs)
    const profile = await profileStop(session)
    const r = await probeStop(session)
    const start = r.chrome.inputs[0]?.at ?? t0
    return {
      ...(profile ? { profile } : {}),
      frames: frameStats(r.chrome.frames, start, start + motionWindowMs),
      longTasks: longTaskStats(r.chrome.longTasks, start, start + motionWindowMs),
      stateEvents: r.chrome.states.filter((s) => s.at >= start && s.at <= start + motionWindowMs)
        .length,
      mainLag: r.main?.lag ?? null,
      mainSends: r.main
        ? {
            count: r.main.sends.length,
            totalMs: r.main.sends.reduce((a, s) => a + s.ms, 0),
            maxMs: r.main.sends.reduce((a, s) => Math.max(a, s.ms), 0),
            maxSize: r.main.sends.reduce((a, s) => Math.max(a, s.size ?? 0), 0),
            stateCount: r.main.sends.filter((s) => s.name === 'state').length
          }
        : null
    }
  }
  const openOmnibox = async () => {
    await chrome.keyboard.press('Control+l')
  }
  const closeOmnibox = async () => {
    await chrome.keyboard.press('Escape')
    await sleep(300)
  }
  const closeTab = async (tabId) => {
    await invoke(chrome, 'tab.close', { tabId })
  }
  const runs = { omnibox: [], close: [], load: [] }
  for (let phase of ['idle', 'loading']) {
    for (let i = 0; i < RUNS; i++) {
      // Fresh tabs to close, so the list has one to slide.
      const victim = await invoke(chrome, 'tab.create', {
        url: `${origin}/page/${50 + i}`,
        active: false
      })
      await waitForIdle(chrome, 5000)
      let heavyTab = null
      if (phase === 'loading') {
        heavyTab = await invoke(chrome, 'tab.create', {
          url: `${origin}/heavy?r=${i}`,
          active: true
        })
        // Let the document commit so the load is under way as the motions run.
        await sleep(250)
      } else {
        await invoke(chrome, 'tab.activate', { tabId: ids[0] })
        await sleep(300)
      }
      const omni = await measureMotion('omnibox', openOmnibox)
      await closeOmnibox()
      const close = await measureMotion('close', () => closeTab(victim))
      runs.omnibox.push({ phase, ...omni })
      runs.close.push({ phase, ...close })
      log(
        `${phase} #${i + 1}: omnibox frames p95 ${omni.frames.p95?.toFixed(1)} max ${omni.frames.max?.toFixed(1)} dropped ${omni.frames.dropped}; ` +
          `close p95 ${close.frames.p95?.toFixed(1)} max ${close.frames.max?.toFixed(1)} dropped ${close.frames.dropped}; ` +
          `states ${omni.stateEvents}+${close.stateEvents}; lag max ${omni.mainLag?.max?.toFixed(1)}`
      )
      if (heavyTab) {
        await waitForIdle(chrome, 15000)
        await invoke(chrome, 'tab.close', { tabId: heavyTab, force: true })
        await sleep(300)
      }
    }
  }
  // The whole load on its own, no motion over it: how long it runs, the state events and sends
  // it raises on main, and the chrome's frames while it carries them.
  for (let i = 0; i < RUNS; i++) {
    await probeStart(session, { sizes: true })
    await profileStart(session)
    const t0 = Date.now()
    const heavyTab = await invoke(chrome, 'tab.create', {
      url: `${origin}/heavy?l=${i}`,
      active: true
    })
    await sleep(500)
    await waitForIdle(chrome, 15000)
    const profile = await profileStop(session)
    const r = await probeStop(session)
    const span = (Date.now() - t0) / 1000
    const sample = {
      ...(profile ? { profile } : {}),
      seconds: span,
      frames: frameStats(r.chrome.frames),
      longTasks: longTaskStats(r.chrome.longTasks),
      stateEvents: r.chrome.states.length,
      mainLag: r.main?.lag ?? null,
      sends: r.main
        ? {
            count: r.main.sends.length,
            stateCount: r.main.sends.filter((s) => s.name === 'state').length,
            totalMs: r.main.sends.reduce((a, s) => a + s.ms, 0),
            maxMs: r.main.sends.reduce((a, s) => Math.max(a, s.ms), 0),
            maxSize: r.main.sends.reduce((a, s) => Math.max(a, s.size ?? 0), 0),
            meanSize: r.main.sends.length
              ? r.main.sends.reduce((a, s) => a + (s.size ?? 0), 0) / r.main.sends.length
              : 0
          }
        : null
    }
    runs.load.push(sample)
    log(
      `load alone #${i + 1}: ${span.toFixed(1)} s, ${sample.stateEvents} state events, ` +
        `frames p95 ${sample.frames.p95?.toFixed(1)} max ${sample.frames.max?.toFixed(1)} dropped ${sample.frames.dropped}, lag max ${sample.mainLag?.max?.toFixed(1)}`
    )
    await invoke(chrome, 'tab.close', { tabId: heavyTab, force: true })
    await sleep(300)
  }
  for (const phase of ['idle', 'loading']) {
    out[phase] = {
      omnibox: summarizeMotion(runs.omnibox.filter((r) => r.phase === phase)),
      close: summarizeMotion(runs.close.filter((r) => r.phase === phase))
    }
  }
  out.loadAlone = runs.load
  return out
}

/**
 * The prompts: the time from the trigger to the first painted frame of the prompt in the
 * chrome – a tab-modal `alert()` (the frame dialog host), a geolocation request's permission
 * bubble, the tab row's context menu (a native menu: the time to the host's `menu.show` is not
 * observable, so the main-side popup call is stamped by the IPC's arrival instead), and the
 * app menu (renderer-hosted, `menu.show`).
 */
async function scenePrompts(session, origin) {
  const { chrome, app } = session
  const promptTab = await invoke(chrome, 'tab.create', { url: `${origin}/prompts`, active: true })
  await waitForIdle(chrome, 8000)
  await sleep(500)
  const pageOf = () => app.windows().find((p) => p.url() === `${origin}/prompts`)
  const results = { alert: [], geolocation: [], appMenu: [], tabMenu: [] }
  for (let i = 0; i < RUNS; i++) {
    const page = pageOf()
    if (!page) throw new Error('the prompts page is not among the windows')
    // alert(): the page stamps the call; the chrome's dialog host mounts the prompt.
    await chrome.evaluate(() => {
      globalThis.__zenPerf.unwatch()
      globalThis.__zenPerf.watch('alert', '[data-page-dialog="alert"]')
    })
    await probeStart(session)
    const alertCall = page.evaluate(() => {
      window.__t = performance.timeOrigin + performance.now()
      document.getElementById('alert').click()
      return window.__t
    })
    await sleep(900)
    const r1 = await probeStop(session)
    const dialog = r1.chrome.mutations.find((m) => m.name === 'alert') ?? null
    // Dismiss the dialog with Escape (or Enter) so the page's alert() returns.
    await chrome.keyboard.press('Escape')
    const callAt = await alertCall.catch(() => null)
    await sleep(300)
    results.alert.push({
      triggerAt: callAt,
      mountedMs: dialog && callAt ? Math.round(dialog.at - callAt) : null,
      paintedMs:
        dialog && callAt ? Math.round((dialog.paintedAt ?? dialog.frameAt) - callAt) : null,
      longTasks: longTaskStats(r1.chrome.longTasks),
      frames: frameStats(r1.chrome.frames)
    })
    // Geolocation: the permission bubble.
    await chrome.evaluate(() => {
      globalThis.__zenPerf.unwatch()
      globalThis.__zenPerf.watch('permission', '[data-testid="permission-prompt"]')
    })
    await probeStart(session)
    const geoAt = await page.evaluate(() => {
      window.__t = performance.timeOrigin + performance.now()
      document.getElementById('geo').click()
      return window.__t
    })
    await sleep(900)
    const r2 = await probeStop(session)
    const bubble = r2.chrome.mutations.find((m) => m.name === 'permission') ?? null
    results.geolocation.push({
      triggerAt: geoAt,
      mountedMs: bubble ? Math.round(bubble.at - geoAt) : null,
      paintedMs: bubble ? Math.round((bubble.paintedAt ?? bubble.frameAt) - geoAt) : null,
      longTasks: longTaskStats(r2.chrome.longTasks),
      frames: frameStats(r2.chrome.frames)
    })
    await chrome.keyboard.press('Escape')
    await sleep(300)
    // The app menu (renderer-hosted): a click on its "⋯" button, measured from the pointer down.
    // (Its chords – Alt+F, F10 in the Chrome preset – do not open it under Playwright's
    // synthetic keys on this build; the button does.)
    await chrome.evaluate(() => {
      globalThis.__zenPerf.unwatch()
      globalThis.__zenPerf.watch('menu', '[role="menu"]')
    })
    await probeStart(session)
    await chrome.locator('[data-zen-app-menu-button]').first().click()
    await sleep(900)
    const r3 = await probeStop(session)
    const key = r3.chrome.inputs.find((k) => k.type === 'pointerdown') ?? null
    const menu = r3.chrome.mutations.find((m) => m.name === 'menu') ?? null
    const menuShow = r3.chrome.marks.find((m) => m.name === 'menu.show') ?? null
    results.appMenu.push({
      showMs: key && menuShow ? Math.round(menuShow.at - key.at) : null,
      mountedMs: key && menu ? Math.round(menu.at - key.at) : null,
      paintedMs: key && menu ? Math.round((menu.paintedAt ?? menu.frameAt) - key.at) : null,
      longTasks: longTaskStats(r3.chrome.longTasks),
      frames: frameStats(r3.chrome.frames)
    })
    await chrome.keyboard.press('Escape')
    await sleep(300)
    log(
      `prompts #${i + 1}: alert painted ${results.alert[i].paintedMs} ms (mounted ${results.alert[i].mountedMs}); ` +
        `geolocation painted ${results.geolocation[i].paintedMs} ms (mounted ${results.geolocation[i].mountedMs}); ` +
        `app menu painted ${results.appMenu[i].paintedMs} ms (show ${results.appMenu[i].showMs}, mounted ${results.appMenu[i].mountedMs})`
    )
  }
  await invoke(chrome, 'tab.close', { tabId: promptTab, force: true })
  const sum = (rows, key) => summarize(rows.map((r) => r[key]).filter((v) => typeof v === 'number'))
  return {
    alert: {
      samples: results.alert,
      mounted: sum(results.alert, 'mountedMs'),
      painted: sum(results.alert, 'paintedMs')
    },
    geolocation: {
      samples: results.geolocation,
      mounted: sum(results.geolocation, 'mountedMs'),
      painted: sum(results.geolocation, 'paintedMs')
    },
    appMenu: {
      samples: results.appMenu,
      show: sum(results.appMenu, 'showMs'),
      mounted: sum(results.appMenu, 'mountedMs'),
      painted: sum(results.appMenu, 'paintedMs')
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------------------------

function summarizeSamples(samples) {
  const pick = (key) => summarize(samples.map((s) => s[key]).filter((v) => typeof v === 'number'))
  const frameP95 = samples.map((s) => s.frames.p95).filter((v) => typeof v === 'number')
  const frameMax = samples.map((s) => s.frames.max).filter((v) => typeof v === 'number')
  return {
    samples,
    stateMs: pick('stateMs'),
    rowPaintedMs: pick('rowPaintedMs'),
    mainShowMs: pick('mainShowMs'),
    layoutAppliedMs: pick('layoutAppliedMs'),
    pagePaintMs: pick('pagePaintMs'),
    frames: {
      p50OfRuns: summarize(samples.map((s) => s.frames.p50).filter((v) => typeof v === 'number')),
      p95OfRuns: summarize(frameP95),
      maxOfRuns: summarize(frameMax),
      dropped: summarize(samples.map((s) => s.frames.dropped))
    },
    longTasks: {
      count: summarize(samples.map((s) => s.longTasks.count)),
      totalMs: summarize(samples.map((s) => s.longTasks.totalMs)),
      max: summarize(samples.map((s) => s.longTasks.max))
    },
    mainLagMax: summarize(samples.map((s) => s.mainLag?.max).filter((v) => typeof v === 'number')),
    mainSendsTotalMs: summarize(
      samples.map((s) => s.mainSends?.totalMs).filter((v) => typeof v === 'number')
    )
  }
}

function summarizeMotion(rows) {
  const all = rows.map((r) => r.frames)
  return {
    runs: rows.length,
    p50: summarize(all.map((f) => f.p50).filter((v) => typeof v === 'number')),
    p95: summarize(all.map((f) => f.p95).filter((v) => typeof v === 'number')),
    max: summarize(all.map((f) => f.max).filter((v) => typeof v === 'number')),
    dropped: summarize(all.map((f) => f.dropped)),
    frames: summarize(all.map((f) => f.count)),
    longTaskMs: summarize(rows.map((r) => r.longTasks.totalMs)),
    stateEvents: summarize(rows.map((r) => r.stateEvents)),
    mainLagMax: summarize(rows.map((r) => r.mainLag?.max).filter((v) => typeof v === 'number')),
    mainSendMs: summarize(
      rows.map((r) => r.mainSends?.totalMs).filter((v) => typeof v === 'number')
    )
  }
}

function fmt(s) {
  if (!s || typeof s.p50 !== 'number') return '–'
  return `p50 ${s.p50.toFixed(1)} · p95 ${s.p95.toFixed(1)} · max ${s.max.toFixed(1)} (n=${s.count})`
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  const { server, origin } = await startFixture()
  log(`fixture at ${origin}`)
  const session = await launch()
  const result = {
    label,
    exe: opts.exe,
    app: opts.app ?? null,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    cpu: os.cpus()[0]?.model ?? null,
    memoryGb: Math.round(os.totalmem() / 1e9),
    startedAt: new Date().toISOString(),
    runs: RUNS,
    tabs: TABS,
    cpuThrottle: CPU_THROTTLE,
    frameBudgetMs: FRAME_BUDGET_MS,
    scenes: {}
  }
  try {
    await session.chrome.evaluate(chromeProbeSource)
    const mainProbe = await session.app.evaluate(mainProbeSource)
    log(`main probe: ${JSON.stringify(mainProbe)}`)
    result.mainProbe = mainProbe
    result.electron = await session.app.evaluate(() => process.versions.electron)
    const ids = await openTabs(session, origin, TABS)
    log(`${ids.length} tabs open`)
    await sleep(1000)
    if (scenarios.includes('switch')) {
      log('scene: switch')
      result.scenes.switch = await sceneSwitch(session, origin, ids)
    }
    if (scenarios.includes('wake')) {
      log('scene: wake')
      result.scenes.wake = await sceneWake(session, origin, ids)
    }
    if (scenarios.includes('load')) {
      log('scene: load')
      result.scenes.load = await sceneLoad(session, origin, ids)
    }
    if (scenarios.includes('prompts')) {
      log('scene: prompts')
      result.scenes.prompts = await scenePrompts(session, origin)
    }
  } finally {
    result.endedAt = new Date().toISOString()
    const file = path.join(outDir, `${label}.json`)
    fs.writeFileSync(file, JSON.stringify(result, null, 2))
    log(`wrote ${file}`)
    await closeApp(session.app)
    server.close()
    // A killed Electron may still be dropping files into the profile for a moment (ENOTEMPTY).
    fs.rmSync(session.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  printTable(result)
}

/** Playwright's close() needs a live main-process event loop; fall back to killing the tree. */
async function closeApp(app) {
  const proc = app.process()
  const exited = new Promise((r) => proc.once('exit', r))
  await Promise.race([app.close().catch(() => undefined), sleep(8000)])
  if (proc.exitCode === null && !proc.killed) {
    log(`force killing pid ${proc.pid}`)
    try {
      process.kill(proc.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await Promise.race([exited, sleep(5000)])
  }
}

function printTable(result) {
  const lines = []
  const sw = result.scenes.switch
  if (sw) {
    lines.push(`switch (loaded→loaded, n=${sw.samples.length})`)
    lines.push(`  click→state      ${fmt(sw.stateMs)}`)
    lines.push(`  click→row paint  ${fmt(sw.rowPaintedMs)}`)
    lines.push(`  click→main show  ${fmt(sw.mainShowMs)}`)
    lines.push(`  click→layout     ${fmt(sw.layoutAppliedMs)}`)
    lines.push(
      `  frame p95/run    ${fmt(sw.frames.p95OfRuns)}   max/run ${fmt(sw.frames.maxOfRuns)}   dropped/run ${fmt(sw.frames.dropped)}`
    )
    lines.push(
      `  long tasks/run   count ${fmt(sw.longTasks.count)}   total ms ${fmt(sw.longTasks.totalMs)}`
    )
    lines.push(
      `  main lag max     ${fmt(sw.mainLagMax)}   state sends ms/run ${fmt(sw.mainSendsTotalMs)}`
    )
  }
  const wk = result.scenes.wake
  if (wk) {
    lines.push(`wake (sleeping→loaded, n=${wk.samples.length})`)
    lines.push(`  click→state      ${fmt(wk.stateMs)}`)
    lines.push(`  click→row paint  ${fmt(wk.rowPaintedMs)}`)
    lines.push(`  click→main show  ${fmt(wk.mainShowMs)}`)
    lines.push(`  click→layout     ${fmt(wk.layoutAppliedMs)}`)
    lines.push(`  click→page paint ${fmt(wk.pagePaintMs)}`)
    lines.push(
      `  frame p95/run    ${fmt(wk.frames.p95OfRuns)}   max/run ${fmt(wk.frames.maxOfRuns)}   dropped/run ${fmt(wk.frames.dropped)}`
    )
    lines.push(
      `  long tasks/run   count ${fmt(wk.longTasks.count)}   total ms ${fmt(wk.longTasks.totalMs)}`
    )
    lines.push(
      `  main lag max     ${fmt(wk.mainLagMax)}   state sends ms/run ${fmt(wk.mainSendsTotalMs)}`
    )
  }
  const ld = result.scenes.load
  if (ld) {
    for (const phase of ['idle', 'loading']) {
      for (const motion of ['omnibox', 'close']) {
        const m = ld[phase][motion]
        lines.push(
          `${phase} ${motion}: frame p95 ${fmt(m.p95)} · max ${fmt(m.max)} · dropped ${fmt(m.dropped)} · long task ms ${fmt(m.longTaskMs)} · states ${fmt(m.stateEvents)} · main lag max ${fmt(m.mainLagMax)}`
        )
      }
    }
    for (const t of ld.loadAlone) {
      lines.push(
        `load alone ${t.seconds.toFixed(1)} s: ${t.stateEvents} state events, sends ${t.sends?.stateCount} state / ${t.sends?.count} total, ` +
          `${t.sends?.totalMs.toFixed(1)} ms serialising (max ${t.sends?.maxMs.toFixed(2)}), mean size ${Math.round(t.sends?.meanSize ?? 0)} B, ` +
          `chrome frames p95 ${t.frames.p95?.toFixed(1)} max ${t.frames.max?.toFixed(1)} dropped ${t.frames.dropped}, long tasks ${t.longTasks.count} (${t.longTasks.totalMs.toFixed(0)} ms), main lag max ${t.mainLag?.max?.toFixed(1)}`
      )
    }
  }
  const pr = result.scenes.prompts
  if (pr) {
    lines.push(`alert dialog: mounted ${fmt(pr.alert.mounted)} · painted ${fmt(pr.alert.painted)}`)
    lines.push(
      `geolocation bubble: mounted ${fmt(pr.geolocation.mounted)} · painted ${fmt(pr.geolocation.painted)}`
    )
    lines.push(
      `app menu: show ${fmt(pr.appMenu.show)} · mounted ${fmt(pr.appMenu.mounted)} · painted ${fmt(pr.appMenu.painted)}`
    )
  }
  console.log(lines.join('\n'))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
