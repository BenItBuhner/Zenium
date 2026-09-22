import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

const LONG_PRESS_MS = 380
const SLOP = 8
/** How long a released hold waits for its click before firing regardless. */
const RELEASE_DELAY_MS = 250

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

/** Where the hold was, in the viewport's CSS px: the point a menu anchored at the finger opens at. */
export interface LongPressPoint {
  x: number
  y: number
}

/**
 * A press-and-hold on an element (a group's header, a space's row, an Essential). The hold is
 * recognised while the finger is down (a haptic tick), and the callback runs when it lifts – on
 * the click that follows the release, so a sheet the callback opens cannot receive that click,
 * or after a moment if no click comes – with the point the finger went down at, for a menu that
 * anchors where it was held (the tablet's, §9.36). A touch that moves is a scroll or a drag and
 * is left alone; a right click counts as a long press too, for the mouse.
 */
export function useLongPress(onLongPress: (at: LongPressPoint) => void): LongPress {
  const touch = useRef<{ id: number; x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const release = useRef<ReturnType<typeof setTimeout> | null>(null)
  const swallow = useRef(false)
  const at = useRef<LongPressPoint>({ x: 0, y: 0 })
  const callback = useRef(onLongPress)
  useLayoutEffect(() => {
    callback.current = onLongPress
  })

  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    touch.current = null
  }
  const fire = (): void => {
    if (release.current) clearTimeout(release.current)
    release.current = null
    callback.current(at.current)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (release.current) clearTimeout(release.current)
    },
    []
  )

  const lift = (): void => {
    clear()
    if (!held.current) return
    held.current = false
    swallow.current = true
    release.current = setTimeout(fire, RELEASE_DELAY_MS)
  }

  return {
    handlers: {
      onPointerDown: (e) => {
        swallow.current = false
        if (e.button !== 0 || touch.current) return
        // Controls inside the element keep their own taps; the element itself may be a button.
        const control = (e.target as HTMLElement).closest('button, input')
        if (control && control !== e.currentTarget) return
        touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
        at.current = { x: e.clientX, y: e.clientY }
        held.current = false
        timer.current = setTimeout(() => {
          timer.current = null
          held.current = true
          try {
            navigator.vibrate?.(8)
          } catch {
            /* not available */
          }
        }, LONG_PRESS_MS)
      },
      onPointerMove: (e) => {
        const t = touch.current
        if (!t || t.id !== e.pointerId) return
        if (Math.hypot(e.clientX - t.x, e.clientY - t.y) >= SLOP) {
          clear()
          held.current = false
        }
      },
      onPointerUp: lift,
      onPointerCancel: () => {
        clear()
        held.current = false
      },
      onContextMenu: (e) => {
        e.preventDefault()
        clear()
        held.current = false
        swallow.current = true
        at.current = { x: e.clientX, y: e.clientY }
        fire()
      }
    },
    swallowsClick: () => {
      const s = swallow.current
      swallow.current = false
      if (release.current) fire()
      return s
    }
  }
}
