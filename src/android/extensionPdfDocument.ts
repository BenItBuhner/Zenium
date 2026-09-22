import { PDF_VIEWER_DOCUMENT_ATTRIBUTE } from '@shared/pdfPage'

/**
 * The phone's PDF viewer document, read by an extension as Chrome's.
 *
 * Chrome presents a PDF as a document at the PDF's own URL (a plugin document over an
 * `<embed type="application/pdf">`) whose `document.contentType` is `application/pdf`; an
 * extension's PDF handler runs its content script there and tells the PDF by that type
 * (Google Scholar PDF Reader: `document.contentType.toLowerCase() === 'application/pdf'` at
 * `DOMContentLoaded`, then replaces the body with its reader; its worker asks
 * `executeScript(() => document.contentType)` before it acts on a frame). The phone's viewer
 * (`shared/pdfPage.ts`) already stands where Chrome's does: an HTML shell loaded under the PDF's
 * URL, with the plugin element first in its body; the WebView, though, reads the shell as
 * `text/html`. So in the extension's realm the shell's document answers `application/pdf`:
 * the getter goes on the realm's `Document.prototype` (the world's own with isolated worlds,
 * the page's under the `with` fallback, where the viewer's own script never reads it), for this
 * document alone; a document the extension parses itself (`DOMParser`) keeps its own type.
 *
 * Installed once per document at document start, only in the viewer's document (the shell's
 * root element carries `PDF_VIEWER_DOCUMENT_ATTRIBUTE`); anywhere else nothing is touched.
 */
export function installPdfDocumentType(win: Window & typeof globalThis): boolean {
  const doc = win.document
  const root = doc?.documentElement
  if (!root || !root.hasAttribute(PDF_VIEWER_DOCUMENT_ATTRIBUTE)) return false
  const owner = contentTypeOwner(doc)
  if (!owner) return false
  const { proto, descriptor } = owner
  const nativeGet = descriptor.get as (this: Document) => string
  Object.defineProperty(proto, 'contentType', {
    ...descriptor,
    get(this: Document): string {
      return this === doc ? 'application/pdf' : nativeGet.call(this)
    }
  })
  return true
}

/**
 * The prototype on the document's own chain that owns the `contentType` accessor: the realm's
 * `Document.prototype` in a browser, found by walking rather than by name so the getter lands on
 * the object the document actually reads through.
 */
function contentTypeOwner(
  doc: Document
): { proto: object; descriptor: PropertyDescriptor & { get: () => string } } | null {
  for (
    let proto = Object.getPrototypeOf(doc) as object | null;
    proto;
    proto = Object.getPrototypeOf(proto)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'contentType')
    if (!descriptor) continue
    if (!descriptor.get || !descriptor.configurable) return null
    return { proto, descriptor: descriptor as PropertyDescriptor & { get: () => string } }
  }
  return null
}
