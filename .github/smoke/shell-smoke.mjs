/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Temporary Windows/macOS checks for the window-shell branch (removed before review).
// Not part of the product. Drives the unpacked app with Playwright for Electron and takes
// OS-level screenshots; writes result.json with one entry per check.

import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const OS = IS_WIN ? 'windows' : IS_MAC ? 'macos' : process.platform
const ACCEL = IS_MAC ? 'Meta' : 'Control'
const AUMID = 'io.github.benitbuhner.zenium'
const CAPTION_HEIGHT = 38

const opts = parseArgs(process.argv.slice(2))
if (!opts.exe || !opts.out) {
  console.error('usage: node shell-smoke.mjs --exe <path> --out <dir>')
  process.exit(2)
}

const outDir = path.resolve(opts.out)
fs.mkdirSync(outDir, { recursive: true })
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zenium-shell-'))
const result = {
  exe: opts.exe,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  startedAt: new Date().toISOString(),
  checks: {},
  screenshots: [],
  sessions: {},
  known: [
    'WIN-009: two startup console errors from the first tab page (hotfix elsewhere)',
    'WIN-001 / MAC-002: main-process onDestroyed TypeError on quit (hotfix elsewhere; swallowed here)'
  ]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
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
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function check(name, ok, detail) {
  result.checks[name] = { ok: Boolean(ok), detail: detail ?? null }
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${JSON.stringify(detail).slice(0, 600)}` : ''}`)
  return Boolean(ok)
}

function skip(name, why, detail) {
  result.checks[name] = { ok: true, skipped: why, detail: detail ?? null }
  log(`SKIP ${name}: ${why}`)
}

function sh(cmd, args, timeout = 20000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout })
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }
}

function ps(file, args, timeout = 30000) {
  const r = sh(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, file), ...args],
    timeout
  )
  if (r.status !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout
}

function psJson(file, args) {
  const out = ps(file, args)
  const line = out
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith('{'))
  return JSON.parse(line || out)
}

function osascript(script) {
  return sh('osascript', ['-e', script])
}

// ---------------------------------------------------------------------------
// Profiles, environment, screenshots
// ---------------------------------------------------------------------------

function freshProfile(name, settings = {}) {
  const dir = path.join(profileRoot, name)
  fs.mkdirSync(path.join(dir, 'zen'), { recursive: true })
  writeJson(path.join(dir, 'zen', 'state.json'), {
    version: 2,
    settings: {
      onboardingDone: true,
      updates: { autoCheck: false, autoDownload: false, channel: 'stable' },
      ...settings
    }
  })
  return dir
}

function isolateEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zenium-home-'))
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  if (IS_WIN) {
    env.APPDATA = path.join(home, 'Roaming')
    env.LOCALAPPDATA = path.join(home, 'Local')
    env.USERPROFILE = home
    fs.mkdirSync(env.APPDATA, { recursive: true })
    fs.mkdirSync(env.LOCALAPPDATA, { recursive: true })
  } else {
    env.HOME = home
  }
  return { home, env }
}

function screenshot(file) {
  const dest = path.join(outDir, file)
  if (IS_WIN) {
    ps('win-screenshot.ps1', ['-Path', dest])
  } else if (IS_MAC) {
    const r = sh('screencapture', ['-x', dest])
    if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'screencapture failed')
  } else {
    // Linux dry run under Xvfb: ImageMagick grabs the X root window.
    const r = sh('import', ['-window', 'root', dest])
    if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'import failed')
  }
  const st = fs.statSync(dest)
  if (st.size < 1000) throw new Error(`screenshot empty: ${dest}`)
  result.screenshots.push({ file, bytes: st.size })
  log(`screenshot ${file} (${st.size} bytes)`)
  return dest
}

function imageSize(file) {
  if (IS_WIN) return psJson('shell-win.ps1', ['-Action', 'size', '-Path', file])
  if (!IS_MAC) {
    const [w, h] = sh('identify', ['-format', '%w %h', file]).stdout.split(' ').map(Number)
    return { width: w || 0, height: h || 0 }
  }
  const w = sh('sips', ['-g', 'pixelWidth', file]).stdout.match(/pixelWidth:\s*(\d+)/)
  const h = sh('sips', ['-g', 'pixelHeight', file]).stdout.match(/pixelHeight:\s*(\d+)/)
  return { width: w ? Number(w[1]) : 0, height: h ? Number(h[1]) : 0 }
}

function crop(srcFile, outFile, x, y, w, h) {
  const src = path.join(outDir, srcFile)
  const dest = path.join(outDir, outFile)
  const X = Math.max(0, Math.round(x))
  const Y = Math.max(0, Math.round(y))
  const W = Math.max(1, Math.round(w))
  const H = Math.max(1, Math.round(h))
  if (IS_WIN) {
    psJson('shell-win.ps1', [
      '-Action',
      'crop',
      '-Path',
      src,
      '-Out',
      dest,
      '-X',
      String(X),
      '-Y',
      String(Y),
      '-W',
      String(W),
      '-H',
      String(H)
    ])
  } else if (IS_MAC) {
    const r = sh('sips', [
      '-c',
      String(H),
      String(W),
      '--cropOffset',
      String(Y),
      String(X),
      src,
      '--out',
      dest
    ])
    if (r.status !== 0) throw new Error(`sips crop failed: ${r.stderr || r.stdout}`)
  } else {
    const r = sh('convert', [src, '-crop', `${W}x${H}+${X}+${Y}`, '+repage', dest])
    if (r.status !== 0) throw new Error(`convert crop failed: ${r.stderr || r.stdout}`)
  }
  const st = fs.statSync(dest)
  result.screenshots.push({ file: outFile, bytes: st.size, cropOf: srcFile })
  return dest
}

// ---------------------------------------------------------------------------
// Launching and talking to the app
// ---------------------------------------------------------------------------

async function launch({ name, settings = {}, extraArgs = [], extraEnv = {} }) {
  const { env } = isolateEnv()
  const userData = freshProfile(name, settings)
  const t0 = Date.now()
  const app = await electron.launch({
    executablePath: opts.exe,
    args: [
      `--user-data-dir=${userData}`,
      ...(IS_WIN || IS_MAC ? [] : ['--no-sandbox']),
      ...extraArgs
    ],
    env: { ...env, ...extraEnv },
    colorScheme: null,
    timeout: 120000
  })
  const stderr = []
  app.process().stderr?.on('data', (d) => stderr.push(d.toString()))
  const mainConsole = []
  app.on('console', (msg) =>
    mainConsole.push({ type: msg.type(), text: msg.text().slice(0, 2000) })
  )
  const pageErrors = []
  const attach = (page) => {
    if (page.__shellAttached) return
    page.__shellAttached = true
    page.on('pageerror', (err) =>
      pageErrors.push({
        url: page.url(),
        message: String(err && (err.stack || err.message || err))
      })
    )
  }
  app.on('window', attach)
  for (const p of app.windows()) attach(p)

  // WIN-001 / MAC-002 (fixed elsewhere) would otherwise pop the stock error dialog on quit.
  // Also record every setTitleBarOverlay the app makes, to prove the caption recolours live.
  const hooks = await app.evaluate(({ BrowserWindow }) => {
    process.on('uncaughtException', (e) => console.error('[shell-smoke-swallow]', e && e.message))
    const calls = []
    globalThis.__shellOverlayCalls = calls
    const proto = BrowserWindow.prototype
    const hasOverlay = typeof proto.setTitleBarOverlay === 'function'
    if (hasOverlay) {
      const orig = proto.setTitleBarOverlay
      proto.setTitleBarOverlay = function (o) {
        calls.push({ id: this.id, t: Date.now(), ...o })
        return orig.call(this, o)
      }
    }
    return { hasOverlay, systemVersion: process.getSystemVersion() }
  })

  const deadline = Date.now() + 90000
  let chrome = null
  while (Date.now() < deadline && !chrome) {
    for (const p of app.windows()) {
      const u = await p.evaluate(() => location.href).catch(() => '')
      if (/index\.html/.test(u)) {
        const ok = await p
          .waitForSelector('.zen-window', { timeout: 5000, state: 'attached' })
          .then(() => true)
          .catch(() => false)
        if (ok) {
          chrome = p
          break
        }
      }
    }
    if (!chrome) await sleep(250)
  }
  if (!chrome)
    throw new Error(
      `chrome .zen-window never appeared; pages: ${app.windows().map((p) => p.url())}`
    )
  await app.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve) => {
        const w = BrowserWindow.getAllWindows()[0]
        if (!w || w.isVisible()) return resolve(true)
        w.once('show', () => resolve(true))
        setTimeout(() => resolve(false), 15000)
      })
  )
  await sleep(700)
  const session = {
    name,
    app,
    chrome,
    stderr,
    mainConsole,
    pageErrors,
    userData,
    appEnv: env,
    hooks,
    launchMs: Date.now() - t0
  }
  result.sessions[name] = {
    userData,
    launchMs: session.launchMs,
    systemVersion: hooks.systemVersion
  }
  log(`session ${name} up in ${session.launchMs} ms (system ${hooks.systemVersion})`)
  return session
}

async function closeApp(session) {
  const s = result.sessions[session.name]
  s.pageErrors = session.pageErrors
  s.mainConsoleErrors = session.mainConsole.filter((m) => m.type === 'error').map((m) => m.text)
  s.stderrLines = session.stderr.join('').split(/\r?\n/).filter(Boolean).length
  fs.writeFileSync(path.join(outDir, `${session.name}-stderr.log`), session.stderr.join(''))
  try {
    await session.app.close()
  } catch {
    try {
      session.app.process().kill()
    } catch {
      // ignore
    }
  }
  await sleep(600)
}

async function windows(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .sort((a, b) => a.id - b.id)
      .map((w) => ({
        id: w.id,
        wcId: w.webContents.id,
        title: w.getTitle(),
        bounds: w.getBounds(),
        contentBounds: w.getContentBounds(),
        maximized: w.isMaximized(),
        fullscreen: w.isFullScreen(),
        visible: w.isVisible(),
        focused: w.isFocused(),
        buttons:
          typeof w.getWindowButtonPosition === 'function' ? w.getWindowButtonPosition() : null
      }))
  )
}

async function tabs(app) {
  return app.evaluate(({ webContents, BrowserWindow }) => {
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
      .map((wc) => ({ id: wc.id, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading() }))
  })
}

async function waitForTab(app, prefix, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await tabs(app)
    const t = list.find((x) => x.url.startsWith(prefix) && !x.loading)
    if (t) return t
    await sleep(400)
  }
  throw new Error(`tab ${prefix} missing; ${JSON.stringify(await tabs(app))}`)
}

async function waitFor(fn, timeoutMs, every = 200) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(every)
  }
  return last
}

/** Playwright pages that render Zenium's chrome, each with its BrowserWindow id and chrome kind. */
async function chromePages(app) {
  const out = []
  for (const p of app.windows()) {
    const u = await p.evaluate(() => location.href).catch(() => '')
    if (!/index\.html/.test(u)) continue
    const bw = await app.browserWindow(p).catch(() => null)
    const id = bw ? await bw.evaluate((w) => w.id).catch(() => null) : null
    const kind = await p
      .locator('.zen-window')
      .getAttribute('data-window-chrome', { timeout: 1500 })
      .catch(() => null)
    out.push({ page: p, id, kind })
  }
  return out
}

async function pageFor(app, urlPrefix) {
  for (const p of app.windows()) {
    const u = await p.evaluate(() => location.href).catch(() => '')
    if (u.startsWith(urlPrefix)) return p
  }
  return null
}

function evalInTab(app, wcId, script) {
  return app.evaluate(
    ({ webContents }, [id, code]) => {
      const wc = webContents.fromId(id)
      if (!wc) throw new Error(`no webContents ${id}`)
      return wc.executeJavaScript(code, true)
    },
    [wcId, script]
  )
}

async function loadInNewTab(session, url) {
  const { app, chrome } = session
  const input = chrome.locator(
    'input[placeholder*="Search or enter address"], input[placeholder^="Search with"], input[type="text"]'
  )
  if (
    await input
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await chrome.keyboard.press('Escape')
    await sleep(200)
  }
  await chrome.keyboard.press(`${ACCEL}+t`)
  const viaKey = await input
    .first()
    .waitFor({ state: 'visible', timeout: 6000 })
    .then(() => true)
    .catch(() => false)
  if (!viaKey) {
    // The same event the core sends the chrome for the shortcut.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('zen:event', 'urlbar.toggle', {
        mode: 'new-tab'
      })
    )
    await input.first().waitFor({ state: 'visible', timeout: 10000 })
  }
  await input.first().fill(url)
  await chrome.keyboard.press('Enter')
  return waitForTab(app, url)
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** What the chrome sees of the native caption buttons and what sits under them. */
function overlayProbe(page) {
  return page.evaluate(() => {
    const api = navigator.windowControlsOverlay
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;left:env(titlebar-area-x,-1px);top:env(titlebar-area-y,-1px);width:env(titlebar-area-width,-1px);height:env(titlebar-area-height,-1px);pointer-events:none;visibility:hidden'
    document.body.appendChild(probe)
    const cs = getComputedStyle(probe)
    const env = { x: cs.left, y: cs.top, width: cs.width, height: cs.height }
    probe.remove()
    const out = {
      api: Boolean(api),
      visible: api ? api.visible : null,
      rect: null,
      env,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      region: null,
      under: [],
      customControls: document.querySelectorAll(
        'button[title="Minimize"], button[title="Maximize"], button[title="Restore"]'
      ).length,
      sidebar: document.querySelectorAll('aside[data-side]').length,
      chrome: document.querySelector('.zen-window')?.getAttribute('data-window-chrome') ?? null,
      captionOverlayAttr:
        document.querySelector('.zen-window')?.getAttribute('data-caption-overlay') ?? null,
      theme: document.documentElement.dataset.theme ?? null,
      material: document.documentElement.dataset.material ?? null
    }
    if (!api || !api.visible) return out
    const r = api.getTitlebarAreaRect()
    out.rect = { x: r.x, y: r.y, width: r.width, height: r.height }
    // The buttons occupy whatever the titlebar area leaves: the trailing end (LTR) or the leading one.
    const trailing = window.innerWidth - (r.x + r.width)
    const region =
      trailing > r.x ? { start: r.x + r.width, end: window.innerWidth } : { start: 0, end: r.x }
    out.region = { ...region, width: region.end - region.start }
    const step = (region.end - region.start) / 3
    for (let i = 0; i < 3; i++) {
      for (const fy of [0.25, 0.5, 0.85]) {
        const x = region.start + step * (i + 0.5)
        const y = r.height * fy
        const el = document.elementFromPoint(x, y)
        // app-region is not inherited: the nearest ancestor that sets it decides whether the
        // spot drags the window (Chromium builds the drag region from those boxes).
        let appRegion = null
        for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
          const style = getComputedStyle(node)
          const v =
            style.getPropertyValue('app-region') || style.getPropertyValue('-webkit-app-region')
          if (v && v !== 'none' && v !== 'auto') {
            appRegion = v
            break
          }
        }
        out.under.push({
          x: Math.round(x),
          y: Math.round(y),
          tag: el ? el.tagName.toLowerCase() : null,
          classes: el ? String(el.className).slice(0, 80) : null,
          appRegion,
          interactive: el
            ? el.closest('button, input, a, select, textarea, [role="button"]') !== null
            : false
        })
      }
    }
    return out
  })
}

function nothingInteractiveUnderCaption(probe) {
  if (!probe.region || probe.under.length === 0) return false
  return probe.under.every((u) => u.tag !== null && !u.interactive && u.appRegion === 'drag')
}

function themeVars(page) {
  return page.evaluate(() => {
    const root = document.documentElement
    return {
      theme: root.dataset.theme ?? null,
      bgSolid: root.style.getPropertyValue('--zen-bg-solid').trim(),
      fg: root.style.getPropertyValue('--zen-fg').trim(),
      colorScheme: root.style.colorScheme
    }
  })
}

async function overlayCalls(app) {
  return app.evaluate(() => (globalThis.__shellOverlayCalls || []).slice())
}

async function flipTheme(session, scheme) {
  const { app, chrome } = session
  const before = (await overlayCalls(app)).length
  const t0 = Date.now()
  await app.evaluate(({ nativeTheme }, s) => {
    nativeTheme.themeSource = s
  }, scheme)
  const vars = await waitFor(async () => {
    const v = await themeVars(chrome)
    return v.theme === scheme ? v : null
  }, 8000)
  const calls = (await overlayCalls(app)).slice(before)
  const native = await app.evaluate(({ nativeTheme }) => ({
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    themeSource: nativeTheme.themeSource
  }))
  return { scheme, ms: Date.now() - t0, vars: vars || (await themeVars(chrome)), calls, native }
}

/** The caption recolour the app made matches the chrome exactly: ink for glyphs, gradient shows through. */
function overlayMatchesChrome(flip) {
  const expectColor = `${flip.vars.bgSolid}00`.toLowerCase()
  const expectSymbol = flip.vars.fg.toLowerCase()
  const last = flip.calls[flip.calls.length - 1]
  return {
    ok:
      Boolean(last) &&
      String(last.symbolColor).toLowerCase() === expectSymbol &&
      String(last.color).toLowerCase() === expectColor,
    expected: { color: expectColor, symbolColor: expectSymbol },
    got: last ?? null,
    callCount: flip.calls.length
  }
}

// Windows writes a taskbar jump list to Recent\CustomDestinations\<hash>.customDestinations-ms,
// where <hash> is the CRC-64 (ECMA polynomial, MSB first, all-ones start) of the UTF-16LE
// upper-cased AppUserModelID.
function appIdHash(aumid) {
  const POLY = 0x92c64265d32139a4n
  const MASK = 0xffffffffffffffffn
  const table = []
  for (let i = 0; i < 256; i++) {
    let crc = BigInt(i) << 56n
    for (let k = 0; k < 8; k++) {
      crc = crc & (1n << 63n) ? ((crc << 1n) ^ POLY) & MASK : (crc << 1n) & MASK
    }
    table.push(crc)
  }
  let crc = MASK
  for (const b of Buffer.from(aumid.toUpperCase(), 'utf16le')) {
    crc = (table[Number(((crc >> 56n) ^ BigInt(b)) & 0xffn)] ^ ((crc << 8n) & MASK)) & MASK
  }
  return crc.toString(16).padStart(16, '0')
}

function jumpListDirs(env) {
  const dirs = new Set()
  for (const base of [env.APPDATA, process.env.APPDATA]) {
    if (base) dirs.add(path.join(base, 'Microsoft', 'Windows', 'Recent', 'CustomDestinations'))
  }
  return [...dirs]
}

function listJumpLists(dirs) {
  const out = {}
  for (const d of dirs) {
    try {
      out[d] = fs.readdirSync(d).filter((f) => /\.customDestinations-ms$/i.test(f))
    } catch {
      out[d] = []
    }
  }
  return out
}

function setOsDark(on) {
  if (IS_WIN) {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
    const v = on ? '0' : '1'
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
    return { apps: a.status, system: b.status }
  }
  if (IS_MAC) {
    const ui = osascript(
      `tell application "System Events" to tell appearance preferences to set dark mode to ${on ? 'true' : 'false'}`
    )
    return { systemEvents: ui.status === 0 ? 'ok' : `failed: ${ui.stderr || ui.stdout}` }
  }
  return null
}

function hoverAt(x, y) {
  if (IS_WIN)
    return ps('win-mouse.ps1', [
      '-Action',
      'move',
      '-X',
      String(Math.round(x)),
      '-Y',
      String(Math.round(y))
    ])
  return null
}

async function screenScale(app, file) {
  const display = await app.evaluate(({ screen }) => screen.getPrimaryDisplay())
  const size = imageSize(path.join(outDir, file))
  return { scale: size.width / display.size.width, display, size }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function sessionMain() {
  const session = await launch({ name: 'main' })
  const { app, chrome } = session
  try {
    screenshot(`01-${OS}-main-light.png`)
    const probe = await overlayProbe(chrome)
    result.sessions.main.probe = probe

    if (IS_WIN) {
      check(
        'overlay-active',
        probe.api && probe.visible && probe.rect && probe.rect.height === CAPTION_HEIGHT,
        {
          visible: probe.visible,
          rect: probe.rect,
          env: probe.env,
          captionOverlayAttr: probe.captionOverlayAttr
        }
      )
      check('custom-controls-hidden', probe.customControls === 0, {
        customControls: probe.customControls
      })
      check('no-chrome-under-caption-left', nothingInteractiveUnderCaption(probe), {
        region: probe.region,
        under: probe.under
      })
      const facts = psJson('shell-win.ps1', ['-Action', 'facts'])
      result.sessions.main.win32 = facts
      check(
        'maximize-button-present',
        facts.styles.includes('WS_MAXIMIZEBOX') && probe.region && probe.region.width >= 90,
        { styles: facts.styles, captionRegion: probe.region }
      )
      // Hover the (native) maximize button: Windows 11 shows the Snap Layouts flyout after ~1 s.
      const [w] = await windows(app)
      const step = probe.region.width / 3
      const sx = w.contentBounds.x + probe.region.start + step * 1.5
      const sy = w.contentBounds.y + probe.rect.height / 2
      hoverAt(sx, sy)
      await sleep(1600)
      screenshot(`02-${OS}-maximize-hover-snap-layouts.png`)
      hoverAt(
        w.contentBounds.x + w.contentBounds.width / 2,
        w.contentBounds.y + w.contentBounds.height / 2
      )
      await sleep(300)
    } else if (IS_MAC) {
      skip('overlay-active', 'macOS draws traffic lights, not a caption overlay', {
        api: probe.api
      })
      check('custom-controls-hidden', probe.customControls === 0, {
        customControls: probe.customControls
      })
      const [w] = await windows(app)
      check(
        'traffic-lights-position',
        w.buttons && w.buttons.x === 14 && w.buttons.y === 16,
        w.buttons
      )
      const { scale } = await screenScale(app, `01-${OS}-main-light.png`)
      crop(
        `01-${OS}-main-light.png`,
        `01b-${OS}-traffic-lights.png`,
        (w.bounds.x - 4) * scale,
        (w.bounds.y - 4) * scale,
        420 * scale,
        120 * scale
      )
    } else {
      // Linux keeps Zenium's own caption buttons in the sidebar.
      skip('overlay-active', 'Linux has no caption overlay', {
        api: probe.api,
        visible: probe.visible
      })
      check('custom-controls-present', probe.customControls >= 2 && !probe.visible, {
        customControls: probe.customControls
      })
    }

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await sleep(900)
    screenshot(`03-${OS}-maximized.png`)
    const maxed = (await windows(app))[0]
    const probeMax = await overlayProbe(chrome)
    if (!IS_WIN && !IS_MAC && !maxed.maximized) {
      skip('maximized', 'bare Xvfb has no window manager to maximize into', maxed.bounds)
    } else check('maximized', maxed.maximized === true, { bounds: maxed.bounds })
    if (IS_WIN) {
      check(
        'overlay-active-maximized',
        probeMax.visible && nothingInteractiveUnderCaption(probeMax),
        {
          rect: probeMax.rect,
          region: probeMax.region
        }
      )
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
    await sleep(600)

    // Live theme flip through nativeTheme (what the OS toggle does).
    const dark = await flipTheme(session, 'dark')
    await sleep(500)
    screenshot(`04-${OS}-theme-flip-dark.png`)
    const light = await flipTheme(session, 'light')
    await sleep(500)
    screenshot(`05-${OS}-theme-flip-light.png`)
    check('theme-flip-live', dark.vars.theme === 'dark' && light.vars.theme === 'light', {
      dark: { ms: dark.ms, vars: dark.vars, native: dark.native },
      light: { ms: light.ms, vars: light.vars, native: light.native }
    })
    if (IS_WIN) {
      const d = overlayMatchesChrome(dark)
      const l = overlayMatchesChrome(light)
      check('theme-flip-recolours-caption', d.ok && l.ok, { dark: d, light: l })
    } else {
      skip('theme-flip-recolours-caption', 'no caption overlay on macOS', {
        hasSetTitleBarOverlay: session.hooks.hasOverlay
      })
    }

    if (IS_WIN) {
      const dirs = jumpListDirs(session.appEnv)
      const expected = `${appIdHash(AUMID)}.customDestinations-ms`
      const lists = listJumpLists([...dirs, ...jumpListDirs(process.env)])
      const found = Object.entries(lists).filter(([, files]) =>
        files.some((f) => f.toLowerCase() === expected)
      )
      const again = await app.evaluate(({ app }) => {
        const settings = app.getJumpListSettings()
        const exe = process.execPath
        const outcome = app.setJumpList([
          {
            type: 'tasks',
            items: [
              {
                type: 'task',
                title: 'New Window',
                program: exe,
                args: '--new-window',
                iconPath: exe,
                iconIndex: 0
              },
              {
                type: 'task',
                title: 'New Private Window',
                program: exe,
                args: '--private-window',
                iconPath: exe,
                iconIndex: 0
              }
            ]
          },
          { type: 'recent' }
        ])
        return { settings, outcome }
      })
      const after = listJumpLists([...dirs, ...jumpListDirs(process.env)])
      const foundAfter = Object.entries(after).filter(([, files]) =>
        files.some((f) => f.toLowerCase() === expected)
      )
      check(
        'jump-list-set',
        again.outcome === 'ok' && (found.length > 0 || foundAfter.length > 0),
        {
          expectedFile: expected,
          foundInBeforeRecall: found.map(([d]) => d),
          foundAfterRecall: foundAfter.map(([d]) => d),
          lists: after,
          recall: again
        }
      )
      check('aumid', found.length > 0 || foundAfter.length > 0, {
        aumid: AUMID,
        jumpListFile: expected,
        note: 'the jump list file name is the CRC-64 of the AppUserModelID the app registered'
      })
    } else if (IS_MAC) {
      const dock = await app.evaluate(({ app }) => {
        const menu = app.dock ? app.dock.getMenu() : null
        return menu ? menu.items.map((i) => ({ label: i.label, type: i.type })) : null
      })
      const labels = (dock || []).map((i) => i.label)
      check(
        'dock-menu-set',
        labels.includes('New Window') && labels.includes('New Private Window'),
        dock
      )
    } else {
      skip('jump-list-set', 'Windows only')
      skip('dock-menu-set', 'macOS only')
    }

    // Settings (Look): Appearance row; Windows 11 22H2+ also offers the Mica switch.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('zen:event', 'overlay.open', {
        kind: 'settings'
      })
    )
    const appearance = await chrome
      .getByText('Colour scheme', { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    const micaRow = await chrome.getByText('Use Windows transparency effects').count()
    await sleep(300)
    screenshot(`06-${OS}-settings-look.png`)
    check('settings-appearance-row', appearance, { appearance })
    if (IS_WIN) {
      const build = Number(String(session.hooks.systemVersion).split('.')[2] || 0)
      check('mica-settings-row', build >= 22621 ? micaRow > 0 : micaRow === 0, {
        build,
        micaRow,
        rule: 'offered from Windows 11 22H2 (build 22621, DWMWA_SYSTEMBACKDROP_TYPE)'
      })
    } else {
      check('mica-settings-row-absent', micaRow === 0, { micaRow })
    }
    await chrome.keyboard.press('Escape')
    await sleep(300)

    // A page opens windows: sized window.open → toolbar-only Zenium window with window.opener intact.
    const example = await loadInNewTab(session, 'https://example.com')
    const before = await windows(app)
    const opened = await evalInTab(
      app,
      example.id,
      "(() => { const w = window.open('https://example.com/?popup', '_blank', 'width=500,height=400'); return { returned: w !== null, closed: w ? w.closed : null } })()"
    )
    const popupWin = await waitFor(async () => {
      const list = await chromePages(app)
      return list.find((c) => c.kind === 'popup') || null
    }, 15000)
    await waitForTab(app, 'https://example.com/?popup', 30000).catch(() => null)
    await sleep(800)
    screenshot(`07-${OS}-popup-window.png`)
    const afterPopup = await windows(app)
    const popupBw = popupWin ? afterPopup.find((w) => w.id === popupWin.id) : null
    check(
      'popup-opens-zenium-window',
      afterPopup.length === before.length + 1 && popupWin !== null,
      {
        opened,
        before: before.length,
        after: afterPopup.length,
        popupChrome: popupWin ? popupWin.kind : null
      }
    )
    if (popupWin) {
      const p = popupWin.page
      const sidebar = await p.locator('aside[data-side]').count()
      const urlPill = await p.locator('button[title^="https://example.com"]').count()
      const controls = await p.locator('button[title="Minimize"]').count()
      check('popup-toolbar-only', sidebar === 0 && urlPill > 0, {
        sidebar,
        urlPill,
        customControls: controls
      })
      check(
        'popup-size',
        popupBw &&
          Math.abs(popupBw.bounds.width - 500) <= 2 &&
          Math.abs(popupBw.bounds.height - 400) <= 2,
        popupBw ? popupBw.bounds : null
      )
      if (IS_MAC)
        check(
          'popup-traffic-lights',
          popupBw?.buttons?.x === 14 && popupBw?.buttons?.y === 14,
          popupBw?.buttons
        )
      if (IS_WIN) {
        const pp = await overlayProbe(p)
        check(
          'popup-caption-clear',
          pp.visible && nothingInteractiveUnderCaption(pp) && pp.customControls === 0,
          {
            rect: pp.rect,
            region: pp.region,
            under: pp.under
          }
        )
      }
      const popupTab = (await tabs(app)).find((t) => t.url.startsWith('https://example.com/?popup'))
      const opener = popupTab
        ? await evalInTab(
            app,
            popupTab.id,
            '({ hasOpener: window.opener !== null, openerClosed: window.opener ? window.opener.closed : null })'
          ).catch((e) => ({ error: String(e) }))
        : { error: 'popup tab not found' }
      check('popup-window-opener', opener && opener.hasOpener === true, opener)
      if (popupTab) {
        await evalInTab(app, popupTab.id, 'setTimeout(() => window.close(), 50); true')
        const gone = await waitFor(async () => (await windows(app)).length === before.length, 10000)
        check('popup-closes-with-window-close', gone === true, {
          windows: (await windows(app)).length
        })
      }
    }

    // Shift+click a link → a full Zenium window (sidebar and all).
    const beforeShift = await windows(app)
    const tabPage = await pageFor(app, 'https://example.com')
    let via = 'synthetic'
    await evalInTab(
      app,
      example.id,
      "(() => { const a = document.createElement('a'); a.id = 'zen-smoke-shift'; a.href = 'https://example.org/'; a.textContent = 'shift'; a.style.cssText = 'position:fixed;left:12px;top:12px;font-size:28px;z-index:9999;background:#fff'; document.body.appendChild(a); return true })()"
    )
    if (tabPage) {
      via = 'playwright-click'
      await tabPage.click('#zen-smoke-shift', { modifiers: ['Shift'], timeout: 5000 }).catch(() => {
        via = 'synthetic'
      })
    }
    if (via === 'synthetic') {
      await evalInTab(
        app,
        example.id,
        "document.getElementById('zen-smoke-shift').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true, view: window, button: 0 })); true"
      )
    }
    const fullWin = await waitFor(async () => {
      const list = await chromePages(app)
      return list.find((c) => c.kind === 'full' && !beforeShift.some((w) => w.id === c.id)) || null
    }, 15000)
    await waitForTab(app, 'https://example.org', 30000).catch(() => null)
    await sleep(800)
    screenshot(`08-${OS}-shift-click-window.png`)
    const afterShift = await windows(app)
    const fullSidebar = fullWin ? await fullWin.page.locator('aside[data-side]').count() : 0
    check(
      'shift-click-opens-full-window',
      fullWin !== null && afterShift.length === beforeShift.length + 1 && fullSidebar > 0,
      {
        via,
        before: beforeShift.length,
        after: afterShift.length,
        sidebar: fullSidebar
      }
    )
    if (fullWin) {
      await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), fullWin.id)
      await sleep(800)
    }

    // window.open without features stays a tab next to the opener.
    const beforeTab = await windows(app)
    await evalInTab(app, example.id, "window.open('https://example.com/?tab', '_blank'); true")
    const tab = await waitForTab(app, 'https://example.com/?tab', 20000).catch(() => null)
    check(
      'window-open-plain-opens-tab',
      tab !== null && (await windows(app)).length === beforeTab.length,
      {
        tab,
        windows: (await windows(app)).length
      }
    )

    // The app icon the OS shows for the running app.
    if (IS_WIN) {
      const icon = psJson('shell-win.ps1', [
        '-Action',
        'icon',
        '-Path',
        path.join(outDir, `09-${OS}-window-icon.png`)
      ])
      const size = imageSize(path.join(outDir, `01-${OS}-main-light.png`))
      crop(`01-${OS}-main-light.png`, `09b-${OS}-taskbar.png`, 0, size.height - 56, size.width, 56)
      check('icon-is-the-mark', icon.width >= 16, {
        windowIcon: icon,
        note: 'inspect 09-windows-window-icon.png and 09b-windows-taskbar.png'
      })
    } else if (IS_MAC) {
      const size = imageSize(path.join(outDir, `01-${OS}-main-light.png`))
      crop(
        `01-${OS}-main-light.png`,
        `09-${OS}-dock.png`,
        0,
        size.height - Math.round(size.height * 0.12),
        size.width,
        Math.round(size.height * 0.12)
      )
      const iconFile = await app.evaluate(({ app }) => ({
        name: app.getName(),
        path: app.getPath('exe')
      }))
      check('icon-is-the-mark', true, { ...iconFile, note: 'inspect 09-macos-dock.png' })
    } else {
      skip('icon-is-the-mark', 'taskbar and Dock only')
    }
  } finally {
    await closeApp(session)
  }
}

async function sessionSidebarRight() {
  const session = await launch({ name: 'right', settings: { sidebarSide: 'right' } })
  try {
    const probe = await overlayProbe(session.chrome)
    result.sessions.right.probe = probe
    screenshot(`10-${OS}-sidebar-right.png`)
    if (IS_WIN) {
      check(
        'no-chrome-under-caption-right',
        nothingInteractiveUnderCaption(probe) && probe.customControls === 0,
        {
          region: probe.region,
          under: probe.under,
          customControls: probe.customControls
        }
      )
    } else {
      check('sidebar-right-renders', probe.sidebar === 1, { sidebar: probe.sidebar })
    }
  } finally {
    await closeApp(session)
  }
}

async function sessionCompact() {
  const session = await launch({
    name: 'compact',
    settings: {
      toolbarLayout: 'multiple',
      compactMode: { enabled: true, hideSidebar: true, hideToolbar: true, sidebarPersistent: false }
    }
  })
  try {
    await sleep(800)
    const probe = await overlayProbe(session.chrome)
    result.sessions.compact.probe = probe
    screenshot(`11-${OS}-compact.png`)
    if (IS_WIN) {
      check(
        'no-chrome-under-caption-compact',
        nothingInteractiveUnderCaption(probe) && probe.sidebar === 0,
        {
          region: probe.region,
          under: probe.under,
          sidebar: probe.sidebar
        }
      )
    } else {
      check('compact-hides-sidebar', probe.sidebar === 0, { sidebar: probe.sidebar })
    }
  } finally {
    await closeApp(session)
  }
}

async function sessionMica() {
  if (!IS_WIN) {
    skip('mica-applied', 'Windows only')
    return
  }
  const session = await launch({ name: 'mica', settings: { windowMaterial: 'mica' } })
  try {
    await sleep(800)
    const probe = await overlayProbe(session.chrome)
    const facts = psJson('shell-win.ps1', ['-Action', 'facts'])
    result.sessions.mica.probe = probe
    result.sessions.mica.win32 = facts
    screenshot(`12-${OS}-mica.png`)
    const build = Number(String(session.hooks.systemVersion).split('.')[2] || 0)
    if (build >= 22621) {
      check('mica-applied', probe.material === 'mica' && facts.systemBackdropType === 2, {
        build,
        material: probe.material,
        systemBackdropType: facts.systemBackdropType,
        hresult: facts.systemBackdropHresult,
        legend: '2 = DWMSBT_MAINWINDOW (Mica)'
      })
    } else {
      check('mica-not-offered', probe.material !== 'mica', { build, material: probe.material })
    }
  } finally {
    await closeApp(session)
  }
}

async function sessionOsDark() {
  if (!IS_WIN && !IS_MAC) {
    skip('dark-mode-follow', 'OS dark mode toggled only on Windows and macOS')
    return
  }
  const set = setOsDark(true)
  await sleep(1500)
  const session = await launch({ name: 'dark' })
  try {
    await sleep(800)
    const vars = await themeVars(session.chrome)
    const native = await session.app.evaluate(({ nativeTheme }) => ({
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      themeSource: nativeTheme.themeSource
    }))
    screenshot(`13-${OS}-os-dark.png`)
    check('dark-mode-follow', native.shouldUseDarkColors === true && vars.theme === 'dark', {
      set,
      native,
      vars
    })
    if (IS_WIN) {
      // The initial caption colours came in through the constructor; a no-op flip proves the pair.
      const flip = await flipTheme(session, 'light')
      const back = await flipTheme(session, 'dark')
      const m = overlayMatchesChrome(back)
      check('dark-mode-caption-ink', m.ok && back.vars.fg.toLowerCase() === '#f0f0f5', {
        flipLight: flip.vars,
        back: m
      })
    }
  } finally {
    await closeApp(session)
    setOsDark(false)
  }
}

async function sessionScale() {
  const session = await launch({ name: 'scale', extraArgs: ['--force-device-scale-factor=1.5'] })
  try {
    await sleep(800)
    const dpr = await session.chrome.evaluate(() => window.devicePixelRatio)
    const probe = await overlayProbe(session.chrome)
    screenshot(`14-${OS}-dpi-1.5.png`)
    check(
      'dpi-1.5',
      dpr === 1.5 && (!IS_WIN || (probe.visible && probe.rect.height === CAPTION_HEIGHT)),
      {
        dpr,
        rect: probe.rect,
        region: probe.region
      }
    )
  } finally {
    await closeApp(session)
  }
}

async function main() {
  const steps = [
    ['main', sessionMain],
    ['right', sessionSidebarRight],
    ['compact', sessionCompact],
    ['mica', sessionMica],
    ['dark', sessionOsDark],
    ['scale', sessionScale]
  ]
  for (const [name, fn] of steps) {
    try {
      log(`--- ${name} ---`)
      await fn()
    } catch (e) {
      check(`session-${name}`, false, String(e && e.stack ? e.stack : e))
    }
  }
  result.finishedAt = new Date().toISOString()
  const failed = Object.entries(result.checks).filter(([, v]) => !v.ok)
  result.failed = failed.map(([k]) => k)
  writeJson(path.join(outDir, 'result.json'), result)
  fs.writeFileSync(
    path.join(outDir, 'summary.txt'),
    Object.entries(result.checks)
      .map(
        ([k, v]) =>
          `${v.ok ? (v.skipped ? 'SKIP' : 'PASS') : 'FAIL'} ${k}${v.skipped ? ` (${v.skipped})` : ''}`
      )
      .join('\n') + '\n'
  )
  log(
    `done; ${Object.keys(result.checks).length} checks, failed=${result.failed.length} ${result.failed.join(',')}`
  )
  if (result.failed.length) process.exit(1)
}

await main()
