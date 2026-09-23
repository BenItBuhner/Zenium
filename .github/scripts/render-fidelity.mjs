#!/usr/bin/env node
// Runs on the workflow runner once the emulator has booted (android-render-fidelity.yml): loads
// the same pages in the debug build and in the emulator's Chrome and records what each page saw –
// user-agent string and client hints, the request headers actually sent, viewport, the fonts a
// heading and Google's "Sign in" control were drawn with – together with a viewport screenshot, a
// full-screen capture and a crop of the Sign in control, under artifacts/render-fidelity/.
//
// Both browsers are driven over the DevTools protocol (debug builds turn on WebView remote
// debugging), so every probe runs the exact same script in both. When RENDER_BEFORE_APK names a
// second build (the workflow fetches main's), that build goes first under the label `zen-before`,
// so one run shows the change side by side with Chrome. After the branch build's pages, the same
// tab is loaded again under a few user-agent identities (stock WebView, the previous release,
// Chrome's own), and Chrome is loaded carrying the WebView's request tells one at a time, to tell
// which signal a site keys on.
//
// It also answers on port 8787 as a header echo the emulator reaches at http://10.0.2.2:8787/, with
// a couple of controlled pages for font defaults and viewport handling.
//
// Nothing here is a test: it only fails when no browser could be reached at all.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const OUT = process.env.RENDER_OUT || 'artifacts/render-fidelity'
const APP = 'io.github.benitbuhner.zenium.debug'
const CHROME = 'com.android.chrome'
const ECHO_PORT = 8787
const LOAD_TIMEOUT_MS = 60_000
const SETTLE_MS = 4_000

const PAGES = [
  { id: 'google-home', url: 'https://www.google.com/?hl=en' },
  { id: 'google-search', url: 'https://www.google.com/search?q=zenium+browser&hl=en' },
  {
    id: 'google-signin',
    url: 'https://accounts.google.com/ServiceLogin?hl=en&continue=https://www.google.com/'
  },
  { id: 'youtube', url: 'https://m.youtube.com/' },
  { id: 'wikipedia', url: 'https://en.m.wikipedia.org/wiki/Web_browser' },
  { id: 'github', url: 'https://github.com/BenItBuhner/Zenium' },
  { id: 'amazon', url: 'https://www.amazon.com/' },
  { id: 'cern-no-viewport', url: 'http://info.cern.ch/hypertext/WWW/TheProject.html' },
  { id: 'local-quirks', url: `http://10.0.2.2:${ECHO_PORT}/quirks.html` },
  { id: 'local-desktop', url: `http://10.0.2.2:${ECHO_PORT}/desktop.html` },
  { id: 'local-fonts', url: `http://10.0.2.2:${ECHO_PORT}/fonts.html` },
  { id: 'headers-http', url: `http://10.0.2.2:${ECHO_PORT}/headers` },
  { id: 'headers-https', url: 'https://httpbin.org/headers' }
]

/** The pages the identity variants are checked against. */
const VARIANT_PAGES = PAGES.filter((p) => p.id === 'google-home' || p.id === 'headers-http')

// --- controlled pages served to the emulator --------------------------------------------------

/** Doctype-less markup in the style of the first web page: quirks mode, no viewport. */
const QUIRKS_HTML = `<HEADER>
<TITLE>Quirks mode, no viewport</TITLE>
<NEXTID N="55">
</HEADER>
<BODY>
<H1>World Wide Web</H1>The WorldWideWeb (W3) is a wide-area<A NAME=0 HREF="#">hypermedia</A> information retrieval initiative aiming to give universal access to a large universe of documents.<P>
Everything there is online about W3 is linked directly or indirectly to this document, including an <A NAME=24 HREF="#">executive summary</A> of the project, <A NAME=29 HREF="#">Mailing lists</A>, <A NAME=30 HREF="#">Policy</A>, November's <A NAME=34 HREF="#">W3 news</A>, <A NAME=41 HREF="#">Frequently Asked Questions</A>.<P>
<DL>
<DT><A NAME=44 HREF="#">What's out there?</A>
<DD> Pointers to the world's online information, <A NAME=45 HREF="#">subjects</A>, <A NAME=z54 HREF="#">W3 servers</A>, etc.
<DT><A NAME=46 HREF="#">Help</A>
<DD> on the browser you are using
<DT><A NAME=13 HREF="#">Software Products</A>
<DD> A list of W3 project components and their current state.
</DL>
</BODY>
`

/** Standards mode, no viewport meta: the desktop layout Chrome shows zoomed out with boosted text. */
const DESKTOP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Desktop layout, no viewport</title>
<style>body{margin:24px}table{border-collapse:collapse;width:1100px}td{border:1px solid #999;padding:6px 10px}</style></head>
<body>
<h1>Desktop layout without a viewport meta tag</h1>
<p>This paragraph has no font-family of its own, so it is set in the browser's default font. Chrome for Android lays the page out 980 CSS pixels wide, zooms out to fit and boosts the text so it stays legible.</p>
<table><tr><td>one</td><td>two</td><td>three</td><td>four</td><td>five</td><td>six</td><td>seven</td><td>eight</td></tr></table>
<p style="font-family:sans-serif">And this one asks for sans-serif explicitly.</p>
</body></html>
`

/**
 * Mobile page that measures the browser's typographic defaults: the default and generic font
 * families and how small text may get. The page writes its measurements into #measure so the
 * common probe picks them up.
 */
const FONTS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Font defaults</title>
<style>p{margin:8px 0}span{display:inline-block;white-space:nowrap}</style></head>
<body>
<p><span data-m="default">Default font: Hamburgefonstiv 0123456789</span></p>
<p><span data-m="serif" style="font-family:serif">serif: Hamburgefonstiv 0123456789</span></p>
<p><span data-m="sans" style="font-family:sans-serif">sans-serif: Hamburgefonstiv 0123456789</span></p>
<p><span data-m="mono" style="font-family:monospace">monospace: Hamburgefonstiv 0123456789</span></p>
<p><span data-m="cursive" style="font-family:cursive">cursive: Hamburgefonstiv 0123456789</span></p>
<p><span data-m="fantasy" style="font-family:fantasy">fantasy: Hamburgefonstiv 0123456789</span></p>
<p><span data-m="px5" style="font-size:5px">5px text</span> <span data-m="px6" style="font-size:6px">6px text</span> <span data-m="px7" style="font-size:7px">7px text</span> <span data-m="px8" style="font-size:8px">8px text</span> <span data-m="px9" style="font-size:9px">9px text</span> <span data-m="px12" style="font-size:12px">12px text</span></p>
<p style="font-size:10px"><span data-m="em05" style="font-size:.5em">.5em of 10px</span> <span data-m="em07" style="font-size:.7em">.7em of 10px</span> <span data-m="pct60" style="font-size:60%">60% of 10px</span></p>
<pre data-m="pre">pre: fixed-width Hamburgefonstiv 0123456789</pre>
<p id="measure" hidden></p>
<script>
addEventListener('load', () => {
  const rows = [...document.querySelectorAll('[data-m]')].map((el) => {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect()
    return { id: el.dataset.m, fontSize: cs.fontSize, fontFamily: cs.fontFamily, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 }
  })
  document.getElementById('measure').textContent = JSON.stringify(rows)
})
</script>
</body></html>
`

// --- the probe every page answers -------------------------------------------------------------

/**
 * Everything the page can tell us about how it was served and laid out. Runs in the page. Tags the
 * Sign in control and the first heading so the platform fonts they were drawn with can be looked up.
 */
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
  const heading = [...document.querySelectorAll('h1,h2,h3,[role=heading]')].find((e) => text(e).length > 3);
  for (const el of document.querySelectorAll('[data-zen-probe]')) el.removeAttribute('data-zen-probe');
  if (signIn) signIn.setAttribute('data-zen-probe', 'signin');
  if (heading) heading.setAttribute('data-zen-probe', 'heading');
  let hints = null;
  try {
    hints = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(
      ['architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList','wow64','formFactors']) : 'no userAgentData';
  } catch (e) { hints = 'error: ' + e; }
  try { await document.fonts.ready; } catch {}
  const vv = window.visualViewport;
  let measure = null;
  try { measure = JSON.parse(document.getElementById('measure')?.textContent || 'null'); } catch {}
  return JSON.stringify({
    url: location.href,
    title: document.title,
    compatMode: document.compatMode,
    userAgent: navigator.userAgent,
    userAgentData: navigator.userAgentData ? navigator.userAgentData.toJSON() : null,
    highEntropy: hints,
    devicePixelRatio: devicePixelRatio,
    innerSize: [innerWidth, innerHeight],
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    visualViewport: vv ? { scale: vv.scale, width: vv.width, height: vv.height } : null,
    viewportMeta: document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? null,
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    colorSchemeMeta: document.querySelector('meta[name=color-scheme]')?.getAttribute('content') ?? null,
    htmlFontSize: getComputedStyle(document.documentElement).fontSize,
    bodyFontSize: document.body ? getComputedStyle(document.body).fontSize : null,
    bodyFontFamily: document.body ? getComputedStyle(document.body).fontFamily : null,
    fonts: [...document.fonts].map((f) => f.family + ' ' + f.weight + ' ' + f.style + ' ' + f.status),
    heading: heading ? { text: text(heading).slice(0, 80), rect: rect(heading), style: style(heading) } : null,
    signIn: signIn ? {
      tag: signIn.tagName, html: signIn.outerHTML.slice(0, 800), rect: rect(signIn), style: style(signIn),
      parentStyle: style(signIn.parentElement), childStyle: style(signIn.firstElementChild)
    } : null,
    measure,
    htmlLength: document.documentElement.outerHTML.length,
    bodyText: document.body ? document.body.innerText.slice(0, 1200) : null
  });
})()`

// --- plumbing ---------------------------------------------------------------------------------

const logFile = path.join(OUT, 'render-fidelity.log')
const log = (message) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${message}`
  console.log(line)
  appendFileSync(logFile, line + '\n')
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const adb = (...args) =>
  execFileSync('adb', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 << 20
  })
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
const prop = (name) => tryShell(`getprop ${name}`).trim()
const hostCommand = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** Whether adb still sees the emulator; a run cannot continue without it. */
function deviceAlive() {
  return hostCommand('adb', ['get-state']).trim() === 'device'
}

class EmulatorGone extends Error {
  constructor() {
    super('the emulator is gone')
  }
}

/** Host watchdog: memory every few seconds, the kernel log the moment the emulator disappears. */
function startHostMonitor() {
  const file = path.join(OUT, 'host-monitor.txt')
  appendFileSync(file, `${hostCommand('nproc', []).trim()} cores\n${hostCommand('free', ['-m'])}\n`)
  let reported = false
  return setInterval(() => {
    const qemu = hostCommand('ps', [
      '-o',
      'pid=,rss=,pcpu=,comm=',
      '-C',
      'qemu-system-x86_64'
    ]).trim()
    appendFileSync(
      file,
      `${new Date().toISOString().slice(11, 19)} ${hostCommand('free', ['-m']).split('\n')[1]} | ${qemu || 'no qemu'}\n`
    )
    if (!qemu && !reported) {
      reported = true
      appendFileSync(
        file,
        `EMULATOR PROCESS GONE\n${hostCommand('sudo', ['dmesg']).split('\n').slice(-80).join('\n')}\n`
      )
    }
  }, 5_000)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.events = []
    this.listeners = new Set()
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`))
        else p.resolve(m.result)
      } else if (m.method) {
        this.events.push(m)
        for (const l of this.listeners) l(m)
      }
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

/**
 * A DevTools session on one tab. Keeps the request headers of the last document request
 * (`Network.requestWillBeSentExtraInfo` has the ones that actually went out, client hints and all).
 */
class Session {
  constructor(cdp) {
    this.cdp = cdp
    this.documentRequests = new Map()
    this.documentHeaders = new Map()
    cdp.listeners.add((m) => {
      if (m.method === 'Network.requestWillBeSent' && m.params.type === 'Document') {
        this.documentRequests.set(m.params.requestId, m.params.request.url)
      } else if (m.method === 'Network.requestWillBeSentExtraInfo') {
        this.documentHeaders.set(m.params.requestId, m.params.headers)
      }
    })
  }

  static async attach(target) {
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    return new Session(cdp)
  }

  /** Navigate and wait for the load event, then for the document to be complete and settle. */
  async open(url) {
    this.documentRequests.clear()
    this.documentHeaders.clear()
    this.cdp.takeEvents()
    const started = Date.now()
    await this.cdp.send('Page.navigate', { url })
    while (Date.now() - started < LOAD_TIMEOUT_MS) {
      if (this.cdp.takeEvents().some((e) => e.method === 'Page.loadEventFired')) break
      await sleep(250)
    }
    // Redirect chains fire several loads; make sure the current document is complete too.
    for (let i = 0; i < 40; i++) {
      const { result } = await this.cdp.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true
      })
      if (result.value === 'complete') break
      await sleep(500)
    }
    await sleep(SETTLE_MS)
  }

  /** Headers of the document requests of the current load, by URL. */
  requestHeaders() {
    const out = {}
    for (const [id, url] of this.documentRequests) {
      const headers = this.documentHeaders.get(id)
      if (headers) out[url] = headers
    }
    return out
  }

  async probe() {
    const { result, exceptionDetails } = await this.cdp.send(
      'Runtime.evaluate',
      { expression: PROBE, awaitPromise: true, returnByValue: true },
      45_000
    )
    if (exceptionDetails) {
      throw new Error(`probe threw: ${exceptionDetails.text} ${result?.description ?? ''}`)
    }
    const data = JSON.parse(result.value)
    data.requestHeaders = this.requestHeaders()
    data.platformFonts = {
      signin: await this.platformFonts('[data-zen-probe=signin]'),
      heading: await this.platformFonts('[data-zen-probe=heading]'),
      body: await this.platformFonts('body')
    }
    return data
  }

  /** The font families the element's glyphs were actually rasterised from. */
  async platformFonts(selector) {
    try {
      const { root } = await this.cdp.send('DOM.getDocument', { depth: 1 })
      const { nodeId } = await this.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
      if (!nodeId) return null
      const { fonts } = await this.cdp.send('CSS.getPlatformFontsForNode', { nodeId })
      return fonts.map(
        (f) => `${f.familyName}${f.isCustomFont ? ' (web font)' : ''} ×${f.glyphCount}`
      )
    } catch (e) {
      return `error: ${e.message}`
    }
  }

  async capture(file, clip) {
    const params = { format: 'png' }
    if (clip)
      params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
    const { data } = await this.cdp.send('Page.captureScreenshot', params, 60_000)
    writeFileSync(file, Buffer.from(data, 'base64'))
  }

  /** Pretend to be someone else: UA string plus (optionally) client hints metadata. */
  async identity(userAgent, userAgentMetadata) {
    const params = { userAgent }
    if (userAgentMetadata) params.userAgentMetadata = userAgentMetadata
    await this.cdp.send('Network.setUserAgentOverride', params)
  }

  /** Drop a request header on every request (through Fetch interception). */
  async stripHeader(name) {
    await this.cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }]
    })
    this.stripping = (m) => {
      if (m.method !== 'Fetch.requestPaused') return
      const headers = Object.entries(m.params.request.headers)
        .filter(([k]) => k.toLowerCase() !== name.toLowerCase())
        .map(([k, v]) => ({ name: k, value: v }))
      this.cdp
        .send('Fetch.continueRequest', { requestId: m.params.requestId, headers })
        .catch(() => {})
    }
    this.cdp.listeners.add(this.stripping)
  }

  async stopStripping() {
    if (!this.stripping) return
    this.cdp.listeners.delete(this.stripping)
    this.stripping = null
    await this.cdp.send('Fetch.disable')
  }

  close() {
    this.cdp.close()
  }
}

function screencap(file) {
  writeFileSync(file, adbBinary('exec-out', 'screencap', '-p'))
}

// --- the two browsers -------------------------------------------------------------------------

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
  isTab: (t) =>
    !t.url.startsWith('https://appassets.androidplatform.net') && !t.url.startsWith('zen:')
}

const CHROME_BROWSER = {
  id: 'chrome',
  pkg: CHROME,
  port: 9223,
  launch(url) {
    sh(
      `am start -W -n ${CHROME}/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d ${q(url)} --activity-clear-task`
    )
  },
  socket: () => 'localabstract:chrome_devtools_remote',
  isTab: () => true
}

/** (Re)start the browser on the first page and open a DevTools session on that tab. */
async function connect(browser) {
  const first = PAGES[0]
  tryShell(`am force-stop ${browser.pkg}`)
  await sleep(1_500)
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
  return reconnect(browser, (t) => /google\.com/.test(t.url))
}

/** (Re)attach to the browser's tab – after a configuration change Chrome rebuilds its activity. */
async function reconnect(browser, accept = () => true) {
  const target = await waitForTarget(browser.port, (t) => browser.isTab(t) && accept(t), 90_000)
  log(`[${browser.id}] tab target: ${target.url} ${target.description ?? ''}`)
  return Session.attach(target)
}

/** Load one page in an open session, recording the probe and screenshots under `name`. */
async function record(session, page, name) {
  await session.open(page.url)
  const data = await session.probe()
  writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2))
  const fonts = (data.fonts || []).filter((f) => f.endsWith('loaded')).length
  log(
    `  -> ${data.title || data.url} | ${data.innerSize.join('x')} @${data.devicePixelRatio} ` +
      `scale ${data.visualViewport?.scale?.toFixed(3)} | ${fonts} web fonts | ` +
      `heading ${JSON.stringify(data.platformFonts.heading)} | signIn ${JSON.stringify(data.platformFonts.signin)}`
  )
  screencap(path.join(OUT, `${name}-screen.png`))
  await session.capture(path.join(OUT, `${name}.png`))
  const r = data.signIn?.rect
  if (r && r.width > 0 && r.height > 0) {
    const pad = 16
    await session.capture(path.join(OUT, `${name}-signin.png`), {
      x: Math.max(0, r.x - pad),
      y: Math.max(0, r.y - pad),
      width: r.width + 2 * pad,
      height: r.height + 2 * pad
    })
  }
  return data
}

/** Every page, then the home page again with a larger system font and in the dark theme. */
async function runBrowser(browser, label) {
  let session = await connect(browser)
  const results = {}
  for (const page of PAGES) {
    const name = `${label}-${page.id}`
    log(`[${label}] ${page.id}: ${page.url}`)
    try {
      results[page.id] = await record(session, page, name)
    } catch (e) {
      if (!deviceAlive()) throw new EmulatorGone()
      log(`  !! ${page.id} failed: ${e.message}`)
      results[page.id] = { error: e.message }
      try {
        screencap(path.join(OUT, `${name}-screen.png`))
      } catch {
        /* nothing on screen either */
      }
    }
  }

  // Does the page's text and colour scheme follow the system the way Chrome's does? The browser
  // is restarted under the new setting so a process-wide configuration cache cannot hide it.
  const home = PAGES[0]
  for (const [variant, apply, reset] of [
    [
      'fontscale',
      () => sh('settings put system font_scale 1.3'),
      () => sh('settings put system font_scale 1.0')
    ],
    ['dark', () => sh('cmd uimode night yes'), () => sh('cmd uimode night no')]
  ]) {
    const name = `${label}-${home.id}-${variant}`
    log(`[${label}] ${home.id} with ${variant}`)
    try {
      apply()
      await sleep(4_000)
      session.close()
      session = await connect(browser)
      const data = await record(session, home, name)
      results[`${home.id}-${variant}`] = data
      log(`  -> body ${data.bodyFontSize} html ${data.htmlFontSize} dark=${data.prefersDark}`)
    } catch (e) {
      if (!deviceAlive()) throw new EmulatorGone()
      log(`  !! ${variant} failed: ${e.message}`)
      results[`${home.id}-${variant}`] = { error: e.message }
    } finally {
      try {
        reset()
      } catch {
        /* keep going */
      }
      await sleep(4_000)
    }
  }
  try {
    session.close()
    session = await connect(browser)
  } catch (e) {
    log(`  !! could not restart after the theme reset: ${e.message}`)
  }
  return { session, results }
}

/**
 * Chrome carrying one of the WebView's tells at a time: which of them makes Google serve the
 * lighter page? Each is injected into Chrome's own requests over DevTools.
 */
function chromeVariantsFor(chromeUserAgent) {
  return [
    { id: 'with-x-requested-with', headers: { 'X-Requested-With': APP } },
    // A user-agent override without metadata makes Chromium drop the Sec-CH-UA headers.
    { id: 'without-client-hints', userAgent: chromeUserAgent },
    { id: 'without-brotli', headers: { 'Accept-Encoding': 'gzip, deflate' } },
    { id: 'with-zero-network-hints', headers: { downlink: '0', rtt: '0' } },
    {
      id: 'without-client-hints-with-x-requested-with',
      userAgent: chromeUserAgent,
      headers: { 'X-Requested-With': APP }
    }
  ]
}

async function runChromeVariants(session, chromeHome, label) {
  const results = {}
  for (const variant of chromeVariantsFor(chromeHome.userAgent)) {
    log(`[${label}] ${variant.id}`)
    try {
      if (variant.userAgent) await session.identity(variant.userAgent)
      await session.cdp.send('Network.setExtraHTTPHeaders', { headers: variant.headers ?? {} })
      for (const page of VARIANT_PAGES) {
        const name = `${label}-${variant.id}-${page.id}`
        results[`${variant.id}/${page.id}`] = await record(session, page, name)
      }
    } catch (e) {
      if (!deviceAlive()) throw new EmulatorGone()
      log(`  !! ${variant.id} failed: ${e.message}`)
      results[variant.id] = { error: e.message }
    } finally {
      await session.identity('').catch(() => {})
      await session.cdp.send('Network.setExtraHTTPHeaders', { headers: {} }).catch(() => {})
    }
  }
  return results
}

/**
 * The same tab under other identities, to tell which signal a site keys on. `fixed` is what the
 * branch build sends; the stock WebView and the previous release are reconstructed from it.
 */
function variantsFor(fixed) {
  const ua = fixed.userAgent
  const chromeVersion = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? '0.0.0.0'
  const major = chromeVersion.split('.')[0]
  const build = prop('ro.build.id')
  const platformVersion = prop('ro.build.version.release') + '.0.0'
  const model = prop('ro.product.model')
  const platform = /\(([^)]*)\)/.exec(ua)?.[1] ?? 'Linux; Android'
  const withBuild = `${platform} Build/${build}`
  const engine = ua.slice(ua.indexOf(')') + 1).replace(/^\s+/, '')
  const brands = (list) => ({
    brands: list.map(([brand, v]) => ({ brand, version: v.split('.')[0] })),
    fullVersionList: list.map(([brand, v]) => ({ brand, version: v })),
    platform: 'Android',
    platformVersion,
    architecture: '',
    model,
    mobile: true
  })
  const webviewBrands = brands([
    ['Android WebView', chromeVersion],
    ['Chromium', chromeVersion],
    ['Not-A.Brand', '24.0.0.0']
  ])
  const chromeBrands = brands([
    ['Google Chrome', chromeVersion],
    ['Chromium', chromeVersion],
    ['Not-A.Brand', '24.0.0.0']
  ])
  // What the branch build sends where the WebView supports client hints metadata; reconstructed
  // where it does not, so the effect shows on this emulator regardless.
  const zenBrands = Array.isArray(fixed.highEntropy?.fullVersionList)
    ? brands(fixed.highEntropy.fullVersionList.map((b) => [b.brand, b.version]))
    : brands([
        ['Chromium', chromeVersion],
        ['Zenium', '0.2.0'],
        ['Not;A=Brand', '99.0.0.0']
      ])
  return [
    {
      id: 'stock-webview',
      userAgent: `Mozilla/5.0 (${withBuild}; wv) ${engine.replace('Chrome/', 'Version/4.0 Chrome/')}`,
      metadata: webviewBrands
    },
    { id: 'zen-0.2.0', userAgent: `Mozilla/5.0 (${withBuild}) ${engine}`, metadata: null },
    { id: 'zen-fixed-hints', userAgent: ua, metadata: zenBrands },
    { id: 'chrome-brand', userAgent: ua, metadata: chromeBrands },
    {
      id: 'chrome-exact',
      userAgent: ua.replace(/Chrome\/[\d.]+/, `Chrome/${major}.0.0.0`),
      metadata: chromeBrands
    },
    { id: 'no-x-requested-with', userAgent: ua, metadata: zenBrands, strip: 'X-Requested-With' }
  ]
}

async function runVariants(session, fixed, label) {
  const results = {}
  for (const variant of variantsFor(fixed)) {
    log(`[${label}] identity ${variant.id}: ${variant.userAgent}`)
    try {
      await session.identity(variant.userAgent, variant.metadata)
      if (variant.strip) await session.stripHeader(variant.strip)
      for (const page of VARIANT_PAGES) {
        const name = `${label}-${variant.id}-${page.id}`
        results[`${variant.id}/${page.id}`] = await record(session, page, name)
      }
    } catch (e) {
      if (!deviceAlive()) throw new EmulatorGone()
      log(`  !! ${variant.id} failed: ${e.message}`)
      results[variant.id] = { error: e.message }
    } finally {
      await session.stopStripping().catch(() => {})
    }
  }
  await session.identity('').catch(() => {})
  return results
}

// --- main -------------------------------------------------------------------------------------

function installZen(apk) {
  // A clean install every time: the two builds may not share a signer, and no cookies from one
  // session should shape what a site serves in the next.
  tryShell(`am force-stop ${APP}`)
  tryShell(`pm uninstall ${APP}`)
  adb('install', '-g', apk)
  // Past the onboarding overlay: a minimal profile with one space, no update check, flag set.
  const state = {
    version: 2,
    activeSpaceId: 'space_main',
    spaces: [
      {
        id: 'space_main',
        name: 'Main',
        icon: '',
        containerId: 'default',
        theme: null,
        tabIds: [],
        activeTabId: null,
        pinnedCollapsed: false
      }
    ],
    folders: [],
    tabs: [],
    essentialTabIds: [],
    containers: [],
    splitGroups: [],
    settings: {
      onboardingDone: true,
      colorScheme: 'system',
      updates: { autoCheck: false, autoDownload: false, channel: 'stable' }
    },
    shortcutOverrides: {},
    bookmarks: [],
    windows: [
      {
        id: 'window_main',
        bounds: null,
        maximized: false,
        activeSpaceId: 'space_main',
        selection: {},
        compact: false
      }
    ]
  }
  writeFileSync(path.join(OUT, 'seed-state.json'), JSON.stringify(state))
  adb('push', path.join(OUT, 'seed-state.json'), '/data/local/tmp/zen-seed-state.json')
  sh(`run-as ${APP} mkdir -p files/zen`)
  sh(`run-as ${APP} cp /data/local/tmp/zen-seed-state.json files/zen/state.json`)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const afterApk = process.env.RENDER_APK
  if (!afterApk) throw new Error('RENDER_APK must point at the debug APK')
  const beforeApk = process.env.RENDER_BEFORE_APK || ''

  const echo = http.createServer((req, res) => {
    const record = {
      time: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.rawHeaders
    }
    appendFileSync(path.join(OUT, 'header-echo.jsonl'), JSON.stringify(record) + '\n')
    const pages = {
      '/quirks.html': QUIRKS_HTML,
      '/desktop.html': DESKTOP_HTML,
      '/fonts.html': FONTS_HTML
    }
    if (pages[req.url]) {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(pages[req.url])
      return
    }
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(JSON.stringify({ headers: req.rawHeaders }, null, 2))
  })
  await new Promise((resolve) => echo.listen(ECHO_PORT, '0.0.0.0', resolve))

  adb('wait-for-device')
  log(`device: ${prop('ro.build.fingerprint')}`)
  log(
    `webview: ${tryShell('dumpsys webviewupdate')
      .split('\n')
      .filter((l) => /Current WebView package|versionName/.test(l))
      .join(' / ')
      .trim()}`
  )
  log(
    `chrome: ${
      tryShell(`dumpsys package ${CHROME}`)
        .split('\n')
        .find((l) => /versionName/.test(l))
        ?.trim() ?? 'not installed'
    }`
  )

  // Awake, unlocked, no error dialogs, three-button navigation (no gesture zone under the bar).
  tryShell('settings put global hide_error_dialogs 1')
  tryShell('settings put system screen_off_timeout 2147483647')
  tryShell('svc power stayon true')
  tryShell('input keyevent KEYCODE_WAKEUP')
  tryShell('wm dismiss-keyguard')
  // Exclusive within the navbar category: a plain enable is additive and leaves the gestural
  // overlay's insets in force under the buttons (android-gesture-demo.sh says how that looked).
  tryShell('cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton')
  // Chrome without its first-run flow (the emulator image is userdebug, so the command line file
  // is honoured; set-debug-app makes sure of it) and with notifications already granted.
  tryShell(
    `echo '_ --disable-fre --no-first-run --no-default-browser-check --disable-features=ChromeWhatsNewUI' > /data/local/tmp/chrome-command-line`
  )
  tryShell('chmod 644 /data/local/tmp/chrome-command-line')
  tryShell(`am set-debug-app --persistent ${CHROME}`)
  tryShell(`pm grant ${CHROME} android.permission.POST_NOTIFICATIONS`)
  // The Google apps the image starts on boot fight for the emulator's CPU; keep Chrome only.
  for (const pkg of [
    'com.google.android.youtube',
    'com.google.android.apps.youtube.music',
    'com.google.android.gm',
    'com.google.android.apps.messaging',
    'com.google.android.apps.maps',
    'com.google.android.videos',
    'com.google.android.apps.photos',
    'com.google.android.googlequicksearchbox',
    'com.google.android.calendar',
    'com.google.android.apps.docs',
    'com.google.android.apps.wellbeing',
    'com.google.android.projection.gearhead',
    'com.google.android.apps.tachyon',
    'com.google.android.talk',
    'com.google.android.music',
    'com.google.android.apps.podcasts',
    'com.google.android.apps.nbu.files'
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
  tryShell('logcat -c')
  const monitor = startHostMonitor()

  const summary = {}
  const finish = () => {
    clearInterval(monitor)
    writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
    writeFileSync(path.join(OUT, 'logcat.txt'), tryShell('logcat -d -v time'))
    echo.close()
  }
  const runZenium = async (apk, label) => {
    log(`[${label}] installing ${apk}`)
    installZen(apk)
    tryShell(`pm grant ${APP} android.permission.POST_NOTIFICATIONS`)
    try {
      return await runBrowser(ZEN, label)
    } catch (e) {
      if (e instanceof EmulatorGone) throw e
      log(`!! ${label} run failed: ${e.message}`)
      try {
        screencap(path.join(OUT, `${label}-failure-screen.png`))
      } catch {
        /* no screen */
      }
      return { session: null, results: { error: e.message } }
    }
  }

  // Chrome first (the reference and the tells experiment), then this build, then main's: the
  // emulator has frozen on heavy pages before, and a partial run should still hold the reference.
  try {
    try {
      const chrome = await runBrowser(CHROME_BROWSER, 'chrome')
      summary.chrome = chrome.results
      if (chrome.session && chrome.results['google-home'] && !chrome.results['google-home'].error) {
        summary['chrome-with-webview-tells'] = await runChromeVariants(
          chrome.session,
          chrome.results['google-home'],
          'chrome'
        )
      }
      chrome.session?.close()
    } catch (e) {
      if (e instanceof EmulatorGone) throw e
      log(`!! chrome run failed: ${e.message}`)
      summary.chrome = { error: e.message }
      try {
        screencap(path.join(OUT, 'chrome-failure-screen.png'))
      } catch {
        /* no screen */
      }
    }
    tryShell(`am force-stop ${CHROME}`)
    await sleep(3_000)

    const after = await runZenium(afterApk, 'zen-after')
    summary['zen-after'] = after.results
    if (after.session && after.results['google-home'] && !after.results['google-home'].error) {
      summary['zen-after-identities'] = await runVariants(
        after.session,
        after.results['google-home'],
        'zen-after'
      )
    }
    after.session?.close()
    tryShell(`am force-stop ${APP}`)
    await sleep(3_000)

    if (beforeApk) {
      const before = await runZenium(beforeApk, 'zen-before')
      summary['zen-before'] = before.results
      before.session?.close()
      tryShell(`am force-stop ${APP}`)
    }
  } catch (e) {
    // The emulator process died under us (see host-monitor.txt); keep what was recorded.
    summary.aborted = e.message
    finish()
    throw e
  }
  finish()
  if (summary['zen-after']?.error && summary.chrome?.error) {
    throw new Error('neither browser could be driven')
  }
}

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`)
  process.exit(1)
})
