// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { PDF_VIEWER_DOCUMENT_ATTRIBUTE } from '@shared/pdfPage'
import { installPdfDocumentType } from '../extensionPdfDocument'

const win = window as Window & typeof globalThis

/** The prototype on the document's chain that owns `contentType` (the realm's Document.prototype). */
function owner(): { proto: object; descriptor: PropertyDescriptor } {
  for (
    let proto = Object.getPrototypeOf(document) as object | null;
    proto;
    proto = Object.getPrototypeOf(proto)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'contentType')
    if (descriptor) return { proto, descriptor }
  }
  throw new Error('no contentType accessor on the document chain')
}

describe('installPdfDocumentType: the viewer document reads as application/pdf to an extension', () => {
  it('leaves any other document alone', () => {
    document.documentElement.removeAttribute(PDF_VIEWER_DOCUMENT_ATTRIBUTE)
    const before = document.contentType
    const native = owner()
    expect(installPdfDocumentType(win)).toBe(false)
    expect(document.contentType).toBe(before)
    expect(owner().descriptor.get).toBe(native.descriptor.get)
  })

  it("answers Chrome's type for the shell's document and the native one for a document the extension parses", () => {
    document.documentElement.setAttribute(PDF_VIEWER_DOCUMENT_ATTRIBUTE, '')
    const native = owner()
    expect(installPdfDocumentType(win)).toBe(true)
    // The getter landed on the realm's Document.prototype, not on the document itself.
    expect(Object.getOwnPropertyDescriptor(document, 'contentType')).toBeUndefined()
    expect(owner().proto).toBe(native.proto)
    // Scholar's own test, and its worker's `executeScript(() => document.contentType)`.
    expect(document.contentType.toLowerCase()).toBe('application/pdf')
    const parsed = new win.DOMParser().parseFromString('<p>x</p>', 'text/html')
    expect(parsed.contentType).toBe(native.descriptor.get!.call(parsed))
    expect(parsed.contentType).not.toBe('application/pdf')
    // The body Scholar puts in place of the plugin's is still this document's.
    const body = document.createElement('body')
    body.appendChild(document.createElement('iframe'))
    document.documentElement.replaceChild(body, document.body)
    expect(document.body).toBe(body)
    expect(document.contentType).toBe('application/pdf')
    // Installing twice is idempotent: the getter chains onto the first one, and the answer holds.
    expect(installPdfDocumentType(win)).toBe(true)
    expect(document.contentType).toBe('application/pdf')
    Object.defineProperty(native.proto, 'contentType', native.descriptor)
    document.documentElement.removeAttribute(PDF_VIEWER_DOCUMENT_ATTRIBUTE)
    expect(document.contentType).not.toBe('application/pdf')
  })
})
