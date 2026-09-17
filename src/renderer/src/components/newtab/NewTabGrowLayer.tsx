import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import type { Rect, Tab } from '@shared/types'
import { cssPx } from '@renderer/lib/gestures/dock'
import { SpringAnimation } from '@renderer/lib/motion/spring'
import {
  finishNewTabGrow,
  growClipPath,
  growFrame,
  growTravel,
  newTabGrowStore,
  revealNewTabPage,
  SPRING_GROW,
  type NewTabGrowPhase
} from '@renderer/lib/newtab'
import { browserStore, contentAreaStore } from '@renderer/lib/ui'
import { TabPreview } from '../phone/TabPreview'

/** How long the surface takes to fade once it has reached the frame (`.zen-ntp-grow-surface`). */
const REVEAL_MS = 200

/**
 * A new tab opened from a control on screen (MOT-03): a surface in the window's colour grows out
 * of the control's bounds into the content frame, its corners shrinking from the control's pill
 * to the frame's radius, over the page's last capture; when it has arrived the new tab page fades
 * in beneath it. Mounted above the shell; it draws nothing while no tab is being opened.
 */
export function NewTabGrowLayer(): JSX.Element | null {
  const grow = newTabGrowStore.use()
  const area = contentAreaStore.use((s) => s.area)
  const from = browserStore.use((s) =>
    grow.fromTabId ? (s.state?.tabs[grow.fromTabId] ?? null) : null
  )
  if (grow.phase === 'idle' || !grow.origin || !area) return null
  return <GrowSurface phase={grow.phase} origin={grow.origin} frame={area} from={from} />
}

function GrowSurface({
  phase,
  origin,
  frame,
  from
}: {
  phase: NewTabGrowPhase
  origin: Rect
  frame: Rect
  from: Tab | null
}): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  // Where the surface is heading is fixed the moment it starts; a frame that moves meanwhile
  // (the keyboard closing) is not chased.
  const target = useRef({ origin, frame })

  useEffect(() => {
    const layer = layerRef.current
    const surface = surfaceRef.current
    if (!layer || !surface) return
    const { origin, frame } = target.current
    const box: Rect = { x: 0, y: 0, width: layer.clientWidth, height: layer.clientHeight }
    const radius = cssPx('--zen-content-radius', 14)
    const travel = growTravel(origin, frame)
    const apply = (progress: number): void => {
      surface.style.clipPath = growClipPath(growFrame(progress, origin, frame, radius), box)
    }
    apply(0)
    const spring = new SpringAnimation(
      SPRING_GROW,
      (x) => apply(x / travel),
      () => {
        apply(1)
        revealNewTabPage()
      }
    )
    spring.start(0, 0, travel)
    return () => {
      spring.stop()
    }
  }, [])

  // The surface has arrived and is fading: once it is gone, the page stands on its own.
  useEffect(() => {
    if (phase !== 'revealing') return
    const timer = setTimeout(finishNewTabGrow, REVEAL_MS)
    return () => clearTimeout(timer)
  }, [phase])

  // Taken down mid-flight (the layout changed under it): nothing may stay hidden.
  useEffect(() => () => finishNewTabGrow(), [])

  return (
    <div ref={layerRef} className="pointer-events-none fixed inset-0 z-[35]" aria-hidden>
      {from && phase === 'growing' && (
        <div
          className="zen-stage-card absolute"
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        >
          <TabPreview tab={from} />
        </div>
      )}
      <div ref={surfaceRef} className="zen-ntp-grow-surface absolute inset-0" data-phase={phase} />
    </div>
  )
}
