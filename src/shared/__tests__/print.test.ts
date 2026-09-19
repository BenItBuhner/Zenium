import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MARGIN_INCHES,
  PAPER_SIZES,
  PRINT_MESSAGES,
  collapsePages,
  defaultPaperSizeFor,
  defaultPdfFileName,
  defaultPrintSettings,
  destinationLabel,
  initialDestination,
  openingSettings,
  pageRangeText,
  pagesToPrint,
  parsePageRanges,
  pdfRenderOptions,
  primaryLabel,
  printJobOptions,
  printSummary,
  printerDuplex,
  sanitizePrintSettings,
  stickyOf,
  twoSidedAvailable,
  validateCopies,
  validateScale,
  type PrinterDescription,
  type PrintSettings
} from '../print'

const office: PrinterDescription = {
  name: 'Office_HP',
  displayName: 'Office HP',
  description: '',
  isDefault: true,
  duplex: true
}
const simplex: PrinterDescription = {
  name: 'Simplex',
  displayName: 'Simplex printer',
  description: '',
  isDefault: false,
  duplex: false
}

function settings(patch: Partial<PrintSettings> = {}): PrintSettings {
  return { ...defaultPrintSettings('en-US'), ...patch }
}

describe('page ranges', () => {
  it("parses Chrome's grammar: pages, runs, open runs and whitespace", () => {
    expect(parsePageRanges('1-5, 8, 11-13', 20)).toEqual({
      ok: true,
      ranges: [
        { from: 1, to: 5 },
        { from: 8, to: 8 },
        { from: 11, to: 13 }
      ]
    })
    expect(parsePageRanges(' 3 - ', 7)).toEqual({ ok: true, ranges: [{ from: 3, to: 7 }] })
    expect(parsePageRanges('-2', 7)).toEqual({ ok: true, ranges: [{ from: 1, to: 2 }] })
  })

  it('reports syntax errors with the message Chrome shows', () => {
    for (const text of ['', '  ', 'a', '1-2-3', '5-3', '0', ',', '1,,2', '2 3'])
      expect(parsePageRanges(text, 10)).toEqual({ ok: false, error: PRINT_MESSAGES.pageRangeSyntax })
  })

  it('reports pages past the document with the limit', () => {
    expect(parsePageRanges('1-11', 10)).toEqual({
      ok: false,
      error: 'Out of bounds page reference, limit is 10'
    })
    expect(parsePageRanges('12', 10)).toEqual({
      ok: false,
      error: PRINT_MESSAGES.pageRangeLimit(10)
    })
  })

  it('needs the page count for an open-ended run', () => {
    expect(parsePageRanges('3-', null).ok).toBe(false)
    expect(parsePageRanges('3-4', null).ok).toBe(true)
  })

  it('picks pages for each mode, merged and ascending', () => {
    expect(pagesToPrint({ mode: 'all', custom: '' }, 4)).toEqual([1, 2, 3, 4])
    expect(pagesToPrint({ mode: 'odd', custom: '' }, 5)).toEqual([1, 3, 5])
    expect(pagesToPrint({ mode: 'even', custom: '' }, 5)).toEqual([2, 4])
    expect(pagesToPrint({ mode: 'custom', custom: '4-5, 2, 1-3' }, 6)).toEqual([1, 2, 3, 4, 5])
    expect(pagesToPrint({ mode: 'custom', custom: '9' }, 6)).toEqual([])
    expect(pagesToPrint({ mode: 'even', custom: '' }, 1)).toEqual([])
    expect(pagesToPrint({ mode: 'all', custom: '' }, 0)).toEqual([])
  })

  it('collapses pages back into runs and text', () => {
    const runs = collapsePages([1, 2, 3, 5, 8, 9])
    expect(runs).toEqual([
      { from: 1, to: 3 },
      { from: 5, to: 5 },
      { from: 8, to: 9 }
    ])
    expect(pageRangeText(runs)).toBe('1-3, 5, 8-9')
    expect(pageRangeText([])).toBe('')
  })
})

describe('fields', () => {
  it('validates copies and scale with Chrome messages', () => {
    expect(validateCopies('3')).toEqual({ ok: true, value: 3 })
    expect(validateCopies(' 999 ')).toEqual({ ok: true, value: 999 })
    for (const text of ['0', '1000', '-1', '2.5', 'x', ''])
      expect(validateCopies(text)).toEqual({ ok: false, error: 'Use a number (1 to 999)' })
    expect(validateScale('10')).toEqual({ ok: true, value: 10 })
    expect(validateScale('200')).toEqual({ ok: true, value: 200 })
    for (const text of ['9', '201', 'abc', ''])
      expect(validateScale(text)).toEqual({ ok: false, error: 'Use a number (10 to 200)' })
  })
})

describe('defaults and sanitising', () => {
  it('follows the locale for the paper', () => {
    expect(defaultPaperSizeFor('en-US')).toBe('letter')
    expect(defaultPaperSizeFor('es-MX')).toBe('letter')
    expect(defaultPaperSizeFor('en-GB')).toBe('a4')
    expect(defaultPaperSizeFor('de')).toBe('a4')
    expect(defaultPaperSizeFor(null)).toBe('a4')
    expect(defaultPrintSettings('en-CA').paperSize).toBe('letter')
  })

  it('starts as Chrome does: PDF, portrait, colour, default margins, headers on, backgrounds off', () => {
    const s = defaultPrintSettings()
    expect(s.destination).toEqual({ kind: 'pdf' })
    expect(s.layout).toBe('portrait')
    expect(s.color).toBe('color')
    expect(s.margins.mode).toBe('default')
    expect(s.scale).toEqual({ mode: 'default', percent: 100 })
    expect(s.headerFooter).toBe(true)
    expect(s.background).toBe(false)
    expect(s.copies).toBe(1)
    expect(s.twoSided).toBe(false)
  })

  it('takes every field back from an untrusted document and replaces what is off', () => {
    const d = defaultPrintSettings('en-US')
    const s = sanitizePrintSettings(
      {
        destination: { kind: 'printer', name: 'Office_HP' },
        pages: { mode: 'custom', custom: '1-2' },
        copies: '4',
        collate: false,
        layout: 'landscape',
        color: 'bw',
        paperSize: 'a4',
        margins: { mode: 'custom', custom: { top: 1, right: -3, bottom: 'x', left: 0.5 } },
        scale: { mode: 'custom', percent: 500 },
        twoSided: true,
        duplexEdge: 'shortEdge',
        headerFooter: false,
        background: true
      },
      d
    )
    expect(s.destination).toEqual({ kind: 'printer', name: 'Office_HP' })
    expect(s.pages).toEqual({ mode: 'custom', custom: '1-2' })
    expect(s.copies).toBe(4)
    expect(s.collate).toBe(false)
    expect(s.layout).toBe('landscape')
    expect(s.color).toBe('bw')
    expect(s.paperSize).toBe('a4')
    expect(s.margins.mode).toBe('custom')
    expect(s.margins.custom).toEqual({
      top: 1,
      right: 0,
      bottom: DEFAULT_MARGIN_INCHES,
      left: 0.5
    })
    expect(s.scale).toEqual({ mode: 'custom', percent: 200 })
    expect(s.twoSided).toBe(true)
    expect(s.duplexEdge).toBe('shortEdge')
    expect(s.headerFooter).toBe(false)
    expect(s.background).toBe(true)
  })

  it('falls back to the defaults for garbage', () => {
    const d = defaultPrintSettings('en-US')
    expect(sanitizePrintSettings(null, d)).toEqual(d)
    expect(sanitizePrintSettings('x', d)).toEqual(d)
    const s = sanitizePrintSettings(
      { destination: { kind: 'printer' }, paperSize: 'b9', layout: 'sideways', copies: NaN },
      d
    )
    expect(s.destination).toEqual({ kind: 'pdf' })
    expect(s.paperSize).toBe('letter')
    expect(s.layout).toBe('portrait')
    expect(s.copies).toBe(1)
  })

  it('remembers what Chrome remembers and starts pages and copies over', () => {
    const s = settings({
      pages: { mode: 'custom', custom: '1' },
      copies: 5,
      layout: 'landscape',
      destination: { kind: 'printer', name: 'Office_HP' },
      twoSided: true
    })
    const sticky = stickyOf(s)
    expect('pages' in sticky).toBe(false)
    expect('copies' in sticky).toBe(false)
    expect(sticky.layout).toBe('landscape')
    const next = openingSettings(sticky, [office], 'en-US')
    expect(next.pages).toEqual({ mode: 'all', custom: '' })
    expect(next.copies).toBe(1)
    expect(next.layout).toBe('landscape')
    expect(next.destination).toEqual({ kind: 'printer', name: 'Office_HP' })
    expect(next.twoSided).toBe(true)
  })

  it('drops a remembered printer that is gone and two-sided with it', () => {
    const sticky = stickyOf(
      settings({ destination: { kind: 'printer', name: 'Gone' }, twoSided: true })
    )
    const next = openingSettings(sticky, [office, simplex], 'en-US')
    expect(next.destination).toEqual({ kind: 'printer', name: 'Office_HP' })
    expect(next.twoSided).toBe(true)
    const none = openingSettings(sticky, [], 'en-US')
    expect(none.destination).toEqual({ kind: 'pdf' })
    expect(none.twoSided).toBe(false)
  })

  it('a first print with no memory lands on the default printer, else Save as PDF', () => {
    expect(openingSettings(null, [simplex, office]).destination).toEqual({
      kind: 'printer',
      name: 'Office_HP'
    })
    expect(openingSettings(null, []).destination).toEqual({ kind: 'pdf' })
    expect(initialDestination({ kind: 'pdf' }, [office])).toEqual({ kind: 'pdf' })
  })
})

describe('destinations', () => {
  it('reads duplex from the CUPS printer-type bits', () => {
    expect(printerDuplex({ 'printer-type': 0x8000 | 0x4 })).toBe(true)
    expect(printerDuplex({ 'printer-type': '36' })).toBe(false)
    expect(printerDuplex({ system_driverinfo: 'x' })).toBeNull()
    expect(printerDuplex(undefined)).toBeNull()
  })

  it('offers two-sided to duplex and unknown printers only', () => {
    const unknown: PrinterDescription = { ...simplex, name: 'Unknown', duplex: null }
    expect(twoSidedAvailable({ kind: 'printer', name: 'Office_HP' }, [office, simplex])).toBe(true)
    expect(twoSidedAvailable({ kind: 'printer', name: 'Simplex' }, [office, simplex])).toBe(false)
    expect(twoSidedAvailable({ kind: 'printer', name: 'Unknown' }, [unknown])).toBe(true)
    expect(twoSidedAvailable({ kind: 'pdf' }, [office])).toBe(false)
  })

  it('labels destinations and the primary button as Chrome does', () => {
    expect(destinationLabel({ kind: 'pdf' }, [office])).toBe('Save as PDF')
    expect(destinationLabel({ kind: 'printer', name: 'Office_HP' }, [office])).toBe('Office HP')
    expect(destinationLabel({ kind: 'printer', name: 'Other' }, [office])).toBe('Other')
    expect(primaryLabel({ kind: 'pdf' })).toBe('Save')
    expect(primaryLabel({ kind: 'printer', name: 'x' })).toBe('Print')
  })
})

describe('render options', () => {
  it('maps the defaults onto printToPDF: Letter portrait, 1 cm margins, header and footer', () => {
    const o = pdfRenderOptions(settings())
    expect(o.landscape).toBe(false)
    expect(o.printBackground).toBe(false)
    expect(o.scale).toBe(1)
    expect(o.pageSize).toEqual({ width: 8.5, height: 11 })
    expect(o.margins).toEqual({
      top: DEFAULT_MARGIN_INCHES,
      right: DEFAULT_MARGIN_INCHES,
      bottom: DEFAULT_MARGIN_INCHES,
      left: DEFAULT_MARGIN_INCHES
    })
    expect(o.pageRanges).toBe('')
    expect(o.displayHeaderFooter).toBe(true)
    expect(o.preferCSSPageSize).toBe(false)
  })

  it('turns every option: landscape A4, no margins, 70%, backgrounds, no header, odd pages', () => {
    const o = pdfRenderOptions(
      settings({
        layout: 'landscape',
        paperSize: 'a4',
        margins: { mode: 'none', custom: { top: 1, right: 1, bottom: 1, left: 1 } },
        scale: { mode: 'custom', percent: 70 },
        background: true,
        headerFooter: false,
        pages: { mode: 'odd', custom: '' }
      }),
      5
    )
    expect(o.landscape).toBe(true)
    expect(o.pageSize).toEqual({ width: 8.2677, height: 11.6929 })
    expect(o.margins).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(o.scale).toBe(0.7)
    expect(o.printBackground).toBe(true)
    expect(o.displayHeaderFooter).toBe(false)
    expect(o.pageRanges).toBe('1, 3, 5')
  })

  it('renders every page while the count is unknown, and passes custom margins through', () => {
    const custom = { top: 0.25, right: 0.5, bottom: 0.75, left: 1 }
    const s = settings({
      pages: { mode: 'custom', custom: '2-3' },
      margins: { mode: 'custom', custom }
    })
    expect(pdfRenderOptions(s).pageRanges).toBe('')
    expect(pdfRenderOptions(s, 10).pageRanges).toBe('2-3')
    expect(pdfRenderOptions(s, 3).pageRanges).toBe('2-3')
    expect(pdfRenderOptions(s, 2).pageRanges).toBe('')
    expect(pdfRenderOptions(s).margins).toEqual(custom)
    expect(pdfRenderOptions(settings({ margins: { mode: 'minimum', custom } })).margins).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0
    })
  })

  it('lists the paper Chrome offers its PDF destination', () => {
    expect(PAPER_SIZES.map((p) => p.label)).toEqual(['Letter', 'Legal', 'Tabloid', 'A3', 'A4', 'A5'])
    expect(PAPER_SIZES.find((p) => p.id === 'a4')).toMatchObject({
      widthMicrons: 210000,
      heightMicrons: 297000
    })
  })
})

describe('job options', () => {
  const page = { title: 'Invoice', url: 'https://shop.test/invoice/7' }

  it('is null for Save as PDF and for a selection with no pages', () => {
    expect(printJobOptions(settings(), 3, page)).toBeNull()
    expect(
      printJobOptions(
        settings({
          destination: { kind: 'printer', name: 'Office_HP' },
          pages: { mode: 'custom', custom: '9' }
        }),
        3,
        page
      )
    ).toBeNull()
  })

  it('addresses the printer silently with every option in its own unit', () => {
    const o = printJobOptions(
      settings({
        destination: { kind: 'printer', name: 'Office_HP' },
        pages: { mode: 'custom', custom: '1-2, 4' },
        copies: 3,
        collate: false,
        layout: 'landscape',
        color: 'bw',
        paperSize: 'a4',
        margins: { mode: 'custom', custom: { top: 0.5, right: 1, bottom: 0.25, left: 0 } },
        scale: { mode: 'custom', percent: 80 },
        twoSided: true,
        duplexEdge: 'shortEdge',
        headerFooter: true,
        background: true
      }),
      5,
      page
    )
    expect(o).toEqual({
      silent: true,
      deviceName: 'Office_HP',
      printBackground: true,
      color: false,
      landscape: true,
      scaleFactor: 80,
      copies: 3,
      collate: false,
      duplexMode: 'shortEdge',
      pageSize: { width: 210000, height: 297000 },
      margins: { marginType: 'custom', top: 48, right: 96, bottom: 24, left: 0 },
      pageRanges: [
        { from: 0, to: 1 },
        { from: 3, to: 3 }
      ],
      header: 'Invoice',
      footer: 'https://shop.test/invoice/7'
    })
  })

  it('maps the margin modes, one-sided jobs, and headers off', () => {
    const base = settings({ destination: { kind: 'printer', name: 'Office_HP' }, headerFooter: false })
    const o = printJobOptions(base, 2, page)
    expect(o?.margins).toEqual({ marginType: 'default' })
    expect(o?.duplexMode).toBe('simplex')
    expect(o?.pageRanges).toEqual([])
    expect(o && 'header' in o).toBe(false)
    expect(
      printJobOptions({ ...base, margins: { ...base.margins, mode: 'none' } }, 2, page)?.margins
    ).toEqual({ marginType: 'none' })
    expect(
      printJobOptions({ ...base, margins: { ...base.margins, mode: 'minimum' } }, 2, page)?.margins
    ).toEqual({ marginType: 'printableArea' })
  })
})

describe('summary and file name', () => {
  it("counts sheets for a printer and pages for a PDF, in Chrome's words", () => {
    const printer = settings({ destination: { kind: 'printer', name: 'Office_HP' } })
    expect(printSummary(printer, null)).toBeNull()
    expect(printSummary(printer, 1)).toBe('Total: 1 sheet of paper')
    expect(printSummary({ ...printer, copies: 2 }, 3)).toBe('Total: 6 sheets of paper')
    expect(printSummary({ ...printer, twoSided: true }, 3)).toBe('Total: 2 sheets of paper')
    expect(printSummary(settings(), 1)).toBe('Total: 1 page')
    expect(printSummary(settings({ pages: { mode: 'odd', custom: '' } }), 5)).toBe('Total: 3 pages')
  })

  it('names the PDF after the title, else the host, else document', () => {
    expect(defaultPdfFileName('Invoice #7: paid?', 'https://shop.test/x')).toBe(
      'Invoice #7_ paid_.pdf'
    )
    expect(defaultPdfFileName('   ', 'https://shop.test/x')).toBe('shop.test.pdf')
    expect(defaultPdfFileName('', 'not a url')).toBe('document.pdf')
    expect(defaultPdfFileName('', 'zen://newtab')).toBe('newtab.pdf')
    expect(defaultPdfFileName('...', 'zen://newtab')).toBe('document.pdf')
    expect(defaultPdfFileName('a'.repeat(200), 'https://x.test/').length).toBe(124)
  })
})
