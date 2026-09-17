#!/usr/bin/env node
// Runs on the workflow runner once the emulator has booted (android-render-fidelity.yml): loads
// the same pages in the Zen debug build and in the emulator's Chrome and records what each page
// saw – user-agent string, user-agent client hints, viewport, fonts, the computed style of
// Google's "Sign in" control – together with a viewport screenshot, a full-screen capture and a
// crop of the Sign in control, under artifacts/render-fidelity/.
//
// Both browsers are driven over the DevTools protocol (debug builds turn on WebView remote
// debugging), so every probe runs the exact same script in both. It also answers on port 8787 as a
// header echo the emulator reaches at http://10.0.2.2:8787/headers, to see the request headers the
// WebView adds (X-Requested-With) next to Chrome's.
//
// Nothing here is a test: it only fails when a browser cannot be reached at all.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const OUT = process.env.RENDER_OUT || 'artifacts/render-fidelity'
const APP = 'app.zen.chromium.debug'
const CHROME = 'com.android.chrome'
const ECHO_PORT = 8787
const LOAD_TIMEOUT_MS = 60_000
const SETTLE_MS = 4_000

const PAGES = [
  { id: 'google-home', url: 'https://www.google.com/?hl=en' },
  { id: 'google-search', url: 'https://www.google.com/search?q=zenium+browser&hl=en' },
  { id: 'google-signin', url: 'https://accounts.google.com/ServiceLogin?hl=en&continue=https://www.google.com/' },
  { id: 'youtube', url: 'https://m.youtube.com/' },
  { id: 'wikipedia', url: 'https://en.m.wikipedia.org/wiki/Web_browser' },
  { id: 'github', url: 'https://github.com/BenItBuhner/Zenium' },
  { id: 'reddit', url: 'https://www.reddit.com/r/androiddev/' },
  { id: 'amazon', url: 'https://www.amazon.com/' },
  { id: 'cern-no-viewport', url: 'http://info.cern.ch/hypertext/WWW/TheProject.html' },
  { id: 'headers-http', url: `http://10.0.2.2:${ECHO_PORT}/headers` },
  { id: 'headers-https', url: 'https://httpbin.org/headers' }
]

/** Everything the page can tell us about how it was served and laid out. Runs in the page. */
const PROBE = `(async () => {
  const props = ['font-family','font-size','font-weight','line-height','letter-spacing','color',
    'background-color','border','border-radius','padding','height','width','box-shadow','display',
    'text-transform','-webkit-font-smoothing','text-rendering','opacity','outline','box-sizing'];
  const style = (el) => { if (!el) return null; const cs = getComputedStyle(el); const o = {};
    for (const p of props) o[p] = cs.getPropertyValue(p); return o };
  const rect = (el) => el ? el.getBoundingClientRect().toJSON() : null;
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const signIn = [...document.querySelectorAll('a,button,[role=button]')]
    .find((e) => /^sign in$/i.test(text(e)) || /^sign in$/i.test(e.getAttribute('aria-label') || ''));
  let hints = null;
  try {
    hints = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(
      ['architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList','wow64','formFactors']) : 'no userAgentData';
  } catch (e) { hints = 'error: ' + e; }
  try { await document.fonts.ready; } catch {}
  const vv = window.visualViewport;
  return JSON.stringify({
    url: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    userAgentData: navigator.userAgentData ? navigator.userAgentData.toJSON() : null,
    highEntropy: hints,
    devicePixelRatio: devicePixelRatio,
    innerSize: [innerWidth, innerHeight],
    clientWidth: document.documentElement.clientWidth,
    visualViewport: vv ? { scale: vv.scale, width: vv.width, height: vv.height } : null,
    viewportMeta: document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? null,
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    colorSchemeMeta: document.querySelector('meta[name=color-scheme]')?.getAttribute('content') ?? null,
    htmlFontSize: getComputedStyle(document.documentElement).fontSize,
    bodyFontSize: document.body ? getComputedStyle(document.body).fontSize : null,
    bodyFontFamily: document.body ? getComputedStyle(document.body).fontFamily : null,
    fonts: [...document.fonts].map((f) => f.family + ' ' + f.weight + ' ' + f.style + ' ' + f.status),
    signIn: signIn ? {
      tag: signIn.tagName, html: signIn.outerHTML.slice(0, 800), rect: rect(signIn), style: style(signIn),
      parentStyle: style(signIn.parentElement), childStyle: style(signIn.firstElementChild)
    } : null,
    htmlLength: document.documentElement.outerHTML.length,
    bodyText: document.body ? document.body.innerText.slice(0, 1200) : null
  });
})()`

// --- plumbing --------------------------------------------------------------------------------

const logFile = path.join(OUT, 'render-fidelity.log')
const log = (message) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${message}`
  console.log(line)
  appendFileSync(logFile, line + '\n')
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const adb = (...args) =>
  execFileSync('adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 })
const adbBinary = (...args) =>
  execFileSync('adb', args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 })
const sh = (command) => adb('shell', command)
const tryShell = (command) => {
  try {
    return sh(command)
  } catch (e) {
    log(`shell failed (${command}): ${String(e.stderr || e.message).trim()}`)
    return ''
  }
}
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.events = []
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`))
        else p.resolve(m.result)
      } else if (m.method) this.events.push(m)
    }
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: socket closed`))
      this.pending.clear()
    }
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.onopen = () => resolve(new Cdp(ws))
      ws.onerror = () => reject(new Error(`cannot open ${url}`))
    })
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  takeEvents() {
    const events = this.events
    this.events = []
    return events
  }

  close() {
    this.ws.close()
  }
}

async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5_000) })
  return res.json()
}

/** Poll the DevTools endpoint until a page target `accept`s; returns the target. */
async function waitForTarget(port, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let seen = ''
  while (Date.now() < deadline) {
    try {
      const list = await targets(port)
      const hit = list.find((t) => t.type === 'page' && accept(t))
      if (hit) return hit
      const summary = list.map((t) => `${t.type} ${t.url}`).join(' | ')
      if (summary !== seen) {
        seen = summary
        log(`  targets: ${summary || '(none)'}`)
      }
    } catch {
      /* not forwarded yet */
    }
    await sleep(1_000)
  }
  throw new Error(`no matching DevTools target on port ${port}`)
}

/** Navigate and wait for the load event, then for fonts and a settle period. */
async function open(cdp, url) {
  cdp.takeEvents()
  const started = Date.now()
  await cdp.send('Page.navigate', { url })
  while (Date.now() - started < LOAD_TIMEOUT_MS) {
    if (cdp.takeEvents().some((e) => e.method === 'Page.loadEventFired')) break
    await sleep(250)
  }
  // Redirect chains fire several loads; make sure the current document is complete too.
  for (let i = 0; i < 40; i++) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
    if (result.value === 'complete') break
    await sleep(500)
  }
  await sleep(SETTLE_MS)
}

async function probe(cdp) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression: PROBE, awaitPromise: true, returnByValue: true },
    45_000
  )
  if (exceptionDetails) throw new Error(`probe threw: ${exceptionDetails.text} ${result?.description ?? ''}`)
  return JSON.parse(result.value)
}

async function capture(cdp, file, clip) {
  const params = { format: 'png' }
  if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
  const { data } = await cdp.send('Page.captureScreenshot', params, 60_000)
  writeFileSync(file, Buffer.from(data, 'base64'))
}

function screencap(file) {
  writeFileSync(file, adbBinary('exec-out', 'screencap', '-p'))
}

// --- the two browsers ------------------------------------------------------------------------

const ZEN = {
  id: 'zen',
  pkg: APP,
  port: 9222,
  launch(url) {
    sh(`am start -W -a android.intent.action.VIEW -d ${q(url)} ${APP}`)
  },
  socket() {
    const pid = tryShell(`pidof ${APP}`).trim().split(/\s+/)[0]
    return pid ? `localabstract:webview_devtools_remote_${pid}` : null
  },
  // The chrome WebView (appassets) and internal pages are not the tab we want.
  isTab: (t) => !t.url.startsWith('https://appassets.androidplatform.net') && !t.url.startsWith('zen:')
}

const CHROME_BROWSER = {
  id: 'chrome',
  pkg: CHROME,
  port: 9223,
  launch(url) {
    sh(`am start -W -n ${CHROME}/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d ${q(url)} --activity-clear-task`)
  },
  socket: () => 'localabstract:chrome_devtools_remote',
  isTab: () => true
}

/** Load every page in one browser, recording probes and screenshots with the given prefix. */
async function runBrowser(browser, prefix) {
  const first = PAGES[0]
  log(`[${browser.id}] launching with ${first.url}`)
  browser.launch(first.url)
  await sleep(6_000)
  let socket = null
  for (let i = 0; i < 30 && !socket; i++) {
    socket = browser.socket()
    if (!socket) await sleep(1_000)
  }
  if (!socket) throw new Error(`[${browser.id}] process never appeared`)
  adb('forward', `tcp:${browser.port}`, socket)
  log(`[${browser.id}] forwarded tcp:${browser.port} -> ${socket}`)
  const target = await waitForTarget(browser.port, (t) => browser.isTab(t) && /google\.com/.test(t.url), 90_000)
  log(`[${browser.id}] tab target: ${target.url} ${target.description ?? ''}`)
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const results = {}
  for (const page of PAGES) {
    const name = `${prefix}-${browser.id}-${page.id}`
    log(`[${browser.id}] ${page.id}: ${page.url}`)
    try {
      await open(cdp, page.url)
      const data = await probe(cdp)
      results[page.id] = data
      writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2))
      log(`  -> ${data.url} | ${data.title} | ${data.innerSize.join('x')} @${data.devicePixelRatio} | signIn=${data.signIn ? 'yes' : 'no'}`)
      screencap(path.join(OUT, `${name}-screen.png`))
      await capture(cdp, path.join(OUT, `${name}.png`))
      const r = data.signIn?.rect
      if (r && r.width > 0 && r.height > 0) {
        const pad = 16
        await capture(cdp, path.join(OUT, `${name}-signin.png`), {
          x: Math.max(0, r.x - pad),
          y: Math.max(0, r.y - pad),
          width: r.width + 2 * pad,
          height: r.height + 2 * pad
        })
      }
    } catch (e) {
      log(`  !! ${page.id} failed: ${e.message}`)
      results[page.id] = { error: e.message }
      try {
        screencap(path.join(OUT, `${name}-screen.png`))
      } catch {
        /* nothing on screen either */
      }
    }
  }

  // Same page again under a larger system font size and in the dark theme: does the page's text
  // and colour scheme follow the system the way Chrome's does?
  const home = PAGES[0]
  for (const [variant, apply, reset] of [
    ['fontscale', () => sh('settings put system font_scale 1.3'), () => sh('settings put system font_scale 1.0')],
    ['dark', () => sh('cmd uimode night yes'), () => sh('cmd uimode night no')]
  ]) {
    const name = `${prefix}-${browser.id}-${home.id}-${variant}`
    log(`[${browser.id}] ${home.id} with ${variant}`)
    try {
      apply()
      await sleep(4_000)
      await open(cdp, home.url)
      const data = await probe(cdp)
      results[`${home.id}-${variant}`] = data
      writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2))
      log(`  -> body ${data.bodyFontSize} html ${data.htmlFontSize} dark=${data.prefersDark} signIn=${data.signIn ? JSON.stringify(data.signIn.rect) : 'no'}`)
      screencap(path.join(OUT, `${name}-screen.png`))
      await capture(cdp, path.join(OUT, `${name}.png`))
    } catch (e) {
      log(`  !! ${variant} failed: ${e.message}`)
      results[`${home.id}-${variant}`] = { error: e.message }
    } finally {
      try {
        reset()
      } catch {
        /* keep going */
      }
      await sleep(3_000)
    }
  }

  cdp.close()
  adb('forward', '--remove', `tcp:${browser.port}`)
  return results
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true })
  const prefix = process.env.RENDER_PREFIX || 'run'

  const echo = http.createServer((req, res) => {
    const record = { time: new Date().toISOString(), method: req.method, url: req.url, headers: req.rawHeaders }
    appendFileSync(path.join(OUT, 'header-echo.jsonl'), JSON.stringify(record) + '\n')
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(JSON.stringify({ headers: req.rawHeaders }, null, 2))
  })
  await new Promise((resolve) => echo.listen(ECHO_PORT, '0.0.0.0', resolve))

  adb('wait-for-device')
  log(`device: ${sh('getprop ro.build.fingerprint').trim()}`)
  log(`webview: ${tryShell('dumpsys webviewupdate').split('\n').filter((l) => /Current WebView package|versionName/.test(l)).join(' / ').trim()}`)
  log(`chrome: ${tryShell(`dumpsys package ${CHROME}`).split('\n').find((l) => /versionName/.test(l))?.trim() ?? 'not installed'}`)

  // Wake, unlock, no error dialogs, no navigation gesture zone.
  tryShell('settings put global hide_error_dialogs 1')
  tryShell('settings put system screen_off_timeout 2147483647')
  tryShell('svc power stayon true')
  tryShell('input keyevent KEYCODE_WAKEUP')
  tryShell('wm dismiss-keyguard')
  tryShell('cmd overlay enable com.android.internal.systemui.navbar.threebutton')
  // Chrome without its first-run flow (the emulator image is userdebug, so the command line file
  // is honoured; set-debug-app makes sure of it) and with notifications already granted.
  tryShell(`echo '_ --disable-fre --no-first-run --no-default-browser-check --disable-features=ChromeWhatsNewUI' > /data/local/tmp/chrome-command-line`)
  tryShell('chmod 644 /data/local/tmp/chrome-command-line')
  tryShell(`am set-debug-app --persistent ${CHROME}`)
  tryShell(`pm grant ${CHROME} android.permission.POST_NOTIFICATIONS`)
  tryShell(`pm grant ${APP} android.permission.POST_NOTIFICATIONS`)
  // The Google apps the image starts on boot fight for the emulator's CPU; keep Chrome only.
  for (const pkg of [
    'com.google.android.youtube', 'com.google.android.apps.youtube.music', 'com.google.android.gm',
    'com.google.android.apps.messaging', 'com.google.android.apps.maps', 'com.google.android.videos',
    'com.google.android.apps.photos', 'com.google.android.googlequicksearchbox', 'com.google.android.calendar',
    'com.google.android.apps.docs', 'com.google.android.apps.wellbeing', 'com.google.android.projection.gearhead',
    'com.google.android.apps.tachyon', 'com.google.android.talk', 'com.google.android.music',
    'com.google.android.apps.podcasts', 'com.google.android.apps.nbu.files'
  ]) {
    try {
      sh(`pm disable-user --user 0 ${pkg}`)
    } catch {
      /* not on this image */
    }
  }
  tryShell('am kill-all')
  log('letting the system settle')
  await sleep(30_000)

  const apk = process.env.RENDER_APK
  if (!apk) throw new Error('RENDER_APK must point at the debug APK')
  adb('install', '-r', '-g', apk)
  // Past the onboarding overlay: a minimal profile with one space, no update check and the flag set.
  const state = {
    version: 2,
    activeSpaceId: 'space_main',
    spaces: [{ id: 'space_main', name: 'Main', icon: '', containerId: 'default', theme: null, tabIds: [], activeTabId: null, pinnedCollapsed: false }],
    folders: [],
    tabs: [],
    essentialTabIds: [],
    containers: [],
    splitGroups: [],
    settings: { onboardingDone: true, colorScheme: 'system', updates: { autoCheck: false, autoDownload: false, channel: 'stable' } },
    shortcutOverrides: {},
    bookmarks: [],
    windows: [{ id: 'window_main', bounds: null, maximized: false, activeSpaceId: 'space_main', selection: {}, compact: false }]
  }
  writeFileSync(path.join(OUT, 'seed-state.json'), JSON.stringify(state))
  adb('push', path.join(OUT, 'seed-state.json'), '/data/local/tmp/zen-seed-state.json')
  sh(`run-as ${APP} mkdir -p files/zen`)
  sh(`run-as ${APP} cp /data/local/tmp/zen-seed-state.json files/zen/state.json`)

  tryShell('logcat -c')
  const summary = {}
  try {
    summary.zen = await runBrowser(ZEN, prefix)
  } catch (e) {
    log(`!! zen run failed: ${e.message}`)
    summary.zen = { error: e.message }
    try {
      screencap(path.join(OUT, `${prefix}-zen-failure-screen.png`))
    } catch {
      /* no screen */
    }
  }
  tryShell(`am force-stop ${APP}`)
  await sleep(3_000)
  try {
    summary.chrome = await runBrowser(CHROME_BROWSER, prefix)
  } catch (e) {
    log(`!! chrome run failed: ${e.message}`)
    summary.chrome = { error: e.message }
    try {
      screencap(path.join(OUT, `${prefix}-chrome-failure-screen.png`))
    } catch {
      /* no screen */
    }
  }
  tryShell(`am force-stop ${CHROME}`)
  writeFileSync(path.join(OUT, `${prefix}-summary.json`), JSON.stringify(summary, null, 2))
  writeFileSync(path.join(OUT, 'logcat.txt'), tryShell('logcat -d -v time'))
  echo.close()
  if (summary.zen.error && summary.chrome.error) throw new Error('neither browser could be driven')
}

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`)
  process.exit(1)
})
