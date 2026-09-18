import { useEffect, useLayoutEffect, useMemo, type RefObject } from 'react'
import { collectCells, FlipTracker } from '@renderer/lib/motion/flip'

/**
 * Glide the overview's cells to their new slots after every re-layout (see `FlipTracker`). The
 * cells are whatever carries `data-cell` under the grid's scroller – page cards, the New Tab
 * card, group cards – collected after every commit, so every kind of card is in the one set
 * and moves on the one spring. Nothing is measured while the grid is scaling in – the overview
 * re-renders every frame of that spring, and a forced layout per card per frame would slow the
 * very frames the spring is paced by. A group animating its height holds the cells below it
 * until it has settled; the tracker hears of that through `layoutAnimations` on its own.
 */
export function useFlip(scroller: RefObject<HTMLElement | null>, enabled: boolean): FlipTracker {
  const tracker = useMemo(() => new FlipTracker(), [])
  useLayoutEffect(() => {
    const cells = collectCells(scroller.current)
    if (enabled) tracker.commit(cells, scroller.current, true)
    else tracker.observe(cells)
  })
  useEffect(() => () => tracker.dispose(), [tracker])
  return tracker
}
