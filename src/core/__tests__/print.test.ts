import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type { Platform, PrintingHost, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { PdfRenderOptions, PrinterDescription, PrintJobOptions } from '../../shared/print'
import { defaultPrintSettings, type PrintSettings } from '../../shared/print'
import { base64Decode } from '../extensions/bytes'

function memoryIo(): StoreIO & { files: Record<string, string> } {
  const files: Record<string, string> = {}
  return {
    files,
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

const LASER: PrinterDescription = {
  name: 'Laser_1',
  displayName: 'Office laser',
  description: '',
  isDefault: true,
  duplex: true
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  sent: { name: string; payload: unknown }[]
  /** `printToPDF` calls, with the options given. */
  renders: PdfRenderOptions[]
  /** `PrintingHost.print` calls: the document handed over and the job. */
  jobs: { document: Uint8Array; job: PrintJobOptions }[]
  /** Plain `print()` calls (the system dialog). */
  systemPrints: number
  saved: { bytes: Uint8Array; defaultName: string }[]
  io: ReturnType<typeof memoryIo>
}

function fixture(
  opts: {
    preview?: boolean
    printers?: PrinterDescription[]
    /** What the save dialog answers: a path, or null for a dismissal. */
    savePath?: string | null
    printFails?: string
    io?: ReturnType<typeof memoryIo>
  } = {}
): Fixture {
  const sent: Fixture['sent'] = []
  const renders: PdfRenderOptions[] = []
  const jobs: Fixture['jobs'] = []
  const saved: Fixture['saved'] = []
  const io = opts.io ?? memoryIo()
  const preview = opts.preview ?? true
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    pageTabs: false,
    printPreview: preview,
    print: true
  })
  const printing: PrintingHost = {
    printers: async () => opts.printers ?? [LASER],
    print: async (document, job) => {
      jobs.push({ document, job })
      if (opts.printFails) throw new Error(opts.printFails)
    },
    savePdf: async (bytes, { defaultName }) => {
      saved.push({ bytes, defaultName })
      return opts.savePath === undefined ? '/home/u/Downloads/out.pdf' : opts.savePath
    }
  }
  const f: Fixture = {
    browser: undefined as unknown as Browser,
    win: undefined as unknown as ZenWindow,
    sent,
    renders,
    jobs,
    systemPrints: 0,
    saved,
    io
  }
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
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
          hasDocument: () => true,
          getURL: () => url,
          getTitle: () => 'Quarterly report – Example',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
          },
          print: () => {
            f.systemPrints += 1
          },
          printToPDF: async (options: PdfRenderOptions) => {
            renders.push(options)
            return new Uint8Array([0x25, 0x50, 0x44, 0x46, renders.length])
          }
        })
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null,
    ...(preview ? { printing } : {})
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

function command<T>(f: Fixture, name: string, args: unknown): Promise<T> {
  return Promise.resolve(f.browser.handleCommand(f.win, name, args) as T | Promise<T>)
}

describe('opening the print preview', () => {
  it('opens the print overlay for the tab on a host with the preview', () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    f.browser.actions.run('page.printPreview', { sourceTabId: tab.id, win: f.win })
    expect(f.sent.find((s) => s.name === 'overlay.open')?.payload).toEqual({
      kind: 'print',
      tabId: tab.id
    })
    expect(f.systemPrints).toBe(0)
    expect(f.browser.print.isOpen(tab.id)).toBe(true)
  })

  it('falls back to the engine’s own print flow on a host without the preview', () => {
    const f = fixture({ preview: false })
    const tab = openSite(f, 'https://example.test/report')
    f.browser.actions.run('page.printPreview', { sourceTabId: tab.id, win: f.win })
    expect(f.systemPrints).toBe(1)
    expect(f.sent.some((s) => s.name === 'overlay.open')).toBe(false)
  })

  it('leaves page.print on the system dialog', () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    f.browser.actions.run('page.print', { sourceTabId: tab.id, win: f.win })
    expect(f.systemPrints).toBe(1)
    expect(f.sent.some((s) => s.name === 'overlay.open')).toBe(false)
  })
})

describe('the session', () => {
  it('carries the page’s title and address, the printers and settings opening on the default printer', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    tab.title = 'Quarterly report'
    const session = await command<Awaited<ReturnType<Browser['print']['session']>>>(
      f,
      'print.session',
      { tabId: tab.id }
    )
    expect(session?.title).toBe('Quarterly report')
    expect(session?.url).toBe('https://example.test/report')
    expect(session?.printers).toEqual([LASER])
    expect(session?.settings.destination).toEqual({ kind: 'printer', name: 'Laser_1' })
    expect(session?.settings.pages).toEqual({ mode: 'all', custom: '' })
    expect(session?.settings.copies).toBe(1)
  })

  it('opens on Save as PDF when no printer is the default', async () => {
    const f = fixture({ printers: [{ ...LASER, isDefault: false }] })
    const tab = openSite(f, 'https://example.test/report')
    const session = await f.browser.print.session(tab.id)
    expect(session?.settings.destination).toEqual({ kind: 'pdf' })
  })

  it('is null on a host without the preview', async () => {
    const f = fixture({ preview: false })
    const tab = openSite(f, 'https://example.test/report')
    expect(await f.browser.print.session(tab.id)).toBeNull()
  })
})

describe('rendering the preview', () => {
  it('renders the page to a PDF with the settings mapped to printToPDF’s options', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    const settings: PrintSettings = {
      ...defaultPrintSettings('en-US'),
      layout: 'landscape',
      paperSize: 'a4',
      background: true,
      headerFooter: false,
      scale: { mode: 'custom', percent: 80 },
      margins: { mode: 'none', custom: defaultPrintSettings().margins.custom }
    }
    const result = await command<{ ok: boolean; pdf?: string }>(f, 'print.preview', {
      tabId: tab.id,
      settings
    })
    expect(result.ok).toBe(true)
    expect([...base64Decode(result.pdf ?? '')].slice(0, 4)).toEqual([0x25, 0x50, 0x44, 0x46])
    expect(f.renders).toHaveLength(1)
    expect(f.renders[0]).toMatchObject({
      landscape: true,
      printBackground: true,
      displayHeaderFooter: false,
      scale: 0.8,
      pageSize: { width: 8.2677, height: 11.6929 },
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      pageRanges: ''
    })
  })

  it('renders only the pages picked once the page count is known', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    const settings: PrintSettings = {
      ...defaultPrintSettings('en-US'),
      pages: { mode: 'custom', custom: '1-2, 5' }
    }
    await f.browser.print.preview(tab.id, settings, 6)
    expect(f.renders[0].pageRanges).toBe('1-2, 5')
    // Every page picked is every page: no range is passed.
    await f.browser.print.preview(tab.id, { ...settings, pages: { mode: 'odd', custom: '' } }, 1)
    expect(f.renders[1].pageRanges).toBe('')
  })

  it('reports Chrome’s "No pages selected" for a selection that picks nothing', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    const settings: PrintSettings = {
      ...defaultPrintSettings('en-US'),
      pages: { mode: 'even', custom: '' }
    }
    const result = await f.browser.print.preview(tab.id, settings, 1)
    expect(result).toEqual({ ok: false, error: 'No pages selected' })
    expect(f.renders).toHaveLength(0)
  })

  it('fails gracefully when the engine cannot render', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    const view = f.browser.tabs.view(tab.id) as TabView & { printToPDF: unknown }
    view.printToPDF = async (): Promise<Uint8Array> => {
      throw new Error('Page is gone')
    }
    const result = await f.browser.print.preview(tab.id, defaultPrintSettings('en-US'))
    expect(result).toEqual({ ok: false, error: 'Print preview failed (Page is gone)' })
  })
})

describe('printing', () => {
  it('renders the pages picked to a PDF and hands it to the printer with the printer’s options', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    tab.title = 'Quarterly report'
    const settings: PrintSettings = {
      ...defaultPrintSettings('en-US'),
      destination: { kind: 'printer', name: 'Laser_1' },
      pages: { mode: 'custom', custom: '2-3' },
      copies: 2,
      color: 'bw',
      layout: 'landscape',
      twoSided: true,
      duplexEdge: 'shortEdge',
      margins: { mode: 'minimum', custom: defaultPrintSettings().margins.custom }
    }
    const result = await command<unknown>(f, 'print.run', {
      tabId: tab.id,
      settings,
      pageCount: 4
    })
    expect(result).toEqual({ ok: true, action: 'printed' })
    // The layout is the render's: Chrome prints the preview's PDF, so the printer cannot lay the
    // page out again (and Electron's silent print would drop the pages picked).
    expect(f.renders).toHaveLength(1)
    expect(f.renders[0]).toMatchObject({
      landscape: true,
      pageRanges: '2-3',
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      displayHeaderFooter: true
    })
    expect(f.jobs).toHaveLength(1)
    expect(f.jobs[0].document).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1]))
    expect(f.jobs[0].job).toEqual({
      deviceName: 'Laser_1',
      copies: 2,
      collate: true,
      duplexMode: 'shortEdge',
      color: false,
      landscape: true,
      pageSize: { width: 215900, height: 279400 }
    })
    expect(f.browser.print.isOpen(tab.id)).toBe(false)
  })

  it('prints the render the preview shows when the settings have not moved, without rendering again', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    const settings: PrintSettings = {
      ...defaultPrintSettings('en-US'),
      destination: { kind: 'printer', name: 'Laser_1' }
    }
    const preview = await f.browser.print.preview(tab.id, settings, null)
    expect(preview.ok).toBe(true)
    expect(f.renders).toHaveLength(1)
    const result = await f.browser.print.run(tab.id, settings, 3, f.win)
    expect(result).toEqual({ ok: true, action: 'printed' })
    expect(f.renders).toHaveLength(1)
    expect(f.jobs[0].document).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1]))
    // What the printer owns (copies, two-sided) leaves the render alone; a change to the layout
    // renders afresh, so the printer gets what the preview would show for it.
    const tab2 = openSite(f, 'https://example.test/other')
    await f.browser.print.preview(tab2.id, settings, null)
    await f.browser.print.run(tab2.id, { ...settings, copies: 2, twoSided: true }, 3, f.win)
    expect(f.renders).toHaveLength(2)
    expect(f.jobs[1].document).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 2]))
    const tab3 = openSite(f, 'https://example.test/third')
    await f.browser.print.preview(tab3.id, settings, null)
    await f.browser.print.run(tab3.id, { ...settings, layout: 'landscape' }, 3, f.win)
    expect(f.renders).toHaveLength(4)
    expect(f.renders[3].landscape).toBe(true)
    expect(f.jobs[2].document).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 4]))
  })

  it('reports the engine’s failure in Chrome’s words', async () => {
    const f = fixture({ printFails: 'Printer offline' })
    const tab = openSite(f, 'https://example.test/report')
    const settings: PrintSettings = {
      ...defaultPrintSettings('en-US'),
      destination: { kind: 'printer', name: 'Laser_1' }
    }
    const result = await f.browser.print.run(tab.id, settings, 2, f.win)
    expect(result).toEqual({
      ok: false,
      error: 'Couldn’t print – check your printer and try again (Printer offline)'
    })
  })

  it('remembers the sticky settings for the next preview, pages and copies starting over', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    const settings: PrintSettings = {
      ...defaultPrintSettings('en-US'),
      destination: { kind: 'printer', name: 'Laser_1' },
      pages: { mode: 'custom', custom: '2' },
      copies: 3,
      layout: 'landscape',
      color: 'bw',
      twoSided: true,
      background: true
    }
    await f.browser.print.run(tab.id, settings, 4, f.win)
    const next = await f.browser.print.session(tab.id)
    expect(next?.settings).toMatchObject({
      destination: { kind: 'printer', name: 'Laser_1' },
      layout: 'landscape',
      color: 'bw',
      twoSided: true,
      background: true,
      pages: { mode: 'all', custom: '' },
      copies: 1
    })
    // Persisted: a browser started over the same profile opens with them too.
    f.browser.flushSync()
    expect(JSON.parse(f.io.files['print.json']).sticky.layout).toBe('landscape')
    const again = fixture({ io: f.io })
    const tab2 = openSite(again, 'https://example.test/other')
    expect((await again.browser.print.session(tab2.id))?.settings.layout).toBe('landscape')
  })

  it('drops two-sided when the remembered printer is gone and the fallback cannot duplex', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    await f.browser.print.run(
      tab.id,
      {
        ...defaultPrintSettings('en-US'),
        destination: { kind: 'printer', name: 'Laser_1' },
        twoSided: true
      },
      1,
      f.win
    )
    const later = fixture({
      io: f.io,
      printers: [
        { name: 'Ink', displayName: 'Ink', description: '', isDefault: true, duplex: false }
      ]
    })
    const tab2 = openSite(later, 'https://example.test/other')
    const session = await later.browser.print.session(tab2.id)
    expect(session?.settings.destination).toEqual({ kind: 'printer', name: 'Ink' })
    expect(session?.settings.twoSided).toBe(false)
  })
})

describe('Save as PDF', () => {
  it('asks where to save with the page’s title as the name, writes the render and lists it in Downloads', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    tab.title = 'Quarterly report: Q3/2026'
    const settings = defaultPrintSettings('en-US')
    const preview = await f.browser.print.preview(tab.id, settings, null)
    expect(preview.ok).toBe(true)
    const result = await f.browser.print.run(tab.id, settings, 3, f.win)
    expect(result).toEqual({ ok: true, action: 'saved', path: '/home/u/Downloads/out.pdf' })
    expect(f.saved).toHaveLength(1)
    expect(f.saved[0].defaultName).toBe('Quarterly report_ Q3_2026.pdf')
    // The render the preview showed is the file saved: no second render for the same settings.
    expect(f.renders).toHaveLength(1)
    expect([...f.saved[0].bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 1])
    const listed = f.browser.downloads.items.find((d) => d.savePath === '/home/u/Downloads/out.pdf')
    expect(listed?.mimeType).toBe('application/pdf')
    expect(listed?.state).toBe('completed')
    expect(f.browser.print.remembered?.destination).toEqual({ kind: 'pdf' })
  })

  it('renders afresh when the settings moved since the last preview', async () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    const settings = defaultPrintSettings('en-US')
    await f.browser.print.preview(tab.id, settings, null)
    await f.browser.print.run(tab.id, { ...settings, layout: 'landscape' }, 3, f.win)
    expect(f.renders).toHaveLength(2)
    expect(f.renders[1].landscape).toBe(true)
  })

  it('keeps the preview open and forgets nothing when the dialog is dismissed', async () => {
    const f = fixture({ savePath: null })
    const tab = openSite(f, 'https://example.test/report')
    const result = await f.browser.print.run(
      tab.id,
      { ...defaultPrintSettings('en-US'), layout: 'landscape' },
      3,
      f.win
    )
    expect(result).toEqual({ ok: true, action: 'cancelled' })
    expect(f.browser.print.remembered).toBeNull()
    expect(f.browser.downloads.items).toHaveLength(0)
  })
})

describe('closing', () => {
  it('ends the session on Cancel and when the tab goes', () => {
    const f = fixture()
    const tab = openSite(f, 'https://example.test/report')
    f.browser.print.open(tab.id, f.win)
    f.browser.handleCommand(f.win, 'print.close', { tabId: tab.id })
    expect(f.browser.print.isOpen(tab.id)).toBe(false)
    f.browser.print.open(tab.id, f.win)
    f.browser.tabs.closeTab(tab.id, true, f.win)
    expect(f.browser.print.isOpen(tab.id)).toBe(false)
  })
})
