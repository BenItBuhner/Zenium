import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Rect, Tab } from '@shared/types'
import { cssPx } from '@renderer/lib/gestures/dock'
import { SpringAnimation } from '@renderer/lib/motion/spring'
import {
  arriveNewTabGrow,
  finishNewTabGrow,
  growClipPath,
  growFrame,
  growHolePath,
  growProgress,
  growSurfaceOpacity,
  growTravel,
  newTabGrowStore,
  SPRING_GROW
} from '@renderer/lib/newtab'
import { browserStore, contentAreaStore } from '@renderer/lib/ui'
import { TabPreview } from '../phone/TabPreview'

/**
 * A new tab opened from a control on screen (MOT-03): a surface in the window's colour grows out
 * of the control's bounds into the content frame, its corners shrinking from the control's pill
 * to the frame's radius, over the page's last capture; from seven tenths of the way the surface
 * fades on the same progress and the new tab page shows through it, whole as it arrives (design
 * language v2 §11, rule 4's exception: one value, no second clock). Mounted above the shell; it
 * draws nothing while no tab is being opened.
 */
export function NewTabGrowLayer(): JSX.Element | null {
  const grow = newTabGrowStore.use()
  const area = contentAreaStore.use((s) => s.area)
  const from = browserStore.use((s) =>
    grow.fromTabId ? (s.state?.tabs[grow.fromTabId] ?? null) : null
  )
  if (grow.phase === 'idle' || !grow.origin || !area) return null
  return <GrowSurface origin={grow.origin} frame={area} from={from} />
}

function GrowSurface({
  origin,
  frame,
  from
}: {
  origin: Rect
  frame: Rect
  from: Tab | null
}): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const captureRef = useRef<HTMLDivElement>(null)
  // Where the surface is heading is fixed the moment it starts; a frame that moves meanwhile
  // (the keyboard closing) is not chased.
  const target = useRef({ origin, frame })

  // Before the first paint, so the surface is never seen unclipped.
  useLayoutEffect(() => {
    const layer = layerRef.current
    const surface = surfaceRef.current
    if (!layer || !surface) return
    const { origin, frame } = target.current
    const box: Rect = { x: 0, y: 0, width: layer.clientWidth, height: layer.clientHeight }
    const radius = cssPx('--zen-content-radius', 14)
    const travel = growTravel(origin, frame)
    const apply = (progress: number): void => {
      const g = growFrame(progress, origin, frame, radius)
      surface.style.clipPath = growClipPath(g, box)
      surface.style.opacity = String(growSurfaceOpacity(progress))
      // The capture under the surface loses the surface's rectangle, so the fade shows the new
      // page beneath the layer and not the page being left.
      const capture = captureRef.current
      if (capture) capture.style.clipPath = growHolePath(g, frame)
      growProgress(progress)
    }
    apply(0)
    const spring = new SpringAnimation(
      SPRING_GROW,
      (x) => apply(x / travel),
      () => {
        apply(1)
        arriveNewTabGrow()
      }
    )
    spring.start(0, 0, travel)
    return () => {
      spring.stop()
    }
  }, [])

  // Taken down mid-flight (the layout changed under it): nothing may stay hidden.
  useEffect(() => () => finishNewTabGrow(), [])

  return (
    <div ref={layerRef} className="pointer-events-none fixed inset-0 z-[35]" aria-hidden>
      {from && (
        <div
          ref={captureRef}
          className="zen-stage-card zen-ntp-grow-capture absolute"
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        >
          <TabPreview tab={from} />
        </div>
      )}
      <div ref={surfaceRef} className="zen-ntp-grow-surface absolute inset-0" />
    </div>
  )
}
