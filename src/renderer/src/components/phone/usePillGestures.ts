import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import {
  beginOverviewDrag,
  beginTabSwitch,
  catchOverview,
  catchTabSwitch,
  dragOverview,
  dragTabSwitch,
  overviewIsOpen,
  prepareStage,
  releaseOverview,
  releaseTabSwitch
} from '@renderer/lib/gestures/stage'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import { browserStore } from '@renderer/lib/ui'

/** Movement (px) before a touch stops being a tap and its axis is locked. */
const SLOP = 8

/**
 * Feed a move event to the tracker – including the samples the browser coalesced into it while
 * the main thread was busy, so a fling is measured from the real finger path.
 */
function track(tracker: VelocityTracker, e: ReactPointerEvent<HTMLElement>): void {
  const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }
  const coalesced = native.getCoalescedEvents?.() ?? []
  if (coalesced.length > 0) {
    for (const c of coalesced) tracker.add(c.timeStamp, c.clientX, c.clientY)
  } else {
    tracker.add(e.timeStamp, e.clientX, e.clientY)
  }
}

type Mode = 'pending' | 'tabs' | 'overview' | 'none'

interface Touch {
  id: number
  x0: number
  y0: number
  mode: Mode
  /** The touch grabbed a transition that was still moving: never a tap. */
  caught: boolean
  tracker: VelocityTracker
}

export interface PillGestureOptions {
  /** Window edge the bar sits on; decides which way "towards the middle of the screen" is. */
  edge: 'bottom' | 'top'
  onTap: () => void
}

export interface PillGestureHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  onClick: (e: ReactPointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => void
  style: CSSProperties
}

/**
 * The gestures of the address pill. A touch is a tap until it moves `SLOP` px; then its dominant
 * axis decides: sideways drags the tab track (finger left → next tab), towards the middle of
 * the screen pulls the tab overview in (or, when it is open, away from the middle pushes it
 * out). A touch that lands while a transition is still settling catches it – the motion stops
 * under the finger and continues from there when it lifts, so every animation is interruptible.
 */
export function usePillGestures({ edge, onTap }: PillGestureOptions): PillGestureHandlers {
  const touch = useRef<Touch | null>(null)
  const swallowClick = useRef(false)
  // Sign of a vertical delta that heads towards the middle of the screen.
  const inward = edge === 'bottom' ? -1 : 1

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || touch.current) return
    const state = browserStore.get().state
    if (!state) return
    // A drag produces no click to swallow; a new touch must start with a clean slate.
    swallowClick.current = false
    const tracker = new VelocityTracker()
    tracker.add(e.timeStamp, e.clientX, e.clientY)
    let mode: Mode = 'pending'
    let caught = false
    if (catchTabSwitch()) {
      mode = 'tabs'
      caught = true
    } else if (catchOverview()) {
      mode = 'overview'
      caught = true
    } else {
      prepareStage(state)
    }
    touch.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mode, caught, tracker }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    track(t.tracker, e)
    let dx = e.clientX - t.x0
    let dy = e.clientY - t.y0
    if (t.mode === 'pending') {
      if (Math.hypot(dx, dy) < SLOP) return
      const state = browserStore.get().state
      if (!state) {
        t.mode = 'none'
        return
      }
      if (Math.abs(dx) > Math.abs(dy)) {
        t.mode = !overviewIsOpen() && beginTabSwitch(state) ? 'tabs' : 'none'
      } else if (dy * inward > 0 || overviewIsOpen()) {
        t.mode = beginOverviewDrag(state) ? 'overview' : 'none'
      } else {
        t.mode = 'none'
      }
      // Start moving from where the slop was crossed: no jump on the first frame.
      t.x0 = e.clientX
      t.y0 = e.clientY
      dx = 0
      dy = 0
    }
    if (t.mode === 'tabs') dragTabSwitch(-dx)
    else if (t.mode === 'overview') dragOverview(dy * inward)
  }

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    touch.current = null
    if (t.mode === 'pending') {
      if (t.caught || cancelled) swallowClick.current = true
      return
    }
    swallowClick.current = true
    const { vx, vy } = cancelled ? { vx: 0, vy: 0 } : t.tracker.velocity(e.timeStamp)
    if (t.mode === 'tabs') releaseTabSwitch(-vx)
    else if (t.mode === 'overview') releaseOverview(vy * inward)
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true),
    onClick: (e) => {
      if (swallowClick.current) {
        swallowClick.current = false
        e.preventDefault()
        return
      }
      onTap()
    },
    // Both axes are ours: the WebView must not turn a vertical pan into a scroll.
    style: { touchAction: 'none' }
  }
}

export type OverviewHandleHandlers = Omit<PillGestureHandlers, 'onClick'>

/**
 * Dragging the open overview by its header pushes it back out towards the bar, with the same
 * physics as the pill; a touch during its animation catches it just the same.
 */
export function useOverviewHandle({ edge }: { edge: 'bottom' | 'top' }): OverviewHandleHandlers {
  const touch = useRef<{ id: number; y0: number; tracker: VelocityTracker } | null>(null)
  const inward = edge === 'bottom' ? -1 : 1

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    touch.current = null
    const { vy } = cancelled ? { vy: 0 } : t.tracker.velocity(e.timeStamp)
    releaseOverview(vy * inward)
  }

  return {
    onPointerDown: (e) => {
      if (e.button !== 0 || touch.current) return
      const state = browserStore.get().state
      if (!state) return
      if (!catchOverview()) beginOverviewDrag(state)
      const tracker = new VelocityTracker()
      tracker.add(e.timeStamp, e.clientX, e.clientY)
      touch.current = { id: e.pointerId, y0: e.clientY, tracker }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e) => {
      const t = touch.current
      if (!t || t.id !== e.pointerId) return
      track(t.tracker, e)
      dragOverview((e.clientY - t.y0) * inward)
    },
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true),
    style: { touchAction: 'none' }
  }
}
