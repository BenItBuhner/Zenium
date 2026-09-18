import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { Rect, Tab } from '@shared/types'
import { capturePointer } from '@renderer/lib/gestures/pointerCapture'
import { SpringAnimation, type SpringConfig } from '@renderer/lib/motion/spring'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import { createStore } from '@renderer/lib/store'
import { CardSwipe } from './cardSwipe'

/** Hold before a card comes off the grid. */
const LONG_PRESS_MS = 380
/** Movement (px) that turns a held card into a drag, or a touch into a scroll or a swipe. */
const SLOP = 8
/** Distance from the edge of the grid within which a drag scrolls it. */
const AUTOSCROLL_ZONE = 56
/** How long a released hold waits for its click before opening the actions regardless. */
const MENU_DELAY_MS = 250
/** How long the finger rests with a new slot before the gap opens there (see `hover`)… */
const SLOT_DWELL_MS = 150
/** …and how slow (px/s) it has to be moving to count as resting. */
const SLOT_SPEED_PX_S = 120
const AUTOSCROLL_SPEED = 14

/** The ghost tracks the finger closely but not rigidly: a firm spring with a little give. */
const SPRING_FOLLOW: SpringConfig = {
  stiffness: 640,
  damping: 46,
  mass: 1,
  restDelta: 0.3,
  restSpeed: 6
}

/**
 * Where a dragged card may land when it is dropped *on* something:
 *  - `card:<tabId>`   another tab's card – the two become a group (or the card joins its group)
 *  - `group:<id>`     a group card – the tab joins the group
 */
export type LiftTarget = string

/**
 * Where a dragged card is going to be put *between* things: a position in a group's members
 * (`folderId`) or in the loose tabs (`null`), counted without the dragged tab itself.
 */
export interface LiftSlot {
  folderId: string | null
  index: number
}

/** What is under the finger, as the owner of the grid works it out from its layout. */
export interface LiftHover {
  target: LiftTarget | null
  slot: LiftSlot | null
}

export type LiftPhase = 'idle' | 'lifted' | 'dragging' | 'dropping'

export interface LiftState {
  tabId: string | null
  phase: LiftPhase
  /** The ghost card, in window coordinates. */
  ghost: Rect | null
  /** Where the card came from, in window coordinates. */
  origin: Rect | null
  /** Drop target under the finger, null when the card would go into its slot instead. */
  target: LiftTarget | null
  /** Slot the card's stand-in is shown in while it is dragged (and lands in when dropped). */
  slot: LiftSlot | null
  /** Scale of the ghost (1 on the grid, smaller in the hand, smaller still over a target). */
  scale: number
}

const IDLE: LiftState = {
  tabId: null,
  phase: 'idle',
  ghost: null,
  origin: null,
  target: null,
  slot: null,
  scale: 1
}

/** One card at a time can be held; everything that draws the gesture reads this. */
export const liftStore = createStore<LiftState>(IDLE, 'card-lift')

let onSettled: (() => void) | null = null

const xSpring = new SpringAnimation(
  SPRING_FOLLOW,
  (x) => {
    const s = liftStore.get()
    if (!s.ghost) return
    liftStore.set({ ghost: { ...s.ghost, x } })
  },
  () => maybeSettled()
)
const ySpring = new SpringAnimation(
  SPRING_FOLLOW,
  (y) => {
    const s = liftStore.get()
    if (!s.ghost) return
    liftStore.set({ ghost: { ...s.ghost, y } })
  },
  () => maybeSettled()
)
const scaleSpring = new SpringAnimation(
  { stiffness: 520, damping: 34, mass: 1, restDelta: 0.001, restSpeed: 0.01 },
  (scale) => liftStore.set({ scale }),
  () => maybeSettled()
)

function maybeSettled(): void {
  if (liftStore.get().phase !== 'dropping') return
  if (xSpring.running || ySpring.running || scaleSpring.running) return
  const done = onSettled
  onSettled = null
  liftStore.set(IDLE)
  done?.()
}

function stopSprings(): void {
  xSpring.stop()
  ySpring.stop()
  scaleSpring.stop()
}

/** Scale of the ghost for the current situation. */
function targetScale(phase: LiftPhase, target: LiftTarget | null): number {
  if (phase === 'lifted') return 1.04
  if (phase === 'dragging') return target ? 0.84 : 0.94
  return 1
}

function retargetScale(): void {
  const s = liftStore.get()
  const to = targetScale(s.phase, s.target)
  if (scaleSpring.running) scaleSpring.retarget(to)
  else scaleSpring.start(s.scale, 0, to)
}

/**
 * The dropped card's new slot is known (the grid has re-laid itself out): fly the ghost there
 * and put the card back once it has landed. `then` runs when the gesture is over.
 */
export function settleLift(to: Rect, then?: () => void): void {
  const s = liftStore.get()
  if (s.phase !== 'dropping' || !s.ghost) return
  onSettled = then ?? null
  liftStore.set({ ghost: { ...s.ghost, width: to.width, height: to.height } })
  xSpring.start(s.ghost.x, xSpring.current.v, to.x)
  ySpring.start(s.ghost.y, ySpring.current.v, to.y)
  scaleSpring.start(s.scale, 0, 1)
}

/** Drop everything without animation (the overview went away). */
export function cancelLift(): void {
  stopSprings()
  onSettled = null
  if (liftStore.get().phase !== 'idle') liftStore.set(IDLE)
}

function vibrate(ms: number): void {
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* not available */
  }
}

/** A touch that has picked a card up must not scroll the grid; touch-action is too late for that. */
function blockTouchScroll(e: TouchEvent): void {
  if (e.cancelable) e.preventDefault()
}

function sameSlot(a: LiftSlot | null, b: LiftSlot | null): boolean {
  if (!a || !b) return a === b
  return a.folderId === b.folderId && a.index === b.index
}

export interface CardLiftOptions {
  tab: Tab
  /** Cards that cannot be grouped (pinned tabs) are never picked up. */
  enabled: boolean
  /** Cards that cannot be closed by a swipe (pinned tabs) are never swiped. */
  swipeable: boolean
  /** The grid's scroll container, for auto-scrolling while dragging near its edges. */
  scroller: () => HTMLElement | null
  /** Held without moving, then released: show the card's actions. */
  onMenu: (tab: Tab) => void
  /**
   * The finger is at (x, y) with the card in hand: what it is over. Asked on every move; the
   * answer's `slot` moves the card's stand-in (the grid opens the gap), its `target` marks what
   * the card would merge into.
   */
  onHover: (tab: Tab, x: number, y: number, current: LiftHover) => LiftHover
  /**
   * Dropped. The owner acts on the target (or the slot) and, once the grid shows the card in its
   * place (its old one when nothing changed), calls `settleLift` with that slot so the ghost
   * flies there.
   */
  onDrop: (tab: Tab, target: LiftTarget | null, slot: LiftSlot | null) => void
  /** Swiped off the grid: close the tab. */
  onSwipeClose: (tab: Tab) => void
}

export interface CardLiftHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  /** Whether the click that follows this touch must be ignored (it was a hold, a drag or a swipe). */
  swallowsClick: () => boolean
}

interface Touch {
  id: number
  x0: number
  y0: number
  x: number
  y: number
  timer: ReturnType<typeof setTimeout> | null
  lifted: boolean
  /** Finger position that maps to a swipe offset of zero. */
  swipeFrom: number | null
  velocity: VelocityTracker
}

/**
 * The gestures of a card in the grid, beyond the tap that opens it. Long-press picks it up: held
 * in place and released it shows its actions; moved, it follows the finger as a ghost that can be
 * dropped on another card (the two become a group), on a group (it joins) or between cards (it
 * moves there – the gap opens under the finger). A sideways move before the hold is up swipes the
 * card off the grid to close it; a vertical one is a scroll, and never ours.
 */
export function useCardLift({
  tab,
  enabled,
  swipeable,
  scroller,
  onMenu,
  onHover,
  onDrop,
  onSwipeClose
}: CardLiftOptions): CardLiftHandlers {
  const touch = useRef<Touch | null>(null)
  const swallow = useRef(false)
  const autoscroll = useRef<number | null>(null)
  // One swipe per card for as long as it is on the grid, whatever the tab's record becomes.
  const latest = useRef({ tab, onSwipeClose })
  useLayoutEffect(() => {
    latest.current = { tab, onSwipeClose }
  })
  const swipeRef = useRef<CardSwipe | null>(null)
  const swipe = (): CardSwipe =>
    (swipeRef.current ??= new CardSwipe(() => latest.current.onSwipeClose(latest.current.tab)))

  /**
   * A new slot takes hold only once the finger has stayed with it for a moment: the edge of a
   * card is on the way to its middle, and the gap must not open (moving that card away) under a
   * finger that is heading for a merge. Merge targets take hold at once.
   */
  const pendingSlot = useRef<{
    slot: LiftSlot | null
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const dropPendingSlot = (): void => {
    if (pendingSlot.current) clearTimeout(pendingSlot.current.timer)
    pendingSlot.current = null
  }
  const applySlot = (slot: LiftSlot | null): void => {
    dropPendingSlot()
    if (liftStore.get().phase === 'dragging') liftStore.set({ slot })
  }
  const stopAutoscroll = (): void => {
    if (autoscroll.current !== null) cancelAnimationFrame(autoscroll.current)
    autoscroll.current = null
  }

  const clear = (): void => {
    const t = touch.current
    if (t?.timer) clearTimeout(t.timer)
    touch.current = null
    stopAutoscroll()
    dropPendingSlot()
    document.removeEventListener('touchmove', blockTouchScroll)
  }

  useEffect(
    () => () => {
      const t = touch.current
      if (t?.timer) clearTimeout(t.timer)
      touch.current = null
      if (autoscroll.current !== null) cancelAnimationFrame(autoscroll.current)
      if (pendingSlot.current) clearTimeout(pendingSlot.current.timer)
      pendingSlot.current = null
      document.removeEventListener('touchmove', blockTouchScroll)
    },
    []
  )
  useEffect(
    () => () => {
      swipeRef.current?.dispose()
      swipeRef.current = null
    },
    []
  )

  const lift = (el: HTMLElement, t: Touch): void => {
    t.timer = null
    if (liftStore.get().phase !== 'idle') return
    const r = el.getBoundingClientRect()
    const rect = { x: r.left, y: r.top, width: r.width, height: r.height }
    t.lifted = true
    swallow.current = true
    stopSprings()
    liftStore.set({
      tabId: tab.id,
      phase: 'lifted',
      ghost: rect,
      origin: rect,
      target: null,
      slot: null
    })
    scaleSpring.start(1, 0, targetScale('lifted', null))
    document.addEventListener('touchmove', blockTouchScroll, { passive: false })
    vibrate(8)
  }

  const follow = (t: Touch): void => {
    const s = liftStore.get()
    if (!s.origin) return
    // The ghost keeps the grip the finger took on it, wherever the grid scrolls underneath.
    const toX = s.origin.x + (t.x - t.x0)
    const toY = s.origin.y + (t.y - t.y0)
    if (xSpring.running) xSpring.retarget(toX)
    else xSpring.start(s.ghost?.x ?? toX, 0, toX)
    if (ySpring.running) ySpring.retarget(toY)
    else ySpring.start(s.ghost?.y ?? toY, 0, toY)
  }

  const hover = (t: Touch): void => {
    const s = liftStore.get()
    const next = onHover(tab, t.x, t.y, { target: s.target, slot: s.slot })
    if (next.target !== s.target) {
      liftStore.set({ target: next.target })
      retargetScale()
      if (next.target) vibrate(4)
    }
    if (sameSlot(next.slot, s.slot)) {
      dropPendingSlot()
      return
    }
    // The dwell counts from the moment the finger slows down: a finger still on its way (over the
    // edge of a card, towards its middle) keeps the timer waiting.
    const { vx, vy } = t.velocity.velocity(performance.now())
    const settling = Math.hypot(vx, vy) < SLOT_SPEED_PX_S
    if (pendingSlot.current && sameSlot(pendingSlot.current.slot, next.slot) && settling) return
    dropPendingSlot()
    pendingSlot.current = {
      slot: next.slot,
      timer: setTimeout(() => applySlot(next.slot), SLOT_DWELL_MS)
    }
  }

  const scrollNearEdges = (t: Touch): void => {
    stopAutoscroll()
    const el = scroller()
    if (!el) return
    const tick = (): void => {
      autoscroll.current = null
      const r = el.getBoundingClientRect()
      let delta = 0
      if (t.y < r.top + AUTOSCROLL_ZONE)
        delta = -AUTOSCROLL_SPEED * (1 - (t.y - r.top) / AUTOSCROLL_ZONE)
      else if (t.y > r.bottom - AUTOSCROLL_ZONE)
        delta = AUTOSCROLL_SPEED * (1 - (r.bottom - t.y) / AUTOSCROLL_ZONE)
      if (delta === 0 || liftStore.get().phase !== 'dragging') return
      const before = el.scrollTop
      el.scrollTop += delta
      if (el.scrollTop === before) return
      // The slots moved under the finger.
      hover(t)
      autoscroll.current = requestAnimationFrame(tick)
    }
    autoscroll.current = requestAnimationFrame(tick)
  }

  const startSwipe = (el: HTMLElement, t: Touch, from: number): void => {
    if (t.timer) clearTimeout(t.timer)
    t.timer = null
    t.swipeFrom = from
    swallow.current = true
    swipe().begin(el)
    document.addEventListener('touchmove', blockTouchScroll, { passive: false })
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    swallow.current = false
    if (e.button !== 0 || touch.current) return
    if ((e.target as HTMLElement).closest('button')) return
    // A card on its way out is not for touching.
    if (swipe().committed) return
    if (liftStore.get().phase !== 'idle') return
    const el = e.currentTarget
    const t: Touch = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      timer: null,
      lifted: false,
      swipeFrom: null,
      velocity: new VelocityTracker()
    }
    t.velocity.add(e.timeStamp, e.clientX, e.clientY)
    touch.current = t
    if (swipe().running) {
      // Caught springing back: carry on from where the card is.
      startSwipe(el, t, e.clientX - swipe().catchUp())
    } else if (enabled) {
      t.timer = setTimeout(() => lift(el, t), LONG_PRESS_MS)
    } else if (!swipeable) {
      touch.current = null
      return
    }
    // Every event of this touch comes here, wherever the finger wanders; a native scroll still
    // takes over (with a pointercancel) when it moves vertically before the hold is up.
    try {
      capturePointer(el, e.pointerId)
    } catch {
      /* the pointer is gone */
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    t.x = e.clientX
    t.y = e.clientY
    const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }
    const coalesced = native.getCoalescedEvents?.() ?? []
    if (coalesced.length > 0)
      for (const c of coalesced) t.velocity.add(c.timeStamp, c.clientX, c.clientY)
    else t.velocity.add(e.timeStamp, e.clientX, e.clientY)
    if (t.swipeFrom !== null) {
      swipe().move(t.x - t.swipeFrom)
      return
    }
    const dx = t.x - t.x0
    const dy = t.y - t.y0
    const moved = Math.hypot(dx, dy) >= SLOP
    if (!t.lifted) {
      if (!moved) return
      // Sideways before the hold is over is a swipe; anything else is a scroll – not ours.
      if (swipeable && Math.abs(dx) > Math.abs(dy)) {
        startSwipe(e.currentTarget, t, t.x0 + Math.sign(dx) * SLOP)
        swipe().move(t.x - (t.swipeFrom ?? t.x0))
      } else clear()
      return
    }
    const s = liftStore.get()
    if (s.phase === 'lifted' && moved) {
      liftStore.set({ phase: 'dragging' })
      retargetScale()
    }
    if (liftStore.get().phase !== 'dragging') return
    follow(t)
    hover(t)
    scrollNearEdges(t)
  }

  /**
   * A hold released in place opens the card's actions – on the click that follows the release
   * (so the sheet's scrim, appearing under the finger, cannot receive that same click), or after
   * a moment if no click comes.
   */
  const menuTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openMenu = (): void => {
    if (menuTimer.current) clearTimeout(menuTimer.current)
    menuTimer.current = null
    onMenu(tab)
  }
  useEffect(
    () => () => {
      if (menuTimer.current) clearTimeout(menuTimer.current)
    },
    []
  )

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    const lifted = t.lifted
    const swiping = t.swipeFrom !== null
    clear()
    if (swiping) {
      swipe().release(cancelled ? 0 : t.velocity.velocity(e.timeStamp).vx)
      return
    }
    if (!lifted) return
    const s = liftStore.get()
    if (s.phase === 'lifted' || cancelled) {
      // Put it straight back down; the menu comes up for a hold that was released in place.
      liftStore.set({ phase: 'dropping', target: null, slot: null })
      if (s.origin) settleLift(s.origin)
      else cancelLift()
      if (s.phase === 'lifted' && !cancelled)
        menuTimer.current = setTimeout(openMenu, MENU_DELAY_MS)
      return
    }
    liftStore.set({ phase: 'dropping' })
    onDrop(tab, s.target, s.slot)
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true),
    swallowsClick: () => {
      const s = swallow.current
      swallow.current = false
      if (menuTimer.current) openMenu()
      return s
    }
  }
}
