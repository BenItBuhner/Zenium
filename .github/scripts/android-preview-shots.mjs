#!/usr/bin/env node
// Phone-size screenshots of the Android chrome from the preview host, with no emulator involved.
//
// Starts `npm run dev:android` (Vite on http://localhost:41734, the iframe stand-in host from
// src/android/preview.ts), opens it in the Electron already in node_modules – under an Xvfb it
// starts itself, so a desktop is not needed – at 412 x 915 CSS px with device emulation (mobile,
// device scale factor 2.6, touch and a coarse pointer), seeds a profile with a themed space, tabs,
// bookmarks, history and downloads, and captures every requested state in light and dark
// (`nativeTheme.themeSource`). States are the ones src/android/previewStates.ts understands.
//
//   node .github/scripts/android-preview-shots.mjs --out /tmp/shots
//   node .github/scripts/android-preview-shots.mjs --out /tmp/shots --prefix android-x-design- \
//     --states history-populated:overlay=history,find-matches:find=coffee --schemes dark
//
// Options
//   --out <dir>        where the PNGs go (required); files are <prefix><label>-<light|dark>.png
//   --states <list>    comma-separated `label:state` pairs; a state is `idle`, `page=settings`
//                      (the Settings tab; `&section=<id>` opens a section, `&search=<text>` types
//                      into Find in Settings, `&show=<text>` scrolls a row into view, and
//                      `&then=tap:<text>;back;overview;urlbar` takes steps on the open page –
//                      a tap on a row opens its sheet, a second one stacks another, `back`
//                      closes the top sheet, `overview` opens the tab overview, `urlbar` the pill
//                      for editing), `overlay=<kind>`
//                      (history, bookmarks, downloads, settings, addons, …; `&section=<id>` picks
//                      a Settings section, `&show=<text>` scrolls a row into view), `menu=app`
//                      (`&show=<text>` scrolls an item into view), `prompt=<permission>` (the
//                      permission prompt sheet), `private=new` or `private=<url>` (a private
//                      tab), `find=<text>`, `pull=<n>`,
//                      `zoom=<factor>` (the page zoom sheet), `error=<code>&url=<failed url>`
//                      (the zen://error page; see `previewSpec.ts`) or the messages and the load
//                      bar: `toast=<text>&action=<label>` (`&kind=error`), `banners=<n>`,
//                      `progress=<0…1>`, in any combination, or `voice=<script>` (voice search
//                      started on the active tab, the stand-in recogniser playing `listening`,
//                      `partial`, `no-match`, `denied`, `denied-permanently`, … into the listening
//                      sheet; the state is reached at the script's end, so the still shows it).
//                      A comma inside a state is written `%2C`. `&pressed=<selector>;<selector>`
//                      (the script's own key, not the page's) draws the elements those
//                      selectors match in their pressed state for the still – `:active` forced
//                      through DevTools – for a record of a press fill or its absence.
//                      The label defaults to the state with punctuation turned into dashes.
//                      Default: history:overlay=history,bookmarks:overlay=bookmarks,
//                               downloads:overlay=downloads,find:find=coffee
//   --schemes <list>   light,dark (default both)
//   --prefix <text>    file name prefix (default none)
//   --url <url>        reuse a running preview host instead of starting Vite
//   --display <name>   reuse that X display instead of starting an Xvfb (it must fit the window)
//   --seed <file>      profile to seed as JSON: an object of file name → contents (state.json,
//                      history.json, downloads.json, …); `none` keeps whatever the host has.
//                      Default: the built-in profile below.
//   --width, --height, --dpr   viewport in CSS px and device scale factor (412, 915, 2.6)
//   --settle <ms>      wait after a state is applied before capturing (default 1200)
//
// Needs Xvfb (or --display) and nothing beyond electron. Exit code 1 when any capture failed.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const PORT = 41734
const DEFAULT_STATES =
  'history:overlay=history,bookmarks:overlay=bookmarks,downloads:overlay=downloads,find:find=coffee'

function parseArgs(argv) {
  const opts = {
    out: '',
    states: DEFAULT_STATES,
    schemes: 'light,dark',
    prefix: '',
    url: '',
    seed: '',
    display: '',
    width: 412,
    height: 915,
    dpr: 2.6,
    settle: 1200
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`)
    const key = arg.slice(2)
    if (!(key in opts)) throw new Error(`unknown option ${arg}`)
    const value = argv[++i]
    if (value === undefined) throw new Error(`${arg} needs a value`)
    opts[key] = typeof opts[key] === 'number' ? Number(value) : value
  }
  if (!opts.out) throw new Error('--out <dir> is required')
  return opts
}

function parseStates(list) {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf(':')
      const state = (at === -1 ? entry : entry.slice(at + 1)).replaceAll('%2C', ',')
      const label =
        at === -1 ? state.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') : entry.slice(0, at)
      return { label, state }
    })
}

// --- the profile the host is seeded with -------------------------------------------------------

function defaultSeed() {
  const now = Date.now()
  const hour = 3_600_000
  const space = {
    id: 'space_main',
    name: 'Browse',
    icon: '🧭',
    containerId: 'default',
    theme: {
      type: 'gradient',
      colors: [
        { c: [96, 110, 235], x: 0.3, y: 0.35, isPrimary: true },
        { c: [214, 92, 160], x: 0.7, y: 0.65 }
      ],
      opacity: 0.55,
      texture: 0,
      algorithm: 'floating',
      monochrome: false,
      rotation: 40
    },
    tabIds: ['tab_example', 'tab_coffee', 'tab_www'],
    activeTabId: 'tab_example',
    pinnedCollapsed: false
  }
  const tab = (id, url, title) => ({
    id,
    spaceId: 'space_main',
    containerId: 'default',
    folderId: null,
    url,
    title,
    pinned: false,
    essential: false
  })
  const bookmark = (i, url, title) => ({
    id: `bm_${i}`,
    url,
    title,
    favicon: null,
    createdAt: now - i * 26 * hour
  })
  const visit = (i, url, title, visitCount) => ({
    url,
    title,
    visitCount,
    lastVisit: now - i * (i < 3 ? 0.4 : 5) * hour,
    favicon: null
  })
  const download = (i, filename, totalBytes, state, mimeType) => ({
    id: `dl_${i}`,
    url: `https://downloads.example.com/${filename}`,
    filename,
    savePath: `/Downloads/${filename}`,
    totalBytes,
    receivedBytes: state === 'completed' ? totalBytes : Math.round(totalBytes * 0.4),
    state,
    startedAt: now - i * 3 * hour,
    mimeType
  })
  return {
    'state.json': {
      version: 2,
      activeSpaceId: 'space_main',
      spaces: [space],
      folders: [],
      tabs: [
        tab('tab_example', 'https://example.com/', 'Example Domain'),
        tab('tab_coffee', 'https://en.wikipedia.org/wiki/Coffee', 'Coffee - Wikipedia'),
        tab('tab_www', 'https://info.cern.ch/hypertext/WWW/TheProject.html', 'World Wide Web')
      ],
      essentialTabIds: [],
      containers: [],
      splitGroups: [],
      settings: {
        onboardingDone: true,
        colorScheme: 'system',
        updates: { autoCheck: false, autoDownload: false, channel: 'stable' }
      },
      shortcutOverrides: {},
      bookmarks: [
        bookmark(1, 'https://en.wikipedia.org/wiki/Damping', 'Damping - Wikipedia'),
        bookmark(2, 'https://www.rfc-editor.org/rfc/rfc2324.html', 'RFC 2324: HTCPCP/1.0'),
        bookmark(3, 'https://news.ycombinator.com/', 'Hacker News'),
        bookmark(4, 'https://info.cern.ch/hypertext/WWW/TheProject.html', 'World Wide Web'),
        bookmark(
          5,
          'https://developer.mozilla.org/en-US/docs/Web/CSS/corner-shape',
          'corner-shape - CSS | MDN'
        )
      ],
      windows: [
        {
          id: 'window_main',
          bounds: null,
          maximized: false,
          activeSpaceId: 'space_main',
          selection: { space_main: 'tab_example' },
          compact: false
        }
      ]
    },
    'history.json': {
      version: 1,
      entries: [
        visit(1, 'https://en.wikipedia.org/wiki/Coffee', 'Coffee - Wikipedia', 3),
        visit(2, 'https://example.com/', 'Example Domain', 7),
        visit(3, 'https://news.ycombinator.com/', 'Hacker News', 12),
        visit(4, 'https://en.wikipedia.org/wiki/Tea', 'Tea - Wikipedia', 2),
        visit(
          5,
          'https://www.rfc-editor.org/rfc/rfc1149.html',
          'RFC 1149: IP Datagrams on Avian Carriers',
          1
        ),
        visit(
          6,
          'https://github.com/BenItBuhner/Zenium',
          'BenItBuhner/Zenium: a Zen-style browser',
          5
        ),
        visit(
          7,
          'https://developer.mozilla.org/en-US/docs/Web/API/Window/matchMedia',
          'Window: matchMedia() method - Web APIs | MDN',
          2
        ),
        visit(8, 'https://info.cern.ch/hypertext/WWW/TheProject.html', 'World Wide Web', 1)
      ]
    },
    // Per-site decisions the way the permission service keeps them (`origin|permission`), so
    // Site settings has sites to list and site information has permissions to show.
    'permissions.json': {
      version: 1,
      decisions: {
        'https://example.com|geolocation': 'allow',
        'https://example.com|microphone': 'deny',
        'https://example.com|popups': 'allow',
        'https://en.wikipedia.org|camera': 'allow',
        'https://en.wikipedia.org|notifications': 'allow',
        'https://news.ycombinator.com|notifications': 'deny',
        'https://github.com|clipboard-read': 'allow'
      }
    },
    'downloads.json': {
      version: 1,
      items: [
        download(
          1,
          'zenium-0.3.1-arm64.apk',
          48_217_088,
          'completed',
          'application/vnd.android.package-archive'
        ),
        download(2, 'design-language.pdf', 2_411_520, 'completed', 'application/pdf'),
        download(3, 'coffee-roast-chart.png', 918_336, 'interrupted', 'image/png'),
        download(4, 'rfc2324.txt', 21_504, 'cancelled', 'text/plain')
      ]
    }
  }
}

// --- outer stage: display, dev server, then Electron ---------------------------------------------

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch {
      // Mid-navigation the page cannot be asked; try again.
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: 'localhost' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

async function outer(opts) {
  const children = []
  const stop = () => children.forEach(killTree)
  process.on('exit', stop)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))

  const env = { ...process.env }
  if (opts.display) {
    env.DISPLAY = opts.display
  } else {
    let display = 99
    while (fs.existsSync(`/tmp/.X${display}-lock`)) display++
    const screen = `${Math.ceil(opts.width * opts.dpr) + 100}x${Math.ceil(opts.height * opts.dpr) + 100}x24`
    const xvfb = spawn('Xvfb', [`:${display}`, '-screen', '0', screen, '-nolisten', 'tcp'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true
    })
    xvfb.stderr.on('data', (d) => {
      const text = String(d)
      if (!/xkbcomp|keysym/i.test(text)) process.stderr.write(`[xvfb] ${text}`)
    })
    xvfb.on('exit', (code, signal) => console.log(`Xvfb exited (${code ?? signal})`))
    children.push(xvfb)
    await waitFor(() => fs.existsSync(`/tmp/.X${display}-lock`), 10_000, 'Xvfb')
    env.DISPLAY = `:${display}`
    console.log(`Xvfb on ${env.DISPLAY} (${screen})`)
  }

  let url = opts.url
  if (!url) {
    url = `http://localhost:${PORT}/`
    if (!(await portOpen(PORT))) {
      const vite = spawn('npm', ['run', 'dev:android'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env
      })
      children.push(vite)
      vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
      await waitFor(() => portOpen(PORT), 90_000, `the preview host on port ${PORT}`)
      console.log(`preview host on ${url}`)
    } else {
      console.log(`reusing the preview host on ${url}`)
    }
  }

  const electron = spawn(
    createRequire(import.meta.url)('electron'),
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // The window itself renders at the phone's density, so captures come out at that size.
      `--force-device-scale-factor=${opts.dpr}`,
      fileURLToPath(import.meta.url)
    ],
    {
      stdio: 'inherit',
      env: {
        ...env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        ZEN_PREVIEW_SHOTS: JSON.stringify({ ...opts, url })
      }
    }
  )
  const code = await new Promise((resolve) => electron.on('exit', (c) => resolve(c ?? 1)))
  stop()
  return code
}

// --- inner stage: runs inside Electron -----------------------------------------------------------

async function inner(opts) {
  const { app, BrowserWindow, nativeTheme } = await import('electron')
  const states = parseStates(opts.states)
  const schemes = opts.schemes
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  fs.mkdirSync(opts.out, { recursive: true })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  await app.whenReady()
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    useContentSize: true,
    frame: false,
    resizable: false,
    show: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false }
  })
  const wc = win.webContents
  wc.on('console-message', (event, legacyLevel, legacyMessage) => {
    const level = event.level ?? legacyLevel
    const message = String(event.message ?? legacyMessage ?? '')
    if (level === 'error' || level === 3) console.log(`[page] ${message.slice(0, 300)}`)
    // The preview host's own warnings (a state that never arrived).
    if ((level === 'warning' || level === 2) && message.startsWith('[zen preview]'))
      console.log(`[page] ${message.slice(0, 300)}`)
  })
  wc.on('render-process-gone', (_e, details) => {
    console.error(`renderer gone: ${details.reason}`)
    app.exit(1)
  })

  const loaded = () =>
    new Promise((resolve, reject) => {
      wc.once('did-finish-load', resolve)
      wc.once('did-fail-load', (_e, code, description, _url, isMainFrame) => {
        // -3 is ERR_ABORTED: a navigation replaced by another, not a failure.
        if (isMainFrame && code !== -3) reject(new Error(`${code} ${description}`))
      })
    })

  // Seed the profile: the host keeps its files in localStorage under `zen-preview:`, so it has
  // to be written from the origin and the chrome booted again on top of it.
  let seed = null
  if (opts.seed !== 'none') {
    seed = opts.seed ? JSON.parse(fs.readFileSync(opts.seed, 'utf8')) : defaultSeed()
  }
  const first = loaded()
  await wc.loadURL(opts.url)
  await first

  // Everything the page is asked goes through DevTools, bounded: `webContents.executeJavaScript`
  // holds its answer back while any frame of the page is loading (a tab's iframe fetching a site
  // counts), and an input event the renderer never acks would otherwise wait forever.
  wc.debugger.attach('1.3')
  const cdp = (method, params = {}, timeoutMs = 10_000) =>
    Promise.race([
      wc.debugger.sendCommand(method, params),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`${method} did not come back in ${timeoutMs} ms`)),
          timeoutMs
        )
      )
    ])
  const js = async (code) => {
    const result = await cdp('Runtime.evaluate', {
      expression: code,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails
      throw new Error(detail.exception?.description ?? detail.text)
    }
    return result.result.value
  }

  // A Pixel-sized phone with a finger on it: metrics through Electron, touch through DevTools.
  // Only after the first load: emulating an empty WebContents crashes Electron 44.
  wc.enableDeviceEmulation({
    screenPosition: 'mobile',
    screenSize: { width: opts.width, height: opts.height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: opts.dpr,
    viewSize: { width: opts.width, height: opts.height },
    scale: 1
  })
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })

  if (seed) {
    const entries = Object.entries(seed).map(([name, value]) => [name, JSON.stringify(value)])
    const again = loaded()
    await js(`
      for (const key of Object.keys(localStorage)) if (key.startsWith('zen-preview:')) localStorage.removeItem(key)
      for (const [name, text] of ${JSON.stringify(entries)}) localStorage.setItem('zen-preview:' + name, text)
      location.reload()
    `)
    await again
  }
  await waitFor(
    () => js(`Boolean(document.documentElement.dataset.formFactor)`),
    20_000,
    'the chrome'
  )
  await sleep(1500)
  const pointer = await js(`document.documentElement.dataset.pointer`)
  const formFactor = await js(`document.documentElement.dataset.formFactor`)
  console.log(`chrome up: form factor ${formFactor}, pointer ${pointer}`)
  if (pointer !== 'coarse') console.warn('warning: the chrome does not see a coarse pointer')

  // A finger has focused a control before a state is taken. Chromium draws a focus ring
  // (`:focus-visible`) on an element focused by script unless the last focus came from a pointer,
  // so without this a state's taps (script clicks) and the focus a sheet takes as it opens would
  // read as a keyboard's: a ring on the sheet's Cancel that no phone shows. A tap that focuses
  // nothing sets no modality, and the chrome has no control a tap may land on for free, so the
  // finger taps a transient, invisible button of its own in the top-left corner (above any sheet
  // a previous state left up), which then goes: the modality stays with the document. Touch, not
  // a mouse press – under touch emulation the first mouse press is never acked.
  const pointerModality = async () => {
    const PRIMER = 'zen-shot-primer'
    await js(`(() => {
      const button = document.createElement('button')
      button.id = ${JSON.stringify(PRIMER)}
      button.tabIndex = -1
      button.setAttribute('aria-hidden', 'true')
      button.style.cssText =
        'position:fixed;left:0;top:0;width:12px;height:12px;opacity:0;border:0;padding:0;' +
        'background:transparent;z-index:2147483647'
      document.body.appendChild(button)
    })()`)
    try {
      await cdp(
        'Input.dispatchTouchEvent',
        { type: 'touchStart', touchPoints: [{ x: 6, y: 6 }] },
        3000
      )
      await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, 3000)
      await sleep(200)
      const focused = await js(`document.activeElement?.id === ${JSON.stringify(PRIMER)}`)
      if (!focused) console.warn('warning: the primer tap focused nothing; focus rings may show')
    } finally {
      await js(`document.getElementById(${JSON.stringify(PRIMER)})?.remove()`)
    }
  }

  // `pressed=<selector>;<selector>` in a state (a key the page does not read; `;`-separated
  // because `,` separates the states): the elements those selectors match are drawn in their
  // pressed state while the still is taken – `:active` forced through DevTools, as the Styles
  // pane's :hov toggle does – for a record of a press fill, or of its absence on a row that is
  // not a target (§9.34). Returns the release, or null when the state names nothing.
  const press = async (state) => {
    const selector = new URLSearchParams(state).get('pressed')
    if (!selector) return null
    await cdp('DOM.enable')
    await cdp('CSS.enable')
    const { root } = await cdp('DOM.getDocument', { depth: 0 })
    const { nodeIds } = await cdp('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: selector.split(';').join(',')
    })
    if (nodeIds.length === 0) throw new Error(`pressed: nothing matches ${selector}`)
    const force = (forcedPseudoClasses) =>
      Promise.all(
        nodeIds.map((nodeId) => cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses }))
      )
    await force(['active'])
    // The fill's 120 ms transition.
    await sleep(300)
    return async () => {
      await force([])
      await cdp('CSS.disable')
      await cdp('DOM.disable')
    }
  }

  let failures = 0
  for (const scheme of schemes) {
    nativeTheme.themeSource = scheme
    await waitFor(
      () => js(`document.documentElement.dataset.theme === ${JSON.stringify(scheme)}`),
      5000,
      `the ${scheme} theme`
    ).catch((e) => console.warn(e.message))
    for (const { label, state } of states) {
      const file = path.join(opts.out, `${opts.prefix}${label}-${scheme}.png`)
      let release = null
      try {
        await pointerModality()
        await js(`document.documentElement.dataset.previewState = ''`)
        await js(`window.postMessage({ zenPreview: ${JSON.stringify(state)} }, '*')`)
        await waitFor(
          () => js(`document.documentElement.dataset.previewState === ${JSON.stringify(state)}`),
          8000,
          `state ${state}`
        )
        await sleep(opts.settle)
        release = await press(state)
        const png = (await wc.capturePage()).toPNG()
        fs.writeFileSync(file, png)
        console.log(`shot ${file} (${png.readUInt32BE(16)}x${png.readUInt32BE(20)})`)
      } catch (e) {
        failures++
        console.error(`failed ${label} ${scheme}: ${e.message}`)
      } finally {
        await release?.().catch((e) => console.warn(`release: ${e.message}`))
      }
    }
  }
  wc.debugger.detach()
  app.exit(failures ? 1 : 0)
}

// --- entry -----------------------------------------------------------------------------------------

if (process.versions.electron) {
  // Not awaited: Electron holds `ready` back until this module has finished evaluating.
  inner(JSON.parse(process.env.ZEN_PREVIEW_SHOTS)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
} else {
  try {
    process.exitCode = await outer(parseArgs(process.argv.slice(2)))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
