import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { PaneSwipeSession, paneSwipeMayStart } from '@renderer/lib/gestures/paneSwipe'
import type { PaneSwipeDirection } from '@renderer/lib/gestures/paneSwipe'
import { capturePointer } from '@renderer/lib/gestures/pointerCapture'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import type { OverviewPane } from '@renderer/lib/privateTabs'
import { claimTouchMoves } from './usePillGestures'

/**
 * The segment's indicator line while a swipe is live (`PaneSegment` renders it; `main.css`'s
 * `.zen-overview-segment-line` beside the `.zen-v2-segment` primitive).
 */
export const SEGMENT_LINE_CLASS = 'zen-overview-segment-line'

/** The inset of the primitive's own line under a label (`.zen-v2-segment > [role='tab']::after`). */
const LINE_INSET = 8

/**
 * What a touch inside the pane is not allowed to start from: the elements with gestures of their
 * own – a card (its swipe closes it, its hold lifts it), an essential, a group or reach row (the
 * swipe reveals its delete), the space strip (it scrolls sideways), any control – and the
 * segment itself. Chrome's `Pane.isTouchOnInteractiveElement` ("such as a tab card") excludes
 * the same (`chrome/browser/hub/android/.../hub/Pane.java` lines 30-41).
 */
const INTERACTIVE =
  '[data-cell], .zen-essential, .zen-overview-strip, button, a, input, textarea, select, ' +
  '[role="button"], [role="checkbox"], [role="tab"], [role="tablist"]'

export interface PaneSwipeOptions {
  /** The pane on show. */
  pane: OverviewPane
  /** The switcher's panes in the order the segment shows them. */
  panes: readonly OverviewPane[]
  /** The overview is settled and taking touches; a drag in flight when this goes false is dropped. */
  enabled: boolean
  /** Bring the pane in: the switch's own cross-fade completes from where the drag left it. */
  onPick: (pane: OverviewPane) => void
}

export interface PaneSwipeHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
}

/** The boxes a live swipe writes to, measured once at the claim. */
interface Live {
  tablist: HTMLElement
  line: HTMLElement
  /** The pane's slot, whose opacity follows the finger; `null` once the switch has taken it. */
  pane: HTMLElement | null
  /** The line's box under the current label, and under the neighbour's, in the tablist's space. */
  x0: number
  w0: number
  x1: number
  w1: number
  direction: PaneSwipeDirection
  neighbour: OverviewPane
}

interface Touch {
  id: number
  session: PaneSwipeSession<OverviewPane>
  live: Live | null
  /** Gives the touch's moves back to the browser once it is over. */
  release: (() => void) | null
}

/** The gesture's state between events, kept outside React's render. */
interface Machine {
  touch: Touch | null
  /** The swipe whose line (and pane) the spring is carrying to rest. */
  settling: Live | null
  spring: SpringAnimation | null
}

/** The frame at `p` (0 under the current label, 1 under the neighbour's): a transform and an opacity. */
function paint(live: Live, p: number): void {
  const dx = (live.x1 - live.x0) * p
  const s = live.w0 > 0 ? 1 + (live.w1 / live.w0 - 1) * p : 1
  live.line.style.transform = `translate3d(${dx}px, 0, 0) scaleX(${s})`
  if (live.pane) live.pane.style.opacity = String(1 - p)
}

/** The swipe is over: the primitive's own line takes over, the pane's opacity is its own again. */
function rest(live: Live): void {
  delete live.tablist.dataset.swipe
  if (live.pane) live.pane.style.opacity = ''
}

/** End a settle where it is heading: its destination drawn, the swipe over. */
function finishSettle(m: Machine): void {
  const live = m.settling
  if (!live) return
  m.spring?.stop()
  paint(live, live.pane ? 0 : 1)
  rest(live)
  m.settling = null
}

/** Let the line (and, short of a switch, the pane) go to `to` from `from` at `v` progress/s. */
function settle(m: Machine, live: Live, from: number, v: number, to: 0 | 1): void {
  finishSettle(m)
  m.settling = live
  m.spring ??= new SpringAnimation(
    SPRING_SNAPPY,
    (x) => {
      if (m.settling) paint(m.settling, Math.max(0, Math.min(1, x)))
    },
    () => {
      const done = m.settling
      if (!done) return
      paint(done, done.pane ? 0 : 1)
      rest(done)
      m.settling = null
    }
  )
  m.spring.start(from, v, to)
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

/** Find the line's two boxes and mark the swipe live; `null` when the segment is not there. */
function measure(
  rootEl: HTMLElement,
  pane: OverviewPane,
  direction: PaneSwipeDirection,
  neighbour: OverviewPane
): Live | null {
  const tablist = rootEl.querySelector<HTMLElement>('[role="tablist"].zen-v2-segment')
  const line = tablist?.querySelector<HTMLElement>(`.${SEGMENT_LINE_CLASS}`)
  const current = tablist?.querySelector<HTMLElement>(`[role="tab"][data-pane="${pane}"]`)
  const next = tablist?.querySelector<HTMLElement>(`[role="tab"][data-pane="${neighbour}"]`)
  const paneEl = rootEl.querySelector<HTMLElement>('.zen-overview-pane')
  if (!tablist || !line || !current || !next) return null
  // Offsets, not client rects: the overview root scales with the morph, and the line is laid
  // out in the tablist's own space (the modifier makes the tablist its containing block).
  const x0 = current.offsetLeft + LINE_INSET
  const w0 = current.offsetWidth - 2 * LINE_INSET
  const x1 = next.offsetLeft + LINE_INSET
  const w1 = next.offsetWidth - 2 * LINE_INSET
  line.style.left = `${x0}px`
  line.style.width = `${w0}px`
  line.style.transform = 'translate3d(0, 0, 0) scaleX(1)'
  tablist.dataset.swipe = ''
  return { tablist, line, pane: paneEl, x0, w0, x1, w1, direction, neighbour }
}

/**
 * The switcher's pane swipe (GN-19): a horizontal drag over the tab overview's pane moves to the
 * neighbouring header segment, Chrome's Hub gesture (`HubPaneSwipeGestureHandler.java`, read
 * into `lib/gestures/paneSwipe.ts`). A touch that lands on the pane's own background – not on a
 * card or a row, not in the 32 px edge gutters – is nothing until it moves 8 px; then a move
 * with the horizontal winning towards a pane that exists claims it (its touchmoves ours, the
 * pointer captured), and the pane's touch is the scroller's otherwise.
 *
 * While the finger is down the writes are input, not animation (v2 §11.3): the segment's
 * indicator line rides from under the current label towards the neighbour's – a transform per
 * frame on one element, the primitive's own lines hidden under `data-swipe` – and the pane's
 * opacity falls with the progress, the leaving half of the switch's cross-fade under the finger.
 * A release past a third of the width (or a fling onward) picks the neighbour: the switch's
 * cross-fade completes from where the drag left it (the still `PaneSlot` takes carries the
 * pane's opacity), and the line springs the rest of the way on `SPRING_SNAPPY` from the
 * finger's speed; a release short of it springs the line and the pane's opacity back. Under
 * reduced motion the drag still tracks 1:1 and the springs jump. Only transform and opacity per
 * frame. The handlers go on the overview's root, above the slot: the slot itself is replaced at
 * a switch, and a gesture must outlive that.
 */
export function usePaneSwipe(
  root: RefObject<HTMLElement | null>,
  { pane, panes, enabled, onPick }: PaneSwipeOptions
): PaneSwipeHandlers {
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
    const slot = target?.closest<HTMLElement>('.zen-overview-pane')
    if (!slot || !rootEl.contains(slot) || target?.closest(INTERACTIVE)) return
    const box = slot.getBoundingClientRect()
    if (!paneSwipeMayStart(e.clientX - box.left, box.width)) return
    // A finger landing while the last swipe settles ends that settle where it was heading.
    finishSettle(m)
    m.touch = {
      id: e.pointerId,
      session: new PaneSwipeSession<OverviewPane>(
        panes,
        pane,
        box.width,
        e.clientX,
        e.clientY,
        e.timeStamp
      ),
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
        const live = measure(rootEl, pane, step.direction, step.neighbour)
        if (!live) {
          end(m)
          return
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
      settle(m, live, progress, outcome?.velocity ?? 0, 0)
      return
    }
    // The pane's slot goes with the switch: the still `PaneSlot` takes of it keeps the opacity
    // the drag left it at, and the cross-fade completes from there. The line has the rest of
    // its way to go, from the finger's speed.
    live.pane = null
    onPick(outcome.neighbour)
    settle(m, live, outcome.progress, outcome.velocity, 1)
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true)
  }
}
