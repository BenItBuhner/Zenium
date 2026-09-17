// Default-browser / URL-file handoff / external-protocol smoke for the packaged Zenium app.
//   node os-smoke.mjs --exe <path> --out <dir> --label <name> [--extra-args --no-sandbox]
// Windows screenshots use win-screenshot.ps1; macOS uses screencapture -x; Linux uses Playwright.

import { _electron as electron } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

const opts = parseArgs(process.argv.slice(2))
if (!opts.exe || !opts.out || !opts.label) {
  console.error('usage: node os-smoke.mjs --exe <exe> --out <dir> --label <name>')
  process.exit(2)
}

const outDir = path.resolve(opts.out, opts.label)
fs.mkdirSync(outDir, { recursive: true })
const EXTRA_ARGS =
  typeof opts['extra-args'] === 'string' ? opts['extra-args'].split(' ').filter(Boolean) : []
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zenium-os-'))
fs.mkdirSync(path.join(profile, 'zen'), { recursive: true })
fs.writeFileSync(
  path.join(profile, 'zen', 'state.json'),
  JSON.stringify({
    version: 2,
    settings: {
      onboardingDone: true,
      updates: { autoCheck: false, autoDownload: false, channel: 'stable' }
    }
  })
)

const htmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenium-os-html-'))
const testHtml = path.join(htmlDir, 'test.html')
const testPdf = path.join(htmlDir, 'test.pdf')
fs.writeFileSync(
  testHtml,
  `<!doctype html><title>OS handoff</title><p>handoff page</p>
   <a id="mail" href="mailto:os-smoke@example.org">mailto</a>
   <a id="custom" href="zenium-test://x">custom</a>`
)
fs.writeFileSync(testPdf, '%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

const result = {
  label: opts.label,
  exe: opts.exe,
  platform: process.platform,
  startedAt: new Date().toISOString(),
  checks: {},
  screenshots: [],
  console: [],
  pageErrors: [],
  stderr: []
}
let shotIndex = 0
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  fs.appendFileSync(path.join(outDir, 'os-smoke.log'), line + '\n')
}

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

function startPageServer() {
  const html = fs.readFileSync(testHtml, 'utf8')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}/` })
    })
  })
}

async function findDialog() {
  for (const page of appWindows()) {
    const loc = page.locator('.zen-dialog')
    if ((await loc.count()) > 0) return { page, loc }
  }
  return null
}

async function waitForDialog(timeoutMs) {
  return pollUntil(() => findDialog(), timeoutMs)
}

function appWindows() {
  return currentApp ? currentApp.windows() : []
}

let currentApp = null

function screenshotOs(name) {
  shotIndex += 1
  const file = path.join(outDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`)
  try {
    if (IS_WIN) {
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(here, 'win-screenshot.ps1'),
          '-Path',
          file
        ],
        { timeout: 20000, windowsHide: true }
      )
    } else if (IS_MAC) {
      spawnSync('screencapture', ['-x', file], { timeout: 15000 })
    }
  } catch (e) {
    log(`os screenshot ${name}: ${e.message}`)
  }
  result.screenshots.push({ name, file: path.basename(file), ok: fs.existsSync(file) })
  return file
}

function spawnSecond(args) {
  const child = spawn(opts.exe, [`--user-data-dir=${profile}`, ...EXTRA_ARGS, ...args], {
    stdio: 'ignore',
    detached: false
  })
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ pid: child.pid, code: null, timedOut: true }), 15000)
    child.on('exit', (code) => {
      clearTimeout(t)
      resolve({ pid: child.pid, code, timedOut: false })
    })
  })
}

function readPermissions() {
  try {
    return JSON.parse(fs.readFileSync(path.join(profile, 'zen', 'permissions.json'), 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  const pageServer = await startPageServer()
  log(`page server ${pageServer.url}`)

  const app = await electron.launch({
    executablePath: opts.exe,
    args: [`--user-data-dir=${profile}`, ...EXTRA_ARGS],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    colorScheme: null,
    timeout: 120000
  })
  currentApp = app
  const proc = app.process()
  proc.stderr?.on('data', (d) => result.stderr.push(d.toString()))
  app.on('console', (msg) => result.console.push({ type: msg.type(), text: msg.text().slice(0, 500) }))
  await app.evaluate(() => {
    process.on('uncaughtException', (err) => {
      globalThis.__osSmokeUncaught = String((err && err.stack) || err)
    })
    return true
  })

  const chrome = await app.firstWindow()
  chrome.on('pageerror', (e) => result.pageErrors.push(String(e)))
  app.on('window', (page) => page.on('pageerror', (e) => result.pageErrors.push(String(e))))
  await chrome.waitForSelector('.zen-window', { timeout: 90000, state: 'attached' })
  await sleep(1500)
  await chrome.screenshot({ path: path.join(outDir, '01-boot.png') }).catch(() => undefined)
  screenshotOs('boot')

  const strip = await chrome.locator('.zen-default-browser-strip').count()
  result.checks.stripVisible = strip > 0
  if (strip > 0) {
    await chrome.screenshot({ path: path.join(outDir, '02-strip.png') }).catch(() => undefined)
    screenshotOs('strip')
  }

  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.webContents.send('zen:event', 'overlay.open', {
      kind: 'settings',
      section: 'default-browser'
    })
  })
  await chrome.locator('.zen-settings').first().waitFor({ state: 'visible', timeout: 10000 })
  await sleep(600)
  await chrome.screenshot({ path: path.join(outDir, '03-settings-not-default.png') }).catch(() => undefined)
  screenshotOs('settings-not-default')
  const settingsText = await chrome.locator('.zen-settings').innerText()
  result.checks.settingsNotDefault = /Zenium is not your default browser|may not be your default/.test(
    settingsText
  )
  result.checks.settingsMakeDefault = /Make default/.test(settingsText)
  result.checks.settingsWindowsNote =
    process.platform !== 'win32' || /Settings → Apps → Default apps/.test(settingsText)

  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'dark'
  })
  await sleep(700)
  await chrome.screenshot({ path: path.join(outDir, '04-settings-dark.png') }).catch(() => undefined)
  screenshotOs('settings-dark')
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'light'
  })
  await chrome.keyboard.press('Escape')
  await sleep(400)

  const beforeDefault = await app.evaluate(({ app: a }) => a.isDefaultProtocolClient('http'))
  result.checks.isDefaultBeforeMakeDefault = beforeDefault

  const secondUrl = await spawnSecond(['https://example.org/'])
  result.checks.secondInstanceExit = secondUrl
  const tabAfterUrl = await pollUntil(async () => {
    const tabs = await app.evaluate(({ webContents, BrowserWindow }) => {
      const chromeIds = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id))
      return webContents.getAllWebContents().map((wc) => ({
        id: wc.id,
        chrome: chromeIds.has(wc.id),
        url: (() => {
          try {
            return wc.getURL()
          } catch {
            return ''
          }
        })()
      }))
    })
    return tabs.find((t) => !t.chrome && t.url.includes('example.org'))
  }, 20000)
  result.checks.secondInstanceTab = tabAfterUrl ? tabAfterUrl.url : null

  const secondFile = await spawnSecond([testHtml])
  result.checks.fileLaunchExit = secondFile
  const tabAfterFile = await pollUntil(async () => {
    const tabs = await app.evaluate(({ webContents, BrowserWindow }) => {
      const chromeIds = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id))
      return webContents.getAllWebContents().map((wc) => ({
        chrome: chromeIds.has(wc.id),
        url: (() => {
          try {
            return wc.getURL()
          } catch {
            return ''
          }
        })()
      }))
    })
    return tabs.find((t) => !t.chrome && /test\.html/.test(t.url))
  }, 20000)
  result.checks.fileLaunchTab = tabAfterFile ? tabAfterFile.url : null

  const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const secondNew = await spawnSecond(['--new-window', 'https://example.com/'])
  result.checks.newWindowExit = secondNew
  const windowsAfter = await pollUntil(async () => {
    const n = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    return n > windowsBefore ? n : null
  }, 15000)
  result.checks.newWindowOpened = Boolean(windowsAfter)

  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.focus()
  })

  const pageWc = await pollUntil(async () => {
    await app.evaluate(async ({ webContents, BrowserWindow }, url) => {
      const chromeIds = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id))
      const pages = webContents.getAllWebContents().filter((wc) => !chromeIds.has(wc.id) && !wc.isDestroyed())
      const target = pages[0]
      if (!target) return
      await target.loadURL(url)
    }, pageServer.url)
    const tabs = await app.evaluate(({ webContents, BrowserWindow }) => {
      const chromeIds = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id))
      return webContents.getAllWebContents().map((wc) => ({
        id: wc.id,
        chrome: chromeIds.has(wc.id),
        url: (() => {
          try {
            return wc.getURL()
          } catch {
            return ''
          }
        })()
      }))
    })
    return tabs.find((t) => !t.chrome && t.url.startsWith('http://127.0.0.1'))
  }, 20000)
  result.checks.protocolPage = pageWc ? pageWc.url : null

  if (pageWc) {
    await app.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id)
      return wc.executeJavaScript('document.getElementById("mail").click()')
    }, pageWc.id)
    const dialog = await waitForDialog(10000)
    if (!dialog) {
      result.checks.mailtoDialog = null
    } else {
      result.checks.mailtoDialog = (await dialog.loc.innerText()).slice(0, 400)
      await dialog.page.screenshot({ path: path.join(outDir, '05-dialog-mailto.png') }).catch(() => undefined)
      screenshotOs('dialog-mailto')
      const check = dialog.page.locator('.zen-protocol-check')
      if ((await check.count()) > 0) {
        await check.check()
        await sleep(200)
        await dialog.page.screenshot({ path: path.join(outDir, '06-dialog-always-allow.png') }).catch(() => undefined)
        screenshotOs('dialog-always-allow')
      }
      await dialog.page.locator('.zen-dialog').getByRole('button', { name: 'Open' }).click()
      await sleep(800)
      result.checks.permissionsAfterAllow = readPermissions()
    }
  }

  const customWc = await app.evaluate(({ webContents, BrowserWindow }) => {
    const chromeIds = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id))
    const pages = webContents
      .getAllWebContents()
      .filter((wc) => !chromeIds.has(wc.id) && !wc.isDestroyed())
    return pages[0] ? pages[0].id : null
  })
  if (customWc) {
    await app.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id)
      return wc.executeJavaScript('document.getElementById("custom").click()')
    }, customWc)
    const dialog = await waitForDialog(8000)
    result.checks.customSchemeDialog = Boolean(dialog)
    if (dialog) {
      await dialog.page.screenshot({ path: path.join(outDir, '07-dialog-custom.png') }).catch(() => undefined)
      screenshotOs('dialog-custom')
      await dialog.page.locator('.zen-dialog').getByRole('button', { name: 'Cancel' }).click()
      await sleep(400)
    }
  }

  const permsBeforePrivate = JSON.stringify(readPermissions())
  await spawnSecond(['--private-window', pageServer.url])
  await sleep(2500)
  const privateWc = await pollUntil(async () => {
    const tabs = await app.evaluate(({ webContents, BrowserWindow }) => {
      const chromeIds = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id))
      return webContents.getAllWebContents().map((wc) => ({
        id: wc.id,
        chrome: chromeIds.has(wc.id),
        url: (() => {
          try {
            return wc.getURL()
          } catch {
            return ''
          }
        })()
      }))
    })
    return tabs.find((t) => !t.chrome && t.url.startsWith('http://127.0.0.1'))
  }, 15000)
  if (privateWc) {
    await app.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id)
      return wc.executeJavaScript(
        'const a=document.getElementById("mail"); if(a) a.click(); else { location.href="mailto:priv@example.org" }'
      )
    }, privateWc.id)
    const dialog = await waitForDialog(8000)
    result.checks.privateDialog = Boolean(dialog)
    if (dialog) {
      await dialog.page.screenshot({ path: path.join(outDir, '08-dialog-private.png') }).catch(() => undefined)
      screenshotOs('dialog-private')
      result.checks.privateHasRemember = (await dialog.page.locator('.zen-protocol-check').count()) > 0
      await dialog.page.locator('.zen-dialog').getByRole('button', { name: 'Open' }).click()
      await sleep(500)
    }
  }
  result.checks.privateDidNotPersist = JSON.stringify(readPermissions()) === permsBeforePrivate

  if (strip > 0) {
    await chrome.keyboard.press('Escape')
    const notNow = chrome.locator('.zen-default-browser-strip button', { hasText: 'Not now' })
    if ((await notNow.count()) > 0) await notNow.click()
    await sleep(400)
    result.checks.stripDismissed = (await chrome.locator('.zen-default-browser-strip').count()) === 0
  }

  const makeDefault = await chrome
    .evaluate(() => window.zen.invoke('defaultBrowser.makeDefault'))
    .catch((e) => String(e))
  result.checks.makeDefaultOutcome = makeDefault
  await sleep(1500)
  const afterDefault = await app.evaluate(({ app: a }) => a.isDefaultProtocolClient('http'))
  result.checks.isDefaultAfterMakeDefault = afterDefault
  screenshotOs('after-make-default')

  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.webContents.send('zen:event', 'overlay.open', {
      kind: 'settings',
      section: 'default-browser'
    })
  })
  await sleep(700)
  await chrome.screenshot({ path: path.join(outDir, '09-settings-after.png') }).catch(() => undefined)
  screenshotOs('settings-after')

  result.uncaught = await app.evaluate(() => globalThis.__osSmokeUncaught || null)
  result.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2))
  log(JSON.stringify(result.checks, null, 2))

  pageServer.server.close()
  try {
    await app.close()
  } catch (e) {
    log(`app.close: ${e.message}`)
  }
}

main().catch((e) => {
  result.error = String(e && e.stack ? e.stack : e)
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2))
  console.error(e)
  process.exit(1)
})
