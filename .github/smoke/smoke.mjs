// Zenium desktop boot smoke: launches a packaged build with Playwright for Electron, walks through
// the shortcuts and window behaviour a first-time user hits, records every JS error, crash and
// blocking dialog, takes OS-level screenshots at each step and writes one JSON result per step.
//
//   node smoke.mjs --exe <executable> --label <name> --out <dir>
//        [--scenarios boot,restore,scale,dark] [--extra-args=--no-sandbox]
//        [--allowlist known-failures.json] [--render-budget-ms 10000] [--quit-budget-ms 5000]
//        [--step-timeout-ms 60000] [--evaluate-timeout-ms 30000] [--watchdog-min 15]
//
// Zero tolerated JS errors: a chrome console error, a chrome page error, a preload or Electron-side
// error in a tab view, a main-process exception, a crashed process, a blocking native dialog or a
// failed step is a "failure". Failures matching .github/smoke/known-failures.json are reported by
// their bug id and tolerated; anything else makes the run exit 1. Console errors logged by the web
// pages themselves (https://…) are recorded but never gate.
//
// Exit codes: 0 pass (only known failures, if any), 1 unexpected failures, 2 usage, 3 watchdog.

import { _electron as electron } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyFailures, formatFailure, loadKnownFailures } from './known-failures.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const IS_LINUX = process.platform === 'linux'
const ACCEL = IS_MAC ? 'Meta' : 'Control'

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
const QUIT_BUDGET_MS = Number(opts['quit-budget-ms'] ?? 5000)
const STEP_TIMEOUT_MS = Number(opts['step-timeout-ms'] ?? 60000)
const EVALUATE_TIMEOUT_MS = Number(opts['evaluate-timeout-ms'] ?? 30000)
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
  budgets: { renderMs: RENDER_BUDGET_MS, quitMs: QUIT_BUDGET_MS },
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

async function shot(name, session = null) {
  const file = path.join(outDir, `${String(++shotIndex).padStart(2, '0')}-${name}.png`)
  if (session) {
    await session.bringToFront().catch(() => undefined)
    await session.settle().catch(() => undefined)
  }
  const r = osScreenshot(file)
  const ok = fs.existsSync(file) && fs.statSync(file).size > 0
  if (!ok) log(`screenshot ${name} failed: ${r.stderr || r.stdout || r.error || 'no file'}`)
  result.screenshots.push({ name, file: path.basename(file), ok })
  return path.basename(file)
}

// ---------------------------------------------------------------------------------------------
// Main-process hook. Runs inside the Electron main process through Playwright's Node inspector,
// so it can only use what it receives as arguments. It streams every observation as one JSON line
// to `options.eventsFile` (or, without fs access, to stderr prefixed SMOKE_EVENT), which survives
// the process exiting mid-quit; the harness reads the file, never main-process memory.
// ---------------------------------------------------------------------------------------------

function hookMain({ app, webContents, BrowserWindow, Menu, dialog }, options) {
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
  }
  webContents.getAllWebContents().forEach(hook)
  app.on('web-contents-created', (_e, wc) => hook(wc))
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
  return { hooked: true, transport: smoke.transport }
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
    this.chrome = await this.waitForChromePage(RENDER_BUDGET_MS * 3)
    await this.chrome.locator('[data-testid="chrome-root"]').waitFor({
      state: 'attached',
      timeout: RENDER_BUDGET_MS * 3
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
    page.on('crash', () =>
      this.pageErrors.push({
        kind: 'process-gone',
        scenario: this.scenario,
        at: Date.now(),
        url: page.url(),
        message: 'chrome page crashed (Playwright crash event)'
      })
    )
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

  /** Runs one fenced step; a failure is recorded and the scenario carries on. */
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
      log(`step ${name} FAILED: ${entry.error.split('\n')[0]}`)
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
      }
      if (app.focus) app.focus({ steal: true })
    }, windowId)
  }

  /** Two animation frames in the chrome page: the last DOM change has been committed and painted. */
  settle(page = this.chrome) {
    return withTimeout(
      page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
          )
      ),
      3000,
      'settle'
    ).catch(() => false)
  }

  shot(name) {
    return shot(`${this.scenario}-${name}`, this)
  }

  /** Is the main process event loop free? A modal native dialog blocks it. */
  async mainResponsive(timeoutMs = 4000) {
    return Promise.race([
      this.app.evaluate(() => 'ok').catch((e) => `error: ${e.message}`),
      delay(timeoutMs).then(() => 'blocked')
    ])
  }

  async quitWithShortcut(budgetMs = QUIT_BUDGET_MS) {
    this.quitStartedAt = Date.now()
    await Promise.race([this.press(`${ACCEL}+q`), delay(3000)])
    const exit = await Promise.race([this.exitPromise, delay(budgetMs).then(() => null)])
    const ms = Date.now() - this.quitStartedAt
    if (!exit) {
      const responsive = await this.mainResponsive(3000)
      log(`app did not exit after ${ACCEL}+Q within ${budgetMs} ms (main ${responsive}); closing`)
      await this.forceClose()
      throw new Error(
        `app did not exit within ${budgetMs} ms after ${ACCEL}+Q (main process ${responsive}; exit ${JSON.stringify(this.exit)})`
      )
    }
    if (exit.code !== 0)
      throw new Error(`app exited with code ${exit.code} signal ${exit.signal} after ${ms} ms`)
    return { ms, exit }
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
      if (!st.ok)
        out.push({ kind: 'step', scenario: this.scenario, step: st.name, message: st.error })
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
// within seconds of launching and replace the binary under test on quit.
const HARNESS_SETTINGS = { updates: { autoCheck: false, autoDownload: false, channel: 'stable' } }

function freshProfile(name, { onboardingDone = false } = {}) {
  const dir = path.join(profileRoot, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'zen'), { recursive: true })
  const settings = structuredClone(HARNESS_SETTINGS)
  if (onboardingDone) settings.onboardingDone = true
  writeJson(path.join(dir, 'zen', 'state.json'), { version: 2, settings })
  return dir
}

function readState(userData) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(userData, 'zen', 'state.json'), 'utf8'))
    return {
      version: s.version,
      windows: (s.windows || []).length,
      tabs: (s.tabs || []).map((t) => ({ url: t.url, title: t.title })),
      onboardingDone: s.settings && s.settings.onboardingDone
    }
  } catch (e) {
    return { error: String(e.message) }
  }
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
        if (!facts.userData.startsWith(profileRoot)) {
          throw new Error(`profile not isolated: userData is ${facts.userData}`)
        }
        if (s.timings.chromeRenderedMs > RENDER_BUDGET_MS) {
          throw new Error(
            `chrome rendered after ${s.timings.chromeRenderedMs} ms (budget ${RENDER_BUDGET_MS} ms)`
          )
        }
        return { ...s.timings, ...facts }
      },
      { timeoutMs: RENDER_BUDGET_MS * 3 + 90000, fatal: true }
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

async function openUrlInNewTab(s, url) {
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
  await s.press(`${ACCEL}+t`)
  await input.first().waitFor({ state: 'visible', timeout: 8000 })
  await input.first().fill(url)
  await s.press('Enter')
  return s.waitForTab(url, 45000)
}

async function closeExtraWindows(s) {
  await s.app.evaluate(({ BrowserWindow }, keep) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.id !== keep) w.close()
  }, s.mainWindowId)
  await waitFor(async () => (await s.windowCount()) === 1, 10000, 'extra windows closed')
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

const EXAMPLE_TITLE = 'Example Domain'

async function scenarioBoot() {
  const userData = freshProfile('profile')
  return runScenario('boot', userData, {}, async (s, out) => {
    await s.step('onboarding', async () => {
      const onboarding = s.chrome.locator('[data-testid="onboarding"]')
      await onboarding.waitFor({ state: 'visible', timeout: 10000 })
      await s.shot('01-first-launch')
      await s.chrome.getByRole('button', { name: 'Continue' }).click({ timeout: 5000 })
      await s.chrome.getByRole('button', { name: 'Skip tour' }).click({ timeout: 5000 })
      await onboarding.waitFor({ state: 'detached', timeout: 10000 })
      await s.shot('02-after-onboarding')
      return 'completed'
    })

    await s.step('new-tab-example-com', async () => {
      const tab = await openUrlInNewTab(s, 'https://example.com')
      await s.sidebarTab(EXAMPLE_TITLE).first().waitFor({ state: 'visible', timeout: 15000 })
      out.exampleTab = tab
      await s.shot('03-example-com')
      return {
        url: tab.url,
        title: tab.title,
        sidebarTabs: await s.chrome.locator('[data-testid="tab"]').count()
      }
    })

    await s.step('find-bar', async () => {
      await s.press(`${ACCEL}+f`)
      const bar = s.chrome.locator('[data-testid="find-bar"]')
      await bar.first().waitFor({ state: 'visible', timeout: 8000 })
      const input = s.chrome.locator('[data-testid="find-input"]')
      await input.first().waitFor({ state: 'visible', timeout: 5000 })
      await input.first().fill('Example')
      await s.shot('04-find-bar')
      await s.press('Escape')
      await bar.first().waitFor({ state: 'hidden', timeout: 8000 })
      return 'opened and closed'
    })

    await s.step('zoom', async () => {
      const zoom = async () =>
        (await s.tabs()).find((t) => t.url.startsWith('https://example.com'))?.zoomFactor
      const z0 = await zoom()
      await s.press(`${ACCEL}+=`)
      const z1 = await waitFor(
        async () => {
          const z = await zoom()
          return z > z0 + 0.01 ? z : null
        },
        8000,
        'zoom in'
      )
      await s.press(`${ACCEL}+=`)
      const z2 = await waitFor(
        async () => {
          const z = await zoom()
          return z > z1 + 0.01 ? z : null
        },
        8000,
        'zoom in again'
      )
      await s.shot('05-zoomed-in')
      await s.press(`${ACCEL}+-`)
      const z3 = await waitFor(
        async () => {
          const z = await zoom()
          return z < z2 - 0.01 ? z : null
        },
        8000,
        'zoom out'
      )
      await s.press(`${ACCEL}+0`)
      const z4 = await waitFor(
        async () => {
          const z = await zoom()
          return Math.abs(z - 1) < 0.01 ? z : null
        },
        8000,
        'zoom reset'
      )
      return { z0, z1, z2, z3, z4 }
    })

    await s.step('fullscreen', async () => {
      const combo = IS_MAC ? 'Control+Meta+f' : 'F11'
      await s.press(combo)
      await waitFor(async () => (await s.window())?.fullScreen, 10000, 'window fullscreen', 200)
      await s.shot('06-fullscreen')
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
      await s.press(`${ACCEL}+Shift+p`)
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
      await s.shot('07-three-windows')
      await closeExtraWindows(s)
      return { windows: await s.windowCount() }
    })

    await s.step('settings', async () => {
      const panel = s.chrome.locator('[data-testid="settings-panel"]')
      if (IS_MAC) {
        await s.press('Meta+,')
      } else {
        // No default Settings shortcut outside macOS: the toolbar "Menu" button pops up the native
        // application menu; the hook picks its "Settings" item.
        await s.app.evaluate(() => {
          globalThis.__smoke.autoPickMenuItem = 'Settings'
        })
        await s.chrome.locator('button[title="Menu"]').first().click({ timeout: 5000 })
      }
      await panel.first().waitFor({ state: 'visible', timeout: 10000 })
      await s.shot('08-settings')
      await s.press('Escape')
      await panel.first().waitFor({ state: 'hidden', timeout: 8000 })
      return 'opened and closed'
    })

    await s.step('context-menu', async () => {
      const tab = (await s.tabs()).find((t) => t.url.startsWith('https://example.com'))
      if (!tab) throw new Error('example.com tab missing')
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
      const t = Date.now()
      const child = spawn(opts.exe, [...s.launchArgs(), 'https://example.org'], {
        stdio: 'ignore',
        env: s.launchEnv()
      })
      const childExit = new Promise((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - t }))
      )
      child.on('error', (e) => log(`second instance spawn error: ${e.message}`))
      const tab = await s.waitForTab('https://example.org', 30000)
      await s.sidebarTab(EXAMPLE_TITLE).nth(1).waitFor({ state: 'visible', timeout: 15000 })
      const exit = await Promise.race([childExit, delay(15000).then(() => null)])
      if (!exit) {
        child.kill()
        throw new Error('second instance still running after 15 s')
      }
      if (exit.code !== 0) throw new Error(`second instance exited with code ${exit.code}`)
      await s.shot('10-second-instance-tab')
      return { tab: tab.url, secondInstance: exit, windows: await s.windowCount() }
    })

    await s.step('quit', async () => {
      const r = await s.quitWithShortcut()
      out.stateAfterQuit = readState(userData)
      if (!out.stateAfterQuit.tabs?.some((t) => t.url.startsWith('https://example.com'))) {
        throw new Error(`state.json has no example.com tab: ${JSON.stringify(out.stateAfterQuit)}`)
      }
      return { ...r, state: out.stateAfterQuit }
    })
  })
}

async function scenarioRestore() {
  const userData = path.join(profileRoot, 'profile')
  return runScenario('restore', userData, {}, async (s, out) => {
    out.stateBefore = readState(userData)
    await s.step('restored-tab', async () => {
      await s.sidebarTab(EXAMPLE_TITLE).first().waitFor({ state: 'visible', timeout: 15000 })
      const onboarding = await s.chrome.locator('[data-testid="onboarding"]').count()
      if (onboarding) throw new Error('onboarding shown again on the second launch')
      const tabs = await s.tabs()
      await s.shot('01-restored')
      return {
        sidebarTabs: await s.chrome.locator('[data-testid="tab"]').count(),
        exampleTitles: await s.sidebarTab(EXAMPLE_TITLE).count(),
        liveTabs: tabs.map((t) => t.url),
        persisted: out.stateBefore.tabs
      }
    })
    await s.step('quit', async () => s.quitWithShortcut())
  })
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
      await s.step('quit', async () => s.quitWithShortcut())
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
      await s.step('quit', async () => s.quitWithShortcut())
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
  result.finishedAt = new Date().toISOString()
  writeJson(path.join(outDir, 'result.json'), result)

  log(`== ${opts.label} (${process.platform} ${process.arch}) ==`)
  for (const [name, sc] of Object.entries(result.scenarios)) {
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
  for (const name of scenarios) {
    const run = {
      boot: scenarioBoot,
      restore: scenarioRestore,
      scale: scenarioScale,
      dark: scenarioDark
    }[name]
    if (!run) {
      result.scenarios[name] = { fatal: `unknown scenario ${name}` }
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
  finish()
}

main().catch((e) => {
  result.fatal = String(e && (e.stack || e.message || e))
  console.error(e)
  finish(1)
})
