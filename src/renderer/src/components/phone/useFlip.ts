import { useEffect, useLayoutEffect, useMemo, type RefObject } from 'react'
import { FlipTracker, layoutAnimations } from '@renderer/lib/motion/flip'

/**
 * Glide the overview's cells to their new slots after every re-layout (see `FlipTracker`).
 * Suspended while the grid is scaling in and while a group is animating its height.
 */
export function useFlip(
  cells: RefObject<Map<string, HTMLElement>>,
  scroller: RefObject<HTMLElement | null>,
  enabled: boolean
): FlipTracker {
  const tracker = useMemo(() => new FlipTracker(), [])
  useLayoutEffect(() => {
    tracker.commit(cells.current, scroller.current, enabled && !layoutAnimations.any())
  })
  useEffect(() => () => tracker.stop(), [tracker])
  return tracker
}
