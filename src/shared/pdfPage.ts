/**
 * The PDF viewer page, `zen://pdf?id=<download>` (`internalPages.ts`, `core/pdf.ts`): Chrome
 * Android's inline PDF viewer for a host whose engine cannot draw a PDF. A PDF the tab navigates
 * to is downloaded like any file – it shows in Downloads – and, complete, opens in this page in
 * the same tab. The document is a shell over pdf.js: the host serves the viewer's script, the
 * pdf.js worker and the download's bytes from `PDF_VIEWER_ORIGIN` (`pdfViewerProtocol.ts`),
 * which the shell's URLs point at, while the tab's address stays `zen://pdf`.
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
  script: 'viewer.js',
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
}

/** Resolves `zen://pdf?id=…` to the download it shows (null once the file is gone). */
export type PdfPageLookup = (id: string) => PdfDocumentInfo | null

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
    const name = path.slice(PDF_VIEWER_ASSET_PREFIX.length)
    if (/^[A-Za-z0-9_.-]+$/.test(name) && !name.startsWith('.')) return { kind: 'asset', name }
  }
  return null
}

/** The content type the host answers a viewer asset with. */
export function pdfViewerAssetMime(name: string): string {
  if (/\.(?:m?js)$/.test(name)) return 'text/javascript'
  if (name.endsWith('.css')) return 'text/css'
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.svg')) return 'image/svg+xml'
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
 * the pages in both schemes. Pinch zoom is the viewer's (`touch-action` keeps the engine's
 * away), a single finger scrolls as on any page.
 */
export function pdfViewerPageHtml(doc: Pick<PdfDocumentInfo, 'id' | 'name'>): string {
  const config = JSON.stringify({
    id: doc.id,
    name: doc.name,
    src: pdfViewerDocumentUrl(),
    workerSrc: pdfViewerAssetUrl(PDF_VIEWER_ASSETS.worker)
  })
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${escapeHtml(doc.name)}</title><style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; min-height: 100%; background: light-dark(#525659, #3b3b3d); touch-action: pan-x pan-y; overscroll-behavior: contain; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: light-dark(#1e1e24, #f0f0f5); }
  #pages { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px 0 24px; transform-origin: 0 0; }
  .zen-pdf-page { position: relative; background: #fff; box-shadow: 0 1px 4px #0006; overflow: hidden; }
  .zen-pdf-page > canvas { display: block; }
  .zen-pdf-hits { position: absolute; inset: 0; pointer-events: none; }
  .zen-pdf-hit { position: absolute; background: #ffeb3b80; }
  .zen-pdf-hit.current { background: #ff980099; outline: 1px solid #ff9800; }
  .zen-pdf-status { position: fixed; inset: 0; display: grid; place-items: center; text-align: center; padding: 32px; color: #f0f0f5; }
  .zen-pdf-status p { max-width: 420px; line-height: 1.5; margin: 0; }
</style><script>window.__zeniumPdfDocument=${config}</script></head>
<body><div id="pages"></div><div id="status" class="zen-pdf-status"><p>Loading…</p></div>
<script src="${pdfViewerAssetUrl(PDF_VIEWER_ASSETS.script)}"></script></body></html>`
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
