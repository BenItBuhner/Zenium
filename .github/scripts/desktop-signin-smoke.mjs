#!/usr/bin/env node
/**
 * Sign-in fidelity smoke test for the packaged desktop build.
 *
 * Boots the unpacked Linux build (under Xvfb: the workflow wraps this in `xvfb-run`) with a
 * throwaway profile whose MCP server is on, points a tab at a local page and checks what a site
 * sees – the things identity providers key on and that Electron gets wrong out of the box:
 *
 *   - `navigator.webdriver` is false (no automation switch on the command line);
 *   - `window.chrome` carries Chrome's `app`, `csi` and `loadTimes` (Google's sign-in refuses a
 *     Chrome whose `chrome` object lacks `app` as an embedded browser);
 *   - the user agent is Chrome's reduced string, without Electron or Zenium tokens;
 *   - the document request carries the low-entropy client hints and Chrome's Accept-Language;
 *   - FedCM is not exposed (Electron cannot serve it; Google's button would take that path);
 *   - a `window.open` pop-up keeps its opener, its `postMessage` arrives, and the pop-up's
 *     document runs the page preload (its `chrome.app` is there too).
 *
 * The pop-up needs a user gesture: the core's pop-up blocker allows `window.open` only within a
 * few seconds of trusted input on the page. The gesture is a real one – `browser_click`, which is
 * `webContents.sendInputEvent` at the button's coordinates when the page is on screen – sent only
 * once the tab's view is visible and laid out (the chrome renderer places tab views with its
 * first layout report, which a cold runner delivers late; before it the click would degrade to a
 * synthetic DOM click that arms nothing), and verified by the page itself (`event.isTrusted`).
 * When the click still did not arrive as trusted input and `xdotool` is available, the pointer
 * is driven through X instead, calibrated by a mousemove the page reports. A degraded click is
 * logged whole – the tool's second line names the cause (`input: synthetic – …`) – and when the
 * cause names chrome covering the page it is dismissed (Escape) before the pointer goes in; the
 * synthetic click has run the button's handler by then, so the page's flags are reset first,
 * and a click the page did not report as trusted is retried once after a fresh mousemove, with
 * what the page saw (`__clickTrusted`'s value, the element at the button's centre, the view's
 * geometry, the tab listing) in the log either way.
 *
 * Usage: node .github/scripts/desktop-signin-smoke.mjs [path/to/zenium] [--out <dir>]
 *        [--gesture mcp|xdotool]
 * `--out` writes signin-smoke.log and, on failure, a screenshot of the display there (for the
 * workflow's artifact). Exit code 0 when every check passes, 1 otherwise.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { removeTree } from './remove-tree.mjs'

const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const positional = argv.filter(
  (arg, i) => !arg.startsWith('--') && argv[i - 1]?.startsWith('--') !== true
)
const binary = resolve(positional[0] ?? 'dist/linux-unpacked/zenium')
const outDir =
  option('--out') ?? (process.env.SMOKE_OUT ? join(process.env.SMOKE_OUT, 'signin') : null)
const gestureMode = option('--gesture') ?? 'mcp'
const AGENT_PORT = 41739
const ON_SCREEN_TIMEOUT_MS = 45_000
const POPUP_TIMEOUT_MS = 8_000

const lines = []
const failures = []
const passes = []
const log = (text) => {
  lines.push(text)
  console.log(text)
}
const check = (name, ok, detail = '') => {
  ;(ok ? passes : failures).push(name)
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` – ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const has = (command) =>
  spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0

// --- the site --------------------------------------------------------------------------------

const requests = []
const site = createServer((req, res) => {
  requests.push({ url: req.url, headers: req.headers })
  res.setHeader('cache-control', 'no-store')
  if (req.url.startsWith('/popup')) {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>popup</title><body><script>
      const report = { from: 'popup', opener: Boolean(window.opener), chromeApp: typeof (window.chrome && window.chrome.app) };
      if (window.opener) window.opener.postMessage(report, '*');
    </script></body>`)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><title>smoke</title><body style="margin:0">
  <button id="open" style="position:fixed;left:40px;top:40px;width:240px;height:120px;font-size:32px">open</button>
  <script>
    window.__popupMessage = null;
    window.__clickTrusted = null;
    window.__lastMove = null;
    window.__events = [];
    window.__moveCount = 0;
    // DIAG: whether this renderer gets animation frames at all (none: no BeginMainFrame, which
    // keeps Chromium's first-paint input suppression up – non-move input dropped, moves kept).
    window.__rafCount = 0;
    window.__rafLast = null;
    (function tick() { window.__rafCount++; window.__rafLast = Math.round(performance.now()); requestAnimationFrame(tick) })();
    addEventListener('message', (e) => { window.__popupMessage = e.data });
    addEventListener('mousemove', (e) => { window.__moveCount++; window.__lastMove = { screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY, trusted: e.isTrusted } }, true);
    // DIAG: a capture-phase trace of every discrete pointer/mouse event the renderer received,
    // with isTrusted, coordinates and target – tells null (nothing arrived) from a coordinate miss.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      addEventListener(type, (e) => {
        if (window.__events.length < 200) {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          window.__events.push({
            t: Math.round(performance.now()), type: e.type, trusted: e.isTrusted,
            x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, button: e.button,
            tgt: e.target ? (e.target.id || e.target.tagName) : null,
            at: el ? (el.id || el.tagName) : null
          });
        }
      }, true);
    }
    document.getElementById('open').addEventListener('click', (e) => {
      window.__clickTrusted = e.isTrusted;
      window.__popup = window.open('/popup', 'smoke', 'width=400,height=300');
    });
  </script></body>`)
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const siteUrl = `http://localhost:${site.address().port}/`

// --- the browser -----------------------------------------------------------------------------

const config = mkdtempSync(join(tmpdir(), 'zenium-smoke-'))
mkdirSync(join(config, 'Zenium', 'zen'), { recursive: true })
// The build's version – package.json's, which `app.getVersion()` reports in the packaged build.
const appVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
).version
writeFileSync(
  join(config, 'Zenium', 'zen', 'state.json'),
  JSON.stringify({
    version: 3,
    settings: {
      onboardingDone: true,
      // The "Make Zenium your default browser" strip remembers an answer as the version it was
      // given in (`defaultBrowserPromptDismissed: string | null`; a number read as no answer,
      // and the strip showed): this build's version, so the strip stays down on a runner, where
      // no browser is the default. It sits in the frame above the page and arrives when the host
      // answers – late on a busy runner, and a strip arriving mid-run moves the page under a
      // calibrated pointer by its 40 px.
      defaultBrowserPromptDismissed: appVersion,
      updates: { checkAutomatically: false },
      agents: {
        enabled: true,
        port: AGENT_PORT,
        lan: false,
        approveNewAgents: false,
        approvedNames: [],
        defaultMode: 'foreground',
        allowScripts: true,
        showCursor: false
      }
    }
  })
)
/**
 * DIAG: microseconds on CLOCK_MONOTONIC – the clock Chromium's trace timestamps (`ts`) are on,
 * so the harness's moments (spawn, the click) can be placed on the browser's trace.
 */
const mono = () => Number(process.hrtime.bigint() / 1000n)
const marks = []
const mark = (what) => marks.push({ at: mono(), what })
const startedAt = Date.now()
const spawnMono = mono()
const app = spawn(binary, ['--no-sandbox'], {
  env: { ...process.env, XDG_CONFIG_HOME: config, ZEN_INPUT_DIAG: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))
app.on('exit', (code) => log(`zenium exited with ${code}`))
/** Whether the browser process is gone (a code or a signal set once it exited). */
const exited = () => app.exitCode !== null || app.signalCode !== null
/** Resolves when the browser process exits, or after `ms`; at once when it is gone already. */
const waitForExit = (ms) =>
  exited() ? Promise.resolve() : Promise.race([new Promise((r) => app.once('exit', r)), sleep(ms)])

const agentFile = join(config, 'Zenium', 'zen', 'agent.json')
let token = ''
for (let i = 0; i < 90 && !token; i++) {
  await sleep(1000)
  try {
    const agent = JSON.parse(readFileSync(agentFile, 'utf8'))
    if (agent.token) {
      const probe = await fetch(`http://127.0.0.1:${AGENT_PORT}/mcp`).catch(() => null)
      if (probe) token = agent.token
    }
  } catch {
    /* not written yet */
  }
}
if (!token) {
  console.error('MCP server did not come up\n' + appLog)
  app.kill('SIGKILL')
  process.exit(1)
}
log(`MCP server up after ${Date.now() - startedAt} ms`)

let sessionId = ''
async function rpc(method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'user-agent': 'zenium-smoke'
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  sessionId = res.headers.get('mcp-session-id') ?? sessionId
  const text = await res.text()
  return text ? JSON.parse(text) : null
}
async function tool(name, args = {}) {
  const reply = await rpc('tools/call', { name, arguments: args })
  if (!reply || reply.error) throw new Error(`${name}: ${JSON.stringify(reply?.error)}`)
  const out = (reply.result.content ?? []).map((c) => c.text ?? '').join('\n')
  if (reply.result.isError) throw new Error(`${name}: ${out}`)
  return out
}
async function evaluate(expression, tabId) {
  const out = await tool('browser_evaluate', tabId ? { expression, tabId } : { expression })
  return JSON.parse(out.slice(out.indexOf('\n') + 1))
}
/** Polls `expression` in the page until it is truthy; the value, or null after `timeoutMs`. */
async function waitFor(expression, timeoutMs) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(expression).catch(() => null)
    if (value) return value
    if (Date.now() > until) return null
    await sleep(250)
  }
}

// --- gestures --------------------------------------------------------------------------------

const ON_SCREEN_EXPRESSION = `document.visibilityState === 'visible' && innerWidth > 0 && innerHeight > 0 && ({ w: innerWidth, h: innerHeight })`

/**
 * Waits for the tab's view to be visible and laid out. The chrome renderer places tab views with
 * its layout reports, and hides them under chrome that covers the page (the URL bar overlay a
 * blank first tab opens, for one), so a page that stays hidden for a while is nudged through X
 * when `xdotool` is there: Escape closes such an overlay, and so does a click into the window.
 */
async function waitOnScreen() {
  const until = Date.now() + ON_SCREEN_TIMEOUT_MS
  let nudges = 0
  for (;;) {
    const shown = await waitFor(ON_SCREEN_EXPRESSION, 5000)
    if (shown) return shown
    if (Date.now() > until) return null
    if (!process.env.DISPLAY || !has('xdotool')) continue
    nudges++
    const geometry = await evaluate(
      `({ sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, focus: document.hasFocus(), vis: document.visibilityState })`
    ).catch(() => null)
    log(
      `page still hidden (${JSON.stringify(geometry)}); nudge ${nudges}: Escape, then a click into the window`
    )
    const xdotool = (...args) => spawnSync('xdotool', args, { stdio: 'ignore' })
    xdotool('key', 'Escape')
    await sleep(600)
    if (await evaluate(ON_SCREEN_EXPRESSION).catch(() => null)) continue
    if (geometry) {
      xdotool(
        'mousemove',
        '--sync',
        String(Math.round(geometry.sx + geometry.ow * 0.6)),
        String(Math.round(geometry.sy + geometry.oh * 0.6)),
        'click',
        '1'
      )
      await sleep(600)
    }
  }
}

/**
 * The MCP click: trusted OS-level input (`webContents.sendInputEvent` at the button) when the
 * page is on screen; the tool degrades to a synthetic DOM click otherwise, which the page tells
 * apart through `isTrusted`. The result's first line is the tool's headline, logged as before;
 * when the input was synthetic its second line names the cause (`input: synthetic – …`, the
 * core's `routeInput` note), and the result is then logged whole – that line is the diagnosis,
 * and main's boot smoke degraded twice with only the headline in the log. Returns whether the
 * page saw trusted input and, when it did not, the chrome the cause names as covering the page
 * (for `clickThroughXdotool` to dismiss), or null when it names none.
 */
async function clickThroughMcp() {
  mark('browser_click')
  const out = await tool('browser_click', { target: 'text=open' })
  const [headline, ...rest] = out.split('\n')
  log(`browser_click: ${headline}`)
  const value = await evaluate('window.__clickTrusted')
  if (value === true) return { trusted: true, cover: null }
  for (const line of rest) log(`  ${line}`)
  log(`  window.__clickTrusted after browser_click: ${JSON.stringify(value)}`)
  // DIAG round: dump what the renderer saw and its geometry, then observe whether a repeated
  // MCP click ever lands within a few seconds (a readiness race) or never does (a persistent
  // misroute). Observation only – `trusted` stays false so the xdotool path still runs.
  const diag = await evaluate(`(() => {
    const b = document.getElementById('open').getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const at = document.elementFromPoint(cx, cy);
    return { dpr: devicePixelRatio, sx: screenX, sy: screenY, iw: innerWidth, ih: innerHeight,
      ow: outerWidth, oh: outerHeight, rect: { l: b.left, t: b.top, w: b.width, h: b.height },
      cx, cy, at: at ? at.tagName.toLowerCase() + (at.id ? '#' + at.id : '') : null,
      hasFocus: document.hasFocus(), vis: document.visibilityState,
      moves: window.__moveCount, events: window.__events, now: Math.round(performance.now()),
      raf: { count: window.__rafCount, last: window.__rafLast },
      paint: performance.getEntriesByType('paint').map((e) => e.name + '@' + Math.round(e.startTime)) };
  })()`).catch((e) => ({ diagError: String(e) }))
  log(`  DIAG mcp geometry+events: ${JSON.stringify(diag)}`)
  for (let r = 1; r <= 5; r++) {
    await sleep(1000)
    await evaluate('(window.__clickTrusted = null, true)').catch(() => null)
    mark(`browser_click retry ${r}`)
    const retryOut = await tool('browser_click', { target: 'text=open' }).catch(
      (e) => `err ${e.message}`
    )
    const rHead = String(retryOut).split('\n')[0]
    const synth = /input: synthetic/.test(String(retryOut))
    const rv = await evaluate('window.__clickTrusted').catch(() => 'evalErr')
    const rs = await evaluate(
      `({ events: window.__events.length, moves: window.__moveCount, lastMove: window.__lastMove, active: navigator.userActivation.hasBeenActive, now: Math.round(performance.now()), raf: { count: window.__rafCount, last: window.__rafLast }, paint: performance.getEntriesByType('paint').length })`
    ).catch(() => '?')
    log(
      `  DIAG mcp retry ${r}: __clickTrusted=${JSON.stringify(rv)} synthetic=${synth} headline=${JSON.stringify(rHead)} page=${JSON.stringify(rs)}`
    )
    if (rv === true) break
  }
  for (const l of appLog.split('\n')) if (l.includes('[signin-diag]')) log(`  ${l}`)
  const cause = rest
    .map((line) => /^input: synthetic – (.*), so the event/.exec(line)?.[1])
    .find(Boolean)
  const cover = cause && /covers|in front|on screen/.test(cause) ? cause : null
  return { trusted: false, cover }
}

/** The page's view: its screen position, the button's centre in it, and what it can see of itself. */
const VIEW_EXPRESSION = `(() => {
  const r = document.getElementById('open').getBoundingClientRect()
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  const at = document.elementFromPoint(cx, cy)
  return {
    sx: screenX, sy: screenY, ow: outerWidth, oh: outerHeight, iw: innerWidth, ih: innerHeight,
    cx, cy, atCentre: at ? at.tagName.toLowerCase() + (at.id ? '#' + at.id : '') : null,
    focus: document.hasFocus(), vis: document.visibilityState,
    trusted: window.__clickTrusted, lastMove: window.__lastMove
  }
})()`

/**
 * A real pointer through X: the page's view is found by moving the pointer into the window
 * (`window.screenX/Y` and `outerWidth/Height` are the window's) until the page reports a
 * mousemove, whose screen and client coordinates give the view's origin; the button's centre
 * is then clicked at its screen position. `cover` is what the MCP click's cause named as
 * covering the page; it is dismissed first, and so is whatever keeps every probe from the page:
 * Escape – the URL bar overlay closes on it one stage at a time (its popup, then the bar; the
 * chrome's transient surfaces likewise) – then the probes again, up to three rounds, a trusted
 * mousemove reaching the page being the truth (the page's own `visibilityState` stays
 * `visible` under the chrome's picture of it). The synthetic click has run the button's handler
 * by then (`isTrusted` false, `window.open` blocked), so the page's flags are reset before the
 * pointer's click, or its answer would be the synthetic click's. A click the page does not
 * report as trusted is retried once after a fresh mousemove (away a few pixels, then back onto
 * the point, `--sync` both, so a motion event precedes the button press), and the log says what
 * the page saw after each: `__clickTrusted`'s value (null – no click reached the button; false –
 * the synthetic click's value survived), the element at the button's centre, the view's geometry
 * and the last trusted mousemove, the X pointer's window, the tab listing.
 */
async function clickThroughXdotool(cover) {
  const display = process.env.DISPLAY
  if (!display || !has('xdotool')) {
    log('xdotool gesture unavailable (no DISPLAY or xdotool)')
    return false
  }
  // `--sync` waits for the pointer's motion; the timeout keeps a wait that never ends (a pointer
  // X will not move) from wedging the smoke.
  const xdotool = (...args) =>
    execFileSync('xdotool', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
      .toString()
      .trim()
  await evaluate(
    '(window.__clickTrusted = null, window.__popupMessage = null, window.__popup = null, true)'
  )
  const geometry = await evaluate(VIEW_EXPRESSION)
  const calibrate = async () => {
    await evaluate('(window.__lastMove = null, true)')
    for (const [fx, fy] of [
      [0.6, 0.6],
      [0.75, 0.5],
      [0.5, 0.8],
      [0.9, 0.9]
    ]) {
      const x = Math.round(geometry.sx + geometry.ow * fx)
      const y = Math.round(geometry.sy + geometry.oh * fy)
      xdotool('mousemove', '--sync', String(x), String(y))
      const move = await waitFor('window.__lastMove', 1200)
      if (move && move.trusted) {
        const origin = { x: move.screenX - move.clientX, y: move.screenY - move.clientY }
        log(
          `xdotool: pointer at (${x}, ${y}) reached the page; view origin (${origin.x}, ${origin.y}) (${xdotool('getmouselocation')})`
        )
        return origin
      }
      log(
        `xdotool: pointer at (${x}, ${y}) did not reach the page (${xdotool('getmouselocation')}; lastMove ${JSON.stringify(move)})`
      )
    }
    return null
  }
  let origin = null
  for (let round = 1; round <= 3 && !origin; round++) {
    if (cover || round > 1) {
      log(
        round === 1
          ? `xdotool: the click's cause names chrome over the page (${cover}); Escape to dismiss it`
          : `xdotool: Escape (round ${round}: a surface may still cover the page), then the probes again`
      )
      xdotool('key', 'Escape')
      await sleep(600)
    }
    origin = await calibrate()
  }
  if (!origin) {
    log(
      `xdotool: no pointer movement reached the page (window at ${geometry.sx},${geometry.sy} ${geometry.ow}x${geometry.oh}, view ${geometry.iw}x${geometry.ih}, ${geometry.vis}, focus ${geometry.focus})`
    )
    return false
  }
  const x = Math.round(origin.x + geometry.cx)
  const y = Math.round(origin.y + geometry.cy)
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) {
      xdotool('mousemove', '--sync', String(x - 8), String(y - 8))
      await sleep(120)
    }
    xdotool('mousemove', '--sync', String(x), String(y))
    await sleep(120)
    mark(`xdotool click ${attempt}`)
    xdotool('click', '1')
    log(
      `xdotool: clicked at (${x}, ${y})${attempt === 2 ? ' – the retry, after a fresh mousemove' : ''}`
    )
    await sleep(400)
    const after = await evaluate(VIEW_EXPRESSION)
    if (after.trusted === true) return true
    const moved = after.lastMove
      ? `(${after.lastMove.screenX}, ${after.lastMove.screenY}) → client (${after.lastMove.clientX}, ${after.lastMove.clientY}), view origin (${after.lastMove.screenX - after.lastMove.clientX}, ${after.lastMove.screenY - after.lastMove.clientY})`
      : 'none'
    log(
      `xdotool: window.__clickTrusted after the click: ${JSON.stringify(after.trusted)} (null: no click reached the button; false: the synthetic click's value); at the button's centre: ${after.atCentre}; view ${after.iw}x${after.ih} at window ${after.sx},${after.sy} ${after.ow}x${after.oh}, ${after.vis}, focus ${after.focus}; last trusted mousemove ${moved}; pointer ${xdotool('getmouselocation')}`
    )
    log(`xdotool: ${await tabsListing()}`)
    // DIAG: what the renderer saw of the X click (the capture-phase trace), the X windows on
    // the display (geometry, map state, stacking) and the X focus window.
    const trace = await evaluate(
      `({ events: window.__events, moves: window.__moveCount, active: navigator.userActivation.hasBeenActive, now: Math.round(performance.now()), raf: { count: window.__rafCount, last: window.__rafLast }, paint: performance.getEntriesByType('paint').map((e) => e.name + '@' + Math.round(e.startTime)) })`
    ).catch((e) => String(e))
    log(`  DIAG page after X click: ${JSON.stringify(trace)}`)
    const x11 = (cmd, args) => {
      try {
        return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim()
      } catch (e) {
        return `${cmd} failed: ${e.message}`
      }
    }
    log(`  DIAG X focus: ${x11('xdotool', ['getwindowfocus', '-f'])}`)
    if (has('xwininfo')) {
      const tree = x11('xwininfo', ['-root', '-tree'])
        .split('\n')
        .filter((l) => /0x[0-9a-f]+/i.test(l))
        .slice(0, 60)
      for (const l of tree) log(`  DIAG xwininfo: ${l.trim()}`)
    }
  }
  return false
}

// --- failure artefacts -----------------------------------------------------------------------

async function tabsListing() {
  return tool('browser_tabs', {}).catch((error) => `browser_tabs failed: ${error.message}`)
}

function screenshot(path) {
  const display = process.env.DISPLAY
  if (!display || !has('ffmpeg')) return false
  let size = '1600x1000'
  if (has('xdpyinfo')) {
    const info = spawnSync('xdpyinfo', [], { encoding: 'utf8' }).stdout ?? ''
    const match = /dimensions:\s+(\d+x\d+)/.exec(info)
    if (match) size = match[1]
  }
  const result = spawnSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'x11grab',
      '-video_size',
      size,
      '-i',
      display,
      '-frames:v',
      '1',
      path
    ],
    { stdio: 'ignore' }
  )
  return result.status === 0
}

// --- DIAG: the browser's Chromium trace (temporary, W5-H) ------------------------------------

/**
 * The trace events that tell one input event's story and the renderer's rendering state around
 * it: the browser side's forward, the renderer compositor thread's "Input Suppressed" (with the
 * reason bits: DeferMainFrameUpdates, DeferCommits, HasNotPainted), the main-thread queue's
 * receipt (non-move events only), the acks; each renderer's deferral spans (`SetDeferCommits` –
 * paint holding until first contentful paint, `SetDeferMainFrameUpdate`) and frame-sink life;
 * the display compositor's visibility and skipped draws. Reading the spans: both are begin/end
 * pairs on one track per ProxyMain, paired LIFO by the exporter – `BeginLifecycleUpdates`
 * starts the commit deferral and ends the main-frame-update deferral within microseconds, so
 * the `e` right after a `b SetDeferCommits` is the main-frame-update deferral's end, and the
 * later `e SetDeferMainFrameUpdate` is the commit deferral's (first contentful paint, or the
 * 500 ms timeout – which Chromium 152 checks only inside a BeginMainFrame).
 */
const TRACE_NAMES = new Set([
  'Input Suppressed',
  'RenderWidgetHostImpl::ForwardMouseEvent',
  'MainThreadEventQueue::HandleEvent',
  'WidgetInputHandlerManager::DidHandleInputEventSentToMain',
  'WidgetInputHandlerManager::DidHandleInputEventSentToCompositor',
  'ProxyMain::SetDeferMainFrameUpdate',
  'ProxyMain::SetDeferCommits',
  'ProxyMain::SetPauseRendering',
  'ProxyMain::SetBeginFrameSourcePaused',
  'ProxyMain::SetVisible',
  'ProxyMain::DidInitializeLayerTreeFrameSink',
  'ProxyMain::RequestNewLayerTreeFrameSink',
  'ProxyMain::DidLoseLayerTreeFrameSink',
  'Display::SetVisible',
  'No output surface',
  'No root surface.',
  'Draw skipped.',
  'Skip draw'
])
/** Per process, per second since spawn: BeginMainFrames (a renderer's frames) and display draws. */
const TRACE_COUNTED = new Set([
  'ProxyMain::BeginMainFrame',
  'Display::DrawAndSwap',
  'MainFrameAborted'
])
const TRACE_WAIT_MS = 40_000
const TRACE_MAX_LINES = 600

/** Iterates the objects of the trace file's `traceEvents` array without parsing the whole file. */
function* traceObjects(buf) {
  let i = buf.indexOf('"traceEvents"')
  i = buf.indexOf('[', i === -1 ? 0 : i)
  if (i === -1) return
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (i++; i < buf.length; i++) {
    const c = buf[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === 0x5c) escaped = true
      else if (c === 0x22) inString = false
    } else if (c === 0x22) inString = true
    else if (c === 0x7b) {
      if (depth++ === 0) start = i
    } else if (c === 0x7d) {
      if (--depth === 0 && start !== -1) {
        yield buf.toString('utf8', start, i + 1)
        start = -1
      }
    } else if (c === 0x5d && depth === 0) return
  }
}

/**
 * Asks the browser (booted with `ZEN_INPUT_DIAG`) to stop the Chromium trace it has recorded
 * since boot, keeps it gzipped in `outDir`, and logs a digest: the process names, then the
 * events of `TRACE_NAMES` in time order (time since spawn; the harness's own moments – the
 * clicks – interleaved), then per-second counts of frames and draws per process.
 */
async function collectInputTrace() {
  if (!outDir || exited()) return
  const zenDir = join(config, 'Zenium', 'zen')
  const traceFile = join(zenDir, 'input-trace.json')
  const doneFile = `${traceFile}.done`
  const requestedAt = Date.now()
  writeFileSync(join(zenDir, 'input-diag-stop'), '')
  while (!existsSync(doneFile) && Date.now() - requestedAt < TRACE_WAIT_MS && !exited())
    await sleep(200)
  if (!existsSync(doneFile)) {
    log(`DIAG trace: not written within ${TRACE_WAIT_MS} ms (browser exited: ${exited()})`)
    return
  }
  const done = readFileSync(doneFile, 'utf8')
  if (done.startsWith('error:')) {
    log(`DIAG trace: ${done}`)
    return
  }
  const raw = readFileSync(traceFile)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'input-trace.json.gz'), gzipSync(raw, { level: 6 }))
  log(
    `DIAG trace: ${raw.length} bytes, stopped in ${Date.now() - requestedAt} ms → ${outDir}/input-trace.json.gz`
  )

  const names = new Map()
  const pagePids = new Set([...appLog.matchAll(/ospid=(\d+)/g)].map((m) => Number(m[1])))
  const events = []
  const counts = new Map()
  let minTs = Infinity
  let total = 0
  for (const text of traceObjects(raw)) {
    total++
    // The exporter writes keys sorted, so the event's own `"name"` is the last one in the text
    // (`args` – which may carry a `name` of its own – comes first).
    const nameAt = text.lastIndexOf('"name":"')
    if (nameAt === -1) continue
    const name = text.slice(nameAt + 8, text.indexOf('"', nameAt + 8))
    if (name === 'process_name') {
      const e = JSON.parse(text)
      names.set(e.pid, e.args?.name ?? '?')
      continue
    }
    const counted = TRACE_COUNTED.has(name)
    if (!counted && !TRACE_NAMES.has(name)) continue
    const e = JSON.parse(text)
    if (typeof e.ts !== 'number') continue
    if (e.ts < minTs) minTs = e.ts
    if (counted) {
      if (e.ph === 'E' || e.ph === 'e') continue
      const key = `${name}|${e.pid}`
      if (!counts.has(key)) counts.set(key, { name, pid: e.pid, seconds: [] })
      counts.get(key).seconds.push(e.ts)
      continue
    }
    // Moves (exported as the enum's name, `kMouseMove`; 2 as a number) are the noise here.
    if (
      name === 'MainThreadEventQueue::HandleEvent' &&
      (e.args?.event_type === 2 || /Move/.test(String(e.args?.event_type)))
    )
      continue
    events.push({ ts: e.ts, pid: e.pid, ph: e.ph, name, args: e.args })
  }
  // Time since spawn when the trace is on the harness's clock (CLOCK_MONOTONIC); else since the
  // earliest event of interest.
  const onOurClock = minTs > spawnMono - 2_000_000 && minTs < spawnMono + 120_000_000
  const t0 = onOurClock ? spawnMono : minTs
  const rel = (ts) => `+${((ts - t0) / 1e6).toFixed(3)}s`
  const who = (pid) =>
    `pid ${pid} ${names.get(pid) ?? '?'}${pagePids.has(pid) ? ' (page renderer)' : ''}`
  log(
    `DIAG trace: ${total} events; ${events.length} of interest; clock ${onOurClock ? 'shared with the harness (times since spawn)' : 'not the harness’s (times since the first event of interest)'}; processes ${JSON.stringify([...names].map(([pid, name]) => `${pid}:${name}`))}; page renderer pid(s) ${JSON.stringify([...pagePids])}`
  )
  const timeline = [
    ...events.map((e) => ({
      ts: e.ts,
      text: `${rel(e.ts)} ${who(e.pid)} ${e.ph} ${e.name} ${e.args ? JSON.stringify(e.args) : ''}`
    })),
    ...(onOurClock
      ? marks.map((m) => ({ ts: m.at, text: `${rel(m.at)} --- harness: ${m.what}` }))
      : [])
  ].sort((a, b) => a.ts - b.ts)
  let printed = 0
  let last = null
  let repeats = 0
  const flush = () => {
    if (last && repeats > 0)
      log(`  DIAG trace   … ×${repeats} more (same process, event and args within the second)`)
    repeats = 0
  }
  for (const item of timeline) {
    const sameAsLast =
      last &&
      item.text.slice(item.text.indexOf(' ')) === last.text.slice(last.text.indexOf(' ')) &&
      item.ts - last.ts < 1_000_000
    if (sameAsLast) {
      repeats++
      continue
    }
    flush()
    last = item
    if (printed++ < TRACE_MAX_LINES) log(`  DIAG trace ${item.text}`)
  }
  flush()
  if (printed > TRACE_MAX_LINES)
    log(`  DIAG trace: ${printed - TRACE_MAX_LINES} more lines not shown`)
  for (const { name, pid, seconds } of [...counts.values()].sort((a, b) => a.pid - b.pid)) {
    const perSecond = []
    for (const ts of seconds) {
      const s = Math.floor((ts - t0) / 1e6)
      if (s >= 0 && s < 120) perSecond[s] = (perSecond[s] ?? 0) + 1
    }
    const span = Math.max(perSecond.length, 1)
    const cells = Array.from({ length: span }, (_, s) => perSecond[s] ?? 0)
    log(
      `  DIAG trace ${name} per second, ${who(pid)}: ${cells.join(' ')} (total ${seconds.length})`
    )
  }
}

// --- the checks ------------------------------------------------------------------------------

let exitCode = 1
try {
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'zenium-smoke', version: '1' }
  })
  await tool('zen_mode', { mode: 'foreground' })
  await tool('browser_navigate', { url: siteUrl })
  await waitFor(`document.readyState === 'complete'`, 15_000)

  const page = await evaluate(`({
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    chrome: typeof window.chrome,
    chromeApp: typeof (window.chrome && window.chrome.app),
    chromeCsi: typeof (window.chrome && window.chrome.csi),
    chromeLoadTimes: typeof (window.chrome && window.chrome.loadTimes),
    fedcm: 'IdentityCredential' in window,
    brands: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand) : null
  })`)
  check('navigator.webdriver is false', page.webdriver === false, String(page.webdriver))
  check(
    'window.chrome has app, csi and loadTimes',
    page.chromeApp === 'object' &&
      page.chromeCsi === 'function' &&
      page.chromeLoadTimes === 'function',
    `${page.chrome}: app=${page.chromeApp} csi=${page.chromeCsi} loadTimes=${page.chromeLoadTimes}`
  )
  check(
    'user agent is Chrome’s reduced string',
    / Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(page.ua) && !/Electron|Zenium/i.test(page.ua),
    page.ua
  )
  check('FedCM is not exposed', page.fedcm === false, `IdentityCredential in window: ${page.fedcm}`)
  check(
    'client hint brands name Chromium',
    Array.isArray(page.brands) && page.brands.includes('Chromium'),
    JSON.stringify(page.brands)
  )

  const document = requests.find((r) => r.url === '/' && r.headers['sec-fetch-dest'] === 'document')
  const h = document?.headers ?? {}
  check(
    'document request carries the low-entropy client hints',
    Boolean(h['sec-ch-ua'] && h['sec-ch-ua-mobile'] && h['sec-ch-ua-platform']),
    `sec-ch-ua=${h['sec-ch-ua']} mobile=${h['sec-ch-ua-mobile']} platform=${h['sec-ch-ua-platform']}`
  )
  // `en-US,en;q=0.9`: a region variant followed by its base language, q-values, and nothing
  // that is not a language tag (a runner's POSIX `C` locale must not leak into it).
  const languages = (h['accept-language'] ?? '').split(',').map((part) => part.split(';')[0])
  check(
    'document request sends Chrome’s Accept-Language',
    languages.length >= 2 &&
      /;q=/.test(h['accept-language'] ?? '') &&
      languages.every((tag) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)),
    h['accept-language']
  )
  check('document request user agent equals navigator.userAgent', h['user-agent'] === page.ua)

  // The pop-up: a gesture on a page that is on screen, then the blocker's answer.
  const onScreenAt = Date.now()
  const onScreen = await waitOnScreen()
  check(
    'page is on screen (view visible and laid out)',
    Boolean(onScreen),
    onScreen
      ? `${onScreen.w}x${onScreen.h} after ${Date.now() - onScreenAt} ms`
      : `still hidden after ${ON_SCREEN_TIMEOUT_MS} ms; ${await tabsListing()}`
  )
  let gesture = 'none'
  let trusted = false
  let cover = null
  if (gestureMode !== 'xdotool') {
    const mcp = await clickThroughMcp()
    trusted = mcp.trusted
    cover = mcp.cover
    gesture = trusted
      ? 'browser_click (sendInputEvent)'
      : 'browser_click degraded to a synthetic click'
  }
  if (!trusted) {
    if (await clickThroughXdotool(cover)) {
      trusted = true
      gesture = gestureMode === 'xdotool' ? 'xdotool' : `${gesture}; xdotool`
    } else if (gestureMode === 'xdotool') gesture = 'xdotool failed'
  }
  check('the gesture reached the page as trusted input', trusted, gesture)
  // DIAG round (always, pass or fail): the input path the product took and the view bounds it
  // dispatched into, plus the page's geometry – so a green run establishes the baseline against
  // which a red run's `path=`/`viewBounds=` are read.
  {
    const g = await evaluate(
      `({ dpr: devicePixelRatio, sx: screenX, sy: screenY, iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight })`
    ).catch((e) => String(e))
    log(`DIAG geometry: ${JSON.stringify(g)}; onScreen ${JSON.stringify(onScreen)}`)
    for (const l of appLog.split('\n')) if (l.includes('[signin-diag]')) log(l)
  }

  const popup =
    (await waitFor(
      `window.__popupMessage && ({ message: window.__popupMessage, handle: Boolean(window.__popup), closed: window.__popup ? window.__popup.closed : null })`,
      POPUP_TIMEOUT_MS
    )) ??
    (await evaluate(
      `({ message: window.__popupMessage, handle: Boolean(window.__popup), closed: window.__popup ? window.__popup.closed : null })`
    ))
  check('window.open returned a handle', popup.handle === true && popup.closed === false)
  check(
    'pop-up kept its opener and its postMessage arrived',
    popup.message?.from === 'popup' && popup.message?.opener === true,
    JSON.stringify(popup.message)
  )
  check(
    'pop-up document runs the page preload (chrome.app present)',
    popup.message?.chromeApp === 'object',
    `chrome.app in popup: ${popup.message?.chromeApp}`
  )
  const jsErrors = appLog.split('\n').filter((l) => /Uncaught|TypeError|ReferenceError/.test(l))
  check('no JavaScript errors in the browser log', jsErrors.length === 0, jsErrors.join(' | '))
  exitCode = failures.length === 0 ? 0 : 1
  if (exitCode !== 0 && outDir) {
    mkdirSync(outDir, { recursive: true })
    if (screenshot(join(outDir, 'signin-smoke-screen.png')))
      log(`screenshot: ${outDir}/signin-smoke-screen.png`)
    log(await tabsListing())
  }
} catch (error) {
  console.error('smoke test failed:', error)
  console.error(appLog)
  lines.push(`smoke test failed: ${error?.stack ?? error}`)
} finally {
  // The browser process first – SIGTERM, five seconds, then SIGKILL, and its exit is waited for
  // either way – then the profile. Chromium's helpers (the network service, the GPU process)
  // flush into `Partitions/zen-default` for a moment after the browser process is gone, which is
  // what a plain rmSync met on #392's run (ENOTEMPTY, every check passed): removeTree repeats
  // the pass until the tree is gone. A profile that stays after five seconds of that is logged
  // and left in the temp dir; the checks decide the exit code.
  // DIAG (temporary): the browser's trace first, while it is still alive.
  try {
    await collectInputTrace()
  } catch (error) {
    log(`DIAG trace: failed: ${error?.stack ?? error}`)
  }
  app.kill('SIGTERM')
  await waitForExit(5000)
  if (!exited()) {
    app.kill('SIGKILL')
    await waitForExit(2000)
  }
  site.close()
  try {
    const pass = await removeTree(config)
    if (pass > 1) log(`profile removed on pass ${pass} (a helper was still writing into it)`)
  } catch (error) {
    log(`teardown: the profile ${config} could not be removed: ${error?.message ?? error}`)
  }
}
const summary = `${passes.length} passed, ${failures.length} failed`
console.log(`\n${summary}`)
if (outDir) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    join(outDir, 'signin-smoke.log'),
    [...lines, summary, '', '--- zenium output ---', appLog].join('\n')
  )
}
process.exit(exitCode)
