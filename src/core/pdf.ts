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
import {
  pdfPageDownloadId,
  pdfPageUrl,
  pdfViewerBaseUrl,
  type PdfDocumentInfo
} from '../shared/pdfPage'
import { newId } from '../shared/ids'
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
  /**
   * Each shown download's token (`PdfDocumentInfo.token`), minted when its document is first
   * looked up and kept while the download is: the viewer's document carries it, and a report
   * for a tab counts only with the token of the download that tab shows.
   */
  private readonly tokens = new Map<string, string>()

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

  /**
   * Whether a PDF the tab navigated to is on its way to the viewer: the tab keeps its place
   * while the file downloads (Chrome shows the transfer in the tab), and no Downloads surface
   * comes over it.
   */
  expects(tabId: string): boolean {
    for (const owner of this.pending.values()) if (owner === tabId) return true
    return false
  }

  private onDownloadChange(item: DownloadItem, kind: DownloadChangeKind): void {
    if (kind === 'removed') {
      this.pending.delete(item.id)
      this.tokens.delete(item.id)
      return
    }
    if (kind !== 'done' || !this.pending.has(item.id)) return
    const tabId = this.pending.get(item.id) ?? null
    this.pending.delete(item.id)
    // A file held behind a danger warning stays in Downloads until the user keeps it, as in
    // Chrome; the viewer never opens it on its own.
    if (item.state !== 'completed' || !item.savePath || item.danger.level !== 'safe') return
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
    if (!item || !viewable(item)) return null
    let token = this.tokens.get(id)
    if (!token) {
      token = newId()
      this.tokens.set(id, token)
    }
    return { id, name: item.finalName || item.filename, path: item.savePath, url: item.url, token }
  }

  /**
   * The address a viewer tab stands for outside the chrome: the document's own URL, which its
   * document runs under (`pdfViewerBaseUrl`) and which Chrome's PDF tab reads as to extensions
   * (`tabs.Tab.url`, `webNavigation`, content-script matching). Null for any other address, for
   * a viewer address whose download is gone, and for a document with no address to run under.
   */
  documentUrl(tabUrl: string): string | null {
    const id = pdfPageDownloadId(tabUrl)
    const item = id ? this.browser.downloads.item(id) : undefined
    if (!item || !viewable(item)) return null
    return pdfViewerBaseUrl(item) === item.url ? item.url : null
  }

  /** The download a viewer tab shows, if it shows one that is still there. */
  itemOf(tabId: string): DownloadItem | undefined {
    const tab = this.browser.tabs.tab(tabId)
    const id = tab ? pdfPageDownloadId(tab.url) : null
    const item = id ? this.browser.downloads.item(id) : undefined
    return item && viewable(item) ? item : undefined
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

  /**
   * The viewer document reported (a `pdf` page message): keep it and tell the chrome. Only with
   * the token of the download the tab shows: the document runs under the PDF's own origin, and
   * a page of that origin (or any page, on a host whose page script relays from every document)
   * posting a report of its own must not reach the chrome's PDF controls.
   */
  onReport(tabId: string, report: PdfViewerReport, token: string | undefined): void {
    const tab = this.browser.tabs.tab(tabId)
    const id = tab ? pdfPageDownloadId(tab.url) : null
    if (!id || !token || this.tokens.get(id) !== token) return
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

  /**
   * Another document committed in the tab – a page, or another PDF for the viewer – so the
   * report is stale: the new document reports afresh once it is up (`onReport`), and until then
   * the tab has none (the chrome shows its bar loading, not the last document's pages).
   */
  onNavigated(tabId: string): void {
    this.reports.delete(tabId)
  }

  onTabRemoved(tabId: string): void {
    this.reports.delete(tabId)
    for (const [id, owner] of this.pending) if (owner === tabId) this.pending.set(id, null)
  }
}

/** A completed download whose file is there to be shown (not held behind a danger warning). */
function viewable(item: DownloadItem): boolean {
  return (
    item.state === 'completed' &&
    !item.removed &&
    !item.fileMissing &&
    item.savePath !== '' &&
    (item.danger.level === 'safe' || item.dangerAccepted)
  )
}
