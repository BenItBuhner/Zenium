import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import {
  ArmedTint,
  BUBBLE_SIZE,
  bubbleHostFrame,
  bubbleVisuals,
  captionText,
  historyNavHost,
  historyNavStore,
  onHistoryNavFrame,
  TINT_PROPERTY,
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
 * DOM (`data-phase`, `data-edge`, `data-armed`, `data-close-target`) for whoever reads it.
 *
 * At the first page of the tab's history the bubble carries Chrome's caption while armed –
 * 'Close tab' / 'Close Zenium' (`captionText`) – the pill widening out of the disc by the
 * frame's `caption`: the host's frame carries the extent and the text; the DOM disc widens by
 * the caption's measured width, the arrow staying in its 44 at the start.
 *
 * Armed, the arrow wears the accent, and the caption the arrow's ink – Chrome's 250 ms to
 * `--v2-control-accent` as the drag arms and back as it disarms, 120 ms under reduced motion
 * (the lead's 04:34 ruling, v2 §11.9 amended for the arrow alone): the tint (`ArmedTint`) is
 * stepped on the machine's frames and the disc's own animation frames between them, and written
 * to the disc's `--zen-histnav-tint`, which `main.css` mixes the glyph's and the caption's
 * `color` from – per frame, not a CSS transition, as the reduced-motion stylesheet leaves
 * transitions to opacity fades alone; the host's disc runs the same tween itself. The disc's
 * fill and hairline never tint.
 */
export function HistoryNavBubble(): JSX.Element | null {
  const phase = historyNavStore.use((s) => s.phase)
  const edge = historyNavStore.use((s) => s.edge)
  const closeTarget = historyNavStore.use((s) => s.closeTarget)
  const rootRef = useRef<HTMLDivElement>(null)
  const discRef = useRef<HTMLDivElement>(null)
  const captionRef = useRef<HTMLSpanElement>(null)
  const tintRef = useRef<ArmedTint | null>(null)
  const active = phase !== 'idle'
  const hosted = historyNavHost() !== null

  useEffect(() => {
    if (!active) return
    const host = historyNavHost()
    // Measured once per drag: the content frame does not move under a history drag (the one
    // finger down is the drag's), and a read per frame would be a layout read per frame.
    let anchor: BubbleAnchor | null = null
    // The caption's width likewise, the first frame it shows.
    let captionWidth: number | null = null
    // The arrow's tint, written as it moves: on the machine's frames, and on the disc's own
    // animation frames while it has a way to go after the springs have settled.
    const tint = (tintRef.current ??= new ArmedTint())
    let tintWritten = -1
    let tintFrame = 0
    const writeTint = (disc: HTMLElement, value: number): void => {
      if (value === tintWritten) return
      tintWritten = value
      disc.style.setProperty(TINT_PROPERTY, value.toFixed(3))
    }
    const tintTick = (): void => {
      tintFrame = 0
      const disc = discRef.current
      if (!disc || !tint.running) return
      writeTint(disc, tint.step(performance.now()))
      if (tint.running) tintFrame = requestAnimationFrame(tintTick)
    }
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
      writeTint(disc, tint.take(state.armed, reducedMotion(), performance.now()))
      if (tint.running && tintFrame === 0) tintFrame = requestAnimationFrame(tintTick)
      const caption = captionRef.current
      if (caption) {
        captionWidth ??= frame.caption > 0 ? caption.scrollWidth : null
        disc.style.width = `${BUBBLE_SIZE + frame.caption * (captionWidth ?? 0)}px`
      }
    })
    return () => {
      unsubscribe()
      // The bubble is down (idle) or this frame is gone: the tint resets for the next drag, and
      // the host's disc goes with it.
      if (tintFrame !== 0) cancelAnimationFrame(tintFrame)
      tint.take(null, false, performance.now())
      host?.apply(null)
    }
  }, [active])

  if (!active) return null
  const Arrow = edge === 'left' ? ArrowLeft : ArrowRight
  const caption = captionText(closeTarget)
  return (
    <div
      ref={rootRef}
      className="zen-histnav pointer-events-none absolute inset-y-0 z-[5]"
      style={edge === 'left' ? { left: 0 } : { right: 0 }}
      data-edge={edge}
      data-phase={phase}
      data-reduced={reducedMotion() || undefined}
      data-hosted={hosted || undefined}
      data-close-target={closeTarget === 'none' ? undefined : closeTarget}
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
          {caption !== null && (
            <span
              ref={captionRef}
              className="zen-histnav-caption"
              data-testid="history-nav-caption"
            >
              {caption}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
