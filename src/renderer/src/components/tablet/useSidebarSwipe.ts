import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

/** Sideways travel (px) that counts as a swipe; well past a tap's slop and a scroll's wobble. */
const SWIPE = 48
/** A swipe is mostly sideways: this much more sideways than up or down. */
const AXIS_RATIO = 1.5

export interface SidebarSwipeHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void
}

/**
 * A sideways swipe of a finger across the tablet's sidebar (TABLET-02): towards the window's
 * edge it sits at collapses it to the icon rail, away from the edge expands it – Zen's compact
 * toggle by gesture. The list keeps its vertical scroll (the browser takes an up-or-down pan and
 * cancels the pointer; nothing here fights it) and its taps: only a mostly sideways move past
 * `SWIPE` counts, once per touch, and the click that may follow the finger's lift is swallowed
 * so the row under it does not also activate. A mouse is not a finger and is left alone.
 */
export function useSidebarSwipe({
  side,
  collapsed,
  onCollapse,
  onExpand
}: {
  side: 'left' | 'right'
  collapsed: boolean
  onCollapse: () => void
  onExpand: () => void
}): SidebarSwipeHandlers {
  const touch = useRef<{ id: number; x: number; y: number; done: boolean } | null>(null)
  const swallow = useRef(false)
  const latest = useRef({ side, collapsed, onCollapse, onExpand })
  latest.current = { side, collapsed, onCollapse, onExpand }

  const end = (e: ReactPointerEvent<HTMLElement>): void => {
    if (touch.current?.id === e.pointerId) touch.current = null
  }

  return {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' || e.button !== 0 || touch.current) return
      swallow.current = false
      touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, done: false }
    },
    onPointerMove: (e) => {
      const t = touch.current
      if (!t || t.id !== e.pointerId || t.done) return
      const dx = e.clientX - t.x
      const dy = e.clientY - t.y
      if (Math.abs(dx) < SWIPE || Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) return
      t.done = true
      swallow.current = true
      const { side: at, collapsed: isCollapsed, onCollapse: collapse, onExpand: expand } =
        latest.current
      const towardsEdge = at === 'left' ? dx < 0 : dx > 0
      if (towardsEdge && !isCollapsed) collapse()
      else if (!towardsEdge && isCollapsed) expand()
    },
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture: (e) => {
      if (!swallow.current) return
      swallow.current = false
      e.preventDefault()
      e.stopPropagation()
    }
  }
}
