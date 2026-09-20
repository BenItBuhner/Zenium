/**
 * The PDF viewer's arithmetic (`pdfViewer.ts` is the document that uses it): what the zoom is
 * for a fit, which page is the one in view, where a search's matches sit on their pages, and
 * where a pinch leaves the scroll. Pure, so the viewer's behaviour is tested off the WebView.
 */
import { PDF_MAX_ZOOM, PDF_MIN_ZOOM, type PdfFitMode } from '@shared/pdfViewerProtocol'

/** CSS pixels per PDF point at 100 %: Chrome's viewer shows a page at 96 dpi, PDF space is 72. */
export const CSS_UNITS = 96 / 72

/** Space kept around the pages (the shell's padding and the gap between pages), in CSS pixels. */
export const PAGE_GUTTER = 8

/** The most device pixels a page's canvas may hold (pdf.js's own ceiling); beyond it the bitmap is scaled up. */
export const MAX_CANVAS_PIXELS = 16_777_216

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, zoom))
}

/** A page's size in PDF points, after the viewer's rotation. */
export interface PageSize {
  width: number
  height: number
}

/**
 * The zoom that fits the widest page to `viewportWidth` (`width`) or the tallest page into the
 * window (`page`), in CSS pixels; both leave the shell's gutter around the page.
 */
export function fitZoom(
  mode: PdfFitMode,
  pages: readonly PageSize[],
  viewport: { width: number; height: number }
): number {
  if (pages.length === 0) return 1
  const widest = Math.max(...pages.map((p) => p.width))
  const tallest = Math.max(...pages.map((p) => p.height))
  const availableWidth = Math.max(1, viewport.width - 2 * PAGE_GUTTER)
  const availableHeight = Math.max(1, viewport.height - 2 * PAGE_GUTTER)
  const byWidth = availableWidth / (widest * CSS_UNITS)
  if (mode === 'width') return clampZoom(byWidth)
  const byHeight = availableHeight / (tallest * CSS_UNITS)
  return clampZoom(Math.min(byWidth, byHeight))
}

/**
 * The render scale for a canvas of a page `size` points at `zoom` on a screen of `dpr`: the
 * device pixel ratio, lowered when the bitmap would pass `MAX_CANVAS_PIXELS`.
 */
export function canvasScale(size: PageSize, zoom: number, dpr: number): number {
  const cssWidth = size.width * CSS_UNITS * zoom
  const cssHeight = size.height * CSS_UNITS * zoom
  const pixels = cssWidth * cssHeight * dpr * dpr
  if (pixels <= MAX_CANVAS_PIXELS) return dpr
  return Math.max(0.25, dpr * Math.sqrt(MAX_CANVAS_PIXELS / pixels))
}

/** A page's place on screen: its top and bottom in viewport coordinates. */
export interface PageBand {
  top: number
  bottom: number
}

/**
 * The page in view, 1-based, as Chrome's page indicator counts it (pdfium's most visible page):
 * the page showing the largest share of itself, the earlier one when several show as much – so
 * a jump to a page that fits whole names that page, whatever the pages after it show; 0
 * without pages.
 */
export function pageInView(bands: readonly PageBand[], viewportHeight: number): number {
  if (bands.length === 0) return 0
  let best = 0
  let bestShare = -1
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i]
    const height = Math.max(1, band.bottom - band.top)
    const visible = Math.min(band.bottom, viewportHeight) - Math.max(band.top, 0)
    const share = Math.max(0, visible) / height
    if (share > bestShare + 1e-6) {
      bestShare = share
      best = i
    }
  }
  return best + 1
}

/**
 * Which pages to have rendered for the ones on screen: those within `ahead` window heights of
 * the viewport, so a scroll finds the next page drawn. Others may drop their canvases.
 */
export function pagesToRender(
  bands: readonly PageBand[],
  viewportHeight: number,
  ahead = 1
): { render: Set<number>; keep: Set<number> } {
  const render = new Set<number>()
  const keep = new Set<number>()
  const margin = viewportHeight * ahead
  const farMargin = viewportHeight * (ahead + 2)
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i]
    if (band.bottom >= -margin && band.top <= viewportHeight + margin) render.add(i)
    if (band.bottom >= -farMargin && band.top <= viewportHeight + farMargin) keep.add(i)
  }
  return { render, keep }
}

/** A run of text pdf.js reports for a page, in the page's user space. */
export interface TextRun {
  str: string
  /** `[a, b, c, d, e, f]`: the run's transform; `e`, `f` place its baseline's start. */
  transform: readonly number[]
  width: number
  height: number
}

/** A match of the search: where it sits within a page's text runs. */
export interface TextMatch {
  page: number
  run: number
  start: number
  length: number
}

/** Chrome's find: case-insensitive, whitespace collapsed, every occurrence in reading order. */
export function findInRuns(runs: readonly TextRun[], query: string, page: number): TextMatch[] {
  const needle = normalizeForFind(query)
  if (!needle) return []
  const matches: TextMatch[] = []
  runs.forEach((run, index) => {
    const hay = run.str.toLowerCase()
    let from = 0
    for (;;) {
      const at = hay.indexOf(needle, from)
      if (at < 0) break
      matches.push({ page, run: index, start: at, length: needle.length })
      from = at + Math.max(1, needle.length)
    }
  })
  return matches
}

export function normalizeForFind(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** A rectangle as fractions of the page's box, so it follows the page through every zoom. */
export interface FractionRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where a match sits on its page, as fractions of the page's width and height. `convert` maps a
 * rectangle in user space to viewport pixels (pdf.js's `convertToViewportRectangle`), and
 * `viewport` is the size that conversion is in. Text runs are horizontal in the common case;
 * the substring's share of the run's width places the match along it.
 */
export function matchRect(
  run: TextRun,
  match: Pick<TextMatch, 'start' | 'length'>,
  convert: (rect: [number, number, number, number]) => number[],
  viewport: { width: number; height: number }
): FractionRect | null {
  const length = run.str.length || 1
  const x = run.transform[4] ?? 0
  const y = run.transform[5] ?? 0
  const fontHeight = Math.hypot(run.transform[2] ?? 0, run.transform[3] ?? 0) || run.height
  const x0 = x + run.width * (match.start / length)
  const x1 = x + run.width * ((match.start + match.length) / length)
  const converted = convert([x0, y - fontHeight * 0.2, x1, y + fontHeight * 0.8])
  if (converted.length < 4 || viewport.width <= 0 || viewport.height <= 0) return null
  const left = Math.min(converted[0], converted[2])
  const right = Math.max(converted[0], converted[2])
  const top = Math.min(converted[1], converted[3])
  const bottom = Math.max(converted[1], converted[3])
  return {
    left: left / viewport.width,
    top: top / viewport.height,
    width: Math.max(2, right - left) / viewport.width,
    height: Math.max(2, bottom - top) / viewport.height
  }
}

/** The rectangle of a link annotation (`rect` in user space), as fractions of the page. */
export function annotationRect(
  rect: readonly number[],
  convert: (rect: [number, number, number, number]) => number[],
  viewport: { width: number; height: number }
): FractionRect | null {
  if (rect.length < 4 || viewport.width <= 0 || viewport.height <= 0) return null
  const converted = convert([rect[0], rect[1], rect[2], rect[3]])
  if (converted.length < 4) return null
  const left = Math.min(converted[0], converted[2])
  const right = Math.max(converted[0], converted[2])
  const top = Math.min(converted[1], converted[3])
  const bottom = Math.max(converted[1], converted[3])
  if (right - left < 1 || bottom - top < 1) return null
  return {
    left: left / viewport.width,
    top: top / viewport.height,
    width: (right - left) / viewport.width,
    height: (bottom - top) / viewport.height
  }
}

/**
 * The order a search reads the pages in, pdfium's: from the page in view to the last, then
 * from the first – the first match the reader sees is the nearest one ahead.
 */
export function findOrder(pageCount: number, pageInView: number): number[] {
  const from = Math.min(Math.max(1, pageInView), Math.max(1, pageCount))
  const order: number[] = []
  for (let page = from; page <= pageCount; page++) order.push(page)
  for (let page = 1; page < from; page++) order.push(page)
  return order
}

/**
 * A page's matches join the tally in reading order, as pdfium's AddFindResult files them: the
 * first match found becomes current while none is, and a current match stays the same one when
 * matches land before it (its index moves up by their count).
 */
export function mergeMatches(
  matches: readonly TextMatch[],
  found: readonly TextMatch[],
  current: number
): { matches: TextMatch[]; current: number } {
  if (found.length === 0) return { matches: [...matches], current }
  const page = found[0].page
  let at = matches.findIndex((m) => m.page > page)
  if (at < 0) at = matches.length
  const merged = [...matches.slice(0, at), ...found, ...matches.slice(at)]
  if (current < 0) return { matches: merged, current: at }
  return { matches: merged, current: at <= current ? current + found.length : current }
}

/** A hit element's key within its page: the same match, whatever its index in the tally. */
export function matchKey(match: TextMatch): string {
  return `${match.run}:${match.start}`
}

/** Which match `find` lands on: `new` picks the first at or after the page in view, the others step around the ring. */
export function nextMatchIndex(
  matches: readonly TextMatch[],
  current: number,
  direction: 'new' | 'next' | 'prev',
  pageInView: number
): number {
  if (matches.length === 0) return -1
  if (direction === 'new' || current < 0) {
    const at = matches.findIndex((m) => m.page >= pageInView)
    return at < 0 ? 0 : at
  }
  if (direction === 'next') return (current + 1) % matches.length
  return (current - 1 + matches.length) % matches.length
}

/** A pinch in progress: where it began and what it has become. */
export interface Pinch {
  /** The zoom when the fingers landed. */
  startZoom: number
  /** The distance between the fingers then. */
  startDistance: number
  /** Their centre then, in viewport coordinates. */
  centre: { x: number; y: number }
  /** The document point under the centre then (the scroll offset added). */
  focus: { x: number; y: number }
}

export function pinchOf(
  touches: readonly { clientX: number; clientY: number }[],
  zoom: number,
  scroll: { x: number; y: number }
): Pinch | null {
  if (touches.length < 2) return null
  const [a, b] = touches
  const centre = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
  return {
    startZoom: zoom,
    startDistance: Math.max(1, Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)),
    centre,
    focus: { x: centre.x + scroll.x, y: centre.y + scroll.y }
  }
}

/** The zoom the fingers now ask for, within the viewer's range. */
export function pinchZoom(pinch: Pinch, distance: number): number {
  return clampZoom(pinch.startZoom * (distance / pinch.startDistance))
}

/**
 * The scroll offset that keeps the pinch's focus under the fingers once the pages are laid out
 * at `zoom`: the document scales about its origin, the fingers may have moved to `centre`.
 */
export function scrollAfterZoom(
  focus: { x: number; y: number },
  fromZoom: number,
  toZoom: number,
  centre: { x: number; y: number }
): { x: number; y: number } {
  const ratio = toZoom / fromZoom
  return {
    x: Math.max(0, focus.x * ratio - centre.x),
    y: Math.max(0, focus.y * ratio - centre.y)
  }
}

/** Chrome Android's double tap: from a fit to twice it about the tap, and back. */
export function doubleTapZoom(zoom: number, fitted: number): number {
  return Math.abs(zoom - fitted) < 0.01 ? clampZoom(fitted * 2) : fitted
}

/** The status the viewer shows for a failure, in Chrome's words where it has them. */
export function failureText(error: unknown): string {
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : ''
  const message =
    error && typeof error === 'object' ? String((error as { message?: unknown }).message ?? '') : ''
  switch (name) {
    case 'InvalidPDFException':
      return "This PDF file couldn't be opened. It may be damaged or not a PDF."
    case 'MissingPDFException':
    case 'ResponseException':
      return 'This file is no longer available.'
    case 'PasswordException':
      return 'This document is password protected.'
    default:
      return message.trim()
        ? `This PDF could not be loaded (${message.trim()}).`
        : 'This PDF could not be loaded.'
  }
}

/** How much of the outline is reported: the chrome's panel would not show more. */
export const OUTLINE_LIMIT = 400
