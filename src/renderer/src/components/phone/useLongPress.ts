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
   * option (the hold is over, nothing fires). The move is the window's own `PointerEvent`: a
   * draggable hold hears the finger on the window, not on the element (see the hook below).
   */
  onDrag?: (e: PointerEvent) => LongPressDrag | null
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
 *
 * A draggable hold (`onDrag`) has to take the touch's moves away from the browser at the hold,
 * before the finger moves, or no drag ever begins. Chromium decides at a touch's first move
 * whether the page may cancel it, from the touch-action under the finger – the chrome's
 * `manipulation` lets the browser scroll – and a move the page may not cancel becomes the
 * browser's scroll, which cancels the pointer: a `pointercancel`, then no `pointermove` at all
 * (on the new tab page, where nothing scrolls, the finger overscrolls the void; the four device
 * runs of 22 Sep, read from the fourth's trace). What takes the moves away is a non-passive
 * `touchmove` listener on the DOCUMENT, set at the hold: the whole view is then a blocking
 * region for that first hit test, the move comes cancellable, and the block consumes it. The
 * overview's cards (`useCardLift`), the tablet's rows (`useTabTouch`) and the spaces drawer's
 * all do this and drag on the device; a block on the element alone did not. The element carries
 * one too, since the WebView keeps sending a touch's events to the node it began on even after
 * React re-mounts it. Both go with the hold. The moves and the lift are heard on the window
 * (capture phase), as the cards hear them, with the pointer captured from the down, so the drag
 * outlives whatever happens to the element; its own handlers leave that touch to the window
 * from the hold until the next press.
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
  /** The element under the hold, and the blocks it carries while held (the scroll and the window). */
  const holding = useRef<{ el: HTMLElement; unblock: () => void } | null>(null)
  /**
   * The pointer a draggable hold handed to the window: the element's own (synthetic) handlers
   * leave that touch to the window listeners until the next press, so neither drives it twice.
   */
  const winPointer = useRef<number | null>(null)
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
  const endDrag = (e: PointerEvent, cancelled: boolean): void => {
    const d = drag.current
    if (!d || touch.current?.id !== e.pointerId) return
    drag.current = null
    clear()
    swallow.current = true
    d.end(e, cancelled)
  }

  return {
    handlers: {
      onPointerDown: (e) => {
        swallow.current = false
        winPointer.current = null
        if (e.button !== 0 || touch.current) return
        // Controls inside the element keep their own taps; the element itself may be a button.
        const control = (e.target as HTMLElement).closest('button, input')
        if (control && control !== e.currentTarget) return
        touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
        at.current = { x: e.clientX, y: e.clientY }
        held.current = false
        const el = e.currentTarget
        const pointerId = e.pointerId
        // A draggable element captures its pointer from the down (see the hook's note): the
        // capture keeps the lift and the loss coming, and the browser releases it on a scroll
        // that takes the touch before the hold (a pointercancel that clears the pending hold).
        if (opts.current?.onDrag) {
          try {
            capturePointer(el, pointerId)
          } catch {
            /* the pointer is gone */
          }
        }
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
            // The finger from here is the drag's: its moves are taken from the browser's scroll
            // on the document (see the hook's note – the block that makes the first move
            // cancellable) and on the element the touch began on (whose touch events follow it
            // out of the document), and heard on the window. All of it goes with the hold, so a
            // touch that never became a drag leaves nothing behind.
            const block = (ev: TouchEvent): void => {
              if (ev.cancelable) ev.preventDefault()
            }
            const onWinMove = (ev: PointerEvent): void => {
              if (touch.current?.id !== ev.pointerId) return
              if (drag.current) {
                drag.current.move(ev)
                return
              }
              if (!held.current) return
              const t = touch.current
              if (Math.hypot(ev.clientX - t.x, ev.clientY - t.y) < SLOP) return
              const d = opts.current?.onDrag?.(ev) ?? null
              if (d) {
                held.current = false
                drag.current = d
                try {
                  capturePointer(el, ev.pointerId)
                } catch {
                  /* the pointer is gone */
                }
                d.move(ev)
              } else {
                opts.current?.onHoldEnd?.()
                clear()
                held.current = false
              }
            }
            const onWinUp = (ev: PointerEvent): void => {
              if (touch.current?.id !== ev.pointerId) return
              if (drag.current) endDrag(ev, false)
              else lift()
            }
            const onWinCancel = (ev: PointerEvent): void => {
              if (touch.current?.id !== ev.pointerId) return
              if (drag.current) {
                endDrag(ev, true)
                return
              }
              clear()
              if (held.current) opts.current?.onHoldEnd?.()
              held.current = false
            }
            document.addEventListener('touchmove', block, { passive: false })
            el.addEventListener('touchmove', block, { passive: false })
            window.addEventListener('pointermove', onWinMove, true)
            window.addEventListener('pointerup', onWinUp, true)
            window.addEventListener('pointercancel', onWinCancel, true)
            winPointer.current = pointerId
            holding.current = {
              el,
              unblock: () => {
                document.removeEventListener('touchmove', block)
                el.removeEventListener('touchmove', block)
                window.removeEventListener('pointermove', onWinMove, true)
                window.removeEventListener('pointerup', onWinUp, true)
                window.removeEventListener('pointercancel', onWinCancel, true)
              }
            }
          }
          o?.onHold?.(at.current)
        }, LONG_PRESS_MS)
      },
      onPointerMove: (e) => {
        const t = touch.current
        if (!t || t.id !== e.pointerId) return
        // A draggable hold's touch is the window's from here; the element leaves it be.
        if (winPointer.current === e.pointerId) return
        if (Math.hypot(e.clientX - t.x, e.clientY - t.y) < SLOP) return
        // A move past the slop with no drag to hand to is a scroll; a hold that was on ends.
        if (held.current) opts.current?.onHoldEnd?.()
        clear()
        held.current = false
      },
      onPointerUp: (e) => {
        if (winPointer.current === e.pointerId) return
        lift()
      },
      onPointerCancel: (e) => {
        if (winPointer.current === e.pointerId) return
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
