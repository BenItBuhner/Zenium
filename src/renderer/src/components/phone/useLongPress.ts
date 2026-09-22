import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { capturePointer } from '@renderer/lib/gestures/pointerCapture'

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
 * A drag that a held element hands the rest of its touch to (`LongPressOptions.onDrag`): the
 * finger's moves from the one that began it, and its lift or loss.
 */
export interface LongPressDrag {
  move: (e: PointerEvent) => void
  /** The finger lifted (`cancelled` false), or the touch was taken away (`cancelled` true). */
  end: (e: PointerEvent, cancelled: boolean) => void
}

export interface LongPressOptions {
  /** The hold is recognised, the finger still down: the element may show it is in the hand. */
  onHold?: (at: LongPressPoint) => void
  /**
   * The finger moves past the slop while the hold is on. Returning a drag hands it the rest of
   * the touch – the page under the element does not scroll, the press callback stays quiet and
   * the click that follows is swallowed – and null leaves the move a scroll, as without the
   * option (the hold is over, nothing fires).
   */
  onDrag?: (e: ReactPointerEvent<HTMLElement>) => LongPressDrag | null
  /** A hold ended without a drag: the finger lifted (the press callback follows) or the touch was lost. */
  onHoldEnd?: () => void
}

/**
 * A press-and-hold on an element (a group's header, a space's row, an Essential). The hold is
 * recognised while the finger is down (a haptic tick), and the callback runs when it lifts – on
 * the click that follows the release, so a sheet the callback opens cannot receive that click,
 * or after a moment if no click comes – with the point the finger went down at, for a menu that
 * anchors where it was held (the tablet's, §9.36). A touch that moves is a scroll or a drag and
 * is left alone; a right click counts as a long press too, for the mouse. With `onDrag`, a held
 * element that is then moved is dragged instead (the new tab page's shortcuts, NTP-06): the
 * touch is the drag's from there, and the hold's own callback does not run.
 */
export function useLongPress(
  onLongPress: (at: LongPressPoint) => void,
  options?: LongPressOptions
): LongPress {
  const touch = useRef<{ id: number; x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const release = useRef<ReturnType<typeof setTimeout> | null>(null)
  const swallow = useRef(false)
  const at = useRef<LongPressPoint>({ x: 0, y: 0 })
  const drag = useRef<LongPressDrag | null>(null)
  /** The element under the hold, and the touch-scroll block it carries while held (see below). */
  const holding = useRef<{ el: HTMLElement; unblock: () => void } | null>(null)
  const callback = useRef(onLongPress)
  const opts = useRef(options)
  useLayoutEffect(() => {
    callback.current = onLongPress
    opts.current = options
  })

  const unblock = (): void => {
    holding.current?.unblock()
    holding.current = null
  }
  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    touch.current = null
    unblock()
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
      unblock()
    },
    []
  )

  const lift = (): void => {
    clear()
    if (!held.current) return
    held.current = false
    opts.current?.onHoldEnd?.()
    swallow.current = true
    release.current = setTimeout(fire, RELEASE_DELAY_MS)
  }

  /** A drag ended (the finger lifted or the touch was lost): the touch is over. */
  const endDrag = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const d = drag.current
    if (!d || touch.current?.id !== e.pointerId) return
    drag.current = null
    clear()
    swallow.current = true
    d.end(e.nativeEvent, cancelled)
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
        const el = e.currentTarget
        timer.current = setTimeout(() => {
          timer.current = null
          held.current = true
          try {
            navigator.vibrate?.(8)
          } catch {
            /* not available */
          }
          const o = opts.current
          if (o?.onDrag) {
            // The finger moving from here is the drag's, not a scroll's: the touch's default is
            // taken before the browser can make a scroll of it (the bar editor's rows do the
            // same). Removed with the hold, so a touch that never moved leaves nothing behind.
            const block = (ev: TouchEvent): void => {
              if (ev.cancelable) ev.preventDefault()
            }
            el.addEventListener('touchmove', block, { passive: false })
            holding.current = { el, unblock: () => el.removeEventListener('touchmove', block) }
          }
          o?.onHold?.(at.current)
        }, LONG_PRESS_MS)
      },
      onPointerMove: (e) => {
        const t = touch.current
        if (!t || t.id !== e.pointerId) return
        if (drag.current) {
          drag.current.move(e.nativeEvent)
          return
        }
        if (Math.hypot(e.clientX - t.x, e.clientY - t.y) < SLOP) return
        if (held.current) {
          const d = opts.current?.onDrag?.(e) ?? null
          if (d) {
            held.current = false
            if (timer.current) clearTimeout(timer.current)
            timer.current = null
            drag.current = d
            try {
              capturePointer(e.currentTarget, e.pointerId)
            } catch {
              /* the pointer is gone */
            }
            d.move(e.nativeEvent)
            return
          }
          opts.current?.onHoldEnd?.()
        }
        clear()
        held.current = false
      },
      onPointerUp: (e) => {
        if (drag.current) endDrag(e, false)
        else lift()
      },
      onPointerCancel: (e) => {
        if (drag.current) {
          endDrag(e, true)
          return
        }
        clear()
        if (held.current) opts.current?.onHoldEnd?.()
        held.current = false
      },
      onContextMenu: (e) => {
        e.preventDefault()
        if (drag.current) return
        // The `contextmenu` Chromium raises for a touch hold a little after the timer has: on a
        // draggable element it is not the menu's cue – the finger may be about to move – so the
        // hold runs on and the callback comes at the lift, as it does on a host without the event.
        if (held.current && opts.current?.onDrag) return
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
