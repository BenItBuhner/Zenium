import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { SlideMotion } from '@renderer/lib/motion/slide'
import { reducedMotion } from '@renderer/lib/motion/spring'
import { STRIP_FADE } from '@renderer/lib/tabStripLayout'
import { uiStore } from '@renderer/lib/ui'

/**
 * The vertical list's active row comes into view on activation (tabs-28, BUG-008): a click on a
 * row, the strip's keyboard walk, Ctrl+Tab, `tabs.activate` from anywhere – the strip's rule for
 * the column (§9.37, `TabStrip`'s `scrollActiveIntoView`). The scroller moves by the least
 * distance that brings the row clear of its edge fades – `scrollIntoView({ block: 'nearest' })`'s
 * rule with the fade's depth (`STRIP_FADE`, the strip's 24) as the row's margin – and the
 * scroller alone moves: `Element.scrollIntoView` scrolls every scrollable ancestor too, the
 * `overflow: hidden` ones included (the row of space panels the sidebar slides between, the
 * window root), so it is the scroller's own `scrollBy`. Smooth, on the engine's scroll
 * animation, unless motion is reduced (§11.3: a cut) – and a cut when the panel has just come
 * into view (a space switch, the first paint: there is nothing to glide from). Never while a row
 * is being dragged: the rows are sliding under the ghost and the drag's autoscroll is the drag's.
 * The row's box is where it rests (`SlideMotion.restingRect`), not where its glide has it this
 * frame.
 */
export function useActiveRowInView(
  scroller: RefObject<HTMLElement | null>,
  motion: SlideMotion,
  activeTabId: string | null,
  inView: boolean
): void {
  const settled = useRef(false)
  useLayoutEffect(() => {
    const el = scroller.current
    const wasInView = settled.current
    settled.current = inView
    if (!el || !inView || !activeTabId || uiStore.get().drag) return
    const row = el.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`)
    if (!row) return
    scrollRowIntoView(
      el,
      motion.restingRect(activeTabId) ?? row.getBoundingClientRect(),
      wasInView && !reducedMotion() ? 'smooth' : 'auto'
    )
  }, [scroller, motion, activeTabId, inView])
}

/**
 * Scroll `scroller` the least distance that brings `row` (its resting box) clear of the edge
 * fades: past the top fade while the list is scrolled, past the bottom one while there is more
 * list below. Returns the distance asked for (0 when the row is in view already).
 */
export function scrollRowIntoView(
  scroller: HTMLElement,
  row: DOMRect,
  behavior: ScrollBehavior,
  fade = STRIP_FADE
): number {
  const box = scroller.getBoundingClientRect()
  const extent = scroller.scrollHeight - scroller.clientHeight
  const start = box.top + (scroller.scrollTop > 1 ? fade : 0)
  const end = box.bottom - (extent > 1 && scroller.scrollTop < extent - 1 ? fade : 0)
  let by = 0
  if (row.top < start) by = row.top - start
  else if (row.bottom > end) by = row.bottom - end
  if (by !== 0) scroller.scrollBy({ top: by, behavior })
  return by
}
