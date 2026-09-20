import { describe, expect, it } from 'vitest'
import {
  annotationRect,
  canvasScale,
  clampZoom,
  CSS_UNITS,
  doubleTapZoom,
  failureText,
  findInRuns,
  fitZoom,
  matchRect,
  MAX_CANVAS_PIXELS,
  nextMatchIndex,
  normalizeForFind,
  PAGE_GUTTER,
  pageInView,
  pagesToRender,
  pinchOf,
  pinchZoom,
  scrollAfterZoom,
  type PageBand,
  type TextRun
} from '../pdfViewerLogic'
import { PDF_MAX_ZOOM, PDF_MIN_ZOOM } from '@shared/pdfViewerProtocol'

/** A4 in PDF points. */
const A4 = { width: 595, height: 842 }
/** A phone's layout viewport in CSS pixels. */
const PHONE = { width: 412, height: 915 }

/** Pages of `height` CSS pixels stacked with the shell's gap, the column scrolled by `scrollY`. */
function column(count: number, height: number, scrollY: number): PageBand[] {
  const bands: PageBand[] = []
  let top = PAGE_GUTTER - scrollY
  for (let i = 0; i < count; i++) {
    bands.push({ top, bottom: top + height })
    top += height + PAGE_GUTTER
  }
  return bands
}

/** pdf.js's user-space → viewport conversion for an unrotated page of `size` points at scale 1. */
function unrotated(size: { width: number; height: number }) {
  return ([x0, y0, x1, y1]: [number, number, number, number]): number[] => [
    x0,
    size.height - y0,
    x1,
    size.height - y1
  ]
}

describe('fitting the pages to the window', () => {
  it('fits the widest page to the width, the gutter kept on both sides', () => {
    const zoom = fitZoom('width', [A4, { width: 400, height: 400 }], PHONE)
    expect(zoom * A4.width * CSS_UNITS).toBeCloseTo(PHONE.width - 2 * PAGE_GUTTER, 6)
  })

  it('fits the whole page into the window: the tighter of the two', () => {
    // A phone is taller than an A4 page is: the width binds.
    expect(fitZoom('page', [A4], PHONE)).toBe(fitZoom('width', [A4], PHONE))
    // Turned on its side, the page's height binds.
    const landscape = { width: A4.height, height: A4.width }
    const zoom = fitZoom('page', [landscape], { width: 2000, height: 600 })
    expect(zoom * landscape.height * CSS_UNITS).toBeCloseTo(600 - 2 * PAGE_GUTTER, 6)
  })

  it('stays within the zoom range and is 1 for a document without pages', () => {
    expect(fitZoom('width', [], PHONE)).toBe(1)
    expect(fitZoom('width', [{ width: 20, height: 20 }], PHONE)).toBe(PDF_MAX_ZOOM)
    expect(fitZoom('width', [{ width: 100_000, height: 10 }], PHONE)).toBe(PDF_MIN_ZOOM)
  })

  it('clamps a zoom to the range and reads a broken one as 100 %', () => {
    expect(clampZoom(0.01)).toBe(PDF_MIN_ZOOM)
    expect(clampZoom(50)).toBe(PDF_MAX_ZOOM)
    expect(clampZoom(1.3)).toBe(1.3)
    expect(clampZoom(Number.NaN)).toBe(1)
  })

  it('draws at the device pixel ratio until a canvas would pass the ceiling', () => {
    expect(canvasScale(A4, 1, 3)).toBe(3)
    const huge = canvasScale(A4, 5, 3)
    expect(huge).toBeLessThan(3)
    const pixels = A4.width * CSS_UNITS * 5 * huge * (A4.height * CSS_UNITS * 5 * huge)
    expect(pixels).toBeLessThanOrEqual(MAX_CANVAS_PIXELS * 1.0001)
  })
})

describe('the page in view', () => {
  const pageHeight = Math.round(A4.height * CSS_UNITS * 0.5) // 561 px, a fit-to-width A4 on a phone

  it('is the one filling the window while a page is taller than what shows of the next', () => {
    expect(pageInView(column(3, pageHeight, 0), PHONE.height)).toBe(1)
    // Scrolled a little: page 1 still shows more of itself than page 2 does.
    expect(pageInView(column(3, pageHeight, 100), PHONE.height)).toBe(1)
    // Past the middle of page 1: page 2 shows more of itself.
    expect(pageInView(column(3, pageHeight, 400), PHONE.height)).toBe(2)
  })

  it('names the earliest of several pages showing whole (a jump to a page that fits)', () => {
    // Fit to page after a rotation: three short pages all fit the window at once.
    expect(pageInView(column(3, 280, 0), PHONE.height)).toBe(1)
    // Page 1 half gone, 2 and 3 whole: 2, whatever sits under the middle of the window.
    expect(pageInView(column(3, 280, 140 + PAGE_GUTTER), PHONE.height)).toBe(2)
  })

  it('follows a zoomed-in page that is taller than the window', () => {
    const tall = 2000
    expect(pageInView(column(2, tall, 500), PHONE.height)).toBe(1)
    expect(pageInView(column(2, tall, tall - 300), PHONE.height)).toBe(2)
  })

  it('is 0 without pages', () => {
    expect(pageInView([], PHONE.height)).toBe(0)
  })
})

describe('which pages to have drawn', () => {
  it('renders the pages within a window of the viewport and keeps those a little further', () => {
    const bands = column(12, 561, 0)
    const { render, keep } = pagesToRender(bands, PHONE.height)
    // Pages 1–4 lie within one window's height below the viewport's bottom.
    expect([...render]).toEqual([0, 1, 2, 3])
    // Pages further down keep their canvases up to three windows away.
    expect(keep.has(6)).toBe(true)
    expect(keep.has(8)).toBe(false)
    expect([...render].every((i) => keep.has(i))).toBe(true)
  })

  it('counts pages above the viewport the same way', () => {
    const bands = column(12, 561, 561 * 6)
    const { render } = pagesToRender(bands, PHONE.height)
    expect(render.has(4)).toBe(true)
    expect(render.has(2)).toBe(false)
  })
})

describe('find', () => {
  const runs: TextRun[] = [
    {
      str: 'High water at 04:12 and 16:40.',
      transform: [12, 0, 0, 12, 72, 700],
      width: 180,
      height: 12
    },
    {
      str: 'Low WATER at 10:25; water again.',
      transform: [12, 0, 0, 12, 72, 680],
      width: 200,
      height: 12
    }
  ]

  it('matches case-insensitively, every occurrence in reading order', () => {
    const matches = findInRuns(runs, 'water', 3)
    expect(matches).toEqual([
      { page: 3, run: 0, start: 5, length: 5 },
      { page: 3, run: 1, start: 4, length: 5 },
      { page: 3, run: 1, start: 20, length: 5 }
    ])
  })

  it('collapses the query’s whitespace and ignores an empty one', () => {
    expect(normalizeForFind('  High   Water ')).toBe('high water')
    expect(findInRuns(runs, '   ', 1)).toEqual([])
    expect(findInRuns(runs, 'high  water', 1)).toHaveLength(1)
  })

  it('places a match along its run as the substring’s share of the width', () => {
    const rect = matchRect(runs[0], { start: 5, length: 5 }, unrotated(A4), A4)
    expect(rect).not.toBeNull()
    const { left, top, width, height } = rect!
    // 'High ' is 5 of 30 characters: the match starts a sixth of the way along the run.
    expect(left * A4.width).toBeCloseTo(72 + 180 * (5 / 30), 6)
    expect(width * A4.width).toBeCloseTo(180 * (5 / 30), 6)
    // A 12 pt line about the baseline at y = 700, flipped into the viewport's downward y.
    expect(top * A4.height).toBeCloseTo(A4.height - (700 + 12 * 0.8), 6)
    expect(height * A4.height).toBeCloseTo(12, 6)
  })

  it('starts a new search at the page in view and steps around the ring', () => {
    const matches = [
      { page: 1, run: 0, start: 0, length: 1 },
      { page: 2, run: 0, start: 0, length: 1 },
      { page: 3, run: 0, start: 0, length: 1 }
    ]
    expect(nextMatchIndex(matches, -1, 'new', 2)).toBe(1)
    expect(nextMatchIndex(matches, -1, 'new', 7)).toBe(0)
    expect(nextMatchIndex(matches, 1, 'next', 2)).toBe(2)
    expect(nextMatchIndex(matches, 2, 'next', 2)).toBe(0)
    expect(nextMatchIndex(matches, 0, 'prev', 2)).toBe(2)
    expect(nextMatchIndex([], 0, 'next', 1)).toBe(-1)
  })
})

describe('links', () => {
  it('turns a link annotation’s rectangle into fractions of the page', () => {
    const rect = annotationRect([72, 90, 300, 110], unrotated(A4), A4)
    expect(rect).toEqual({
      left: 72 / A4.width,
      top: (A4.height - 110) / A4.height,
      width: (300 - 72) / A4.width,
      height: 20 / A4.height
    })
  })

  it('drops a degenerate or malformed rectangle', () => {
    expect(annotationRect([72, 90, 72, 110], unrotated(A4), A4)).toBeNull()
    expect(annotationRect([72, 90], unrotated(A4), A4)).toBeNull()
  })
})

describe('pinch and double tap', () => {
  it('reads a pinch from two fingers and scales the zoom by their spread', () => {
    const pinch = pinchOf(
      [
        { clientX: 100, clientY: 400 },
        { clientX: 300, clientY: 400 }
      ],
      0.5,
      { x: 0, y: 1000 }
    )
    expect(pinch).toMatchObject({
      startZoom: 0.5,
      startDistance: 200,
      centre: { x: 200, y: 400 },
      focus: { x: 200, y: 1400 }
    })
    expect(pinchZoom(pinch!, 400)).toBe(1)
    expect(pinchZoom(pinch!, 4000)).toBe(PDF_MAX_ZOOM)
    expect(pinchOf([{ clientX: 1, clientY: 1 }], 1, { x: 0, y: 0 })).toBeNull()
  })

  it('keeps the point under the fingers where they are once the pages are laid out anew', () => {
    const scroll = scrollAfterZoom({ x: 200, y: 1400 }, 0.5, 1, { x: 200, y: 400 })
    expect(scroll).toEqual({ x: 200, y: 2400 })
    // Zooming out near the top never asks for a negative scroll.
    expect(scrollAfterZoom({ x: 50, y: 50 }, 1, 0.5, { x: 200, y: 400 })).toEqual({ x: 0, y: 0 })
  })

  it('double taps from the fit to twice it and back', () => {
    expect(doubleTapZoom(0.5, 0.5)).toBe(1)
    expect(doubleTapZoom(1, 0.5)).toBe(0.5)
    expect(doubleTapZoom(3, 3)).toBe(PDF_MAX_ZOOM)
  })
})

describe('what a failure says', () => {
  it('uses Chrome’s words for the cases it has them for', () => {
    expect(failureText({ name: 'InvalidPDFException', message: 'x' })).toBe(
      "This PDF file couldn't be opened. It may be damaged or not a PDF."
    )
    expect(failureText({ name: 'MissingPDFException' })).toBe('This file is no longer available.')
    expect(failureText({ name: 'ResponseException' })).toBe('This file is no longer available.')
    expect(failureText({ name: 'PasswordException' })).toBe('This document is password protected.')
  })

  it('quotes any other message and has a line for none', () => {
    expect(failureText(new Error('worker gone'))).toBe(
      'This PDF could not be loaded (worker gone).'
    )
    expect(failureText(undefined)).toBe('This PDF could not be loaded.')
    expect(failureText({ name: 'X', message: '  ' })).toBe('This PDF could not be loaded.')
  })
})
