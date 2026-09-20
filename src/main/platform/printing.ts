/**
 * The print preview's host side on Electron (`PrintingHost`): the system's printers, as
 * Chromium lists them for any web contents, the job that takes the preview's PDF to one of
 * them, and the file Save as PDF writes after Chrome's save dialog. Rendering (`printToPDF`) is
 * the tab view's (`views.ts`).
 *
 * The job prints the PDF, not the page: Electron's silent `webContents.print` lays the page out
 * again with its own settings and loses the pages picked (its renderer takes the silent path
 * without them), so the printer would not get what the preview showed. Chrome hands the
 * preview's PDF to the printer; here the PDF is written to a temporary file, opened in a hidden
 * window on Chromium's PDF viewer, and printed from there – `print` addresses the viewer's
 * document frame and prints its pages at their own size – with only the printer's options left
 * to give: copies, collation, two-sided, colour, the paper.
 */
import { app, BrowserWindow, dialog, webContents, webFrameMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PrintingHost } from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import {
  printerDuplex,
  printerIsDefault,
  type PrinterDescription,
  type PrintJobOptions
} from '../../shared/print'
import { downloadDir } from './downloads'

/** How long the viewer gets to take a document in before the job is given up. */
const DOCUMENT_LOAD_TIMEOUT_MS = 30_000

export class ElectronPrintingHost implements PrintingHost {
  constructor(private readonly browserWindowOf: (win?: ZenWindow) => BrowserWindow | undefined) {}

  /**
   * `getPrintersAsync` hangs on a web contents but answers for the system; any live one serves.
   * CUPS hosts report `printer-type`, whose bits say whether two-sided printing is on offer and
   * which printer is the server's default; Windows reports nothing of the kind (duplex null: the
   * option is offered, the driver decides; no default: the preview opens on Save as PDF).
   */
  async printers(): Promise<PrinterDescription[]> {
    const wc = webContents.getAllWebContents().find((c) => !c.isDestroyed())
    if (!wc) return []
    const list = await wc.getPrintersAsync()
    return list.map((printer) => {
      const options = printer.options as Record<string, unknown>
      return {
        name: printer.name,
        displayName: printer.displayName || printer.name,
        description: printer.description,
        isDefault: printerIsDefault(options),
        duplex: printerDuplex(options)
      }
    })
  }

  /**
   * The preview's PDF to the printer, silently. The document goes through Chromium's PDF viewer
   * in a hidden window (see the file comment); `margins: none` keeps its pages at their own
   * size – the preview laid them out for this very paper – where the default margins would fit
   * them to the printable area again. The callback's failure reason becomes the rejection.
   */
  async print(document: Uint8Array, job: PrintJobOptions): Promise<void> {
    const file = join(app.getPath('temp'), `zenium-print-${randomUUID()}.pdf`)
    await writeFile(file, document)
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        plugins: true,
        backgroundThrottling: false
      }
    })
    try {
      await loadPdfDocument(win.webContents, pathToFileURL(file).href)
      await new Promise<void>((resolve, reject) => {
        win.webContents.print(
          {
            silent: true,
            deviceName: job.deviceName,
            copies: job.copies,
            collate: job.collate,
            duplexMode: job.duplexMode,
            color: job.color,
            landscape: job.landscape,
            pageSize: { width: job.pageSize.width, height: job.pageSize.height },
            margins: { marginType: 'none' },
            scaleFactor: 100,
            printBackground: true
          },
          (success, failureReason) => {
            if (success) resolve()
            else reject(new Error(failureReason || 'The print job failed'))
          }
        )
      })
    } finally {
      if (!win.isDestroyed()) win.destroy()
      await rm(file, { force: true }).catch(() => undefined)
    }
  }

  /** Chrome's Save as PDF dialog: the downloads folder and the page's title offered. */
  async savePdf(
    bytes: Uint8Array,
    options: { defaultName: string },
    win?: ZenWindow
  ): Promise<string | null> {
    const dialogOptions = {
      title: 'Save as PDF',
      defaultPath: join(downloadDir(), options.defaultName),
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
    }
    const bw = this.browserWindowOf(win)
    const result = bw
      ? await dialog.showSaveDialog(bw, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    const path = /\.pdf$/i.test(result.filePath) ? result.filePath : `${result.filePath}.pdf`
    await writeFile(path, bytes)
    return path
  }
}

/**
 * Open `url` (a PDF) in `wc` and resolve once Chromium's PDF viewer holds the document. The
 * viewer comes up in stages – the file's own frame, the viewer extension's frame inside it,
 * then the frame that carries the document, at the file's URL again – and `print` addresses
 * that last frame; before it is up, `print` would print the viewer's page (toolbar, thumbnails)
 * as an image. So: wait for that frame to finish loading, then for the contents to stop loading
 * altogether (the viewer keeps them loading while it reads the file). Rejects when the load
 * fails or the document is not in within `DOCUMENT_LOAD_TIMEOUT_MS`.
 */
function loadPdfDocument(wc: WebContents, url: string): Promise<void> {
  const path = new URL(url).pathname
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      wc.off('did-frame-finish-load', onFrame)
      wc.off('did-fail-load', onFail)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(
      () => finish(new Error('The document did not load')),
      DOCUMENT_LOAD_TIMEOUT_MS
    )
    const onFrame = (
      _event: Electron.Event,
      isMainFrame: boolean,
      processId: number,
      routingId: number
    ): void => {
      if (isMainFrame) return
      const frame = webFrameMain.fromId(processId, routingId)
      if (!frame || frame === wc.mainFrame) return
      let framePath: string
      try {
        framePath = new URL(frame.url).pathname
      } catch {
        return
      }
      if (framePath !== path) return
      void settleLoading(wc).then(() => finish())
    }
    const onFail = (
      _event: Electron.Event,
      code: number,
      description: string,
      _url: string,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame) finish(new Error(description || `The document did not load (${code})`))
    }
    wc.on('did-frame-finish-load', onFrame)
    wc.on('did-fail-load', onFail)
    wc.loadURL(url).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/** Resolves once `wc` reports no frame loading, or after a short while regardless. */
async function settleLoading(wc: WebContents): Promise<void> {
  for (let i = 0; i < 100 && !wc.isDestroyed() && wc.isLoading(); i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
}
