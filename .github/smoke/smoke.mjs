// Zenium desktop boot smoke: launches a packaged build with Playwright for Electron, walks through
// the shortcuts and window behaviour a first-time user hits, records every JS error, crash and
// blocking dialog, takes OS-level screenshots at each step and writes one JSON result per step.
//
//   node smoke.mjs --exe <executable> --label <name> --out <dir>
//        [--scenarios boot,restore,walkthrough,crash,clear-on-exit,scale,dark]
//        [--extra-args="--no-sandbox --disable-gpu"]   (space-separated, passed to the app)
//        [--allowlist known-failures.json] [--render-budget-ms 10000]
//        [--first-launch-render-budget-ms 20000] [--quit-budget-ms 15000]
//        [--step-timeout-ms 60000] [--evaluate-timeout-ms 30000] [--watchdog-min 15]
//
// Scenarios (each one launch of the executable, on profiles under one temporary root; the pages
// they load come from boot-fixture.mjs's server on 127.0.0.1, started once per run, so a run
// needs no internet):
//   boot         first launch: onboarding (on screen – in the DOM and painted – within the
//                first-launch render budget, then clicked through with the same budget), one
//                visible window titled Zenium, a tab on the fixture's first page opened through
//                the URL bar, a graceful quit (the preset's chord, "Quit Zenium?" answered when
//                several tabs are open) that leaves `cleanExit: true` in the profile
//   restore      the profile from `boot` comes back with its tab loaded, no onboarding and no
//                "Restore pages?" bar (skipped, like `crash`, when boot's launch or onboarding
//                failed: that profile is not past onboarding; scenario-deps.mjs)
//   walkthrough  the Chrome-preset shortcuts (#126) on a fresh profile past onboarding: Ctrl+T,
//                Ctrl+F (the field takes the keyboard, Escape closes the bar and hands it back to
//                the page), Ctrl+plus/minus/0 with the zoom bubble, F11, Ctrl+N, Ctrl+Shift+N,
//                Ctrl+H, Ctrl+Shift+O, Settings from the toolbar menu, the page context menu, a
//                second instance handing its URL over, Ctrl+Shift+W's "Close N tabs?" cancelled,
//                Ctrl+W, a pop-up opened by a real click on a button inside a cross-origin iframe
//                (a local fixture: the frame's gesture reaches the pop-up blocker, the pop-up is
//                a toolbar-only window that keeps its opener, its page runs the page preload –
//                Chrome's `chrome.app`, Zenium's tab-modal `alert` – and closes itself; #142),
//                then "Quit Zenium?" (#129); Escape between steps (Linux job)
//   crash        the profile from `boot`, killed while it runs (`cleanExit: false` stays behind);
//                the next launch lists the tabs unloaded and offers "Restore pages?", Restore
//                loads the page again, the run quits cleanly (Linux job; two launches: crash and
//                crash-restore)
//   clear-on-exit  clear browsing data on exit (#310), on the local fixture's cookie page. The
//                quit run: a profile seeded with privacy.clearOnExit = cookies + cache sets the
//                fixture's cookie, quits (the run happens once the quit is agreed, ahead of the
//                final write) within the budget, cleanExit: true, no owed marker in sitedata.json;
//                the relaunch restores the page and the cookie is gone (the wire, the page, the
//                jar). The owed clear at launch: a profile without clear-on-exit sets the cookie
//                and quits (the jar's file names it), the marker is written into sitedata.json by
//                hand, the launch consumes it (the field null) and the cookie is gone (Linux job;
//                four launches: clear-on-exit, clear-on-exit-relaunch, clear-on-exit-owed-seed,
//                clear-on-exit-owed-launch)
//   scale        --force-device-scale-factor=1.5 renders at devicePixelRatio 1.5
//   dark         OS dark mode (or nativeTheme where the OS has no switch) reaches the chrome
//
// Windows and macOS run boot, restore, scale and dark (the installed Windows build boot and
// restore); the walkthrough, the crash pair and clear-on-exit run on Linux under Xvfb only.
//
// Zero tolerated JS errors: a chrome console error, a chrome page error, a preload or Electron-side
// error in a tab view, a main-process exception, a crashed process, a blocking native dialog or a
// failed step is a "failure". Failures matching .github/smoke/known-failures.json are reported by
// their bug id and tolerated; anything else makes the run exit 1. Console errors logged by the web
// pages themselves (http(s)://…, the fixture's included) are recorded but never gate. A failed
// step also grabs the screen as it was (<scenario>-<step>-failed.png, named in the failure).
//
// Exit codes: 0 pass (only known failures, if any), 1 unexpected failures, 2 usage, 3 watchdog.

import { _electron as electron } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIND_MATCHES, FIND_WORD, isWebPage, startBootFixture } from './boot-fixture.mjs'
import { classifyFailures, formatFailure, loadKnownFailures } from './known-failures.mjs'
import {
  COOKIE_PATH,
  FIXTURE_COOKIE,
  buttonScreenPoint,
  startPopupFixture
} from './popup-fixture.mjs'
import { retryDetail, waitForTabWithRetry } from './navigation.mjs'
import { exitWithin, mainProcessState, unlessTargetClosed } from './quit.mjs'
import { skipReason, skippedEntries } from './scenario-deps.mjs'
import {
  SITE_DATA_FILE,
  cookieRequests,
  owedClear,
  owedClearOf,
  sessionClearsSince,
  withOwedClear
} from './site-data.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const IS_LINUX = process.platform === 'linux'
const ACCEL = IS_MAC ? 'Meta' : 'Control'
// The Chrome shortcut preset is the default (#126): Chrome's chords on every platform.
const QUIT_COMBO = IS_MAC ? 'Meta+q' : 'Control+Shift+q'
const PRIVATE_WINDOW_COMBO = `${ACCEL}+Shift+n`
const FULLSCREEN_COMBO = IS_MAC ? 'Control+Meta+f' : 'F11'

const opts = parseArgs(process.argv.slice(2))
if (!opts.exe || !opts.label || !opts.out) {
  console.error('usage: node smoke.mjs --exe <exe> --label <label> --out <dir> [--scenarios a,b]')
  process.exit(2)
}
const outDir = path.resolve(opts.out, opts.label)
fs.mkdirSync(outDir, { recursive: true })
const scenarios = String(opts.scenarios ?? 'boot,restore')
  .split(',')
  .filter(Boolean)
const EXTRA_ARGS =
  typeof opts['extra-args'] === 'string' ? opts['extra-args'].split(' ').filter(Boolean) : []
const RENDER_BUDGET_MS = Number(opts['render-budget-ms'] ?? 10000)
// The first time this run launches the executable is a cold launch: the build was packaged (or
// installed) moments ago and nothing has mapped its pages yet. On macos-15-intel that first
// paint took 10.4 s and 12.5 s (#165's first run, main at 36e0ae1) against 1.5–6 s for every
// launch after it, so the first launch has its own bound. The warm one stays at 10 s: a
// regression in what the chrome does before its first paint still shows on every later launch.
const FIRST_LAUNCH_RENDER_BUDGET_MS = Number(opts['first-launch-render-budget-ms'] ?? 20000)
// The longest a launch waits for the chrome page at all; past it the launch step fails outright.
const RENDER_WAIT_MS = Math.max(RENDER_BUDGET_MS, FIRST_LAUNCH_RENDER_BUDGET_MS) * 3
// From the quit chord (or the Quit button) to the process's exit event. The app itself quits
// within a second; the rest is Electron's teardown after the last window closes, which took 6 s
// on windows-11-arm (#148, #157) against the 5 s this used to be. Only a process still alive
// when the budget runs out is a failure.
const QUIT_BUDGET_MS = Number(opts['quit-budget-ms'] ?? 15000)
const STEP_TIMEOUT_MS = Number(opts['step-timeout-ms'] ?? 60000)
const EVALUATE_TIMEOUT_MS = Number(opts['evaluate-timeout-ms'] ?? 30000)
// Budget for a click on a button the chrome has just painted for the first time (the
// crash-restore bar). Playwright waits for the button to be actionable; on a busy runner that
// took 5.1 s on one green run and 8 s on a red one, so 5 s is a margin, not a check. What the
// wait is for: the button has to hold still across two animation frames, and a chrome page whose
// window has no frames yet runs none (see Session.waitForFrames). The onboarding's clicks, on the
// run's cold launch, first wait for the frames and then click within the launch's render budget.
const FIRST_PAINT_CLICK_MS = Number(opts['first-paint-click-ms'] ?? 15000)
const WATCHDOG_MS = Number(opts['watchdog-min'] ?? 15) * 60 * 1000
const allowlistFile = path.resolve(opts.allowlist ?? path.join(here, 'known-failures.json'))

// Every scenario gets a profile under one temporary root; nothing touches the runner's real
// profile. Linux additionally isolates the XDG directories Electron derives appData from.
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zenium-smoke-${opts.label}-`))
const isolationEnv = IS_LINUX
  ? {
      XDG_CONFIG_HOME: path.join(profileRoot, 'xdg-config'),
      XDG_CACHE_HOME: path.join(profileRoot, 'xdg-cache'),
      XDG_DATA_HOME: path.join(profileRoot, 'xdg-data')
    }
  : {}
for (const dir of Object.values(isolationEnv)) fs.mkdirSync(dir, { recursive: true })

const context = { platform: process.platform, arch: process.arch, label: opts.label }
const result = {
  label: opts.label,
  exe: opts.exe,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  startedAt: new Date().toISOString(),
  budgets: {
    renderMs: RENDER_BUDGET_MS,
    firstLaunchRenderMs: FIRST_LAUNCH_RENDER_BUDGET_MS,
    quitMs: QUIT_BUDGET_MS
  },
  scenarios: {},
  screenshots: [],
  failures: [],
  verdict: null
}
const logFile = path.join(outDir, 'smoke.log')
fs.writeFileSync(logFile, '')
let currentSession = null
let shotIndex = 0
let displaySize = null
let launchesSoFar = 0

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------

/** `--key value`, `--key=value` (the form for values that start with `--`) and bare `--flag`. */
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

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try {
    fs.appendFileSync(logFile, line + '\n')
  } catch {
    // best effort
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** Evaluated in a page: resolves once two animation frames have run, i.e. the page is painting. */
const twoAnimationFrames = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))

/** Poll `fn` until it returns a truthy value; throws with `what` when the deadline passes. */
async function waitFor(fn, timeoutMs, what, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await fn()
    if (last) return last
    if (Date.now() >= deadline) break
    await delay(intervalMs)
  }
  throw new Error(`${what} (not within ${timeoutMs} ms; last value ${JSON.stringify(last)})`)
}

function sh(cmd, args, timeout = 60000, extra = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout, ...extra })
  return {
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    error: res.error ? String(res.error.message) : undefined
  }
}

function ps(scriptName, args, timeout = 60000) {
  return sh(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(here, scriptName),
      ...args
    ],
    timeout,
    { windowsHide: true }
  )
}

function osascript(script, timeout = 30000) {
  return sh('osascript', ['-e', script], timeout)
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function realPath(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

function killAppProcesses() {
  if (IS_WIN) sh('taskkill', ['/F', '/IM', path.basename(opts.exe), '/T'], 20000)
  else sh('pkill', ['-9', '-f', `^${escapeRegExp(opts.exe)}( |$)`], 20000)
}

// ---------------------------------------------------------------------------------------------
// OS-level screenshots: tab pages are WebContentsViews, so page.screenshot() would only show the
// chrome layer. Linux grabs the Xvfb screen with ffmpeg, Windows copies the screen through GDI,
// macOS uses screencapture.
// ---------------------------------------------------------------------------------------------

function linuxDisplaySize() {
  if (displaySize) return displaySize
  const r = sh('xdpyinfo', [], 10000)
  const m = /dimensions:\s+(\d+)x(\d+)/.exec(r.stdout)
  displaySize = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1600, height: 1000 }
  return displaySize
}

function osScreenshot(file) {
  if (IS_LINUX) {
    const { width, height } = linuxDisplaySize()
    return sh(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'x11grab',
        '-video_size',
        `${width}x${height}`,
        '-i',
        process.env.DISPLAY || ':0',
        '-frames:v',
        '1',
        file
      ],
      30000
    )
  }
  if (IS_WIN) return ps('win-screenshot.ps1', ['-Path', file], 45000)
  if (IS_MAC) return sh('screencapture', ['-x', file], 45000)
  return { status: 1, stderr: 'unsupported platform' }
}

/** The screen as it is right now: no bring-to-front, no settle (the app may be gone or stuck). */
function grabScreen(name) {
  const file = path.join(outDir, `${String(++shotIndex).padStart(2, '0')}-${name}.png`)
  const r = osScreenshot(file)
  const ok = fs.existsSync(file) && fs.statSync(file).size > 0
  if (!ok) log(`screenshot ${name} failed: ${r.stderr || r.stdout || r.error || 'no file'}`)
  result.screenshots.push({ name, file: path.basename(file), ok })
  return { file: path.basename(file), ok }
}

async function shot(name, session = null) {
  if (session) {
    await session.bringToFront().catch(() => undefined)
    await session.settle().catch(() => undefined)
  }
  return grabScreen(name).file
}

// ---------------------------------------------------------------------------------------------
// Main-process hook. Runs inside the Electron main process through Playwright's Node inspector,
// so it can only use what it receives as arguments. It streams every observation as one JSON line
// to `options.eventsFile` (or, without fs access, to stderr prefixed SMOKE_EVENT), which survives
// the process exiting mid-quit; the harness reads the file, never main-process memory.
// ---------------------------------------------------------------------------------------------

function hookMain({ app, webContents, BrowserWindow, Menu, dialog, session }, options) {
  const g = globalThis
  if (g.__smoke) return { hooked: false, reason: 'already hooked' }
  let fsModule = null
  try {
    fsModule =
      process.mainModule && process.mainModule.require ? process.mainModule.require('fs') : null
  } catch {
    fsModule = null
  }
  if (!fsModule) {
    try {
      fsModule = typeof globalThis.require === 'function' ? globalThis.require('fs') : null
    } catch {
      fsModule = null
    }
  }
  const smoke = {
    menus: [],
    dialogs: [],
    autoCloseMenuMs: 0,
    autoPickMenuItem: null,
    quitting: false,
    transport: fsModule ? 'file' : 'stderr'
  }
  g.__smoke = smoke
  const safe = (fn, fallback = null) => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  const clip = (v, n = 4000) => String(v ?? '').slice(0, n)
  const emit = (e) => {
    const line = JSON.stringify({ t: Date.now(), quitting: smoke.quitting, ...e })
    try {
      if (fsModule) fsModule.appendFileSync(options.eventsFile, line + '\n')
      else process.stderr.write(`SMOKE_EVENT ${line}\n`)
    } catch {
      // nothing left to report to
    }
  }
  const isChrome = (wc) =>
    BrowserWindow.getAllWindows().some((w) => safe(() => w.webContents.id === wc.id, false))

  const hook = (wc) => {
    if (!wc || wc.__smokeHooked) return
    wc.__smokeHooked = true
    wc.on('console-message', (event, level, message, line, sourceId) => {
      const d =
        event && typeof event === 'object' && 'message' in event
          ? event
          : { level, message, lineNumber: line, sourceId }
      emit({
        type: 'console',
        wc: wc.id,
        chrome: isChrome(wc),
        url: safe(() => wc.getURL(), ''),
        level: d.level,
        message: clip(d.message),
        sourceId: d.sourceId,
        line: d.lineNumber
      })
    })
    wc.on('render-process-gone', (_e, details) =>
      emit({
        type: 'render-process-gone',
        wc: wc.id,
        chrome: isChrome(wc),
        url: safe(() => wc.getURL(), ''),
        ...details
      })
    )
    wc.on('unresponsive', () =>
      emit({ type: 'unresponsive', wc: wc.id, url: safe(() => wc.getURL(), '') })
    )
    wc.on('did-fail-load', (_e, code, desc, url, isMain) =>
      emit({ type: 'did-fail-load', wc: wc.id, code, desc, url, isMain })
    )
    wc.on('preload-error', (_e, preloadPath, err) =>
      emit({
        type: 'preload-error',
        wc: wc.id,
        preloadPath,
        message: clip((err && (err.stack || err.message)) || err)
      })
    )
    // The page script's gesture reports and blocked pop-ups, timed: what the pop-up step reads
    // when a window.open was refused (did the frame's gesture reach the app, and before the ask?).
    wc.on('ipc-message', (event, channel, message) => {
      const kind = message && typeof message === 'object' ? message.type : undefined
      if (channel !== 'zen:page' || (kind !== 'activation' && kind !== 'popup-blocked')) return
      emit({
        type: 'page-message',
        wc: wc.id,
        frame: safe(() => event.senderFrame && event.senderFrame.url, null),
        message: kind,
        url: kind === 'popup-blocked' ? clip(message.url, 500) : undefined
      })
    })
  }
  webContents.getAllWebContents().forEach(hook)
  app.on('web-contents-created', (_e, wc) => hook(wc))
  // Every window.open the app's handler answers from now on (pages wired after the hook), with
  // its verdict: read alongside the page-message events when the pop-up step fails.
  const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0] || {})
  if (proto && typeof proto.setWindowOpenHandler === 'function' && !proto.__smokeWrapped) {
    const origSetHandler = proto.setWindowOpenHandler
    proto.setWindowOpenHandler = function (handler) {
      return origSetHandler.call(this, (details) => {
        const verdict = handler(details)
        emit({
          type: 'window-open',
          wc: this.id,
          url: clip(details && details.url, 500),
          disposition: details && details.disposition,
          action: verdict && verdict.action
        })
        // The app's `createWindow` (the adopted guest goes into a Zenium window): whether it ran
        // and what it made of the guest, or the exception that stopped it.
        if (verdict && typeof verdict.createWindow === 'function') {
          const create = verdict.createWindow
          verdict.createWindow = (options) => {
            const guest = options && options.webContents
            try {
              const made = create(options)
              emit({
                type: 'create-window',
                wc: this.id,
                guest: guest ? guest.id : null,
                made: made ? made.id : null,
                windows: BrowserWindow.getAllWindows().length
              })
              return made
            } catch (err) {
              emit({
                type: 'create-window',
                wc: this.id,
                guest: guest ? guest.id : null,
                error: clip((err && err.stack) || err)
              })
              throw err
            }
          }
        }
        return verdict
      })
    }
    proto.__smokeWrapped = true
  }
  // The engine's clears, timed: "clear browsing data" ends in `session.clearStorageData`,
  // `clearCache` and `clearCodeCaches` (src/main/platform/sessions.ts), so the clear-on-exit
  // scenario reads from these whether a run happened, on which partition and how long the engine
  // took. The methods sit on the Session prototype (gin's constructible classes fill it); the
  // wrap is recorded in the hook result, so a build where they moved fails the step in words.
  const sessionProto = safe(() => Object.getPrototypeOf(session.defaultSession), null)
  const sessionClears = []
  if (sessionProto && !sessionProto.__smokeWrapped) {
    for (const name of ['clearStorageData', 'clearCache', 'clearCodeCaches']) {
      const orig = sessionProto[name]
      if (typeof orig !== 'function') continue
      sessionProto[name] = function (...args) {
        const t0 = Date.now()
        const storagePath = safe(() => this.storagePath, null)
        const opt = args[0] && typeof args[0] === 'object' ? args[0] : undefined
        const outcome = orig.apply(this, args)
        Promise.resolve(outcome).then(
          () =>
            emit({
              type: 'session-clear',
              method: name,
              storagePath,
              options: opt,
              ok: true,
              ms: Date.now() - t0
            }),
          (err) =>
            emit({
              type: 'session-clear',
              method: name,
              storagePath,
              options: opt,
              ok: false,
              error: clip((err && err.message) || err),
              ms: Date.now() - t0
            })
        )
        return outcome
      }
      sessionClears.push(name)
    }
    sessionProto.__smokeWrapped = true
  }
  app.on('browser-window-created', (_e, w) =>
    emit({ type: 'window-created', window: w.id, windows: BrowserWindow.getAllWindows().length })
  )
  app.on('child-process-gone', (_e, details) => emit({ type: 'child-process-gone', ...details }))
  app.on('before-quit', () => {
    smoke.quitting = true
    emit({ type: 'before-quit' })
  })
  // A second listener makes Electron skip its modal "A JavaScript error occurred in the main
  // process" box; the exception is recorded (and gated) instead of blocking the run.
  process.on('uncaughtException', (err) =>
    emit({ type: 'main-uncaught-exception', message: clip((err && err.stack) || err) })
  )
  process.on('unhandledRejection', (reason) =>
    emit({ type: 'main-unhandled-rejection', message: clip((reason && reason.stack) || reason) })
  )

  // Native popup menus (page context menu, the toolbar "Menu" button) would wait for a real user:
  // record their items, close them after a delay, or pick one item by label for the harness.
  const describe = (items) =>
    (items || []).map((i) => ({
      label: i.label,
      type: i.type,
      role: i.role,
      enabled: i.enabled,
      submenu: i.submenu ? describe(i.submenu.items) : undefined
    }))
  const findItem = (items, label) => {
    for (const i of items || []) {
      if (i.label === label) return i
      const sub = i.submenu ? findItem(i.submenu.items, label) : null
      if (sub) return sub
    }
    return null
  }
  const origPopup = Menu.prototype.popup
  Menu.prototype.popup = function (popupOptions) {
    const entry = { t: Date.now(), items: describe(this.items), closed: false, picked: null }
    smoke.menus.push(entry)
    emit({ type: 'menu-popup', labels: entry.items.map((i) => i.label || i.type || i.role) })
    const pick = smoke.autoPickMenuItem
    if (pick) {
      smoke.autoPickMenuItem = null
      const item = findItem(this.items, pick)
      setTimeout(() => {
        try {
          this.closePopup()
          entry.closed = true
        } catch (e) {
          entry.closeError = String(e && e.message)
        }
        if (!item) entry.pickError = `no menu item labelled ${pick}`
        else {
          try {
            item.click(undefined, BrowserWindow.getFocusedWindow() || undefined, undefined)
            entry.picked = pick
          } catch (e) {
            entry.pickError = String(e && e.message)
          }
        }
      }, 150)
    } else if (smoke.autoCloseMenuMs > 0) {
      setTimeout(() => {
        try {
          this.closePopup()
          entry.closed = true
        } catch (e) {
          entry.closeError = String(e && e.message)
        }
      }, smoke.autoCloseMenuMs)
    }
    return origPopup.call(this, popupOptions)
  }

  // Nobody is there to answer a native dialog: record it as a failure and answer it.
  const wrapDialog = (name, kind) => {
    const orig = dialog[name]
    if (typeof orig !== 'function') return
    dialog[name] = function (...args) {
      const o =
        args.find((a) => a && typeof a === 'object' && !('id' in a && 'webContents' in a)) || {}
      const strings = args.filter((a) => typeof a === 'string')
      const entry = {
        t: Date.now(),
        method: name,
        message: o.message ?? o.title ?? strings[0],
        detail: o.detail ?? strings[1],
        buttons: o.buttons
      }
      smoke.dialogs.push(entry)
      emit({ type: 'dialog', ...entry })
      if (kind === 'message-sync') return 0
      if (kind === 'message') return Promise.resolve({ response: 0, checkboxChecked: false })
      if (kind === 'file-sync') return undefined
      if (kind === 'file') return Promise.resolve({ canceled: true, filePaths: [], filePath: '' })
      return undefined
    }
  }
  wrapDialog('showMessageBox', 'message')
  wrapDialog('showMessageBoxSync', 'message-sync')
  wrapDialog('showErrorBox', 'error')
  wrapDialog('showOpenDialog', 'file')
  wrapDialog('showOpenDialogSync', 'file-sync')
  wrapDialog('showSaveDialog', 'file')
  wrapDialog('showSaveDialogSync', 'file-sync')
  return { hooked: true, transport: smoke.transport, sessionClears }
}

// ---------------------------------------------------------------------------------------------
// Event classification: every hook event that counts as a failure becomes a failure record
// (kind, message, source) the allowlist can match.
// ---------------------------------------------------------------------------------------------

const ERROR_LEVELS = new Set(['error', 3])
const INTERNAL_SOURCE = /electron\/js2c|sandbox_bundle|sandboxed_renderer|preload|node:electron/i
const INTERNAL_URL = /^(zen:|about:blank|file:|chrome-error:|devtools:|$)/
const CLEAN_REASONS = new Set(['clean-exit'])

function failureFromEvent(e, scenario) {
  const base = { scenario, at: e.t, quitting: Boolean(e.quitting) }
  switch (e.type) {
    case 'console': {
      if (!ERROR_LEVELS.has(e.level)) return null
      const source = [e.sourceId, e.line].filter((v) => v !== undefined && v !== '').join(':')
      if (e.chrome)
        return { ...base, kind: 'chrome-console-error', message: e.message, source, url: e.url }
      if (INTERNAL_SOURCE.test(e.sourceId || '') || INTERNAL_URL.test(e.url || '')) {
        return { ...base, kind: 'view-console-error', message: e.message, source, url: e.url }
      }
      // A web page's own console error: recorded (info) but not gated.
      return {
        ...base,
        kind: 'page-console-error',
        message: e.message,
        source,
        url: e.url,
        info: true
      }
    }
    case 'render-process-gone':
    case 'child-process-gone': {
      if (CLEAN_REASONS.has(e.reason)) return null
      const what = e.type === 'child-process-gone' ? `${e.type} ${e.serviceName || ''}` : e.type
      return {
        ...base,
        kind: 'process-gone',
        message: `${what} reason=${e.reason} exitCode=${e.exitCode} url=${e.url || ''}`.trim(),
        // Renderers torn down while the app quits are not crashes.
        info: Boolean(e.quitting)
      }
    }
    case 'unresponsive':
      return {
        ...base,
        kind: 'process-gone',
        message: `webContents ${e.wc} unresponsive (${e.url})`
      }
    case 'preload-error':
      return { ...base, kind: 'preload-error', message: e.message, source: e.preloadPath }
    case 'main-uncaught-exception':
    case 'main-unhandled-rejection':
      return { ...base, kind: 'main-exception', message: `${e.type}: ${e.message}` }
    case 'dialog':
      return {
        ...base,
        kind: 'dialog',
        message: `${e.method}: ${e.message ?? ''}${e.detail ? ` - ${e.detail}` : ''}`
      }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------------
// App session: one launch of the executable with one profile.
// ---------------------------------------------------------------------------------------------

class Session {
  constructor(scenario, userData, { args = [], env = {} } = {}) {
    this.scenario = scenario
    this.userData = userData
    this.extraArgs = args
    this.extraEnv = env
    this.eventsFile = path.join(outDir, `${scenario}-main-events.jsonl`)
    fs.writeFileSync(this.eventsFile, '')
    this.stderr = []
    this.stdout = []
    this.pageErrors = []
    this.steps = []
    this.timings = {}
    this.exit = null
    this.quitStartedAt = null
    this.killedAt = null
    this.mainWindowId = null
  }

  launchArgs() {
    return [...EXTRA_ARGS, `--user-data-dir=${this.userData}`, ...this.extraArgs]
  }

  launchEnv() {
    return { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...isolationEnv, ...this.extraEnv }
  }

  async launch() {
    const t0 = Date.now()
    // The run's first launch is the cold one (FIRST_LAUNCH_RENDER_BUDGET_MS); the counter moves
    // whatever becomes of it, since the launch after a failed first one is a warm launch too.
    this.renderBudgetMs = launchesSoFar === 0 ? FIRST_LAUNCH_RENDER_BUDGET_MS : RENDER_BUDGET_MS
    launchesSoFar++
    log(`launching ${opts.exe} ${this.launchArgs().join(' ')} (${this.scenario})`)
    this.app = await electron.launch({
      executablePath: opts.exe,
      args: this.launchArgs(),
      env: this.launchEnv(),
      // Playwright would otherwise emulate prefers-color-scheme: light on every page it attaches
      // to; null means the pages follow the OS / nativeTheme like they do for a user.
      colorScheme: null,
      timeout: 90000
    })
    // A main process blocked by a synchronous native dialog never answers an evaluate: fence
    // every call so the step fails instead of the whole run stalling.
    const rawEvaluate = this.app.evaluate.bind(this.app)
    this.app.evaluate = (fn, arg) =>
      withTimeout(rawEvaluate(fn, arg), EVALUATE_TIMEOUT_MS, 'app.evaluate')
    const proc = this.app.process()
    this.pid = proc.pid
    proc.stderr?.on('data', (d) => this.stderr.push(d.toString()))
    proc.stdout?.on('data', (d) => this.stdout.push(d.toString()))
    this.exitPromise = new Promise((resolve) => {
      proc.on('exit', (code, signal) => {
        this.exit = { code, signal, at: Date.now() }
        resolve(this.exit)
      })
    })
    this.app.on('window', (page) => this.attachPage(page))
    for (const p of this.app.windows()) this.attachPage(p)
    this.hookResult = await this.app.evaluate(hookMain, { eventsFile: this.eventsFile })
    this.timings.launchMs = Date.now() - t0
    this.chrome = await this.waitForChromePage(RENDER_WAIT_MS)
    await this.chrome.locator('[data-testid="chrome-root"]').waitFor({
      state: 'attached',
      timeout: RENDER_WAIT_MS
    })
    this.timings.chromeRenderedMs = Date.now() - t0
    this.mainWindowId = await this.app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)
      return wins.length ? wins[0].id : null
    })
    if (IS_LINUX && !displaySize) {
      // Physical size of the Xvfb screen for ffmpeg's x11grab.
      displaySize = await this.app.evaluate(({ screen }) => {
        const d = screen.getPrimaryDisplay()
        return {
          width: Math.round(d.size.width * d.scaleFactor),
          height: Math.round(d.size.height * d.scaleFactor)
        }
      })
    }
    return this
  }

  attachPage(page) {
    if (page.__smokeAttached) return
    page.__smokeAttached = true
    page.on('pageerror', (err) =>
      this.pageErrors.push({
        kind: 'chrome-pageerror',
        scenario: this.scenario,
        at: Date.now(),
        url: page.url(),
        message: String(err && (err.stack || err.message || err)).slice(0, 4000)
      })
    )
    page.on('crash', () => {
      // A renderer going with the process the harness itself killed is no crash.
      if (this.killedAt) return
      this.pageErrors.push({
        kind: 'process-gone',
        scenario: this.scenario,
        at: Date.now(),
        url: page.url(),
        message: 'chrome page crashed (Playwright crash event)'
      })
    })
  }

  chromePages() {
    return this.app.windows().filter((p) => /^file:.*index\.html/.test(p.url()))
  }

  async waitForChromePage(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const pages = this.chromePages()
      if (pages.length) return pages[0]
      await this.app
        .waitForEvent('window', { timeout: Math.max(1, Math.min(2000, deadline - Date.now())) })
        .catch(() => undefined)
    }
    const urls = this.app.windows().map((p) => p.url())
    throw new Error(`no chrome page (file://…/index.html) within ${timeoutMs} ms; pages: ${urls}`)
  }

  /**
   * Runs one fenced step; a failure is recorded, with the screen as it was at that moment
   * (`screen`, the file's name), and the scenario carries on.
   */
  async step(name, fn, { timeoutMs = STEP_TIMEOUT_MS, fatal = false } = {}) {
    const t = Date.now()
    const entry = { name, ok: false, ms: 0 }
    log(`step ${name}: start`)
    try {
      const detail = await withTimeout(fn(), timeoutMs, `step ${name}`)
      entry.ok = true
      if (detail !== undefined) entry.detail = detail
    } catch (e) {
      entry.error = String(e && (e.stack || e.message || e)).slice(0, 4000)
      // What the step had gathered before it failed (an error thrown with a `detail`).
      if (e && typeof e === 'object' && e.detail !== undefined) entry.detail = e.detail
      const screen = grabScreen(`${this.scenario}-${name}-failed`)
      if (screen.ok) entry.screen = screen.file
      log(
        `step ${name} FAILED: ${entry.error.split('\n')[0]}${screen.ok ? ` (screen: ${screen.file})` : ''}`
      )
    }
    entry.ms = Date.now() - t
    this.steps.push(entry)
    log(`step ${name}: ${entry.ok ? 'ok' : 'fail'} (${entry.ms} ms)`)
    if (!entry.ok && fatal) throw new Error(`fatal step ${name}: ${entry.error.split('\n')[0]}`)
    return entry
  }

  readEvents() {
    const out = []
    let text = ''
    try {
      text = fs.readFileSync(this.eventsFile, 'utf8')
    } catch {
      return out
    }
    const fromStderr = this.stderr
      .join('')
      .split(/\r?\n/)
      .filter((l) => l.startsWith('SMOKE_EVENT '))
      .map((l) => l.slice('SMOKE_EVENT '.length))
    for (const line of [...text.split('\n'), ...fromStderr]) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // a line cut short by the process exiting
      }
    }
    return out.sort((a, b) => a.t - b.t)
  }

  window(id = this.mainWindowId) {
    return this.app.evaluate(({ BrowserWindow }, wid) => {
      const w = (wid && BrowserWindow.fromId(wid)) || BrowserWindow.getAllWindows()[0]
      if (!w || w.isDestroyed()) return null
      return {
        id: w.id,
        title: w.getTitle(),
        bounds: w.getBounds(),
        visible: w.isVisible(),
        focused: w.isFocused(),
        maximized: w.isMaximized(),
        fullScreen: w.isFullScreen(),
        minimized: w.isMinimized()
      }
    }, id)
  }

  windowCount() {
    return this.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  }

  /** Tab pages: every webContents that is not a window's chrome page and not devtools. */
  tabs() {
    return this.app.evaluate(({ webContents, BrowserWindow }) => {
      const chromeIds = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id))
      return webContents
        .getAllWebContents()
        .filter((wc) => {
          try {
            return !chromeIds.has(wc.id) && !wc.getURL().startsWith('devtools://')
          } catch {
            return false
          }
        })
        .map((wc) => ({
          id: wc.id,
          url: wc.getURL(),
          title: wc.getTitle(),
          loading: wc.isLoading(),
          zoomFactor: wc.getZoomFactor()
        }))
    })
  }

  async waitForTab(urlPrefix, timeoutMs = 30000) {
    return waitFor(
      async () => (await this.tabs()).find((t) => t.url.startsWith(urlPrefix) && !t.loading),
      timeoutMs,
      `tab ${urlPrefix} loaded`,
      250
    )
  }

  sidebarTab(title, page = this.chrome) {
    return page.locator('[data-testid="tab-title"]').filter({ hasText: title })
  }

  /**
   * Keyboard shortcut through webContents.sendInputEvent on the window's chrome page: the same
   * browser-side path a physical key press takes into Electron's before-input-event, where the
   * app's shortcut table lives. (Playwright's CDP key events are delivered to the renderer only.)
   */
  press(combo, windowId = this.mainWindowId) {
    const parts = combo.split('+')
    const key = parts.pop()
    const modifiers = parts.map(
      (m) =>
        ({ Control: 'control', Meta: 'meta', Shift: 'shift', Alt: 'alt' })[m] || m.toLowerCase()
    )
    return this.app.evaluate(
      ({ BrowserWindow }, { key, modifiers, windowId }) => {
        const w =
          (windowId && BrowserWindow.fromId(windowId)) ||
          BrowserWindow.getFocusedWindow() ||
          BrowserWindow.getAllWindows()[0]
        if (!w || w.isDestroyed()) throw new Error('no window to send keys to')
        w.focus()
        w.webContents.focus()
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
      },
      { key, modifiers, windowId }
    )
  }

  bringToFront(windowId = this.mainWindowId) {
    return this.app.evaluate(({ BrowserWindow, app }, wid) => {
      const w =
        (wid && BrowserWindow.fromId(wid)) ||
        BrowserWindow.getAllWindows().find((x) => x.isVisible()) ||
        BrowserWindow.getAllWindows()[0]
      if (w && !w.isDestroyed()) {
        w.show()
        w.focus()
        w.moveTop()
        // Windows keeps another process's active window above an HWND_TOP request from a
        // background process (windows-11-arm leaves a first-logon terminal in the foreground, so
        // every screenshot showed it over the app). A TOPMOST round trip ends with HWND_NOTOPMOST,
        // which places the window above every non-topmost window regardless of activation.
        if (process.platform === 'win32') {
          const wasOnTop = w.isAlwaysOnTop()
          w.setAlwaysOnTop(true)
          w.setAlwaysOnTop(wasOnTop)
        }
      }
      if (app.focus) app.focus({ steal: true })
    }, windowId)
  }

  /** Two animation frames in the chrome page: the last DOM change has been committed and painted. */
  settle(page = this.chrome) {
    return withTimeout(page.evaluate(twoAnimationFrames), 3000, 'settle').catch(() => false)
  }

  /**
   * Waits for the chrome page to run two animation frames; resolves with how long they took, or
   * null when none ran within `timeoutMs`. A page whose DOM is complete but whose window has no
   * frames yet – the GPU process still coming up on a cold launch (the compositor's frames are
   * what drive animation-frame callbacks), the window not shown or occluded – runs no callback at
   * all, so a single evaluate would hang for the whole wait: each attempt is fenced at a second
   * and asked again until the deadline (a stale attempt resolving later goes nowhere).
   */
  async waitForFrames(timeoutMs, page = this.chrome) {
    const t0 = Date.now()
    const deadline = t0 + timeoutMs
    for (;;) {
      const slice = Math.min(1000, deadline - Date.now())
      if (slice <= 0) return null
      const attempt = Date.now()
      const ticked = await withTimeout(page.evaluate(twoAnimationFrames), slice, 'frames').then(
        () => true,
        () => false
      )
      if (ticked) return Date.now() - t0
      // An evaluate that failed outright (the page gone) rather than timing out: not a busy loop.
      if (Date.now() - attempt < slice)
        await delay(Math.min(250, Math.max(0, deadline - Date.now())))
    }
  }

  shot(name) {
    return shot(`${this.scenario}-${name}`, this)
  }

  /** The webContents holding the keyboard, as the main process sees it (null: none). */
  focusedWebContentsId() {
    return this.app.evaluate(({ webContents }) => {
      const wc = webContents.getFocusedWebContents()
      return wc && !wc.isDestroyed() ? wc.id : null
    })
  }

  /** The main window's chrome webContents id (the page the sidebar, URL bar and dialogs live in). */
  chromeWebContentsId(windowId = this.mainWindowId) {
    return this.app.evaluate(({ BrowserWindow }, wid) => {
      const w = (wid && BrowserWindow.fromId(wid)) || BrowserWindow.getAllWindows()[0]
      return w && !w.isDestroyed() ? w.webContents.id : null
    }, windowId)
  }

  /**
   * Where the keyboard is, for the steps that assert it: `chrome` (the window's chrome page, with
   * the focused element's test id when it has one), `tab:<id>` (a page) or `none`.
   */
  async keyboardOwner() {
    const [focused, chrome] = await Promise.all([
      this.focusedWebContentsId(),
      this.chromeWebContentsId()
    ])
    if (focused === null) return 'none'
    if (focused !== chrome) return `tab:${focused}`
    const active = await this.chrome
      .evaluate(() => {
        const el = document.activeElement
        return el && el !== document.body ? el.getAttribute('data-testid') || el.tagName : null
      })
      .catch(() => null)
    return active ? `chrome:${active}` : 'chrome'
  }

  /** Rows in the sidebar's tab list (the active space). */
  sidebarTabCount(page = this.chrome) {
    return page.locator('[data-testid="tab"]').count()
  }

  /** The ids of every window but the main one. */
  otherWindowIds() {
    return this.app.evaluate(
      ({ BrowserWindow }, main) =>
        BrowserWindow.getAllWindows()
          .filter((w) => w.id !== main)
          .map((w) => w.id),
      this.mainWindowId
    )
  }

  /** `code` run in the top document of tab `tabId` (its main world; a promise it returns is awaited). */
  tabEval(tabId, code) {
    return this.app.evaluate(
      ({ webContents }, { tabId, code }) => {
        const wc = webContents.fromId(tabId)
        if (!wc || wc.isDestroyed()) throw new Error(`tab webContents ${tabId} is gone`)
        return wc.executeJavaScript(code)
      },
      { tabId, code }
    )
  }

  /**
   * The cookies named `name` in the jar of tab `tabId`'s session (its container's partition), and
   * where that partition keeps its files: what the engine holds, read from the main process
   * rather than from the page.
   */
  tabCookies(tabId, name) {
    return this.app.evaluate(
      async ({ webContents }, { tabId, name }) => {
        const wc = webContents.fromId(tabId)
        if (!wc || wc.isDestroyed()) throw new Error(`tab webContents ${tabId} is gone`)
        const cookies = await wc.session.cookies.get({ name })
        return {
          storagePath: wc.session.storagePath,
          cookies: cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            session: c.session,
            expirationDate: c.expirationDate
          }))
        }
      },
      { tabId, name }
    )
  }

  /**
   * The child frame of tab `tabId` whose document is on `origin`, as the main process sees it:
   * its URL and whether it runs in a process of its own (null while there is no such frame).
   */
  frameIn(tabId, origin) {
    return this.app.evaluate(
      ({ webContents }, { tabId, origin }) => {
        const wc = webContents.fromId(tabId)
        if (!wc || wc.isDestroyed()) return null
        const top = wc.mainFrame
        const frame = top.frames.find((f) => f.url.startsWith(origin))
        if (!frame) return null
        return {
          url: frame.url,
          outOfProcess: frame.processId !== top.processId,
          processId: frame.processId,
          topProcessId: top.processId
        }
      },
      { tabId, origin }
    )
  }

  /** `code` run inside that child frame (its own main world). */
  frameEval(tabId, origin, code) {
    return this.app.evaluate(
      ({ webContents }, { tabId, origin, code }) => {
        const wc = webContents.fromId(tabId)
        const frame =
          wc && !wc.isDestroyed() ? wc.mainFrame.frames.find((f) => f.url.startsWith(origin)) : null
        if (!frame) throw new Error(`no frame on ${origin} in tab ${tabId}`)
        return frame.executeJavaScript(code)
      },
      { tabId, origin, code }
    )
  }

  /**
   * Where the view of tab `tabId` is on the screen: the window's content origin plus the view's
   * bounds within it (DIPs), with the display's scale factor for tools that count device pixels.
   */
  tabViewScreenRect(tabId, windowId = this.mainWindowId) {
    return this.app.evaluate(
      ({ BrowserWindow, screen }, { tabId, windowId }) => {
        const w = BrowserWindow.fromId(windowId)
        if (!w || w.isDestroyed()) return null
        const find = (parent, ox, oy) => {
          for (const v of parent.children || []) {
            const b = v.getBounds()
            if (v.webContents && v.webContents.id === tabId) {
              return { x: ox + b.x, y: oy + b.y, width: b.width, height: b.height }
            }
            const inner = find(v, ox + b.x, oy + b.y)
            if (inner) return inner
          }
          return null
        }
        const local = find(w.contentView, 0, 0)
        if (!local) return null
        const content = w.getContentBounds()
        return {
          x: content.x + local.x,
          y: content.y + local.y,
          width: local.width,
          height: local.height,
          scale: screen.getDisplayMatching(content).scaleFactor
        }
      },
      { tabId, windowId }
    )
  }

  /**
   * The chrome's window-modal question ("Close N tabs?" before a window with several tabs
   * closes, "Quit Zenium?" before quitting with several tabs; #129), read from the page: its
   * kind, heading and text, or null while none is up.
   */
  async windowPrompt(page = this.chrome) {
    const prompt = page.locator('[data-window-prompt]').first()
    if (!(await prompt.isVisible().catch(() => false))) return null
    const heading = await prompt.getByRole('heading').first().textContent()
    const text = await prompt.textContent()
    return {
      kind: await prompt.getAttribute('data-window-prompt'),
      heading: (heading ?? '').trim(),
      text: (text ?? '').replace(/\s+/g, ' ').trim()
    }
  }

  /** Nothing chrome-side may stay open between steps: Escape, then two frames. */
  async reset() {
    await this.press('Escape')
    await this.settle()
  }

  /**
   * Quit the way a user does, with the preset's quit chord. With more than one tab open the chrome
   * first asks "Quit Zenium?" (the "warn before closing a window with multiple tabs" setting is
   * on by default): the question must show exactly then, name the tab count, and its Quit button
   * ends the run. The app has to exit with code 0 within the budget either way.
   *
   * The exit is the process's exit event and nothing else. From the moment the app quits,
   * Playwright's connections to it are gone – before the process is, by seconds on a slow runner
   * – so a call still in flight then ("Target page, context or browser has been closed") is the
   * quit happening, and an evaluate can neither confirm the exit nor tell a slow teardown from a
   * hang (#148, #157). Callers read state.json only after this returns: the write a graceful
   * quit ends with is the run's last one (#150), complete once the process has exited.
   */
  async quitGracefully(budgetMs = QUIT_BUDGET_MS) {
    const tabs = await this.sidebarTabCount().catch(() => 0)
    const expectPrompt = tabs > 1
    this.quitStartedAt = Date.now()
    // The chord's evaluate may lose its target: the quit it triggers can take the main-process
    // session down before the reply arrives. The exit event says what happened then.
    await Promise.race([unlessTargetClosed(this.press(QUIT_COMBO)), delay(3000)])
    const prompt = this.chrome.locator('[data-window-prompt="quit"]').first()
    // The wait ends early when the chrome page closes under it: the app quitting without asking.
    const first = await Promise.race([
      this.exitPromise.then(() => 'exit'),
      prompt
        .waitFor({ state: 'visible', timeout: budgetMs })
        .then(() => 'prompt')
        .catch(() => 'no-prompt')
    ])
    let asked = null
    if (first === 'prompt') {
      asked = await this.windowPrompt()
      await shot(`${this.scenario}-quit-prompt`, this)
      if (asked.heading !== 'Quit Zenium?' || !asked.text.includes(`${tabs} tabs`)) {
        throw new Error(
          `quit question reads "${asked.heading}" / "${asked.text}" with ${tabs} tabs open`
        )
      }
      // Quit closes the window the button is in; the click's reply may not make it back.
      await unlessTargetClosed(
        prompt.getByRole('button', { name: 'Quit', exact: true }).click({ timeout: 5000 })
      )
      this.quitStartedAt = Date.now()
    }
    // One budget from the chord (or from Quit): the time the question took to show counts.
    const exit = await exitWithin(this.exitPromise, budgetMs, this.quitStartedAt)
    const ms = Date.now() - this.quitStartedAt
    if (!exit) {
      // Still alive past the bound. Whether the main process answers tells a quit that never
      // started (responsive: the chord went nowhere; a prompt may be up) from a blocked one (a
      // native dialog) from one gone from Playwright's view (windows and debugger closed, the
      // process not ending: a teardown slower than the bound, or stuck).
      const main = await mainProcessState(
        this.app.evaluate(() => 'ok'),
        3000
      )
      const late = main === 'responsive' ? await this.windowPrompt().catch(() => null) : null
      log(
        `app did not exit within ${budgetMs} ms after ${QUIT_COMBO} (main process ${main}); closing`
      )
      await this.forceClose()
      throw new Error(
        `app did not exit within ${budgetMs} ms after ${QUIT_COMBO}${asked ? ' and Quit' : ''} (main process ${main}; prompt ${JSON.stringify(late)}; exit after forceClose ${JSON.stringify(this.exit)})`
      )
    }
    if (exit.code !== 0)
      throw new Error(`app exited with code ${exit.code} signal ${exit.signal} after ${ms} ms`)
    if (expectPrompt && !asked)
      throw new Error(`quit went ahead without "Quit Zenium?" although ${tabs} tabs were open`)
    if (!expectPrompt && asked)
      throw new Error(`"Quit Zenium?" asked with ${tabs} tab open: ${JSON.stringify(asked)}`)
    return { ms, exit, prompt: asked }
  }

  /** End the process the way a crash does: no quit path, no clean-exit marker. */
  async kill() {
    this.killedAt = Date.now()
    if (IS_WIN) sh('taskkill', ['/F', '/PID', String(this.pid)], 20000)
    else process.kill(this.pid, 'SIGKILL')
    const exit = await Promise.race([this.exitPromise, delay(10000).then(() => null)])
    if (!exit) throw new Error(`process ${this.pid} still alive 10 s after SIGKILL`)
    return exit
  }

  /** Playwright's close() needs a live main-process event loop, so fall back to killing the tree. */
  async forceClose() {
    if (this.exit) return this.exit
    this.quitStartedAt ??= Date.now()
    await Promise.race([this.app.close().catch(() => undefined), delay(8000)])
    if (!this.exit && this.pid) {
      log(`force killing pid ${this.pid}`)
      if (IS_WIN) sh('taskkill', ['/F', '/T', '/PID', String(this.pid)], 20000)
      else {
        try {
          process.kill(this.pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      await Promise.race([this.exitPromise, delay(5000)])
    }
    return this.exit
  }

  /** Every failure of this session: failed steps, hook events, Playwright page errors. */
  failures() {
    const out = []
    for (const st of this.steps) {
      if (!st.ok) {
        out.push({
          kind: 'step',
          scenario: this.scenario,
          step: st.name,
          message: st.error,
          ...(st.screen ? { screen: st.screen } : {})
        })
      }
    }
    for (const e of this.readEvents()) {
      const f = failureFromEvent(e, this.scenario)
      if (f) out.push(f)
    }
    out.push(...this.pageErrors)
    return out
  }

  saveLogs() {
    fs.writeFileSync(path.join(outDir, `${this.scenario}-stderr.log`), this.stderr.join(''))
    fs.writeFileSync(path.join(outDir, `${this.scenario}-stdout.log`), this.stdout.join(''))
  }

  summary() {
    const failures = this.failures()
    return {
      scenario: this.scenario,
      pid: this.pid,
      hook: this.hookResult,
      timings: this.timings,
      exit: this.exit,
      steps: this.steps,
      failures,
      events: this.readEvents().length
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------

// Automatic updates stay off in every smoke profile: left on, the app could find a newer release
// within seconds of launching and replace the binary under test on quit. The shortcut preset is
// written out because a state file without one reads as a profile from before the setting and
// gets the one-time "shortcuts now follow Chrome" toast (#126); a first run has the default.
const HARNESS_SETTINGS = {
  updates: { autoCheck: false, autoDownload: false, channel: 'stable' },
  shortcutPreset: 'chrome'
}

/**
 * A profile with the harness settings, past onboarding when asked, plus `settings` on top (a
 * scenario's own, e.g. `privacy.clearOnExit`; the state's sanitisers fill in the rest).
 */
function freshProfile(name, { onboardingDone = false, settings: extra = {} } = {}) {
  const dir = path.join(profileRoot, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'zen'), { recursive: true })
  const settings = { ...structuredClone(HARNESS_SETTINGS), ...structuredClone(extra) }
  if (onboardingDone) settings.onboardingDone = true
  writeJson(path.join(dir, 'zen', 'state.json'), { version: 2, settings })
  return dir
}

/**
 * The profile's state file as the smoke reads it. `cleanExit` is #129's marker: false from the
 * first write of a run, true from the write a graceful quit ends with, absent from a profile no
 * run has written yet.
 */
function readState(userData) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(userData, 'zen', 'state.json'), 'utf8'))
    return {
      version: s.version,
      windows: (s.windows || []).length,
      tabs: (s.tabs || []).map((t) => ({ url: t.url, title: t.title })),
      onboardingDone: s.settings && s.settings.onboardingDone,
      cleanExit: s.cleanExit
    }
  } catch (e) {
    return { error: String(e.message) }
  }
}

/** The state after a graceful quit: the marker set, and (when asked) a tab on `url`. */
function assertCleanState(userData, url) {
  const state = readState(userData)
  if (state.cleanExit !== true) {
    throw new Error(`state.json lacks cleanExit: true after the quit: ${JSON.stringify(state)}`)
  }
  if (url && !state.tabs?.some((t) => t.url.startsWith(url))) {
    throw new Error(`state.json has no ${url} tab: ${JSON.stringify(state)}`)
  }
  return state
}

/**
 * The profile's site-data document (#310's `sitedata.json`, beside state.json) as the smoke reads
 * it: `doc` parsed (undefined without a file), `owed` what it owes (site-data.mjs's
 * `owedClearOf`: undefined for no file, null for a marker dropped or never written, else the
 * marker), `error` for a file that is not JSON (a write mid-rename would be: reread).
 */
function readSiteData(userData) {
  const file = path.join(userData, 'zen', SITE_DATA_FILE)
  if (!fs.existsSync(file)) return { file, doc: undefined, owed: undefined }
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { file, doc, owed: owedClearOf(doc) }
  } catch (e) {
    return { file, error: String(e.message) }
  }
}

/** Writes `marker` into the profile's sitedata.json as the clear its next launch owes. */
function writeOwedClear(userData, marker) {
  const { file, doc } = readSiteData(userData)
  const written = withOwedClear(doc ?? null, marker)
  writeJson(file, written)
  return written
}

/** The document after a quit that owes nothing: present (when `expectFile`) and no marker. */
function assertNoOwedClear(userData, { expectFile = true } = {}) {
  const siteData = readSiteData(userData)
  if (siteData.error) throw new Error(`${SITE_DATA_FILE} unreadable: ${siteData.error}`)
  if (expectFile && siteData.doc === undefined) {
    throw new Error(`${SITE_DATA_FILE} missing: the marker was never written before the run`)
  }
  if (siteData.owed) {
    throw new Error(
      `${SITE_DATA_FILE} still owes a clear (the run did not report done): ${JSON.stringify(siteData.doc)}`
    )
  }
  return siteData.doc ?? null
}

/**
 * Whether the partition's cookie store on disk names `name`: the SQLite `Cookies` file (and
 * its journal, where a commit may still sit) keeps cookie names in clear text, so a persistent
 * cookie that survived a quit shows there. The evidence a cookie was in the profile before the
 * launch that clears it.
 */
function cookieStoreNames(storagePath, name) {
  const files = fs.existsSync(storagePath)
    ? fs.readdirSync(storagePath).filter((f) => f.startsWith('Cookies'))
    : []
  const named = files.filter((f) => fs.readFileSync(path.join(storagePath, f)).includes(name))
  return { storagePath, files, named, found: named.length > 0 }
}

// ---------------------------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------------------------

async function runScenario(name, userData, sessionOptions, body) {
  const s = new Session(name, userData, sessionOptions)
  currentSession = s
  const out = { userData }
  try {
    await s.step(
      'launch',
      async () => {
        await s.launch()
        const facts = await s.app.evaluate(({ app }) => ({
          version: app.getVersion(),
          name: app.getName(),
          userData: app.getPath('userData'),
          electron: process.versions.electron,
          chrome: process.versions.chrome
        }))
        // Resolved on both sides: macOS reports /private/var/... for the /var/... tmpdir.
        if (!realPath(facts.userData).startsWith(realPath(profileRoot))) {
          throw new Error(`profile not isolated: userData is ${facts.userData}`)
        }
        if (s.timings.chromeRenderedMs > s.renderBudgetMs) {
          throw new Error(
            `chrome rendered after ${s.timings.chromeRenderedMs} ms (budget ${s.renderBudgetMs} ms${s.renderBudgetMs === RENDER_BUDGET_MS ? '' : ' for the first launch of the run'})`
          )
        }
        return { ...s.timings, renderBudgetMs: s.renderBudgetMs, ...facts }
      },
      { timeoutMs: RENDER_WAIT_MS + 90000, fatal: true }
    )
    await body(s, out)
  } catch (e) {
    out.fatal = String(e && (e.stack || e.message || e))
    log(`${name}: ${out.fatal.split('\n')[0]}`)
  }
  if (s.app && !s.exit) await s.forceClose().catch(() => undefined)
  s.saveLogs()
  out.session = s.summary()
  result.scenarios[name] = out
  writeJson(path.join(outDir, 'result.json'), result)
  return out
}

/**
 * Accel+T, the URL typed into the bar that comes up, Enter: a new tab row in the sidebar and the
 * page loaded. Returns the tab (as the main process sees it) and the sidebar row count.
 * `landsOn` is where the tab ends up when `url` redirects (the fixture's cookie set page).
 */
async function openUrlInNewTab(s, url, { landsOn = url } = {}) {
  const input = s.chrome.locator('[data-testid="urlbar-input"]')
  // A blank first tab already shows the URL bar; Accel+T would toggle it away. Close it first.
  if (
    await input
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await s.press('Escape')
    await input.first().waitFor({ state: 'hidden', timeout: 5000 })
  }
  const rowsBefore = await s.sidebarTabCount()
  // Main-process events recorded before this navigation are not its failures.
  const eventsBefore = s.readEvents().length
  await s.press(`${ACCEL}+t`)
  await input.first().waitFor({ state: 'visible', timeout: 8000 })
  await input.first().fill(url)
  await s.press('Enter')
  // One network hiccup on the runner (a TLS reset, `ERR_CONNECTION_RESET`) lands the tab on the
  // error page; the step retries the navigation once in that tab (Accel+L, the address again)
  // and says so in its detail. A second failure fails the step (navigation.mjs).
  const { tab, retried } = await waitForTabWithRetry({
    url,
    loaded: async () => (await s.tabs()).find((t) => t.url.startsWith(landsOn) && !t.loading),
    events: async () => s.readEvents().slice(eventsBefore),
    retry: async (failure) => {
      log(`${url}: ${retryDetail(failure)}`)
      await s.press(`${ACCEL}+l`)
      await input.first().waitFor({ state: 'visible', timeout: 8000 })
      await input.first().fill(url)
      await s.press('Enter')
    },
    timeoutMs: 45000
  })
  const rows = await waitFor(
    async () => {
      const n = await s.sidebarTabCount()
      return n > rowsBefore ? n : null
    },
    10000,
    `a new sidebar row for ${url} (${rowsBefore} before)`
  )
  return { tab, sidebarTabs: rows, retried: retried ? retryDetail(retried) : null }
}

async function closeExtraWindows(s) {
  await s.app.evaluate(({ BrowserWindow }, keep) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.id !== keep) w.close()
  }, s.mainWindowId)
  await waitFor(async () => (await s.windowCount()) === 1, 10000, 'extra windows closed')
}

/**
 * The private window's new tab page has the "Block third-party cookies" switch (the private-scoped
 * setting of #218): the row is there once the page has its state, and a real click on the switch
 * flips `privacy.thirdPartyCookiesPrivate` – off writes `allow`, on writes `block` – while the
 * regular mode is left alone. The click goes through xdotool like the pop-up step's: the served
 * page is a WebContentsView, not a Playwright page. Returns the step's detail.
 */
async function privateCookiesSwitch(s, privateWindowId) {
  // A window opened by a synthetic shortcut gets no focus from a window manager and lands behind
  // the main one; under Xvfb without one it can sit fully under it. A window Chromium finds
  // occluded gets no rendering updates: the chrome's ResizeObserver never measures the content
  // frame, no `layout.report` reaches the core, and the page's view – created and attached –
  // stays hidden (main red twice on 2026-09-20 with `{url: "zen://newtab/", visible: false}`
  // after 15 s). So the window is raised before anything is waited for, the wait is split into
  // the view existing and the view being shown, and a view that stays hidden gets the chrome
  // nudged into a fresh report: the window raised again and resized by a pixel and back.
  await s.bringToFront(privateWindowId)
  const nudged = []
  const windowViews = () =>
    s.app.evaluate(({ BrowserWindow }, wid) => {
      const w = BrowserWindow.fromId(wid)
      if (!w || w.isDestroyed()) return { shown: null, views: 'window gone' }
      const views = []
      const walk = (parent) => {
        for (const v of parent.children || []) {
          const wc = v.webContents
          if (wc && !wc.isDestroyed()) {
            views.push({
              id: wc.id,
              url: wc.getURL(),
              visible: v.getVisible(),
              loading: wc.isLoading()
            })
          }
          walk(v)
        }
      }
      walk(w.contentView)
      const page = (v) => v.url.startsWith('zen://newtab')
      const hit = views.find((v) => page(v) && v.visible && !v.loading)
      return { shown: hit ? hit.id : null, exists: views.some(page), views }
    }, privateWindowId)
  const nudge = () =>
    s.app.evaluate(({ BrowserWindow }, wid) => {
      const w = BrowserWindow.fromId(wid)
      if (!w || w.isDestroyed()) return
      w.show()
      w.focus()
      w.moveTop()
      const [width, height] = w.getSize()
      w.setSize(width + 1, height)
      w.setSize(width, height)
    }, privateWindowId)
  // What the window holds goes into a failure, so a miss says which page the window shows.
  let seen = null
  // (a) The page's view exists in the window (the window may hold an adopted preload of it too).
  await waitFor(
    async () => {
      const snapshot = await windowViews()
      seen = snapshot.views
      return snapshot.exists ? true : null
    },
    15000,
    "the private window's zen://newtab view"
  ).catch((err) => {
    throw new Error(`${err.message}; the window's views: ${JSON.stringify(seen)}`)
  })
  // (b) The view is shown and its page loaded: the chrome placed it. A hidden view here is
  // usually by design, not a stall: 150 ms after the chrome is up the core opens the URL bar in
  // its new-tab mode over the private new tab page (`newtab.opened`), and an open URL bar covers
  // the content (`overlayCoversContent`), so the chrome reports `contentHidden` and shows the
  // page's picture instead of the live view. Whether the first look lands before or after that
  // 150 ms decided the outcome (main red three times on `visible: false`). So while the view is
  // hidden, Escape closes the bar every second (the later click needs it closed anyway), and
  // every 4 s the chrome is nudged into another layout report as a fallback.
  let lastNudge = Date.now()
  let lastEscape = 0
  const escaped = []
  const ntpId = await waitFor(
    async () => {
      const snapshot = await windowViews()
      seen = snapshot.views
      if (snapshot.shown) return snapshot.shown
      if (Date.now() - lastEscape >= 1000) {
        lastEscape = Date.now()
        escaped.push(new Date().toISOString())
        await s.press('Escape', privateWindowId)
      }
      if (Date.now() - lastNudge >= 4000) {
        lastNudge = Date.now()
        nudged.push(new Date().toISOString())
        await nudge()
      }
      return null
    },
    20000,
    "the private window's zen://newtab view shown by the chrome"
  ).catch((err) => {
    throw new Error(
      `${err.message}; the window's views: ${JSON.stringify(seen)}; escaped ${escaped.length}, nudged ${nudged.length} time(s)`
    )
  })
  const probe = `(() => {
      const row = document.getElementById('zen-cookies')
      const sw = document.getElementById('zen-cookies-switch')
      const desc = document.getElementById('zen-cookies-desc')
      if (!row || !sw) return null
      const r = sw.getBoundingClientRect()
      return {
        hidden: row.hidden,
        role: sw.getAttribute('role'),
        checked: sw.getAttribute('aria-checked'),
        disabled: sw.disabled,
        label: (document.getElementById('zen-cookies-label') || {}).textContent,
        description: desc && desc.textContent,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height }
      }
    })()`
  const privacy = async () =>
    (await s.chrome.evaluate(() => window.zen.invoke('app.getState'))).settings.privacy
  const before = await privacy()
  // (1) The row exists on the private page, a switch in the position the settings give it.
  const row = await waitFor(
    async () => {
      const r = await s.tabEval(ntpId, probe).catch(() => null)
      return r && !r.hidden ? r : null
    },
    10000,
    'the "Block third-party cookies" row on the private new tab page'
  )
  const detail = { privateWindowId, ntpId, before, row, nudged, escaped }
  if (row.role !== 'switch' || row.label !== 'Block third-party cookies') {
    throw new Error(`the row is not the switch it should be: ${JSON.stringify(row)}`)
  }
  if (row.disabled && before.thirdPartyCookies !== 'block') {
    throw new Error(`the switch is disabled while the global mode is ${before.thirdPartyCookies}`)
  }
  // (2) A real click at the switch flips the setting the way the switch reads: on -> block,
  // off -> allow, never default. The window opened behind the main one (a synthetic shortcut
  // gives it no focus from the window manager): raise it and wait until it is the focused
  // window, then Escape takes its URL bar out of the new-tab mode so the page is what sits
  // under the pointer; the view's place is read after that, once the window has settled.
  await s.bringToFront(privateWindowId)
  await waitFor(
    () =>
      s.app.evaluate(
        ({ BrowserWindow }, wid) => BrowserWindow.fromId(wid)?.isFocused() ?? false,
        privateWindowId
      ),
    8000,
    'the private window focused'
  )
  await s.press('Escape', privateWindowId)
  await s.settle()
  await delay(500)
  const view = await s.tabViewScreenRect(ntpId, privateWindowId)
  if (!view) throw new Error(`no view for the page ${ntpId} in window ${privateWindowId}`)
  const zoom = (await s.tabs()).find((t) => t.id === ntpId)?.zoomFactor ?? 1
  const rowNow = await s.tabEval(ntpId, probe)
  const point = buttonScreenPoint({
    view,
    frame: { left: 0, top: 0 },
    button: rowNow.rect,
    zoom,
    scale: view.scale
  })
  detail.geometry = { view, zoom, point }
  if (!point.inside) {
    throw new Error(`the switch is outside the page view: ${JSON.stringify(detail.geometry)}`)
  }
  await s.shot('05a-private-cookies-row')
  const wantAfterClick = rowNow.checked === 'true' ? 'allow' : 'block'
  const flipped = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const p = await privacy()
      if (p.thirdPartyCookiesPrivate === wantAfterClick) return p
      if (Date.now() >= deadline) return null
      await delay(150)
    }
  }
  // The gesture, as the sign-in smoke sends its: trusted input through `sendInputEvent` at the
  // switch on the page's own webContents (the served page is the top document of its view, so
  // the event reaches it); when the setting has not moved, the pointer goes through X instead –
  // the window raised by the window manager first, since a window opened by a synthetic
  // shortcut can sit behind the main one.
  const local = {
    x: Math.round(rowNow.rect.left + rowNow.rect.width / 2),
    y: Math.round(rowNow.rect.top + rowNow.rect.height / 2)
  }
  await s.app.evaluate(
    ({ webContents }, { id, x, y }) => {
      const wc = webContents.fromId(id)
      if (!wc || wc.isDestroyed()) throw new Error(`page webContents ${id} is gone`)
      wc.focus()
      wc.sendInputEvent({ type: 'mouseMove', x, y })
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    },
    { id: ntpId, ...local }
  )
  let after = await flipped(4000)
  detail.gesture = after ? 'sendInputEvent' : 'sendInputEvent did not move the setting'
  if (!after) {
    const xid = await s.app.evaluate(({ BrowserWindow }, wid) => {
      const w = BrowserWindow.fromId(wid)
      const handle = w && !w.isDestroyed() ? w.getNativeWindowHandle() : null
      return handle && handle.length >= 4 ? handle.readUInt32LE(0) : null
    }, privateWindowId)
    if (xid) sh('xdotool', ['windowactivate', '--sync', String(xid)], 10000)
    await delay(300)
    xdotoolClick(point.x, point.y)
    after = await flipped(8000)
    detail.gesture += after ? `; xdotool at ${point.x},${point.y} did` : '; xdotool did not either'
    if (!after) {
      throw new Error(
        `privacy.thirdPartyCookiesPrivate did not become ${wantAfterClick} after the click (${detail.gesture}); geometry ${JSON.stringify(detail.geometry)}`
      )
    }
  }
  const rowAfter = await waitFor(
    async () => {
      const r = await s.tabEval(ntpId, probe).catch(() => null)
      return r && r.checked === (wantAfterClick === 'block' ? 'true' : 'false') ? r : null
    },
    8000,
    `aria-checked mirrors the ${wantAfterClick} choice`
  )
  detail.after = after
  detail.rowAfter = rowAfter
  if (after.thirdPartyCookies !== before.thirdPartyCookies) {
    throw new Error(
      `the private switch changed the regular mode: ${before.thirdPartyCookies} -> ${after.thirdPartyCookies}`
    )
  }
  await s.shot('05b-private-cookies-switch')
  return detail
}

/** The chrome page of the window whose chrome is `chrome` (`full`, `popup`), once it renders. */
function chromePageWithChrome(s, chrome, timeoutMs) {
  return waitFor(
    async () => {
      for (const p of s.chromePages()) {
        const value = await p
          .locator('[data-testid="chrome-root"]')
          .getAttribute('data-window-chrome', { timeout: 1000 })
          .catch(() => null)
        if (value === chrome) return p
      }
      return null
    },
    timeoutMs,
    `a chrome page with data-window-chrome=${chrome}`
  )
}

/**
 * A real click at device pixel (x, y) of the X display: xdotool's XTEST events take the path a
 * mouse's do (X server, Chromium's platform window, its input router), which is what a gesture
 * inside an out-of-process iframe needs – `webContents.sendInputEvent` reaches the top document's
 * widget only, and a DOM `click()` is no user gesture at all. The move is not `--sync`ed (that
 * waits for a motion event, which never comes when the pointer already rests on the point; X
 * delivers the move before the press anyway), and the press is held for a moment like a
 * person's: the frame reports the gesture on mousedown, the page opens its window on click.
 */
function xdotoolClick(x, y) {
  const r = sh(
    'xdotool',
    [
      'mousemove',
      String(x),
      String(y),
      'sleep',
      '0.25',
      'mousedown',
      '1',
      'sleep',
      '0.08',
      'mouseup',
      '1'
    ],
    15000
  )
  if (r.status !== 0) {
    throw new Error(`xdotool click at ${x},${y} failed: ${r.error || r.stderr || r.stdout}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

// The pages the scenarios load (boot-fixture.mjs): `first` (the boot tab, restored by the later
// scenarios; the walkthrough's active tab), `second` (the walkthrough's other tab), `handoff`
// (the second instance's URL), each `{ url, title }` on the run's 127.0.0.1 origin. Started once
// per run by main(), ahead of the first scenario, so the URL `boot` persists – port included – is
// the one `restore` and `crash-restore` load again.
let bootSite = null

/** The window a user sees: one of them, titled with the product name, its chrome on screen. */
async function assertMainWindow(s) {
  const windows = await s.windowCount()
  if (windows !== 1) throw new Error(`${windows} windows open, expected 1`)
  const win = await s.window()
  if (!win || !win.visible) throw new Error(`main window not visible: ${JSON.stringify(win)}`)
  if (!/Zenium/.test(win.title)) throw new Error(`window title "${win.title}" lacks "Zenium"`)
  const chromeRoot = s.chrome.locator('[data-testid="chrome-root"]')
  if (!(await chromeRoot.isVisible())) throw new Error('chrome root not visible')
  return {
    windows,
    title: win.title,
    bounds: win.bounds,
    kind: await chromeRoot.getAttribute('data-window-kind')
  }
}

/**
 * Every platform's first launch: onboarding, one window titled Zenium, a tab on the fixture's
 * first page and a graceful quit that marks the profile cleanly exited (JS errors and dialogs
 * gate on their own).
 */
async function scenarioBoot() {
  const userData = freshProfile('profile')
  const page = bootSite.first
  return runScenario('boot', userData, {}, async (s, out) => {
    out.fixture = { origin: bootSite.origin, page: page.url }
    await s.step('onboarding', async () => {
      // The onboarding has the launch's render budget (the run's first launch is the cold one:
      // FIRST_LAUNCH_RENDER_BUDGET_MS) to be on screen, which is two things: in the DOM
      // (`visible`: laid out, nothing hiding it – a wait Playwright polls on timers) and painted
      // (the page runs animation frames, which the compositor's frames drive). The clicks then
      // get the same budget. Kept apart because they come apart: on 2026-09-22 (#327's merge
      // ref, ubuntu-latest) the onboarding was in the DOM 2 s after a cold launch that took 4 s
      // to its chrome, and the window stayed blank for the 25 s after it – no frame, because
      // the GPU process was still probing GL through Mesa (some 190 MB of libgallium/libLLVM
      // paged in from a cold disk, under an Xvfb that has no GPU to find) before settling on
      // the software compositor; the Linux job now launches with --disable-gpu, which skips
      // that probe (ci.yml). Playwright's click, which needs the button to hold still across
      // two animation frames, waited its FIRST_PAINT_CLICK_MS out with nothing to measure and
      // the failure read "locator.click: Timeout 15000ms exceeded". Now it reads what was
      // missing, with the screen at that moment and what the main process knew of the GPU
      // (`gpu`: Electron's getGPUFeatureStatus – gpu_compositing "disabled_software" is the
      // Xvfb norm, with or without the flag).
      const budget = s.renderBudgetMs
      const onboarding = s.chrome.locator('[data-testid="onboarding"]')
      const gpuStatus = () =>
        s.app.evaluate(({ app }) => app.getGPUFeatureStatus()).catch((e) => String(e.message || e))
      const t0 = Date.now()
      await onboarding.waitFor({ state: 'visible', timeout: budget })
      const visibleMs = Date.now() - t0
      await s.bringToFront().catch(() => undefined)
      const paintedMs = await s.waitForFrames(Math.max(1, budget - visibleMs))
      if (paintedMs === null) {
        const win = await s.window().catch(() => null)
        const gpu = await gpuStatus()
        const where = win
          ? `window ${win.visible ? 'visible' : 'not visible'}, ${win.bounds.width}x${win.bounds.height}, title "${win.title}"`
          : 'no window'
        const compositing =
          gpu && typeof gpu === 'object'
            ? `gpu_compositing ${gpu.gpu_compositing}`
            : `gpu status: ${gpu}`
        const error = new Error(
          `onboarding in the DOM after ${visibleMs} ms but not painted: no animation frame in the chrome page within the ${budget} ms render budget (${where}; ${compositing})`
        )
        error.detail = { visibleMs, paintedMs: null, renderBudgetMs: budget, window: win, gpu }
        throw error
      }
      await s.shot('01-first-launch')
      await s.chrome.getByRole('button', { name: 'Continue' }).click({ timeout: budget })
      await s.chrome.getByRole('button', { name: 'Skip tour' }).click({ timeout: budget })
      await onboarding.waitFor({ state: 'detached', timeout: 10000 })
      await s.shot('02-after-onboarding')
      return {
        completed: true,
        visibleMs,
        paintedMs,
        renderBudgetMs: budget,
        gpu: await gpuStatus()
      }
    })

    await s.step('window', () => assertMainWindow(s))

    await s.step('new-tab-fixture', async () => {
      const { tab, sidebarTabs, retried } = await openUrlInNewTab(s, page.url)
      await s.sidebarTab(page.title).first().waitFor({ state: 'visible', timeout: 15000 })
      out.fixtureTab = tab
      await s.shot('03-fixture-page')
      return { url: tab.url, title: tab.title, sidebarTabs, ...(retried ? { retried } : {}) }
    })

    await s.step('quit', async () => {
      const r = await s.quitGracefully()
      out.stateAfterQuit = assertCleanState(userData, page.url)
      return { ...r, state: out.stateAfterQuit }
    })
  })
}

/**
 * The profile from `boot` comes back after its graceful quit: the fixture's tab, no onboarding
 * and no "Restore pages?" bar (the clean-exit marker was written, #129).
 */
async function scenarioRestore() {
  const userData = path.join(profileRoot, 'profile')
  const page = bootSite.first
  // Read before the launch: the app's first (debounced) write of the new run flips the marker
  // back to false, and how soon it lands after the chrome renders differs per platform.
  const stateBefore = readState(userData)
  return runScenario('restore', userData, {}, async (s, out) => {
    out.stateBefore = stateBefore
    await s.step('restored-tab', async () => {
      if (stateBefore.cleanExit !== true) {
        throw new Error(`profile not marked cleanly exited: ${JSON.stringify(stateBefore)}`)
      }
      await s.sidebarTab(page.title).first().waitFor({ state: 'visible', timeout: 15000 })
      const onboarding = await s.chrome.locator('[data-testid="onboarding"]').count()
      if (onboarding) throw new Error('onboarding shown again on the second launch')
      // The page is loaded, not merely listed (after a crash it would be held back).
      const tab = await s.waitForTab(page.url, 30000)
      await s.settle()
      const restoreBar = await s.chrome.locator('[data-crash-restore]').count()
      if (restoreBar) throw new Error('"Restore pages?" offered after a graceful quit')
      await s.shot('01-restored')
      return {
        sidebarTabs: await s.sidebarTabCount(),
        fixtureTitles: await s.sidebarTab(page.title).count(),
        liveTabs: (await s.tabs()).map((t) => t.url),
        loaded: tab.url,
        persisted: out.stateBefore.tabs
      }
    })
    await s.step('window', () => assertMainWindow(s))
    await s.step('quit', async () => {
      const r = await s.quitGracefully()
      return { ...r, state: assertCleanState(userData, page.url) }
    })
  })
}

/**
 * The Linux job's walkthrough of the Chrome-preset shortcuts (#126) and the window questions
 * (#129) on a fresh profile past onboarding. Escape between steps: nothing chrome-side may carry
 * over from one to the next.
 */
async function scenarioWalkthrough() {
  const userData = freshProfile('profile-walkthrough', { onboardingDone: true })
  const page = bootSite.first
  return runScenario('walkthrough', userData, {}, async (s, out) => {
    out.fixture = {
      origin: bootSite.origin,
      pages: { first: page.url, second: bootSite.second.url, handoff: bootSite.handoff.url }
    }
    await s.step('new-tab', async () => {
      // The fresh window's blank tab takes the first URL; the second Ctrl+T must add a row. The
      // fixture's first page comes last so it is the active tab the following steps act on.
      const first = await openUrlInNewTab(s, bootSite.second.url)
      const second = await openUrlInNewTab(s, page.url)
      await s.sidebarTab(page.title).first().waitFor({ state: 'visible', timeout: 15000 })
      if (second.sidebarTabs !== first.sidebarTabs + 1) {
        throw new Error(
          `${second.sidebarTabs} sidebar rows after the second Ctrl+T, ${first.sidebarTabs} after the first`
        )
      }
      out.fixtureTab = second.tab
      await s.shot('01-two-tabs')
      return {
        first: { url: first.tab.url, title: first.tab.title, sidebarTabs: first.sidebarTabs },
        second: { url: second.tab.url, title: second.tab.title, sidebarTabs: second.sidebarTabs }
      }
    })

    await s.step('find-bar', async () => {
      await s.reset()
      const tab = out.fixtureTab
      if (!tab) throw new Error('no fixture tab to find in')
      await s.press(`${ACCEL}+f`)
      const bar = s.chrome.locator('[data-testid="find-bar"]')
      await bar.first().waitFor({ state: 'visible', timeout: 8000 })
      const input = s.chrome.locator('[data-testid="find-input"]')
      await input.first().waitFor({ state: 'visible', timeout: 5000 })
      const opened = await waitFor(
        async () => {
          const owner = await s.keyboardOwner()
          return owner === 'chrome:find-input' ? owner : null
        },
        5000,
        'keyboard in the find field'
      )
      // The fixture's first page has the word a known number of times: the count says the page
      // was searched, not just that the bar opened.
      await input.first().fill(FIND_WORD)
      const counter = s.chrome.locator('[data-testid="find-count"]').first()
      const count = await waitFor(
        async () => {
          const text = ((await counter.textContent().catch(() => null)) ?? '').trim()
          return text === `1/${FIND_MATCHES}` ? text : null
        },
        8000,
        `the find count reading 1/${FIND_MATCHES} for "${FIND_WORD}"`
      )
      await s.shot('02-find-bar')
      await s.press('Escape')
      await bar.first().waitFor({ state: 'hidden', timeout: 8000 })
      // Escape hands the keyboard back to the page (closeFindBar → returnFocusToPage).
      const closed = await waitFor(
        async () => {
          const owner = await s.keyboardOwner()
          return owner === `tab:${tab.id}` ? owner : null
        },
        5000,
        `keyboard back on the page (tab ${tab.id})`
      )
      return { opened, count, closed }
    })

    await s.step('zoom', async () => {
      await s.reset()
      const zoom = async () => (await s.tabs()).find((t) => t.url.startsWith(page.url))?.zoomFactor
      const bubble = s.chrome.locator('[data-zoom-bubble]')
      const level = bubble.locator('#zen-zoom-level')
      /** The bubble is up and says `percent`; the page's factor agrees. */
      const expectZoom = async (factor, what) => {
        const percent = `${Math.round(factor * 100)}%`
        await waitFor(
          async () => {
            const z = await zoom()
            return z !== undefined && Math.abs(z - factor) < 0.01 ? z : null
          },
          8000,
          `${what}: page zoom ${factor}`
        )
        await level.waitFor({ state: 'visible', timeout: 5000 })
        const text = ((await level.textContent()) ?? '').trim()
        if (text !== percent)
          throw new Error(`${what}: zoom bubble says "${text}", page is at ${percent}`)
        return text
      }
      const z0 = await zoom()
      if (Math.abs(z0 - 1) > 0.01) throw new Error(`page starts at zoom ${z0}, expected 1`)
      if (await bubble.count()) throw new Error('zoom bubble up before any zoom step')
      await s.press(`${ACCEL}+=`)
      const z1 = await expectZoom(1.1, 'Ctrl+plus')
      await s.press(`${ACCEL}+=`)
      const z2 = await expectZoom(1.25, 'Ctrl+plus again')
      await s.shot('03-zoom-bubble')
      await s.press(`${ACCEL}+-`)
      const z3 = await expectZoom(1.1, 'Ctrl+minus')
      await s.press(`${ACCEL}+0`)
      const z4 = await expectZoom(1, 'Ctrl+0')
      // Left alone the bubble goes on its own (1.5 s; up to 5 s once its buttons were used).
      await bubble.first().waitFor({ state: 'hidden', timeout: 8000 })
      return { z0, z1, z2, z3, z4, bubbleGone: true }
    })

    await s.step('fullscreen', async () => {
      await s.reset()
      const combo = FULLSCREEN_COMBO
      await s.press(combo)
      await waitFor(async () => (await s.window())?.fullScreen, 10000, 'window fullscreen', 200)
      await s.shot('04-fullscreen')
      await s.press(combo)
      await waitFor(
        async () => !(await s.window())?.fullScreen,
        10000,
        'window left fullscreen',
        200
      )
      return 'entered and left'
    })

    await s.step('new-window', async () => {
      await s.reset()
      const before = await s.windowCount()
      await s.press(`${ACCEL}+n`)
      await waitFor(async () => (await s.windowCount()) >= before + 1, 10000, 'second window')
      await waitFor(async () => s.chromePages().length >= 2, 10000, 'second chrome page')
      const kinds = []
      for (const p of s.chromePages()) {
        await p
          .locator('[data-testid="chrome-root"]')
          .waitFor({ state: 'attached', timeout: 10000 })
        kinds.push(await p.locator('[data-testid="chrome-root"]').getAttribute('data-window-kind'))
      }
      return { windows: await s.windowCount(), kinds }
    })

    await s.step('private-window', async () => {
      const before = await s.windowCount()
      await s.press(PRIVATE_WINDOW_COMBO)
      await waitFor(async () => (await s.windowCount()) >= before + 1, 10000, 'private window')
      await waitFor(
        async () => {
          for (const p of s.chromePages()) {
            const kind = await p
              .locator('[data-testid="chrome-root"]')
              .getAttribute('data-window-kind')
              .catch(() => null)
            if (kind === 'private') return true
          }
          return false
        },
        10000,
        'a chrome page with data-window-kind=private'
      )
      await s.shot('05-three-windows')
      await closeExtraWindows(s)
      return { windows: await s.windowCount() }
    })

    // The private window's new tab page carries the "Block third-party cookies" switch (the
    // private-scoped setting of #218): the row is there once the page has its state, and a real
    // click on the switch flips `privacy.thirdPartyCookiesPrivate` – off writes `allow`, on writes
    // `block` – while the regular mode is left alone. The click goes through xdotool like the
    // pop-up step's: the served page is a WebContentsView, not a Playwright page.
    await s.step('private-cookies-switch', async () => {
      await s.reset()
      const windowsBefore = await s.windowCount()
      await s.press(PRIVATE_WINDOW_COMBO)
      await waitFor(
        async () => (await s.windowCount()) >= windowsBefore + 1,
        10000,
        'private window'
      )
      const privateWindowId = await waitFor(
        () =>
          s.app.evaluate(
            ({ BrowserWindow }, main) =>
              BrowserWindow.getAllWindows().find((w) => w.id !== main && !w.isDestroyed())?.id ??
              null,
            s.mainWindowId
          ),
        10000,
        'the private window'
      )
      try {
        return await privateCookiesSwitch(s, privateWindowId)
      } finally {
        await closeExtraWindows(s)
      }
    })

    // History, the bookmarks manager and Downloads are page tabs like Settings (design language
    // v2 §10.1, styling pass 6): the chord opens one `zenium://<page>` tab per window – a sidebar
    // row titled for the page, the pill on the `zenium://` address (the title where it cannot
    // fit), the address in the pill's tooltip – a second press refocuses that tab instead of
    // opening another, and Ctrl+W closes it like any tab. Escape does nothing to a tab.
    const pageTabStep = async (name, combo, testId, title, address, still) => {
      await s.reset()
      const page = s.chrome.locator(`[data-testid="${testId}"]`)
      const rowsBefore = await s.sidebarTabCount()
      await s.press(combo)
      await page.first().waitFor({ state: 'visible', timeout: 8000 })
      await waitFor(
        async () => (await s.sidebarTabCount()) === rowsBefore + 1,
        8000,
        `a sidebar row for the ${title} tab (${rowsBefore} rows before)`
      )
      await s.settle()
      const heading = await page
        .getByRole('heading', { name: title, exact: true })
        .first()
        .textContent()
      if ((heading ?? '').trim() !== title) {
        throw new Error(`the ${name} page's heading reads "${heading}", expected "${title}"`)
      }
      const activeTitle = await s.chrome
        .locator('[data-testid="tab"][data-active="true"] [data-testid="tab-title"]')
        .first()
        .textContent()
      if ((activeTitle ?? '').trim() !== title) {
        throw new Error(`the active sidebar row is "${activeTitle}", expected "${title}"`)
      }
      const pill = s.chrome.locator('[role="group"][aria-label="Address"]').first()
      const reads = await pill.locator('[data-reads]').first().getAttribute('data-reads')
      const shown = ((await pill.locator(':scope > button').first().textContent()) ?? '').trim()
      const expected = reads === 'title' ? title : address
      if (!['address', 'title'].includes(reads ?? '') || shown !== expected) {
        throw new Error(`the pill reads "${shown}" (${reads}), expected "${expected}"`)
      }
      const tooltip = await pill.getAttribute('title')
      if (tooltip !== address) {
        throw new Error(`the pill's tooltip is "${tooltip}", expected "${address}"`)
      }
      await s.shot(still)
      // The chord again: the one tab is refocused, no second row.
      await s.press(combo)
      await s.settle()
      const rowsAfterSecondPress = await s.sidebarTabCount()
      if (rowsAfterSecondPress !== rowsBefore + 1) {
        throw new Error(
          `a second ${combo} left ${rowsAfterSecondPress} sidebar rows, expected ${rowsBefore + 1} (one ${title} tab per window)`
        )
      }
      if (!(await page.first().isVisible())) {
        throw new Error(`a second ${combo} hid the ${name} page`)
      }
      await s.press(`${ACCEL}+w`)
      await page.first().waitFor({ state: 'hidden', timeout: 8000 })
      await waitFor(
        async () => (await s.sidebarTabCount()) === rowsBefore,
        8000,
        `the ${title} row gone (${rowsBefore} rows before)`
      )
      return { heading: heading.trim(), address: shown, reads, tooltip, rows: rowsBefore }
    }

    await s.step('history', () =>
      pageTabStep(
        'history',
        `${ACCEL}+h`,
        'history-page',
        'History',
        'zenium://history',
        '06-history'
      )
    )

    await s.step('bookmarks-manager', () =>
      pageTabStep(
        'bookmarks manager',
        `${ACCEL}+Shift+o`,
        'bookmarks-manager',
        'Bookmarks',
        'zenium://bookmarks',
        '07-bookmarks-manager'
      )
    )

    await s.step('settings', async () => {
      await s.reset()
      // Settings is a page tab (design language v2 §10): a view-less tab of the chrome's own
      // document, `zenium://settings` in the pill, the §10.5 two-pane inside it.
      const page = s.chrome.locator('[data-testid="settings-page"]')
      const rowsBefore = await s.sidebarTabCount()
      if (IS_MAC) {
        await s.press('Meta+,')
      } else {
        // No default Settings shortcut outside macOS: the toolbar "⋯" button opens the in-chrome
        // application menu – a `.zen-v2-menu` popover of the chrome document under the button
        // (design language v2 §6 "Menus"), not the OS's menu, so no native-menu hook here – and
        // its "Settings" row is a menuitem to click. The page under it stays undimmed (§9.20).
        const button = s.chrome.locator('[data-zen-app-menu-button]').first()
        await button.click({ timeout: 5000 })
        const menu = s.chrome.locator('.zen-v2-menu[role="menu"]').first()
        await menu.waitFor({ state: 'visible', timeout: 5000 })
        if ((await button.getAttribute('aria-expanded')) !== 'true') {
          throw new Error('the "⋯" button is not marked aria-expanded while its menu stands')
        }
        if (await s.chrome.locator('[data-testid="content-dim"]').first().isVisible()) {
          throw new Error('the page under the app menu is dimmed (§9.20: no scrim under a menu)')
        }
        await s.shot('07b-app-menu')
        await menu.getByRole('menuitem', { name: 'Settings', exact: true }).click({ timeout: 5000 })
        await menu.waitFor({ state: 'hidden', timeout: 5000 })
      }
      await page.first().waitFor({ state: 'visible', timeout: 10000 })
      await waitFor(
        async () => (await s.sidebarTabCount()) === rowsBefore + 1,
        8000,
        `a sidebar row for the Settings tab (${rowsBefore} rows before)`
      )
      await s.settle()
      const activeTitle = await s.chrome
        .locator('[data-testid="tab"][data-active="true"] [data-testid="tab-title"]')
        .first()
        .textContent()
      if ((activeTitle ?? '').trim() !== 'Settings') {
        throw new Error(`the active sidebar row is "${activeTitle}", expected "Settings"`)
      }
      // The pill: `zenium://settings` while its field fits the address, the page's title
      // "Settings" once it does not (the sidebar's default width, §10.1's chrome note); the
      // tooltip carries the `zenium://` address either way, never `zen://`.
      const pill = s.chrome.locator('[role="group"][aria-label="Address"]').first()
      const reads = await pill.locator('[data-reads]').first().getAttribute('data-reads')
      const address = ((await pill.locator(':scope > button').first().textContent()) ?? '').trim()
      const expected = reads === 'title' ? 'Settings' : 'zenium://settings'
      if (!['address', 'title'].includes(reads ?? '') || address !== expected) {
        throw new Error(`the pill reads "${address}" (${reads}), expected "${expected}"`)
      }
      const tooltip = await pill.getAttribute('title')
      if (tooltip !== 'zenium://settings') {
        throw new Error(`the pill's tooltip is "${tooltip}", expected "zenium://settings"`)
      }
      await s.shot('08-settings')
      // Ctrl+F on the tab is "Find in Settings" (the page claims `find.open`), not the find bar;
      // Escape with nothing to clear leaves the field and the tab stays.
      await s.press(`${ACCEL}+f`)
      const owner = await waitFor(
        async () => {
          const o = await s.keyboardOwner()
          return o === 'chrome:settings-find' ? o : null
        },
        5000,
        'the keyboard in Find in Settings'
      )
      if (await s.chrome.locator('[data-testid="find-bar"]').first().isVisible()) {
        throw new Error('the find bar opened over the Settings tab')
      }
      await s.press('Escape')
      const after = await waitFor(
        async () => {
          const o = await s.keyboardOwner()
          return o !== 'chrome:settings-find' ? o : null
        },
        5000,
        'Escape leaving Find in Settings'
      )
      if (!(await page.first().isVisible())) throw new Error('Escape closed the Settings tab')
      // Ctrl+W closes the tab like any other.
      await s.press(`${ACCEL}+w`)
      await page.first().waitFor({ state: 'hidden', timeout: 8000 })
      await waitFor(
        async () => (await s.sidebarTabCount()) === rowsBefore,
        8000,
        `the Settings row gone (${rowsBefore} rows before)`
      )
      return { address, reads, tooltip, owner, after, rows: rowsBefore }
    })

    await s.step('context-menu', async () => {
      await s.reset()
      const tab = (await s.tabs()).find((t) => t.url.startsWith(page.url))
      if (!tab) throw new Error('the fixture tab is missing')
      const menusBefore = await s.app.evaluate(() => globalThis.__smoke.menus.length)
      await s.app.evaluate(() => {
        globalThis.__smoke.autoCloseMenuMs = 1200
      })
      await s.app.evaluate(({ webContents }, id) => {
        const wc = webContents.fromId(id)
        wc.focus()
        wc.sendInputEvent({ type: 'mouseDown', button: 'right', x: 200, y: 150, clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', button: 'right', x: 200, y: 150, clickCount: 1 })
      }, tab.id)
      const menu = await waitFor(
        () =>
          s.app.evaluate((_electron, n) => {
            const m = globalThis.__smoke.menus
            return m.length > n ? { items: m[m.length - 1].items.length } : null
          }, menusBefore),
        10000,
        'page context menu recorded'
      )
      await s.shot('09-context-menu')
      await waitFor(
        () => s.app.evaluate(() => globalThis.__smoke.menus.at(-1).closed),
        8000,
        'context menu closed by the hook'
      )
      await s.app.evaluate(() => {
        globalThis.__smoke.autoCloseMenuMs = 0
      })
      await s.press('Escape')
      return { items: menu.items }
    })

    await s.step('second-instance', async () => {
      await s.reset()
      const rowsBefore = await s.sidebarTabCount()
      const t = Date.now()
      const handoff = bootSite.handoff
      const child = spawn(opts.exe, [...s.launchArgs(), handoff.url], {
        stdio: 'ignore',
        env: s.launchEnv()
      })
      const childExit = new Promise((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - t }))
      )
      child.on('error', (e) => log(`second instance spawn error: ${e.message}`))
      const tab = await s.waitForTab(handoff.url, 30000)
      await s.sidebarTab(handoff.title).first().waitFor({ state: 'visible', timeout: 15000 })
      await waitFor(
        async () => (await s.sidebarTabCount()) === rowsBefore + 1,
        15000,
        `a sidebar row for the handed-over URL (${rowsBefore} rows before)`
      )
      const exit = await Promise.race([childExit, delay(15000).then(() => null)])
      if (!exit) {
        child.kill()
        throw new Error('second instance still running after 15 s')
      }
      if (exit.code !== 0) throw new Error(`second instance exited with code ${exit.code}`)
      await s.shot('10-second-instance-tab')
      return { tab: tab.url, secondInstance: exit, windows: await s.windowCount() }
    })

    await s.step('close-window-question', async () => {
      await s.reset()
      const tabs = await s.sidebarTabCount()
      if (tabs < 2) throw new Error(`${tabs} tab open; the question needs several`)
      const prompt = s.chrome.locator('[data-window-prompt="close-tabs"]').first()
      await s.press(`${ACCEL}+Shift+w`)
      await prompt.waitFor({ state: 'visible', timeout: 8000 })
      const asked = await s.windowPrompt()
      await s.shot('11-close-tabs-question')
      if (asked.heading !== `Close ${tabs} tabs?`) {
        throw new Error(`question reads "${asked.heading}" with ${tabs} tabs open`)
      }
      const owner = await s.keyboardOwner()
      await prompt.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 5000 })
      await prompt.waitFor({ state: 'hidden', timeout: 8000 })
      await delay(500)
      const windows = await s.windowCount()
      if (windows !== 1) throw new Error(`${windows} windows after Cancel, expected 1`)
      const after = await s.sidebarTabCount()
      if (after !== tabs) throw new Error(`${after} tabs after Cancel, ${tabs} before`)
      return { ...asked, keyboard: owner, windows, tabs: after }
    })

    await s.step('close-tab', async () => {
      await s.reset()
      const before = await s.sidebarTabCount()
      const liveBefore = (await s.tabs()).map((t) => t.url)
      await s.press(`${ACCEL}+w`)
      const after = await waitFor(
        async () => {
          const n = await s.sidebarTabCount()
          return n === before - 1 ? n : null
        },
        8000,
        `sidebar rows ${before} → ${before - 1} after Ctrl+W`
      )
      await s.settle()
      const windows = await s.windowCount()
      if (windows !== 1) throw new Error(`${windows} windows after Ctrl+W, expected 1`)
      return { before, after, liveBefore, liveAfter: (await s.tabs()).map((t) => t.url) }
    })

    // The two pop-up regressions #142 fixed, on a local fixture shaped like "Sign in with
    // Google": a button inside a cross-origin (out-of-process) iframe opens `window.open(…,
    // 'width=500,height=600')` on a real click. The frame's gesture has to reach the pop-up
    // blocker (Electron reports input for the top document's widget only), and the pop-up's page
    // has to run the page preload (the adopted guest once came without its webPreferences).
    await s.step('popup-from-iframe', async () => {
      await s.reset()
      const fixture = await startPopupFixture()
      const detail = {
        fixture: { top: fixture.topUrl, frame: fixture.frameUrl, popup: fixture.popupUrl }
      }
      try {
        const rowsBefore = await s.sidebarTabCount()
        const windowsBefore = await s.windowCount()
        const { tab } = await openUrlInNewTab(s, fixture.topUrl)
        const frame = await waitFor(
          () => s.frameIn(tab.id, fixture.frameOrigin),
          15000,
          `the ${fixture.frameOrigin} frame in the fixture tab`
        )
        if (!frame.outOfProcess) {
          throw new Error(
            `the ${fixture.frameOrigin} frame shares the top document's process; the fixture is not out of process: ${JSON.stringify(frame)}`
          )
        }
        await waitFor(
          () =>
            s.frameEval(tab.id, fixture.frameOrigin, 'Boolean(window.__smoke)').catch(() => false),
          10000,
          "the frame's script"
        )
        detail.frame = frame

        // The button's place on the screen: the tab view in the window, the iframe in the page,
        // the button in the frame.
        const view = await s.tabViewScreenRect(tab.id)
        if (!view) throw new Error(`no view for tab ${tab.id} in window ${s.mainWindowId}`)
        const rectOf = (selector) =>
          `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()`
        const frameRect = await s.tabEval(tab.id, rectOf('#frame'))
        const buttonRect = await s.frameEval(tab.id, fixture.frameOrigin, rectOf('#open'))
        const zoom = (await s.tabs()).find((t) => t.id === tab.id)?.zoomFactor ?? 1
        const point = buttonScreenPoint({
          view,
          frame: frameRect,
          button: buttonRect,
          zoom,
          scale: view.scale
        })
        detail.geometry = { view, frameRect, buttonRect, zoom, point }
        if (!point.inside) {
          throw new Error(
            `the frame's button is outside the tab view: ${JSON.stringify(detail.geometry)}`
          )
        }

        await s.bringToFront()
        await s.settle()
        xdotoolClick(point.x, point.y)
        // The frame saw the click (else the point was off, a harness matter, not a pop-up one)
        // and its handler ran to the end: `opened` is a boolean once window.open() has returned.
        // (It is null while the call is in its synchronous ask of the browser, during which the
        // frame still answers executeJavaScript – a read at that moment would say "no handle".)
        const clicked = await waitFor(
          async () => {
            const st = await s.frameEval(tab.id, fixture.frameOrigin, 'window.__smoke')
            return st.clicks > 0 && typeof st.opened === 'boolean' ? st : null
          },
          8000,
          `the frame's button clicked at ${point.x},${point.y} and its window.open() returned`
        )
        detail.frameAfterClick = clicked
        // (2) Inside the frame, window.open() returned a handle.
        if (clicked.opened !== true) {
          detail.windowsAfterClick = await s.windowCount()
          throw new Error(
            `window.open() from the cross-origin frame returned null on a real click (trusted: ${clicked.trusted}, windows: ${detail.windowsAfterClick}): the frame's gesture did not reach the pop-up blocker`
          )
        }

        // (1) A second window, its chrome the toolbar-only pop-up kind: no sidebar rows.
        await waitFor(
          async () => (await s.windowCount()) === windowsBefore + 1,
          10000,
          'the pop-up window'
        )
        const popupPage = await chromePageWithChrome(s, 'popup', 10000)
        const [popupWindowId] = await s.otherWindowIds()
        const popupWindow = await s.window(popupWindowId)
        await popupPage
          .locator('[data-testid="toolbar"]')
          .first()
          .waitFor({ state: 'visible', timeout: 5000 })
        const popupSidebarRows = await popupPage.locator('[data-testid="tab"]').count()
        if (popupSidebarRows) {
          throw new Error(`the pop-up window's chrome shows ${popupSidebarRows} sidebar tab rows`)
        }
        detail.popupWindow = { ...popupWindow, sidebarRows: popupSidebarRows, chrome: 'popup' }

        // (3) The pop-up's page kept its opener and its postMessage round trip resolves;
        // (4) the page preload ran there: Chrome's `chrome.app` / `chrome.csi` are in place.
        const popupTab = await s.waitForTab(fixture.popupUrl, 15000)
        const report = await s.tabEval(
          popupTab.id,
          `Promise.race([window.__roundTrip, new Promise((r) => setTimeout(() => r(null), 8000))])
            .then((pong) => ({
              ...window.__smoke,
              pong,
              chromeApp: typeof (window.chrome && window.chrome.app),
              chromeCsi: typeof (window.chrome && window.chrome.csi),
              chromeLoadTimes: typeof (window.chrome && window.chrome.loadTimes)
            }))`
        )
        detail.popupPage = report
        if (report.opener !== true) {
          throw new Error(`window.opener is null in the pop-up: ${JSON.stringify(report)}`)
        }
        if (!report.pong || report.pong.from !== fixture.frameOrigin) {
          throw new Error(
            `the pop-up's postMessage round trip to its opener did not resolve: ${JSON.stringify(report)}`
          )
        }
        if (report.chromeApp !== 'object' || report.chromeCsi !== 'function') {
          throw new Error(
            `the pop-up's page lacks the page preload's chrome members (chrome.app ${report.chromeApp}, chrome.csi ${report.chromeCsi}): the pop-up runs without the preload`
          )
        }
        await s.bringToFront(popupWindowId)
        await s.settle(popupPage)
        await shot(`${s.scenario}-12-popup-window`)

        // alert() from the pop-up's page: Zenium's tab-modal dialog in the pop-up window's chrome,
        // not the engine's native box. The page blocks in its synchronous ask until the dialog is
        // answered, so the call is not awaited; Escape in the pop-up's chrome dismisses it.
        await s.app.evaluate(({ webContents }, id) => {
          const wc = webContents.fromId(id)
          if (!wc || wc.isDestroyed()) throw new Error(`pop-up webContents ${id} is gone`)
          wc.executeJavaScript("alert('smoke')").catch(() => undefined)
          return true
        }, popupTab.id)
        const dialog = popupPage.locator('[data-page-dialog="alert"]').first()
        await dialog.waitFor({ state: 'visible', timeout: 10000 })
        const role = await dialog.getAttribute('role')
        const title = ((await dialog.getByRole('heading').first().textContent()) ?? '').trim()
        const text = ((await dialog.textContent()) ?? '').replace(/\s+/g, ' ').trim()
        if (role !== 'alertdialog' && role !== 'dialog') {
          throw new Error(`the pop-up's alert has role "${role}"`)
        }
        if (!title.endsWith(' says')) throw new Error(`the pop-up's alert is titled "${title}"`)
        if (!text.includes('smoke')) throw new Error(`the pop-up's alert reads "${text}"`)
        // The dialog belongs to the pop-up's tab: the main window's chrome shows none.
        const mainWindowDialogs = await s.chrome.locator('[data-page-dialog]').count()
        if (mainWindowDialogs) {
          throw new Error(`${mainWindowDialogs} page dialogs in the main window's chrome`)
        }
        detail.alert = { role, title, text }
        await shot(`${s.scenario}-13-popup-alert`)
        await s.press('Escape', popupWindowId)
        await dialog.waitFor({ state: 'hidden', timeout: 8000 })
        // Answered: the page's alert() returned and the page runs again.
        await withTimeout(
          s.tabEval(popupTab.id, '1 + 1'),
          8000,
          "the pop-up's page after the alert"
        )

        // (5) window.close() from the pop-up's page closes the pop-up window.
        await s.app.evaluate(({ webContents }, id) => {
          const wc = webContents.fromId(id)
          if (wc && !wc.isDestroyed()) wc.executeJavaScript('window.close()').catch(() => undefined)
          return true
        }, popupTab.id)
        await waitFor(
          async () => (await s.windowCount()) === windowsBefore,
          10000,
          'the pop-up window closed by window.close()'
        )
        const handleClosed = await waitFor(
          () =>
            s.frameEval(
              tab.id,
              fixture.frameOrigin,
              'window.__popup ? window.__popup.closed : null'
            ),
          5000,
          "the frame's handle reporting the pop-up closed"
        )
        detail.afterClose = { windows: await s.windowCount(), handleClosed }

        // The fixture tab goes too: the tabs are as they were before the step.
        await s.press(`${ACCEL}+w`)
        await waitFor(
          async () => (await s.sidebarTabCount()) === rowsBefore,
          8000,
          `sidebar rows back to ${rowsBefore} after closing the fixture tab`
        )
        detail.requests = fixture.requests
        return detail
      } catch (e) {
        // The failure keeps what was gathered up to it (geometry, the frame's state, the window).
        detail.windowsAtFailure = await s.windowCount().catch(() => null)
        detail.requests = fixture.requests
        if (e && typeof e === 'object') e.detail = detail
        throw e
      } finally {
        if ((await s.windowCount().catch(() => 1)) > 1) {
          await closeExtraWindows(s).catch(() => undefined)
        }
        await fixture.close()
      }
    })

    await s.step('quit', async () => {
      await s.reset()
      const r = await s.quitGracefully()
      out.stateAfterQuit = assertCleanState(userData, page.url)
      return { ...r, state: out.stateAfterQuit }
    })
  })
}

/**
 * The run that does not end well (#129): the profile from `boot` is killed while it runs, which
 * leaves the state file with `cleanExit: false`. The next launch lists the tabs but loads no
 * page, offers "Restore pages?", Restore brings the fixture's page back, and a graceful quit
 * marks the profile clean again.
 */
async function scenarioCrash() {
  const userData = path.join(profileRoot, 'profile')
  const page = bootSite.first
  const stateBeforeCrash = readState(userData)
  const killed = await runScenario('crash', userData, {}, async (s, out) => {
    out.stateBefore = stateBeforeCrash
    await s.step('running-marker', async () => {
      await s.sidebarTab(page.title).first().waitFor({ state: 'visible', timeout: 15000 })
      await s.waitForTab(page.url, 30000)
      // The first write of the run carries the marker (the startup commit is debounced).
      const state = await waitFor(
        () => {
          const st = readState(userData)
          return st.cleanExit === false ? st : null
        },
        15000,
        'state.json with cleanExit: false while the app runs',
        250
      )
      return { before: out.stateBefore.cleanExit, running: state.cleanExit, tabs: state.tabs }
    })
    await s.step('kill', async () => {
      const exit = await s.kill()
      out.stateAfterKill = readState(userData)
      if (out.stateAfterKill.cleanExit !== false) {
        throw new Error(`killed run left cleanExit ${JSON.stringify(out.stateAfterKill.cleanExit)}`)
      }
      return { exit, state: out.stateAfterKill }
    })
  })
  if (killed.fatal) return killed

  const stateAfterCrash = readState(userData)
  return runScenario('crash-restore', userData, {}, async (s, out) => {
    out.stateBefore = stateAfterCrash
    await s.step('restore-offer', async () => {
      if (stateAfterCrash.cleanExit !== false) {
        throw new Error(`profile not marked as crashed: ${JSON.stringify(stateAfterCrash)}`)
      }
      const bar = s.chrome.locator('[data-crash-restore]').first()
      await bar.waitFor({ state: 'visible', timeout: 15000 })
      await s.sidebarTab(page.title).first().waitFor({ state: 'visible', timeout: 15000 })
      await s.settle()
      const text = ((await bar.textContent()) ?? '').replace(/\s+/g, ' ').trim()
      const m = /Restore (\d+) pages?/.exec(text)
      if (!m) throw new Error(`restore bar reads "${text}"`)
      const offered = Number(m[1])
      const persisted = out.stateBefore.tabs?.length ?? 0
      if (offered !== persisted) {
        throw new Error(
          `bar offers ${offered} pages, state.json lists ${persisted} tabs: "${text}"`
        )
      }
      // Held back: the tabs are listed, no page of theirs is loaded yet.
      const loaded = (await s.tabs()).filter((t) => isWebPage(t.url))
      if (loaded.length) {
        throw new Error(`pages loaded before the answer: ${loaded.map((t) => t.url).join(', ')}`)
      }
      await s.shot('01-restore-offer')
      return { text, offered, persisted }
    })
    await s.step('restore', async () => {
      const bar = s.chrome.locator('[data-crash-restore]').first()
      await bar
        .getByRole('button', { name: 'Restore', exact: true })
        .click({ timeout: FIRST_PAINT_CLICK_MS })
      const tab = await s.waitForTab(page.url, 45000)
      await bar.waitFor({ state: 'hidden', timeout: 8000 })
      await s.shot('02-restored-after-crash')
      return { url: tab.url, title: tab.title, sidebarTabs: await s.sidebarTabCount() }
    })
    await s.step('quit', async () => {
      const r = await s.quitGracefully()
      return { ...r, state: assertCleanState(userData, page.url) }
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Clear browsing data on exit (#310)
// ---------------------------------------------------------------------------------------------

/** What the quit run's profile clears on exit: the cookies (the jar and the site storage) and the cache. */
const CLEAR_ON_EXIT_TYPES = ['cookies', 'cache']

/**
 * The fixture's cookie in tab `tab`, read three ways that have to agree: the page's
 * (`window.__smoke.has`, what `document.cookie` held as the page loaded), the jar's (the tab's
 * session, asked from the main process) and the wire's (the fixture's requests for the cookie
 * page from watermark `from` on: did the browser send the Cookie header?).
 */
async function cookieReadings(s, fixture, tab, from) {
  const page = await waitFor(
    () => s.tabEval(tab.id, 'window.__smoke || null').catch(() => null),
    10000,
    `the cookie page's reading in tab ${tab.id}`
  )
  const jar = await s.tabCookies(tab.id, FIXTURE_COOKIE.name)
  const wire = cookieRequests(fixture.requests, COOKIE_PATH, FIXTURE_COOKIE.name, from)
  return { page, jar, wire }
}

/** The cookie is there, persistent, and went out on every request for the page. */
function assertCookiePresent({ page, jar, wire }) {
  const { name, value } = FIXTURE_COOKIE
  if (page.has !== true) {
    throw new Error(`the page reads no ${name} cookie: ${JSON.stringify(page)}`)
  }
  if (jar.cookies.length !== 1 || jar.cookies[0].value !== value) {
    throw new Error(
      `the jar holds ${JSON.stringify(jar.cookies)}, expected one ${name}=${value} (${jar.storagePath})`
    )
  }
  if (jar.cookies[0].session !== false) {
    throw new Error(
      `${name} is a session cookie (the jar would not write it to disk): ${JSON.stringify(jar.cookies[0])}`
    )
  }
  if (wire.total < 1 || wire.withCookie !== wire.total) {
    throw new Error(
      `the Cookie header went out on ${wire.withCookie} of ${wire.total} requests for ${COOKIE_PATH}: ${JSON.stringify(wire.cookies)}`
    )
  }
}

/** The cookie is gone from the page, the jar and every request for the page. */
function assertCookieGone({ page, jar, wire }) {
  const { name } = FIXTURE_COOKIE
  if (page.has !== false) {
    throw new Error(`the page still reads the ${name} cookie: ${JSON.stringify(page)}`)
  }
  if (jar.cookies.length) {
    throw new Error(`the jar still holds ${JSON.stringify(jar.cookies)} (${jar.storagePath})`)
  }
  if (wire.total < 1) {
    throw new Error(
      `no request for ${COOKIE_PATH} reached the fixture: the tab did not load from it`
    )
  }
  if (wire.withCookie) {
    throw new Error(
      `the Cookie header went out on ${wire.withCookie} of ${wire.total} requests for ${COOKIE_PATH}: ${JSON.stringify(wire.cookies)}`
    )
  }
}

/**
 * `/cookie-set.html` through the URL bar (a persistent first-party cookie from a Set-Cookie
 * header, the tab landing on `/cookie.html`, which reads it and sets nothing), then the three
 * readings, which have to find the cookie. The step's detail.
 */
async function setFixtureCookie(s, fixture, shotName) {
  const from = fixture.requests.length
  const { tab, sidebarTabs } = await openUrlInNewTab(s, fixture.cookieSetUrl, {
    landsOn: fixture.cookieUrl
  })
  const readings = await cookieReadings(s, fixture, tab, from)
  await s.shot(shotName)
  assertCookiePresent(readings)
  return { tab: { id: tab.id, url: tab.url }, sidebarTabs, ...readings }
}

/**
 * The tab restored on `/cookie.html` (loaded, no "Restore pages?" bar) and the three readings
 * from the launch's watermark `from`, which have to find the cookie gone. The step's detail.
 */
async function restoredCookiePageWithoutCookie(s, fixture, from, shotName) {
  let tab
  try {
    tab = await s.waitForTab(fixture.cookieUrl, 30000)
  } catch (e) {
    // What the restore did instead: the tabs, the main-frame load failures, the fixture's log.
    e.detail = {
      tabs: await s.tabs().catch(() => null),
      failedLoads: s.readEvents().filter((ev) => ev.type === 'did-fail-load'),
      requests: fixture.requests.slice(from)
    }
    throw e
  }
  await s.settle()
  const restoreBar = await s.chrome.locator('[data-crash-restore]').count()
  if (restoreBar) throw new Error('"Restore pages?" offered after a graceful quit')
  const readings = await cookieReadings(s, fixture, tab, from)
  await s.shot(shotName)
  assertCookieGone(readings)
  return { tab: { id: tab.id, url: tab.url }, sidebarTabs: await s.sidebarTabCount(), ...readings }
}

/**
 * The Linux job's clear browsing data on exit (#310): two profiles, four launches, one fixture
 * server for all of them (a tab restored on the cookie page needs its port back).
 *
 * The quit run. A profile seeded with `privacy.clearOnExit` = cookies + cache (through the
 * harness's state.json write) sets the fixture's cookie and the three readings agree it is
 * there. The quit chord (the preset's) and Quit: `Browser.requestQuit` runs
 * `SiteDataService.runOnExit` once the quit is agreed, ahead of `shutdown`'s final write, with
 * 3 s to spend – the marker written first, dropped on `done`. After the exit: within the 15 s
 * budget, `cleanExit: true`, sitedata.json there and owing nothing (the outcome `done`, read from
 * the file: the service is not reachable from the main process's globals), and the engine's
 * clears on the events log from the chord on – `clearStorageData` on the tab's partition, the
 * cache's – timed. The relaunch restores the tab on `/cookie.html` (a page that sets nothing):
 * the request carries no Cookie header, the page reads none, the jar holds none; a clean quit.
 *
 * The owed clear at launch. A profile without clear-on-exit sets the cookie and quits: nothing
 * cleared, no marker, and the partition's Cookies file names the cookie – it is in the profile.
 * The marker `readPendingClear` takes back is written into sitedata.json by hand; the launch
 * runs it from `start()` ahead of the windows: the field goes null (a debounced write, polled),
 * the restored page loads without the cookie, the jar is empty; a clean quit owing nothing.
 *
 * The `deferred` outcome (an engine clear slower than the 3 s budget) is not deterministic
 * under Xvfb and is left to the service's unit tests.
 */
async function scenarioClearOnExit() {
  const fixture = await startPopupFixture()
  const pages = { set: fixture.cookieSetUrl, read: fixture.cookieUrl, cookie: FIXTURE_COOKIE }
  try {
    // --- The quit run -------------------------------------------------------------------------
    const userData = freshProfile('profile-clear-on-exit', {
      onboardingDone: true,
      settings: { privacy: { clearOnExit: { types: CLEAR_ON_EXIT_TYPES } } }
    })
    const quitRun = await runScenario('clear-on-exit', userData, {}, async (s, out) => {
      out.fixture = pages
      out.clearOnExit = CLEAR_ON_EXIT_TYPES
      await s.step('cookie-set', async () => {
        const detail = await setFixtureCookie(s, fixture, '01-cookie-set')
        out.storagePath = detail.jar.storagePath
        return detail
      })
      await s.step('quit-runs-the-clear', async () => {
        const hooked = s.hookResult?.sessionClears ?? []
        if (!hooked.includes('clearStorageData')) {
          throw new Error(
            `the hook did not wrap session.clearStorageData (wrapped: ${JSON.stringify(hooked)}): the engine's clears cannot be read`
          )
        }
        const chordAt = Date.now()
        const r = await s.quitGracefully()
        const state = assertCleanState(userData, pages.read)
        const siteData = assertNoOwedClear(userData)
        const clears = sessionClearsSince(s.readEvents(), chordAt)
        const detail = { ...r, state, siteData, clears }
        const storage = clears.find(
          (c) => c.method === 'clearStorageData' && c.ok && c.storagePath === out.storagePath
        )
        if (!storage) {
          throw Object.assign(
            new Error(
              `no clearStorageData on ${out.storagePath} between the quit chord and the exit: ${JSON.stringify(clears)}`
            ),
            { detail }
          )
        }
        if (!clears.some((c) => c.method === 'clearCache' && c.ok)) {
          throw Object.assign(
            new Error(
              `no clearCache between the quit chord and the exit: ${JSON.stringify(clears)}`
            ),
            { detail }
          )
        }
        return detail
      })
    })
    if (quitRun.fatal) return quitRun

    const stateBefore = readState(userData)
    const relaunchFrom = fixture.requests.length
    const relaunch = await runScenario('clear-on-exit-relaunch', userData, {}, async (s, out) => {
      out.stateBefore = stateBefore
      await s.step('cookie-gone', async () => {
        if (stateBefore.cleanExit !== true) {
          throw new Error(`profile not marked cleanly exited: ${JSON.stringify(stateBefore)}`)
        }
        return restoredCookiePageWithoutCookie(
          s,
          fixture,
          relaunchFrom,
          '02-cookie-gone-after-quit'
        )
      })
      await s.step('quit', async () => {
        const r = await s.quitGracefully()
        return {
          ...r,
          state: assertCleanState(userData, pages.read),
          siteData: assertNoOwedClear(userData)
        }
      })
    })
    if (relaunch.fatal) return relaunch

    // --- The owed clear at launch -------------------------------------------------------------
    const owedData = freshProfile('profile-owed-clear', { onboardingDone: true })
    let storagePath = null
    const seed = await runScenario('clear-on-exit-owed-seed', owedData, {}, async (s, out) => {
      out.fixture = pages
      await s.step('cookie-set', async () => {
        const detail = await setFixtureCookie(s, fixture, '03-owed-seed-cookie-set')
        storagePath = detail.jar.storagePath
        out.storagePath = storagePath
        return detail
      })
      await s.step('quit-keeps-the-cookie', async () => {
        const chordAt = Date.now()
        const r = await s.quitGracefully()
        const state = assertCleanState(owedData, pages.read)
        const siteData = assertNoOwedClear(owedData, { expectFile: false })
        const clears = sessionClearsSince(s.readEvents(), chordAt)
        if (clears.length) {
          throw new Error(
            `a quit without clear-on-exit cleared through the engine: ${JSON.stringify(clears)}`
          )
        }
        // The jar's file names the cookie: it is in the profile for the launch that clears it.
        const store = cookieStoreNames(storagePath, FIXTURE_COOKIE.name)
        if (!store.found) {
          throw new Error(
            `no Cookies file under ${storagePath} names ${FIXTURE_COOKIE.name} after the quit: ${JSON.stringify(store)}`
          )
        }
        return { ...r, state, siteData, clears, store }
      })
    })
    if (seed.fatal) return seed

    // By hand: the marker readPendingClear (src/core/siteData.ts) takes back, as the quit
    // writes it (`noteExiting`): the types, the site lists as they stood (none), when.
    const marker = owedClear({ types: CLEAR_ON_EXIT_TYPES })
    const seeded = writeOwedClear(owedData, marker)
    const launchFrom = fixture.requests.length
    // Awaited here: a `return` of the bare promise would run the `finally` (the fixture's
    // close) before the launch, and the restored tab would find the server gone.
    return await runScenario('clear-on-exit-owed-launch', owedData, {}, async (s, out) => {
      out.fixture = pages
      out.seeded = seeded
      await s.step('owed-clear-consumed', async () => {
        // start() ran the clear ahead of the windows; the marker goes with the run's end (a
        // debounced write, so the file is polled, never read once).
        const siteData = await waitFor(
          () => {
            const sd = readSiteData(owedData)
            return sd.owed === null ? sd : null
          },
          15000,
          `${SITE_DATA_FILE} with pendingClear: null (the owed clear consumed)`,
          250
        )
        // The engine's clears of the launch, when the hook was in place early enough to see them
        // (the run starts before Playwright attaches; recorded, not required).
        return { siteData: siteData.doc, clears: sessionClearsSince(s.readEvents(), 0) }
      })
      await s.step('cookie-gone', () =>
        restoredCookiePageWithoutCookie(s, fixture, launchFrom, '04-owed-clear-at-launch')
      )
      await s.step('quit', async () => {
        const r = await s.quitGracefully()
        return {
          ...r,
          state: assertCleanState(owedData, pages.read),
          siteData: assertNoOwedClear(owedData)
        }
      })
    })
  } finally {
    await fixture.close()
  }
}

async function scenarioScale() {
  const userData = freshProfile('profile-scale', { onboardingDone: true })
  return runScenario(
    'scale',
    userData,
    { args: ['--force-device-scale-factor=1.5'] },
    async (s) => {
      await s.step('scale-1.5', async () => {
        const dpr = await s.chrome.evaluate(() => ({
          devicePixelRatio: window.devicePixelRatio,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight
        }))
        if (Math.abs(dpr.devicePixelRatio - 1.5) > 0.01) {
          throw new Error(`devicePixelRatio is ${dpr.devicePixelRatio}, expected 1.5`)
        }
        await s.shot('01-scale-150')
        return { ...dpr, window: await s.window() }
      })
      await s.step('quit', async () => s.quitGracefully())
    }
  )
}

// OS dark mode. Windows: the Personalize registry keys Chromium watches. macOS: System Events
// posts the theme-changed notification (`defaults write` alone would not reach running apps).
function setOsDarkMode(on) {
  if (IS_WIN) {
    const v = on ? '0' : '1'
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
    const a = sh('reg', ['add', key, '/v', 'AppsUseLightTheme', '/t', 'REG_DWORD', '/d', v, '/f'])
    const b = sh('reg', [
      'add',
      key,
      '/v',
      'SystemUsesLightTheme',
      '/t',
      'REG_DWORD',
      '/d',
      v,
      '/f'
    ])
    return {
      ok: a.status === 0 && b.status === 0,
      detail: a.stderr || b.stderr || 'registry updated'
    }
  }
  if (IS_MAC) {
    const r = osascript(
      `tell application "System Events" to tell appearance preferences to set dark mode to ${on ? 'true' : 'false'}`
    )
    return { ok: r.status === 0, detail: r.stderr || r.stdout || 'System Events accepted' }
  }
  return { ok: false, detail: 'no OS theme switch on this platform' }
}

async function scenarioDark() {
  const userData = freshProfile('profile-dark', { onboardingDone: true })
  const osSwitch = setOsDarkMode(true)
  log(`OS dark mode: ${JSON.stringify(osSwitch)}`)
  try {
    return await runScenario('dark', userData, {}, async (s, out) => {
      out.osSwitch = osSwitch
      await s.step('dark-mode', async () => {
        let source = 'os'
        if (osSwitch.ok) {
          // The OS accepted the switch; give Chromium a moment to pick the new theme up.
          const reached = await waitFor(
            () => s.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors || null),
            8000,
            'OS dark mode reached nativeTheme'
          ).catch(() => false)
          if (!reached) source = 'nativeTheme.themeSource (OS switch did not reach the app)'
        } else {
          source = 'nativeTheme.themeSource'
        }
        if (source !== 'os') {
          // No effective OS-level switch (Linux under Xvfb, macOS runners without UI scripting
          // rights): drive Chromium's nativeTheme directly so the chrome still renders its dark
          // palette for the screenshot.
          log(`dark mode source: ${source}`)
          await s.app.evaluate(({ nativeTheme }) => {
            nativeTheme.themeSource = 'dark'
          })
        }
        const facts = await waitFor(
          async () => {
            const theme = await s.app.evaluate(({ nativeTheme }) => ({
              shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
              themeSource: nativeTheme.themeSource
            }))
            const chrome = await s.chrome.evaluate(() => {
              const root = document.querySelector('[data-testid="chrome-root"]')
              return {
                dataDark: root?.getAttribute('data-dark'),
                prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
                background: root ? getComputedStyle(root).backgroundColor : null
              }
            })
            return theme.shouldUseDarkColors && chrome.dataDark === 'true'
              ? { theme, chrome }
              : null
          },
          15000,
          'nativeTheme dark and chrome data-dark=true',
          300
        )
        await s.shot('01-dark-mode')
        return { source, ...facts }
      })
      await s.step('quit', async () => s.quitGracefully())
    })
  } finally {
    if (osSwitch.ok) log(`OS dark mode reset: ${JSON.stringify(setOsDarkMode(false))}`)
  }
}

// ---------------------------------------------------------------------------------------------

function finish(exitCode) {
  const failures = []
  for (const sc of Object.values(result.scenarios)) {
    if (sc.session) failures.push(...sc.session.failures)
    if (sc.fatal && !sc.session?.steps?.some((st) => !st.ok)) {
      failures.push({ kind: 'harness', message: sc.fatal })
    }
  }
  if (result.fatal) failures.push({ kind: 'harness', message: result.fatal })
  const gated = failures.filter((f) => !f.info)
  const info = failures.filter((f) => f.info)
  let entries = []
  try {
    entries = loadKnownFailures(allowlistFile)
  } catch (e) {
    gated.push({ kind: 'harness', message: `allowlist: ${e.message}` })
  }
  const verdict = classifyFailures(gated, entries, context)
  result.failures = failures
  result.verdict = {
    ok: verdict.ok,
    known: verdict.known.map((k) => ({ id: k.id, ...k.failure })),
    unexpected: verdict.unexpected,
    unusedAllowlist: verdict.unused,
    informational: info,
    allowlist: entries.map((e) => e.id)
  }
  // What the fixture served: the pages the run loaded came from 127.0.0.1, or the log says which
  // did not arrive.
  if (bootSite) result.fixture = { origin: bootSite.origin, requests: bootSite.requests }
  result.finishedAt = new Date().toISOString()
  writeJson(path.join(outDir, 'result.json'), result)

  log(`== ${opts.label} (${process.platform} ${process.arch}) ==`)
  for (const [name, sc] of Object.entries(result.scenarios)) {
    if (sc.skipped) {
      log(`${name.padEnd(8)} skipped: ${sc.skipped} (${sc.note})`)
      continue
    }
    const steps = sc.session?.steps ?? []
    const failed = steps.filter((st) => !st.ok).map((st) => st.name)
    const t = sc.session?.timings ?? {}
    log(
      `${name.padEnd(8)} steps ${steps.length} failed ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}` +
        ` chrome ${t.chromeRenderedMs ?? '-'} ms` +
        (sc.session?.exit ? ` exit ${sc.session.exit.code}` : '') +
        (sc.note ? ` ${sc.note}` : '') +
        (sc.fatal ? ` FATAL ${sc.fatal.split('\n')[0]}` : '')
    )
  }
  for (const k of result.verdict.known) log(`known ${k.id}: ${formatFailure(k)}`)
  for (const f of result.verdict.unexpected) log(`UNEXPECTED ${formatFailure(f)}`)
  for (const f of info) log(`info ${formatFailure(f)}`)
  if (verdict.unused.length) log(`allowlist entries nothing matched: ${verdict.unused.join(', ')}`)
  log(
    `verdict: ${verdict.ok ? 'PASS' : 'FAIL'} (${result.verdict.unexpected.length} unexpected, ${result.verdict.known.length} known)`
  )
  process.exit(exitCode ?? (verdict.ok ? 0 : 1))
}

async function main() {
  log(`smoke ${opts.label}: exe=${opts.exe} scenarios=${scenarios.join(',')} out=${outDir}`)
  log(`allowlist ${allowlistFile}; profiles under ${profileRoot}`)
  const watchdog = setTimeout(() => {
    const where = `${currentSession?.scenario ?? '-'}/${currentSession?.steps.at(-1)?.name ?? '-'}`
    result.fatal = `watchdog: run exceeded ${WATCHDOG_MS / 60000} min (at ${where})`
    log(result.fatal)
    if (currentSession && !result.scenarios[currentSession.scenario]) {
      currentSession.saveLogs()
      result.scenarios[currentSession.scenario] = {
        partial: true,
        session: currentSession.summary()
      }
    }
    killAppProcesses()
    finish(3)
  }, WATCHDOG_MS)
  watchdog.unref?.()

  if (!fs.existsSync(opts.exe)) {
    // Nothing to launch (an installer that did not write the executable): one "install" failure
    // the allowlist can name, no scenario runs.
    const message = `executable not found: ${opts.exe}`
    log(message)
    result.scenarios.install = {
      note: message,
      session: { steps: [], failures: [{ kind: 'install', scenario: 'install', message }] }
    }
    return finish()
  }
  // The pages every scenario loads, from this process on 127.0.0.1 for the whole run: `boot`
  // persists their URL, so the port has to hold until `restore` and `crash-restore` have loaded
  // it again (a server that cannot bind fails the run as a harness error).
  bootSite = await startBootFixture()
  result.fixture = { origin: bootSite.origin }
  log(
    `fixture on ${bootSite.origin}: ${[bootSite.first, bootSite.second, bootSite.handoff].map((p) => p.url).join(' ')}`
  )
  for (const name of scenarios) {
    const run = {
      boot: scenarioBoot,
      restore: scenarioRestore,
      walkthrough: scenarioWalkthrough,
      crash: scenarioCrash,
      'clear-on-exit': scenarioClearOnExit,
      scale: scenarioScale,
      dark: scenarioDark
    }[name]
    if (!run) {
      result.scenarios[name] = { fatal: `unknown scenario ${name}` }
      continue
    }
    // A scenario whose profile `boot` failed to leave past onboarding would only meet the
    // onboarding again and time out behind it: reported as skipped, the boot failure gates.
    const reason = skipReason(name, result.scenarios)
    if (reason) {
      for (const [session, entry] of skippedEntries(name, reason)) {
        result.scenarios[session] = entry
        log(`${session}: skipped: ${reason} (${entry.note})`)
      }
      writeJson(path.join(outDir, 'result.json'), result)
      continue
    }
    try {
      await run()
    } catch (e) {
      result.scenarios[name] = { fatal: String(e && (e.stack || e.message || e)) }
      log(`scenario ${name} crashed the harness: ${e.message}`)
    }
    // No instance may survive between scenarios (it would hold the single-instance lock).
    if (currentSession && !currentSession.exit) killAppProcesses()
  }
  clearTimeout(watchdog)
  await bootSite.close()
  finish()
}

main().catch((e) => {
  result.fatal = String(e && (e.stack || e.message || e))
  console.error(e)
  finish(1)
})
