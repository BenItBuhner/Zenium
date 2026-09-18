import { useEffect, useLayoutEffect, useMemo, type RefObject } from 'react'
import { collectCells, FlipTracker, layoutAnimations } from '@renderer/lib/motion/flip'

/**
 * Glide the overview's cells to their new slots after every re-layout (see `FlipTracker`). The
 * cells are whatever carries `data-cell` under the grid's scroller – page cards, the New Tab
 * card, group cards – collected after every commit, so every kind of card is in the one set
 * and moves on the one spring. Nothing is measured while the grid is scaling in – the overview
 * re-renders every frame of that spring, and a forced layout per card per frame would slow the
 * very frames the spring is paced by – and glides pause while a group is animating its height.
 */
export function useFlip(scroller: RefObject<HTMLElement | null>, enabled: boolean): FlipTracker {
  const tracker = useMemo(() => new FlipTracker(), [])
  useLayoutEffect(() => {
    const cells = collectCells(scroller.current)
    if (enabled) tracker.commit(cells, scroller.current, !layoutAnimations.any())
    else tracker.observe(cells)
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
