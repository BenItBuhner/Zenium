import { beforeEach, describe, expect, it } from 'vitest'
import type { UIState } from '@shared/types'
import type { PdfViewerReport } from '@shared/pdfViewerProtocol'
import { folderNameOf } from '../captureOverlay'
import { browserStore } from '../ui'
import {
  canZoomIn,
  canZoomOut,
  clearPdfReport,
  currentOutlineKey,
  dropStalePdfReports,
  flattenOutline,
  formatPdfZoom,
  isPdfViewerTab,
  parsePageNumber,
  PDF_PRINT_REFUSED,
  PDF_SAVE_REFUSED,
  pdfPrintRow,
  pdfSavedMessage,
  pdfSaveRow,
  pdfViewerStore,
  pdfZoomIs,
  setPdfReport
} from '../pdfViewer'

const report = (over: Partial<PdfViewerReport> = {}): PdfViewerReport => ({
  state: 'ready',
  pageCount: 3,
  page: 1,
  zoom: 1,
  fit: 'width',
  title: null,
  find: null,
  outline: [],
  form: { fields: 0, modified: false },
  ...over
})

const stateWith = (tabs: Record<string, string>): UIState =>
  ({
    tabs: Object.fromEntries(Object.entries(tabs).map(([id, url]) => [id, { id, url }]))
  }) as unknown as UIState

describe('pdfViewerStore', () => {
  beforeEach(() => {
    pdfViewerStore.set({ reports: {}, urls: {} })
    browserStore.set({ state: stateWith({ t1: 'zen://pdf?id=d1', t2: 'https://a.test/' }) })
  })

  it('keeps a report under the address the tab showed when it came', () => {
    setPdfReport('t1', report())
    expect(pdfViewerStore.get().reports.t1?.pageCount).toBe(3)
    expect(pdfViewerStore.get().urls.t1).toBe('zen://pdf?id=d1')
    clearPdfReport('t1')
    expect(pdfViewerStore.get()).toEqual({ reports: {}, urls: {} })
  })

  it('drops the report of a tab that moved on – to a page, or to another document – and of one that closed', () => {
    setPdfReport('t1', report())
    setPdfReport('t2', report({ pageCount: 9 }))
    // Nothing moved: nothing goes.
    dropStalePdfReports(stateWith({ t1: 'zen://pdf?id=d1', t2: 'https://a.test/' }))
    expect(Object.keys(pdfViewerStore.get().reports).sort()).toEqual(['t1', 't2'])
    // t1 shows another document for the viewer, t2 is gone.
    dropStalePdfReports(stateWith({ t1: 'zen://pdf?id=d2' }))
    expect(pdfViewerStore.get()).toEqual({ reports: {}, urls: {} })
  })

  it('knows a viewer tab by its address', () => {
    const state = stateWith({ t1: 'zen://pdf?id=d1', t2: 'https://a.test/report.pdf' })
    expect(isPdfViewerTab(state, 't1')).toBe(true)
    expect(isPdfViewerTab(state, 't2')).toBe(false)
    expect(isPdfViewerTab(state, 'nope')).toBe(false)
    expect(isPdfViewerTab(state, null)).toBe(false)
  })
})

describe('the bar’s arithmetic', () => {
  it('formats a zoom as a whole percentage and matches presets with the viewer’s rounding', () => {
    expect(formatPdfZoom(1)).toBe('100%')
    expect(formatPdfZoom(1.254)).toBe('125%')
    expect(formatPdfZoom(0.6667)).toBe('67%')
    expect(pdfZoomIs(1.004, 1)).toBe(true)
    expect(pdfZoomIs(1.006, 1)).toBe(false)
  })

  it('stops zooming at the viewer’s range', () => {
    expect(canZoomOut(0.25)).toBe(false)
    expect(canZoomOut(0.26)).toBe(true)
    expect(canZoomIn(5)).toBe(false)
    expect(canZoomIn(4.99)).toBe(true)
  })

  it('lays the outline flat in reading order, children under their parent, keyed by path', () => {
    const flat = flattenOutline([
      {
        title: 'Week 38',
        page: 1,
        children: [
          { title: 'Springs', page: 1, children: [] },
          { title: 'Crossing', page: null, children: [{ title: 'Deep', page: 2, children: [] }] }
        ]
      },
      { title: 'Week 39', page: 2, children: [] }
    ])
    expect(flat.map((f) => [f.item.title, f.depth, f.key])).toEqual([
      ['Week 38', 0, '0'],
      ['Springs', 1, '0.0'],
      ['Crossing', 1, '0.1'],
      ['Deep', 2, '0.1.0'],
      ['Week 39', 0, '1']
    ])
  })

  it('marks the entry the reader is at: the page’s own heading, else the section begun before it', () => {
    const rows = flattenOutline([
      {
        title: 'Week 38',
        page: 1,
        children: [
          { title: 'Springs', page: 1, children: [] },
          { title: 'Crossing', page: 1, children: [] }
        ]
      },
      { title: 'Week 40', page: 3, children: [] },
      { title: 'Appendix', page: null, children: [] }
    ])
    expect(currentOutlineKey(rows, 1)).toBe('0')
    expect(currentOutlineKey(rows, 2)).toBe('0.1')
    expect(currentOutlineKey(rows, 3)).toBe('1')
    expect(currentOutlineKey(rows, 4)).toBe('1')
    expect(currentOutlineKey(rows, 0)).toBeNull()
    expect(currentOutlineKey([], 2)).toBeNull()
  })

  it('takes only a whole page number the document has', () => {
    expect(parsePageNumber('2', 3)).toBe(2)
    expect(parsePageNumber(' 3 ', 3)).toBe(3)
    expect(parsePageNumber('0', 3)).toBeNull()
    expect(parsePageNumber('4', 3)).toBeNull()
    expect(parsePageNumber('2.5', 3)).toBeNull()
    expect(parsePageNumber('two', 3)).toBeNull()
    expect(parsePageNumber('', 3)).toBeNull()
  })
})

describe('the overflow’s Save and Print rows (CT-44)', () => {
  it('offers Save for a document with a form, enabled once a field changed, and not otherwise', () => {
    // No form: nothing a copy would hold that the file does not – no row.
    expect(pdfSaveRow(report())).toBe('absent')
    expect(pdfSaveRow(null)).toBe('absent')
    // A form untouched: the row at .4 until a field changes.
    expect(pdfSaveRow(report({ form: { fields: 12, modified: false } }))).toBe('disabled')
    expect(pdfSaveRow(report({ form: { fields: 12, modified: true } }))).toBe('enabled')
    // Only an open document has a form to speak of.
    for (const state of ['loading', 'password', 'error'] as const)
      expect(pdfSaveRow(report({ state, form: { fields: 12, modified: true } }))).toBe('absent')
  })

  it('offers Print where the host prints, and like Share needs only the file', () => {
    expect(pdfPrintRow(report(), false)).toBe('absent')
    expect(pdfPrintRow(report({ form: { fields: 3, modified: true } }), false)).toBe('absent')
    expect(pdfPrintRow(report(), true)).toBe('enabled')
    // The file is there whatever the viewer made of it (Share's rule).
    expect(pdfPrintRow(report({ state: 'password' }), true)).toBe('enabled')
    expect(pdfPrintRow(report({ state: 'error' }), true)).toBe('enabled')
    // Not before the document began to load, and not before it reported at all.
    expect(pdfPrintRow(report({ state: 'loading' }), true)).toBe('disabled')
    expect(pdfPrintRow(null, true)).toBe('disabled')
  })

  it('names the destination of a written copy as the capture card does, and states a refusal of the document', () => {
    // Android's public collection – the directory `Download` – is "Downloads" through the shared
    // `folderNameOf`, the one place that names it (the lead's ruling: across both toasts), so the
    // message is the capture card's shape, `Saved to ${folderNameOf(path) || 'Downloads'}`.
    const inDownloads = '/storage/emulated/0/Download/mooring (1).pdf'
    expect(folderNameOf(inDownloads)).toBe('Downloads')
    expect(pdfSavedMessage(inDownloads)).toBe('Saved to Downloads')
    expect(pdfSavedMessage(inDownloads)).toBe(
      `Saved to ${folderNameOf(inDownloads) || 'Downloads'}`
    )
    // Below Android 10 the host writes under its own files: the same folder by name.
    expect(
      pdfSavedMessage('/storage/emulated/0/Android/data/app.zen/files/Download/mooring.pdf')
    ).toBe('Saved to Downloads')
    // A host that names no path answers the row's address: no folder to name.
    expect(pdfSavedMessage('content://media/external/downloads/1042')).toBe('Saved to Downloads')
    expect(pdfSavedMessage('mooring.pdf')).toBe('Saved to Downloads')
    // Any other folder by its own name – the shared reading (`folderNameOf`).
    expect(pdfSavedMessage('/storage/emulated/0/Documents/Forms/mooring.pdf')).toBe(
      'Saved to Forms'
    )
    // One clause each, uncontracted, stated of the thing (the register).
    expect(PDF_SAVE_REFUSED).toBe('This PDF cannot be saved.')
    expect(PDF_PRINT_REFUSED).toBe('This PDF cannot be printed.')
  })
})
