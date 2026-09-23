import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { ARMED_GROWTH, historyNavStore, onHistoryNavFrame } from '@renderer/lib/historyNav'
import { reducedMotion } from '@renderer/lib/motion/spring'

/** The disc's diameter, CSS px: Chrome's `navigation_bubble_size`. */
const BUBBLE = 44
/** The bubble is fully opaque once its leading edge has come this far in from the side. */
const FADE_IN = 16

/**
 * Chrome's history navigation bubble (GN-04): a disc with an arrow that a drag in from a page's
 * side pulls out from beyond that side, vertically centred on the content frame as Chrome's
 * `SideSlideLayout` lays it. The host recognises the drag in 3-button navigation mode and the
 * machine in `lib/historyNav.ts` turns it into the bubble's offset, its armed growth and its
 * hide; everything per frame goes straight to the DOM through refs – transform and opacity, and
 * the `data-armed` flag the accent arrow's 250 ms tint reads – so a drag re-renders nothing.
 * Idle it draws nothing at all, so hosts without the gesture pay nothing for it.
 */
export function HistoryNavBubble(): JSX.Element | null {
  const phase = historyNavStore.use((s) => s.phase)
  const edge = historyNavStore.use((s) => s.edge)
  const discRef = useRef<HTMLDivElement>(null)
  const active = phase !== 'idle'

  useEffect(() => {
    if (!active) return
    return onHistoryNavFrame(({ offset, hide, grow }, state) => {
      const disc = discRef.current
      if (!disc) return
      // The disc's far side sits on the page's edge at rest: its leading edge is `offset` in.
      const x = offset - BUBBLE
      const shown = 1 - hide
      const scale = (1 + ARMED_GROWTH * grow) * shown
      disc.style.transform = `translate3d(${state.edge === 'left' ? x : -x}px, -50%, 0) scale(${scale})`
      disc.style.opacity = String(Math.min(1, offset / FADE_IN) * shown)
      if (state.armed) disc.dataset.armed = ''
      else delete disc.dataset.armed
    })
  }, [active])

  if (!active) return null
  const Arrow = edge === 'left' ? ArrowLeft : ArrowRight
  return (
    <div
      className="zen-histnav pointer-events-none absolute inset-y-0 z-[5]"
      style={edge === 'left' ? { left: 0 } : { right: 0 }}
      data-edge={edge}
      data-phase={phase}
      data-reduced={reducedMotion() || undefined}
      data-testid="history-nav"
      aria-hidden
    >
      <div
        ref={discRef}
        className="zen-histnav-disc absolute top-1/2"
        data-testid="history-nav-bubble"
        style={{
          width: BUBBLE,
          height: BUBBLE,
          ...(edge === 'left' ? { left: 0 } : { right: 0 }),
          transform: `translate3d(${edge === 'left' ? -BUBBLE : BUBBLE}px, -50%, 0)`,
          opacity: 0
        }}
      >
        <span className="zen-histnav-glyph zen-histnav-ink">
          <Arrow />
        </span>
        <span className="zen-histnav-glyph zen-histnav-accent">
          <Arrow />
        </span>
      </div>
    </div>
  )
}
