import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { Rect, UIState } from '@shared/types'
import { ZOOM_CEILING, ZOOM_FLOOR, formatZoom } from '@shared/pageControls'
import { run } from '@renderer/lib/api'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  placePopover,
  toRect,
  viewportSize
} from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { closeZoomBubble, type UiState } from '@renderer/lib/ui'
import { useEscapeTrap } from '../bookmarks/escape'
import { focusAnchor, wrapTab } from '../bookmarks/popover'
import { WheelZoom, bubbleTimeout, defaultZoomFor } from './bubble'

type Bubble = NonNullable<UiState['zoomBubble']>

const CHIP = '[data-zoom-chip]'
const WIDTH = POPOVER_WIDTH.list

/**
 * Chrome's zoom bubble: it comes up under the address pill when the page is zoomed (Ctrl+plus,
 * Ctrl+wheel, the menu) and says where the zoom stands, with a step either way and Reset. Left
 * alone it goes after 1.5 s – 5 s once one of its buttons was used – and waits while the
 * pointer rests on it; opened from the pill's zoom chip it stays until Escape, a click outside
 * or the chip itself puts it away. Escape hands the keyboard back to the chip (§9.22).
 *
 * A desktop popover (v2 draft §9.20): 320 wide, its top border on the pill's bottom edge,
 * end-aligned with the chip, through the chrome layer. The page under it is a picture while it
 * is up (chrome cannot overlap a live view), refreshed at every step by `showZoomBubble`; so the
 * bubble also takes the wheel the page would have had – Ctrl+wheel keeps zooming, a plain turn
 * gives the page back at once.
 */
export function ZoomBubble({ state, bubble }: { state: UIState; bubble: Bubble }): JSX.Element {
  const tab = state.tabs[bubble.tabId]
  const active = activeTab(state)
  const panelRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const [hovered, setHovered] = useState(false)
  const [clicked, setClicked] = useState(false)
  const [box, setBox] = useState(() => place(null))
  const lastAnchor = useRef<Rect | null>(null)

  // The bubble speaks for the page on screen; another tab coming forward, or the tab going,
  // puts it away.
  const gone = !tab || active?.id !== bubble.tabId
  useEffect(() => {
    if (gone) closeZoomBubble()
  }, [gone])

  // Hangs from the chip, measured again on every state push and window resize: the chip arrives
  // with the push that follows the zoom event, and goes when the zoom is back at the default.
  // Then the bubble keeps its place rather than jumping to the pill's edge.
  useLayoutEffect(() => {
    const measure = (): void => {
      const chip = document.querySelector(CHIP)
      if (chip) lastAnchor.current = toRect(chip.getBoundingClientRect())
      const next = place(lastAnchor.current)
      setBox((prev) =>
        prev.left === next.left && prev.top === next.top && prev.width === next.width ? prev : next
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [state])

  // The clock: restarted by every zoom step (`seq`), paused under the pointer, longer once the
  // buttons were used, off for the chip's bubble.
  useEffect(() => {
    const ms = bubbleTimeout({ source: bubble.source, hovered, clicked })
    if (ms === null) return
    const timer = window.setTimeout(() => closeZoomBubble(), ms)
    return () => window.clearTimeout(timer)
  }, [bubble.seq, bubble.source, hovered, clicked])

  // Opened from the chip, the keyboard goes into the bubble (§9.22); a zoom step leaves it be.
  useEffect(() => {
    if (bubble.source === 'chip') firstRef.current?.focus()
  }, [bubble.source])

  useEscapeTrap(true, () => {
    if (document.querySelector(CHIP)) {
      closeZoomBubble({ keepFocus: true })
      focusAnchor(CHIP)
    } else {
      closeZoomBubble()
    }
  })

  // A click anywhere else puts the bubble away; the chip toggles it itself. The wheel over the
  // page's picture: Ctrl+wheel goes on zooming, any other turn is meant for the page, which
  // gets it back as soon as the bubble is gone.
  useEffect(() => {
    const outside = (target: EventTarget | null): boolean => {
      const el = target instanceof Element ? target : null
      return !el || (!panelRef.current?.contains(el) && !el.closest(CHIP))
    }
    const onDown = (e: PointerEvent): void => {
      if (outside(e.target)) closeZoomBubble()
    }
    const wheel = new WheelZoom()
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) {
        e.preventDefault()
        const step = wheel.step(e.deltaY)
        if (step) run('tab.setZoom', { tabId: bubble.tabId, delta: step })
        return
      }
      if (outside(e.target)) closeZoomBubble()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('wheel', onWheel, { capture: true })
    }
  }, [bubble.tabId])

  const { pageControls } = state.settings
  const factor = bubble.factor
  const defaultZoom = tab ? defaultZoomFor(tab.url, pageControls, state.pageEnvironment) : 1
  const atDefault = Math.abs(factor - defaultZoom) < 0.005
  const step = (delta: number | null): void => {
    setClicked(true)
    run('tab.setZoom', { tabId: bubble.tabId, delta })
  }
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
        aria-labelledby="zen-zoom-title"
        aria-describedby="zen-zoom-level"
        data-zoom-bubble=""
        className="zen-animate-pop zen-bm-popover fixed z-[70] flex flex-col"
        style={{ left: box.left, top: box.top, width: box.width }}
        onKeyDown={onKeyDown}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <div className="zen-bm-title-block">
          <h2 id="zen-zoom-title" className="zen-bm-title">
            Zoom
          </h2>
          <p id="zen-zoom-level" className="zen-bm-title-desc tabular-nums" aria-live="polite">
            {formatZoom(factor)}
          </p>
        </div>
        <div className="zen-zoom-controls">
          <button
            ref={firstRef}
            type="button"
            className="zen-button zen-zoom-step"
            aria-label="Zoom out"
            title="Zoom out (Ctrl+-)"
            disabled={factor <= ZOOM_FLOOR + 0.005}
            onClick={() => step(-1)}
          >
            <Minus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="zen-button zen-zoom-step"
            aria-label="Zoom in"
            title="Zoom in (Ctrl++)"
            disabled={factor >= ZOOM_CEILING - 0.005}
            onClick={() => step(1)}
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="zen-button ml-auto"
            title={`Back to ${formatZoom(defaultZoom)} (Ctrl+0)`}
            disabled={atDefault}
            onClick={() => step(null)}
          >
            Reset
          </button>
        </div>
      </div>
    </ChromePortal>
  )
}

/**
 * Where the bubble goes: hanging from the pill's bottom edge, end-aligned with the chip (which
 * sits in the pill's trailing half); with no pill on screen (compact mode) in the window's top
 * trailing corner, like the star bubble.
 */
function place(chip: Rect | null): { left: number; top: number; width: number } {
  const viewport = viewportSize()
  const pill = document.querySelector('.zen-pill')
  const pillRect = pill ? toRect(pill.getBoundingClientRect()) : null
  const anchor = chip ??
    (pillRect && {
      x: pillRect.x + pillRect.width - 28,
      y: pillRect.y,
      width: 28,
      height: pillRect.height
    }) ?? {
      x: viewport.width - POPOVER_MARGIN - 28,
      y: 28,
      width: 28,
      height: 28
    }
  const { left, top, width } = placePopover(anchor, pillRect ?? anchor, viewport, WIDTH)
  return { left, top, width }
}
