// Zenium desktop runner smoke: boots a packaged build with Playwright for Electron, drives the
// keyboard shortcuts and window behaviour a first-time user hits, and records JS errors, crashes,
// OS-level screenshots and OS-integration facts. Verification only; nothing here changes the app.
//
//   node smoke.mjs --exe <path-to-executable> --label <name> --out <dir> [--scenarios boot,restore,scale,dark,errordialog]
//
// Every step is fenced: a failing step is recorded in result.json and the run carries on.

import { _electron as electron } from 'playwright'
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const ACCEL = IS_MAC ? 'Meta' : 'Control'

const opts = parseArgs(process.argv.slice(2))
if (!opts.exe || !opts.label || !opts.out) {
  console.error('usage: node smoke.mjs --exe <exe> --label <label> --out <dir> [--scenarios a,b]')
  process.exit(2)
}
const outDir = path.resolve(opts.out, opts.label)
fs.mkdirSync(outDir, { recursive: true })
const scenarios = (opts.scenarios ?? 'boot,restore,scale,dark,errordialog').split(',').filter(Boolean)
// Extra Chromium/Electron switches for every launch (local debugging, e.g. --no-sandbox in a container).
const EXTRA_ARGS = typeof opts['extra-args'] === 'string' ? opts['extra-args'].split(' ').filter(Boolean) : []
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zenium-smoke-${opts.label}-`))
const profile = path.join(profileRoot, 'profile')
// Every main-process evaluate and every step is fenced by a timeout, and the whole run by a
// watchdog: a blocked main process (modal dialog, hung menu) must not stall the runner job.
const EVALUATE_TIMEOUT_MS = Number(opts['evaluate-timeout-ms'] ?? 45000)
const STEP_TIMEOUT_MS = Number(opts['step-timeout-ms'] ?? 180000)
const WATCHDOG_MS = Number(opts['watchdog-min'] ?? 18) * 60 * 1000
const logFile = path.join(outDir, 'smoke.log')
fs.writeFileSync(logFile, '')
let currentSession = null

const result = {
  label: opts.label,
  exe: opts.exe,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  hostname: os.hostname(),
  startedAt: new Date().toISOString(),
  scenarios: {},
  screenshots: [],
  verdict: {}
}
let shotIndex = 0
const logLines = []

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  logLines.push(line)
  console.log(line)
  try {
    fs.appendFileSync(logFile, line + '\n')
  } catch {
    // best effort
  }
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function killAppProcesses() {
  if (IS_WIN) sh('taskkill', ['/F', '/IM', path.basename(opts.exe), '/T'], 20000)
  else sh('pkill', ['-9', '-f', `^${opts.exe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`], 20000)
}

// Partial results survive a hang: whatever the current session recorded goes into result.json.
function flushPartialResult(reason) {
  if (currentSession && !result.scenarios[currentSession.scenario]) {
    result.scenarios[currentSession.scenario] = { partial: true, reason, session: currentSession.summary() }
  }
  writeJson(path.join(outDir, 'result.json'), result)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next
        i++
      } else out[key] = true
    }
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pollUntil(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function ps(scriptName, args, timeout = 60000) {
  const script = path.join(here, scriptName)
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', timeout, windowsHide: true }
  )
  return { status: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() }
}

function sh(cmd, args, timeout = 60000) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout })
  return { status: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() }
}

// OS-level screenshot: the tab pages are WebContentsViews, so Playwright's page.screenshot() only
// shows the chrome layer. Windows copies the primary screen through GDI; macOS uses screencapture.
async function shot(name, page = null) {
  const file = path.join(outDir, `${String(++shotIndex).padStart(2, '0')}-${name}.png`)
  try {
    if (IS_WIN) {
      const r = ps('win-screenshot.ps1', ['-Path', file], 45000)
      if (r.status !== 0) log(`screenshot ${name} failed: ${r.stderr || r.stdout}`)
    } else if (IS_MAC) {
      const r = sh('screencapture', ['-x', '-C', file], 45000)
      if (r.status !== 0) log(`screenshot ${name} failed: ${r.stderr}`)
    } else if (page) {
      // Linux (local debugging only): chrome layer through Playwright, no OS-level capture.
      await page.screenshot({ path: file }).catch((e) => log(`screenshot ${name} failed: ${e.message}`))
    }
  } catch (e) {
    log(`screenshot ${name} threw: ${e.message}`)
  }
  const ok = fs.existsSync(file) && fs.statSync(file).size > 0
  result.screenshots.push({ name, file: path.basename(file), ok })
  return file
}

// ---------------------------------------------------------------------------------------------
// Main-process hooks (run inside the Electron main process through Playwright's Node inspector)
// ---------------------------------------------------------------------------------------------

function hookMain({ app, webContents, Menu, dialog }, options = {}) {
  const g = globalThis
  if (g.__smoke) return 'already-hooked'
  const events = []
  // Electron's own default handler is the only listener in a stock build: its presence means an
  // uncaught main-process error shows "A JavaScript error occurred in the main process".
  const uncaughtListenersBefore = process.listenerCount('uncaughtException')
  const smoke = { events, menus: [], dialogs: [], autoCloseMenuMs: 0, autoAnswerDialog: null, uncaughtListenersBefore }
  g.__smoke = smoke
  const push = (e) => {
    events.push({ t: Date.now(), ...e })
    if (events.length > 8000) events.shift()
  }
  const safe = (fn, fallback = null) => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  const hook = (wc) => {
    if (!wc || wc.__smokeHooked) return
    wc.__smokeHooked = true
    wc.on('console-message', (event, level, message, line, sourceId) => {
      const d =
        event && typeof event === 'object' && 'message' in event
          ? event
          : { level, message, lineNumber: line, sourceId }
      push({
        type: 'console',
        wc: wc.id,
        wcType: safe(() => wc.getType()),
        url: safe(() => wc.getURL(), ''),
        level: d.level,
        message: String(d.message ?? '').slice(0, 3000),
        sourceId: d.sourceId,
        line: d.lineNumber
      })
    })
    wc.on('render-process-gone', (_e, details) =>
      push({ type: 'render-process-gone', wc: wc.id, url: safe(() => wc.getURL(), ''), ...details })
    )
    wc.on('unresponsive', () => push({ type: 'unresponsive', wc: wc.id }))
    wc.on('did-fail-load', (_e, code, desc, url, isMain) =>
      push({ type: 'did-fail-load', wc: wc.id, code, desc, url, isMain })
    )
    wc.on('preload-error', (_e, preloadPath, err) =>
      push({ type: 'preload-error', wc: wc.id, preloadPath, message: String(err && err.message) })
    )
  }
  webContents.getAllWebContents().forEach(hook)
  app.on('web-contents-created', (_e, wc) => hook(wc))
  app.on('child-process-gone', (_e, d) => push({ type: 'child-process-gone', ...d }))
  app.on('render-process-gone', (_e, wc, d) =>
    push({ type: 'app-render-process-gone', wc: wc && wc.id, ...d })
  )
  // Registering a listener suppresses Electron's default error dialog (it steps aside when there
  // is another listener), so the errordialog scenario asks for the stock behaviour instead.
  if (!options.noExceptionHook) {
    process.on('uncaughtException', (err) =>
      push({ type: 'main-uncaught-exception', message: String((err && err.stack) || err) })
    )
  }
  process.on('unhandledRejection', (r) =>
    push({ type: 'main-unhandled-rejection', message: String((r && r.stack) || r) })
  )

  // Record every native menu the app builds and pops up (context menus, app menu) and give the
  // harness a way to close a popup that would otherwise wait for a real user.
  const describe = (items) =>
    (items || []).map((i) => ({
      label: i.label,
      type: i.type,
      role: i.role,
      enabled: i.enabled,
      visible: i.visible,
      submenu: i.submenu ? describe(i.submenu.items || i.submenu) : undefined
    }))
  const origPopup = Menu.prototype.popup
  Menu.prototype.popup = function (options) {
    const entry = { t: Date.now(), items: describe(this.items), closed: false }
    smoke.menus.push(entry)
    if (smoke.autoCloseMenuMs > 0) {
      setTimeout(() => {
        try {
          this.closePopup()
          entry.closed = true
        } catch (e) {
          entry.closeError = String(e && e.message)
        }
      }, smoke.autoCloseMenuMs)
    }
    return origPopup.call(this, options)
  }
  const origShowMessageBox = dialog.showMessageBox
  dialog.showMessageBox = function (...args) {
    const o = args.find((a) => a && typeof a === 'object' && 'message' in a) || {}
    const entry = {
      t: Date.now(),
      message: o.message,
      detail: o.detail,
      buttons: o.buttons,
      type: o.type,
      answered: null
    }
    smoke.dialogs.push(entry)
    if (smoke.autoAnswerDialog !== null) {
      entry.answered = 'auto'
      return Promise.resolve({ response: smoke.autoAnswerDialog, checkboxChecked: false })
    }
    return origShowMessageBox.apply(this, args).then((r) => {
      entry.answered = r
      return r
    })
  }
  return { hooked: true, uncaughtListenersBefore, exceptionHook: !options.noExceptionHook }
}

async function mainFacts(app) {
  return app.evaluate(({ app, screen, nativeTheme, BrowserWindow, webContents, Menu }) => {
    const safe = (fn, fallback = null) => {
      try {
        return fn()
      } catch (e) {
        return `error: ${e && e.message}`
      }
    }
    return {
      name: app.getName(),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      exe: process.execPath,
      argv: process.argv,
      locale: safe(() => app.getLocale()),
      userData: app.getPath('userData'),
      sessionData: safe(() => app.getPath('sessionData')),
      logs: safe(() => app.getPath('logs')),
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      isDefaultHttp: safe(() => app.isDefaultProtocolClient('http')),
      isDefaultHttps: safe(() => app.isDefaultProtocolClient('https')),
      nativeTheme: {
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
        themeSource: nativeTheme.themeSource,
        highContrast: nativeTheme.shouldUseHighContrastColors
      },
      displays: screen.getAllDisplays().map((d) => ({
        id: d.id,
        bounds: d.bounds,
        workArea: d.workArea,
        scaleFactor: d.scaleFactor,
        colorDepth: d.colorDepth,
        internal: d.internal
      })),
      windows: BrowserWindow.getAllWindows().map((w) => ({
        id: w.id,
        title: w.getTitle(),
        bounds: w.getBounds(),
        contentBounds: w.getContentBounds(),
        visible: w.isVisible(),
        focused: w.isFocused(),
        maximized: w.isMaximized(),
        fullScreen: w.isFullScreen(),
        minimizable: safe(() => w.isMinimizable()),
        maximizable: safe(() => w.isMaximizable()),
        resizable: w.isResizable(),
        menuBarVisible: safe(() => w.isMenuBarVisible()),
        hasShadow: safe(() => w.hasShadow()),
        backgroundColor: safe(() => w.getBackgroundColor())
      })),
      webContents: webContents.getAllWebContents().map((wc) => ({
        id: wc.id,
        type: safe(() => wc.getType()),
        url: safe(() => wc.getURL()),
        title: safe(() => wc.getTitle()),
        loading: safe(() => wc.isLoading()),
        zoomFactor: safe(() => wc.getZoomFactor()),
        pid: safe(() => wc.getOSProcessId())
      })),
      dock: process.platform === 'darwin' ? {
        menu: safe(() => (app.dock.getMenu() ? 'set' : null)),
        badge: safe(() => app.dock.getBadge()),
        visible: safe(() => app.dock.isVisible())
      } : undefined,
      applicationMenu: (() => {
        const m = Menu.getApplicationMenu()
        const describe = (items) => (items || []).map((i) => ({ label: i.label, role: i.role, submenu: i.submenu ? describe(i.submenu.items) : undefined }))
        return m ? describe(m.items) : null
      })(),
      metrics: app.getAppMetrics().map((m) => ({
        type: m.type,
        pid: m.pid,
        name: m.name,
        serviceName: m.serviceName,
        workingSetMB: Math.round(m.memory.workingSetSize / 1024),
        peakWorkingSetMB: Math.round(m.memory.peakWorkingSetSize / 1024),
        cpu: m.cpu && m.cpu.percentCPUUsage
      }))
    }
  })
}

async function drainEvents(app) {
  return app.evaluate(() => {
    const s = globalThis.__smoke
    if (!s) return { events: [], menus: [], dialogs: [] }
    const out = { events: s.events.splice(0), menus: s.menus.slice(), dialogs: s.dialogs.slice() }
    return out
  })
}

// ---------------------------------------------------------------------------------------------
// App session wrapper
// ---------------------------------------------------------------------------------------------

class Session {
  constructor(scenario, userData, extraArgs = [], extraEnv = {}, hookOptions = {}) {
    this.scenario = scenario
    this.userData = userData
    this.extraArgs = extraArgs
    this.extraEnv = extraEnv
    this.hookOptions = hookOptions
    this.stderr = []
    this.stdout = []
    this.mainConsole = []
    this.pageErrors = []
    this.events = []
    this.menus = []
    this.dialogs = []
    this.steps = []
    this.timings = {}
    this.exit = null
    currentSession = this
  }

  async launch() {
    const t0 = Date.now()
    log(`launching ${opts.exe} (${this.scenario})`)
    this.app = await electron.launch({
      executablePath: opts.exe,
      args: [`--user-data-dir=${this.userData}`, ...EXTRA_ARGS, ...this.extraArgs],
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...this.extraEnv },
      timeout: 120000
    })
    // A main process blocked by a synchronous native dialog never answers an evaluate: fence
    // every call so the step fails instead of the whole run stalling.
    const rawEvaluate = this.app.evaluate.bind(this.app)
    this.app.evaluate = (fn, arg) => withTimeout(rawEvaluate(fn, arg), EVALUATE_TIMEOUT_MS, 'app.evaluate')
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
    this.app.on('console', (msg) => {
      this.mainConsole.push({ type: msg.type(), text: msg.text().slice(0, 3000) })
    })
    this.app.on('window', (page) => this.attachPage(page))
    for (const p of this.app.windows()) this.attachPage(p)
    this.hookResult = await this.app.evaluate(hookMain, this.hookOptions)
    this.timings.launchMs = Date.now() - t0
    this.chrome = await this.waitForChromePage(90000)
    this.timings.firstChromePageMs = Date.now() - t0
    await this.chrome.waitForSelector('.zen-window', { timeout: 90000, state: 'attached' })
    this.timings.chromeRenderedMs = Date.now() - t0
    await this.app.evaluate(({ BrowserWindow }) =>
      new Promise((resolve) => {
        const w = BrowserWindow.getAllWindows()[0]
        if (!w || w.isVisible()) return resolve(true)
        w.once('show', () => resolve(true))
        setTimeout(() => resolve(false), 15000)
      })
    )
    this.timings.firstWindowVisibleMs = Date.now() - t0
    return this
  }

  attachPage(page) {
    if (page.__smokeAttached) return
    page.__smokeAttached = true
    page.on('pageerror', (err) =>
      this.pageErrors.push({ url: page.url(), message: String(err && (err.stack || err.message || err)).slice(0, 3000) })
    )
    page.on('crash', () => this.pageErrors.push({ url: page.url(), message: 'PAGE CRASHED (Playwright crash event)' }))
  }

  chromePages() {
    return this.app.windows().filter((p) => /^file:.*index\.html/.test(p.url()))
  }

  async waitForChromePage(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const pages = this.chromePages()
      if (pages.length) return pages[0]
      try {
        await this.app.waitForEvent('window', { timeout: Math.min(5000, deadline - Date.now()) })
      } catch {
        // keep polling: the chrome page may already exist with a not-yet-reported URL
      }
      for (const p of this.app.windows()) {
        try {
          const u = await p.evaluate(() => location.href).catch(() => '')
          if (/index\.html/.test(u)) return p
        } catch {
          // page closed or not ready
        }
      }
    }
    throw new Error(`no chrome page (file://…/index.html) within ${timeoutMs} ms; pages: ${this.app.windows().map((p) => p.url()).join(', ')}`)
  }

  async step(name, fn, timeoutMs = STEP_TIMEOUT_MS) {
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
    return entry
  }

  async collect() {
    try {
      const d = await this.app.evaluate(() => {
        const s = globalThis.__smoke
        if (!s) return { events: [], menus: [], dialogs: [] }
        return { events: s.events.splice(0), menus: s.menus.slice(), dialogs: s.dialogs.slice() }
      })
      this.events.push(...d.events)
      this.menus = d.menus
      this.dialogs = d.dialogs
    } catch (e) {
      log(`collect failed: ${e.message}`)
    }
  }

  async bringToFront() {
    try {
      await this.app.evaluate(({ BrowserWindow, app }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.isVisible()) || BrowserWindow.getAllWindows()[0]
        if (w) {
          w.show()
          w.focus()
          w.moveTop()
        }
        if (app.focus) app.focus({ steal: true })
      })
    } catch {
      // ignore
    }
  }

  async shot(name) {
    await this.bringToFront()
    await sleep(700)
    return shot(`${this.scenario}-${name}`, this.chrome)
  }

  async winFacts() {
    return this.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        id: w.id,
        title: w.getTitle(),
        bounds: w.getBounds(),
        contentBounds: w.getContentBounds(),
        size: w.getSize(),
        contentSize: w.getContentSize(),
        visible: w.isVisible(),
        focused: w.isFocused(),
        maximized: w.isMaximized(),
        fullScreen: w.isFullScreen(),
        minimized: w.isMinimized()
      }))
    )
  }

  // Tab pages: every webContents that is not a BrowserWindow's own chrome page and not devtools.
  // (WebContentsView contents report getType() === 'window' in Electron 44, so type is no filter.)
  async tabs() {
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
          type: wc.getType(),
          url: wc.getURL(),
          title: wc.getTitle(),
          loading: wc.isLoading(),
          zoomFactor: wc.getZoomFactor(),
          zoomLevel: wc.getZoomLevel(),
          audible: wc.isCurrentlyAudible(),
          pid: wc.getOSProcessId()
        }))
    })
  }

  async sidebarTabCount() {
    let n = 0
    for (const p of this.chromePages()) n += await p.locator('[data-tab-id]').count().catch(() => 0)
    return n
  }

  async windowCount() {
    return this.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  }

  // Is the main process event loop free? A synchronous native dialog (Electron's error box)
  // blocks it, so an evaluate that does not return within the timeout means a modal is up.
  async mainResponsive(timeoutMs = 4000) {
    const r = await Promise.race([
      this.app.evaluate(() => 'ok').catch((e) => `error: ${e.message}`),
      sleep(timeoutMs).then(() => 'blocked')
    ])
    return r
  }

  async waitForTab(urlPrefix, timeoutMs = 45000) {
    const found = await pollUntil(async () => {
      const tabs = await this.tabs()
      const t = tabs.find((x) => x.url.startsWith(urlPrefix) && !x.loading)
      return t || null
    }, timeoutMs, 400)
    if (!found) {
      const tabs = await this.tabs()
      throw new Error(`tab ${urlPrefix} not loaded within ${timeoutMs} ms; tabs: ${JSON.stringify(tabs.map((t) => [t.url, t.loading]))}`)
    }
    return found
  }

  // Keyboard shortcut. Playwright's CDP key events are delivered to the renderer only and never
  // reach Electron's before-input-event (verified: the app's shortcut table did not fire), so the
  // shortcut goes through webContents.sendInputEvent on the focused window's chrome page, the
  // same browser-side path a physical key press takes.
  async press(combo) {
    const parts = combo.split('+')
    const key = parts.pop()
    const modifiers = parts.map((m) => ({ Control: 'control', Meta: 'meta', Shift: 'shift', Alt: 'alt' })[m] || m.toLowerCase())
    await this.app.evaluate(({ BrowserWindow }, { key, modifiers }) => {
      const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      if (!w) throw new Error('no window to send keys to')
      w.focus()
      w.webContents.focus()
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    }, { key, modifiers })
  }

  // A real OS-level key press (Windows: SendKeys to the foreground window; macOS: System Events,
  // which needs Accessibility). Used once to prove that physical shortcuts reach the app.
  osPress(keys) {
    if (IS_WIN) {
      const r = ps('win-mouse.ps1', ['-Action', 'sendkeys', '-Name', keys.win], 20000)
      return { via: 'SendKeys', status: r.status, out: r.stdout || r.stderr }
    }
    if (IS_MAC) {
      const r = sh('osascript', ['-e', `tell application "System Events" to keystroke "${keys.macKey}" using ${keys.macMods}`], 20000)
      return { via: 'osascript', status: r.status, out: r.stdout || r.stderr }
    }
    return { via: 'none' }
  }

  async quitWithShortcut() {
    const t = Date.now()
    await Promise.race([this.press(`${ACCEL}+q`), sleep(5000)])
    const exit = await Promise.race([this.exitPromise, sleep(20000).then(() => null)])
    if (!exit) {
      log('app did not exit after Accel+Q within 20 s; force closing')
      await this.forceClose()
      return { exitedOnShortcut: false, ms: Date.now() - t, exit: this.exit }
    }
    return { exitedOnShortcut: true, ms: Date.now() - t, exit }
  }

  async quit() {
    try {
      await Promise.race([this.app.evaluate(({ app }) => app.quit()), sleep(8000)])
    } catch {
      // main may already be gone
    }
    const exit = await Promise.race([this.exitPromise, sleep(20000).then(() => null)])
    if (!exit) await this.forceClose()
    return this.exit
  }

  // Playwright's close() needs a live main-process event loop (a modal native dialog blocks it),
  // so fall back to killing the process tree.
  async forceClose() {
    if (this.exit) return this.exit
    await Promise.race([this.app.close().catch(() => {}), sleep(8000)])
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
      await Promise.race([this.exitPromise, sleep(5000)])
    }
    return this.exit
  }

  summary() {
    const chromeErrors = this.events.filter(
      (e) => e.type === 'console' && (e.level === 'error' || e.level === 3) && (e.wcType === 'window' || /index\.html/.test(e.url || ''))
    )
    const pageConsoleErrors = this.events.filter(
      (e) => e.type === 'console' && (e.level === 'error' || e.level === 3) && !(e.wcType === 'window' || /index\.html/.test(e.url || ''))
    )
    const crashes = this.events.filter((e) => /gone|unresponsive|uncaught|unhandled/.test(e.type))
    return {
      scenario: this.scenario,
      pid: this.pid,
      hookResult: this.hookResult,
      timings: this.timings,
      exit: this.exit,
      steps: this.steps,
      chromeConsoleErrors: chromeErrors,
      chromeConsoleWarnings: this.events.filter((e) => e.type === 'console' && (e.level === 'warning' || e.level === 2) && (e.wcType === 'window')),
      pageConsoleErrors,
      pageErrors: this.pageErrors,
      mainConsole: this.mainConsole,
      crashesAndProcessLoss: crashes,
      failedLoads: this.events.filter((e) => e.type === 'did-fail-load'),
      menus: this.menus,
      dialogs: this.dialogs,
      stderrLines: this.stderr.join('').split(/\r?\n/).length,
      zeroJsErrors: chromeErrors.length === 0 && this.pageErrors.length === 0 && crashes.length === 0
    }
  }

  saveLogs() {
    fs.writeFileSync(path.join(outDir, `${this.scenario}-stderr.log`), this.stderr.join(''))
    fs.writeFileSync(path.join(outDir, `${this.scenario}-stdout.log`), this.stdout.join(''))
    writeJson(path.join(outDir, `${this.scenario}-events.json`), this.events)
  }
}

// ---------------------------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------------------------

function freshProfile(name, { onboardingDone = false } = {}) {
  const dir = path.join(profileRoot, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'zen'), { recursive: true })
  if (onboardingDone) {
    writeJson(path.join(dir, 'zen', 'state.json'), { version: 2, settings: { onboardingDone: true } })
  }
  return dir
}

function readState(userData) {
  try {
    const raw = fs.readFileSync(path.join(userData, 'zen', 'state.json'), 'utf8')
    const s = JSON.parse(raw)
    return {
      version: s.version,
      windows: (s.windows || []).map((w) => ({ id: w.id, bounds: w.bounds, maximized: w.maximized })),
      tabs: (s.tabs || []).map((t) => ({ id: t.id, url: t.url, title: t.title, pinned: t.pinned })),
      spaces: (s.spaces || []).length,
      onboardingDone: s.settings && s.settings.onboardingDone
    }
  } catch (e) {
    return { error: String(e.message) }
  }
}

function listProfile(userData) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 2) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      out.push(path.relative(userData, p) + (e.isDirectory() ? '/' : ''))
      if (e.isDirectory()) walk(p, depth + 1)
    }
  }
  walk(userData, 0)
  return out.slice(0, 300)
}

function externalProcessFacts() {
  if (IS_WIN) {
    const r = ps('win-mouse.ps1', ['-Action', 'processes'], 60000)
    try {
      return JSON.parse(r.stdout)
    } catch {
      return { raw: r.stdout, stderr: r.stderr }
    }
  }
  if (IS_MAC) {
    const r = sh('/bin/sh', ['-c', "ps -axo pid,ppid,rss,%cpu,comm | grep -i '[Z]en' | head -40"])
    return { raw: r.stdout }
  }
  return null
}

function windowStyleFacts() {
  if (!IS_WIN) return null
  const r = ps('win-mouse.ps1', ['-Action', 'window'], 60000)
  try {
    return JSON.parse(r.stdout)
  } catch {
    return { raw: r.stdout, stderr: r.stderr }
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

async function scenarioBoot() {
  const userData = freshProfile('profile')
  const s = new Session('boot', userData)
  const out = { userData }
  try {
    const launched = await s.step('launch', async () => {
      await s.launch()
      return s.timings
    })
    if (!launched.ok) throw new Error(`launch failed: ${launched.error}`)

    await s.step('facts', async () => {
      out.facts = await mainFacts(s.app)
      out.userDataHonoured = out.facts.userData === userData
      return { userData: out.facts.userData, version: out.facts.version, chrome: out.facts.versions.chrome }
    })

    await s.step('first-launch-screenshot', async () => {
      await sleep(1500)
      const onboarding = await s.chrome.locator('h1:has-text("Welcome to Zen")').count()
      out.onboardingShown = onboarding > 0
      await s.shot('01-first-launch')
      return { onboardingShown: out.onboardingShown }
    })

    await s.step('complete-onboarding', async () => {
      if (!out.onboardingShown) return 'no onboarding shown'
      await s.chrome.getByRole('button', { name: 'Continue' }).click({ timeout: 5000 })
      await sleep(600)
      await s.shot('02-onboarding-look')
      await s.chrome.getByRole('button', { name: 'Skip tour' }).click({ timeout: 5000 })
      await s.chrome.locator('h1:has-text("Welcome to Zen")').waitFor({ state: 'detached', timeout: 10000 })
      await sleep(1200)
      await s.shot('03-main-after-onboarding')
      return 'completed'
    })

    await s.step('ui-scripting-probe', async () => {
      // macOS: System Events UI scripting needs an Accessibility grant the runner may not have.
      // Windows: UI Automation and SendKeys work in any interactive session.
      if (IS_MAC) {
        const r = sh('osascript', ['-e', 'tell application "System Events" to tell process "Zen" to get name of every window'], 20000)
        out.uiScripting = { available: r.status === 0, out: r.stdout || r.stderr }
      } else {
        out.uiScripting = { available: IS_WIN }
      }
      result.uiScripting = out.uiScripting
      return out.uiScripting
    })

    await s.step('new-tab-shortcut-and-navigate', async () => {
      // Zen's "new tab" opens the URL bar first and creates the tab on commit, so the shortcut is
      // judged by the URL bar appearing. The first-run blank tab already shows it: close it first.
      const input = s.chrome.locator('input[placeholder*="Search or enter address"], input[placeholder^="Search with"]')
      const urlbarOpenBefore = await input.first().isVisible().catch(() => false)
      if (urlbarOpenBefore) {
        await s.chrome.keyboard.press('Escape')
        await input.first().waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {})
      }
      const tabsBefore = await s.sidebarTabCount()
      await s.press(`${ACCEL}+t`)
      await input.first().waitFor({ state: 'visible', timeout: 8000 })
      await sleep(300)
      await s.shot('04-urlbar-open')
      await input.first().fill('https://example.com')
      await s.chrome.keyboard.press('Enter')
      const tab = await s.waitForTab('https://example.com', 60000)
      await sleep(1500)
      const tabsAfter = await s.sidebarTabCount()
      await s.shot('05-example-com-loaded')
      out.exampleTab = tab
      return { urlbarOpenBefore, newTabShortcutOpenedUrlbar: true, sidebarTabsBefore: tabsBefore, sidebarTabsAfterNavigate: tabsAfter, title: tab.title, url: tab.url, webContentsType: tab.type }
    })

    await s.step('focus-urlbar-shortcut', async () => {
      await s.press(`${ACCEL}+l`)
      const input = s.chrome.locator('input[placeholder*="Search or enter address"], input[placeholder^="Search with"]')
      await input.first().waitFor({ state: 'visible', timeout: 5000 })
      const value = await input.first().inputValue()
      await s.shot('06-urlbar-edit-mode')
      await s.chrome.keyboard.press('Escape')
      const hidden = await input.first().waitFor({ state: 'hidden', timeout: 4000 }).then(() => true).catch(() => false)
      if (!hidden) {
        await s.press('Escape')
        await input.first().waitFor({ state: 'hidden', timeout: 4000 })
      }
      return { value, closedByRendererEscape: hidden }
    })

    await s.step('os-level-keypress-check', async () => {
      // One physical-path shortcut (Ctrl/Cmd+T) to prove the OS -> Chromium -> before-input-event
      // chain that a real user relies on; everything else uses the main-process input path.
      if (IS_MAC && !out.uiScripting?.available) return 'skipped (no Accessibility grant for System Events)'
      if (!IS_WIN && !IS_MAC) return 'skipped (no OS-level input on Linux)'
      await s.bringToFront()
      await sleep(500)
      const before = await s.sidebarTabCount()
      const r = s.osPress({ win: '^t', macKey: 't', macMods: 'command down' })
      const grew = await pollUntil(async () => (await s.sidebarTabCount()) > before, 6000)
      const input = s.chrome.locator('input[placeholder*="Search or enter address"], input[placeholder^="Search with"]')
      const urlbarOpen = await input.first().isVisible().catch(() => false)
      if (urlbarOpen) {
        await s.chrome.keyboard.press('Escape')
        await sleep(300)
      }
      return { ...r, tabsBefore: before, tabsAfter: await s.sidebarTabCount(), newTabOpened: Boolean(grew), urlbarOpen }
    })

    await s.step('find-in-page-shortcut', async () => {
      await s.press(`${ACCEL}+f`)
      const find = s.chrome.locator('input[placeholder="Find in page"]')
      await find.waitFor({ state: 'visible', timeout: 5000 })
      await find.fill('Example')
      await sleep(900)
      const text = await s.chrome.locator('body').innerText().catch(() => '')
      const matchText = (text.match(/\d+\s*(of|\/)\s*\d+/) || [])[0]
      await s.shot('07-find-bar')
      await s.chrome.keyboard.press('Escape')
      await find.waitFor({ state: 'hidden', timeout: 5000 })
      return { matchText }
    })

    await s.step('zoom-shortcuts', async () => {
      const zoom = async () => (await s.tabs()).find((t) => t.url.startsWith('https://example.com'))?.zoomFactor
      const z0 = await zoom()
      await s.press(`${ACCEL}+=`)
      await sleep(400)
      const z1 = await zoom()
      await s.press(`${ACCEL}+=`)
      await sleep(400)
      const z2 = await zoom()
      await s.shot('08-zoom-in')
      await s.press(`${ACCEL}+-`)
      await sleep(400)
      const z3 = await zoom()
      await s.press(`${ACCEL}+0`)
      await sleep(400)
      const z4 = await zoom()
      return { z0, z1, z2, z3, z4 }
    })

    await s.step('fullscreen-shortcut', async () => {
      const combo = IS_MAC ? 'Control+Meta+f' : 'F11'
      await s.press(combo)
      const on = await pollUntil(async () => (await s.winFacts())[0]?.fullScreen, 8000)
      await sleep(IS_MAC ? 2000 : 800)
      await s.shot('09-fullscreen')
      await s.press(combo)
      const offAgain = await pollUntil(async () => !(await s.winFacts())[0]?.fullScreen, 8000)
      await sleep(IS_MAC ? 2000 : 500)
      return { enteredFullscreen: Boolean(on), leftFullscreen: Boolean(offAgain) }
    })

    await s.step('new-window-and-private-window', async () => {
      const before = await s.windowCount()
      await s.press(`${ACCEL}+n`)
      const two = await pollUntil(async () => (await s.windowCount()) >= before + 1, 10000)
      await s.press(`${ACCEL}+Shift+p`)
      const three = await pollUntil(async () => (await s.windowCount()) >= before + 2, 10000)
      await sleep(1500)
      const kinds = []
      for (const p of s.chromePages()) {
        const k = await p.locator('.zen-window').first().getAttribute('data-window-kind').catch(() => null)
        kinds.push(k)
      }
      await s.shot('10-three-windows')
      const wins = await s.winFacts()
      // close the extra windows from their own chrome (Accel+Shift+W = close window)
      await s.app.evaluate(({ BrowserWindow }) => {
        const all = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)
        all.slice(1).forEach((w) => w.close())
      })
      const backToOne = await pollUntil(async () => (await s.windowCount()) === before, 10000)
      return { before, newWindow: Boolean(two), privateWindow: Boolean(three), kinds, bounds: wins.map((w) => w.bounds), closedExtras: Boolean(backToOne) }
    })

    await s.step('open-settings', async () => {
      if (IS_MAC) {
        await s.press('Meta+,')
      } else {
        // Windows/Linux have no default Settings shortcut in Zen's table (Cmd+, is macOS only):
        // reach the overlay the way the native app menu does (main -> renderer event).
        await s.app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows()[0]
          w.webContents.send('zen:event', 'overlay.open', { kind: 'settings' })
        })
      }
      const panel = s.chrome.locator('.zen-settings').first()
      await panel.waitFor({ state: 'visible', timeout: 8000 })
      await sleep(800)
      await s.shot('11-settings')
      const headings = await s.chrome.locator('h1, h2, h3').allInnerTexts().catch(() => [])
      await s.chrome.keyboard.press('Escape')
      await sleep(500)
      return { headings: headings.slice(0, 30) }
    })

    await s.step('page-context-menu', async () => {
      const tab = (await s.tabs()).find((t) => t.url.startsWith('https://example.com'))
      if (!tab) throw new Error('example.com tab missing')
      await s.app.evaluate(() => {
        globalThis.__smoke.autoCloseMenuMs = 4000
      })
      await s.app.evaluate(({ webContents }, id) => {
        const wc = webContents.fromId(id)
        const x = 200
        const y = 150
        wc.focus()
        wc.sendInputEvent({ type: 'mouseDown', button: 'right', x, y, clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', button: 'right', x, y, clickCount: 1 })
      }, tab.id)
      await sleep(1200)
      const file = await shot(`${s.scenario}-12-page-context-menu`)
      if (IS_WIN) ps('win-mouse.ps1', ['-Action', 'escape'], 20000)
      if (IS_MAC) sh('osascript', ['-e', 'tell application "System Events" to key code 53'], 20000)
      await sleep(4500)
      await s.collect()
      const menu = s.menus[s.menus.length - 1]
      await s.app.evaluate(() => {
        globalThis.__smoke.autoCloseMenuMs = 0
      })
      return { menusRecorded: s.menus.length, lastMenuLabels: menu ? menu.items.map((i) => i.label || i.type || i.role) : null, closedByTimer: menu?.closed, file: path.basename(file) }
    })

    await s.step('maximize-restore-and-caption-button-hover', async () => {
      const before = (await s.winFacts())[0]
      await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
      const max = await pollUntil(async () => (await s.winFacts())[0]?.maximized, 6000)
      await sleep(800)
      const restoreBtn = s.chrome.locator('button[title="Restore"]')
      const restoreVisible = (await restoreBtn.count()) > 0
      await s.shot('13-maximized')
      let hover = null
      if (IS_WIN && restoreVisible) {
        const box = await restoreBtn.first().boundingBox()
        const cb = (await s.winFacts())[0].contentBounds
        const scale = out.facts?.displays?.[0]?.scaleFactor || 1
        if (box) {
          const x = Math.round((cb.x + box.x + box.width / 2) * scale)
          const y = Math.round((cb.y + box.y + box.height / 2) * scale)
          ps('win-mouse.ps1', ['-Action', 'move', '-X', String(x), '-Y', String(y)], 20000)
          await sleep(1800)
          await shot(`${s.scenario}-14-maximize-button-hover-snap-layouts`)
          hover = { x, y }
          ps('win-mouse.ps1', ['-Action', 'move', '-X', '5', '-Y', String(y + 300)], 20000)
        }
      }
      await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
      const unmax = await pollUntil(async () => !(await s.winFacts())[0]?.maximized, 6000)
      const after = (await s.winFacts())[0]
      return { maximized: Boolean(max), restoreButtonShown: restoreVisible, unmaximized: Boolean(unmax), boundsBefore: before.bounds, boundsAfter: after.bounds, hover }
    })

    await s.step('native-window-styles', async () => {
      out.windowStyles = windowStyleFacts()
      return out.windowStyles
    })

    await s.step('drag-window-by-title-area', async () => {
      if (!IS_WIN) return 'skipped (macOS: no OS-level input without Accessibility grant)'
      const point = await s.chrome.evaluate(() => {
        const drags = Array.from(document.querySelectorAll('.zen-drag'))
        for (const el of drags) {
          const r = el.getBoundingClientRect()
          if (r.width < 20 || r.height < 8) continue
          for (let fx = 0.1; fx <= 0.9; fx += 0.1) {
            for (let fy = 0.2; fy <= 0.8; fy += 0.3) {
              const x = r.left + r.width * fx
              const y = r.top + r.height * fy
              const hit = document.elementFromPoint(x, y)
              if (!hit) continue
              const region = hit.closest('.zen-no-drag, .zen-drag')
              if (region && region.classList.contains('zen-drag')) return { x, y, area: r.width * r.height }
            }
          }
        }
        return null
      })
      if (!point) throw new Error('no draggable (.zen-drag) point found in the chrome')
      const before = (await s.winFacts())[0]
      const scale = out.facts?.displays?.[0]?.scaleFactor || 1
      const sx = Math.round((before.contentBounds.x + point.x) * scale)
      const sy = Math.round((before.contentBounds.y + point.y) * scale)
      const r = ps('win-mouse.ps1', ['-Action', 'drag', '-X', String(sx), '-Y', String(sy), '-DX', '140', '-DY', '70'], 30000)
      await sleep(1000)
      const after = (await s.winFacts())[0]
      const moved = after.bounds.x !== before.bounds.x || after.bounds.y !== before.bounds.y
      await s.shot('15-after-drag')
      return { point, from: before.bounds, to: after.bounds, moved, dx: after.bounds.x - before.bounds.x, dy: after.bounds.y - before.bounds.y, ps: r.stderr || undefined }
    })

    await s.step('resize-900x600', async () => {
      await s.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]
        w.setSize(900, 600)
        w.center()
      })
      await sleep(900)
      const w = (await s.winFacts())[0]
      const chromeSize = await s.chrome.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, root: document.querySelector('.zen-window')?.getBoundingClientRect().toJSON() }))
      await s.shot('16-resized-900x600')
      return { size: w.size, contentSize: w.contentSize, chromeSize }
    })

    await s.step('notification-permission-prompt', async () => {
      const tab = (await s.tabs()).find((t) => t.url.startsWith('https://example.com'))
      if (!tab) throw new Error('example.com tab missing')
      const permBefore = await s.app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('Notification.permission'), tab.id)
      // Without OS-level UI scripting nobody could dismiss the native prompt, so the hook answers
      // it (button 0 = Allow) and only the dialog text is recorded.
      const canClick = Boolean(out.uiScripting?.available)
      await s.app.evaluate((_electron, auto) => {
        globalThis.__smoke.autoAnswerDialog = auto
      }, canClick ? null : 0)
      // Fire and do not await: the prompt is a native dialog that blocks the promise.
      await s.app.evaluate(({ webContents }, id) => {
        const wc = webContents.fromId(id)
        globalThis.__smokeNotif = wc.executeJavaScript(
          `window.__notif = { events: [] }; Notification.requestPermission().then(p => { window.__notif.permission = p; return p })`,
          true
        )
      }, tab.id)
      await sleep(1500)
      await s.collect()
      const dialog = s.dialogs[s.dialogs.length - 1]
      await shot(`${s.scenario}-17-notification-permission-prompt`)
      const readPermission = () =>
        pollUntil(async () => {
          const p = await s.app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('window.__notif && window.__notif.permission'), tab.id).catch(() => null)
          return p || null
        }, 10000, 500)
      let answered = canClick ? null : 'auto-answered by hook (no UI scripting)'
      if (canClick && IS_WIN) {
        const r = ps('win-mouse.ps1', ['-Action', 'click-button', '-Name', 'Allow', '-TimeoutSeconds', '8'], 30000)
        answered = r.stdout || r.stderr
      } else if (canClick && IS_MAC) {
        const r = sh('osascript', ['-e', 'tell application "System Events" to tell process "Zen" to click button "Allow" of sheet 1 of window 1'], 20000)
        answered = r.status === 0 ? r.stdout : `osascript failed: ${r.stderr}`
      }
      let permission = await readPermission()
      let fallback = null
      if (!permission && canClick) {
        // Do not leave a modal prompt behind: Esc cancels it (the page then sees "denied").
        fallback = IS_WIN ? ps('win-mouse.ps1', ['-Action', 'escape'], 20000).stdout : sh('osascript', ['-e', 'tell application "System Events" to key code 53'], 20000).stdout
        permission = await readPermission()
      }
      await s.app.evaluate(() => {
        globalThis.__smoke.autoAnswerDialog = null
      })
      return { permBefore, dialog: dialog ? { message: dialog.message, detail: dialog.detail, buttons: dialog.buttons, answered: dialog.answered } : null, answered, fallback, permission }
    })

    await s.step('notification-display', async () => {
      const tab = (await s.tabs()).find((t) => t.url.startsWith('https://example.com'))
      if (!tab) throw new Error('example.com tab missing')
      const r = await s.app.evaluate(({ webContents }, id) => {
        const wc = webContents.fromId(id)
        return wc.executeJavaScript(
          `new Promise((resolve) => {
             const out = { permission: Notification.permission, events: [] };
             if (Notification.permission !== 'granted') return resolve(out);
             try {
               const n = new Notification('Zenium smoke test', { body: 'If you can read this on the desktop, notifications work.', tag: 'zenium-smoke' });
               ['show', 'error', 'close', 'click'].forEach((ev) => n.addEventListener(ev, () => out.events.push(ev)));
             } catch (e) { out.error = String(e); }
             setTimeout(() => resolve(out), 2500);
           })`,
          true
        )
      }, tab.id)
      await shot(`${s.scenario}-18-notification-banner`)
      return r
    })

    await s.step('second-instance-url', async () => {
      const t = Date.now()
      const child = spawn(opts.exe, [`--user-data-dir=${userData}`, ...EXTRA_ARGS, 'https://example.org'], { stdio: 'ignore', detached: false })
      const childExit = new Promise((resolve) => child.on('exit', (code) => resolve({ code, ms: Date.now() - t })))
      const tab = await s.waitForTab('https://example.org', 30000).catch((e) => ({ error: e.message }))
      const exit = await Promise.race([childExit, sleep(15000).then(() => ({ code: 'still-running' }))])
      if (exit.code === 'still-running') child.kill()
      await sleep(800)
      await s.shot('19-second-instance-opened-tab')
      const windows = await s.windowCount()
      return { secondProcessExit: exit, tab: tab.url ? { url: tab.url, title: tab.title } : tab, windows }
    })

    await s.step('second-instance-private-window', async () => {
      const t = Date.now()
      const before = await s.windowCount()
      const child = spawn(opts.exe, [`--user-data-dir=${userData}`, ...EXTRA_ARGS, '--private-window'], { stdio: 'ignore' })
      const childExit = new Promise((resolve) => child.on('exit', (code) => resolve({ code, ms: Date.now() - t })))
      const opened = await pollUntil(async () => (await s.windowCount()) > before, 15000)
      const exit = await Promise.race([childExit, sleep(10000).then(() => ({ code: 'still-running' }))])
      if (exit.code === 'still-running') child.kill()
      await sleep(1200)
      const kinds = []
      for (const p of s.chromePages()) kinds.push(await p.locator('.zen-window').first().getAttribute('data-window-kind').catch(() => null))
      await s.shot('20-second-instance-private-window')
      await s.app.evaluate(({ BrowserWindow }) => {
        const all = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)
        all.slice(1).forEach((w) => w.close())
      })
      await pollUntil(async () => (await s.windowCount()) === before, 8000)
      return { secondProcessExit: exit, privateWindowOpened: Boolean(opened), kinds }
    })

    await s.step('process-and-memory-facts', async () => {
      const facts = await mainFacts(s.app)
      out.metrics = facts.metrics
      out.externalProcesses = externalProcessFacts()
      const totalMB = facts.metrics.reduce((a, m) => a + m.workingSetMB, 0)
      return { processes: facts.metrics.length, totalWorkingSetMB: totalMB, byType: facts.metrics.map((m) => `${m.type}${m.serviceName ? ':' + m.serviceName : ''}=${m.workingSetMB}MB`) }
    })

    await s.collect()
    await s.step('quit-shortcut', async () => {
      const r = await s.quitWithShortcut()
      out.stateAfterQuit = readState(userData)
      out.profileFiles = listProfile(userData)
      return { ...r, state: out.stateAfterQuit }
    })
  } catch (e) {
    out.fatal = String(e && (e.stack || e.message || e))
    log(`boot scenario fatal: ${out.fatal}`)
    if (s.app) await s.forceClose()
  }
  if (s.app) await s.collect().catch(() => {})
  s.saveLogs()
  out.session = s.summary()
  result.scenarios.boot = out
  writeJson(path.join(outDir, 'result.json'), result)
}

async function scenarioRestore() {
  const userData = profile
  const s = new Session('restore', userData)
  const out = { userData, stateBefore: readState(userData) }
  try {
    const launched = await s.step('relaunch', async () => {
      await s.launch()
      return s.timings
    })
    if (!launched.ok) throw new Error(`launch failed: ${launched.error}`)
    await s.step('restored-windows-and-tabs', async () => {
      await sleep(3000)
      const wins = await s.winFacts()
      const tabs = await s.tabs()
      const sidebarTabs = await s.chrome.locator('[data-tab-id]').count().catch(() => -1)
      const onboarding = await s.chrome.locator('h1:has-text("Welcome to Zen")').count()
      await s.shot('01-restored-session')
      return { windows: wins.length, bounds: wins.map((w) => w.bounds), liveTabs: tabs.map((t) => t.url), sidebarTabElements: sidebarTabs, onboardingShownAgain: onboarding > 0, persistedTabs: out.stateBefore.tabs }
    })
    await s.step('close-tab-shortcut', async () => {
      const before = { live: (await s.tabs()).length, sidebar: await s.sidebarTabCount() }
      await s.press(`${ACCEL}+w`)
      await sleep(1200)
      const after = { live: (await s.tabs()).length, sidebar: await s.sidebarTabCount() }
      return { before, after, closedOne: after.sidebar === before.sidebar - 1 }
    })
    if (IS_MAC) {
      await s.step('mac-hide-and-unhide', async () => {
        // Cmd+H is the appMenu role's accelerator: only a real key event (System Events) reaches
        // it; the main-process input path is recorded as a comparison.
        await s.bringToFront()
        await sleep(500)
        let via = 'sendInputEvent'
        if (result.uiScripting?.available) {
          via = 'osascript'
          s.osPress({ macKey: 'h', macMods: 'command down' })
        } else {
          await s.press('Meta+h')
        }
        const hidden = await pollUntil(async () => s.app.evaluate(({ app }) => app.isHidden()), 5000)
        await s.app.evaluate(({ app }) => app.show())
        const shown = await pollUntil(async () => s.app.evaluate(({ app }) => !app.isHidden()), 5000)
        return { via, hidden: Boolean(hidden), shownAgain: Boolean(shown) }
      })
      await s.step('mac-menu-bar-and-dock', async () => {
        const facts = await mainFacts(s.app)
        await s.shot('02-menu-bar')
        return { applicationMenu: facts.applicationMenu, dock: facts.dock }
      })
      await s.step('mac-close-last-window-keeps-app-alive-then-activate', async () => {
        await s.press('Meta+Shift+w')
        const none = await pollUntil(async () => (await s.windowCount()) === 0, 8000)
        const alive = s.exit === null
        await s.app.evaluate(({ app }) => app.emit('activate'))
        const back = await pollUntil(async () => (await s.windowCount()) >= 1, 8000)
        if (back) {
          s.chrome = await s.waitForChromePage(20000)
          await s.chrome.waitForSelector('.zen-window', { timeout: 20000, state: 'attached' })
        }
        return { allWindowsClosed: Boolean(none), appStillRunning: alive, reopenedOnActivate: Boolean(back) }
      })
    }
    await s.step('quit', async () => {
      const exit = await s.quit()
      return { exit, state: readState(userData) }
    })
  } catch (e) {
    out.fatal = String(e && (e.stack || e.message || e))
    if (s.app) await s.forceClose()
  }
  if (s.app) await s.collect().catch(() => {})
  s.saveLogs()
  out.session = s.summary()
  result.scenarios.restore = out
  writeJson(path.join(outDir, 'result.json'), result)
}

async function scenarioScale() {
  const userData = freshProfile('profile-scale', { onboardingDone: true })
  const s = new Session('scale', userData, ['--force-device-scale-factor=1.5'])
  const out = { userData }
  try {
    const launched = await s.step('launch-scale-1.5', async () => {
      await s.launch()
      return s.timings
    })
    if (!launched.ok) throw new Error(`launch failed: ${launched.error}`)
    await s.step('scale-facts-and-screenshot', async () => {
      await sleep(2000)
      const dpr = await s.chrome.evaluate(() => ({ devicePixelRatio: window.devicePixelRatio, innerWidth: window.innerWidth, innerHeight: window.innerHeight }))
      const wins = await s.winFacts()
      await s.shot('01-scale-150')
      return { dpr, bounds: wins[0]?.bounds }
    })
    await s.step('quit', async () => s.quit())
  } catch (e) {
    out.fatal = String(e && (e.stack || e.message || e))
    if (s.app) await s.forceClose()
  }
  if (s.app) await s.collect().catch(() => {})
  s.saveLogs()
  out.session = s.summary()
  result.scenarios.scale = out
  writeJson(path.join(outDir, 'result.json'), result)
}

function setOsDarkMode(on) {
  if (IS_WIN) {
    const v = on ? '0' : '1'
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
    const a = sh('reg', ['add', key, '/v', 'AppsUseLightTheme', '/t', 'REG_DWORD', '/d', v, '/f'])
    const b = sh('reg', ['add', key, '/v', 'SystemUsesLightTheme', '/t', 'REG_DWORD', '/d', v, '/f'])
    return { apps: a.status, system: b.status, err: a.stderr || b.stderr || undefined }
  }
  if (IS_MAC) {
    const r = on
      ? sh('defaults', ['write', '-g', 'AppleInterfaceStyle', 'Dark'])
      : sh('defaults', ['delete', '-g', 'AppleInterfaceStyle'])
    return { status: r.status, err: r.stderr || undefined }
  }
  return null
}

async function scenarioDark() {
  const userData = freshProfile('profile-dark', { onboardingDone: true })
  const out = { userData, set: setOsDarkMode(true) }
  await sleep(1500)
  const s = new Session('dark', userData)
  try {
    const launched = await s.step('launch-in-os-dark-mode', async () => {
      await s.launch()
      return s.timings
    })
    if (!launched.ok) throw new Error(`launch failed: ${launched.error}`)
    const themeFacts = async () => {
      const theme = await s.app.evaluate(({ nativeTheme }) => ({ shouldUseDarkColors: nativeTheme.shouldUseDarkColors, themeSource: nativeTheme.themeSource }))
      const chrome = await s.chrome.evaluate(() => {
        const root = document.querySelector('.zen-window')
        return {
          dataDark: root?.getAttribute('data-dark'),
          dataTheme: document.documentElement.dataset.theme,
          prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
          background: root ? getComputedStyle(root).backgroundColor : null,
          bodyBackground: getComputedStyle(document.body).backgroundColor
        }
      })
      return { theme, chrome }
    }
    await s.step('dark-facts-and-screenshot', async () => {
      await sleep(2000)
      const facts = await themeFacts()
      await s.shot('01-os-dark-mode')
      return facts
    })
    // Does the running app follow a live OS theme change (Chromium watches the registry key /
    // AppleInterfaceStyle notification)? Startup vs live can differ.
    await s.step('live-toggle-light-then-dark', async () => {
      const toLight = setOsDarkMode(false)
      await sleep(3500)
      const afterLight = await themeFacts()
      const toDark = setOsDarkMode(true)
      await sleep(3500)
      const afterDark = await themeFacts()
      await s.shot('02-after-live-toggle-to-dark')
      return { toLight, afterLight, toDark, afterDark }
    })
    await s.step('quit', async () => s.quit())
  } catch (e) {
    out.fatal = String(e && (e.stack || e.message || e))
    if (s.app) await s.forceClose()
  }
  out.reset = setOsDarkMode(false)
  if (s.app) await s.collect().catch(() => {})
  s.saveLogs()
  out.session = s.summary()
  result.scenarios.dark = out
  writeJson(path.join(outDir, 'result.json'), result)
}

function nativeDialogFacts() {
  if (IS_WIN) {
    const r = ps('win-mouse.ps1', ['-Action', 'dialogs'], 60000)
    try {
      return JSON.parse(r.stdout)
    } catch {
      return { raw: r.stdout, stderr: r.stderr }
    }
  }
  if (IS_MAC) {
    const r = sh('osascript', ['-e', 'tell application "System Events" to tell process "Zen" to get {name, role description} of every window'], 20000)
    return { status: r.status, out: r.stdout || r.stderr }
  }
  return null
}

function dismissNativeDialog(buttonName) {
  if (IS_WIN) {
    const r = ps('win-mouse.ps1', ['-Action', 'click-button', '-Name', buttonName, '-TimeoutSeconds', '5'], 30000)
    return r.stdout || r.stderr
  }
  if (IS_MAC) {
    const r = sh('osascript', ['-e', `tell application "System Events" to tell process "Zen" to click button "${buttonName}" of window 1`], 20000)
    return r.status === 0 ? r.stdout : `osascript failed: ${r.stderr}`
  }
  return null
}

// The boot scenario records main-process exceptions through its own listener, which also hides
// Electron's stock reaction to them. This run keeps the stock behaviour to show what a user sees
// when a window with a loaded page is closed and when the app quits.
async function scenarioErrorDialog() {
  const userData = freshProfile('profile-errordialog', { onboardingDone: true })
  const s = new Session('errordialog', userData, [], {}, { noExceptionHook: true })
  const out = { userData }
  try {
    const launched = await s.step('launch-stock-exception-handling', async () => {
      await s.launch()
      return { ...s.timings, hook: s.hookResult }
    })
    if (!launched.ok) throw new Error(`launch failed: ${launched.error}`)
    await s.step('open-page-and-second-window', async () => {
      await s.press(`${ACCEL}+t`)
      const input = s.chrome.locator('input[placeholder*="Search or enter address"], input[placeholder^="Search with"]')
      await input.first().waitFor({ state: 'visible', timeout: 8000 })
      await input.first().fill('https://example.com')
      await s.chrome.keyboard.press('Enter')
      await s.waitForTab('https://example.com', 60000)
      await s.press(`${ACCEL}+n`)
      const two = await pollUntil(async () => (await s.windowCount()) >= 2, 10000)
      await sleep(1000)
      return { secondWindow: Boolean(two) }
    })
    await s.step('close-first-window-with-loaded-page', async () => {
      // Closing the window that owns the loaded page destroys its tab view; the user does this
      // with the caption close button or Ctrl/Cmd+Shift+W.
      await Promise.race([
        s.app.evaluate(({ BrowserWindow }) => {
          const all = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)
          all[0].close()
        }),
        sleep(5000)
      ])
      await sleep(2500)
      const responsive = await s.mainResponsive(4000)
      const dialogs = nativeDialogFacts()
      await shot(`${s.scenario}-01-after-closing-window-with-page`)
      let dismissed = null
      if (responsive === 'blocked') {
        dismissed = dismissNativeDialog('OK')
        await sleep(1500)
      }
      const responsiveAfter = await s.mainResponsive(4000)
      const windows = responsiveAfter === 'ok' ? await s.windowCount() : null
      return { mainResponsiveAfterClose: responsive, dialogs, dismissed, mainResponsiveAfterDismiss: responsiveAfter, windowsLeft: windows, exited: s.exit }
    })
    await s.step('quit-shortcut-stock', async () => {
      const t = Date.now()
      if (s.exit) return { alreadyExited: s.exit }
      await Promise.race([s.press(`${ACCEL}+q`), sleep(5000)])
      const exit = await Promise.race([s.exitPromise, sleep(10000).then(() => null)])
      const responsive = exit ? 'exited' : await s.mainResponsive(4000)
      const dialogs = exit ? null : nativeDialogFacts()
      if (!exit) await shot(`${s.scenario}-02-after-quit-shortcut`)
      let dismissed = null
      let exitAfterDismiss = null
      if (!exit) {
        dismissed = dismissNativeDialog('OK')
        exitAfterDismiss = await Promise.race([s.exitPromise, sleep(10000).then(() => null)])
      }
      return { exitedWithin10s: Boolean(exit), ms: Date.now() - t, mainResponsive: responsive, dialogs, dismissed, exitAfterDismiss }
    })
  } catch (e) {
    out.fatal = String(e && (e.stack || e.message || e))
  }
  if (s.app && !s.exit) await s.forceClose()
  s.saveLogs()
  out.session = s.summary()
  result.scenarios.errordialog = out
  writeJson(path.join(outDir, 'result.json'), result)
}

// ---------------------------------------------------------------------------------------------

async function main() {
  log(`smoke ${opts.label}: exe=${opts.exe} scenarios=${scenarios.join(',')} out=${outDir}`)
  const watchdog = setTimeout(() => {
    log(`WATCHDOG: run exceeded ${WATCHDOG_MS / 60000} min; writing partial results and killing the app`)
    result.fatal = `watchdog: run exceeded ${WATCHDOG_MS / 60000} min (last scenario: ${currentSession?.scenario}, last step: ${currentSession?.steps.at(-1)?.name})`
    flushPartialResult('watchdog')
    killAppProcesses()
    fs.writeFileSync(path.join(outDir, 'smoke.log'), logLines.join('\n'))
    process.exit(3)
  }, WATCHDOG_MS)
  watchdog.unref?.()
  result.exeExists = fs.existsSync(opts.exe)
  if (!result.exeExists) {
    result.fatal = `executable not found: ${opts.exe}`
    writeJson(path.join(outDir, 'result.json'), result)
    fs.writeFileSync(path.join(outDir, 'smoke.log'), logLines.join('\n'))
    process.exit(1)
  }
  for (const sc of scenarios) {
    try {
      if (sc === 'boot') await scenarioBoot()
      else if (sc === 'restore') await scenarioRestore()
      else if (sc === 'scale') await scenarioScale()
      else if (sc === 'dark') await scenarioDark()
      else if (sc === 'errordialog') await scenarioErrorDialog()
      else log(`unknown scenario ${sc}`)
    } catch (e) {
      result.scenarios[sc] = { fatal: String(e && (e.stack || e.message || e)) }
      log(`scenario ${sc} crashed the harness: ${e.message}`)
    }
    // Make sure no instance survives between scenarios (a lingering process would break the lock).
    // The pattern is anchored to the executable path so the harness (whose own command line
    // contains that path) does not kill itself; helpers die with the browser process.
    killAppProcesses()
    await sleep(1500)
  }
  clearTimeout(watchdog)
  for (const [name, sc] of Object.entries(result.scenarios)) {
    result.verdict[name] = {
      booted: Boolean(sc.session && sc.session.timings && sc.session.timings.chromeRenderedMs),
      zeroJsErrors: sc.session ? sc.session.zeroJsErrors : false,
      chromeConsoleErrors: sc.session ? sc.session.chromeConsoleErrors.length : null,
      pageErrors: sc.session ? sc.session.pageErrors.length : null,
      crashes: sc.session ? sc.session.crashesAndProcessLoss.length : null,
      failedSteps: sc.session ? sc.session.steps.filter((st) => !st.ok).map((st) => st.name) : null,
      timeToChromeMs: sc.session?.timings?.chromeRenderedMs ?? null,
      fatal: sc.fatal
    }
    if (name === 'errordialog' && sc.session) {
      const quit = sc.session.steps.find((st) => st.name === 'quit-shortcut-stock')?.detail
      const close = sc.session.steps.find((st) => st.name === 'close-first-window-with-loaded-page')?.detail
      result.verdict[name].stockQuitExitedWithin10s = quit?.exitedWithin10s ?? null
      result.verdict[name].stockQuitMainBlocked = quit?.mainResponsive === 'blocked'
      result.verdict[name].stockCloseMainBlocked = close?.mainResponsiveAfterClose === 'blocked'
    }
  }
  result.finishedAt = new Date().toISOString()
  writeJson(path.join(outDir, 'result.json'), result)
  fs.writeFileSync(path.join(outDir, 'smoke.log'), logLines.join('\n'))
  log(`done: ${JSON.stringify(result.verdict)}`)
}

main().catch((e) => {
  result.fatal = String(e && (e.stack || e.message || e))
  writeJson(path.join(outDir, 'result.json'), result)
  fs.writeFileSync(path.join(outDir, 'smoke.log'), logLines.join('\n'))
  console.error(e)
  process.exit(1)
})
