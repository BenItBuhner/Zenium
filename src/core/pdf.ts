/**
 * The inline PDF viewer (`zen://pdf`; `shared/pdfPage.ts`, `shared/pdfViewerProtocol.ts`) for a
 * host whose engine cannot draw a PDF (`capabilities.pdfViewer`: Android's WebView). Chrome
 * Android's flow: a PDF the tab navigates to is downloaded like any file – the row shows in
 * Downloads, the notification too – and, complete, the tab shows it in the viewer page instead
 * of handing it to another app. "Open with" and the share sheet stay a tap away.
 *
 * Which downloads open here is decided from what the host reports with the transfer: the
 * response the tab's own navigation produced (not a "Download link", which stays a download),
 * a PDF by type or name, and not one the server marked `attachment`, which Chrome saves without
 * opening. The viewer document reports where it stands (`pdf` page messages) and takes the
 * chrome's commands (`pdf.command`); the chrome draws the controls.
 */
import type { Browser } from './browser'
import type { DownloadInit } from './downloads'
import type { DownloadChangeKind, DownloadItem } from '../shared/types'
import { pdfPageDownloadId, pdfPageUrl, type PdfDocumentInfo } from '../shared/pdfPage'
import {
  pdfCommandScript,
  type PdfViewerCommand,
  type PdfViewerReport
} from '../shared/pdfViewerProtocol'

/** Whether a download is a PDF: by the response's type, else by the file's name. */
export function isPdfDownload(mimeType: string, filename: string): boolean {
  const type = mimeType.split(';')[0].trim().toLowerCase()
  if (type === 'application/pdf' || type === 'application/x-pdf') return true
  const generic =
    type === '' || type === 'application/octet-stream' || type === 'binary/octet-stream'
  return generic && /\.pdf$/i.test(filename.trim())
}

/**
 * Whether a download the host announced opens in the viewer once complete: on a host with the
 * viewer, from a tab's own navigation, a PDF, and not an attachment.
 */
export function opensInViewer(
  init: Pick<DownloadInit, 'sourceTabId' | 'navigation' | 'disposition' | 'mimeType' | 'filename'>,
  hasViewer: boolean
): boolean {
  if (!hasViewer || !init.sourceTabId || !init.navigation) return false
  if (init.disposition === 'attachment') return false
  return isPdfDownload(init.mimeType, init.filename)
}

export class PdfViewerService {
  /**
   * Downloads that open in the viewer when they complete: download id → the tab that navigated
   * (null once that tab closed; the file then opens in a tab of its own).
   */
  private readonly pending = new Map<string, string | null>()
  /** What each viewer tab last reported. */
  private readonly reports = new Map<string, PdfViewerReport>()

  constructor(private readonly browser: Browser) {
    browser.onDownloadChange((item, kind) => this.onDownloadChange(item, kind))
  }

  get available(): boolean {
    return this.browser.platform.capabilities.pdfViewer
  }

  /** A transfer began (`DownloadService.begin`): note the ones that open here. */
  onDownloadBegin(item: DownloadItem, init: DownloadInit): void {
    if (opensInViewer(init, this.available) && init.sourceTabId)
      this.pending.set(item.id, init.sourceTabId)
  }

  private onDownloadChange(item: DownloadItem, kind: DownloadChangeKind): void {
    if (kind === 'removed') {
      this.pending.delete(item.id)
      return
    }
    if (kind !== 'done' || !this.pending.has(item.id)) return
    const tabId = this.pending.get(item.id) ?? null
    this.pending.delete(item.id)
    if (item.state !== 'completed' || !item.savePath) return
    this.show(item, tabId)
  }

  /**
   * Show a completed download in the viewer: in the tab that navigated to it, as Chrome does,
   * else – the tab closed meanwhile – in a new tab of the window in front.
   */
  show(item: DownloadItem, tabId: string | null): void {
    const url = pdfPageUrl(item.id)
    const tab = tabId ? this.browser.tabs.tab(tabId) : undefined
    if (tab) this.browser.tabs.navigate(tab.id, url, { transition: 'link' })
    else this.browser.tabs.createTab({ url, active: true }, this.browser.focusedWindow())
  }

  /**
   * The document behind a viewer address, for the host to serve (`PdfPageLookup`): null once the
   * download is gone – deleted, cleared from the list, its file missing – and the page says so.
   */
  document(id: string): PdfDocumentInfo | null {
    const item = this.browser.downloads.item(id)
    if (!item || item.state !== 'completed' || item.removed || item.fileMissing || !item.savePath)
      return null
    return { id, name: item.finalName || item.filename, path: item.savePath }
  }

  /** The download a viewer tab shows, if it shows one that is still there. */
  itemOf(tabId: string): DownloadItem | undefined {
    const tab = this.browser.tabs.tab(tabId)
    const id = tab ? pdfPageDownloadId(tab.url) : null
    const item = id ? this.browser.downloads.item(id) : undefined
    return item && item.state === 'completed' && !item.removed ? item : undefined
  }

  /** Chrome's "Open with": the system's chooser for the file (the plain open where there is none). */
  async openWith(tabId: string): Promise<void> {
    const item = this.itemOf(tabId)
    if (!item) return
    const host = this.browser.platform.downloads
    await (host.openWith ? host.openWith(item) : host.open(item))
  }

  /** The share sheet with the file; a host that cannot share files shares the address it came from. */
  async share(tabId: string): Promise<void> {
    const item = this.itemOf(tabId)
    if (!item) return
    const host = this.browser.platform.downloads
    if (host.share) {
      await host.share(item)
      return
    }
    if (/^https?:/i.test(item.url))
      await this.browser.platform.shell.share?.({ url: item.url, title: item.finalName, tabId })
  }

  /** The viewer document reported (a `pdf` page message): keep it and tell the chrome. */
  onReport(tabId: string, report: PdfViewerReport): void {
    this.reports.set(tabId, report)
    this.browser.emit('pdf.changed', { tabId, report }, this.browser.tabs.windowFor(tabId))
  }

  report(tabId: string): PdfViewerReport | null {
    return this.reports.get(tabId) ?? null
  }

  /** Drive the viewer document; false when the tab shows no viewer that could take the command. */
  async command(tabId: string, command: PdfViewerCommand): Promise<boolean> {
    const view = this.browser.tabs.view(tabId)
    if (!view || !this.itemOf(tabId)) return false
    try {
      return (await view.executeJavaScript(pdfCommandScript(command))) === true
    } catch {
      return false
    }
  }

  /** The tab left the viewer (another document committed): its report is stale. */
  onNavigated(tabId: string, url: string): void {
    if (!pdfPageDownloadId(url)) this.reports.delete(tabId)
  }

  onTabRemoved(tabId: string): void {
    this.reports.delete(tabId)
    for (const [id, owner] of this.pending) if (owner === tabId) this.pending.set(id, null)
  }
}
