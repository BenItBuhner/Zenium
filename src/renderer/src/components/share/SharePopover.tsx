import type { JSX } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Paperclip } from 'lucide-react'
import type { Rect, ShareAnswer, ShareRequest, UIState } from '@shared/types'
import { useChromeSurface } from '@renderer/hooks/useChromeSurface'
import { usePopover } from '@renderer/hooks/usePopover'
import { run } from '@renderer/lib/api'
import { useLightDismiss } from '@renderer/lib/popoverStore'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  type PopoverBox,
  placePopover,
  popoverStyle,
  toRect,
  viewportSize
} from '@renderer/lib/portals'
import { qrSymbol } from '@renderer/lib/qr'
import { sharePreview, shareTargets } from '@renderer/lib/share'
import { cn } from '@renderer/lib/utils'
import { useScrolled } from '../bookmarks/popover'
import { V2TitleBlock } from '../extensions/v2'

/** The address pill the popover hangs from (Chrome's share bubble hangs from the omnibox). */
const PILL = '.zen-pill'
/** A list of targets without trailing controls (§9.20). */
const WIDTH = POPOVER_WIDTH.list
/** The QR's tile: the symbol's side in CSS px, inside the tile's 8 px padding. */
const QR_SIZE = 160

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
 * the pill, placed by `placePopover` (flip, slide, shrink, 8 inside the window); radius 8, the
 * panel shadow, no scrim (§9.5), through the chrome layer (`ChromePortal`). A title block
 * (§9.23) – "Share" with the sharing site as its description for a page's `navigator.share`,
 * "Share this page" for the menu's – stays put while the body scrolls under it (§9.7). The body:
 * what is shared (its title and link or text, and the files' count and size), the link's QR
 * code on a white tile (the symbol keeps black on white in either scheme, as a scanner and
 * Chrome's QR bubble want; the tile's border and radius are the card's), then the targets as
 * shared rows with a leading 16 glyph – Copy link (or Copy text), Email, Save when the share
 * carries files or an image, and "More…" for the OS's own sheet where there is one (macOS). A
 * row answers the request (`share.respond`) and the popover leaves with it; Escape, a press
 * anywhere else, a resize and another popover opening dismiss it, which a page hears as
 * `AbortError`. Focus moves to the first row and Tab wraps (§9.22).
 */
function SharePopover({ request, state }: { request: ShareRequest; state: UIState }): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrolled = useScrolled(bodyRef)
  const pill = usePillRect(state)
  const box = place(pill)

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
  usePopover(panelRef, { onClose: dismiss })
  useLightDismiss(panelRef, dismiss, { anchor: () => document.querySelector(PILL) })

  const preview = sharePreview(request)
  const qr = useMemo(() => qrSymbol(request.url), [request.url])
  const targets = shareTargets(request)
  const files = request.files.length
  return (
    <ChromePortal>
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby="zen-share-title"
        data-share-popover=""
        data-surface="page"
        className="zen-v2 zen-animate-pop zen-bm-popover zen-share-popover fixed z-[70] flex flex-col outline-none"
        style={popoverStyle(box)}
        tabIndex={-1}
      >
        <V2TitleBlock
          id="zen-share-title"
          title={request.origin ? 'Share' : 'Share this page'}
          description={request.origin ? `${request.origin} wants to share` : undefined}
          scrolled={scrolled}
        />
        <div ref={bodyRef} className="zen-bm-popover-body zen-share-body">
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
          {qr && (
            <div className="zen-share-qr" data-share-qr="">
              <svg
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                width={QR_SIZE}
                height={QR_SIZE}
                shapeRendering="crispEdges"
                role="img"
                aria-label={`QR code for ${request.url}`}
              >
                {/* The symbol's own colours, content not chrome: a scanner wants black on white. */}
                <rect width={qr.size} height={qr.size} fill="#fff" />
                <path d={qr.path} fill="#000" />
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
 * The viewport rect of the address pill, measured after layout, again on every state push (the
 * pill's chips come and go with the page) and when it or the window resizes; null while no pill
 * is on screen.
 */
function usePillRect(state: UIState): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null)
  useLayoutEffect(() => {
    const pill = document.querySelector<HTMLElement>(PILL)
    const measure = (): void => {
      const next = pill ? toRect(pill.getBoundingClientRect()) : null
      setRect((prev) => (sameRect(prev, next) ? prev : next))
    }
    measure()
    if (!pill) return
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(pill)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [state])
  return rect
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Where the popover goes: hanging from the pill's bottom edge, start-aligned with it (the pill
 * is its own bar); with no pill on screen (an app window's chrome), in the window's top
 * trailing corner like the star bubble.
 */
function place(pill: Rect | null): PopoverBox {
  const viewport = viewportSize()
  const rect: Rect = pill ?? {
    x: viewport.width - POPOVER_MARGIN - 28,
    y: 28,
    width: 28,
    height: 28
  }
  return placePopover(rect, rect, viewport, WIDTH)
}
