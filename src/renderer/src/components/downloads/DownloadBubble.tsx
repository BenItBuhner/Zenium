import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Rect, UIState } from '@shared/types'
import {
  DOWNLOAD_LINGER_MS,
  bubbleItems,
  closeDownloadBubble,
  downloadsUi,
  showAllDownloads
} from '@renderer/lib/downloads'
import { downloadsEngine } from '@renderer/lib/downloadsEngine'
import { bubbleDescription } from '@renderer/lib/downloadsView'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  type PopoverBox,
  placePopover,
  popoverStyle,
  toRect,
  useLightDismiss,
  viewportSize
} from '@renderer/lib/portals'
import { browserStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useEscapeTrap } from '../bookmarks/escape'
import { tabbables, useScrolled, wrapTab } from '../bookmarks/popover'
import { DownloadRow } from './DownloadParts'

/** The toolbar button the bubble hangs from, and the bar or toolbar row it sits in. */
const BUTTON = '[data-zen-downloads-button]'
const BAR = '[data-zen-nav-bar]'
const ROW = '[data-zen-nav-row]'
/** Rows with trailing controls: the 400 popover (design language v2 §9.20). */
const WIDTH = POPOVER_WIDTH.form

/**
 * The downloads bubble (Chrome 112+): the current list under the toolbar button, or only the
 * items that just finished when it opened by itself. Mounted once above whichever shell is up;
 * the live page behind shows its snapshot while the bubble is up.
 */
export function DownloadBubbleLayer(): JSX.Element | null {
  const open = downloadsUi.use((s) => s.open)
  const state = browserStore.use((s) => s.state)
  if (!open || !state) return null
  return <Bubble state={state} />
}

/**
 * A desktop popover (v2 draft §9.20) through the chrome layer: 400 wide, its top border on the
 * bottom edge of the bar the button sits in, end-aligned with the button (it sits in the bar's
 * trailing half), never taller than 60% of the window – the rows scroll under the sticky title
 * block (§9.23), which draws the §9.7 hairline once they have moved. Placed once on open and
 * again when the chrome changes; never animated between positions. Registered for the layer's
 * light dismiss: a press anywhere else, a scroll, a resize and another popover opening put it
 * away and hand the keyboard back to the page; the button's own press closes it and keeps the
 * keyboard there. Escape closes it and returns the keyboard to the button (§9.22); opened by
 * the user, the keyboard moves to the first row and Tab wraps inside.
 */
function Bubble({ state }: { state: UIState }): JSX.Element {
  const ui = downloadsUi.use()
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<PopoverBox>(() => place())
  const [held, setHeld] = useState(false)
  const scrolled = useScrolled(bodyRef)
  const items = bubbleItems(downloadsEngine.list(state), ui.partial)
  const description = bubbleDescription(items)

  // Hangs from the button in its bar, measured again on every state push (the bar's buttons
  // come and go with the tab) and on resize; the box only changes when the measurement does.
  useLayoutEffect(() => {
    const measure = (): void => setBox((prev) => (sameBox(prev, place()) ? prev : place()))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [state])

  // The keyboard moves into a bubble the user asked for (§9.22): its first row, or the panel
  // itself when there is none. An auto-opened bubble leaves the keyboard where it was.
  useEffect(() => {
    if (!ui.takeFocus) return
    const panel = panelRef.current
    if (!panel) return
    const first = panel.querySelector<HTMLElement>('[data-download-id]') ?? tabbables(panel)[0]
    ;(first ?? panel).focus({ preventScroll: true })
  }, [ui.takeFocus])

  useEscapeTrap(true, () => closeDownloadBubble({ focus: 'anchor' }))

  useLightDismiss(
    panelRef,
    (reason) =>
      closeDownloadBubble({
        focus: reason === 'anchor' || reason === 'replaced' || reason === 'all' ? 'keep' : 'page'
      }),
    { anchor: () => document.querySelector(BUTTON), disabled: ui.closing }
  )

  // The auto-opened bubble leaves after five idle seconds; a pointer or focus on it holds it.
  useEffect(() => {
    if (!ui.autoClose || held) return
    const timer = setTimeout(() => closeDownloadBubble(), DOWNLOAD_LINGER_MS)
    return () => clearTimeout(timer)
  }, [ui.autoClose, held])

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    wrapTab(e, panelRef.current)
  }

  return (
    <ChromePortal>
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby="zen-dl-title"
        aria-describedby={description ? 'zen-dl-desc' : undefined}
        data-zen-downloads-bubble
        data-partial={ui.partial ? 'true' : undefined}
        tabIndex={-1}
        className={cn(
          'zen-bm-popover zen-dl-surface zen-dl-bubble fixed z-[70] flex flex-col outline-none',
          ui.closing ? 'zen-dl-pop-out' : 'zen-animate-pop'
        )}
        style={popoverStyle(box)}
        onKeyDown={onKeyDown}
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false)
        }}
      >
        <div className="zen-bm-title-block" data-scrolled={scrolled || undefined}>
          <h2 id="zen-dl-title" className="zen-bm-title">
            Downloads
          </h2>
          {description && (
            <p id="zen-dl-desc" className="zen-bm-title-desc tabular-nums" aria-live="polite">
              {description}
            </p>
          )}
        </div>
        <div ref={bodyRef} className="zen-bm-popover-body">
          {items.length === 0 ? (
            <p className="zen-dl-empty">Files you download appear here</p>
          ) : (
            <ul className="zen-dl-list">
              {items.map((item) => (
                <DownloadRow key={item.id} item={item} highlighted={item.id === ui.highlightId} />
              ))}
            </ul>
          )}
        </div>
        <div className="zen-dl-bubble-footer">
          <button
            type="button"
            className="zen-button zen-dl-show-all"
            data-variant="quiet"
            onClick={() => showAllDownloads(state)}
          >
            Show all downloads
          </button>
        </div>
      </div>
    </ChromePortal>
  )
}

/**
 * Where the bubble goes: hanging from the bar the toolbar button sits in (the sidebar's
 * navigation row or the top toolbar's row), end-aligned with the button. A button standing in
 * a column (compact mode) is its own bar; a button not on screen (a shortcut opened the bubble
 * before the button appeared) puts it in the window's top trailing corner.
 */
function place(): PopoverBox {
  const viewport = viewportSize()
  const button = document.querySelector(BUTTON)
  const anchor: Rect = button
    ? toRect(button.getBoundingClientRect())
    : { x: viewport.width - POPOVER_MARGIN - 28, y: 28, width: 28, height: 28 }
  const barEl = button?.closest(BAR) ?? button?.closest(ROW) ?? null
  const measured = barEl ? toRect(barEl.getBoundingClientRect()) : anchor
  const bar = measured.height > measured.width ? anchor : measured
  return placePopover(anchor, bar, viewport, WIDTH)
}

function sameBox(a: PopoverBox, b: PopoverBox): boolean {
  if (a.left !== b.left || a.width !== b.width || a.maxHeight !== b.maxHeight) return false
  return a.side === 'below'
    ? b.side === 'below' && a.top === b.top
    : b.side === 'above' && a.bottom === b.bottom
}
