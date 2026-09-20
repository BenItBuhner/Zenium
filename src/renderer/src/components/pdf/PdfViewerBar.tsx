import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { ChevronDown, List, MoreVertical, Search, Share2 } from 'lucide-react'
import type { UIState } from '@shared/types'
import { cmd } from '@renderer/lib/api'
import {
  fetchPdfReport,
  formatPdfZoom,
  PDF_FIT_LABELS,
  pdfCommand,
  pdfViewerStore
} from '@renderer/lib/pdfViewer'
import { openFindBar } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import {
  PdfGoToPageSheet,
  PdfMoreSheet,
  PdfOutlineSheet,
  PdfPasswordSheet,
  PdfZoomSheet
} from './PdfSheets'

/** Which of the bar's sheets is up. */
type Sheet = 'zoom' | 'outline' | 'more' | 'goto' | 'password' | null

/**
 * The inline PDF viewer's controls (CT-02: `zen://pdf`, `core/pdf.ts`), docked under the live
 * page the way the find bar and the page zoom sheet are (v2 §9.32: a bar on the frame's bottom
 * edge, not a sheet on the chassis, so the pages stay in view while the controls act on them).
 * Chrome Android's viewer in the phone chrome's language: the page indicator, the zoom as a
 * menulist that opens the zoom sheet (the two fits and Chrome's presets), then Find, Contents
 * (the document's outline) and Share as icon buttons, and the overflow with Open with – Chrome's
 * way out of the viewer – and Rotate. Every sheet is a `PhoneSheet` on the hosted chassis.
 *
 * The bar draws what the viewer document last reported (`lib/pdfViewer.ts`): the document
 * loading, waiting for a password, open, or failed – each a state of this one bar, with the
 * controls that mean nothing in it disabled at .4 (§9.30). A page surface (§9.29): the root
 * carries `data-surface="page"`. No tooltips: the controls are named for the reader (§9.31).
 */
export function PdfViewerBar({ state, tabId }: { state: UIState; tabId: string }): JSX.Element {
  const report = pdfViewerStore.use((s) => s.reports[tabId] ?? null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [openingWith, setOpeningWith] = useState(false)

  // A viewer that reported before this chrome listened: ask once as the bar comes up.
  useEffect(() => {
    void fetchPdfReport(tabId)
  }, [tabId])

  const tab = state.tabs[tabId]
  const fileName = tab?.title || 'PDF'
  const status = report?.state ?? 'loading'
  const ready = status === 'ready' && report !== null
  const page = report?.page ?? 0
  const pageCount = report?.pageCount ?? 0
  const zoom = report?.zoom ?? 1
  const zoomLabel = ready ? (report.fit ? PDF_FIT_LABELS[report.fit] : formatPdfZoom(zoom)) : '—'
  const outline = report?.outline ?? []
  const title = report?.title || fileName

  const openWith = (): void => {
    if (openingWith) return
    setOpeningWith(true)
    void cmd('pdf.openWith', { tabId }).finally(() => setOpeningWith(false))
  }

  return (
    <>
      <div
        className="zen-pdf-bar shrink-0 border-t border-[var(--v2-border)] bg-[var(--v2-panel)] text-[var(--v2-text)]"
        style={{
          borderTopLeftRadius: 'var(--v2-radius-sheet)',
          borderTopRightRadius: 'var(--v2-radius-sheet)',
          fontSize: 'var(--v2-font-body)',
          lineHeight: 'var(--v2-line-body)'
        }}
        role="toolbar"
        aria-label="PDF viewer"
        aria-busy={status === 'loading' || undefined}
        data-surface="page"
        data-state={status}
        data-testid="pdf-bar"
      >
        {/* One bar row (§9.32): the 44 controls at 2 px margins, text at the 16 gutter. */}
        <div className="flex min-h-12 items-center gap-1 pl-2 pr-0.5">
          {status === 'password' ? (
            <>
              <span className="min-w-0 flex-1 truncate pl-2 text-[var(--v2-text-deemphasized)]">
                Password protected
              </span>
              <button
                type="button"
                className="zen-v2-button mr-1.5 shrink-0"
                data-primary
                onClick={() => setSheet('password')}
              >
                Unlock
              </button>
            </>
          ) : status === 'error' ? (
            <>
              <span className="min-w-0 flex-1 truncate pl-2 text-[var(--v2-text-deemphasized)]">
                Can&apos;t open this PDF
              </span>
              <button
                type="button"
                className="zen-v2-button mr-1.5 shrink-0"
                aria-busy={openingWith || undefined}
                onClick={openWith}
              >
                Open with
              </button>
            </>
          ) : (
            <>
              {/* The page indicator: Chrome's "1 / 3" pill, here a target that goes to a page. */}
              <button
                type="button"
                className={cn(
                  'zen-pdf-pages flex h-10 shrink-0 items-center rounded-[var(--v2-radius-control)] px-2 tabular-nums',
                  'transition-[background] duration-[120ms] hover:bg-[var(--v2-fill)] active:bg-[var(--v2-fill)]',
                  'disabled:opacity-40 disabled:hover:bg-transparent'
                )}
                style={{ fontWeight: 'var(--v2-weight-heading)' }}
                aria-label={ready ? `Page ${page} of ${pageCount}. Go to page` : 'Loading pages'}
                disabled={!ready}
                onClick={() => setSheet('goto')}
              >
                {ready ? (
                  <>
                    <span>{page}</span>
                    <span className="px-1 text-[var(--v2-text-deemphasized)]">/</span>
                    <span>{pageCount}</span>
                  </>
                ) : (
                  <span className="text-[var(--v2-text-deemphasized)]">Loading…</span>
                )}
              </button>
              {/* The zoom, a menulist whose popup is the zoom sheet (§9.13 on a phone). */}
              <button
                type="button"
                className="zen-v2-menulist zen-pdf-zoom shrink-0"
                style={{ width: 'auto' }}
                aria-label={`Zoom, ${zoomLabel}`}
                aria-haspopup="dialog"
                aria-expanded={sheet === 'zoom'}
                disabled={!ready}
                onClick={() => setSheet('zoom')}
              >
                <span className="min-w-0 truncate tabular-nums">{zoomLabel}</span>
                <ChevronDown aria-hidden />
              </button>
              <span className="flex-1" />
              <button
                type="button"
                className="zen-v2-icon-button"
                aria-label="Find in page"
                disabled={!ready}
                onClick={() => openFindBar(tabId)}
              >
                <Search />
              </button>
              <button
                type="button"
                className="zen-v2-icon-button"
                aria-label="Contents"
                aria-haspopup="dialog"
                aria-expanded={sheet === 'outline'}
                disabled={!ready || outline.length === 0}
                onClick={() => setSheet('outline')}
              >
                <List />
              </button>
              <button
                type="button"
                className="zen-v2-icon-button"
                aria-label="Share"
                disabled={status === 'loading'}
                onClick={() => void cmd('pdf.share', { tabId })}
              >
                <Share2 />
              </button>
              <button
                type="button"
                className="zen-v2-icon-button"
                aria-label="More options"
                aria-haspopup="dialog"
                aria-expanded={sheet === 'more'}
                onClick={() => setSheet('more')}
              >
                <MoreVertical />
              </button>
            </>
          )}
        </div>
      </div>
      {sheet === 'zoom' && report && (
        <PdfZoomSheet
          zoom={report.zoom}
          fit={report.fit}
          onPick={(pick) =>
            pdfCommand(
              tabId,
              pick.kind === 'fit'
                ? { kind: 'fit', mode: pick.mode }
                : { kind: 'zoom', factor: pick.factor }
            )
          }
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'outline' && (
        <PdfOutlineSheet
          outline={outline}
          page={page}
          onGoTo={(target) => pdfCommand(tabId, { kind: 'goTo', page: target })}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'more' && (
        <PdfMoreSheet
          title={title}
          ready={ready}
          onShare={() => void cmd('pdf.share', { tabId })}
          onOpenWith={openWith}
          onRotate={() => pdfCommand(tabId, { kind: 'rotate' })}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'goto' && ready && (
        <PdfGoToPageSheet
          page={page}
          pageCount={pageCount}
          onGoTo={(target) => pdfCommand(tabId, { kind: 'goTo', page: target })}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'password' && (
        <PdfPasswordSheet tabId={tabId} fileName={fileName} onClose={() => setSheet(null)} />
      )}
    </>
  )
}
