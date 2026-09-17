import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

const LONG_PRESS_MS = 380
const SLOP = 8

export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void
}

export interface LongPress {
  /** Spread onto the element. */
  handlers: LongPressHandlers
  /** True once per touch that was a long press, so the click that follows it can be ignored. */
  swallowsClick: () => boolean
}

/**
 * A press-and-hold on an element (a group's header, a space's row). A touch that moves is a
 * scroll or a drag and is left alone; a right click counts as a long press too, for the mouse.
 */
export function useLongPress(onLongPress: () => void): LongPress {
  const touch = useRef<{ id: number; x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const swallow = useRef(false)
  const callback = useRef(onLongPress)
  useLayoutEffect(() => {
    callback.current = onLongPress
  })

  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    touch.current = null
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return {
    handlers: {
      onPointerDown: (e) => {
        swallow.current = false
        if (e.button !== 0 || touch.current) return
        // Controls inside the element keep their own taps; the element itself may be a button.
        const control = (e.target as HTMLElement).closest('button, input')
        if (control && control !== e.currentTarget) return
        touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
        timer.current = setTimeout(() => {
          timer.current = null
          touch.current = null
          swallow.current = true
          callback.current()
        }, LONG_PRESS_MS)
      },
      onPointerMove: (e) => {
        const t = touch.current
        if (!t || t.id !== e.pointerId) return
        if (Math.hypot(e.clientX - t.x, e.clientY - t.y) >= SLOP) clear()
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onContextMenu: (e) => {
        e.preventDefault()
        clear()
        swallow.current = true
        callback.current()
      }
    },
    swallowsClick: () => {
      const s = swallow.current
      swallow.current = false
      return s
    }
  }
}
