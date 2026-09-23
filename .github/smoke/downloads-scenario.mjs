// The `downloads` scenario: a navigation that turns into a download, in the two shapes of
// BUG-030 / downloads-01, against the fixture server's attachment (boot-fixture.mjs
// DOWNLOAD_FIXTURE). Its own file so the harness's scenario table gains one line for it.
//
//  1. typed-into-blank-tab: a new tab (the sidebar's "+", the blank page until an address is
//     typed) is pointed at the attachment as the URL bar would point it. The download begins,
//     and the tab – which never had a document of the user's – closes instead of staying behind
//     titled with the download's host over an empty page. The file lands, complete, in the
//     folder the profile names.
//  2. alt-click-downloads-link: Alt+click on a link to the attachment downloads it from the
//     page, as in Chrome (Blink's navigation policy for an Alt-modified click; Glance is off in
//     this profile, since Zen's default gives Alt to Glance). The page keeps its tab and row;
//     the download's source is the page's own webContents. The pointer goes through X
//     (xdotool), so the step runs on Linux only and says so elsewhere.
//
// Downloads are watched from the main process (`will-download` on every session, the item's
// `done`), not from the chrome: what the core does with the tab is the thing under test.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const DOWNLOADS_SCENARIO = 'downloads'

/**
 * The profile's settings for the scenario: past onboarding; downloads straight into `dir`
 * without asking, no notification, no panel; Glance off so an Alt+click reaches the engine.
 */
export function downloadsProfileSettings(dir) {
  return {
    glanceEnabled: false,
    askWhereToSave: false,
    downloads: {
      directory: dir,
      askWhereToSave: false,
      notifyOnComplete: false,
      openPanelOnStart: false,
      openPanelOnComplete: false
    }
  }
}

/** The xdotool line for an Alt+click at device pixel (x, y): the move, Alt held around the press. */
export function altClickArgs(x, y) {
  return [
    'mousemove',
    String(x),
    String(y),
    'sleep',
    '0.25',
    'keydown',
    'alt',
    'sleep',
    '0.05',
    'mousedown',
    '1',
    'sleep',
    '0.08',
    'mouseup',
    '1',
    'sleep',
    '0.05',
    'keyup',
    'alt'
  ]
}

/**
 * Where a link's middle is on the X display: the view's screen rectangle (DIPs, from the
 * harness's `tabViewScreenRect`) plus the link's rectangle in the page, times the display's
 * scale factor for xdotool's device pixels.
 */
export function linkScreenPoint(viewRect, linkRect) {
  const scale = viewRect.scale ?? 1
  return {
    x: Math.round((viewRect.x + linkRect.left + linkRect.width / 2) * scale),
    y: Math.round((viewRect.y + linkRect.top + linkRect.height / 2) * scale)
  }
}

/** Installed in the main process once per session: every download, as it begins and ends. */
function installDownloadWatch({ app, webContents }) {
  const g = globalThis
  if (g.__smokeDownloads) return false
  const record = { items: [] }
  g.__smokeDownloads = record
  const hooked = new WeakSet()
  const hook = (ses) => {
    if (!ses || hooked.has(ses)) return
    hooked.add(ses)
    ses.on('will-download', (_event, item, source) => {
      const live = source && !source.isDestroyed()
      const entry = {
        url: item.getURL(),
        filename: item.getFilename(),
        source: live ? source.id : null,
        sourceUrl: live ? source.getURL() : null,
        state: 'started',
        savePath: null,
        receivedBytes: 0,
        at: Date.now()
      }
      record.items.push(entry)
      item.on('done', (_e, state) => {
        entry.state = state
        entry.savePath = item.getSavePath()
        entry.receivedBytes = item.getReceivedBytes()
        entry.doneAt = Date.now()
      })
    })
  }
  for (const wc of webContents.getAllWebContents()) hook(wc.session)
  app.on('web-contents-created', (_event, wc) => hook(wc.session))
  return true
}

/**
 * Runs the scenario. `h` is what the harness lends it: `freshProfile`, `runScenario`, `waitFor`,
 * `delay`, `log`, the fixture (`startBootFixture`'s result) and whether this is Linux.
 */
export async function scenarioDownloads(h) {
  const { freshProfile, runScenario, waitFor, delay, log, fixture, isLinux } = h
  const { page, file } = fixture.download
  const userData = freshProfile(`profile-${DOWNLOADS_SCENARIO}`, { onboardingDone: true })
  // The folder is under the profile, so it goes with it; named once the profile directory exists.
  const filesDir = path.join(userData, 'smoke-downloads')
  fs.mkdirSync(filesDir, { recursive: true })
  const statePath = path.join(userData, 'zen', 'state.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.settings = { ...state.settings, ...downloadsProfileSettings(filesDir) }
  fs.writeFileSync(statePath, JSON.stringify(state))

  return runScenario(DOWNLOADS_SCENARIO, userData, {}, async (s, out) => {
    out.filesDir = filesDir
    const downloads = () => s.app.evaluate(() => globalThis.__smokeDownloads?.items ?? [])
    const invoke = (name, args) =>
      s.chrome.evaluate(({ name, args }) => window.zen.invoke(name, args), { name, args })
    const finished = (match, what) =>
      waitFor(
        async () => {
          const d = (await downloads()).find(match)
          return d && d.state !== 'started' ? d : null
        },
        30000,
        what
      )
    // The item downloads under the partial suffix (`shared/downloads.ts` PARTIAL_SUFFIX) and is
    // renamed to its name once done: the final file is what is checked, once it is there.
    const onDisk = async (d) => {
      if (d.state !== 'completed') throw new Error(`the download ended ${d.state}`)
      if (!d.savePath || !d.savePath.startsWith(filesDir)) {
        throw new Error(`the file went to ${d.savePath}, not under ${filesDir}`)
      }
      const finalPath = d.savePath.replace(/\.zeniumdownload$/, '')
      const size = await waitFor(
        () => (fs.existsSync(finalPath) ? fs.statSync(finalPath).size : null),
        10000,
        `${finalPath} on disk`
      )
      if (size !== file.size) throw new Error(`${finalPath} is ${size} bytes, not ${file.size}`)
      return { savePath: finalPath, size }
    }

    await s.step('typed-into-blank-tab', async () => {
      await s.app.evaluate(installDownloadWatch)
      const rowsBefore = await s.sidebarTabCount()
      const tabId = await invoke('tab.create', { active: true })
      const blank = await waitFor(
        async () => {
          const rows = await s.sidebarTabCount()
          const view = (await s.tabs()).find((t) => /^zen:\/\/blank\/?$/.test(t.url) && !t.loading)
          return rows === rowsBefore + 1 && view ? view : null
        },
        10000,
        'the new tab: one more row, the blank page in its view'
      )
      log(`${DOWNLOADS_SCENARIO}: tab ${tabId} (webContents ${blank.id}) on ${blank.url}`)
      await invoke('tab.navigate', { tabId, input: file.url })
      const started = await waitFor(
        async () => (await downloads()).find((d) => d.url === file.url) ?? null,
        15000,
        `the download of ${file.url}`
      )
      const closed = await waitFor(
        async () => {
          const rows = await s.sidebarTabCount()
          const views = await s.tabs()
          return rows === rowsBefore && !views.some((t) => t.id === blank.id) ? { rows } : null
        },
        10000,
        `the blank tab closed: ${rowsBefore} row(s) again, webContents ${blank.id} gone`
      )
      const done = await finished((d) => d.url === file.url, 'the typed download finished')
      return {
        tabId,
        rowsBefore,
        rowsAfter: closed.rows,
        download: { ...started, ...done },
        file: await onDisk(done)
      }
    })

    await s.step('alt-click-downloads-link', async () => {
      if (!isLinux) return { skipped: 'the pointer is driven through X (xdotool): Linux only' }
      const before = (await downloads()).length
      const tabId = await invoke('tab.create', { url: page.url, active: true })
      const view = await s.waitForTab(page.url, 20000)
      const rowsBefore = await s.sidebarTabCount()
      // Let the layout settle: the view's rectangle is read from the window.
      await delay(500)
      const viewRect = await waitFor(
        () => s.tabViewScreenRect(view.id),
        8000,
        `the page view of webContents ${view.id} on screen`
      )
      const linkRect = await s.app.evaluate(
        ({ webContents }, { id, linkId }) =>
          webContents
            .fromId(id)
            .executeJavaScript(
              `(() => { const r = document.getElementById(${JSON.stringify(linkId)}).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()`
            ),
        { id: view.id, linkId: page.linkId }
      )
      const point = linkScreenPoint(viewRect, linkRect)
      const r = spawnSync('xdotool', altClickArgs(point.x, point.y), {
        encoding: 'utf8',
        timeout: 15000
      })
      if (r.status !== 0) {
        throw new Error(`xdotool exited ${r.status}: ${(r.stderr || r.stdout || '').trim()}`)
      }
      const started = await waitFor(
        async () => (await downloads()).slice(before).find((d) => d.url === file.url) ?? null,
        15000,
        `the Alt+click download of ${file.url}`
      )
      if (started.source !== view.id) {
        throw new Error(
          `the download came from webContents ${started.source} (${started.sourceUrl}), not the page's ${view.id}`
        )
      }
      // The page keeps its tab: no row went, the view is still on the page.
      await delay(500)
      const rows = await s.sidebarTabCount()
      const still = (await s.tabs()).find((t) => t.id === view.id)
      if (rows !== rowsBefore || !still || still.url !== page.url) {
        throw new Error(
          `after the Alt+click: ${rows} row(s) (${rowsBefore} before), the page's view ${still ? `on ${still.url}` : 'gone'}`
        )
      }
      const done = await finished(
        (d) => d.url === file.url && d.at >= started.at,
        'the Alt+click download finished'
      )
      await s.shot('01-alt-click-download')
      return {
        tabId,
        point,
        viewRect,
        linkRect,
        rows,
        download: { ...started, ...done },
        file: await onDisk(done)
      }
    })

    await s.step('quit', async () => s.quitGracefully())
  })
}
