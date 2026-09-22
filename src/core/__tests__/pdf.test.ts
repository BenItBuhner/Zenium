import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type {
  DownloadHost,
  Platform,
  ShellHost,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import type { DownloadInit } from '../downloads'
import { isPdfDownload, opensInViewer } from '../pdf'
import { pdfCommandScript, type PdfViewerReport } from '../../shared/pdfViewerProtocol'

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  sent: { name: string; payload: unknown }[]
  /** Every `loadURL` a page view took, by tab. */
  loads: { tabId: string; url: string }[]
  /** Scripts run in page views. */
  scripts: { tabId: string; code: string }[]
  openedWith: string[]
  shared: string[]
  opened: string[]
}

function fixture(
  opts: { viewer?: boolean; shareHost?: boolean; windows?: boolean; document?: boolean } = {}
): Fixture {
  const sent: Fixture['sent'] = []
  const loads: Fixture['loads'] = []
  const scripts: Fixture['scripts'] = []
  const f: Fixture = {
    browser: undefined as unknown as Browser,
    win: undefined as unknown as ZenWindow,
    sent,
    loads,
    scripts,
    openedWith: [],
    shared: [],
    opened: []
  }
  const capabilities = stub<HostCapabilities>({
    windows: opts.windows ?? true,
    updates: false,
    agents: false,
    pageTabs: true,
    pdfViewer: opts.viewer ?? true,
    printPreview: false,
    print: true
  })
  const downloads = stub<DownloadHost>({
    release: async (item) => ({ savePath: item.savePath, finalName: item.finalName }),
    open: async (item) => {
      f.opened.push(item.id)
    },
    // The stub answers any key with a no-op, so a host without the file variants says so.
    ...(opts.shareHost === false
      ? { openWith: undefined, share: undefined }
      : {
          openWith: async (item) => {
            f.openedWith.push(item.id)
          },
          share: async (item) => {
            f.shared.push(item.id)
          }
        })
  })
  const platform: Platform = {
    info: { os: 'android' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 412, height: 915 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          }
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => {
        let url = tab.url
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          hasDocument: () => opts.document ?? true,
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
            loads.push({ tabId: tab.id, url: u })
          },
          executeJavaScript: async (code: string) => {
            scripts.push({ tabId: tab.id, code })
            return true
          }
        })
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub<ShellHost>({
      share: async (payload) => {
        f.shared.push(`url:${payload.url ?? ''}`)
      }
    }),
    net: stub(),
    downloads,
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  f.browser = browser
  f.win = browser.focusedWindow()
  return f
}

function openSite(f: Fixture, url: string): Tab {
  return f.browser.tabs.createTab({ url, active: true }, f.win)
}

const PDF_INIT = (tabId: string | null, extra: Partial<DownloadInit> = {}): DownloadInit => ({
  url: 'https://example.test/report.pdf',
  filename: 'report.pdf',
  totalBytes: 1000,
  mimeType: 'application/pdf',
  sourceTabId: tabId,
  navigation: true,
  disposition: null,
  containerId: 'default',
  ...extra
})

/** Run the transfer to completion the way the host does: progress, then `finish`, then the release. */
async function completeDownload(f: Fixture, id: string): Promise<void> {
  f.browser.downloads.progress(id, {
    state: 'progressing',
    receivedBytes: 1000,
    savePath: '/sdcard/Download/report.pdf.zeniumdownload'
  })
  f.browser.downloads.finish(id, 'completed', { savePath: '/sdcard/Download/report.pdf' })
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('what counts as a PDF for the viewer', () => {
  it('goes by the type, else by the name of a typeless response', () => {
    expect(isPdfDownload('application/pdf', 'x.bin')).toBe(true)
    expect(isPdfDownload('Application/PDF; charset=binary', 'x')).toBe(true)
    expect(isPdfDownload('application/x-pdf', 'x')).toBe(true)
    expect(isPdfDownload('application/octet-stream', 'paper.PDF')).toBe(true)
    expect(isPdfDownload('', 'paper.pdf')).toBe(true)
    expect(isPdfDownload('application/octet-stream', 'paper.zip')).toBe(false)
    expect(isPdfDownload('text/html', 'paper.pdf')).toBe(false)
  })

  it('opens a navigation’s PDF in the viewer, never a download link, an attachment or a host without one', () => {
    expect(opensInViewer(PDF_INIT('tab_1'), true)).toBe(true)
    expect(opensInViewer(PDF_INIT('tab_1', { disposition: 'inline' }), true)).toBe(true)
    expect(opensInViewer(PDF_INIT('tab_1', { disposition: 'attachment' }), true)).toBe(false)
    expect(opensInViewer(PDF_INIT('tab_1', { navigation: false }), true)).toBe(false)
    expect(opensInViewer(PDF_INIT(null), true)).toBe(false)
    expect(
      opensInViewer(PDF_INIT('tab_1', { mimeType: 'application/zip', filename: 'a.zip' }), true)
    ).toBe(false)
    expect(opensInViewer(PDF_INIT('tab_1'), false)).toBe(false)
  })
})

describe('a PDF the tab navigates to', () => {
  it('downloads like any file and, complete, opens in the viewer page in the same tab', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/')
    const item = f.browser.downloads.begin(PDF_INIT(tab.id))
    // Still a download while it runs: the row is in the list, the tab is where it was.
    expect(f.browser.downloads.items.map((d) => d.id)).toContain(item.id)
    expect(f.loads.filter((l) => l.url.startsWith('zen://pdf'))).toHaveLength(0)
    await completeDownload(f, item.id)
    expect(f.loads.at(-1)).toEqual({ tabId: tab.id, url: `zen://pdf?id=${item.id}` })
    expect(f.browser.tabs.tab(tab.id)?.url).toBe(`zen://pdf?id=${item.id}`)
    // The page resolves to the file the download left, under its final name, with the document's
    // own address (what its document runs under) and a token of its own that holds across lookups.
    const doc = f.browser.pdf.document(item.id)
    expect(doc).toEqual({
      id: item.id,
      name: 'report.pdf',
      path: '/sdcard/Download/report.pdf',
      url: 'https://example.test/report.pdf',
      token: expect.any(String)
    })
    expect(doc?.token).not.toBe('')
    expect(f.browser.pdf.document(item.id)?.token).toBe(doc?.token)
    // What the tab stands for outside the chrome: the PDF's URL, as Chrome's PDF tab reads.
    expect(f.browser.pdf.documentUrl(`zen://pdf?id=${item.id}`)).toBe(
      'https://example.test/report.pdf'
    )
    expect(f.browser.pdf.documentUrl('zen://pdf?id=dl_nothing')).toBeNull()
    expect(f.browser.pdf.documentUrl('https://example.test/')).toBeNull()
  })

  it('reads as its own viewer address when the PDF has no http(s) URL to run under', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/')
    const item = f.browser.downloads.begin(
      PDF_INIT(tab.id, { url: 'blob:https://example.test/0b1c', filename: 'generated.pdf' })
    )
    await completeDownload(f, item.id)
    // The document runs on the viewer's origin (`pdfViewerBaseUrl`), so the tab stands for no
    // web address: extensions read it as the viewer page.
    expect(f.browser.pdf.document(item.id)?.url).toBe('blob:https://example.test/0b1c')
    expect(f.browser.pdf.documentUrl(`zen://pdf?id=${item.id}`)).toBeNull()
  })

  it('opens in a new tab when the tab that asked for it closed meanwhile', async () => {
    const f = fixture()
    const keep = openSite(f, 'https://example.test/keep')
    const tab = openSite(f, 'https://example.test/')
    const item = f.browser.downloads.begin(PDF_INIT(tab.id))
    f.browser.tabs.closeTab(tab.id, true, f.win)
    await completeDownload(f, item.id)
    const viewerTab = Object.values(f.browser.tabs.model.tabs).find(
      (t) => t.url === `zen://pdf?id=${item.id}`
    )
    expect(viewerTab).toBeDefined()
    expect(viewerTab?.id).not.toBe(keep.id)
  })

  it('stays a plain download for an attachment, a download link and on a host without the viewer', async () => {
    for (const [f, init] of [
      [fixture(), { disposition: 'attachment' as const }],
      [fixture(), { navigation: false }],
      [fixture({ viewer: false }), {}]
    ] as const) {
      const tab = openSite(f, 'https://example.test/')
      const item = f.browser.downloads.begin(PDF_INIT(tab.id, init))
      await completeDownload(f, item.id)
      expect(f.loads.some((l) => l.url.startsWith('zen://pdf'))).toBe(false)
      expect(f.browser.downloads.item(item.id)?.state).toBe('completed')
    }
  })

  it('does not open a file that ended cancelled or interrupted', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/')
    const item = f.browser.downloads.begin(PDF_INIT(tab.id))
    f.browser.downloads.finish(item.id, 'interrupted')
    await new Promise((r) => setTimeout(r, 0))
    expect(f.loads.some((l) => l.url.startsWith('zen://pdf'))).toBe(false)
  })

  it('keeps the tab it is bound for and brings no Downloads sheet over it while it transfers', async () => {
    // A single-window host (Android) whose tab was opened for the PDF alone: no document, no
    // history. For any other download the host closes such a tab and shows its panel – the
    // phone's Downloads sheet (the chrome reports its layout on boot; a tablet's Downloads is a
    // page tab and gets no surface over the page).
    const f = fixture({ windows: false, document: false })
    f.browser.handleCommand(f.win, 'window.formFactor', { formFactor: 'phone' })
    const tab = openSite(f, 'https://example.test/report.pdf')
    const item = f.browser.downloads.begin(PDF_INIT(tab.id))
    f.browser.onDownloadStarted(tab.id)
    await new Promise((r) => setTimeout(r, 250))
    expect(f.browser.tabs.tab(tab.id)).toBeDefined()
    expect(f.sent.some((s) => s.name === 'overlay.open')).toBe(false)
    await completeDownload(f, item.id)
    expect(f.browser.tabs.tab(tab.id)?.url).toBe(`zen://pdf?id=${item.id}`)
    expect(f.browser.pdf.expects(tab.id)).toBe(false)

    const plain = openSite(f, 'https://example.test/archive.zip')
    f.browser.downloads.begin(
      PDF_INIT(plain.id, {
        url: 'https://example.test/archive.zip',
        filename: 'archive.zip',
        mimeType: 'application/zip'
      })
    )
    f.browser.onDownloadStarted(plain.id)
    await new Promise((r) => setTimeout(r, 250))
    expect(f.browser.tabs.tab(plain.id)).toBeUndefined()
    // The sheet is revealed for the download, not asked for again: one already up stays up
    // (the chrome toggles only a user's repeat request), the new row on top.
    const opened = f.sent.filter((s) => s.name === 'overlay.open')
    expect(opened).toHaveLength(1)
    expect(opened[0].payload).toMatchObject({ kind: 'downloads', reveal: true })
  })
})

describe('the viewer page', () => {
  it('resolves to nothing once the download is gone from the list or its file is missing', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/')
    const item = f.browser.downloads.begin(PDF_INIT(tab.id))
    await completeDownload(f, item.id)
    expect(f.browser.pdf.document(item.id)).not.toBeNull()
    f.browser.downloads.item(item.id)!.fileMissing = true
    expect(f.browser.pdf.document(item.id)).toBeNull()
    expect(f.browser.pdf.documentUrl(`zen://pdf?id=${item.id}`)).toBeNull()
    expect(f.browser.pdf.document('dl_nothing')).toBeNull()
  })

  it('"Open with" hands the file to the system chooser and Share to the share sheet', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/')
    const item = f.browser.downloads.begin(PDF_INIT(tab.id))
    await completeDownload(f, item.id)
    await f.browser.handleCommand(f.win, 'pdf.openWith', { tabId: tab.id })
    await f.browser.handleCommand(f.win, 'pdf.share', { tabId: tab.id })
    expect(f.openedWith).toEqual([item.id])
    expect(f.shared).toEqual([item.id])
    // A tab that shows no viewer has nothing to open.
    const other = openSite(f, 'https://example.test/other')
    await f.browser.handleCommand(f.win, 'pdf.openWith', { tabId: other.id })
    expect(f.openedWith).toEqual([item.id])
  })

  it('falls back to the plain open and to sharing the address on a host without the file variants', async () => {
    const f = fixture({ shareHost: false })
    const tab = openSite(f, 'https://example.test/')
    const item = f.browser.downloads.begin(PDF_INIT(tab.id))
    await completeDownload(f, item.id)
    await f.browser.pdf.openWith(tab.id)
    await f.browser.pdf.share(tab.id)
    expect(f.opened).toEqual([item.id])
    expect(f.shared).toEqual(['url:https://example.test/report.pdf'])
  })

  it('keeps the document’s report for the chrome and relays its commands to the page', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/')
    const item = f.browser.downloads.begin(PDF_INIT(tab.id))
    await completeDownload(f, item.id)
    const report: PdfViewerReport = {
      state: 'ready',
      pageCount: 12,
      page: 3,
      zoom: 1.25,
      fit: null,
      title: 'Quarterly report',
      find: null,
      outline: [{ title: 'Summary', page: 2, children: [] }]
    }
    // Only with the document's token: the viewer's document runs under the PDF's own origin,
    // which a web page could share, so a report without it, or with another, is no one's.
    f.browser.handlePageMessage(tab.id, { type: 'pdf', pdf: report })
    f.browser.handlePageMessage(tab.id, { type: 'pdf', pdf: report, token: 'not-the-token' })
    expect(f.browser.pdf.report(tab.id)).toBeNull()
    const token = f.browser.pdf.document(item.id)!.token
    f.browser.handlePageMessage(tab.id, { type: 'pdf', pdf: report, token })
    expect(f.browser.pdf.report(tab.id)).toEqual(report)
    expect(await f.browser.handleCommand(f.win, 'pdf.state', { tabId: tab.id })).toEqual(report)
    expect(f.sent.find((s) => s.name === 'pdf.changed')?.payload).toEqual({ tabId: tab.id, report })
    const taken = await f.browser.handleCommand(f.win, 'pdf.command', {
      tabId: tab.id,
      command: { kind: 'goTo', page: 5 }
    })
    expect(taken).toBe(true)
    expect(f.scripts.at(-1)?.code).toBe(pdfCommandScript({ kind: 'goTo', page: 5 }))
    // Leaving the viewer forgets the report (the tabs service says so as the navigation
    // commits); a tab without one takes no command.
    f.browser.tabs.navigate(tab.id, 'https://example.test/elsewhere', { transition: 'typed' })
    f.browser.pdf.onNavigated(tab.id)
    expect(f.browser.pdf.report(tab.id)).toBeNull()
    expect(await f.browser.pdf.command(tab.id, { kind: 'rotate' })).toBe(false)
  })
})
