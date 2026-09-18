import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { Rect, Tab } from '@shared/types'
import {
  beginDrag,
  DRAG_SLOP,
  DROP_IDLE,
  dwellDeadline,
  elapseDrag,
  hoverDrag,
  leaveDrag,
  releaseDrag,
  sameSlot,
  scrollDrag,
  type DragPointer,
  type DropHover,
  type DropOutcome,
  type DropSlot,
  type DropTargetKey,
  type DropTargetState
} from '@renderer/lib/gestures/dropTarget'
import { capturePointer } from '@renderer/lib/gestures/pointerCapture'
import { SPRING_SNAPPY, SpringAnimation, type SpringConfig } from '@renderer/lib/motion/spring'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import { createStore } from '@renderer/lib/store'
import { CardSwipe } from './cardSwipe'

/** Hold before a card comes off the grid. */
const LONG_PRESS_MS = 380
/** Movement (px) that turns a held card into a drag, or a touch into a scroll or a swipe. */
const SLOP = DRAG_SLOP
/** Distance from the edge of the grid within which a drag scrolls it. */
const AUTOSCROLL_ZONE = 56
/** How long a released hold waits for its click before opening the actions regardless. */
const MENU_DELAY_MS = 250
const AUTOSCROLL_SPEED = 14

/**
 * The ghost tracks the finger closely but not rigidly: a firm spring with a little give. Let go,
 * it glides home on the grid's own `SPRING_SNAPPY` from the velocity it had (v2 §11.4).
 */
const SPRING_FOLLOW: SpringConfig = {
  stiffness: 640,
  damping: 46,
  mass: 1,
  restDelta: 0.3,
  restSpeed: 6
}
/** Scale of the card in the hand (v2 §11.4); over a merge target it tucks in further. */
const LIFT_SCALE = 1.02
const TUCK_SCALE = 0.84

/**
 * Where a dragged card may land when it is dropped *on* something:
 *  - `card:<tabId>`   another tab's card – the two become a group (or the card joins its group)
 *  - `group:<id>`     a group card – the tab joins the group
 */
export type LiftTarget = DropTargetKey

/**
 * Where a dragged card is going to be put *between* things: a position in a group's members
 * (`folderId`) or in the loose tabs (`null`), counted without the dragged tab itself.
 */
export type LiftSlot = DropSlot

/** What is under the finger, as the owner of the grid works it out from its layout. */
export type LiftHover = DropHover

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
/** The ghost is flying into its slot (`settleLift` was called; the springs may retarget). */
let landing = false

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
  landing = false
  liftStore.set(IDLE)
  done?.()
}

function stopSprings(): void {
  xSpring.stop()
  ySpring.stop()
  scaleSpring.stop()
  landing = false
}

/** Scale of the ghost for the current situation. */
function targetScale(phase: LiftPhase, target: LiftTarget | null): number {
  if (phase === 'lifted') return LIFT_SCALE
  if (phase === 'dragging') return target ? TUCK_SCALE : LIFT_SCALE
  return 1
}

function retargetScale(): void {
  const s = liftStore.get()
  const to = targetScale(s.phase, s.target)
  if (scaleSpring.running) scaleSpring.retarget(to)
  else scaleSpring.start(s.scale, 0, to)
}

/**
 * The dropped card's new slot is known (the grid has re-laid itself out): fly the ghost there on
 * the grid's own spring, from the velocity it had in the hand (v2 §11.4), and put the card back
 * once it has landed. `then` runs when the gesture is over.
 */
export function settleLift(to: Rect, then?: () => void): void {
  const s = liftStore.get()
  if (s.phase !== 'dropping' || !s.ghost) return
  onSettled = then ?? null
  landing = true
  liftStore.set({ ghost: { ...s.ghost, width: to.width, height: to.height } })
  xSpring.start(s.ghost.x, xSpring.current.v, to.x, SPRING_SNAPPY)
  ySpring.start(s.ghost.y, ySpring.current.v, to.y, SPRING_SNAPPY)
  scaleSpring.start(s.scale, 0, 1)
}

/**
 * The slot the ghost is flying into has moved (the card's stand-in is gliding – the cells below
 * a group were let go once its height had settled): keep heading for where it is drawn now, so
 * the ghost lands on the card wherever the glide has taken it. Nothing until `settleLift`.
 */
export function retargetLift(to: Rect): void {
  const s = liftStore.get()
  if (!landing || s.phase !== 'dropping' || !s.ghost) return
  if (s.ghost.width !== to.width || s.ghost.height !== to.height)
    liftStore.set({ ghost: { ...s.ghost, width: to.width, height: to.height } })
  if (xSpring.destination !== to.x) xSpring.retarget(to.x)
  if (ySpring.destination !== to.y) ySpring.retarget(to.y)
}

/** Drop everything without animation (the overview went away). */
export function cancelLift(): void {
  session?.end()
  clearPendingMenu()
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

/**
 * A touch that has picked a card up must not scroll the grid; touch-action is too late for that,
 * so its touchmoves are cancelled instead. Listened for on the document and, once a card is in
 * the hand, on the node the touch started on as well: Chromium keeps dispatching the touch's
 * events to that node after React has taken it out of the document (the card re-mounted in
 * another parent), and from a detached node they never reach the document – the grid's `pan-y`
 * would take the touch over at the first re-mount and end the drag with a pointercancel.
 */
function blockTouchScroll(e: Event): void {
  if (e.cancelable) e.preventDefault()
}

/**
 * A hold released in place opens the card's actions – on the click that follows the release
 * (so the sheet's scrim, appearing under the finger, cannot receive that same click), or after
 * a moment if no click comes.
 */
let pendingMenu: { timer: ReturnType<typeof setTimeout>; open: () => void } | null = null

function scheduleMenu(open: () => void): void {
  clearPendingMenu()
  pendingMenu = { timer: setTimeout(firePendingMenu, MENU_DELAY_MS), open }
}

function firePendingMenu(): void {
  const menu = pendingMenu
  if (!menu) return
  clearTimeout(menu.timer)
  pendingMenu = null
  menu.open()
}

function clearPendingMenu(): void {
  if (pendingMenu) clearTimeout(pendingMenu.timer)
  pendingMenu = null
}

/**
 * The click that follows a lift belongs to the gesture, whichever element the browser fires it
 * on: the card may have been re-mounted meanwhile (its stand-in moved to another group), and a
 * fresh card must not read that click as a tap. Cleared by the next touch, so no tap is lost.
 */
let liftedClick = false

/** What the card in the hand calls back into; the card that is mounted for it keeps it current. */
interface DragHandlers {
  tab: Tab
  scroller: () => HTMLElement | null
  onMenu: (tab: Tab) => void
  onHover: (tab: Tab, x: number, y: number, current: LiftHover) => LiftHover | null
  onDrop: (tab: Tab, outcome: DropOutcome) => void
}

/**
 * The gesture of a card in the hand, from the lift to the release. It belongs to the module, not
 * to the card's component: the card's stand-in moves between the grid and the groups as the slot
 * under the finger changes, and React re-mounts the card each time – a gesture that lived in the
 * component's hooks died with it, mid-drag, leaving the ghost in the hand and the last target
 * ringed for good. The session listens on the window, holds the pointer capture on the grid's
 * scroller (which stays put), keeps the native scroll blocked on the node the touch started on
 * (which the browser's touch events follow out of the document), and reads the card's callbacks
 * from whichever mount of the card is current. What the card is over is a `DropTargetState`
 * (`lib/gestures/dropTarget.ts`); every way the gesture can end – release, cancel, the overview
 * leaving – goes through `end()`.
 */
class DragSession {
  private drop: DropTargetState
  private x: number
  private y: number
  private readonly x0: number
  private readonly y0: number
  /** The node the touch started on; the browser's touch events follow it, not the pointer. */
  private readonly anchor: EventTarget | null
  private autoscroll: number | null = null
  private dwell: ReturnType<typeof setTimeout> | null = null
  private ended = false
  /** The last pointer event's own time, and the time it was dispatched (see `hover`). */
  private lastEvent = { at: performance.now(), seen: performance.now() }

  constructor(
    readonly pointerId: number,
    readonly tabId: string,
    touch: { x0: number; y0: number; x: number; y: number; anchor: EventTarget | null },
    private readonly velocity: VelocityTracker,
    public handlers: DragHandlers
  ) {
    this.x0 = touch.x0
    this.y0 = touch.y0
    this.x = touch.x
    this.y = touch.y
    this.anchor = touch.anchor
    this.drop = beginDrag(handlers.tab.folderId ?? null, { x: touch.x, y: touch.y })
    window.addEventListener('pointermove', this.onMove, true)
    window.addEventListener('pointerup', this.onUp, true)
    window.addEventListener('pointercancel', this.onCancel, true)
    document.addEventListener('touchmove', blockTouchScroll, { passive: false })
    this.anchor?.addEventListener('touchmove', blockTouchScroll, { passive: false })
    // Every event of this pointer keeps coming, whatever happens to the card's element.
    const scroller = handlers.scroller()
    if (scroller) {
      try {
        capturePointer(scroller, pointerId)
      } catch {
        /* the pointer is gone; the window listeners still see its end */
      }
    }
  }

  /** Stop listening and forget every timer; the store is the caller's to settle. */
  end(): void {
    if (this.ended) return
    this.ended = true
    window.removeEventListener('pointermove', this.onMove, true)
    window.removeEventListener('pointerup', this.onUp, true)
    window.removeEventListener('pointercancel', this.onCancel, true)
    document.removeEventListener('touchmove', blockTouchScroll)
    this.anchor?.removeEventListener('touchmove', blockTouchScroll)
    this.stopAutoscroll()
    this.clearDwell()
    if (session === this) session = null
  }

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return
    this.x = e.clientX
    this.y = e.clientY
    const coalesced = e.getCoalescedEvents?.() ?? []
    if (coalesced.length > 0)
      for (const c of coalesced) this.velocity.add(c.timeStamp, c.clientX, c.clientY)
    else this.velocity.add(e.timeStamp, e.clientX, e.clientY)
    const s = liftStore.get()
    if (s.phase === 'lifted' && Math.hypot(this.x - this.x0, this.y - this.y0) >= SLOP) {
      liftStore.set({ phase: 'dragging' })
      retargetScale()
    }
    if (liftStore.get().phase !== 'dragging') return
    this.follow()
    this.hover(e.timeStamp, true)
    this.scrollNearEdges()
  }

  private readonly onUp = (e: PointerEvent): void => this.finish(e, false)
  private readonly onCancel = (e: PointerEvent): void => this.finish(e, true)

  private follow(): void {
    const s = liftStore.get()
    if (!s.origin) return
    // The ghost keeps the grip the finger took on it, wherever the grid scrolls underneath.
    const toX = s.origin.x + (this.x - this.x0)
    const toY = s.origin.y + (this.y - this.y0)
    // The follow spring, always: the last landing left the springs on the grid's.
    if (xSpring.running) xSpring.retarget(toX)
    else xSpring.start(s.ghost?.x ?? toX, 0, toX, SPRING_FOLLOW)
    if (ySpring.running) ySpring.retarget(toY)
    else ySpring.start(s.ghost?.y ?? toY, 0, toY, SPRING_FOLLOW)
  }

  /**
   * Ask the grid what the finger is over and run the drop-target machine on the answer – which
   * counts only once the finger has moved past the slop from where it settled (v2 §11.4).
   *
   * The finger's speed is read at `eventTime`, on the events' own clock: the samples carry the
   * touch's timestamps, and on a busy main thread the events are dispatched well after them –
   * further than the tracker's window on a slow device, where a speed read against
   * `performance.now()` would find no recent sample and call a moving finger still, so that a
   * slot took hold under it in passing and the grid reflowed under a finger on its way. The dwell
   * and the pause are kept on `performance.now()`: how long nothing new has been heard.
   */
  private hover(eventTime: number, mirror: boolean): void {
    const now = performance.now()
    this.lastEvent = { at: eventTime, seen: now }
    const { tab, onHover } = this.handlers
    const current: LiftHover = { target: this.drop.target, slot: this.drop.slot }
    const next = onHover(tab, this.x, this.y, current)
    const { vx, vy } = this.velocity.velocity(eventTime)
    const pointer: DragPointer = { x: this.x, y: this.y, now, speed: Math.hypot(vx, vy) }
    // Off the grid: nothing is targeted, nothing waits to open.
    this.drop = next === null ? leaveDrag(this.drop, pointer) : hoverDrag(this.drop, next, pointer)
    if (mirror) this.mirror()
  }

  /** Now, on the events' clock: the last event's time plus what has passed since it came. */
  private eventNow(): number {
    return this.lastEvent.at + (performance.now() - this.lastEvent.seen)
  }

  /** Show the machine's state: the target ring and the ghost's tuck at once, the slot's gap. */
  private mirror(): void {
    const s = liftStore.get()
    if (s.phase !== 'dragging') return
    if (this.drop.target !== s.target) {
      liftStore.set({ target: this.drop.target })
      retargetScale()
      if (this.drop.target) vibrate(4)
    }
    if (!sameSlot(this.drop.slot, s.slot)) liftStore.set({ slot: this.drop.slot })
    this.scheduleDwell()
  }

  private scheduleDwell(): void {
    this.clearDwell()
    const deadline = dwellDeadline(this.drop)
    if (deadline === null) return
    this.dwell = setTimeout(
      () => {
        this.dwell = null
        this.drop = elapseDrag(this.drop, performance.now())
        this.mirror()
      },
      Math.max(0, deadline - performance.now())
    )
  }

  private clearDwell(): void {
    if (this.dwell !== null) clearTimeout(this.dwell)
    this.dwell = null
  }

  private scrollNearEdges(): void {
    this.stopAutoscroll()
    const el = this.handlers.scroller()
    if (!el) return
    const tick = (): void => {
      this.autoscroll = null
      const r = el.getBoundingClientRect()
      let delta = 0
      if (this.y < r.top + AUTOSCROLL_ZONE)
        delta = -AUTOSCROLL_SPEED * (1 - (this.y - r.top) / AUTOSCROLL_ZONE)
      else if (this.y > r.bottom - AUTOSCROLL_ZONE)
        delta = AUTOSCROLL_SPEED * (1 - (r.bottom - this.y) / AUTOSCROLL_ZONE)
      if (delta === 0 || liftStore.get().phase !== 'dragging') return
      const before = el.scrollTop
      el.scrollTop += delta
      if (el.scrollTop === before) return
      // The slots moved under the finger – at the finger's own asking.
      this.drop = scrollDrag(this.drop, 0, el.scrollTop - before)
      this.hover(this.eventNow(), true)
      this.autoscroll = requestAnimationFrame(tick)
    }
    this.autoscroll = requestAnimationFrame(tick)
  }

  private stopAutoscroll(): void {
    if (this.autoscroll !== null) cancelAnimationFrame(this.autoscroll)
    this.autoscroll = null
  }

  private finish(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerId !== this.pointerId) return
    this.end()
    const s = liftStore.get()
    if (s.tabId !== this.tabId || (s.phase !== 'lifted' && s.phase !== 'dragging')) return
    const { tab, onMenu, onDrop } = this.handlers
    if (s.phase === 'lifted' || cancelled) {
      // Put it straight back down; the menu comes up for a hold that was released in place.
      this.drop = releaseDrag(this.drop, 'cancel').state
      liftStore.set({ phase: 'dropping', target: null, slot: null })
      if (s.origin) settleLift(s.origin)
      else cancelLift()
      if (s.phase === 'lifted' && !cancelled) scheduleMenu(() => onMenu(tab))
      return
    }
    // The card lands where the finger let go: one last look under the release point.
    this.x = e.clientX
    this.y = e.clientY
    this.hover(e.timeStamp, false)
    const { outcome } = releaseDrag(this.drop, 'drop')
    this.drop = DROP_IDLE
    // The target ring goes out now; the stand-in keeps its slot until the browser shows the
    // drop, so the grid does not jump back and forth while the command is confirmed.
    liftStore.set({
      phase: 'dropping',
      target: null,
      slot: outcome.kind === 'slot' ? outcome.slot : s.slot
    })
    onDrop(tab, outcome)
  }
}

/** The one card in the hand, or null. */
let session: DragSession | null = null

/** The gesture in flight, for tests and diagnostics: the pointer it follows, or null. */
export function activeLiftPointer(): number | null {
  return session?.pointerId ?? null
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
   * the card would merge into; null says the finger is off the grid altogether.
   */
  onHover: (tab: Tab, x: number, y: number, current: LiftHover) => LiftHover | null
  /**
   * Dropped. The owner acts on the outcome and, once the grid shows the card in its place (its
   * old one when nothing changed), calls `settleLift` with that slot so the ghost flies there.
   */
  onDrop: (tab: Tab, outcome: DropOutcome) => void
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
  /** The node under the finger when it came down (see `blockTouchScroll`). */
  anchor: EventTarget | null
  timer: ReturnType<typeof setTimeout> | null
  /** Finger position that maps to a swipe offset of zero. */
  swipeFrom: number | null
  velocity: VelocityTracker
}

/**
 * The gestures of a card in the grid, beyond the tap that opens it. Long-press picks it up: held
 * in place and released it shows its actions; moved, it follows the finger as a ghost that can be
 * dropped on another card (the two become a group), on a group (it joins) or between cards (it
 * moves there – the gap opens under the finger). A sideways move before the hold is up swipes the
 * card off the grid to close it; a vertical one is a scroll, and never ours. The hook owns the
 * touch until the card is lifted; from there a `DragSession` owns it (see above), and the hook
 * only keeps the session's callbacks current for as long as this card is the one in the hand.
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
  // One swipe per card for as long as it is on the grid, whatever the tab's record becomes.
  const latest = useRef({ tab, onSwipeClose })
  useLayoutEffect(() => {
    latest.current = { tab, onSwipeClose }
  })
  const swipeRef = useRef<CardSwipe | null>(null)
  const swipe = (): CardSwipe =>
    (swipeRef.current ??= new CardSwipe(() => latest.current.onSwipeClose(latest.current.tab)))

  // This card is the one in the hand: the session reads this render's callbacks (they close over
  // the grid's current layout), also right after a re-mount.
  useLayoutEffect(() => {
    if (session && session.tabId === tab.id)
      session.handlers = { tab, scroller, onMenu, onHover, onDrop }
  })

  const clear = (): void => {
    const t = touch.current
    if (t?.timer) clearTimeout(t.timer)
    touch.current = null
    document.removeEventListener('touchmove', blockTouchScroll)
  }

  useEffect(
    () => () => {
      const t = touch.current
      if (t?.timer) clearTimeout(t.timer)
      touch.current = null
      // The swipe's scroll block is this card's; a session's is the session's.
      if (!session) document.removeEventListener('touchmove', blockTouchScroll)
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
    if (liftStore.get().phase !== 'idle' || session) return
    const r = el.getBoundingClientRect()
    const rect = { x: r.left, y: r.top, width: r.width, height: r.height }
    swallow.current = true
    liftedClick = true
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
    // From here the touch is the session's; this hook hears no more of it.
    touch.current = null
    session = new DragSession(t.id, tab.id, t, t.velocity, {
      tab,
      scroller,
      onMenu,
      onHover,
      onDrop
    })
    vibrate(8)
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
    liftedClick = false
    if (e.button !== 0 || touch.current) return
    if ((e.target as HTMLElement).closest('button')) return
    // A card on its way out is not for touching.
    if (swipe().committed) return
    if (liftStore.get().phase !== 'idle' || session) return
    const el = e.currentTarget
    const t: Touch = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      anchor: e.target,
      timer: null,
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
    if (Math.hypot(dx, dy) < SLOP) return
    // Sideways before the hold is over is a swipe; anything else is a scroll – not ours.
    if (swipeable && Math.abs(dx) > Math.abs(dy)) {
      startSwipe(e.currentTarget, t, t.x0 + Math.sign(dx) * SLOP)
      swipe().move(t.x - (t.swipeFrom ?? t.x0))
    } else clear()
  }

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    const swiping = t.swipeFrom !== null
    clear()
    if (swiping) swipe().release(cancelled ? 0 : t.velocity.velocity(e.timeStamp).vx)
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true),
    swallowsClick: () => {
      const s = swallow.current || liftedClick
      swallow.current = false
      liftedClick = false
      if (pendingMenu) firePendingMenu()
      return s
    }
  }
}
