import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

/**
 * pdf.js for the chrome's own surfaces (the print preview draws the PDF `printToPDF` rendered
 * with it; `src/android/pdfViewer.ts` is the Android viewer document's copy). Loaded on first
 * use so the library is a chunk of its own, never part of the chrome's start-up bundle. The
 * worker is inlined and started from a blob: the packaged chrome is a `file://` document, from
 * which Chromium refuses a worker script by URL, and a blob it made itself is the one form it
 * takes there; the dev server's `http://` origin takes either.
 *
 * Nothing but the document's own bytes is fetched: a PDF Chromium printed embeds every font it
 * uses, so no standard-font or character-map data is asked for.
 */
type Pdfjs = typeof import('pdfjs-dist')

let loading: Promise<Pdfjs> | null = null

export function loadPdfjs(): Promise<Pdfjs> {
  loading ??= (async () => {
    const [pdfjs, { default: PdfWorker }] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?worker&inline')
    ])
    if (!pdfjs.GlobalWorkerOptions.workerPort)
      pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()
    return pdfjs
  })().catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

/** A base64 string as bytes (the form `print.preview` hands the render over in). */
export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Open a PDF from its bytes; the caller `closePdf`s the document when done with it. */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs()
  return pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise
}

/** Release a document's pages and worker-side state (pdf.js 6 frees through the loading task). */
export function closePdf(doc: PDFDocumentProxy | null | undefined): void {
  void doc?.loadingTask.destroy().catch(() => undefined)
}

/** A page's size in CSS pixels at 100 % (pdf.js's 72 points per inch at 96 CSS pixels per inch). */
export function pageSizeAt(page: PDFPageProxy, scale: number): { width: number; height: number } {
  const viewport = page.getViewport({ scale: (96 / 72) * scale })
  return { width: viewport.width, height: viewport.height }
}

/**
 * Draw a page onto `canvas` at `scale` (1 = the page's size on a 96 dpi screen), for the
 * device's pixel ratio; the canvas's CSS size is set to the page's. Resolves when the drawing
 * is done or was cancelled by a later call on the same canvas.
 */
export async function drawPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
  pixelRatio = window.devicePixelRatio || 1
): Promise<void> {
  const viewport = page.getViewport({ scale: (96 / 72) * scale * pixelRatio })
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  canvas.style.width = `${Math.round(viewport.width / pixelRatio)}px`
  canvas.style.height = `${Math.round(viewport.height / pixelRatio)}px`
  try {
    await page.render({ canvas, viewport }).promise
  } catch (error) {
    // A render superseded by the next one on this canvas is cancelled by pdf.js and is no error.
    if ((error as { name?: string } | null)?.name !== 'RenderingCancelledException') throw error
  }
}
