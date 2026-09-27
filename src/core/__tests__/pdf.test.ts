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
import type { PdfPrintJob } from '../platform'
import { isPdfDownload, opensInViewer, pdfSaveName, printsSavedCopy } from '../pdf'
import {
  pdfCommandScript,
  pdfSaveScript,
  type PdfViewerReport
} from '../../shared/pdfViewerProtocol'

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
  /** Files the host was asked to write (`saveFile`). */
  written: { name: string; mimeType: string; data: string }[]
  /** Print jobs the host took (`printPdf`). */
  printed: PdfPrintJob[]
}

/** The base64 the viewer's save script answers with by default: the bytes of `%PDF-1`. */
const SAVED_COPY = 'JVBERi0x'

function fixture(
  opts: {
    viewer?: boolean
    shareHost?: boolean
    windows?: boolean
    document?: boolean
    /** Whether the host writes files (`saveFile`); true unless said, as Android's does. */
    saveFile?: boolean
    /** Where a written file lands, or null for a write that failed. */
    writtenPath?: string | null
    /** Whether the host prints PDFs (`printPdf`); absent unless asked. */
    printHost?: boolean
    /** What the viewer's save script answers: base64, or null for no copy. */
    savedCopy?: string | null
  } = {}
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
    opened: [],
    written: [],
    printed: []
  }
  const savedCopy = opts.savedCopy === undefined ? SAVED_COPY : opts.savedCopy
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
        }),
    ...(opts.saveFile === false
      ? { saveFile: undefined }
      : {
          saveFile: async (file) => {
            f.written.push(file)
            return opts.writtenPath === undefined
              ? `/sdcard/Download/${file.name}`
              : opts.writtenPath
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
            // The viewer's save answers with the copy's bytes; every other script is taken.
            return code === pdfSaveScript() ? savedCopy : true
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
    readabilitySource: () => null,
    ...(opts.printHost
      ? {
          printPdf: async (job: PdfPrintJob) => {
            f.printed.push(job)
            return true
          }
        }
      : {})
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
      outline: [{ title: 'Summary', page: 2, children: [] }],
      form: { fields: 0, modified: false }
    }
    // Only with the document's token: the viewer's document runs under the PDF's own origin,
    // which a web page could share, so a report without it, or with another, is no one's.
    f.browser.handlePageMessage(tab.id, { type: 'pdf', pdf: report })
    f.browser.handlePageMessage(tab.id, { type: 'pdf', pdf: report, pdfToken: 'not-the-token' })
    expect(f.browser.pdf.report(tab.id)).toBeNull()
    const pdfToken = f.browser.pdf.document(item.id)!.token
    f.browser.handlePageMessage(tab.id, { type: 'pdf', pdf: report, pdfToken })
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

/** A report of a document whose form stands as `modified` says. */
function formReport(modified: boolean): PdfViewerReport {
  return {
    state: 'ready',
    pageCount: 1,
    page: 1,
    zoom: 1,
    fit: 'width',
    title: null,
    find: null,
    outline: [],
    form: { fields: 7, modified }
  }
}

/** Open a PDF in the viewer and have its document report the form's state. */
async function openForm(f: Fixture, modified: boolean): Promise<{ tab: Tab; itemId: string }> {
  const tab = openSite(f, 'https://example.test/')
  const item = f.browser.downloads.begin(PDF_INIT(tab.id, { filename: 'mooring.pdf' }))
  await completeDownload(f, item.id)
  f.browser.downloads.item(item.id)!.savePath = '/sdcard/Download/mooring.pdf'
  const pdfToken = f.browser.pdf.document(item.id)!.token
  f.browser.handlePageMessage(tab.id, { type: 'pdf', pdf: formReport(modified), pdfToken })
  return { tab, itemId: item.id }
}

describe('a form in the document', () => {
  it('names the saved copy after the file, with .pdf put on where it is missing', () => {
    expect(pdfSaveName('mooring.pdf')).toBe('mooring.pdf')
    expect(pdfSaveName('Mooring.PDF')).toBe('Mooring.PDF')
    expect(pdfSaveName('download')).toBe('download.pdf')
    expect(pdfSaveName('  ')).toBe('document.pdf')
  })

  it('prints the edited copy only once the viewer reports the form modified', () => {
    expect(printsSavedCopy(null)).toBe(false)
    expect(printsSavedCopy(formReport(false))).toBe(false)
    expect(printsSavedCopy(formReport(true))).toBe(true)
  })

  it('Save writes the copy the viewer made into Downloads, lists it, and tells the viewer', async () => {
    const f = fixture({ writtenPath: '/sdcard/Download/mooring (1).pdf' })
    const { tab } = await openForm(f, true)
    const before = f.browser.downloads.items.length
    // The answer is where the copy went, for the chrome's "Saved to <folder>".
    expect(await f.browser.handleCommand(f.win, 'pdf.save', { tabId: tab.id })).toBe(
      '/sdcard/Download/mooring (1).pdf'
    )
    // The viewer's bytes, under the file's own name; the host kept the original and numbered the copy.
    expect(f.written).toEqual([
      { name: 'mooring.pdf', mimeType: 'application/pdf', data: SAVED_COPY }
    ])
    const copy = f.browser.downloads.items[0]
    expect(f.browser.downloads.items).toHaveLength(before + 1)
    expect(copy).toMatchObject({
      filename: 'mooring (1).pdf',
      savePath: '/sdcard/Download/mooring (1).pdf',
      mimeType: 'application/pdf',
      state: 'completed',
      containerId: 'default',
      totalBytes: 6
    })
    // The save script ran, and the viewer heard the copy was written – in that order.
    const codes = f.scripts.filter((s) => s.tabId === tab.id).map((s) => s.code)
    expect(codes.indexOf(pdfSaveScript())).toBeGreaterThanOrEqual(0)
    expect(codes.at(-1)).toBe(pdfCommandScript({ kind: 'saved' }))
  })

  it('Save says no – and leaves the form modified – without a copy, a writer, or a written file', async () => {
    const noCopy = fixture({ savedCopy: null })
    const a = await openForm(noCopy, true)
    expect(await noCopy.browser.pdf.save(a.tab.id)).toBeNull()
    expect(noCopy.written).toEqual([])
    const noWriter = fixture({ saveFile: false })
    const b = await openForm(noWriter, true)
    expect(await noWriter.browser.pdf.save(b.tab.id)).toBeNull()
    // The viewer is not asked for a copy no one could write.
    expect(noWriter.scripts.some((s) => s.code === pdfSaveScript())).toBe(false)
    const failed = fixture({ writtenPath: null })
    const c = await openForm(failed, true)
    const before = failed.browser.downloads.items.length
    expect(await failed.browser.pdf.save(c.tab.id)).toBeNull()
    expect(failed.browser.downloads.items).toHaveLength(before)
    expect(failed.scripts.some((s) => s.code === pdfCommandScript({ kind: 'saved' }))).toBe(false)
    // A tab that shows no viewer has nothing to save.
    const other = openSite(failed, 'https://example.test/other')
    expect(await failed.browser.pdf.save(other.id)).toBeNull()
  })

  it('Print hands the host the file as downloaded, or the filled copy once the form was touched', async () => {
    const f = fixture({ printHost: true })
    const { tab } = await openForm(f, false)
    expect(await f.browser.handleCommand(f.win, 'pdf.print', { tabId: tab.id })).toBe(true)
    expect(f.printed).toEqual([
      { tabId: tab.id, name: 'mooring.pdf', path: '/sdcard/Download/mooring.pdf', data: null }
    ])
    // Untouched: the viewer was not asked for a copy.
    expect(f.scripts.some((s) => s.code === pdfSaveScript())).toBe(false)
    const pdfToken = f.browser.pdf.document(f.browser.pdf.itemOf(tab.id)!.id)!.token
    f.browser.handlePageMessage(tab.id, { type: 'pdf', pdf: formReport(true), pdfToken })
    expect(await f.browser.pdf.print(tab.id)).toBe(true)
    expect(f.printed.at(-1)).toEqual({
      tabId: tab.id,
      name: 'mooring.pdf',
      path: null,
      data: SAVED_COPY
    })
    // Printing is not saving: the viewer's form stays modified for Save.
    expect(f.scripts.some((s) => s.code === pdfCommandScript({ kind: 'saved' }))).toBe(false)
  })

  it('Print says no without a print host, without a copy of an edited form, and off the viewer', async () => {
    const noHost = fixture()
    const a = await openForm(noHost, false)
    expect(await noHost.browser.pdf.print(a.tab.id)).toBe(false)
    // An edited form with no copy to give prints nothing: the file would show the form as it was.
    const noCopy = fixture({ printHost: true, savedCopy: null })
    const b = await openForm(noCopy, true)
    expect(await noCopy.browser.pdf.print(b.tab.id)).toBe(false)
    expect(noCopy.printed).toEqual([])
    const other = openSite(noCopy, 'https://example.test/other')
    expect(await noCopy.browser.pdf.print(other.id)).toBe(false)
  })
})
