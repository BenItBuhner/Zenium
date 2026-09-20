/**
 * The PDF viewer page, `zen://pdf?id=<download>` (`internalPages.ts`, `core/pdf.ts`): Chrome
 * Android's inline PDF viewer for a host whose engine cannot draw a PDF. A PDF the tab navigates
 * to is downloaded like any file – it shows in Downloads – and, complete, opens in this page in
 * the same tab. The document is a shell over pdf.js: the host serves the viewer's script, the
 * pdf.js worker and the download's bytes from `PDF_VIEWER_ORIGIN` (`pdfViewerProtocol.ts`),
 * which the shell's URLs point at, while the tab's address stays `zen://pdf`.
 *
 * The document itself runs under the PDF's own URL (`pdfViewerBaseUrl`: the base URL the host
 * loads the shell with), as Chrome's PDF viewer presents its tab: extensions see the tab under
 * that URL (`tabs`, `webNavigation`), a content script matching it runs in the document and
 * reads it as `location.href` (Kami's "Open with Kami", a content script on every URL that
 * looks for Chrome's viewer), and the viewer's own requests, now cross-origin to
 * `PDF_VIEWER_ORIGIN`, are answered with the CORS headers they need. A PDF with no http(s)
 * address to stand under runs on `PDF_VIEWER_ORIGIN` itself.
 *
 * Pure: addresses, the shell's HTML and the missing-file page. The viewer's behaviour lives in
 * `src/android/pdfViewer.ts` (built into the app's assets); the protocol between the two in
 * `pdfViewerProtocol.ts`.
 */
import { PDF_VIEWER_ORIGIN } from './pdfViewerProtocol'

export { PDF_VIEWER_ORIGIN }

export const PDF_PAGE_URL = 'zen://pdf'

/** Under the viewer's origin: the viewer's own files (`/viewer/<name>`) and the document's bytes. */
export const PDF_VIEWER_ASSET_PREFIX = '/viewer/'
export const PDF_VIEWER_DOCUMENT_PATH = '/document.pdf'

/** The viewer's files, as the host ships them (`android/app/src/main/assets/pdf/`). */
export const PDF_VIEWER_ASSETS = {
  script: 'viewer.mjs',
  worker: 'pdf.worker.mjs'
} as const

/** The address of a download shown in the viewer. */
export function pdfPageUrl(downloadId: string): string {
  return `${PDF_PAGE_URL}?id=${encodeURIComponent(downloadId)}`
}

/** The download a viewer address shows, or null for any other address. */
export function pdfPageDownloadId(url: string): string | null {
  const m = /^(?:zen|zenium):\/\/pdf\/?\?(.*)$/i.exec(url)
  if (!m) return null
  const id = new URLSearchParams(m[1]).get('id')
  return id && id.trim() ? id : null
}

/** What the shell needs to know about the document it shows. */
export interface PdfDocumentInfo {
  /** The download's id (the page's address). */
  id: string
  /** The file's name: the document's title until its metadata names one. */
  name: string
  /** The file's location on the host, for the host to serve; never reaches the document. */
  path: string
  /**
   * The document's own address, the download's URL: what the viewer's document runs under
   * (`pdfViewerBaseUrl`) and what the tab reads as to extensions. Empty when unknown.
   */
  url: string
  /**
   * A secret of this document's, written into the shell and posted beside every report
   * (`pdfViewerProtocol.ts`): the core takes a report for the tab only with it, since the
   * document's origin is the PDF's, which any page of that origin shares.
   */
  token: string
}

/** Resolves `zen://pdf?id=…` to the download it shows (null once the file is gone). */
export type PdfPageLookup = (id: string) => PdfDocumentInfo | null

/**
 * The base URL the host loads the shell with (`loadDataWithBaseURL`): the document's own
 * http(s) address, so the document runs under it as under Chrome's viewer; the viewer's origin
 * for a document that has none (never `zen://`, which has no origin to fetch from).
 */
export function pdfViewerBaseUrl(doc: Pick<PdfDocumentInfo, 'url'>): string {
  return /^https?:\/\/[^/]+/i.test(doc.url) ? doc.url : `${PDF_VIEWER_ORIGIN}/`
}

/** The document's own address for its bytes, and the viewer's files, under the viewer's origin. */
export function pdfViewerDocumentUrl(): string {
  return `${PDF_VIEWER_ORIGIN}${PDF_VIEWER_DOCUMENT_PATH}`
}

export function pdfViewerAssetUrl(name: string): string {
  return `${PDF_VIEWER_ORIGIN}${PDF_VIEWER_ASSET_PREFIX}${name}`
}

/**
 * Which file under the viewer's origin a request asks for: a viewer asset by name, the
 * document, or nothing (any other path is a 404). The host's interception is the one place
 * these requests can be answered from, so the mapping is spelt out here and tested.
 */
export type PdfViewerRequest = { kind: 'asset'; name: string } | { kind: 'document' } | null

export function pdfViewerRequestFor(url: string): PdfViewerRequest {
  if (!url.startsWith(PDF_VIEWER_ORIGIN)) return null
  const path = url.slice(PDF_VIEWER_ORIGIN.length).split(/[?#]/, 1)[0]
  if (path === PDF_VIEWER_DOCUMENT_PATH) return { kind: 'document' }
  if (path.startsWith(PDF_VIEWER_ASSET_PREFIX)) {
    // The viewer's own files, and pdf.js's data one folder down (`cmaps/`, `standard_fonts/`,
    // `wasm/`, `iccs/`); nothing that could climb out of the assets folder.
    const name = path.slice(PDF_VIEWER_ASSET_PREFIX.length)
    if (/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)?$/.test(name))
      return { kind: 'asset', name }
  }
  return null
}

/** The content type the host answers a viewer asset with. */
export function pdfViewerAssetMime(name: string): string {
  if (/\.(?:m?js)$/.test(name)) return 'text/javascript'
  if (name.endsWith('.css')) return 'text/css'
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  if (name.endsWith('.wasm')) return 'application/wasm'
  if (name.endsWith('.ttf')) return 'font/ttf'
  if (name.endsWith('.icc')) return 'application/vnd.iccprofile'
  return 'application/octet-stream'
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The viewer's document. The pages are drawn by the viewer script into `#pages`; the chrome's
 * own colours are not available to a document, so the shell keeps Chrome's viewer grey behind
 * the pages in both schemes (the light scheme's grey first, for a WebView without
 * `light-dark()`). Pinch zoom is the viewer's (`touch-action` keeps the engine's away), a
 * single finger scrolls as on any page.
 *
 * The pages pan inside `#scroller`, a box the size of the screen, not the window: a WebView
 * with a wide viewport (Android's `useWideViewPort`, on for every page in the tab) grows the
 * layout viewport to the content's width once a page is wider than the screen – past the fit,
 * 1450 css px of page in a 400 px screen gave a 1472 x 2786 px layout viewport with the screen
 * a window into it – and the window's scroll, the elements' rects and its height then measure
 * that viewport rather than the screen (the page indicator read the page under the layout
 * viewport's top, a go-to could not reach the last page). A document that never overflows the
 * window keeps the layout viewport at the screen's size, and every measurement against the
 * scroller is a measurement of the screen.
 *
 * The body opens with the plugin element Chrome's PDF viewer's top document holds (`<embed
 * type="application/pdf" src="about:blank">`, the shape Chrome's viewer page is generated with):
 * an extension's content script running in the document, as it does in Chrome's, tells a PDF
 * tab by it (Kami's "Open with Kami" looks for that embed, or for the closed-shadow-root frame
 * of Chrome's newer viewer). It is hidden and draws nothing: the WebView has no PDF plugin, and
 * the pages are the viewer's own.
 */
export function pdfViewerPageHtml(doc: Pick<PdfDocumentInfo, 'id' | 'name' | 'token'>): string {
  // Inside a script element: a `<` of the file's name (the server's to choose) must not read as
  // the element's end.
  const config = JSON.stringify({
    id: doc.id,
    name: doc.name,
    token: doc.token,
    src: pdfViewerDocumentUrl(),
    workerSrc: pdfViewerAssetUrl(PDF_VIEWER_ASSETS.worker)
  }).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${escapeHtml(doc.name)}</title><style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #525659; background: light-dark(#525659, #3b3b3d); touch-action: pan-x pan-y; overscroll-behavior: contain; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f0f0f5; color: light-dark(#1e1e24, #f0f0f5); }
  #scroller { position: fixed; inset: 0; overflow: auto; touch-action: pan-x pan-y; overscroll-behavior: contain; }
  #pages { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px 8px 24px; box-sizing: border-box; width: max-content; min-width: 100%; transform-origin: 0 0; }
  .zen-pdf-page { position: relative; flex: none; background: #fff; box-shadow: 0 1px 4px #0006; overflow: hidden; }
  .zen-pdf-page > canvas { display: block; width: 100%; height: 100%; }
  .zen-pdf-hits, .zen-pdf-links { position: absolute; inset: 0; pointer-events: none; }
  .zen-pdf-hit { position: absolute; background: #ffeb3b80; }
  .zen-pdf-hit.current { background: #ff980099; outline: 1px solid #ff9800; }
  .zen-pdf-link { position: absolute; display: block; pointer-events: auto; }
  .zen-pdf-status { position: fixed; inset: 0; display: grid; place-items: center; text-align: center; padding: 32px; color: #f0f0f5; }
  .zen-pdf-status[hidden] { display: none; }
  .zen-pdf-status p { max-width: 420px; line-height: 1.5; margin: 0; }
</style><script>window.__zeniumPdfDocument=${config}</script></head>
<body><embed name="plugin" type="application/pdf" src="about:blank" internalid="${escapeHtml(doc.id)}" hidden><div id="scroller"><div id="pages"></div></div><div id="status" class="zen-pdf-status"><p>Loading…</p></div>
<script type="module" src="${pdfViewerAssetUrl(PDF_VIEWER_ASSETS.script)}"></script></body></html>`
}

/** The page for a viewer address whose download is gone (deleted, cleared from the list). */
export function pdfMissingPageHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PDF</title><style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { background: transparent; color: light-dark(#1e1e24, #f0f0f5); display: grid; place-items: center; }
  .card { max-width: 480px; padding: 32px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
  p { margin: 0; line-height: 1.5; opacity: .8; }
</style></head>
<body><div class="card">
  <h1>This file is no longer available</h1>
  <p>The PDF was moved or deleted. Download it again to open it.</p>
</div></body></html>`
}
