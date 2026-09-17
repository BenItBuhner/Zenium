import { useEffect, useLayoutEffect, useMemo, type RefObject } from 'react'
import { FlipTracker, layoutAnimations } from '@renderer/lib/motion/flip'

/**
 * Glide the overview's cells to their new slots after every re-layout (see `FlipTracker`).
 * Nothing is measured while the grid is scaling in – the overview re-renders every frame of
 * that spring, and a forced layout per card per frame would slow the very frames the spring is
 * paced by – and glides pause while a group is animating its height.
 */
export function useFlip(
  cells: RefObject<Map<string, HTMLElement>>,
  scroller: RefObject<HTMLElement | null>,
  enabled: boolean
): FlipTracker {
  const tracker = useMemo(() => new FlipTracker(), [])
  useLayoutEffect(() => {
    if (!enabled) return
    tracker.commit(cells.current, scroller.current, !layoutAnimations.any())
  })
  useEffect(() => {
    // A group finished changing height: the cards below it are where they are now.
    const unsubscribe = layoutAnimations.onSettled(() => tracker.rebaseline())
    return () => {
      unsubscribe()
      tracker.stop()
    }
  }, [tracker])
  return tracker
}
