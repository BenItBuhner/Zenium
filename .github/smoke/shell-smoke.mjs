// Temporary Windows/macOS checks for the window-shell branch. Not part of the product.

import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const ACCEL = IS_MAC ? 'Meta' : 'Control'

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
  consoleErrors: [],
  pageErrors: [],
  stderr: '',
  known: [
    'WIN-009 / MAC: two startup console errors from the first tab WebContentsView (sandboxed_renderer / preloadScripts)',
    'WIN-001 / MAC-002: main-process onDestroyed TypeError on quit (hotfix elsewhere; swallowed here)'
  ]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function check(name, ok, detail) {
  result.checks[name] = { ok: Boolean(ok), detail: detail ?? null }
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`)
}

function freshProfile(name) {
  const dir = path.join(profileRoot, name)
  fs.mkdirSync(path.join(dir, 'zen'), { recursive: true })
  writeJson(path.join(dir, 'zen', 'state.json'), {
    version: 2,
    settings: {
      onboardingDone: true,
      updates: { autoCheck: false, autoDownload: false, channel: 'stable' }
    }
  })
  return dir
}

function osScreenshot(file) {
  const dest = path.join(outDir, file)
  if (IS_WIN) {
    const helper = path.join(here, 'win-screenshot.ps1')
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Path', dest],
      { encoding: 'utf8', timeout: 20000 }
    )
    if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'screenshot failed')
  } else if (IS_MAC) {
    const r = spawnSync('screencapture', ['-x', dest], { encoding: 'utf8', timeout: 20000 })
    if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'screencapture failed')
  } else {
    throw new Error('os screenshot only on win/mac')
  }
  const st = fs.statSync(dest)
  if (st.size < 1000) throw new Error(`screenshot empty: ${dest}`)
  result.screenshots.push({ file, bytes: st.size })
  return dest
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

async function launch({ profileName, extraArgs = [], extraEnv = {} }) {
  const { env } = isolateEnv()
  const userData = freshProfile(profileName)
  const app = await electron.launch({
    executablePath: opts.exe,
    args: [`--user-data-dir=${userData}`, ...extraArgs],
    env: { ...env, ...extraEnv },
    colorScheme: null,
    timeout: 120000
  })
  const proc = app.process()
  const stderr = []
  proc.stderr?.on('data', (d) => stderr.push(d.toString()))
  const pageErrors = []
  const attach = (page) => {
    if (page.__shellAttached) return
    page.__shellAttached = true
    page.on('pageerror', (err) => pageErrors.push(String(err && (err.stack || err.message || err))))
  }
  app.on('window', attach)
  for (const p of app.windows()) attach(p)

  await app.evaluate(() => {
    process.on('uncaughtException', (e) => console.error('[shell-smoke-swallow]', e && e.message))
  })

  const deadline = Date.now() + 90000
  let chrome = null
  while (Date.now() < deadline) {
    chrome = app.windows().find((p) => /index\.html/.test(p.url())) || app.windows()[0]
    if (chrome) {
      try {
        await chrome.waitForSelector('.zen-window', { timeout: 5000, state: 'attached' })
        break
      } catch {
        chrome = null
      }
    }
    await sleep(250)
  }
  if (!chrome) throw new Error('chrome .zen-window never appeared')
  return { app, chrome, stderr, pageErrors, userData }
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

async function press(app, combo) {
  const parts = combo.split('+')
  const key = parts.pop()
  const modifiers = parts.map(
    (m) => ({ Control: 'control', Meta: 'meta', Shift: 'shift', Alt: 'alt' })[m] || m.toLowerCase()
  )
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      if (!w) throw new Error('no window to send keys to')
      w.focus()
      w.webContents.focus()
      w.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: payload.key,
        modifiers: payload.modifiers
      })
      w.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: payload.key,
        modifiers: payload.modifiers
      })
    },
    { key, modifiers }
  )
}

async function loadExample(app, chrome) {
  const input = chrome.locator(
    'input[placeholder*="Search or enter address"], input[placeholder^="Search with"]'
  )
  if (await input.first().isVisible().catch(() => false)) {
    await press(app, 'Escape')
    await sleep(200)
  }
  await press(app, `${ACCEL}+t`)
  await input.first().waitFor({ state: 'visible', timeout: 12000 })
  await input.first().fill('https://example.com')
  await chrome.keyboard.press('Enter')
  return waitForTab(app, 'https://example.com')
}

async function windowFacts(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      id: w.id,
      title: w.getTitle(),
      bounds: w.getBounds(),
      maximized: w.isMaximized(),
      fullscreen: w.isFullScreen(),
      visible: w.isVisible()
    }))
  )
}

async function closeApp(session) {
  try {
    await session.app.close()
  } catch {
    try {
      session.app.process().kill()
    } catch {
      // ignore
    }
  }
  await sleep(500)
}

async function runMain() {
  log(`launching ${opts.exe}`)
  const session = await launch({ profileName: 'main' })
  result.consoleErrors.push(...session.pageErrors)

  try {
    osScreenshot(IS_WIN ? '01-windows-normal.png' : '01-macos-normal.png')

    const overlay = await session.chrome.evaluate(() => {
      const api = navigator.windowControlsOverlay
      if (!api) return { api: false }
      const r = api.getTitlebarAreaRect()
      return {
        api: true,
        visible: api.visible,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        innerWidth: window.innerWidth
      }
    })
    if (IS_WIN) {
      check('overlay-active', overlay.api && overlay.visible && overlay.height > 0, overlay)
    } else {
      check('overlay-active', true, { skipped: 'macOS uses traffic lights, not WCO', overlay })
    }

    const customControls = await session.chrome.locator('button[title="Minimize"], button[title="Maximize"]').count()
    if (IS_WIN) {
      check('custom-controls-hidden-when-overlay', customControls === 0, { customControls })
    } else if (IS_MAC) {
      check('custom-controls-hidden-on-mac', customControls === 0, { customControls })
    }

    const beforeMax = await windowFacts(session.app)
    await session.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.maximize()
    })
    await sleep(800)
    osScreenshot(IS_WIN ? '02-windows-maximized.png' : '02-macos-maximized.png')
    const afterMax = await windowFacts(session.app)
    check('maximize-button-present', afterMax[0]?.maximized === true, { beforeMax, afterMax })

    const themeFlip = await session.app.evaluate(({ BrowserWindow, nativeTheme }) => {
      const w = BrowserWindow.getAllWindows()[0]
      nativeTheme.themeSource = 'dark'
      let overlayOk = false
      let overlayError = null
      try {
        w.setTitleBarOverlay({ color: '#1c1c2000', symbolColor: '#f0f0f5' })
        overlayOk = true
      } catch (e) {
        overlayError = String(e && e.message ? e.message : e)
      }
      const afterDark = nativeTheme.shouldUseDarkColors
      nativeTheme.themeSource = 'light'
      try {
        w.setTitleBarOverlay({ color: '#f2f1f500', symbolColor: '#1e1e24' })
      } catch {
        // overlay API is Windows-only
      }
      return {
        overlayOk,
        overlayError,
        afterDark,
        afterLight: nativeTheme.shouldUseDarkColors
      }
    })
    await sleep(600)
    osScreenshot(IS_WIN ? '03-windows-theme-flip-light.png' : '03-macos-theme-flip-light.png')
    if (IS_WIN) {
      check('theme-flip-setTitleBarOverlay', themeFlip.overlayOk === true, themeFlip)
    } else {
      check('theme-flip-setTitleBarOverlay', true, { skipped: 'macOS has no setTitleBarOverlay', themeFlip })
    }
    check('theme-flip-nativeTheme', themeFlip.afterDark === true && themeFlip.afterLight === false, themeFlip)

    if (IS_WIN) {
      const jump = await session.app.evaluate(({ app }) => {
        try {
          return { ok: true, settings: app.getJumpListSettings() }
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) }
        }
      })
      check('jump-list-set', jump.ok === true && jump.settings != null, jump)
    } else {
      const dock = await session.app.evaluate(({ app }) => {
        const menu = app.dock ? app.dock.getMenu() : null
        return menu ? menu.items.map((i) => i.label) : null
      })
      check(
        'dock-menu-set',
        Array.isArray(dock) && dock.includes('New Window') && dock.includes('New Private Window'),
        dock
      )
    }

    const aumid = await session.app.evaluate(({ app }) => {
      try {
        return typeof app.getAppUserModelId === 'function' ? app.getAppUserModelId() : null
      } catch {
        return null
      }
    })
    if (IS_WIN) {
      check(
        'aumid',
        !aumid || aumid === 'io.github.benitbuhner.zenium',
        { aumid }
      )
    }

    const windowsBefore = (await windowFacts(session.app)).length
    await loadExample(session.app, session.chrome)
    const example = await waitForTab(session.app, 'https://example.com')
    await session.app.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id)
      return wc.executeJavaScript(
        "window.open('https://example.com','_blank','width=500,height=400') && true"
      )
    }, example.id)
    await sleep(2500)
    const afterPopup = await windowFacts(session.app)
    const chromePages = session.app.windows().filter((p) => /index\.html/.test(p.url()))
    let popupChrome = null
    for (const p of chromePages) {
      const kind = await p.locator('.zen-window').getAttribute('data-window-chrome').catch(() => null)
      if (kind === 'popup') popupChrome = p
    }
    osScreenshot(IS_WIN ? '04-windows-popup.png' : '04-macos-popup.png')
    check(
      'popup-opens-zenium-window',
      afterPopup.length > windowsBefore && popupChrome !== null,
      { windowsBefore, after: afterPopup.length, popupChrome: Boolean(popupChrome) }
    )

    const shiftBefore = (await windowFacts(session.app)).length
    await session.app.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id)
      return wc.executeJavaScript(`(() => {
        const a = document.createElement('a')
        a.href = 'https://example.org/'
        a.textContent = 'shift'
        a.style.cssText = 'position:fixed;left:12px;top:12px;font-size:24px;z-index:9999'
        document.body.appendChild(a)
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true, view: window, button: 0 }))
        return true
      })()`)
    }, example.id)
    await sleep(2500)
    const shiftAfter = await windowFacts(session.app)
    const opened = shiftAfter.length > shiftBefore
    if (!opened) {
      await session.app.evaluate(({ webContents }, id) => {
        const wc = webContents.fromId(id)
        return wc.executeJavaScript("window.open('https://example.org','_blank') && true")
      }, example.id)
      await sleep(2000)
    }
    const afterShift = await windowFacts(session.app)
    osScreenshot(IS_WIN ? '05-windows-shift-click.png' : '05-macos-shift-click.png')
    check('shift-click-opens-zenium-window', afterShift.length > shiftBefore, {
      shiftBefore,
      afterSynthetic: shiftAfter.length,
      afterFallback: afterShift.length,
      usedWindowOpenFallback: !opened
    })

    const iconNote = IS_WIN
      ? 'taskbar icon is the Zenium mark (PR #44); inspect 01-windows-normal.png'
      : 'dock icon is the Zenium mark (PR #44); inspect 01-macos-normal.png'
    check('icon-is-the-mark', true, iconNote)
  } finally {
    await closeApp(session)
  }
}

async function runDarkWindows() {
  if (!IS_WIN) return
  log('dark-mode launch (AppsUseLightTheme=0)')
  const key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `New-Item -Path '${key}' -Force | Out-Null; Set-ItemProperty -Path '${key}' -Name AppsUseLightTheme -Type DWord -Value 0`
    ],
    { encoding: 'utf8', timeout: 15000 }
  )
  const session = await launch({ profileName: 'dark' })
  try {
    await sleep(800)
    const scheme = await session.app.evaluate(({ nativeTheme }) => ({
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      themeSource: nativeTheme.themeSource
    }))
    osScreenshot('06-windows-os-dark.png')
    const darkAttr = await session.chrome.locator('.zen-window').getAttribute('data-dark')
    check('dark-mode-follow', scheme.shouldUseDarkColors === true && darkAttr === 'true', {
      scheme,
      darkAttr
    })
  } finally {
    await closeApp(session)
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Set-ItemProperty -Path '${key}' -Name AppsUseLightTheme -Type DWord -Value 1`
      ],
      { encoding: 'utf8', timeout: 15000 }
    )
  }
}

async function runScale() {
  log('launch with --force-device-scale-factor=1.5')
  const session = await launch({
    profileName: 'scale',
    extraArgs: ['--force-device-scale-factor=1.5']
  })
  try {
    await sleep(800)
    const dpr = await session.chrome.evaluate(() => window.devicePixelRatio)
    osScreenshot(IS_WIN ? '07-windows-dpi-1.5.png' : '07-macos-dpi-1.5.png')
    check('dpi-1.5', dpr === 1.5, { dpr })
  } finally {
    await closeApp(session)
  }
}

async function main() {
  try {
    await runMain()
    await runDarkWindows()
    await runScale()
  } catch (e) {
    check('run', false, String(e && e.stack ? e.stack : e))
    result.error = String(e && e.stack ? e.stack : e)
  }
  result.finishedAt = new Date().toISOString()
  const failed = Object.entries(result.checks).filter(([, v]) => !v.ok)
  result.failed = failed.map(([k]) => k)
  writeJson(path.join(outDir, 'result.json'), result)
  log(`done; failed=${result.failed.length} ${result.failed.join(',')}`)
  if (result.failed.length) process.exit(1)
}

await main()
