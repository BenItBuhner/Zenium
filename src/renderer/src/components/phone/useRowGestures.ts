import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { VelocityTracker } from '@renderer/lib/motion/velocity'

const LONG_PRESS_MS = 380
/** Movement (px) before a touch stops being a tap and its axis is decided. */
const SLOP = 8

export interface RowSwipe {
  /** The row content is `dx` px from its resting place under the finger. */
  onMove(dx: number): void
  /** The finger lifted (`velocity` px/s along x) or the touch was taken away (velocity 0). */
  onEnd(dx: number, velocity: number): void
}

export interface RowGestureOptions {
  onTap(): void
  /** A hold, recognised while the finger is still down (with a haptic tick). Right click too. */
  onLongPress?: () => void
  /** Sideways drags move the row; without this a sideways move is merely not a tap. */
  swipe?: RowSwipe | null
}

export interface RowGestureHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  onClick: (e: ReactMouseEvent<HTMLElement>) => void
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
}

interface Touch {
  id: number
  x0: number
  y0: number
  mode: 'pending' | 'swipe' | 'scroll'
  tracker: VelocityTracker
}

/**
 * One list row's touch vocabulary: a tap opens it, a hold selects it, a sideways drag swipes it
 * (to delete), and an up-or-down move is the list's scroll – which the WebView performs itself,
 * as the row leaves vertical panning to it (`touch-action: pan-y`) and only claims a touch once
 * it has moved sideways. A hold or a swipe swallows the click that follows the release, so the
 * row does not also open. Controls inside the row (a trailing button) keep their own taps.
 */
export function useRowGestures(options: RowGestureOptions): RowGestureHandlers {
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })
  const touch = useRef<Touch | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const swallowClick = useRef(false)

  const clearTimer = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clearTimer, [])

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    touch.current = null
    clearTimer()
    if (t.mode !== 'swipe') return
    swallowClick.current = true
    const velocity = cancelled ? 0 : t.tracker.velocity(e.timeStamp).vx
    latest.current.swipe?.onEnd(e.clientX - t.x0, velocity)
  }

  return {
    onPointerDown: (e) => {
      if (e.button !== 0 || touch.current) return
      // Controls inside the row keep their own taps.
      const control = (e.target as HTMLElement).closest('button, input, a')
      if (control && control !== e.currentTarget) return
      swallowClick.current = false
      const tracker = new VelocityTracker()
      tracker.add(e.timeStamp, e.clientX, e.clientY)
      touch.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mode: 'pending', tracker }
      if (!latest.current.onLongPress) return
      timer.current = setTimeout(() => {
        timer.current = null
        const held = touch.current
        if (!held || held.mode !== 'pending') return
        // Recognised while the finger is still down: the release must not also open the row.
        swallowClick.current = true
        try {
          navigator.vibrate?.(8)
        } catch {
          /* not available */
        }
        latest.current.onLongPress?.()
      }, LONG_PRESS_MS)
    },
    onPointerMove: (e) => {
      const t = touch.current
      if (!t || t.id !== e.pointerId) return
      t.tracker.add(e.timeStamp, e.clientX, e.clientY)
      const dx = e.clientX - t.x0
      const dy = e.clientY - t.y0
      if (t.mode === 'pending') {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
        clearTimer()
        if (Math.abs(dx) > Math.abs(dy) && latest.current.swipe) {
          t.mode = 'swipe'
          e.currentTarget.setPointerCapture(e.pointerId)
        } else {
          t.mode = 'scroll'
          return
        }
      }
      if (t.mode === 'swipe') latest.current.swipe?.onMove(dx)
    },
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true),
    onClick: (e) => {
      if (swallowClick.current) {
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const control = (e.target as HTMLElement).closest('button, input, a')
      if (control && control !== e.currentTarget) return
      latest.current.onTap()
    },
    onContextMenu: (e) => {
      if (!latest.current.onLongPress) return
      e.preventDefault()
      clearTimer()
      touch.current = null
      swallowClick.current = true
      latest.current.onLongPress()
    },
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        latest.current.onTap()
      }
    }
  }
}
