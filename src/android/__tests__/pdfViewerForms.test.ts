import { describe, expect, it } from 'vitest'
import {
  bytesToBase64,
  PDF_FORMS_CSS,
  PDF_FORMS_LAYER_CLASS,
  pdfFormLinkService
} from '../pdfViewerForms'

describe('the form layer’s stylesheet', () => {
  it('is flat CSS, every rule the viewer’s own, with nothing the WebView floor lacks', () => {
    // One level of braces: no rule opens inside another (Chromium 113 has no CSS nesting).
    let depth = 0
    for (const ch of PDF_FORMS_CSS) {
      if (ch === '{') depth++
      if (ch === '}') depth--
      expect(depth).toBeGreaterThanOrEqual(0)
      expect(depth).toBeLessThanOrEqual(1)
    }
    expect(depth).toBe(0)
    expect(PDF_FORMS_CSS).not.toContain('&')
    // pdf.js sizes its layer with `round()`, which the floor has not got: the viewer sets pixels.
    expect(PDF_FORMS_CSS).not.toMatch(/round\(/)
    // Every selector is keyed on the viewer's page or its layer: nothing of the document's own
    // page can match, and pdf.js's class names reach no further than the layer.
    const selectors = PDF_FORMS_CSS.split('}')
      .map((rule) => rule.split('{')[0].trim())
      .filter(Boolean)
    expect(selectors.length).toBeGreaterThan(30)
    for (const group of selectors)
      for (const selector of group.split('\n'))
        expect(selector.trim()).toMatch(/^\.zen-pdf-(page|forms)(\s|\[|$)/)
    // The widgets pdf.js draws itself toggle their faces on the input's state.
    expect(PDF_FORMS_CSS).toContain('[data-canvas-name="checked"]:has(~ input:checked)')
    expect(PDF_FORMS_CSS).toContain(
      '--total-scale-factor: calc(var(--scale-factor) * var(--user-unit))'
    )
    expect(PDF_FORMS_LAYER_CLASS.split(' ')).toEqual(['zen-pdf-forms', 'annotationLayer'])
  })
})

describe('the layer’s link service', () => {
  it('moves the viewer for destinations and the paging named actions, and for nothing else', async () => {
    const moves: unknown[] = []
    const service = pdfFormLinkService({
      goToDestination: (dest) => moves.push(['dest', dest]),
      goToPage: (target) => moves.push(['page', target])
    })
    await service.goToDestination('chapter-2')
    const explicit = [{ num: 3, gen: 0 }, { name: 'XYZ' }, 0, 0, null]
    await service.goToDestination(explicit)
    await service.goToDestination(42)
    await service.goToDestination(null)
    for (const action of ['NextPage', 'PrevPage', 'FirstPage', 'LastPage', 'Print', 'SaveAs'])
      service.executeNamedAction(action)
    service.executeSetOCGState({ state: [], preserveRB: true })
    expect(moves).toEqual([
      ['dest', 'chapter-2'],
      ['dest', explicit],
      ['page', 'next'],
      ['page', 'prev'],
      ['page', 'first'],
      ['page', 'last']
    ])
    // What pdf.js's elements read of a link service: no event bus (no scripting sandbox), not a
    // presentation, external links allowed, and anchors that go nowhere of their own.
    expect(service.eventBus).toBeNull()
    expect(service.isInPresentationMode).toBe(false)
    expect(service.externalLinkEnabled).toBe(true)
    expect(service.getDestinationHash('chapter-2')).toBe('#')
    expect(service.getAnchorUrl('')).toBe('#')
    await expect(service.getAttachmentContent('a1')).resolves.toBeNull()
  })

  it('binds a push button’s link to http(s) addresses only, as the viewer’s link layer does', () => {
    const service = pdfFormLinkService({ goToDestination: () => {}, goToPage: () => {} })
    const anchor = (): HTMLAnchorElement =>
      ({ href: '', rel: '', target: '' }) as unknown as HTMLAnchorElement
    const web = anchor()
    service.addLinkAttributes(web, 'https://harbour.example/fees', true)
    expect(web).toEqual({
      href: 'https://harbour.example/fees',
      rel: 'noreferrer',
      target: '_blank'
    })
    const same = anchor()
    service.addLinkAttributes(same, 'http://harbour.example/')
    expect(same).toEqual({ href: 'http://harbour.example/', rel: 'noreferrer', target: '' })
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:x@y', 'intent://x'])
      service.addLinkAttributes(same, url)
    expect(same.href).toBe('http://harbour.example/')
  })
})

describe('bytesToBase64', () => {
  it('encodes any length as Node does, past the slice the argument list is split at', () => {
    for (const length of [0, 1, 2, 3, 4, 0x7fff, 0x8000, 0x8001, 200_003]) {
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i++) bytes[i] = (i * 7919 + 13) & 0xff
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    }
    expect(bytesToBase64(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe('JVBERi0x')
  })
})
