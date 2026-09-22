import { describe, expect, it } from 'vitest'
import { looksLikeStatements } from '../../core/agent/util'
import {
  PDF_VIEWER_DOCUMENT_ATTRIBUTE,
  PDF_VIEWER_ORIGIN,
  pdfMissingPageHtml,
  pdfPageDownloadId,
  pdfPageUrl,
  pdfViewerAssetMime,
  pdfViewerAssetUrl,
  pdfViewerBaseUrl,
  pdfViewerDocumentUrl,
  pdfViewerPageHtml,
  pdfViewerRequestFor
} from '../pdfPage'
import {
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  PDF_VIEWER_GLOBAL,
  PDF_VIEWER_MESSAGE_KEY,
  PDF_VIEWER_TOKEN_KEY,
  pdfCommandScript,
  pdfReportOf,
  pdfReportTokenOf,
  steppedZoom
} from '../pdfViewerProtocol'

describe('the viewer page’s address', () => {
  it('names the download it shows, and reads it back from either scheme', () => {
    expect(pdfPageUrl('dl 1')).toBe('zen://pdf?id=dl%201')
    expect(pdfPageDownloadId('zen://pdf?id=dl%201')).toBe('dl 1')
    expect(pdfPageDownloadId('zenium://pdf/?id=abc&x=1')).toBe('abc')
  })

  it('is nothing for any other address, or one without a download', () => {
    expect(pdfPageDownloadId('zen://pdf')).toBeNull()
    expect(pdfPageDownloadId('zen://pdf?id=')).toBeNull()
    expect(pdfPageDownloadId('zen://settings?id=abc')).toBeNull()
    expect(pdfPageDownloadId('https://example.com/pdf?id=abc')).toBeNull()
  })
})

describe('what the host serves under the viewer’s origin', () => {
  it('answers the document and the viewer’s files, pdf.js’s data one folder down', () => {
    expect(pdfViewerRequestFor(pdfViewerDocumentUrl())).toEqual({ kind: 'document' })
    expect(pdfViewerRequestFor(pdfViewerAssetUrl('viewer.mjs'))).toEqual({
      kind: 'asset',
      name: 'viewer.mjs'
    })
    expect(pdfViewerRequestFor(`${PDF_VIEWER_ORIGIN}/viewer/pdf.worker.mjs?v=1#x`)).toEqual({
      kind: 'asset',
      name: 'pdf.worker.mjs'
    })
    expect(
      pdfViewerRequestFor(`${PDF_VIEWER_ORIGIN}/viewer/cmaps/Adobe-Japan1-UCS2.bcmap`)
    ).toEqual({
      kind: 'asset',
      name: 'cmaps/Adobe-Japan1-UCS2.bcmap'
    })
    expect(pdfViewerRequestFor(`${PDF_VIEWER_ORIGIN}/viewer/standard_fonts/FoxitSans.pfb`)).toEqual(
      {
        kind: 'asset',
        name: 'standard_fonts/FoxitSans.pfb'
      }
    )
  })

  it('answers nothing that could climb out of the assets folder, and nothing off the origin', () => {
    expect(pdfViewerRequestFor(`${PDF_VIEWER_ORIGIN}/viewer/../secret`)).toBeNull()
    expect(pdfViewerRequestFor(`${PDF_VIEWER_ORIGIN}/viewer/.hidden`)).toBeNull()
    expect(pdfViewerRequestFor(`${PDF_VIEWER_ORIGIN}/viewer/a/b/c.js`)).toBeNull()
    expect(pdfViewerRequestFor(`${PDF_VIEWER_ORIGIN}/viewer/`)).toBeNull()
    expect(pdfViewerRequestFor(`${PDF_VIEWER_ORIGIN}/other.pdf`)).toBeNull()
    expect(pdfViewerRequestFor('https://pdf.zenium.invalid.example/document.pdf')).toBeNull()
    expect(pdfViewerRequestFor('https://example.com/document.pdf')).toBeNull()
  })

  it('types the files it serves', () => {
    expect(pdfViewerAssetMime('viewer.mjs')).toBe('text/javascript')
    expect(pdfViewerAssetMime('pdf.worker.mjs')).toBe('text/javascript')
    expect(pdfViewerAssetMime('wasm/openjpeg.wasm')).toBe('application/wasm')
    expect(pdfViewerAssetMime('standard_fonts/LiberationSans-Regular.ttf')).toBe('font/ttf')
    expect(pdfViewerAssetMime('iccs/CGATS001Compat-v2-micro.icc')).toBe(
      'application/vnd.iccprofile'
    )
    expect(pdfViewerAssetMime('cmaps/Adobe-Japan1-UCS2.bcmap')).toBe('application/octet-stream')
  })
})

describe('the viewer document', () => {
  const html = pdfViewerPageHtml({
    id: 'dl1',
    name: 'Tide <tables> & "notes".pdf',
    token: 'tok-1'
  })

  it('carries the document’s name escaped, its token, its addresses for the script and the viewer’s files', () => {
    expect(html).toContain('<title>Tide &lt;tables&gt; &amp; &quot;notes&quot;.pdf</title>')
    expect(html).toContain(`src="${pdfViewerAssetUrl('viewer.mjs')}"`)
    const config = /window\.__zeniumPdfDocument=(\{.*?\})<\/script>/.exec(html)
    expect(config).not.toBeNull()
    expect(JSON.parse(config![1])).toEqual({
      id: 'dl1',
      name: 'Tide <tables> & "notes".pdf',
      token: 'tok-1',
      src: pdfViewerDocumentUrl(),
      workerSrc: pdfViewerAssetUrl('pdf.worker.mjs')
    })
  })

  it('keeps a name that spells a script element’s end inside the config', () => {
    const tricky = pdfViewerPageHtml({ id: 'dl1', name: '</script><script>x()//.pdf', token: 't' })
    expect(tricky).not.toContain('</script><script>x()')
    const config = /window\.__zeniumPdfDocument=(\{.*?\})<\/script>/.exec(tricky)
    expect(JSON.parse(config![1]).name).toBe('</script><script>x()//.pdf')
  })

  it('opens the body with the hidden plugin element of Chrome’s viewer document, which content scripts tell a PDF tab by', () => {
    // The shape Kami's "Open with Kami" looks for: an embed of the PDF type whose src is
    // `about:blank` (Chrome's viewer page), first in the body; it draws nothing here.
    expect(html).toMatch(
      /<body><embed name="plugin" type="application\/pdf" src="about:blank" internalid="dl1" hidden>/
    )
    // The root carries the mark by which an extension's realm makes `document.contentType`
    // answer `application/pdf` here (`android/extensionPdfDocument.ts`).
    expect(html).toMatch(
      new RegExp(`^<!doctype html><html lang="en" ${PDF_VIEWER_DOCUMENT_ATTRIBUTE}>`)
    )
  })

  it('runs under the document’s own http(s) address, else on the viewer’s origin', () => {
    expect(pdfViewerBaseUrl({ url: 'https://example.test/papers/report.pdf?v=2#page=3' })).toBe(
      'https://example.test/papers/report.pdf?v=2#page=3'
    )
    expect(pdfViewerBaseUrl({ url: 'http://10.0.2.2:8765/sample.pdf' })).toBe(
      'http://10.0.2.2:8765/sample.pdf'
    )
    expect(pdfViewerBaseUrl({ url: '' })).toBe(`${PDF_VIEWER_ORIGIN}/`)
    expect(pdfViewerBaseUrl({ url: 'blob:https://example.test/abc' })).toBe(`${PDF_VIEWER_ORIGIN}/`)
    expect(pdfViewerBaseUrl({ url: 'content://downloads/1' })).toBe(`${PDF_VIEWER_ORIGIN}/`)
  })

  it('keeps the engine’s pinch zoom away and hides the status once the pages are up', () => {
    expect(html).toContain('touch-action: pan-x pan-y')
    expect(html).toContain('.zen-pdf-status[hidden] { display: none; }')
    // A colour the WebView without `light-dark()` can read comes first.
    expect(html).toMatch(/background: #525659; background: light-dark\(/)
  })

  it('pans the pages in a scroller the size of the screen, so a wide viewport never grows the window', () => {
    expect(html).toContain('<div id="scroller"><div id="pages"></div></div>')
    expect(html).toMatch(/#scroller \{[^}]*position: fixed; inset: 0; overflow: auto;/)
    expect(html).toMatch(/html, body \{[^}]*overflow: hidden;/)
  })

  it('has a page for a download that is gone', () => {
    expect(pdfMissingPageHtml()).toContain('This file is no longer available')
  })
})

describe('the protocol between the viewer and the chrome', () => {
  it('steps the zoom along Chrome’s presets, the nearest preset counting as the current one', () => {
    expect(steppedZoom(1, 1)).toBe(1.1)
    expect(steppedZoom(1, -1)).toBe(0.9)
    expect(steppedZoom(0.4992, 2)).toBe(0.75)
    // Between two presets a step reaches the next one in its direction, not the one past it.
    expect(steppedZoom(0.6, 1)).toBe(0.67)
    expect(steppedZoom(0.6, -1)).toBe(0.5)
    expect(steppedZoom(PDF_MAX_ZOOM, 3)).toBe(PDF_MAX_ZOOM)
    expect(steppedZoom(PDF_MIN_ZOOM, -3)).toBe(PDF_MIN_ZOOM)
  })

  it('hands a command to the document’s global and says whether it was there', () => {
    const script = pdfCommandScript({ kind: 'find', query: 'a"b', direction: 'new' })
    expect(script).toContain(`window[${JSON.stringify(PDF_VIEWER_GLOBAL)}]`)
    expect(script).toContain('{"kind":"find","query":"a\\"b","direction":"new"}')
    const taken: unknown[] = []
    const run = (window: Record<string, unknown>): boolean =>
      new Function('window', `return ${script}`)(window) as boolean
    expect(run({})).toBe(false)
    expect(run({ [PDF_VIEWER_GLOBAL]: { command: (c: unknown) => taken.push(c) } })).toBe(true)
    expect(taken).toEqual([{ kind: 'find', query: 'a"b', direction: 'new' }])
  })

  it('is one expression to a host that tells them from statements without a parser', () => {
    // Android's `executeJavaScript` wraps what reads as a statement list into a function and
    // loses its value; the chrome would then take every command for one the document refused.
    expect(looksLikeStatements(pdfCommandScript({ kind: 'goTo', page: 2 }))).toBe(false)
    expect(looksLikeStatements(pdfCommandScript({ kind: 'stopFind' }))).toBe(false)
  })

  it('reads a report out of the viewer’s window message and nothing else', () => {
    const report = {
      state: 'ready',
      pageCount: 3,
      page: 1,
      zoom: 0.5,
      fit: 'width',
      title: null,
      find: null,
      outline: []
    }
    expect(pdfReportOf({ [PDF_VIEWER_MESSAGE_KEY]: report })).toEqual(report)
    expect(pdfReportOf({ [PDF_VIEWER_MESSAGE_KEY]: { ...report, state: 'odd' } })).toBeNull()
    expect(pdfReportOf({ [PDF_VIEWER_MESSAGE_KEY]: { ...report, page: '1' } })).toBeNull()
    expect(pdfReportOf({ other: report })).toBeNull()
    expect(pdfReportOf('zeniumPdf')).toBeNull()
    expect(pdfReportOf(null)).toBeNull()
  })

  it('reads the document’s token beside the report, and nothing for a message without one', () => {
    expect(pdfReportTokenOf({ [PDF_VIEWER_MESSAGE_KEY]: {}, [PDF_VIEWER_TOKEN_KEY]: 'tok' })).toBe(
      'tok'
    )
    expect(pdfReportTokenOf({ [PDF_VIEWER_TOKEN_KEY]: '' })).toBeNull()
    expect(pdfReportTokenOf({ [PDF_VIEWER_TOKEN_KEY]: 7 })).toBeNull()
    expect(pdfReportTokenOf({})).toBeNull()
    expect(pdfReportTokenOf(null)).toBeNull()
  })
})
