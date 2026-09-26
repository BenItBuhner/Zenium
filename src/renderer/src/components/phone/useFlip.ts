import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { collectCells, FlipTracker } from '@renderer/lib/motion/flip'

export interface FlipOptions {
  /**
   * An ancestor of the scroller that may be in motion of its own – the Space slot sliding the
   * grid in (MOT-05) – set while it is. The tracker measures the cells' layout positions with
   * `getBoundingClientRect`, which includes every ancestor's transform: read mid-slide, every
   * cell would seem moved by the slide's offset and glide back by it. So its transform is held
   * at none (an inline `!important`, which outranks an animation's declaration) for the one
   * measurement and let go after, before anything paints.
   */
  frame?: RefObject<HTMLElement | null>
  /**
   * Which grid the cells belong to (the Space's id on the Tabs pane). When it changes the commit
   * takes a fresh baseline and glides nothing: the grid that left and the one that came are two
   * sets with no spatial relation (v2 §11.4) – a key both hold, the New Tab card's, would
   * otherwise glide from the old grid's slot to the new one's while the new grid slides in.
   */
  epoch?: string
}

/**
 * Glide the overview's cells to their new slots after every re-layout (see `FlipTracker`). The
 * cells are whatever carries `data-cell` under the grid's scroller – page cards, the New Tab
 * card, group cards – collected after every commit, so every kind of card is in the one set
 * and moves on the one spring. Nothing is measured while the grid is scaling in – the overview
 * re-renders every frame of that spring, and a forced layout per card per frame would slow the
 * very frames the spring is paced by. A group animating its height holds the cells below it
 * until it has settled; the tracker hears of that through `layoutAnimations` for as long as the
 * grid is mounted – subscribed in an effect, so that StrictMode's mount, cleanup, mount (every
 * dev build) leaves it listening, and unsubscribed with the grid.
 */
export function useFlip(
  scroller: RefObject<HTMLElement | null>,
  enabled: boolean,
  options: FlipOptions = {}
): FlipTracker {
  const tracker = useMemo(() => new FlipTracker(), [])
  const { frame, epoch } = options
  const seen = useRef(epoch)
  // A new grid seen while only observing takes its baseline at the first measured commit.
  const fresh = useRef(false)
  useLayoutEffect(() => {
    const cells = collectCells(scroller.current)
    if (seen.current !== epoch) fresh.current = true
    seen.current = epoch
    if (!enabled) {
      tracker.observe(cells)
      return
    }
    const held = frame?.current ?? null
    held?.style.setProperty('transform', 'none', 'important')
    try {
      tracker.commit(cells, scroller.current, !fresh.current)
    } finally {
      held?.style.removeProperty('transform')
    }
    fresh.current = false
  })
  useEffect(() => {
    tracker.listen()
    return () => tracker.dispose()
  }, [tracker])
  return tracker
}
