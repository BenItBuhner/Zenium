import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, CircleAlert } from 'lucide-react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { PRINT_LABELS, PRINT_MESSAGES } from '@shared/print'
import { drawPage, pageSizeAt } from '@renderer/lib/pdfDocument'
import { cn } from '@renderer/lib/utils'
import { Spinner } from '../siteControls/primitives'
import { V2_GLYPH } from '../v2/controls'
import type { PreviewPhase } from './usePrintPreview'

/** The grey around the pages, and the gap between them. */
const PANE_PADDING = 24
const PAGE_GAP = 16

/**
 * The preview's pages (Chrome's left pane): the PDF the page rendered to, drawn page by page
 * with pdf.js on the `--v2-fill` grey, each page fitted whole to the pane – the paper as it
 * prints, white in both schemes – with the panel shadow under it; only the pages the selection
 * picks are shown. Pages draw as they come into view. A paging pill hangs at the bottom –
 * previous, "2 / 5", next – and follows the scroll (§9.3 icon buttons on a `--v2-panel` chip).
 * While a fresh render is on its way the last one stays, dimmed to .4 under a spinner and
 * Chrome's "Loading preview" (§9.30); the first render shows the spinner alone; a failure says
 * why in the danger ink with the alert glyph; a selection with no page in it says so.
 */
export function PreviewPane({
  document,
  pages,
  phase,
  rendering,
  error,
  className
}: {
  document: PDFDocumentProxy | null
  /** The pages to show, 1-based. */
  pages: readonly number[]
  phase: PreviewPhase
  rendering: boolean
  error: string | null
  className?: string
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  // The pages' proxies with the document they belong to. The pane draws the last document whose
  // pages it has: a fresh render's pages replace them when they arrive, so the old ones stay up
  // (dimmed, under the notice) rather than the pane going blank between the two.
  const [loaded, setLoaded] = useState<{
    document: PDFDocumentProxy
    proxies: Map<number, PDFPageProxy>
  } | null>(null)
  const shown = document ? loaded : null
  const proxies = shown?.proxies ?? null
  const [current, setCurrent] = useState(1)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void =>
      setBox({
        width: el.clientWidth - PANE_PADDING * 2,
        height: el.clientHeight - PANE_PADDING * 2
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Every page's proxy up front (metadata only: the size, for the box before the drawing).
  useEffect(() => {
    if (!document) return
    let cancelled = false
    void Promise.all(Array.from({ length: document.numPages }, (_, i) => document.getPage(i + 1)))
      .then((list) => {
        if (cancelled) return
        setLoaded({ document, proxies: new Map(list.map((p, i) => [i + 1, p])) })
      })
      // A document released under the request (the next render landed) has no pages to give.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [document])

  // One scale for the document: its largest page fitted whole into the pane, never above 100 %
  // of the paper's size on screen by more than a little (a small page on a big pane).
  const scale = useMemo(() => {
    if (!proxies || !box || box.width <= 0 || box.height <= 0) return 1
    let fit = Infinity
    for (const n of pages) {
      const page = proxies.get(n)
      if (!page) continue
      const size = pageSizeAt(page, 1)
      fit = Math.min(fit, box.width / size.width, box.height / size.height)
    }
    return Number.isFinite(fit) ? Math.min(fit, 1.5) : 1
  }, [proxies, box, pages])

  // The page most in view names the pill: the one whose box crosses the pane's middle.
  const onScroll = useCallback((): void => {
    const el = scroller.current
    if (!el) return
    const middle = el.scrollTop + el.clientHeight / 2
    let best = 1
    for (const child of Array.from(el.querySelectorAll<HTMLElement>('[data-page]'))) {
      if (child.offsetTop <= middle) best = Number(child.dataset.page)
    }
    setCurrent(best)
  }, [])
  useEffect(() => {
    onScroll()
  }, [pages, scale, onScroll])

  const goTo = (index: number): void => {
    const el = scroller.current
    const target = el?.querySelector<HTMLElement>(`[data-page="${pages[index]}"]`)
    if (!el || !target) return
    el.scrollTo({ top: target.offsetTop - PANE_PADDING, behavior: 'smooth' })
  }

  const index = Math.max(0, pages.indexOf(current))
  const showPages = shown !== null && pages.length > 0
  const empty = shown !== null && pages.length === 0 && phase !== 'failed'
  // The last render stays up, dimmed, while the next is on its way or the last failed – and
  // while a fresh document's pages are still being fetched.
  const dimmed = showPages && (rendering || phase === 'failed' || shown.document !== document)

  return (
    <div
      className={cn('relative flex min-h-0 min-w-0 flex-col bg-[var(--v2-fill)]', className)}
      data-testid="print-preview-pane"
      data-rendering={rendering || undefined}
    >
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ padding: PANE_PADDING, scrollbarGutter: 'stable' }}
        onScroll={onScroll}
        aria-busy={rendering || undefined}
      >
        {showPages && (
          <div
            className={cn(
              'mx-auto flex w-max flex-col items-center transition-opacity duration-[120ms]',
              dimmed && 'opacity-40'
            )}
            style={{ gap: PAGE_GAP }}
          >
            {pages.map((n) => {
              const page = shown.proxies.get(n)
              return page ? (
                <PageCanvas
                  key={`${n}:${shown.document.fingerprints[0] ?? ''}`}
                  page={page}
                  number={n}
                  scale={scale}
                  root={scroller}
                />
              ) : null
            })}
          </div>
        )}
      </div>
      {showPages && pages.length > 1 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <div
            className="pointer-events-auto flex items-center gap-1 rounded-full bg-[var(--v2-panel)] p-0.5 text-[13px] leading-5 text-[var(--v2-text)] shadow-[var(--v2-shadow-panel)]"
            data-testid="print-preview-paging"
          >
            <button
              type="button"
              className="zen-v2-icon-button rounded-full"
              aria-label="Previous page"
              disabled={dimmed || index <= 0}
              onClick={() => goTo(index - 1)}
            >
              <ChevronLeft aria-hidden />
            </button>
            <span
              className="min-w-[56px] px-1 text-center [font-variant-numeric:tabular-nums]"
              role="status"
              aria-live="polite"
              data-testid="print-preview-page"
            >
              {index + 1} / {pages.length}
            </span>
            <button
              type="button"
              className="zen-v2-icon-button rounded-full"
              aria-label="Next page"
              disabled={dimmed || index >= pages.length - 1}
              onClick={() => goTo(index + 1)}
            >
              <ChevronRight aria-hidden />
            </button>
          </div>
        </div>
      )}
      {(phase === 'loading' || (rendering && showPages)) && (
        <Notice>
          <Spinner />
          <span>{PRINT_LABELS.loading}</span>
        </Notice>
      )}
      {phase === 'failed' && error && (
        <Notice danger>
          <CircleAlert className={cn(V2_GLYPH, 'shrink-0')} aria-hidden />
          <span>{error}</span>
        </Notice>
      )}
      {empty && (
        <Notice>
          <span>{PRINT_MESSAGES.noPages}</span>
        </Notice>
      )}
    </div>
  )
}

/** A line over the pane's middle: the spinner and Chrome's wording, or a failure in danger ink. */
function Notice({
  children,
  danger = false
}: {
  children: React.ReactNode
  danger?: boolean
}): JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div
        className={cn(
          'flex max-w-[360px] items-center gap-2 rounded-[var(--v2-radius-card)] bg-[var(--v2-panel)] px-4 py-3 text-[15px] leading-5 shadow-[var(--v2-shadow-panel)]',
          danger ? 'text-[var(--v2-danger)]' : 'text-[var(--v2-text)]'
        )}
        role={danger ? 'alert' : 'status'}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * One page: a box of the page's size at `scale` from the first paint, the drawing made once
 * the box is within a pane of the viewport and again whenever the scale changes.
 */
function PageCanvas({
  page,
  number,
  scale,
  root
}: {
  page: PDFPageProxy
  number: number
  scale: number
  root: React.RefObject<HTMLElement | null>
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  const size = pageSizeAt(page, scale)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setNear(true)
      },
      { root: root.current, rootMargin: '100% 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    const el = canvas.current
    if (!el || !near) return
    void drawPage(page, el, scale).catch(() => undefined)
  }, [page, scale, near])

  // The paper's white is pdf.js's own page background (what prints), painted with the page; the
  // box before the drawing is the pane's grey under the panel shadow.
  return (
    <canvas
      ref={canvas}
      data-page={number}
      className="block shadow-[var(--v2-shadow-panel)]"
      style={{ width: Math.round(size.width), height: Math.round(size.height) }}
      aria-label={`Page ${number}`}
    />
  )
}
