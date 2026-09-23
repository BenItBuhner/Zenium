import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import {
  BUBBLE_SIZE,
  bubbleHostFrame,
  bubbleVisuals,
  historyNavHost,
  historyNavStore,
  onHistoryNavFrame,
  type BubbleAnchor,
  type HistoryNavEdge
} from '@renderer/lib/historyNav'
import { reducedMotion } from '@renderer/lib/motion/spring'

/**
 * The page frame's side the drag began at and its vertical centre, off the root: it is laid
 * along that side of the content frame with no width of its own, so its box is the side. The
 * clip is the root's parent – the viewport whose `overflow: hidden` clips the DOM disc – read in
 * the same frame as the side (one layout for both).
 */
function measureAnchor(root: HTMLElement, edge: HistoryNavEdge): BubbleAnchor {
  const rect = root.getBoundingClientRect()
  const frame = (root.parentElement ?? root).getBoundingClientRect()
  return {
    x: edge === 'left' ? rect.left : rect.right,
    centerY: (rect.top + rect.bottom) / 2,
    clip: { left: frame.left, top: frame.top, right: frame.right, bottom: frame.bottom }
  }
}

/**
 * Chrome's history navigation bubble (GN-04, v2 §11.9): a disc with an arrow that a drag in from
 * a page's side pulls out from beyond that side, vertically centred on the content frame as
 * Chrome's `SideSlideLayout` lays it. The host recognises the drag in 3-button navigation mode
 * and the machine in `lib/historyNav.ts` turns it into the bubble's offset, its growth and its
 * hide; everything per frame goes straight to the DOM through refs – transform and opacity, and
 * the `data-armed` flag as the drag's state – so a drag re-renders nothing. Idle it draws
 * nothing at all, so hosts without the gesture pay nothing for it.
 *
 * Where the pages are layered above the chrome (Android), nothing drawn here at a page's side
 * could show: with a host bound (`setHistoryNavHost`) the disc is the host's, fed the same
 * frames as the disc's box in window px with the viewport's box as its clip (the frame's
 * `overflow: hidden` the DOM disc emerges under), and the root stays as the drag's state on the
 * DOM (`data-phase`, `data-edge`, `data-armed`) for whoever reads it.
 */
export function HistoryNavBubble(): JSX.Element | null {
  const phase = historyNavStore.use((s) => s.phase)
  const edge = historyNavStore.use((s) => s.edge)
  const rootRef = useRef<HTMLDivElement>(null)
  const discRef = useRef<HTMLDivElement>(null)
  const active = phase !== 'idle'
  const hosted = historyNavHost() !== null

  useEffect(() => {
    if (!active) return
    const host = historyNavHost()
    // Measured once per drag: the content frame does not move under a history drag (the one
    // finger down is the drag's), and a read per frame would be a layout read per frame.
    let anchor: BubbleAnchor | null = null
    const unsubscribe = onHistoryNavFrame((frame, state) => {
      const root = rootRef.current
      if (!root) return
      if (state.armed) root.dataset.armed = ''
      else delete root.dataset.armed
      if (host) {
        anchor ??= measureAnchor(root, state.edge)
        host.apply(bubbleHostFrame(frame, state, anchor, reducedMotion()))
        return
      }
      const disc = discRef.current
      if (!disc) return
      const { x, scale, opacity } = bubbleVisuals(frame, reducedMotion())
      disc.style.transform = `translate3d(${state.edge === 'left' ? x : -x}px, -50%, 0) scale(${scale})`
      disc.style.opacity = String(opacity)
      if (state.armed) disc.dataset.armed = ''
      else delete disc.dataset.armed
    })
    return () => {
      unsubscribe()
      // The bubble is down (idle) or this frame is gone: the host's disc goes with it.
      host?.apply(null)
    }
  }, [active])

  if (!active) return null
  const Arrow = edge === 'left' ? ArrowLeft : ArrowRight
  return (
    <div
      ref={rootRef}
      className="zen-histnav pointer-events-none absolute inset-y-0 z-[5]"
      style={edge === 'left' ? { left: 0 } : { right: 0 }}
      data-edge={edge}
      data-phase={phase}
      data-reduced={reducedMotion() || undefined}
      data-hosted={hosted || undefined}
      data-testid="history-nav"
      aria-hidden
    >
      {!hosted && (
        <div
          ref={discRef}
          className="zen-histnav-disc absolute top-1/2"
          data-testid="history-nav-bubble"
          style={{
            width: BUBBLE_SIZE,
            height: BUBBLE_SIZE,
            ...(edge === 'left' ? { left: 0 } : { right: 0 }),
            transform: `translate3d(${edge === 'left' ? -BUBBLE_SIZE : BUBBLE_SIZE}px, -50%, 0)`,
            opacity: 0
          }}
        >
          <span className="zen-histnav-glyph">
            <Arrow />
          </span>
        </div>
      )}
    </div>
  )
}
