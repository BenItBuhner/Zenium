// One adapter per browser. Each one starts the browser itself (so it can be put in a memory
// cgroup before it execs), opens tabs in the background, switches to a tab, scrolls the tab in
// front, and waits for a tab to be painted again. Every browser runs with its own memory-saving
// feature switched on at its most aggressive setting (see README.md).
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CdpClient, MarionetteClient } from './proto.mjs'
import { treePids } from './sample.mjs'

const here = new URL('.', import.meta.url).pathname
export const ZENIUM_DIR = process.env.ZENIUM_DIR ?? resolve(here, '../../..')
export const BINARIES = {
  chromium: process.env.CHROMIUM_BIN ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  edge: process.env.EDGE_BIN ?? '/opt/bench/edge/opt/microsoft/msedge/msedge',
  firefox: process.env.FIREFOX_BIN ?? '/opt/bench/firefox/firefox',
  zenium: process.env.ZENIUM_ELECTRON ?? join(ZENIUM_DIR, 'node_modules/electron/dist/electron')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const WIDTH = 1280
const HEIGHT = 800

/**
 * Resolves once the page in front has been painted: the document is visible, its HTML has been
 * parsed (DOMContentLoaded), and two animation frames have run after that, i.e. at least one
 * frame with the page's content has been produced. `reloaded` tells whether the document was
 * created after `since` (a discarded or unloaded tab that had to load again).
 */
export const PAINTED = (sinceEpochMs) => `new Promise((resolve) => {
  const frames = () => requestAnimationFrame(() => requestAnimationFrame(() =>
    resolve({ reloaded: performance.timeOrigin > ${sinceEpochMs}, at: Date.now() })))
  const parsed = () => document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', frames, { once: true }) : frames()
  document.visibilityState === 'visible' ? parsed()
    : document.addEventListener('visibilitychange', parsed, { once: true })
})`

function spawnInCgroup(bin, args, { cgroup, env, cwd, log }) {
  // `exec` keeps the browser's pid equal to the shell's, which joined the cgroup first.
  const script = cgroup
    ? `echo $$ > /sys/fs/cgroup/memory/${cgroup}/cgroup.procs && exec "$@"`
    : 'exec "$@"'
  const child = spawn('sh', ['-c', script, 'sh', bin, ...args], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99', ...env },
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (d) => log?.(d.toString()))
  child.stderr.on('data', (d) => log?.(d.toString()))
  return child
}

async function waitFor(fn, timeoutMs, what) {
  const until = Date.now() + timeoutMs
  let last
  while (Date.now() < until) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
}

async function cdpBrowserUrl(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`)
  return (await r.json()).webSocketDebuggerUrl
}

// ---------------------------------------------------------------------------------------------
// Chromium family (stock Chromium / Chrome for Testing, Microsoft Edge)
// ---------------------------------------------------------------------------------------------

const POLICY_FILE = {
  chromium: '/etc/opt/chrome/policies/managed/zz-memory-bench.json',
  edge: '/etc/opt/edge/policies/managed/zz-memory-bench.json'
}
const POLICIES = {
  // Memory Saver on, "Maximum" savings: discards background tabs soonest.
  chromium: { HighEfficiencyModeEnabled: true, MemorySaverModeSavings: 2 },
  // Sleeping tabs on, after the shortest timeout Edge allows (30 seconds of inactivity).
  edge: {
    SleepingTabsEnabled: true,
    SleepingTabsTimeout: 30,
    HideFirstRunExperience: true,
    StartupBoostEnabled: false
  }
}

class ChromiumFamily {
  constructor(kind, opts) {
    this.kind = kind
    this.opts = opts
    this.port = opts.port ?? 9400
    this.tabs = []
  }

  async launch() {
    const { profileDir, cgroup, extraArgs = [], log, memorySaver = true } = this.opts
    if (memorySaver) {
      mkdirSync(join(POLICY_FILE[this.kind], '..'), { recursive: true })
      writeFileSync(POLICY_FILE[this.kind], JSON.stringify(POLICIES[this.kind]))
    }
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${this.port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox', // the cloud box runs as root
      '--password-store=basic',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--window-position=0,0',
      ...extraArgs,
      'about:blank'
    ]
    this.child = spawnInCgroup(BINARIES[this.kind], args, { cgroup, log })
    this.rootPid = this.child.pid
    const ws = await waitFor(() => cdpBrowserUrl(this.port), 30_000, `${this.kind} to start`)
    this.cdp = await CdpClient.connect(ws)
  }

  async openTab(url) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url, background: true })
    const tab = { targetId, url }
    this.tabs.push(tab)
    return tab
  }

  async target(tab) {
    const { targetInfos } = await this.cdp.send('Target.getTargets')
    const pages = targetInfos.filter((t) => t.type === 'page')
    const same = pages.find((t) => t.targetId === tab.targetId)
    if (same) return same.targetId
    // A discard may give the tab a new target; find it by the URL it last showed.
    const byUrl = pages.find((t) => t.url === tab.lastUrl || t.url === tab.url)
    if (byUrl) tab.targetId = byUrl.targetId
    return byUrl?.targetId ?? null
  }

  async activate(tab) {
    const id = (await this.target(tab)) ?? tab.targetId
    await this.cdp.send('Target.activateTarget', { targetId: id })
  }

  async scroll(tab, deltaY) {
    const id = await this.target(tab)
    if (!id) return
    await this.cdp.withSession(id, async (s) => {
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: WIDTH / 2, y: HEIGHT / 2, deltaX: 0, deltaY },
        s,
        5_000
      )
      tab.lastUrl = (
        await this.cdp.send('Target.getTargetInfo', { targetId: id }).catch(() => null)
      )?.targetInfo?.url
    })
  }

  async waitPainted(tab, sinceEpochMs, timeoutMs) {
    return waitFor(
      async () => {
        const id = await this.target(tab)
        if (!id) return null
        return this.cdp.withSession(id, (s) => this.cdp.evaluate(s, PAINTED(sinceEpochMs), 5_000))
      },
      timeoutMs,
      'the tab to paint'
    )
  }

  async close() {
    await this.cdp?.send('Browser.close', {}, undefined, 5_000).catch(() => {})
    this.cdp?.close()
    await killTree(this.child)
    if (this.opts.memorySaver !== false) rmSync(POLICY_FILE[this.kind], { force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Zenium (Electron)
// ---------------------------------------------------------------------------------------------

class Zenium {
  constructor(opts) {
    this.kind = 'zenium'
    this.opts = opts
    this.port = opts.port ?? 9333
    this.tabs = []
  }

  async launch() {
    const { profileDir, cgroup, extraArgs = [], log, zeniumState = {}, env = {} } = this.opts
    mkdirSync(join(profileDir, 'zen'), { recursive: true })
    const state = {
      version: 6, // state.json's schema version; an unversioned file is ignored
      ...zeniumState,
      settings: {
        onboardingDone: true,
        defaultBrowserPromptDismissed: new Date().toISOString(),
        ...(zeniumState.settings ?? {})
      }
    }
    writeFileSync(join(profileDir, 'zen', 'state.json'), JSON.stringify(state))
    const args = [
      ZENIUM_DIR,
      '--no-sandbox',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${this.port}`,
      ...extraArgs
    ]
    this.child = spawnInCgroup(BINARIES.zenium, args, { cgroup, log, cwd: ZENIUM_DIR, env })
    this.rootPid = this.child.pid
    const ws = await waitFor(() => cdpBrowserUrl(this.port), 45_000, 'Zenium to start')
    this.cdp = await CdpClient.connect(ws)
    this.shellId = await waitFor(
      async () => {
        const { targetInfos } = await this.cdp.send('Target.getTargets')
        return targetInfos.find(
          (t) => t.type === 'page' && /out\/renderer\/index\.html/.test(t.url)
        )?.targetId
      },
      30_000,
      'the Zenium window'
    )
    const { sessionId } = await this.cdp.send('Target.attachToTarget', {
      targetId: this.shellId,
      flatten: true
    })
    this.shell = sessionId
    await waitFor(
      () => this.cdp.evaluate(this.shell, `typeof window.zen?.invoke === 'function'`),
      30_000,
      'the Zenium bridge'
    )
  }

  /**
   * The main process's own JS memory (`process.memoryUsage()`, MB) over its inspector, and a
   * heap snapshot written to `snapshotPath` when given. Needs `--inspect=<port>` at launch.
   */
  async mainMemory(inspectPort, snapshotPath) {
    const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
    const c = await CdpClient.connect(list[0].webSocketDebuggerUrl)
    try {
      const usage = await c.send('Runtime.evaluate', {
        expression:
          'Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1048576)]))',
        returnByValue: true
      })
      if (snapshotPath) {
        const chunks = []
        c.on((m) => {
          if (m.method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(m.params.chunk)
        })
        await c.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, undefined, 180_000)
        writeFileSync(snapshotPath, chunks.join(''))
      }
      return usage.result.value
    } finally {
      c.close()
    }
  }

  invoke(name, args) {
    return this.cdp.evaluate(
      this.shell,
      `window.zen.invoke(${JSON.stringify(name)}, ${JSON.stringify(args ?? null)})`,
      30_000
    )
  }

  async openTab(url) {
    const tabId = await this.invoke('tab.create', { url, active: false })
    const tab = { tabId, url }
    this.tabs.push(tab)
    return tab
  }

  async state() {
    return this.cdp.evaluate(
      this.shell,
      `window.zen.invoke('app.getState').then((s) => {
        const tabs = Object.values(s.tabs ?? {})
        return tabs.map((t) => ({ id: t.id, url: t.url, discarded: t.discarded, frozen: t.frozen }))
      })`,
      30_000
    )
  }

  async target(tab) {
    const { targetInfos: cached } = await this.cdp.send('Target.getTargets')
    if (tab.targetId && cached.some((x) => x.targetId === tab.targetId)) return tab.targetId
    const tabs = await this.state()
    const t = tabs.find((x) => x.id === tab.tabId)
    if (!t) return null
    tab.lastUrl = t.url
    const { targetInfos } = await this.cdp.send('Target.getTargets')
    tab.targetId =
      targetInfos.find((x) => x.type === 'page' && (x.url === t.url || x.url === tab.url))
        ?.targetId ?? null
    return tab.targetId
  }

  async activate(tab) {
    await this.invoke('tab.activate', { tabId: tab.tabId })
  }

  async scroll(tab, deltaY) {
    const id = await this.target(tab)
    if (!id) return
    await this.cdp.withSession(id, (s) =>
      this.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: WIDTH / 2, y: HEIGHT / 2, deltaX: 0, deltaY },
        s,
        5_000
      )
    )
  }

  async waitPainted(tab, sinceEpochMs, timeoutMs) {
    return waitFor(
      async () => {
        const id = await this.target(tab)
        if (!id) return null
        return this.cdp.withSession(id, (s) => this.cdp.evaluate(s, PAINTED(sinceEpochMs), 5_000))
      },
      timeoutMs,
      'the tab to paint'
    )
  }

  async close() {
    this.cdp?.close()
    await killTree(this.child)
  }
}

// ---------------------------------------------------------------------------------------------
// Firefox (Marionette)
// ---------------------------------------------------------------------------------------------

/** First-run prompts off, plus Firefox's tab unloader made as eager as its prefs allow. */
const FIREFOX_PREFS = {
  'browser.shell.checkDefaultBrowser': false,
  'browser.aboutwelcome.enabled': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'browser.startup.page': 0,
  'datareporting.policy.dataSubmissionEnabled': false,
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'trailhead.firstrun.didSeeAboutWelcome': true,
  'browser.tabs.warnOnClose': false,
  // The remote agent's "recommended" prefs switch off things a normal profile has; keep stock.
  'remote.prefs.recommended': false
}
const FIREFOX_UNLOAD_PREFS = {
  // Unload background tabs once they have been inactive 30 s (Edge's shortest sleep timeout)...
  'browser.tabs.unloadOnLowMemory': true,
  'browser.tabs.min_inactive_duration_before_unload': 30_000,
  // ...and treat memory as always low, so the unloader runs without real memory pressure
  // (Firefox does not read cgroup limits, so it would not notice the 512 MB cap otherwise).
  'browser.low_commit_space_threshold_percent': 100,
  'browser.low_commit_space_threshold_mb': 1_000_000
}

class Firefox {
  constructor(opts) {
    this.kind = 'firefox'
    this.opts = opts
    this.port = opts.port ?? 2828
    this.tabs = []
  }

  async launch() {
    const { profileDir, cgroup, extraArgs = [], log, memorySaver = true } = this.opts
    mkdirSync(profileDir, { recursive: true })
    // Behind a TLS-intercepting proxy (the cloud box), Firefox needs the proxy's CA in its own
    // certificate store; Chromium-based browsers read the system NSS store instead.
    const ca = process.env.FIREFOX_EXTRA_CA
    if (ca && existsSync(ca))
      execFileSync('certutil', [
        '-A',
        '-n',
        'extra-ca',
        '-t',
        'C,,',
        '-i',
        ca,
        '-d',
        `sql:${profileDir}`
      ])
    const prefs = {
      ...FIREFOX_PREFS,
      'marionette.port': this.port,
      ...(memorySaver ? FIREFOX_UNLOAD_PREFS : {})
    }
    writeFileSync(
      join(profileDir, 'user.js'),
      Object.entries(prefs)
        .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
        .join('\n')
    )
    const args = [
      '--profile',
      profileDir,
      '--no-remote',
      '--marionette',
      '--width',
      String(WIDTH),
      '--height',
      String(HEIGHT),
      ...extraArgs,
      'about:blank'
    ]
    this.child = spawnInCgroup(BINARIES.firefox, args, {
      cgroup,
      log,
      env: { MOZ_CRASHREPORTER_DISABLE: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }
    })
    this.rootPid = this.child.pid
    this.m = await waitFor(() => MarionetteClient.connect(this.port), 45_000, 'Firefox to start')
    await this.m.run('chrome', 'window.__zb = new Map(); return true')
  }

  async openTab(url) {
    const id = this.tabs.length + 1
    await this.m.run(
      'chrome',
      `const [id, url] = arguments
       const tab = gBrowser.addTab(url, {
         inBackground: true,
         triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
       })
       window.__zb.set(id, tab)
       return true`,
      [id, url]
    )
    const tab = { id, url }
    this.tabs.push(tab)
    return tab
  }

  async activate(tab) {
    await this.m.run(
      'chrome',
      `const tab = window.__zb.get(arguments[0]); if (tab) gBrowser.selectedTab = tab; return Boolean(tab)`,
      [tab.id]
    )
  }

  async scroll(_tab, deltaY) {
    // A wheel event through the widget, over the middle of the content area.
    await this.m.run(
      'chrome',
      `const r = gBrowser.selectedBrowser.getBoundingClientRect()
       window.windowUtils.sendWheelEvent(r.left + r.width / 2, r.top + r.height / 2,
         0, arguments[0], 0, 0 /* DOM_DELTA_PIXEL */, 0, 0, 0, 0)
       return true`,
      [deltaY],
      5_000
    )
  }

  async waitPainted(tab, sinceEpochMs, timeoutMs) {
    return waitFor(
      async () => {
        // The tab in front's window handle, then the same paint check as the other browsers.
        const handle = await this.m.run(
          'chrome',
          `const tab = window.__zb.get(arguments[0])
           if (!tab || tab !== gBrowser.selectedTab || tab.hasAttribute('pending')) return null
           const { NavigableManager } = ChromeUtils.importESModule(
             'chrome://remote/content/shared/NavigableManager.sys.mjs')
           return NavigableManager.getIdForBrowser(tab.linkedBrowser)`,
          [tab.id]
        )
        if (!handle) return null
        await this.m.context('content')
        await this.m.send('WebDriver:SwitchToWindow', { handle, focus: false }, 5_000)
        return this.m.run('content', `return ${PAINTED(sinceEpochMs)}`, [], 5_000)
      },
      timeoutMs,
      'the tab to paint'
    )
  }

  async close() {
    await this.m?.send('Marionette:Quit', { flags: ['eForceQuit'] }, 5_000).catch(() => {})
    this.m?.close()
    await killTree(this.child)
  }
}

/**
 * Stop a browser and everything it started: SIGTERM the main process (Electron and Firefox quit
 * cleanly on it), then SIGKILL whatever of its tree is left, renderers orphaned by the exit too.
 */
async function killTree(child) {
  if (!child) return
  const pids = new Set(treePids(child.pid))
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once('exit', r))
    try {
      process.kill(child.pid, 'SIGTERM')
    } catch {
      /* gone */
    }
    await Promise.race([exited, sleep(5_000)])
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  await sleep(500)
}

export function makeBrowser(kind, opts) {
  switch (kind) {
    case 'chromium':
    case 'edge':
      return new ChromiumFamily(kind, opts)
    case 'zenium':
      if (!existsSync(join(ZENIUM_DIR, 'out/main/index.js')))
        throw new Error('build Zenium first (npx electron-vite build)')
      return new Zenium(opts)
    case 'firefox':
      return new Firefox(opts)
    default:
      throw new Error(`unknown browser ${kind}`)
  }
}
