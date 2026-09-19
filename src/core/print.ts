/**
 * The print preview (`zen://print`; `shared/print.ts` for the option model): Chrome's print
 * dialog for a host whose engine has none of its own (Electron ships Chromium without its
 * preview). The chrome draws the dialog over the page; this service is what it talks to:
 *
 *  - `open` starts a session for a tab and opens the page (its overlay on the desktop);
 *  - `session` gives the chrome the tab's title and address, the system's printers and the
 *    settings to open with – Chrome's sticky settings from the last print over the defaults;
 *  - `preview` renders the page to a PDF with the settings (`TabView.printToPDF`), which the
 *    chrome draws with pdf.js and learns the page count from;
 *  - `run` prints (`TabView.printWith`, silently: the preview asked everything) or saves the
 *    PDF where the user chooses (`PrintingHost.savePdf`), lists the file in Downloads as a saved
 *    page is, and remembers the sticky part of the settings for the next print.
 *
 * A host without the preview (`capabilities.printPreview` off: Android, whose print manager has
 * its own) gets the engine's flow from `open`, so `page.printPreview` is safe to bind anywhere.
 */
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import { JsonStore } from './store/JsonStore'
import { base64Encode } from './extensions/bytes'
import {
  defaultPdfFileName,
  openingSettings,
  pagesToPrint,
  pdfRenderOptions,
  PRINT_MESSAGES,
  printJobOptions,
  sanitizePrintSettings,
  defaultPrintSettings,
  stickyOf,
  type PrinterDescription,
  type PrintPreviewResult,
  type PrintRunResult,
  type PrintSessionInfo,
  type PrintSettings,
  type PrintStickySettings
} from '../shared/print'

interface Persisted {
  /** Chrome's sticky settings: what the last print used, minus the pages and copies. */
  sticky: PrintStickySettings | null
}

/** A preview open for a tab. */
interface Session {
  tabId: string
  /** The last render, for a Save that follows without a change of settings. */
  rendered: { settings: string; pdf: Uint8Array } | null
}

export class PrintService {
  private readonly store: JsonStore<Persisted>
  private sticky: PrintStickySettings | null
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly browser: Browser) {
    this.store = new JsonStore<Persisted>(browser.platform.io, 'print.json', 300)
    const persisted = this.store.readSync()
    this.sticky = persisted?.sticky ? this.sanitizeSticky(persisted.sticky) : null
  }

  /** Whether this host has the preview: it renders PDFs and lists printers. */
  get available(): boolean {
    return (
      this.browser.platform.capabilities.printPreview &&
      this.browser.platform.printing !== undefined
    )
  }

  /** The settings the last print used, as remembered; null before a first print. */
  get remembered(): PrintStickySettings | null {
    return this.sticky
  }

  /**
   * Ctrl+P: the preview for a tab, or the engine's own print flow on a host without one. A tab
   * that cannot be printed – no page view (a chrome page), a page not yet loaded – does nothing,
   * as Chrome's Print stays disabled on such pages.
   */
  open(tabId: string, win: ZenWindow): void {
    const view = this.browser.tabs.view(tabId)
    if (!view) return
    if (!this.available || this.browser.pages.isChromePage(this.browser.tabs.tab(tabId))) {
      view.print()
      return
    }
    this.sessions.set(tabId, { tabId, rendered: null })
    this.browser.emit('overlay.open', { kind: 'print', tabId }, win)
  }

  /** What the preview opens with for a tab; null when the tab cannot be previewed here. */
  async session(tabId: string): Promise<PrintSessionInfo | null> {
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!tab || !view || !this.available) return null
    if (!this.sessions.has(tabId)) this.sessions.set(tabId, { tabId, rendered: null })
    const printers = await this.printers()
    return {
      tabId,
      title: tab.title || view.getTitle() || '',
      url: tab.url,
      printers,
      settings: openingSettings(this.sticky, printers, this.locale())
    }
  }

  /**
   * The page as a PDF with `settings`, base64 for the chrome. `pageCount` is what the chrome
   * learned from an earlier render (the pages picked need it; unknown, every page renders).
   */
  async preview(
    tabId: string,
    raw: PrintSettings,
    pageCount: number | null = null
  ): Promise<PrintPreviewResult> {
    const view = this.browser.tabs.view(tabId)
    if (!view?.printToPDF || !this.available)
      return { ok: false, error: PRINT_MESSAGES.previewFailed }
    const settings = this.sanitize(raw)
    if (pageCount !== null && pageCount > 0 && pagesToPrint(settings.pages, pageCount).length === 0)
      return { ok: false, error: PRINT_MESSAGES.noPages }
    try {
      const pdf = await view.printToPDF(pdfRenderOptions(settings, pageCount))
      const session = this.sessions.get(tabId) ?? { tabId, rendered: null }
      session.rendered = { settings: JSON.stringify(settings), pdf }
      this.sessions.set(tabId, session)
      return { ok: true, pdf: base64Encode(pdf) }
    } catch (error) {
      return { ok: false, error: failureText(error, PRINT_MESSAGES.previewFailed) }
    }
  }

  /**
   * Print or Save with `settings` for a document of `pageCount` pages. A printer gets the job
   * without another dialog; Save as PDF asks where to save (the page's title as the file name)
   * and lists the file in Downloads. The sticky part of the settings is remembered either way –
   * not when the save dialog is dismissed, as Chrome forgets a cancelled print.
   */
  async run(
    tabId: string,
    raw: PrintSettings,
    pageCount: number,
    win: ZenWindow
  ): Promise<PrintRunResult> {
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    const printing = this.browser.platform.printing
    if (!tab || !view || !printing || !this.available)
      return { ok: false, error: PRINT_MESSAGES.printFailed }
    const settings = this.sanitize(raw)
    const pages = pagesToPrint(settings.pages, pageCount)
    if (pages.length === 0) return { ok: false, error: PRINT_MESSAGES.noPages }
    const title = tab.title || view.getTitle() || ''
    if (settings.destination.kind === 'printer') {
      const options = printJobOptions(settings, pageCount, { title, url: tab.url })
      if (!options || !view.printWith) return { ok: false, error: PRINT_MESSAGES.printFailed }
      try {
        await view.printWith(options)
      } catch (error) {
        return { ok: false, error: failureText(error, PRINT_MESSAGES.printFailed) }
      }
      this.remember(settings)
      this.sessions.delete(tabId)
      return { ok: true, action: 'printed' }
    }
    // Save as PDF: the render the preview shows when the settings have not moved since, else a
    // fresh one – the pages and paper of the file are the preview's.
    let pdf: Uint8Array
    try {
      const rendered = this.sessions.get(tabId)?.rendered
      pdf =
        rendered && rendered.settings === JSON.stringify(settings) && view.printToPDF
          ? rendered.pdf
          : await this.render(view, settings, pageCount)
    } catch (error) {
      return { ok: false, error: failureText(error, PRINT_MESSAGES.saveFailed) }
    }
    let path: string | null
    try {
      path = await printing.savePdf(pdf, { defaultName: defaultPdfFileName(title, tab.url) }, win)
    } catch (error) {
      return { ok: false, error: failureText(error, PRINT_MESSAGES.saveFailed) }
    }
    if (!path) return { ok: true, action: 'cancelled' }
    this.browser.downloads.addCompleted(path, 'application/pdf', {
      containerId: tab.containerId,
      private: win.isPrivate
    })
    this.remember(settings)
    this.sessions.delete(tabId)
    return { ok: true, action: 'saved', path }
  }

  /** The preview closed without printing: the tab's session is over. */
  close(tabId: string): void {
    this.sessions.delete(tabId)
  }

  /** Whether a preview is open for the tab (its overlay asked for a session). */
  isOpen(tabId: string): boolean {
    return this.sessions.has(tabId)
  }

  onTabRemoved(tabId: string): void {
    this.sessions.delete(tabId)
  }

  flushSync(): void {
    this.store.flushSync()
  }

  // ---------------------------------------------------------------------------

  private async render(
    view: NonNullable<ReturnType<Browser['tabs']['view']>>,
    settings: PrintSettings,
    pageCount: number
  ): Promise<Uint8Array> {
    if (!view.printToPDF) throw new Error(PRINT_MESSAGES.saveFailed)
    return view.printToPDF(pdfRenderOptions(settings, pageCount))
  }

  private async printers(): Promise<PrinterDescription[]> {
    try {
      return (await this.browser.platform.printing?.printers()) ?? []
    } catch {
      return []
    }
  }

  private remember(settings: PrintSettings): void {
    this.sticky = stickyOf(settings)
    this.store.write({ sticky: this.sticky })
  }

  /** The chrome's settings, checked field by field (a stale chrome, a hand-edited request). */
  private sanitize(raw: PrintSettings): PrintSettings {
    return sanitizePrintSettings(raw, defaultPrintSettings(this.locale()))
  }

  private sanitizeSticky(raw: unknown): PrintStickySettings {
    return stickyOf(sanitizePrintSettings(raw, defaultPrintSettings(this.locale())))
  }

  /** The user's locale, for Chrome's default paper (Letter in the Americas, A4 elsewhere). */
  private locale(): string | null {
    const fromHost = this.browser.platform.translate?.locales[0]
    if (fromHost) return fromHost
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale
    } catch {
      return null
    }
  }
}

/** An error's message for the user, or `fallback` for one without words. */
function failureText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.trim() ? `${fallback} (${message.trim()})` : fallback
}
