import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { dragAxis, type Axis, type DismissDirections } from '@renderer/lib/gestures/dismiss'
import { VelocityTracker } from '@renderer/lib/motion/velocity'

export interface SwipeDismissCallbacks {
  dirs: DismissDirections
  /** A finger is on the card (true) or has left it (false): the message's clock stops meanwhile. */
  onHold(held: boolean): void
  /** The finger has left the slop circle and the drag runs along `axis`. */
  onDragStart(axis: Axis): void
  /** The finger moved `delta` px along the axis since the drag began. */
  onDrag(axis: Axis, delta: number): void
  /** The finger lifted after a drag, at `delta` px moving at `velocity` px/s along the axis. */
  onRelease(axis: Axis, delta: number, velocity: number): void
}

export interface SwipeDismissHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void
  onPointerMove(e: ReactPointerEvent<HTMLElement>): void
  onPointerUp(e: ReactPointerEvent<HTMLElement>): void
  onPointerCancel(e: ReactPointerEvent<HTMLElement>): void
  onLostPointerCapture(e: ReactPointerEvent<HTMLElement>): void
  onClickCapture(e: ReactMouseEvent<HTMLElement>): void
}

interface Gesture {
  pointerId: number
  startX: number
  startY: number
  axis: Axis | null
  tracker: VelocityTracker
}

/**
 * Pointer handling for swiping a message card away. The card is captured only once the finger
 * has left the slop circle, so a tap on its action button stays a tap; a drag that ends over the
 * button does not click it either.
 */
export function useSwipeDismiss(callbacks: SwipeDismissCallbacks): SwipeDismissHandlers {
  const latest = useRef(callbacks)
  useLayoutEffect(() => {
    latest.current = callbacks
  })
  const gesture = useRef<Gesture | null>(null)
  // Set when a drag ran; the click that follows the pointer up is swallowed once.
  const dragged = useRef(false)

  return useMemo<SwipeDismissHandlers>(() => {
    const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
      const g = gesture.current
      if (!g || g.pointerId !== e.pointerId) return
      gesture.current = null
      const cb = latest.current
      if (g.axis) {
        g.tracker.add(e.timeStamp, e.clientX, e.clientY)
        const delta = g.axis === 'x' ? e.clientX - g.startX : e.clientY - g.startY
        const v = g.tracker.velocity(e.timeStamp)
        const velocity = cancelled ? 0 : g.axis === 'x' ? v.vx : v.vy
        cb.onRelease(g.axis, delta, velocity)
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId)
      }
      cb.onHold(false)
    }
    return {
      onPointerDown: (e) => {
        if (gesture.current || (e.pointerType === 'mouse' && e.button !== 0)) return
        dragged.current = false
        const tracker = new VelocityTracker()
        tracker.add(e.timeStamp, e.clientX, e.clientY)
        gesture.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          axis: null,
          tracker
        }
        latest.current.onHold(true)
      },
      onPointerMove: (e) => {
        const g = gesture.current
        if (!g || g.pointerId !== e.pointerId) return
        g.tracker.add(e.timeStamp, e.clientX, e.clientY)
        const dx = e.clientX - g.startX
        const dy = e.clientY - g.startY
        if (!g.axis) {
          const axis = dragAxis(dx, dy)
          if (!axis) return
          g.axis = axis
          dragged.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          latest.current.onDragStart(axis)
        }
        latest.current.onDrag(g.axis, g.axis === 'x' ? dx : dy)
      },
      onPointerUp: (e) => finish(e, false),
      onPointerCancel: (e) => finish(e, true),
      onLostPointerCapture: (e) => finish(e, true),
      onClickCapture: (e) => {
        if (!dragged.current) return
        dragged.current = false
        e.preventDefault()
        e.stopPropagation()
      }
    }
  }, [])
}
