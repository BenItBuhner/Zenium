import { beforeEach, describe, expect, it } from 'vitest'
import type { UIState } from '@shared/types'
import type { PdfViewerReport } from '@shared/pdfViewerProtocol'
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
