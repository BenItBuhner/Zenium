import type { JSX, RefObject } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import type { DropTarget } from './useBookmarkDrag'

/**
 * The insertion line of a reorder drag. One element that glides between slots on a spring
 * (rather than a line per row that blinks on and off), positioned inside the scrolling list.
 */
export function DropIndicator({
  target,
  container
}: {
  target: DropTarget | null
  container: RefObject<HTMLElement | null>
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const spring = useRef<SpringAnimation | null>(null)
  const shown = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    const root = container.current
    if (!el || !root) return
    const slot =
      target && (target.position === 'before' || target.position === 'after') ? target : null
    const row = slot ? root.querySelector<HTMLElement>(`[data-bm-drop="row:${slot.rowId}"]`) : null
    if (!slot || !row) {
      shown.current = false
      el.style.opacity = '0'
      return
    }
    const rootRect = root.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    const y =
      (slot.position === 'before' ? rect.top : rect.bottom) - rootRect.top + root.scrollTop - 1
    el.style.left = `${rect.left - rootRect.left + 8}px`
    el.style.width = `${Math.max(0, rect.width - 16)}px`
    if (!spring.current) {
      spring.current = new SpringAnimation(
        SPRING_SNAPPY,
        (v) => {
          el.style.transform = `translateY(${v}px)`
        },
        () => undefined
      )
    }
    const s = spring.current
    if (shown.current) {
      const state = s.stop()
      s.start(state.x, state.v, y)
    } else {
      s.stop()
      s.start(y, 0, y)
      el.style.transform = `translateY(${y}px)`
    }
    shown.current = true
    el.style.opacity = '1'
  }, [target, container])

  useLayoutEffect(
    () => () => {
      spring.current?.stop()
    },
    []
  )

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 z-10 h-0.5 rounded-full bg-[var(--zen-accent)] opacity-0 transition-opacity duration-100 before:absolute before:top-[-3px] before:left-[-4px] before:h-2 before:w-2 before:rounded-full before:bg-[var(--zen-accent)] before:content-['']"
    />
  )
}
