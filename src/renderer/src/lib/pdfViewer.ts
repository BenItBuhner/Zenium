import type { UIState } from '@shared/types'
import { pdfPageDownloadId } from '@shared/pdfPage'
import {
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  type PdfFitMode,
  type PdfOutlineItem,
  type PdfViewerCommand,
  type PdfViewerReport
} from '@shared/pdfViewerProtocol'
import { cmd, run } from './api'
import { createStore } from './store'
import { browserStore } from './ui'

/**
 * What the chrome knows of each PDF viewer tab (`zen://pdf`, `core/pdf.ts`): the viewer
 * document's last report, kept per tab as `pdf.changed` brings it (`useMainEvents`), and asked
 * for once when a viewer tab comes on screen before any report arrived (`pdf.state`, then the
 * `report` command for a document that was up before this chrome attached). The docked bar
 * (`components/pdf/PdfViewerBar.tsx`) and the find bar draw from here. Each report is kept
 * with the address the tab showed when it came: a tab that moved on – to a page, or to another
 * document for the same viewer – has none until the new document reports
 * (`dropStalePdfReports`).
 */
export const pdfViewerStore = createStore<{
  reports: Readonly<Record<string, PdfViewerReport>>
  /** The address of the tab as each report came, by tab. */
  urls: Readonly<Record<string, string>>
}>({ reports: {}, urls: {} }, 'pdf-viewer')

/** The viewer document reported (`pdf.changed`). */
export function setPdfReport(tabId: string, report: PdfViewerReport): void {
  const url = browserStore.get().state?.tabs[tabId]?.url ?? ''
  pdfViewerStore.set((s) => ({
    reports: { ...s.reports, [tabId]: report },
    urls: { ...s.urls, [tabId]: url }
  }))
}

/** The tab is gone, or shows another document: its report is stale. */
export function clearPdfReport(tabId: string): void {
  pdfViewerStore.set((s) => {
    if (!(tabId in s.reports) && !(tabId in s.urls)) return {}
    const reports = { ...s.reports }
    const urls = { ...s.urls }
    delete reports[tabId]
    delete urls[tabId]
    return { reports, urls }
  })
}

/**
 * The browser state moved: a report whose tab is gone, or shows another address than the one
 * it came under, goes with it (the viewer of the new document reports afresh once it is up).
 */
export function dropStalePdfReports(state: UIState): void {
  const { urls } = pdfViewerStore.get()
  for (const tabId of Object.keys(urls)) {
    const tab = state.tabs[tabId]
    if (!tab || tab.url !== urls[tabId]) clearPdfReport(tabId)
  }
}

/** Whether the tab shows the inline PDF viewer page. */
export function isPdfViewerTab(state: UIState, tabId: string | null | undefined): boolean {
  const tab = tabId ? state.tabs[tabId] : undefined
  return tab !== undefined && pdfPageDownloadId(tab.url) !== null
}

/**
 * Ask the core for the tab's report when the store has none (a chrome that attached after the
 * viewer reported), and have the document report again when the core has none either.
 */
export async function fetchPdfReport(tabId: string): Promise<void> {
  if (pdfViewerStore.get().reports[tabId]) return
  const report = await cmd('pdf.state', { tabId }).catch(() => null)
  if (pdfViewerStore.get().reports[tabId]) return
  if (report) setPdfReport(tabId, report)
  else run('pdf.command', { tabId, command: { kind: 'report' } })
}

/** Drive the viewer document of `tabId`. */
export function pdfCommand(tabId: string, command: PdfViewerCommand): void {
  run('pdf.command', { tabId, command })
}

/** A zoom factor as the bar shows it: whole percent, tabular. */
export function formatPdfZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}

/** Whether a zoom is as good as the preset (the viewer rounds its fits to three decimals). */
export function pdfZoomIs(zoom: number, preset: number): boolean {
  return Math.abs(zoom - preset) < 0.005
}

/** The zoom sheet's presets: Chrome's two fits, then the round factors of its zoom menu. */
export const PDF_ZOOM_PRESETS: ReadonlyArray<number> = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

export const PDF_FIT_LABELS: Readonly<Record<PdfFitMode, string>> = {
  width: 'Fit to width',
  page: 'Fit to page'
}

/** Whether the bar's zoom out / zoom in still have a step to take. */
export function canZoomOut(zoom: number): boolean {
  return zoom > PDF_MIN_ZOOM + 0.005
}
export function canZoomIn(zoom: number): boolean {
  return zoom < PDF_MAX_ZOOM - 0.005
}

/** An outline entry laid flat for a list: the entry and how deep it sits. */
export interface FlatOutlineItem {
  item: PdfOutlineItem
  depth: number
  /** A stable key: the entry's path of indices from the root. */
  key: string
}

/** The outline as the sheet lists it: every entry in reading order, children under their parent. */
export function flattenOutline(
  items: readonly PdfOutlineItem[],
  depth = 0,
  prefix = ''
): FlatOutlineItem[] {
  const out: FlatOutlineItem[] = []
  items.forEach((item, index) => {
    const key = prefix ? `${prefix}.${index}` : String(index)
    out.push({ item, depth, key })
    if (item.children.length > 0) out.push(...flattenOutline(item.children, depth + 1, key))
  })
  return out
}

/**
 * The entry the reader is at: the first that leads to the page on screen (the page's own
 * heading, where it has several), else the last that leads to a page before it (a page without
 * a heading of its own belongs to the section that began before it); null before the document
 * is open or when nothing leads that far.
 */
export function currentOutlineKey(rows: readonly FlatOutlineItem[], page: number): string | null {
  if (page < 1) return null
  let before: string | null = null
  for (const row of rows) {
    if (row.item.page === null) continue
    if (row.item.page === page) return row.key
    if (row.item.page < page) before = row.key
  }
  return before
}

/**
 * A page number typed into "Go to page": the page, or null for anything that is not a whole
 * number within the document.
 */
export function parsePageNumber(text: string, pageCount: number): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const page = Number(trimmed)
  return page >= 1 && page <= pageCount ? page : null
}
