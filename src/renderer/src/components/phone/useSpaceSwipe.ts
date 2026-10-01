import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { PaneSwipeSession, paneSwipeMayStart } from '@renderer/lib/gestures/paneSwipe'
import type { PaneSwipeDirection } from '@renderer/lib/gestures/paneSwipe'
import { capturePointer } from '@renderer/lib/gestures/pointerCapture'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { claimTouchMoves } from './usePillGestures'

/**
 * What a touch inside the grid is not allowed to start from: the elements with gestures of their
 * own – a card (its swipe closes it, its hold lifts it), an essential, a group or reach row (the
 * swipe reveals its delete), the space strip (it scrolls sideways), any control. Chrome's
 * `Pane.isTouchOnInteractiveElement` ("such as a tab card") excludes the same
 * (`chrome/browser/hub/android/.../hub/Pane.java` lines 30-41).
 */
const INTERACTIVE =
  '[data-cell], .zen-essential, .zen-overview-strip, button, a, input, textarea, select, ' +
  '[role="button"], [role="checkbox"], [role="tab"], [role="tablist"]'

/** The slot the swipe moves: the Space's grid (`TabOverview`'s `PaneSlot` keyed by the Space). */
const SLOT = '.zen-overview-space'

/**
 * Where a committed swipe left the grid, for the Space that comes in to pick up from (tab
 * overview cleanup spec §6: the pane slides one width on `SPRING_SNAPPY` following the finger,
 * and the rest of the way after it): the incoming grid starts `(1 - progress)` of a width out on
 * the side the finger is heading from, at the finger's speed.
 */
export interface SpaceSwipeHandoff {
  direction: PaneSwipeDirection
  /** How far across the grid had travelled, 0 … 1. */
  progress: number
  /** The release's speed in progress per second, positive onward. */
  velocity: number
  /** The slot's width, which a full travel is. */
  width: number
}

export interface SpaceSwipeOptions {
  /** The Space on show. */
  spaceId: string
  /** The window's Spaces in their order (the strip's; a swipe left goes to the next). */
  spaceIds: readonly string[]
  /** The overview is settled and taking touches; a drag in flight when this goes false is dropped. */
  enabled: boolean
  /** Bring the Space in: the switch completes from where the drag left it (`handoff`). */
  onPick: (spaceId: string, handoff: SpaceSwipeHandoff) => void
}

export interface SpaceSwipeHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
}

/** The box a live swipe writes to, measured once at the claim. */
interface Live {
  /** The Space's slot, which rides the finger; `null` once the switch has taken it. */
  slot: HTMLElement | null
  width: number
  direction: PaneSwipeDirection
  neighbour: string
}

interface Touch {
  id: number
  session: PaneSwipeSession<string>
  /** The slot's width at the touch, which a full travel is. */
  width: number
  live: Live | null
  /** Gives the touch's moves back to the browser once it is over. */
  release: (() => void) | null
}

/** The gesture's state between events, kept outside React's render. */
interface Machine {
  touch: Touch | null
  /** The swipe whose slot the spring is carrying back to rest. */
  settling: Live | null
  spring: SpringAnimation | null
}

/** The slot's travel at `p` (0 at rest, 1 a full width on): the finger's way, signed. */
export function slotTravel(p: number, width: number, direction: PaneSwipeDirection): number {
  return (direction === 'left' ? -1 : 1) * p * width
}

/** The frame at `p`: one transform on the slot. */
function paint(live: Live, p: number): void {
  if (!live.slot) return
  live.slot.style.transform = `translate3d(${slotTravel(p, live.width, live.direction)}px, 0, 0)`
  live.slot.dataset.swipe = ''
}

/** The swipe is over without a switch: the slot's transform is its own again. */
function rest(live: Live): void {
  if (!live.slot) return
  live.slot.style.transform = ''
  delete live.slot.dataset.swipe
}

/** End a settle where it is heading: at rest, the swipe over. */
function finishSettle(m: Machine): void {
  const live = m.settling
  if (!live) return
  m.spring?.stop()
  rest(live)
  m.settling = null
}

/**
 * Let the slot spring back to rest from `from` at `v` progress/s. The spring runs in pixels –
 * the slot's width is a full travel – since its rest thresholds (0.4 px, 8 px/s) are pixel
 * measures: in progress units a release under a third sits inside the rest delta and the slot
 * would snap home on the first frame instead of springing.
 */
function settle(m: Machine, live: Live, from: number, v: number): void {
  finishSettle(m)
  m.settling = live
  m.spring ??= new SpringAnimation(
    SPRING_SNAPPY,
    (x) => {
      const s = m.settling
      if (s) paint(s, Math.max(0, Math.min(1, x / travelWidth(s))))
    },
    () => {
      const done = m.settling
      if (!done) return
      rest(done)
      m.settling = null
    }
  )
  const width = travelWidth(live)
  m.spring.start(from * width, v * width, 0)
}

/** A full travel in pixels; a slot without a measured width still gets a finite spring. */
function travelWidth(live: Live): number {
  return live.width > 0 ? live.width : 1
}

/** The touch is over, whatever it was: its moves are the browser's again. */
function end(m: Machine): void {
  m.touch?.release?.()
  m.touch = null
}

/** Drop a drag in flight without a settle (the overview closed under it). */
function drop(m: Machine): void {
  if (m.touch?.live) rest(m.touch.live)
  end(m)
}

/**
 * The overview's SPACE swipe (GN-19; tab overview cleanup spec §1, §6): a horizontal drag over
 * the grid's background moves to the neighbouring Space, the header following, Chrome's Hub
 * gesture (`HubPaneSwipeGestureHandler.java`, read into `lib/gestures/paneSwipe.ts`) turned to
 * the Spaces now that the overview has no panes to move between. A touch that lands on the
 * grid's own background – not on a card or a row, not in the 32 px edge gutters – is nothing
 * until it moves 8 px; then a move with the horizontal winning towards a Space that exists
 * claims it (its touchmoves ours, the pointer captured), and the grid's touch is the scroller's
 * otherwise. In a right-to-left layout the strip's order runs the other way, so a swipe left
 * goes to the previous Space.
 *
 * While the finger is down the writes are input, not animation (v2 §11.3): the Space's slot
 * rides the finger 1:1 – one transform per frame on one element. A release past a third of the
 * width (or a fling onward) picks the neighbour: `onPick` switches the Space and hands the
 * incoming grid where the finger left (`SpaceSwipeHandoff`: it springs the rest of the way on
 * `SPRING_SNAPPY` from the finger's speed, `TabOverview`'s `enterSpace`), the still of the grid
 * that left fading where it stood; a release short of it springs the slot back. Under reduced
 * motion the drag still tracks 1:1 and the springs jump. Only transform and opacity per frame.
 * The handlers go on the overview's root, above the slot: the slot itself is replaced at a
 * switch, and a gesture must outlive that.
 */
export function useSpaceSwipe(
  root: RefObject<HTMLElement | null>,
  { spaceId, spaceIds, enabled, onPick }: SpaceSwipeOptions
): SpaceSwipeHandlers {
  const machine = useRef<Machine>({ touch: null, settling: null, spring: null })

  // The overview closing under a drag drops it.
  useEffect(() => {
    if (!enabled) drop(machine.current)
  }, [enabled])

  useEffect(
    () => () => {
      const m = machine.current
      finishSettle(m)
      drop(m)
    },
    []
  )

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    const m = machine.current
    const rootEl = root.current
    if (!enabled || !rootEl || e.button !== 0 || m.touch) return
    const target = e.target as HTMLElement | null
    const slot = target?.closest<HTMLElement>(SLOT)
    if (!slot || !rootEl.contains(slot) || target?.closest(INTERACTIVE)) return
    const box = slot.getBoundingClientRect()
    if (!paneSwipeMayStart(e.clientX - box.left, box.width)) return
    // A finger landing while the last swipe settles ends that settle where it was heading.
    finishSettle(m)
    const rtl = getComputedStyle(rootEl).direction === 'rtl'
    const order = rtl ? [...spaceIds].reverse() : spaceIds
    m.touch = {
      id: e.pointerId,
      session: new PaneSwipeSession<string>(
        order,
        spaceId,
        box.width,
        e.clientX,
        e.clientY,
        e.timeStamp
      ),
      width: box.width,
      live: null,
      release: null
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const m = machine.current
    const t = m.touch
    const rootEl = root.current
    if (!t || t.id !== e.pointerId || !rootEl) return
    const step = t.session.move(e.clientX, e.clientY, e.timeStamp)
    switch (step.kind) {
      case 'pending':
        return
      case 'declined':
        end(m)
        return
      case 'claimed': {
        const slot = rootEl.querySelector<HTMLElement>(SLOT)
        if (!slot) {
          end(m)
          return
        }
        const live: Live = {
          slot,
          width: slot.getBoundingClientRect().width || t.width,
          direction: step.direction,
          neighbour: step.neighbour
        }
        t.live = live
        t.release = claimTouchMoves(e.currentTarget)
        capturePointer(e.currentTarget, e.pointerId)
        paint(live, step.progress)
        return
      }
      case 'dragging':
        if (t.live) paint(t.live, step.progress)
    }
  }

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const m = machine.current
    const t = m.touch
    if (!t || t.id !== e.pointerId) return
    const live = t.live
    const outcome = cancelled ? null : t.session.release(e.timeStamp)
    const progress = t.session.progress
    end(m)
    if (!live) return
    if (!outcome?.commit) {
      settle(m, live, progress, outcome?.velocity ?? 0)
      return
    }
    // The slot goes with the switch: the still `PaneSlot` takes of it stands where the drag
    // left it (the transform measured into its box, not copied), and the incoming grid springs
    // the rest of the way from the finger's speed.
    const handoff: SpaceSwipeHandoff = {
      direction: live.direction,
      progress: outcome.progress,
      velocity: outcome.velocity,
      width: live.width
    }
    live.slot = null
    onPick(outcome.neighbour, handoff)
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true)
  }
}
