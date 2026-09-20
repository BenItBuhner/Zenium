/**
 * How the PDF viewer document (`zen://pdf`, `shared/pdfPage.ts`) and the browser talk. The
 * viewer posts its state as a `message` on its own window – the page script relays it (only
 * from a document of the viewer's origin) as a `pdf` page message – and the browser drives it
 * through a global the document exposes (`pdfCommandScript`, run with `executeJavaScript`).
 * Kept apart from `pdfPage` so the page script bundle does not carry the viewer's HTML.
 */

/**
 * The origin the viewer document runs on. The WebView loads the document with this base URL
 * (`loadDataWithBaseURL`) while the tab shows `zen://pdf`: a `zen://` document has no origin
 * of its own, and pdf.js's worker and the document's bytes can only be fetched from a real one.
 * `.invalid` never resolves, so a request that escaped the host's interception would fail
 * rather than reach a network. Every request to it is answered by the host itself.
 */
export const PDF_VIEWER_ORIGIN = 'https://pdf.zenium.invalid'

/** The key of the window message the viewer posts its report under. */
export const PDF_VIEWER_MESSAGE_KEY = 'zeniumPdf'

/** The global the viewer document exposes for the browser's commands. */
export const PDF_VIEWER_GLOBAL = '__zeniumPdf'

/** An entry of the document's outline (its bookmarks), with the children beneath it. */
export interface PdfOutlineItem {
  title: string
  /** The page the entry leads to, 1-based; null when its destination could not be resolved. */
  page: number | null
  children: PdfOutlineItem[]
}

export type PdfFitMode = 'width' | 'page'

/** Where the viewer stands, as it tells the browser after every change. */
export interface PdfViewerReport {
  /** `password`: the document is encrypted and waits for one (`password` command). */
  state: 'loading' | 'password' | 'ready' | 'error'
  /** 0 until the document is open. */
  pageCount: number
  /** The page most in view, 1-based; 0 until the document is open. */
  page: number
  /** The scale, 1 being 100 %. */
  zoom: number
  /** The fit the zoom follows, or null once the user zoomed freely. */
  fit: PdfFitMode | null
  /** The document's own title (its metadata), when it names one. */
  title: string | null
  /** The find bar's tally while a search runs; null when none does. */
  find: { query: string; current: number; total: number } | null
  outline: PdfOutlineItem[]
  /** `error`: what went wrong, in the viewer's words. */
  error?: string
  /** `password`: the one given was wrong (as against none given yet). */
  passwordWrong?: boolean
}

export type PdfViewerCommand =
  /** Set the zoom to a factor (1 = 100 %), clamped to the viewer's range. */
  | { kind: 'zoom'; factor: number }
  /** Step the zoom in (`steps` > 0) or out, along Chrome's zoom presets. */
  | { kind: 'zoomBy'; steps: number }
  | { kind: 'fit'; mode: PdfFitMode }
  /** Scroll to a page, 1-based. */
  | { kind: 'goTo'; page: number }
  /** Search: `new` starts over with the query, `next` / `prev` step through the matches. */
  | { kind: 'find'; query: string; direction: 'new' | 'next' | 'prev' }
  | { kind: 'stopFind' }
  /** Turn every page a quarter turn clockwise (Chrome's rotate). */
  | { kind: 'rotate' }
  /** The password for an encrypted document. */
  | { kind: 'password'; password: string }
  /** Post the current report again (a chrome that attached after the last one). */
  | { kind: 'report' }

/** Chrome's zoom presets, the steps `zoomBy` moves along. */
export const PDF_ZOOM_STEPS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5
]
export const PDF_MIN_ZOOM = PDF_ZOOM_STEPS[0]
export const PDF_MAX_ZOOM = PDF_ZOOM_STEPS[PDF_ZOOM_STEPS.length - 1]

/**
 * The preset `steps` away from `zoom`, as Chrome's zoom in and out move: one step reaches the
 * first preset past `zoom` in its direction, so a zoom between two presets (a fit) lands on the
 * neighbouring one; a zoom as good as on a preset counts as there.
 */
export function steppedZoom(zoom: number, steps: number): number {
  if (steps === 0) return zoom
  const tolerance = 1e-3
  let index: number
  if (steps > 0) {
    index = PDF_ZOOM_STEPS.findIndex((preset) => preset > zoom + tolerance)
    if (index < 0) index = PDF_ZOOM_STEPS.length
    index += steps - 1
  } else {
    index = PDF_ZOOM_STEPS.length - 1
    while (index >= 0 && PDF_ZOOM_STEPS[index] >= zoom - tolerance) index--
    index += steps + 1
  }
  return PDF_ZOOM_STEPS[Math.min(PDF_ZOOM_STEPS.length - 1, Math.max(0, index))]
}

/**
 * The JavaScript that hands `command` to the viewer document; true when the document took it.
 * One expression – an arrow function called at once – so a host that tells expressions from
 * statement lists without a parser (Android's `executeJavaScript`, `looksLikeStatements`) runs
 * it as the former and hands its value back; a classic `(function(){…})()` reads as statements
 * there and its value is lost.
 */
export function pdfCommandScript(command: PdfViewerCommand): string {
  return `(() => { const v = window[${JSON.stringify(PDF_VIEWER_GLOBAL)}]; if (!v || typeof v.command !== 'function') return false; v.command(${JSON.stringify(command)}); return true })()`
}

/** The report inside a window message the viewer posted, or null for any other message. */
export function pdfReportOf(data: unknown): PdfViewerReport | null {
  if (!data || typeof data !== 'object') return null
  const report = (data as Record<string, unknown>)[PDF_VIEWER_MESSAGE_KEY]
  if (!report || typeof report !== 'object') return null
  const r = report as Record<string, unknown>
  if (r.state !== 'loading' && r.state !== 'password' && r.state !== 'ready' && r.state !== 'error')
    return null
  if (typeof r.pageCount !== 'number' || typeof r.page !== 'number' || typeof r.zoom !== 'number')
    return null
  return report as PdfViewerReport
}
