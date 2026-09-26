// The `visibility` scenario (W6-F6): a tab page's `document.visibilityState` follows its WINDOW
// as a Chrome tab's does. Its own file so the harness's scenario table gains one line for it.
//
// Every move is made on the app's main window from the main process and read off the page – its
// `visibilityState` and the `visibilitychange` events it saw (a logger installed in the page
// counts them; a move that Chrome reports as one transition has to be exactly one here, a
// hidden → visible → hidden flicker is a failure):
//
//   minimize / restore   `hidden` while minimised, `visible` again on restore. Under Xvfb there
//                        is no window manager, so `minimize()` does nothing at all (no event, the
//                        window never minimised): the two steps record `skipped` with that reason
//                        and `hide` / `show` below stand in for them on that leg.
//   hide / show          `hidden` while the window is hidden – its tab view HIDDEN to Chromium
//                        (`WebContentsView.getVisible()` false, W6-F6's fix) – and `visible` on
//                        show, the view back in its box.
//   blur-partial-cover   a window of the harness's own over part of the main window, focused: the
//                        page stays `visible` through the blur, no event at all (Chrome's: a blur
//                        is not hidden).
//   blur-full-cover      a window over the whole of it: `hidden` where the OS tracks occlusion
//                        natively (Windows, macOS – Chromium's own trackers, nothing of the app's)
//                        and this machine reports it (the bare window of `native-forwarding`
//                        read `hidden` under its own full cover), `visible` again when the cover
//                        closes; elsewhere recorded, not judged – on Linux Chrome does no
//                        occlusion tracking on X11 beyond what the X server says (Xvfb reports a
//                        fully obscured window and the page reads `hidden`, a compositing desktop
//                        does not), and the macOS arm64 runner's virtual display reports no
//                        occlusion to any window; on every leg the count of events is exactly
//                        the flips that happened.
//   parked-under-cover   the Web capture overlay over the page parks its view (W6-F5: shown, one
//                        pixel in a window corner, the page `visible`); the window hidden takes
//                        the parked view down for real (hidden, its box its own) and the page
//                        reads `hidden`; the window shown parks it again and the page reads
//                        `visible`; Escape closes the overlay and the view is back in its box.
//
// Before the app's own window is moved, the same moves are made on a throwaway BrowserWindow +
// WebContentsView the scenario creates in the app's main process, with no host logic in between:
// what Electron forwards natively on this OS – the slice's "before" column – recorded in the
// `native-forwarding` step and not judged.
//
// One thing the harness has to undo first: Playwright turns `Emulation.setFocusEmulationEnabled`
// on for every page it attaches (its default page overrides), which makes the renderer report
// itself focused and so pins `document.visibilityState` to `visible` however the window behaves.
// Left on, every reading here would be `visible` and the scenario would measure the harness, not
// the browser. `s.honestVisibility` turns it back off, through each page's own Playwright CDP
// session, for the tab this scenario reads and for the throwaway native view – so both follow
// their window as they do for a user. (The earlier report that a page never reads `hidden` on
// Xvfb was this same pin, not the platform.)
import { parkedInCorner, viewInBox } from './views.mjs'

export const VISIBILITY_SCENARIO = 'visibility'

/** The Web capture overlay (components/capture/CaptureOverlay.tsx): the chrome cover used. */
const CAPTURE_OVERLAY = '[role="dialog"][aria-label="Web capture"]'

/**
 * Installed once in a page: its `visibilityState` and every `visibilitychange` since, stamped.
 * Returns how many entries the log holds.
 */
export const VISIBILITY_LOGGER = `(() => {
  if (!window.__zenVis) {
    const log = [{ t: Math.round(performance.now()), state: document.visibilityState, ev: 'init' }]
    window.__zenVis = { log }
    document.addEventListener('visibilitychange', () => {
      log.push({ t: Math.round(performance.now()), state: document.visibilityState, ev: 'visibilitychange' })
    })
  }
  return window.__zenVis.log.length
})()`

/** The page's reading: its state, `document.hidden`, the events counted, the last few entries. */
export const VISIBILITY_PROBE = `(() => {
  const log = window.__zenVis ? window.__zenVis.log : []
  return {
    state: document.visibilityState,
    hidden: document.hidden,
    changes: log.filter((e) => e.ev === 'visibilitychange').length,
    log: log.slice(-6)
  }
})()`

/** A page for the throwaway window, with the logger in it from the first byte. */
export function loggedPage(name, color) {
  const body =
    `<!doctype html><title>${name}</title>` +
    `<body style="margin:0;background:${color};font:20px system-ui">${name}` +
    `<script>${VISIBILITY_LOGGER}</script></body>`
  return `data:text/html,${encodeURIComponent(body)}`
}

/** Whether Chromium tracks a window's occlusion by other windows natively on `platform`. */
export function occlusionTracked(platform) {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * Whether the full-cover step is judged on this leg: Chromium tracks occlusion natively on this
 * OS, and this machine reported it to the bare window of the `native-forwarding` step – its
 * `cover-full` row read `nativeCoverFull`, `hidden` where the OS told the window it was covered.
 * A display that reports none to any window (the macOS arm64 runner's virtual display: the bare
 * window's page stayed `visible` under a full cover, 2026-09-26) is recorded, not judged. An
 * unknown native reading (`null`, the probe unavailable) leaves the OS's own rule to stand.
 */
export function occlusionJudged(platform, nativeCoverFull) {
  if (!occlusionTracked(platform)) return false
  return nativeCoverFull !== 'visible'
}

/** The box a window covering the whole of `bounds` takes: `inflate` DIP beyond it on every side. */
export function fullCoverBounds(bounds, inflate = 8) {
  return {
    x: bounds.x - inflate,
    y: bounds.y - inflate,
    width: bounds.width + 2 * inflate,
    height: bounds.height + 2 * inflate
  }
}

/** The box a window covering the top-left quarter of `bounds` takes (a blur, the page in view). */
export function partialCoverBounds(bounds) {
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(120, Math.floor(bounds.width / 2)),
    height: Math.max(120, Math.floor(bounds.height / 2))
  }
}

/**
 * What is wrong with a reading `after` a move that Chrome reports as one transition to `state`
 * from the reading `before`: the state, then exactly one `visibilitychange` more (a
 * hidden → visible → hidden flicker is two). Null when nothing is.
 */
export function flipVerdict(before, after, state) {
  if (!after) return 'no reading from the page'
  if (after.state !== state) return `the page reads ${after.state}, not ${state}`
  const flips = after.changes - before.changes
  if (flips !== 1) {
    return `${flips} visibilitychange event(s) for one transition to ${state} (${before.changes} → ${after.changes}): ${JSON.stringify(after.log)}`
  }
  return null
}

/**
 * What is wrong with a reading `after` a move that Chrome reports nothing for: the same `state`
 * as before, not one `visibilitychange` more. Null when nothing is.
 */
export function steadyVerdict(before, after, state) {
  if (!after) return 'no reading from the page'
  if (after.state !== state) return `the page reads ${after.state}, not ${state}`
  if (after.changes !== before.changes) {
    return `${after.changes - before.changes} visibilitychange event(s) for a move that is none to a page (${before.changes} → ${after.changes}): ${JSON.stringify(after.log)}`
  }
  return null
}

/**
 * The one-line row of the report's table for a move: what the page read before and after, and
 * how many events the move cost it.
 */
export function tableRow(move, before, after) {
  return {
    move,
    before: before ? before.state : null,
    after: after ? after.state : null,
    events: before && after ? after.changes - before.changes : null
  }
}

/**
 * Runs the scenario. `h` is what the harness lends it: `freshProfile`, `runScenario`, `waitFor`,
 * `delay`, `log`, the fixture (`startBootFixture`'s result) and the platform.
 */
export async function scenarioVisibility(h) {
  const { freshProfile, runScenario, waitFor, delay, log, fixture, platform } = h
  const page = fixture.first
  const userData = freshProfile(`profile-${VISIBILITY_SCENARIO}`, { onboardingDone: true })
  const tracked = occlusionTracked(platform)

  return runScenario(VISIBILITY_SCENARIO, userData, {}, async (s, out) => {
    out.platform = platform
    out.occlusionTracked = tracked
    /** What the bare window's page read under a full cover (`native-forwarding`): the machine's word. */
    let nativeCoverFull = null
    const invoke = (name, args) =>
      s.chrome.evaluate(({ name, args }) => window.zen.invoke(name, args), { name, args })
    let tab = null
    /** The page's reading (VISIBILITY_PROBE); null while the page cannot answer. */
    const tryRead = () => s.tabEval(tab.id, VISIBILITY_PROBE).catch(() => null)
    /** The page's reading, which it has to give. */
    const read = async () => {
      const reading = await tryRead()
      if (!reading) throw new Error(`no reading from the page (webContents ${tab?.id})`)
      return reading
    }
    /** The main window's state and the tab's view in it, from the main process. */
    const facts = async () => {
      const window = await s.app.evaluate(({ BrowserWindow }, wid) => {
        const w = BrowserWindow.fromId(wid)
        if (!w || w.isDestroyed()) return null
        return {
          minimized: w.isMinimized(),
          visible: w.isVisible(),
          focused: w.isFocused(),
          bounds: w.getBounds()
        }
      }, s.mainWindowId)
      const kb = await s.keyboardFacts().catch(() => null)
      const view = kb?.views?.find((v) => v.wc === tab.id) ?? null
      return {
        window,
        content: kb?.content ?? null,
        view: view
          ? {
              visible: view.visible,
              bounds: view.bounds,
              inBox: viewInBox(view, kb.content),
              parked: view.visible === true && parkedInCorner(view.bounds, kb.content)
            }
          : null
      }
    }
    /** The main window moved from the main process; its state after. */
    const move = (action) =>
      s.app.evaluate(
        ({ BrowserWindow }, { wid, action }) => {
          const w = BrowserWindow.fromId(wid)
          if (!w || w.isDestroyed()) throw new Error(`window ${wid} is gone`)
          if (action === 'minimize') w.minimize()
          else if (action === 'restore') w.restore()
          else if (action === 'hide') w.hide()
          else if (action === 'show') w.show()
          else throw new Error(`no such move: ${action}`)
          return { minimized: w.isMinimized(), visible: w.isVisible(), focused: w.isFocused() }
        },
        { wid: s.mainWindowId, action }
      )
    /**
     * A window of the harness's own shown over the main window at `bounds` and given the focus
     * (the main window blurs). Kept in the main process under `kind` for `uncover`.
     */
    const cover = (kind, bounds) =>
      s.app.evaluate(
        async ({ BrowserWindow }, { wid, kind, bounds, url }) => {
          const g = globalThis
          g.__smokeVis = g.__smokeVis || { covers: {} }
          if (g.__smokeVis.covers[kind]) throw new Error(`a ${kind} cover is already up`)
          const w = new BrowserWindow({
            ...bounds,
            frame: false,
            show: false,
            skipTaskbar: true,
            backgroundColor: '#b23a3a',
            webPreferences: { sandbox: true, contextIsolation: true }
          })
          g.__smokeVis.covers[kind] = w
          await w.loadURL(url)
          w.show()
          w.focus()
          w.moveTop()
          const main = BrowserWindow.fromId(wid)
          return {
            id: w.id,
            bounds: w.getBounds(),
            focused: w.isFocused(),
            mainFocused: main && !main.isDestroyed() ? main.isFocused() : null
          }
        },
        { wid: s.mainWindowId, kind, bounds, url: loggedPage(`${kind} cover`, '#b23a3a') }
      )
    const uncover = (kind) =>
      s.app.evaluate((_electron, kind) => {
        const g = globalThis
        const w = g.__smokeVis?.covers?.[kind]
        if (!w) return false
        delete g.__smokeVis.covers[kind]
        if (!w.isDestroyed()) w.close()
        return true
      }, kind)
    /** The page's reading once it says `state`, or the last reading when it never does. */
    const readUntil = async (state, timeoutMs, what) => {
      let last = null
      await waitFor(
        async () => {
          last = await tryRead()
          return last && last.state === state ? last : null
        },
        timeoutMs,
        what
      ).catch(() => undefined)
      // A moment for a second event that would follow a flicker, then the reading that counts.
      await delay(400)
      return (await tryRead()) ?? last
    }
    /** The main window back in front, and the page reading `visible` again. */
    const frontAndVisible = async (what) => {
      await s.bringToFront()
      return readUntil('visible', 8000, what)
    }
    const fail = (verdict, extra) => {
      if (verdict) throw new Error(`${verdict}${extra ? ` – ${JSON.stringify(extra)}` : ''}`)
    }

    await s.step('page-visible', async () => {
      // The fixture's page in a tab of its own, the window in front: the page reads `visible`,
      // its view shown in its box (no chrome cover up – the new-tab URL bar of the tab the window
      // opened with is closed with Escape while it covers the content).
      const tabId = await invoke('tab.create', { url: page.url, active: true })
      tab = await s.waitForTab(page.url, 20000)
      // Playwright pins every page it attaches to `visible` (focus emulation); the page's real
      // visibility is what this scenario measures, so it turns that off for the tab first.
      const unpinned = await s.honestVisibility(page.url)
      await s.bringToFront()
      await s.tabEval(tab.id, VISIBILITY_LOGGER)
      let lastEscape = 0
      let seen = null
      const state = await waitFor(
        async () => {
          seen = await facts()
          const reading = await tryRead()
          if (seen.view?.inBox === true && reading?.state === 'visible') return { seen, reading }
          if (Date.now() - lastEscape >= 1000) {
            lastEscape = Date.now()
            await s.press('Escape')
            await s.bringToFront()
          }
          return null
        },
        15000,
        'the page visible in its box with the window in front'
      ).catch((err) => {
        throw new Error(`${err.message}; last: ${JSON.stringify(seen)}`)
      })
      await s.settle()
      await s.shot('01-page-visible')
      return { tabId, webContentsId: tab.id, unpinned, ...state }
    })

    await s.step('native-forwarding', async () => {
      // What Electron forwards to a WebContentsView's page natively on this OS (no host logic:
      // a throwaway BrowserWindow with the view as its child, made here in the app's main
      // process), for the same moves the steps below make on the app's window. Recorded, not
      // judged: the slice's "before" column.
      const box = { x: 40, y: 40, width: 720, height: 480 }
      const opened = await s.app.evaluate(
        async ({ BrowserWindow, WebContentsView }, { box, pages }) => {
          const g = globalThis
          g.__smokeVis = g.__smokeVis || { covers: {} }
          if (g.__smokeVis.native) throw new Error('a native probe window is already up')
          const win = new BrowserWindow({
            ...box,
            frame: false,
            show: false,
            skipTaskbar: true,
            webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true }
          })
          const events = []
          for (const ev of ['show', 'hide', 'minimize', 'restore', 'blur', 'focus']) {
            win.on(ev, () => events.push(ev))
          }
          await win.loadURL(pages.chrome)
          const view = new WebContentsView({
            webPreferences: { sandbox: true, contextIsolation: true }
          })
          win.contentView.addChildView(view)
          view.setBounds({ x: 0, y: 40, width: box.width, height: box.height - 40 })
          view.setVisible(true)
          await view.webContents.loadURL(pages.tab)
          win.show()
          win.focus()
          g.__smokeVis.native = { win, view, events }
          return { windowId: win.id, viewWebContentsId: view.webContents.id }
        },
        {
          box,
          pages: {
            chrome: loggedPage('native chrome', '#dfe3ea'),
            tab: loggedPage('native tab', '#f5e6a8')
          }
        }
      )
      const nativeRead = () =>
        s.app
          .evaluate((_electron, probe) => {
            const n = globalThis.__smokeVis?.native
            if (!n || n.view.webContents.isDestroyed()) return null
            return n.view.webContents.executeJavaScript(probe)
          }, VISIBILITY_PROBE)
          .catch(() => null)
      const nativeMove = (action, coverBox) =>
        s.app.evaluate(
          async ({ BrowserWindow }, { action, coverBox, url }) => {
            const n = globalThis.__smokeVis.native
            const w = n.win
            const eventsBefore = n.events.length
            if (action === 'minimize') w.minimize()
            else if (action === 'restore') w.restore()
            else if (action === 'hide') w.hide()
            else if (action === 'show') w.show()
            else if (action === 'cover') {
              const c = new BrowserWindow({
                ...coverBox,
                frame: false,
                show: false,
                skipTaskbar: true,
                backgroundColor: '#b23a3a',
                webPreferences: { sandbox: true, contextIsolation: true }
              })
              n.cover = c
              await c.loadURL(url)
              c.show()
              c.focus()
              c.moveTop()
            } else if (action === 'uncover') {
              if (n.cover && !n.cover.isDestroyed()) n.cover.close()
              n.cover = null
              w.focus()
            }
            await new Promise((r) => setTimeout(r, 150))
            return {
              minimized: w.isMinimized(),
              visible: w.isVisible(),
              focused: w.isFocused(),
              events: n.events.slice(eventsBefore)
            }
          },
          { action, coverBox: coverBox ?? null, url: loggedPage('native cover', '#b23a3a') }
        )
      // The throwaway view is a Playwright page too, so its reading is pinned to `visible` until
      // focus emulation is turned off for it (its page's URL carries `native tab`, encoded).
      const nativeUnpinned = await s
        .honestVisibility('native%20tab')
        .catch((e) => ({ marker: 'native%20tab', pages: 0, error: String(e.message || e) }))
      const rows = []
      try {
        const first = await readUntilNative(nativeRead, 'visible', 8000, waitFor, delay)
        rows.push({ ...tableRow('shown', null, first), reading: first })
        if (!first || first.state !== 'visible') {
          return {
            unavailable: `the throwaway window's page never read visible: ${JSON.stringify(first)}`,
            rows,
            ...opened
          }
        }
        let before = first
        const moves = [
          ['minimize', 'hidden'],
          ['restore', 'visible'],
          ['hide', 'hidden'],
          ['show', 'visible'],
          ['cover-full', 'hidden', fullCoverBounds(box)],
          ['uncover-full', 'visible'],
          ['cover-partial', 'visible', partialCoverBounds(box)],
          ['uncover-partial', 'visible']
        ]
        for (const [name, expected, coverBox] of moves) {
          const action = name.startsWith('cover')
            ? 'cover'
            : name.startsWith('uncover')
              ? 'uncover'
              : name
          const window = await nativeMove(action, coverBox)
          const after = await readUntilNative(nativeRead, expected, 3000, waitFor, delay)
          if (name === 'cover-full') nativeCoverFull = after ? after.state : null
          rows.push({
            ...tableRow(name, before, after),
            chromeReads: expected,
            window,
            reading: after
          })
          log(
            `${VISIBILITY_SCENARIO}: native ${name}: ${before.state} → ${after ? after.state : '?'} (${after ? after.changes - before.changes : '?'} event(s); window ${JSON.stringify(window)})`
          )
          before = after ?? before
        }
      } finally {
        await s.app.evaluate(() => {
          const g = globalThis
          const n = g.__smokeVis?.native
          if (!n) return
          g.__smokeVis.native = null
          if (n.cover && !n.cover.isDestroyed()) n.cover.close()
          if (!n.win.isDestroyed()) n.win.close()
        })
      }
      // The app's window back in front (the throwaway window may have stood over it): the page
      // reads `visible` again before its own moves are made.
      const reading = await frontAndVisible("the app's page visible again after the native probe")
      fail(
        reading?.state === 'visible'
          ? null
          : `the page reads ${reading?.state} with the window back in front`,
        reading
      )
      return { ...opened, nativeUnpinned, rows }
    })

    let minimised = false
    await s.step('minimize', async () => {
      const before = await read()
      const moved = await move('minimize')
      const state = await waitFor(
        async () => {
          const f = await facts()
          return f.window?.minimized ? f : null
        },
        2500,
        'the window minimised'
      ).catch(() => null)
      if (!state) {
        const window2 = (await facts()).window
        if (platform === 'linux') {
          // No window manager under Xvfb: minimize() is a no-op there (no `minimize` event, the
          // window never minimised). hide / show below stand in for the pair on this leg.
          const reading = await read()
          fail(steadyVerdict(before, reading, 'visible'), reading)
          return {
            skipped:
              'minimize() is a no-op on this display (no window manager under Xvfb): the window never minimised – hide/show stand in',
            moved,
            window: window2,
            reading
          }
        }
        throw new Error(`the window did not minimise within 2.5 s: ${JSON.stringify(window2)}`)
      }
      minimised = true
      const after = await readUntil('hidden', 8000, 'the page hidden with its window minimised')
      // The screen as it is: `s.shot` would bring the window to the front first, and `show()`
      // un-minimises it on Windows and macOS – the view came back up before it was checked
      // (Desktop smoke run 36239781382, all four legs).
      await s.shotAsIs('02-minimised')
      fail(flipVerdict(before, after, 'hidden'), { window: state.window, view: state.view })
      const f = await facts()
      if (f.view?.visible !== false) {
        throw new Error(
          `the tab view is not hidden to Chromium under the minimised window: ${JSON.stringify(f.view)}`
        )
      }
      return {
        ...tableRow('minimize', before, after),
        moved,
        window: f.window,
        view: f.view,
        reading: after
      }
    })

    await s.step('restore', async () => {
      if (!minimised) {
        return { skipped: 'nothing to restore: minimize() was a no-op on this display' }
      }
      const before = await read()
      const window = await move('restore')
      const after = await frontAndVisible('the page visible again with its window restored')
      await s.shot('03-restored')
      const f = await facts()
      fail(flipVerdict(before, after, 'visible'), { window: f.window, view: f.view })
      if (f.view?.inBox !== true) {
        throw new Error(
          `the tab view is not back in its box after the restore: ${JSON.stringify(f.view)}`
        )
      }
      return {
        ...tableRow('restore', before, after),
        moved: window,
        window: f.window,
        view: f.view,
        reading: after
      }
    })

    await s.step('hide', async () => {
      const before = await read()
      const window = await move('hide')
      if (window.visible)
        throw new Error(`the window is still visible after hide(): ${JSON.stringify(window)}`)
      const after = await readUntil('hidden', 8000, 'the page hidden with its window hidden')
      const f = await facts()
      fail(flipVerdict(before, after, 'hidden'), { window: f.window, view: f.view })
      if (f.view?.visible !== false) {
        throw new Error(
          `the tab view is not hidden to Chromium under the hidden window: ${JSON.stringify(f.view)}`
        )
      }
      return { ...tableRow('hide', before, after), window: f.window, view: f.view, reading: after }
    })

    await s.step('show', async () => {
      const before = await read()
      const window = await move('show')
      const after = await frontAndVisible('the page visible again with its window shown')
      await s.shot('04-shown')
      const f = await facts()
      fail(flipVerdict(before, after, 'visible'), { window: f.window, view: f.view })
      if (f.view?.inBox !== true) {
        throw new Error(
          `the tab view is not back in its box after the show: ${JSON.stringify(f.view)}`
        )
      }
      return {
        ...tableRow('show', before, after),
        moved: window,
        window: f.window,
        view: f.view,
        reading: after
      }
    })

    await s.step('blur-partial-cover', async () => {
      // A window over a quarter of the main window takes the focus: the page is still on screen
      // and stays `visible` – a blur is not hidden – with no event at all.
      const before = await read()
      const { window } = await facts()
      const shown = await cover('partial', partialCoverBounds(window.bounds))
      const blurred = await waitFor(
        async () => {
          const f = await facts()
          return f.window && !f.window.focused ? f.window : null
        },
        3000,
        'the main window blurred under the partial cover'
      ).catch(() => null)
      await delay(1500)
      const under = await read()
      await s.shotAsIs('05-partial-cover')
      fail(steadyVerdict(before, under, 'visible'), { cover: shown, blurred })
      await uncover('partial')
      const after = await frontAndVisible('the page visible with the partial cover gone')
      fail(steadyVerdict(before, after, 'visible'), { cover: shown })
      return {
        ...tableRow('blur-partial-cover', before, under),
        cover: shown,
        mainBlurred: Boolean(blurred),
        afterUncover: tableRow('uncover-partial', under, after),
        reading: after
      }
    })

    await s.step('blur-full-cover', async () => {
      // A window over the whole of the main window: where Chromium tracks occlusion natively
      // (Windows, macOS) and this machine reports it – the bare window of `native-forwarding`
      // read `hidden` under its full cover – the page reads `hidden` and `visible` again once the
      // cover is gone, one event each way. Elsewhere the reading is recorded: on Linux the X
      // server's word (Xvfb reports the window fully obscured, a compositing desktop does not);
      // on a display that reports no occlusion to any window (the macOS arm64 runner) the page
      // stays `visible`. On every leg the count of events is exactly the flips that happened.
      const judged = occlusionJudged(platform, nativeCoverFull)
      if (tracked && !judged) {
        log(
          `${VISIBILITY_SCENARIO}: this display reported no occlusion to the bare window either (native cover-full read ${nativeCoverFull}): the full cover is recorded, not judged`
        )
      }
      const before = await read()
      const { window } = await facts()
      const shown = await cover('full', fullCoverBounds(window.bounds))
      const under = await readUntil(
        'hidden',
        judged ? 8000 : 4000,
        'the page hidden under the full cover'
      )
      await s.shotAsIs('06-full-cover')
      const wentHidden = under?.state === 'hidden'
      if (judged) fail(flipVerdict(before, under, 'hidden'), { cover: shown })
      else if (wentHidden) fail(flipVerdict(before, under, 'hidden'), { cover: shown })
      else fail(steadyVerdict(before, under, 'visible'), { cover: shown })
      await uncover('full')
      const after = await frontAndVisible('the page visible with the full cover gone')
      fail(
        wentHidden ? flipVerdict(under, after, 'visible') : steadyVerdict(under, after, 'visible'),
        { cover: shown }
      )
      return {
        ...tableRow('blur-full-cover', before, under),
        judged,
        occlusionTracked: tracked,
        nativeCoverFull,
        cover: shown,
        afterUncover: tableRow('uncover-full', under, after),
        reading: after
      }
    })

    await s.step('parked-under-cover', async () => {
      // The Web capture overlay over the page parks its view (W6-F5): shown, one pixel in a
      // window corner, the page `visible`. The window hidden takes the parked view down for real
      // and the page reads `hidden`; shown again, the view is parked again and the page reads
      // `visible`; Escape closes the overlay and the view is back in its box.
      const before = await read()
      await invoke('urlbar.runCommand', { action: 'capture.start' })
      const overlay = s.chrome.locator(CAPTURE_OVERLAY).first()
      await overlay.waitFor({ state: 'visible', timeout: 8000 })
      const parked = await waitFor(
        async () => {
          const f = await facts()
          return f.view?.parked ? f : null
        },
        8000,
        "the page's view parked in a window corner under the overlay"
      )
      await delay(400)
      const underCover = await read()
      fail(steadyVerdict(before, underCover, 'visible'), { view: parked.view })
      await s.shot('07-parked')
      await move('hide')
      const hidden = await readUntil(
        'hidden',
        8000,
        'the parked page hidden with its window hidden'
      )
      const down = await facts()
      fail(flipVerdict(underCover, hidden, 'hidden'), { view: down.view })
      if (down.view?.visible !== false || down.view?.parked) {
        throw new Error(
          `the parked view is not hidden for real under the hidden window: ${JSON.stringify(down.view)}`
        )
      }
      if (!down.view?.bounds || parkedInCorner(down.view.bounds, down.content)) {
        throw new Error(`the hidden view keeps its parked box: ${JSON.stringify(down.view)}`)
      }
      await move('show')
      const back = await frontAndVisible('the parked page visible again with its window shown')
      const reparked = await waitFor(
        async () => {
          const f = await facts()
          return f.view?.parked ? f : null
        },
        5000,
        'the view parked again with the window back'
      )
      fail(flipVerdict(hidden, back, 'visible'), { view: reparked.view })
      const overlayUp = await overlay.count()
      if (!overlayUp) throw new Error('the Web capture overlay went with the window hidden')
      await s.shot('08-reparked')
      // The overlay closed: the view back in its box, the page still `visible`.
      await s.press('Escape')
      await overlay.waitFor({ state: 'hidden', timeout: 5000 }).catch(async () => {
        await s.chrome.keyboard.press('Escape')
        await overlay.waitFor({ state: 'hidden', timeout: 5000 })
      })
      const inBox = await waitFor(
        async () => {
          const f = await facts()
          return f.view?.inBox === true ? f : null
        },
        8000,
        "the page's view back in its box with the overlay closed"
      )
      await delay(400)
      const after = await read()
      fail(steadyVerdict(back, after, 'visible'), { view: inBox.view })
      return {
        parked: parked.view,
        underCover: tableRow('park', before, underCover),
        hidden: tableRow('hide (parked)', underCover, hidden),
        hiddenView: down.view,
        shown: tableRow('show (parked)', hidden, back),
        reparkedView: reparked.view,
        closed: tableRow('overlay closed', back, after),
        reading: after
      }
    })

    await s.step('quit', async () => s.quitGracefully())
  })
}

/**
 * The throwaway page's reading once it says `state` (the reader answers null while the page
 * cannot), or its last reading when it never does within `timeoutMs`; a moment is left after
 * the state for the second event a flicker would bring.
 */
async function readUntilNative(read, state, timeoutMs, waitFor, delay) {
  let last = null
  await waitFor(
    async () => {
      last = await read()
      return last && last.state === state ? last : null
    },
    timeoutMs,
    `the throwaway page ${state}`
  ).catch(() => undefined)
  await delay(400)
  return (await read()) ?? last
}
