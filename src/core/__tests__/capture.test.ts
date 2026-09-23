import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type {
  AgentCapture,
  AgentCaptureOptions,
  ClipboardHost,
  DownloadHost,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import { CAPTURE_MAX_HEIGHT, CAPTURE_TOO_LARGE, type PageViewport } from '../../shared/capture'
import { base64Encode } from '../extensions/bytes'

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

/** The header of a PNG that declares `width` × `height` (what the hosts' pictures start with). */
function pngHeader(width: number, height: number): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return base64Encode(bytes)
}

/** A 1280 × 720 view over a 1280 × 4000 page, scrolled 600 down, at 100 % on a plain display. */
const PLAIN: PageViewport = {
  scrollX: 0,
  scrollY: 600,
  width: 1280,
  height: 720,
  zoom: 1,
  devicePixelRatio: 1,
  documentWidth: 1280,
  documentHeight: 4000
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  /** Every `TabView.capture` call, in order. */
  captures: AgentCaptureOptions[]
  /** Every image data URL handed to the clipboard. */
  copied: string[]
  /** Every file handed to `DownloadHost.saveFile`. */
  saved: Array<{ name: string; mimeType: string; data: string }>
  /** Every `TabView.screenshot` call (Take Screenshot's path). */
  screenshots: string[]
}

function fixture(
  opts: {
    viewport?: PageViewport | null
    /** What the host's `capture` answers, given what it was asked; the default paints the area asked for at DPR 1. */
    capture?: (options: AgentCaptureOptions) => AgentCapture | null | Promise<AgentCapture | null>
    /** No agent capture on this host at all. */
    noCapture?: boolean
    /** No `saveFile` on this host. */
    noSaveFile?: boolean
    /** What the clipboard answers. */
    clipboard?: boolean
    /** What `saveFile` answers: the path written, or null for a failure. */
    savePath?: string | null
  } = {}
): Fixture {
  const captures: AgentCaptureOptions[] = []
  const copied: string[] = []
  const saved: Fixture['saved'] = []
  const screenshots: string[] = []
  const viewport = opts.viewport === undefined ? PLAIN : opts.viewport
  const paint =
    opts.capture ??
    ((options: AgentCaptureOptions): AgentCapture => {
      const area =
        options.mode === 'region' && options.region
          ? options.region
          : options.mode === 'viewport'
            ? { width: PLAIN.width, height: PLAIN.height }
            : { width: PLAIN.documentWidth, height: PLAIN.documentHeight }
      return {
        data: pngHeader(Math.round(area.width), Math.round(area.height)),
        mimeType: options.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        width: Math.round(area.width),
        height: Math.round(area.height)
      }
    })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({
      windows: true,
      updates: false,
      agents: false,
      pageTabs: false
    }),
    io: memoryIo(),
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
          send: () => undefined
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
          getTitle: () => 'Example',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
          },
          viewport: async () => viewport,
          screenshot: async (fileName: string) => {
            screenshots.push(fileName)
            return `/home/u/Downloads/${fileName}`
          },
          ...(opts.noCapture
            ? {}
            : {
                capture: async (options: AgentCaptureOptions) => {
                  captures.push(options)
                  return paint(options)
                }
              })
        })
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub<ClipboardHost>({
      writeImageFromUrl: async (dataUrl: string) => {
        copied.push(dataUrl)
        return opts.clipboard ?? true
      }
    }),
    shell: stub(),
    net: stub(),
    downloads: stub<DownloadHost>({
      currentDirectory: () => '/home/u/Downloads',
      ...(opts.noSaveFile
        ? {}
        : {
            saveFile: async (file: { name: string; mimeType: string; data: string }) => {
              saved.push(file)
              return opts.savePath === undefined ? `/home/u/Downloads/${file.name}` : opts.savePath
            }
          })
    }),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  // A fixed clock for the name rule.
  browser.capture.now = () => new Date(2026, 8, 23, 14, 5, 9)
  return { browser, win: browser.focusedWindow(), captures, copied, saved, screenshots }
}

function openSite(f: Fixture, url = 'https://example.test/page'): Tab {
  return f.browser.tabs.createTab({ url, active: true }, f.win)
}

function command<T>(f: Fixture, name: string, args: unknown): Promise<T> {
  return Promise.resolve(f.browser.handleCommand(f.win, name, args) as T | Promise<T>)
}

type CaptureResult = {
  dataUrl: string
  width: number
  height: number
  devicePixelRatio: number
  fallback?: 'viewport'
} | null

describe('page.capture', () => {
  it('paints a region through the host’s agent capture and answers with a PNG data URL and its size', async () => {
    const f = fixture()
    const tab = openSite(f)
    const result = await command<CaptureResult>(f, 'page.capture', {
      tabId: tab.id,
      mode: 'region',
      region: { x: 100, y: 700, width: 300, height: 200 }
    })
    expect(f.captures).toEqual([
      { mode: 'region', region: { x: 100, y: 700, width: 300, height: 200 }, format: 'png' }
    ])
    expect(result).toEqual({
      dataUrl: `data:image/png;base64,${pngHeader(300, 200)}`,
      width: 300,
      height: 200,
      devicePixelRatio: 1
    })
  })

  it('reports the picture’s own size and ratio from its bytes, whatever the host says – a 2x display', async () => {
    const f = fixture({
      viewport: { ...PLAIN, devicePixelRatio: 2 },
      // The Electron host reports the clip in CSS px; the bytes are the device pixels.
      capture: (options) => ({
        data: pngHeader(600, 400),
        mimeType: 'image/png',
        width: options.region?.width ?? 0,
        height: options.region?.height ?? 0
      })
    })
    const tab = openSite(f)
    const result = await command<CaptureResult>(f, 'page.capture', {
      tabId: tab.id,
      mode: 'region',
      region: { x: 0, y: 600, width: 300, height: 200 }
    })
    expect(result).toMatchObject({ width: 600, height: 400, devicePixelRatio: 2 })
  })

  it('clamps a region to the document before the host paints it and refuses one outside it', async () => {
    const f = fixture()
    const tab = openSite(f)
    await command(f, 'page.capture', {
      tabId: tab.id,
      mode: 'region',
      region: { x: 1200, y: 3900, width: 300, height: 300 }
    })
    expect(f.captures[0]).toMatchObject({ region: { x: 1200, y: 3900, width: 80, height: 100 } })
    await expect(
      command(f, 'page.capture', {
        tabId: tab.id,
        mode: 'region',
        region: { x: 5000, y: 0, width: 10, height: 10 }
      })
    ).resolves.toBeNull()
    expect(f.captures).toHaveLength(1)
  })

  it('paints the viewport and the full page as asked, PNG unless JPEG is wanted', async () => {
    const f = fixture()
    const tab = openSite(f)
    const viewport = await command<CaptureResult>(f, 'page.capture', {
      tabId: tab.id,
      mode: 'viewport'
    })
    expect(viewport).toMatchObject({ width: 1280, height: 720, devicePixelRatio: 1 })
    const full = await command<CaptureResult>(f, 'page.capture', {
      tabId: tab.id,
      mode: 'fullPage',
      format: 'jpeg'
    })
    expect(full?.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(f.captures).toEqual([
      { mode: 'viewport', format: 'png' },
      { mode: 'fullPage', format: 'jpeg' }
    ])
  })

  it('refuses a request past the pixel budget with the named error before the host paints anything', async () => {
    // 2560 CSS px wide at the height cut on a display at 150 %: 69 Mpx.
    const f = fixture({
      viewport: {
        ...PLAIN,
        width: 2560,
        documentWidth: 2560,
        documentHeight: 30_000,
        devicePixelRatio: 1.5
      }
    })
    const tab = openSite(f)
    const attempt = command(f, 'page.capture', { tabId: tab.id, mode: 'fullPage' })
    await expect(attempt).rejects.toMatchObject({
      name: CAPTURE_TOO_LARGE,
      message: `The capture would be 3,840 × ${(CAPTURE_MAX_HEIGHT * 1.5).toLocaleString('en-US')} pixels, more than the 36 megapixels a capture can hold. Zoom out or select a smaller area.`
    })
    expect(f.captures).toEqual([])
    // A region of the same page within the budget goes through.
    await expect(
      command(f, 'page.capture', {
        tabId: tab.id,
        mode: 'region',
        region: { x: 0, y: 0, width: 2560, height: 2000 }
      })
    ).resolves.not.toBeNull()
    expect(f.captures).toHaveLength(1)
  })

  it('passes a host’s viewport fallback through, with the page’s own ratio', async () => {
    const f = fixture({
      viewport: { ...PLAIN, devicePixelRatio: 2 },
      // The debugger is another's: the host cropped the viewport paint to the region instead.
      capture: () => ({
        data: pngHeader(600, 400),
        mimeType: 'image/png',
        width: 600,
        height: 400,
        fallback: 'viewport'
      })
    })
    const tab = openSite(f)
    const result = await command<CaptureResult>(f, 'page.capture', {
      tabId: tab.id,
      mode: 'fullPage'
    })
    expect(result).toEqual({
      dataUrl: `data:image/png;base64,${pngHeader(600, 400)}`,
      width: 600,
      height: 400,
      devicePixelRatio: 2,
      fallback: 'viewport'
    })
  })

  it('answers null for a host without the agent capture, a tab that is not there, or a paint that failed', async () => {
    const none = fixture({ noCapture: true })
    const tab = openSite(none)
    await expect(
      command(none, 'page.capture', { tabId: tab.id, mode: 'viewport' })
    ).resolves.toBeNull()
    await expect(
      command(none, 'page.capture', { tabId: 'tab_missing', mode: 'viewport' })
    ).resolves.toBeNull()
    const failing = fixture({
      capture: () => {
        throw new Error('Debugger is already attached')
      }
    })
    const other = openSite(failing)
    await expect(
      command(failing, 'page.capture', { tabId: other.id, mode: 'viewport' })
    ).resolves.toBeNull()
    const empty = fixture({ capture: () => null })
    const third = openSite(empty)
    await expect(
      command(empty, 'page.capture', { tabId: third.id, mode: 'viewport' })
    ).resolves.toBeNull()
  })

  it('without the page’s geometry leaves the viewport and full page to the host and measures nothing', async () => {
    const f = fixture({ viewport: null })
    const tab = openSite(f)
    const result = await command<CaptureResult>(f, 'page.capture', {
      tabId: tab.id,
      mode: 'fullPage'
    })
    expect(f.captures).toEqual([{ mode: 'fullPage', format: 'png' }])
    expect(result).toMatchObject({ width: 1280, height: 4000, devicePixelRatio: 1 })
  })
})

describe('page.viewport', () => {
  it('hands the chrome the page’s geometry, and null when there is none to read', async () => {
    const f = fixture()
    const tab = openSite(f)
    await expect(command(f, 'page.viewport', { tabId: tab.id })).resolves.toEqual(PLAIN)
    await expect(command(f, 'page.viewport', { tabId: 'tab_missing' })).resolves.toBeNull()
    const blind = fixture({ viewport: null })
    const other = openSite(blind)
    await expect(command(blind, 'page.viewport', { tabId: other.id })).resolves.toBeNull()
  })
})

describe('capture.copy', () => {
  it('puts an image data URL on the clipboard through the host and takes anything else as nothing', async () => {
    const f = fixture()
    const url = `data:image/png;base64,${pngHeader(4, 4)}`
    await expect(command(f, 'capture.copy', { dataUrl: url })).resolves.toBe(true)
    expect(f.copied).toEqual([url])
    await expect(
      command(f, 'capture.copy', { dataUrl: 'https://example.test/a.png' })
    ).resolves.toBe(false)
    await expect(
      command(f, 'capture.copy', { dataUrl: 'data:text/html;base64,PGh0bWw+' })
    ).resolves.toBe(false)
    expect(f.copied).toEqual([url])
    const refusing = fixture({ clipboard: false })
    await expect(command(refusing, 'capture.copy', { dataUrl: url })).resolves.toBe(false)
  })
})

describe('capture.save', () => {
  it('writes the picture through the downloads host under the screenshot name rule and lists it as a completed download', async () => {
    const f = fixture()
    const tab = openSite(f)
    const url = `data:image/png;base64,${pngHeader(4, 4)}`
    const result = await command<{ path: string } | null>(f, 'capture.save', {
      dataUrl: url,
      tabId: tab.id
    })
    expect(f.saved).toEqual([
      {
        name: 'Screenshot 2026-09-23 at 14.05.09.png',
        mimeType: 'image/png',
        data: pngHeader(4, 4)
      }
    ])
    expect(result).toEqual({ path: '/home/u/Downloads/Screenshot 2026-09-23 at 14.05.09.png' })
    const listed = f.browser.downloads.items.find((i) => i.savePath === result?.path)
    expect(listed).toMatchObject({
      state: 'completed',
      filename: 'Screenshot 2026-09-23 at 14.05.09.png',
      mimeType: 'image/png',
      containerId: tab.containerId,
      url: 'file:///home/u/Downloads/Screenshot 2026-09-23 at 14.05.09.png'
    })
  })

  it('takes the chrome’s file name as a leaf name with the picture’s extension put right', async () => {
    const f = fixture()
    const png = `data:image/png;base64,${pngHeader(4, 4)}`
    await command(f, 'capture.save', { dataUrl: png, fileName: '../../etc/passwd' })
    await command(f, 'capture.save', { dataUrl: png, fileName: 'Invoice (page 2)' })
    await command(f, 'capture.save', { dataUrl: png, fileName: 'photo.JPG' })
    await command(f, 'capture.save', {
      dataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
      fileName: 'photo'
    })
    expect(f.saved.map((s) => s.name)).toEqual([
      'passwd.png',
      'Invoice (page 2).png',
      'photo.png',
      'photo.jpg'
    ])
  })

  it('answers null for anything but an image, a host without the write, or a write that failed – and lists nothing', async () => {
    const f = fixture()
    const png = `data:image/png;base64,${pngHeader(4, 4)}`
    await expect(
      command(f, 'capture.save', { dataUrl: 'https://example.test/a.png' })
    ).resolves.toBeNull()
    const noHost = fixture({ noSaveFile: true })
    await expect(command(noHost, 'capture.save', { dataUrl: png })).resolves.toBeNull()
    const failing = fixture({ savePath: null })
    await expect(command(failing, 'capture.save', { dataUrl: png })).resolves.toBeNull()
    expect(failing.saved).toHaveLength(1)
    expect(failing.browser.downloads.items).toEqual([])
  })
})

describe('the one screenshot name rule', () => {
  it('names Take Screenshot’s file as capture.save does', () => {
    const f = fixture()
    const tab = openSite(f)
    f.browser.actions.run('page.screenshot', { sourceTabId: tab.id, win: f.win })
    return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      expect(f.screenshots).toEqual(['Screenshot 2026-09-23 at 14.05.09.png'])
    })
  })
})
