import type { JSX } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Paperclip } from 'lucide-react'
import type { Rect, ShareAnswer, ShareRequest, UIState } from '@shared/types'
import { useChromeSurface } from '@renderer/hooks/useChromeSurface'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { usePopover } from '@renderer/hooks/usePopover'
import { run } from '@renderer/lib/api'
import { useLightDismiss } from '@renderer/lib/popoverStore'
import {
  ChromePortal,
  measuringStyle,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  type PopoverBox,
  placePopover,
  popoverStyle,
  toRect,
  useMeasuredHeight,
  viewportSize
} from '@renderer/lib/portals'
import { qrLayout, qrSymbol } from '@renderer/lib/qr'
import { sharePreview, shareTargets } from '@renderer/lib/share'
import { cn } from '@renderer/lib/utils'
import { V2TitleBlock } from '../extensions/v2'

/** The address pill the popover hangs from (Chrome's share bubble hangs from the omnibox). */
const PILL = '.zen-pill'
/**
 * A control that asked for the share and wants the popover on itself (§9.20: a popover hangs
 * from what opened it) – the capture card's Share, over the dimmed page – ahead of the pill.
 */
const ANCHOR = '[data-share-anchor]'

/** The control the popover hangs from: one that asked for it, else the pill; null with neither. */
function anchorElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(ANCHOR) ?? document.querySelector<HTMLElement>(PILL)
}
/** A list of targets without trailing controls (§9.20). */
const WIDTH = POPOVER_WIDTH.list
/** The QR's tile: 160 border-box under §6's card edge. */
const QR_TILE = 160
/** Inside the tile's 1 px hairline: the white the symbol is drawn on, at whole pixels a module. */
const QR_INNER = QR_TILE - 2

/**
 * The desktop's share sheet (MW-21) as a §9.20 popover: the share surface of a host with one
 * (`capabilities.shareSheet`; `ChromeSurface` – the core holds a page's `navigator.share` and
 * the menu's Share… open for a window only while this is up, and answers a window without it as
 * a cancel), so the layer registers on those hosts alone. One request at a time, the oldest
 * first.
 */
export function ShareLayer({ state }: { state: UIState }): JSX.Element | null {
  const surface = state.capabilities.shareSheet
  useChromeSurface('share', surface)
  const request = state.shareRequests[0]
  return surface && request ? (
    <SharePopover key={request.id} request={request} state={state} />
  ) : null
}

/**
 * The popover (§9.20) 320 wide with its top border on the pill's bottom edge, start-aligned with
 * the pill – or, for a control that asked for the share and marks itself the anchor
 * (`data-share-anchor`: the capture card's Share, a footer verb over the dimmed page), aligned
 * by the halves of the dialog the verb stands in and hanging from that dialog's bottom edge,
 * overlapping none of it (§9.20: a dialog's footer is the bar of its verbs) – placed by
 * `placePopover` (flip, slide, shrink, 8 inside the window) on its content's measured height
 * (`useMeasuredHeight`, the 60% cap a ceiling on that: a 216 panel fits under a footer 282 from
 * the window's edge and stays below it); radius 8,
 * the panel shadow, no scrim (§9.5), through the chrome layer (`ChromePortal`). A title block
 * (§9.23) – "Share" with the sharing site as its description for a page's `navigator.share`,
 * "Share this page" for the menu's, "Share" for a share of files alone (a capture's) – stays
 * put while the body scrolls under it (§9.7). The body: what is shared (its title and link or
 * text, and the files' count and size), the link's QR code on a white tile (the symbol keeps
 * black on white in either scheme, as a scanner and Chrome's QR bubble want; the tile's border
 * and radius are the card's; every module a whole number of pixels, the tile's white taking the
 * remainder around the quiet zone), then the targets as shared rows with a leading 16 glyph –
 * Copy link (or Copy text; Copy image for one picture and nothing else), Email where there is a
 * link or text to mail, Save when the share carries files or an image, and "More…" for the OS's
 * own sheet where there is one (macOS). A row answers the request (`share.respond`) and the
 * popover leaves with it; Escape, a press anywhere else, a resize and another popover opening
 * dismiss it, which a page hears as `AbortError`. Focus moves to the first row and Tab wraps
 * (§9.22). The popover overhangs the content frame, so the page's view gives way to its picture
 * while it is up (`useFloatingChrome`) and the popover holds its first paint until the picture
 * is in place.
 */
function SharePopover({
  request,
  state
}: {
  request: ShareRequest
  state: UIState
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  // The body's scroll, read inline: the body mounts after the first paint is released.
  const [scrolled, setScrolled] = useState(false)
  const seat = useAnchorRect(state)
  const ready = useFloatingChrome()
  // The first pass after the page has given way measures the content; the panel is placed on
  // the number and takes the keyboard then (a hidden panel cannot be focused).
  const measured = useMeasuredHeight(panelRef, ready)
  const placed = ready && measured !== null
  const box = place(seat, measured)

  // The answer goes once: the request leaves the state with it and this unmounts.
  const answered = useRef(false)
  const answer = useCallback(
    (choice: ShareAnswer) => {
      if (answered.current) return
      answered.current = true
      run('share.respond', { id: request.id, answer: choice })
    },
    [request.id]
  )
  const dismiss = useCallback(() => answer('dismiss'), [answer])
  usePopover(panelRef, { onClose: dismiss, active: placed })
  useLightDismiss(panelRef, dismiss, { anchor: anchorElement })

  const preview = sharePreview(request)
  const qr = useMemo(() => qrSymbol(request.url), [request.url])
  const qrBox = qr ? qrLayout(qr.size, QR_INNER) : null
  const targets = shareTargets(request)
  const files = request.files.length
  if (!ready) return null
  return (
    <ChromePortal>
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby="zen-share-title"
        data-share-popover=""
        data-surface="page"
        className="zen-v2 zen-animate-pop zen-bm-popover zen-share-popover fixed z-[70] flex flex-col outline-none"
        style={placed ? popoverStyle(box) : measuringStyle(WIDTH)}
        data-measuring={placed ? undefined : ''}
        tabIndex={-1}
      >
        <V2TitleBlock
          id="zen-share-title"
          title={request.origin || filesAlone(request) ? 'Share' : 'Share this page'}
          description={request.origin ? `${request.origin} wants to share` : undefined}
          scrolled={scrolled}
        />
        <div
          className="zen-bm-popover-body zen-share-body"
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          <div className="zen-share-preview">
            <div className="zen-share-preview-title">{preview.title}</div>
            {preview.detail && (
              <div className="zen-share-preview-detail" dir="ltr">
                {preview.detail}
              </div>
            )}
            {files > 0 && (
              <div className="zen-share-preview-detail flex items-center gap-1.5">
                <Paperclip className="zen-share-glyph" aria-hidden />
                {files === 1 ? request.files[0].name : `${files} files`}
              </div>
            )}
          </div>
          {qr && qrBox && (
            <div className="zen-share-qr" data-share-qr="">
              <svg
                viewBox={`0 0 ${QR_INNER} ${QR_INNER}`}
                width={QR_TILE}
                height={QR_TILE}
                shapeRendering="crispEdges"
                role="img"
                aria-label={`QR code for ${request.url}`}
              >
                {/* The symbol's own colours, content not chrome: a scanner wants black on white. */}
                <rect width={QR_INNER} height={QR_INNER} fill="#fff" />
                {/* A whole number of pixels a module, centred; the white around it is padding. */}
                <g transform={`translate(${qrBox.offset} ${qrBox.offset}) scale(${qrBox.scale})`}>
                  <path d={qr.path} fill="#000" />
                </g>
              </svg>
            </div>
          )}
          <div className="zen-share-targets" role="group" aria-label="Share with">
            {targets.map(({ answer: choice, label, description, icon: Icon }) => (
              <button
                key={choice}
                type="button"
                className={cn('zen-v2-row', description && 'zen-share-row-two')}
                data-share-target={choice}
                data-lines={description ? '2' : undefined}
                onClick={() => answer(choice)}
              >
                <span className="zen-v2-row-body">
                  <Icon className="zen-v2-row-lead" aria-hidden />
                  <span className="zen-v2-row-text">
                    <span className="zen-v2-label truncate">{label}</span>
                    {description && <span className="zen-v2-description">{description}</span>}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </ChromePortal>
  )
}

/**
 * What the popover hangs from: the anchor's viewport rect and its bar's – the pill is its own
 * bar; a control that asked for the share stands in a dialog's footer, whose bar is the dialog
 * (`role="dialog"`: the footer's halves are the dialog's, and its bottom edge is where the
 * popover hangs from, §9.20), or itself with no dialog around it. Both on whole pixels (§9.16:
 * the popover's hairline on one row, though the dialog is centred on a half). Measured after
 * layout, again on every state push (the pill's chips come and go with the page) and when the
 * anchor or the window resizes; null while neither is on screen.
 */
interface Seat {
  anchor: Rect
  bar: Rect
}

function useAnchorRect(state: UIState): Seat | null {
  const [seat, setSeat] = useState<Seat | null>(null)
  useLayoutEffect(() => {
    const anchor = anchorElement()
    const measure = (): void => {
      if (!anchor) {
        setSeat(null)
        return
      }
      const dialog = anchor.hasAttribute('data-share-anchor')
        ? anchor.closest<HTMLElement>('[role="dialog"]')
        : null
      const next: Seat = {
        anchor: snap(toRect(anchor.getBoundingClientRect())),
        bar: snap(toRect((dialog ?? anchor).getBoundingClientRect()))
      }
      setSeat((prev) => (sameSeat(prev, next) ? prev : next))
    }
    measure()
    if (!anchor) return
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(anchor)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [state])
  return seat
}

function snap(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: r.width, height: r.height }
}

function sameSeat(a: Seat | null, b: Seat | null): boolean {
  if (!a || !b) return a === b
  return sameRect(a.anchor, b.anchor) && sameRect(a.bar, b.bar)
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** A share of files and nothing else – a capture's picture – is not "this page". */
function filesAlone(request: Pick<ShareRequest, 'files' | 'url' | 'text'>): boolean {
  return request.files.length > 0 && !request.url && !request.text
}

/**
 * Where the popover goes: hanging from the bar's bottom edge – the pill's, or the dialog's a
 * footer verb stands in – aligned with the anchor by its half of the bar (start-aligned with
 * the pill; end-aligned with a Share in a footer's trailing half), as tall as its content
 * measured (`height`; the cap while the measure is not in yet); with no anchor on screen (an
 * app window's chrome), in the window's top trailing corner like the star bubble.
 */
function place(seat: Seat | null, height: number | null): PopoverBox {
  const viewport = viewportSize()
  const corner: Rect = {
    x: viewport.width - POPOVER_MARGIN - 28,
    y: 28,
    width: 28,
    height: 28
  }
  const { anchor, bar } = seat ?? { anchor: corner, bar: corner }
  return placePopover(anchor, bar, viewport, WIDTH, height && height > 0 ? height : undefined)
}
