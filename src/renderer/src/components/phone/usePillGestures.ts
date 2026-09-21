import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { PhoneBarPosition } from '@shared/types'
import { beginDock, catchDock, dockAlong, dragDock, releaseDock } from '@renderer/lib/gestures/dock'
import { capturePointer } from '@renderer/lib/gestures/pointerCapture'
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
/** A touch that has not moved past the slop by then picks the pill up (Android's long-press). */
const LONG_PRESS_MS = 400

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

type Mode = 'pending' | 'tabs' | 'overview' | 'dock' | 'none'

/**
 * Take a touch sequence away from the browser's gesture recogniser for as long as it lasts.
 *
 * `touch-action: none` stops the scroll a drag would cause, but Chromium still recognises the
 * gesture: a fast release starts a fling in the browser process (its scroll updates are filtered,
 * the fling itself runs on), and a tap in the ~300 ms after it is swallowed as the tap that stops
 * the fling – the card tapped right after a swipe-open of the overview did nothing. A touchmove
 * the page consumes drops every gesture derived from it, fling included, and the moves of a
 * surface we drag ourselves are ours in full. Returns the function that hands them back.
 */
function claimTouchMoves(target: HTMLElement): () => void {
  const consume = (e: TouchEvent): void => {
    if (e.cancelable) e.preventDefault()
  }
  target.addEventListener('touchmove', consume, { passive: false })
  return () => target.removeEventListener('touchmove', consume)
}

interface Touch {
  id: number
  x0: number
  y0: number
  /** Latest finger position (a stationary press still jitters by a pixel or two). */
  x: number
  y: number
  mode: Mode
  /** The touch grabbed a transition that was still moving: never a tap. */
  caught: boolean
  /** Track position the carried pill had when this touch took it over. */
  dockStart: number
  tracker: VelocityTracker
  longPress: ReturnType<typeof setTimeout> | null
  /** Gives the touch's moves back to the browser once it is over. */
  release: () => void
}

export interface PillGestureOptions {
  /** Window edge the bar sits on; decides which way "towards the middle of the screen" is. */
  edge: PhoneBarPosition
  /** A plain tap (the click event tells which part of the pill was tapped). */
  onTap: (e: ReactPointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => void
}

export interface PillGestureHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  onClick: (e: ReactPointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => void
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void
  style: CSSProperties
}

/**
 * The gestures of the address pill. A touch is a tap until it moves `SLOP` px; then its dominant
 * axis decides: sideways drags the tab track (finger left → next tab), towards the middle of
 * the screen pulls the tab overview in (or, when it is open, away from the middle pushes it
 * out). A touch that holds still for a long-press instead picks the pill up, to carry the bar
 * to the other edge of the screen. A touch that lands while a transition is still settling
 * catches it – the motion stops under the finger and continues from there when it lifts, so
 * every animation is interruptible.
 */
export function usePillGestures({ edge, onTap }: PillGestureOptions): PillGestureHandlers {
  const touch = useRef<Touch | null>(null)
  const swallowClick = useRef(false)
  // Sign of a vertical delta that heads towards the middle of the screen.
  const inward = edge === 'bottom' ? -1 : 1

  const clearLongPress = (t: Touch): void => {
    if (t.longPress) clearTimeout(t.longPress)
    t.longPress = null
  }

  /** Move the surface the touch drives to a finger displacement of (dx, dy) from its origin. */
  const drag = (t: Touch, dx: number, dy: number): void => {
    if (t.mode === 'tabs') dragTabSwitch(-dx)
    else if (t.mode === 'overview') dragOverview(dy * inward)
    else if (t.mode === 'dock') dragDock(dx, dy, t.dockStart)
  }

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
    let dockStart = 0
    if (catchDock()) {
      mode = 'dock'
      caught = true
      dockStart = dockAlong()
    } else if (catchTabSwitch()) {
      mode = 'tabs'
      caught = true
    } else if (catchOverview()) {
      mode = 'overview'
      caught = true
    } else {
      prepareStage(state)
    }
    const t: Touch = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      mode,
      caught,
      dockStart,
      tracker,
      longPress: null,
      release: claimTouchMoves(e.currentTarget)
    }
    touch.current = t
    const target = e.currentTarget
    capturePointer(target, e.pointerId)
    if (mode === 'pending' && !overviewIsOpen()) {
      // The pill only relocates from a stationary press: any swipe cancels this first.
      t.longPress = setTimeout(() => {
        t.longPress = null
        if (touch.current !== t || t.mode !== 'pending') return
        const current = browserStore.get().state
        const rect = target.getBoundingClientRect()
        const slot = { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        if (!current || !beginDock(current, slot, edge)) return
        t.mode = 'dock'
        t.caught = true
        t.x0 = t.x
        t.y0 = t.y
        t.dockStart = 0
      }, LONG_PRESS_MS)
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    track(t.tracker, e)
    t.x = e.clientX
    t.y = e.clientY
    let dx = e.clientX - t.x0
    let dy = e.clientY - t.y0
    if (t.mode === 'pending') {
      if (Math.hypot(dx, dy) < SLOP) return
      clearLongPress(t)
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
    drag(t, dx, dy)
  }

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    touch.current = null
    clearLongPress(t)
    t.release()
    if (t.mode === 'pending') {
      if (t.caught || cancelled) swallowClick.current = true
      return
    }
    swallowClick.current = true
    if (!cancelled) {
      // The lift is the last sample of the finger's path. Without it a main thread that was busy
      // during the swipe (the thumbnail capture, layout) delivers the last moves late and the
      // release reads as a finger that had stopped short of the threshold: velocity 0 at a
      // position the moves never reached, and a swipe across half the screen snapped back.
      track(t.tracker, e)
      drag(t, e.clientX - t.x0, e.clientY - t.y0)
    }
    const { vx, vy } = cancelled ? { vx: 0, vy: 0 } : t.tracker.velocity(e.timeStamp)
    if (t.mode === 'tabs') releaseTabSwitch(-vx)
    else if (t.mode === 'overview') releaseOverview(vy * inward)
    else if (t.mode === 'dock') releaseDock(vy)
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
      onTap(e)
    },
    // The long-press is ours; the WebView must not open a context menu or start a selection.
    onContextMenu: (e) => e.preventDefault(),
    // Both axes are ours: the WebView must not turn a vertical pan into a scroll.
    style: { touchAction: 'none' }
  }
}

export type OverviewHandleHandlers = Omit<PillGestureHandlers, 'onClick' | 'onContextMenu'>

/**
 * Dragging the open overview by its header pushes it back out towards the bar, with the same
 * physics as the pill; a touch during its animation catches it just the same. A touch that does
 * not move stays a tap: the drag (and the pointer capture that goes with it) only begins once
 * the finger has crossed the slop, so the header's buttons still receive their clicks.
 *
 * `from` says where a touch may start the drag: in the gaps between the controls (the overview
 * header's rule, the default: a touch on one of its buttons is that button's, even mid-flight),
 * or `'anywhere'` but a text field – the tablet toolbar's rule (GN-27), whose whole row is the
 * overview's handle: a pull that starts on a button and crosses the slop is a pull, and the
 * button's own hold has let go of the touch by then (`useLongPress` gives up at its slop).
 */
export function useOverviewHandle({
  edge,
  from = 'gaps'
}: {
  edge: PhoneBarPosition
  from?: 'gaps' | 'anywhere'
}): OverviewHandleHandlers {
  const touch = useRef<{
    id: number
    x0: number
    y0: number
    dragging: boolean
    tracker: VelocityTracker
    release: () => void
  } | null>(null)
  const inward = edge === 'bottom' ? -1 : 1

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    touch.current = null
    t.release()
    if (!t.dragging) return
    if (!cancelled) {
      track(t.tracker, e)
      dragOverview((e.clientY - t.y0) * inward)
    }
    const { vy } = cancelled ? { vy: 0 } : t.tracker.velocity(e.timeStamp)
    releaseOverview(vy * inward)
  }

  return {
    onPointerDown: (e) => {
      if (e.button !== 0 || touch.current) return
      // A touch that begins on one of the header's controls is that control's, even mid-flight:
      // catching it here would take the pointer and turn the tap into nothing. A field's touch
      // is the field's on either rule (its caret, its selection).
      const control = (e.target as HTMLElement).closest('button, input')
      if (control && (from === 'gaps' || control.matches('input'))) return
      const state = browserStore.get().state
      if (!state) return
      const tracker = new VelocityTracker()
      tracker.add(e.timeStamp, e.clientX, e.clientY)
      // Mid-flight the rest of the header has nothing to tap, so a catch may take the touch at
      // once; a button of the tablet toolbar has, and its touch becomes a pull at the slop.
      const dragging = control ? false : catchOverview()
      touch.current = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        dragging,
        tracker,
        release: claimTouchMoves(e.currentTarget)
      }
      if (dragging) capturePointer(e.currentTarget, e.pointerId)
    },
    onPointerMove: (e) => {
      const t = touch.current
      if (!t || t.id !== e.pointerId) return
      track(t.tracker, e)
      if (!t.dragging) {
        const dx = e.clientX - t.x0
        const dy = e.clientY - t.y0
        if (Math.hypot(dx, dy) < SLOP) return
        const state = browserStore.get().state
        if (!state || Math.abs(dx) > Math.abs(dy) || !beginOverviewDrag(state)) {
          t.release()
          touch.current = null
          return
        }
        t.dragging = true
        t.y0 = e.clientY
        capturePointer(e.currentTarget, e.pointerId)
      }
      dragOverview((e.clientY - t.y0) * inward)
    },
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true),
    style: { touchAction: 'none' }
  }
}
