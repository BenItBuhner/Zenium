// The `mcp` scenario: the MCP server (Settings → AI Agents) soaked on the unpacked build, short –
// scripts/mcp-soak.mjs's legs run in-process against the harness's launch, their verdict judged
// per step. Its own file so the harness's scenario table gains one line for it.
//
// A profile past onboarding with the server on (`settings.agents`: enabled, a free port, LAN off,
// new agents approved without asking, scripts allowed – the soak's clients carry the token, which
// approves them anyway) is launched twice, `mcp` and `mcp-restart`, the second being the restart
// the first prepares for:
//
//   mcp
//     server-up             <profile>/zen/agent.json says running and the URL answers (fatal)
//     soak                  MCP_SOAK.sessions agent lives, MCP_SOAK.concurrency at a time, one round
//                           (soakMainLeg: initialize, status, background mode, a tab on the soak's
//                           own fixture page, snapshot, screenshot, the form, foreground mode,
//                           screenshot, `zen_session end` – closeTabs on the even ones – a call
//                           after it on the same id, the adoption of an earlier orphan, end, DELETE)
//     hand-off              the stage's hand-off, judged on the screen: a session in background
//                           mode opens a tab on a solid-colour page (staged: laid out and painted
//                           off screen), takes the screen (zen_mode foreground takeScreen) and
//                           acts – the X display must then show the page's colour at five points
//                           inside the tab's view in the user's window (not the chrome over it,
//                           not a blank), read from the screen's own pixels
//     user-switch           the same switch made by the user: a second tab opened blank (staged
//                           at once) and navigated to its page there – the document committing
//                           on the stage, as a page an agent loads in a tab it already holds
//                           does – then switched to with Ctrl+Tab through the window's chrome
//                           (the sidebar click's activation, without a row to click on the
//                           Agents space today) and no agent call after – the screen must show
//                           its colour the same way
//     shim                  MCP_SOAK.shimSessions of the same through `zenium --mcp`, one process
//                           each (the build's own executable, the leg's --extra-args)
//     drop                  a client quiet without DELETE; another lists its group as owned, adopts
//                           it with force: true (soft until E), and after the DELETE for real
//     resurrection          a made-up session id with the token is 200 + "resumed"; without, 404
//     carry-across-restart  an HTTP session and a shim process that the restart must not lose
//     tidy                  what the sessions left orphaned is adopted and closed (the quit
//                           would otherwise ask about tabs the harness does not see: the app
//                           counts every space's, the sidebar shows the user's), and
//                           `zenium://diagnostics` is read while its counters still count the
//                           soak (the restart starts them over)
//     quit                  the graceful quit (the profile's server stops with it)
//   mcp-restart
//     server-up             the same profile's server back (the same token: agent.json keeps it)
//     old-session-resumes   the HTTP session id from before the quit is answered with the
//                           "resumed" notice; the shim process from before answers a call too
//     diagnostics           what the restart's leg left is adopted and closed; the restarted
//                           server's `zenium://diagnostics` read into the verdict
//     quit
//
// A step FAILS on a hard check that failed during it (the checks scripts/mcp-soak.mjs names:
// a tool error, a session lost, no resurrection, a background snapshot without a viewport, a
// screenshot without an image, a DELETE not 204 …); the soft checks – the ones named with the PR
// they wait on, `drop-force-adopt (until E)` – are counted in the step's detail and never fail
// it, so CI stays green until that PR lands. The whole verdict (counts, client latency per tool
// and leg, the server's diagnostics) is written to <out>/<label>/soak.json next to result.json
// and printed as the soak's table into the log.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import {
  HttpClient,
  Latencies,
  Verdict,
  delay,
  formatTable,
  openedTab,
  readDiagnostics,
  restartCarry,
  restartVerify,
  resurrectionProbes,
  soakDropLeg,
  soakMainLeg,
  soakShimLeg,
  startFixture,
  summarizeDiagnostics,
  tidy,
  waitForEndpoint
} from '../../scripts/mcp-soak.mjs'

export const MCP_SCENARIO = 'mcp'
export const MCP_RESTART_SCENARIO = 'mcp-restart'

/** The soak's size on CI: short – a runner's minute, not the full 3 × 30. */
export const MCP_SOAK = Object.freeze({ sessions: 6, concurrency: 3, rounds: 1, shimSessions: 2 })

/** How long the server may take to answer after a launch. */
const SERVER_UP_MS = 60_000

/**
 * Settings → AI Agents as the profile is seeded: the server on at `port`, loopback only, new
 * agents let in without the approval prompt, page scripts allowed (the soak's clients hold the
 * token, which approves them either way), the cursor shown as by default.
 */
export function agentSettings(port) {
  return {
    enabled: true,
    port,
    lan: false,
    approveNewAgents: false,
    approvedNames: [],
    defaultMode: 'foreground',
    allowScripts: true,
    showCursor: true
  }
}

/**
 * Where the scenario picks the server's port from: below the kernel's ephemeral range, which on
 * Linux starts at 32768 by default (`/proc/sys/net/ipv4/ip_local_port_range`; macOS and Windows
 * hand out from 49152). Nothing that asks the kernel for "any port" can land here.
 */
export const PORT_POOL = Object.freeze({ lo: 20000, hi: 32768 })

/** The kernel's first ephemeral port, from the proc file where there is one; the Linux default otherwise. */
export function ephemeralFloor(read = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    const low = Number(
      String(read('/proc/sys/net/ipv4/ip_local_port_range')).trim().split(/\s+/)[0]
    )
    if (Number.isInteger(low) && low > 0) return low
  } catch {
    // Not Linux, or no proc: the default below.
  }
  return PORT_POOL.hi
}

/** Whether a loopback listener can bind `port` right now (bound and released again). */
export function bindable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

/**
 * A port nothing listens on right now, picked below the ephemeral range so nothing can take it
 * between here and the app's own bind.
 *
 * The pick used to be the OS's – bind port 0, read the number, release it, seed the profile with
 * it. Released, that number went straight back into the kernel's ephemeral pool: the very pool the
 * fixture server, the stage pages, Playwright's inspector socket and Chromium's own sockets draw
 * from while the app boots. When one of those drew it first, the app's listen failed with
 * EADDRINUSE, agent.json stayed `running: false`, and server-up waited its full minute on a server
 * that had already given up (runs 36451930938 and 36274678598: ports 44025 and 43491, both inside
 * Linux's 32768–60999). A port below the floor can only be taken by something asking for that
 * exact number, which nothing here does; `bindable` still confirms it is free at the moment of the
 * pick. `random` and `floor` are injectable for the unit tests.
 */
export async function freePort({
  random = Math.random,
  floor = ephemeralFloor(),
  tries = 32
} = {}) {
  // A box whose ephemeral range starts low leaves no room beneath it; the pool is used as is
  // there – a verified-free port still, only without the guarantee.
  const hi = floor - PORT_POOL.lo >= 1024 ? Math.min(PORT_POOL.hi, floor) : PORT_POOL.hi
  const span = hi - PORT_POOL.lo
  let last = null
  for (let i = 0; i < tries; i++) {
    const port = PORT_POOL.lo + Math.floor(random() * span)
    if (await bindable(port)) return port
    last = port
  }
  throw new Error(
    `no free port in ${PORT_POOL.lo}–${hi - 1} after ${tries} tries (last tried ${last})`
  )
}

/** Where a step starts: the verdict's counts and every check's failure count so far. */
export function mark(verdict) {
  const checks = {}
  for (const [name, c] of Object.entries(verdict.summary().checks)) checks[name] = c.fail
  return { counts: verdict.snapshot(), checks }
}

/**
 * A step's outcome from the checks added since `before`: the sessions and calls it made, the
 * hard and soft failures, which checks failed (with the check's first quoted detail) – and
 * `error`, the message the step fails with, when a hard check failed; null otherwise.
 */
export function judgeStep(verdict, before) {
  const since = verdict.since(before.counts)
  const failed = { hard: [], soft: [] }
  for (const [name, c] of Object.entries(verdict.summary().checks)) {
    const failures = c.fail - (before.checks[name] ?? 0)
    if (failures > 0) failed[c.kind].push({ name, failures, sample: c.samples[0] ?? null })
  }
  const detail = {
    sessions: since.sessions,
    calls: since.calls,
    hardFailures: since.hard,
    softFailures: since.soft,
    failed
  }
  const error =
    since.hard > 0
      ? `${since.hard} hard check(s) failed: ${failed.hard
          .map((f) => `${f.name} ×${f.failures}${f.sample ? ` (${f.sample})` : ''}`)
          .join('; ')}`
      : null
  return { detail, error }
}

// ---------------------------------------------------------------------------------------------
// The stage's hand-off on the screen (hand-off, user-switch)
// ---------------------------------------------------------------------------------------------

/**
 * The pages the hand-off is checked with: one solid colour each, told apart from each other and
 * from anything the chrome paints (greys, whites) on the screen. The title is what the sidebar
 * row shows.
 */
export const STAGE_PAGES = Object.freeze({
  handOff: Object.freeze({ name: 'hand-off', title: 'Stage hand-off', rgb: [255, 136, 0] }),
  userSwitch: Object.freeze({
    name: 'user-switch',
    title: 'Stage user switch',
    rgb: [0, 102, 255]
  })
})

/** How far a screen pixel may be from the page's colour per channel (Xvfb's 24-bit is exact). */
export const COLOUR_TOLERANCE = 12

/** How long the moved page has to show its colour on the screen after the switch. */
export const PAINT_WAIT_MS = 15_000

/** A page that is nothing but its colour: the whole viewport `rgb`, no text to land a sample on. */
export function colourPage({ title, rgb }) {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body style="margin:0;min-height:100vh;background:rgb(${rgb.join(',')})"></body></html>`
  )
}

/** The stage pages served on 127.0.0.1 (an ephemeral port): `{ url(page), close }`. */
export function startStagePages() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://stage')
    const page = Object.values(STAGE_PAGES).find((p) => pathname === `/${p.name}`)
    if (!page) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(colourPage(page))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`
      resolve({
        url: (page) => `${origin}/${page.name}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}

/**
 * Where the screen is read inside a tab's view: five points well inside `rect` – its centre and
 * its four quarter points – in device pixels (`rect` is in DIPs with the display's `scale`, as
 * Session.tabViewScreenRect reports it), clear of the view's rounded corners and of any bar the
 * chrome lays along an edge.
 */
export function samplePoints(rect) {
  const scale = rect.scale ?? 1
  return [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75]
  ].map(([fx, fy]) => ({
    x: Math.round((rect.x + rect.width * fx) * scale),
    y: Math.round((rect.y + rect.height * fy) * scale)
  }))
}

/** Whether `pixel` ([r, g, b]) is `rgb` within the tolerance, channel by channel. */
export function isColour(pixel, rgb, tolerance = COLOUR_TOLERANCE) {
  return Boolean(pixel) && rgb.every((c, k) => Math.abs(pixel[k] - c) <= tolerance)
}

/**
 * The screen read at the sample points of `rect`: how many show `rgb`, of how many, `ok` when
 * all do, and what each point showed (the check's detail when they do not).
 */
export function judgePixels(screen, rect, rgb) {
  const seen = samplePoints(rect).map((p) => ({ ...p, rgb: screen.at(p.x, p.y) }))
  const matched = seen.filter((p) => isColour(p.rgb, rgb)).length
  return {
    matched,
    of: seen.length,
    ok: matched === seen.length,
    seen: seen.map((p) => `${p.x},${p.y}→${p.rgb ? `rgb(${p.rgb.join(',')})` : 'off screen'}`)
  }
}

/** The webContents id of the tab on `url`, as the main process lists it (null within `timeoutMs`). */
async function tabWebContentsId(s, url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tab = (await s.tabs()).find((t) => t.url === url)
    if (tab) return tab.id
    if (Date.now() >= deadline) return null
    await delay(200)
  }
}

/**
 * The webContents id of the one tab that appeared since `known` (Session.tabs' ids before it
 * was opened) – a blank tab has no URL to find it by. Null within `timeoutMs`; the step is the
 * only thing opening tabs while it runs.
 */
async function newTabWebContentsId(s, known, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const fresh = (await s.tabs()).filter((t) => !known.has(t.id))
    if (fresh.length) return fresh[0].id
    if (Date.now() >= deadline) return null
    await delay(200)
  }
}

/**
 * Whether the tab's view is off the user's window – the stage's (a hidden tab the host lays out
 * and paints off screen has no rect in the window's tree) – with the reason when it is not.
 */
async function stagedState(s, wcId) {
  if (wcId === null) return { staged: false, why: 'the tab is not among the webContents' }
  const rect = await s.tabViewScreenRect(wcId)
  if (rect) {
    return {
      staged: false,
      why: `the hidden tab's view is in the user's window at ${rect.x},${rect.y} ${rect.width}×${rect.height}`
    }
  }
  return { staged: true, why: '' }
}

/**
 * Waits up to `timeoutMs` for the screen to show `rgb` at every sample point inside the view of
 * tab `wcId` in the user's window: `{ ok, ms, rect, matched, of, seen }` – `rect` null while the
 * view is not in the window's tree, `screen: false` where the platform has no raw screen grab.
 */
async function colourOnScreen(s, h, wcId, rgb, timeoutMs = PAINT_WAIT_MS) {
  const t0 = Date.now()
  let last = { rect: null }
  for (;;) {
    const rect = await s.tabViewScreenRect(wcId)
    if (rect) {
      const screen = h.screenPixels()
      if (!screen) return { ok: false, screen: false, ms: Date.now() - t0, rect }
      last = { rect, ...judgePixels(screen, rect, rgb) }
      if (last.ok) return { ...last, ms: Date.now() - t0 }
    } else last = { rect: null }
    if (Date.now() - t0 >= timeoutMs) return { ...last, ok: false, ms: Date.now() - t0 }
    await delay(250)
  }
}

/** A pixel check's detail line: the count, the time, where the view stood and what was seen. */
function pixelDetail(page, shown) {
  if (shown.screen === false) return 'no raw screen grab on this platform'
  if (!shown.rect) return `the tab's view is not in the user's window after ${shown.ms} ms`
  const r = shown.rect
  return (
    `${shown.matched}/${shown.of} sample(s) rgb(${page.rgb.join(',')}) after ${shown.ms} ms ` +
    `in the ${r.width}×${r.height} view at ${r.x},${r.y}: ${shown.seen.join(' ')}`
  )
}

/**
 * The `hand-off` step. A session in background mode opens a tab on the hand-off page – hidden,
 * so the host stages it: laid out and painted off screen – then takes the screen (zen_mode
 * foreground takeScreen) and acts on the tab, which is what brings it in front of the user. The
 * screen must then show the page's colour at every sample point inside the tab's view within
 * PAINT_WAIT_MS (`hand-off-pixels`, hard): a view that arrived unpainted, or under the chrome,
 * shows the window's grey there instead. The session stays for the user-switch step.
 */
export async function stageHandOff(s, ctx, h, stage) {
  const { verdict } = ctx
  const client = new HttpClient({
    ...ctx.endpoint,
    name: 'smoke-stage',
    leg: 'stage',
    latencies: ctx.latencies
  })
  stage.client = client
  verdict.sessions++
  const call = async (name, args) => {
    const r = await client.call(name, args)
    verdict.calls++
    return r
  }
  await client.initialize()
  let r = await call('zen_mode', { mode: 'background' })
  verdict.hard('zen_mode background', !r.isError, r.text)
  const page = STAGE_PAGES.handOff
  const url = stage.pages.url(page)
  r = await call('browser_tabs', { action: 'new', url })
  const tabId = openedTab(r.text)
  verdict.hard('browser_tabs new', !r.isError && Boolean(tabId), r.text)
  if (!tabId) return { tabId: null }
  const wcId = await tabWebContentsId(s, url)
  // Staged, or there is no hand-off to judge: a background tab in the user's window is not the
  // stage's, and the check below would read a view that never moved.
  const { staged, why } = await stagedState(s, wcId)
  verdict.hard('staged', staged, why)
  // The switch: the screen taken, then one act – the act brings the tab in front.
  r = await call('zen_mode', { mode: 'foreground', takeScreen: true })
  verdict.hard('zen_mode foreground takeScreen', !r.isError, r.text)
  r = await call('browser_snapshot', { tabId })
  verdict.hard('foreground act', !r.isError, r.text)
  const shown = await colourOnScreen(s, h, wcId, page.rgb)
  if (shown.screen === false) verdict.skip('hand-off-pixels', 'hard', pixelDetail(page, shown))
  else verdict.hard('hand-off-pixels', shown.ok, pixelDetail(page, shown))
  s.shotAsIs('hand-off')
  ctx.log(`hand-off: ${pixelDetail(page, shown)}`)
  return { tabId, staged, shownAfterMs: shown.ok ? shown.ms : null, pixels: shown.seen ?? null }
}

/**
 * The `user-switch` step. The hand-off's session, back in background mode, opens a second tab
 * blank – staged at once, nothing to load – and navigates it to the user-switch page there, so
 * the page's document commits on the stage, as a page an agent loads in a tab it already holds
 * does. Then the user switches to it: Ctrl+Tab through the window's chrome (Session.press, the
 * path a key press takes into the app's shortcut table; `tab.next` activates with `userSwitch`,
 * as a click on the tab's sidebar row does – core/tabs.ts TabFocusOptions), pressed again while
 * another tab of the space came first, with no agent call after the navigation: the host's
 * hand-off runs on the user's activation alone, without a tool call's prepare to touch the page.
 * The screen must show the page's colour at every sample point inside its view within
 * PAINT_WAIT_MS (`user-switch-pixels`, hard). The session then ends with its tabs closed and is
 * deleted.
 *
 * The navigation, not a tab opened on the page: browser_tabs new with a url waits for the page
 * before it stages the tab (service.ts prepare loads first, then setAgentDriven), so that page
 * commits in a window that has been shown – the hand-off step's case. Only a navigation of a
 * tab already staged commits on the stage, and that is the commit the user's switch has to
 * survive.
 *
 * The keyboard rather than the row: with the Agents space active, the sidebar's space strip
 * stands off screen (Sidebar.tsx moves the strip, `spaces.length × 100 %` wide, by
 * `translateX(-activeIndex × 100 %)` of its own width), so there is no row to click – a
 * sidebar finding of its own, outside this leg.
 */
export async function stageUserSwitch(s, ctx, h, stage) {
  const { verdict } = ctx
  let client = stage.client
  if (!client) {
    client = new HttpClient({ ...ctx.endpoint, name: 'smoke-stage', leg: 'stage' })
    stage.client = client
    verdict.sessions++
    await client.initialize()
  }
  const call = async (name, args) => {
    const r = await client.call(name, args)
    verdict.calls++
    return r
  }
  let r = await call('zen_mode', { mode: 'background' })
  verdict.hard('zen_mode background', !r.isError, r.text)
  const page = STAGE_PAGES.userSwitch
  const url = stage.pages.url(page)
  const known = new Set((await s.tabs()).map((t) => t.id))
  r = await call('browser_tabs', { action: 'new' })
  const tabId = openedTab(r.text)
  verdict.hard('browser_tabs new', !r.isError && Boolean(tabId), r.text)
  const out = { tabId, staged: null, navigatedOnStage: null, presses: null, shown: null }
  if (tabId) {
    const wcId = await newTabWebContentsId(s, known)
    // Staged blank, before any page: the tab is not in the user's window (its view is the stage's).
    const blank = await stagedState(s, wcId)
    out.staged = blank.staged
    verdict.hard('staged', blank.staged, blank.why)
    // The page loaded in the staged tab – the commit on the stage. The last agent call.
    r = await call('browser_navigate', { tabId, url })
    verdict.hard('browser_navigate', !r.isError, r.text)
    const onUrl = wcId !== null && (await s.tabs()).some((t) => t.id === wcId && t.url === url)
    const still = await stagedState(s, wcId)
    out.navigatedOnStage = onUrl && still.staged
    verdict.hard(
      'navigated on the stage',
      out.navigatedOnStage,
      onUrl ? still.why : `the tab is not on ${url} after the navigation`
    )
    // The document committed while staged: the harness's own read of the page (not a tool call;
    // a call's prepare would touch the page). Each read bounded – a page that does not answer
    // is the check's failure to show, not the step's to hang on.
    if (wcId !== null) {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const ready = await Promise.race([
          s.tabEval(wcId, 'document.readyState'),
          delay(2000).then(() => 'no answer')
        ]).catch(() => null)
        if (ready === 'complete') break
        await delay(200)
      }
    }
    // The user's switch: Ctrl+Tab until the tab is the space's active one (at most one press per
    // tab the space holds, plus one); no agent call from here until the check is made.
    const tabsInSpace = (await s.tabs()).length
    let presses = 0
    let active = false
    while (!active && presses <= tabsInSpace) {
      await s.press('Control+Tab')
      presses++
      const deadline = Date.now() + 3000
      while (!active && Date.now() < deadline) {
        active = (await s.activeTabId()) === tabId
        if (!active) await delay(100)
      }
    }
    out.presses = presses
    verdict.hard('user-switch', active, `not the active tab after ${presses} Ctrl+Tab`)
    const shown = await colourOnScreen(s, h, wcId, page.rgb)
    if (shown.screen === false) verdict.skip('user-switch-pixels', 'hard', pixelDetail(page, shown))
    else verdict.hard('user-switch-pixels', shown.ok, pixelDetail(page, shown))
    s.shotAsIs('user-switch')
    ctx.log(`user-switch: ${pixelDetail(page, shown)}`)
    out.shown = shown
  }
  r = await call('zen_session', { action: 'end', closeTabs: true })
  verdict.hard('zen_session end closeTabs', !r.isError, r.text)
  const closed = await client.close()
  verdict.hard('delete', closed, 'DELETE did not answer 204')
  stage.client = null
  return {
    tabId,
    staged: out.staged,
    navigatedOnStage: out.navigatedOnStage,
    presses: out.presses,
    shownAfterMs: out.shown?.ok ? out.shown.ms : null,
    pixels: out.shown?.seen ?? null
  }
}

/**
 * Runs the scenario. `h` is what the harness lends it: `freshProfile`, `runScenario`, `log`,
 * the executable under test (`exe`; the shim processes are its `--mcp`), the leg's extra
 * arguments (`extraArgs`, passed on to those processes), the label's output directory
 * (`outDir`, where soak.json goes), and for the stage's hand-off `screenPixels` (the X display
 * as raw RGB, null off Linux).
 */
export async function scenarioMcp(h) {
  const { freshProfile, runScenario, log, exe, extraArgs, outDir } = h
  const port = await freePort()
  const userData = freshProfile(`profile-${MCP_SCENARIO}`, {
    onboardingDone: true,
    settings: { agents: agentSettings(port) }
  })
  const fixture = await startFixture()
  const stage = { pages: await startStagePages(), client: null }
  const verdict = new Verdict()
  const latencies = new Latencies()
  const ctx = {
    endpoint: null,
    fixture,
    verdict,
    latencies,
    log: (line) => log(`mcp: ${verdict.redact(line)}`),
    verbose: () => undefined,
    extraArgs
  }
  const legs = []
  let carry = { sessionId: null, shim: null }
  let diagnostics = null
  let diagnosticsAfterRestart = null

  /** A step whose pass or fail is the soak's hard checks during it; the soft ones its detail. */
  const judged = (s, name, fn, opts) =>
    s.step(
      name,
      async () => {
        const before = mark(verdict)
        const extra = (await fn()) ?? {}
        const { detail, error } = judgeStep(verdict, before)
        if (error) {
          const e = new Error(error)
          e.detail = { ...detail, ...extra }
          throw e
        }
        return { ...detail, ...extra }
      },
      opts
    )
  // The wait itself gives up at SERVER_UP_MS and says which phase it was stuck in (what
  // agent.json said, whether the url answered); the step's own guard sits a beat past that so
  // it is the wait's report that fails the step, not a bare "timed out after 60000 ms" that
  // pre-empted it (run 36451930938 read exactly that, with "server: no diagnostics read").
  const serverUp = (s) =>
    s.step(
      'server-up',
      async () => {
        ctx.endpoint = await waitForEndpoint(userData, SERVER_UP_MS, { log: ctx.log })
        if (!verdict.secrets.includes(ctx.endpoint.token)) verdict.secrets.push(ctx.endpoint.token)
        return { url: ctx.endpoint.url, port }
      },
      { fatal: true, timeoutMs: SERVER_UP_MS + 5_000 }
    )
  const summary = () =>
    verdict.summary({
      options: { ...MCP_SOAK, legs, fixture: 'built-in', strict: false },
      latency: latencies.summary(),
      diagnostics,
      diagnosticsAfterRestart
    })

  try {
    const first = await runScenario(MCP_SCENARIO, userData, {}, async (s, out) => {
      out.port = port
      await serverUp(s)
      legs.push('http')
      await judged(s, 'soak', () => soakMainLeg(ctx, MCP_SOAK), { timeoutMs: 300_000 })
      legs.push('stage')
      await judged(s, 'hand-off', () => stageHandOff(s, ctx, h, stage), { timeoutMs: 90_000 })
      await judged(s, 'user-switch', () => stageUserSwitch(s, ctx, h, stage), {
        timeoutMs: 90_000
      })
      legs.push('stdio')
      await judged(
        s,
        'shim',
        () =>
          soakShimLeg(ctx, {
            exe,
            userDataDir: userData,
            sessions: MCP_SOAK.shimSessions,
            concurrency: 2
          }),
        { timeoutMs: 180_000 }
      )
      legs.push('drop')
      await judged(s, 'drop', () => soakDropLeg(ctx), { timeoutMs: 120_000 })
      await judged(s, 'resurrection', () => resurrectionProbes(ctx))
      legs.push('restart')
      await judged(s, 'carry-across-restart', async () => {
        carry = await restartCarry(ctx, { exe, userDataDir: userData })
        return { httpSession: Boolean(carry.sessionId), shimProcess: Boolean(carry.shim) }
      })
      await judged(s, 'tidy', async () => {
        const before = verdict.counters.tidiedGroups ?? 0
        await tidy(ctx)
        diagnostics = await readDiagnostics(ctx)
        return {
          groupsClosed: (verdict.counters.tidiedGroups ?? 0) - before,
          server: summarizeDiagnostics(diagnostics)
        }
      })
      await s.step('quit', () => s.quitGracefully())
    })
    if (first.fatal) return first

    return await runScenario(MCP_RESTART_SCENARIO, userData, {}, async (s, out) => {
      out.port = port
      await serverUp(s)
      await judged(s, 'old-session-resumes', () => restartVerify(ctx, carry), {
        timeoutMs: 120_000
      })
      carry = { sessionId: null, shim: null }
      await judged(s, 'diagnostics', async () => {
        await tidy(ctx)
        diagnosticsAfterRestart = await readDiagnostics(ctx)
        return { server: summarizeDiagnostics(diagnosticsAfterRestart) }
      })
      out.soak = summary().counts
      await s.step('quit', () => s.quitGracefully())
    })
  } finally {
    if (carry.shim) await carry.shim.close().catch(() => undefined)
    if (stage.client) await stage.client.close().catch(() => undefined)
    await stage.pages.close()
    await fixture.close()
    const final = summary()
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'soak.json'), JSON.stringify(final, null, 2) + '\n')
    for (const line of formatTable(final).split('\n')) log(`mcp: ${line}`)
  }
}
