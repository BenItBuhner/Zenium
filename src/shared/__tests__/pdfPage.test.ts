import { describe, expect, it } from 'vitest'
import {
  PDF_VIEWER_ORIGIN,
  pdfMissingPageHtml,
  pdfPageDownloadId,
  pdfPageUrl,
  pdfViewerAssetMime,
  pdfViewerAssetUrl,
  pdfViewerDocumentUrl,
  pdfViewerPageHtml,
  pdfViewerRequestFor
} from '../pdfPage'
import {
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  PDF_VIEWER_GLOBAL,
  PDF_VIEWER_MESSAGE_KEY,
  pdfCommandScript,
  pdfReportOf,
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
  const html = pdfViewerPageHtml({ id: 'dl1', name: 'Tide <tables> & "notes".pdf' })

  it('carries the document’s name escaped, its addresses for the script and the viewer’s files', () => {
    expect(html).toContain('<title>Tide &lt;tables&gt; &amp; &quot;notes&quot;.pdf</title>')
    expect(html).toContain(`src="${pdfViewerAssetUrl('viewer.mjs')}"`)
    const config = /window\.__zeniumPdfDocument=(\{.*?\})<\/script>/.exec(html)
    expect(config).not.toBeNull()
    expect(JSON.parse(config![1])).toEqual({
      id: 'dl1',
      name: 'Tide <tables> & "notes".pdf',
      src: pdfViewerDocumentUrl(),
      workerSrc: pdfViewerAssetUrl('pdf.worker.mjs')
    })
  })

  it('keeps the engine’s pinch zoom away and hides the status once the pages are up', () => {
    expect(html).toContain('touch-action: pan-x pan-y')
    expect(html).toContain('.zen-pdf-status[hidden] { display: none; }')
    // A colour the WebView without `light-dark()` can read comes first.
    expect(html).toMatch(/background: #525659; background: light-dark\(/)
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
})
