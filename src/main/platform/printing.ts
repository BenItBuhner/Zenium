/**
 * The print preview's host side on Electron (`PrintingHost`): the system's printers, as
 * Chromium lists them for any web contents, and the file Save as PDF writes after Chrome's save
 * dialog. Rendering (`printToPDF`) and the job (`print`) are the tab view's (`views.ts`).
 */
import { dialog, webContents, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrintingHost } from '../../core/platform'
import type { ZenWindow } from '../../core/window'
import { printerDuplex, printerIsDefault, type PrinterDescription } from '../../shared/print'
import { downloadDir } from './downloads'

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
