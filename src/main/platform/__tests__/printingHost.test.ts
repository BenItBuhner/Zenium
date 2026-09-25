import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'node:events'
import type { PrintJobOptions } from '../../../shared/print'

/**
 * The print job on Electron (`ElectronPrintingHost.print`): the preview's PDF goes to the
 * printer through a hidden window on Chromium's PDF viewer, and `print` on that window gets
 * only the printer's business – never `pageRanges`, which Electron's silent `print` drops on
 * Linux (every page would print) and which the PDF already honours. The viewer's load is
 * bounded: a document the viewer never reports fails the job with a reason.
 */

/** A hidden viewer window as the test sees it. */
interface FakeWindow {
  options: Record<string, unknown>
  webContents: EventEmitter & {
    loaded: string[]
    /** Every `print` call's options; the callback is answered by `printAnswer`. */
    printed: Array<Record<string, unknown>>
    printAnswer: [boolean, string?]
  }
  isDestroyed(): boolean
}

const fakes = vi.hoisted(() => ({
  /** A frame `webFrameMain.fromId` hands back, by `${processId}:${routingId}`. */
  frames: new Map<string, { url: string }>(),
  /** Every hidden window made, in order. */
  windows: [] as FakeWindow[],
  writes: [] as Array<{ file: string; bytes: Uint8Array }>,
  removed: [] as string[]
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWebContents extends EventEmitter {
    readonly mainFrame = { url: '', tag: 'main frame' }
    readonly loaded: string[] = []
    readonly printed: Array<Record<string, unknown>> = []
    printAnswer: [boolean, string?] = [true]
    destroyed = false
    loadURL(url: string): Promise<void> {
      this.loaded.push(url)
      this.mainFrame.url = url
      return Promise.resolve()
    }
    isLoading(): boolean {
      return false
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    print(
      options: Record<string, unknown>,
      callback: (success: boolean, failureReason?: string) => void
    ): void {
      this.printed.push(options)
      const [success, reason] = this.printAnswer
      setTimeout(() => callback(success, reason), 0)
    }
  }
  class FakeBrowserWindow implements FakeWindow {
    readonly webContents = new FakeWebContents()
    private destroyed = false
    constructor(readonly options: Record<string, unknown>) {
      fakes.windows.push(this)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
      this.webContents.destroyed = true
    }
  }
  return {
    app: { getPath: (name: string) => `/tmp/zenium-test/${name}` },
    BrowserWindow: FakeBrowserWindow,
    dialog: {},
    webContents: { getAllWebContents: () => [] },
    webFrameMain: {
      fromId: (processId: number, routingId: number) =>
        fakes.frames.get(`${processId}:${routingId}`)
    }
  }
})

vi.mock('node:fs/promises', () => ({
  writeFile: async (file: string, bytes: Uint8Array) => {
    fakes.writes.push({ file, bytes })
  },
  rm: async (file: string) => {
    fakes.removed.push(file)
  }
}))

vi.mock('../downloads', () => ({ downloadDir: () => '/tmp/zenium-test/downloads' }))

import { DOCUMENT_LOAD_TIMEOUT_MS, ElectronPrintingHost } from '../printing'

const JOB: PrintJobOptions = {
  deviceName: 'Zenium_PDF',
  copies: 2,
  collate: true,
  duplexMode: 'longEdge',
  color: false,
  landscape: true,
  pageSize: { width: 279_400, height: 215_900 }
}

const DOCUMENT = new Uint8Array([0x25, 0x50, 0x44, 0x46])

const VIEWER_URL = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html'

/** The viewer's document frame – the frame at the file's own URL inside the viewer – finished loading. */
function documentFrameLoaded(win: FakeWindow): void {
  fakes.frames.set('7:9', { url: win.webContents.loaded[0]! })
  win.webContents.emit('did-frame-finish-load', {}, false, 7, 9)
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  fakes.frames.clear()
  fakes.windows.length = 0
  fakes.writes.length = 0
  fakes.removed.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ElectronPrintingHost.print', () => {
  it("hands `print` the printer's business only – never `pageRanges` – once the viewer holds the document", async () => {
    const host = new ElectronPrintingHost(() => undefined)
    const job = host.print(DOCUMENT, JOB)
    await tick()
    const win = fakes.windows[0]!
    // The PDF went to a temporary file the hidden viewer window was pointed at.
    expect(fakes.writes).toHaveLength(1)
    expect(fakes.writes[0]!.file).toMatch(/zenium-print-[0-9a-f-]+\.pdf$/)
    expect(fakes.writes[0]!.bytes).toBe(DOCUMENT)
    expect(win.webContents.loaded).toEqual([`file://${fakes.writes[0]!.file}`])
    expect(win.options).toMatchObject({ show: false, webPreferences: { plugins: true } })
    // Nothing prints while only the viewer's own frames are up: the file's frame, then the
    // viewer extension's – `print` then would print the viewer's page as an image.
    win.webContents.emit('did-frame-finish-load', {}, true, 7, 1)
    fakes.frames.set('7:3', { url: VIEWER_URL })
    win.webContents.emit('did-frame-finish-load', {}, false, 7, 3)
    await tick()
    expect(win.webContents.printed).toEqual([])

    documentFrameLoaded(win)
    await job

    expect(win.webContents.printed).toEqual([
      {
        silent: true,
        deviceName: 'Zenium_PDF',
        copies: 2,
        collate: true,
        duplexMode: 'longEdge',
        color: false,
        landscape: true,
        pageSize: { width: 279_400, height: 215_900 },
        margins: { marginType: 'none' },
        scaleFactor: 100,
        printBackground: true
      }
    ])
    const options = win.webContents.printed[0]!
    expect(options).not.toHaveProperty('pageRanges')
    expect(options).not.toHaveProperty('header')
    expect(options).not.toHaveProperty('footer')
    // The window and the temporary file go once the job is done.
    expect(win.isDestroyed()).toBe(true)
    expect(fakes.removed).toEqual([fakes.writes[0]!.file])
  })

  it('fails the job with a reason when the viewer never reports the document, within the bound', async () => {
    vi.useFakeTimers()
    const host = new ElectronPrintingHost(() => undefined)
    const outcome = host.print(DOCUMENT, JOB).then(
      () => 'resolved',
      (error: Error) => error.message
    )
    await vi.advanceTimersByTimeAsync(0)
    const win = fakes.windows[0]!
    // The whole bound less a moment: still waiting, nothing printed, the window still up.
    await vi.advanceTimersByTimeAsync(DOCUMENT_LOAD_TIMEOUT_MS - 1)
    expect(win.webContents.printed).toEqual([])
    expect(win.isDestroyed()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe(
      'The document did not load: the PDF viewer did not report it within 30 s'
    )
    expect(win.webContents.printed).toEqual([])
    expect(win.isDestroyed()).toBe(true)
    expect(fakes.removed).toEqual([fakes.writes[0]!.file])
    // A frame reported after the bound changes nothing.
    documentFrameLoaded(win)
    await vi.advanceTimersByTimeAsync(100)
    expect(win.webContents.printed).toEqual([])
  })

  it("fails the job with the load failure, and with the printer's reason when `print` reports one", async () => {
    const failed = new ElectronPrintingHost(() => undefined).print(DOCUMENT, JOB)
    await tick()
    const first = fakes.windows[0]!
    first.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x.pdf', true)
    await expect(failed).rejects.toThrow('ERR_FILE_NOT_FOUND')
    expect(first.webContents.printed).toEqual([])
    expect(first.isDestroyed()).toBe(true)

    const refused = new ElectronPrintingHost(() => undefined).print(DOCUMENT, JOB)
    await tick()
    const second = fakes.windows[1]!
    second.webContents.printAnswer = [false, 'Printer offline']
    documentFrameLoaded(second)
    await expect(refused).rejects.toThrow('Printer offline')
    expect(second.isDestroyed()).toBe(true)
    expect(fakes.removed).toHaveLength(2)
  })
})
