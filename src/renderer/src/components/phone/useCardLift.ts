import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { Rect, Tab } from '@shared/types'
import { SpringAnimation, type SpringConfig } from '@renderer/lib/motion/spring'
import { createStore } from '@renderer/lib/store'

/** Hold before a card comes off the grid. */
const LONG_PRESS_MS = 380
/** Movement (px) that turns a held card into a drag, or a touch into a scroll. */
const SLOP = 8
/** Distance from the edge of the grid within which a drag scrolls it. */
const AUTOSCROLL_ZONE = 56
/** How long a released hold waits for its click before opening the actions regardless. */
const MENU_DELAY_MS = 250
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
 * Where a dragged card may land, from the `data-drop` attribute under the finger:
 *  - `card:<tabId>`   another tab's card – the two become a group (or the card joins its group)
 *  - `group:<id>`     a group card – the tab joins the group
 *  - `loose`          the landing strip below the grid – the tab leaves its group
 */
export type LiftTarget = string

export type LiftPhase = 'idle' | 'lifted' | 'dragging' | 'dropping'

export interface LiftState {
  tabId: string | null
  phase: LiftPhase
  /** The ghost card, in window coordinates. */
  ghost: Rect | null
  /** Where the card came from, in window coordinates. */
  origin: Rect | null
  /** Drop target under the finger, null when it would spring back. */
  target: LiftTarget | null
  /** Scale of the ghost (1 on the grid, smaller in the hand, smaller still over a target). */
  scale: number
}

const IDLE: LiftState = {
  tabId: null,
  phase: 'idle',
  ghost: null,
  origin: null,
  target: null,
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
  if (phase === 'dragging') return target && target !== 'loose' ? 0.84 : 0.94
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

function dropTargetAt(x: number, y: number, ownId: string): LiftTarget | null {
  const el = document.elementFromPoint(x, y)
  const target = el?.closest<HTMLElement>('[data-drop]')
  const key = target?.dataset.drop ?? null
  if (!key || key === `card:${ownId}`) return null
  return key
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

export interface CardLiftOptions {
  tab: Tab
  /** Cards that cannot be grouped (pinned tabs) are never picked up. */
  enabled: boolean
  /** The grid's scroll container, for auto-scrolling while dragging near its edges. */
  scroller: () => HTMLElement | null
  /** Held without moving, then released: show the card's actions. */
  onMenu: (tab: Tab) => void
  /**
   * Dropped. The owner acts on the target and, once the grid shows the card in its slot (its
   * old one when nothing changed), calls `settleLift` with that slot so the ghost flies there.
   */
  onDrop: (tab: Tab, target: LiftTarget | null) => void
}

export interface CardLiftHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  /** Whether the click that follows this touch must be ignored (it was a hold or a drag). */
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
}

/**
 * Long-press a card to pick it up: held in place and released it shows its actions; moved, it
 * follows the finger as a ghost and can be dropped on another card (the two become a group), on
 * a group (it joins) or on the strip below the grid (it leaves its group). A touch that moves
 * before the hold is over is a scroll, and never ours.
 */
export function useCardLift({
  tab,
  enabled,
  scroller,
  onMenu,
  onDrop
}: CardLiftOptions): CardLiftHandlers {
  const touch = useRef<Touch | null>(null)
  const swallow = useRef(false)
  const autoscroll = useRef<number | null>(null)

  const stopAutoscroll = (): void => {
    if (autoscroll.current !== null) cancelAnimationFrame(autoscroll.current)
    autoscroll.current = null
  }

  const clear = (): void => {
    const t = touch.current
    if (t?.timer) clearTimeout(t.timer)
    touch.current = null
    stopAutoscroll()
    document.removeEventListener('touchmove', blockTouchScroll)
  }

  useEffect(
    () => () => {
      const t = touch.current
      if (t?.timer) clearTimeout(t.timer)
      touch.current = null
      if (autoscroll.current !== null) cancelAnimationFrame(autoscroll.current)
      document.removeEventListener('touchmove', blockTouchScroll)
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
    liftStore.set({ tabId: tab.id, phase: 'lifted', ghost: rect, origin: rect, target: null })
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
      autoscroll.current = requestAnimationFrame(tick)
    }
    autoscroll.current = requestAnimationFrame(tick)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    swallow.current = false
    if (!enabled || e.button !== 0 || touch.current) return
    if ((e.target as HTMLElement).closest('button')) return
    if (liftStore.get().phase !== 'idle') return
    const el = e.currentTarget
    const t: Touch = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      timer: null,
      lifted: false
    }
    t.timer = setTimeout(() => lift(el, t), LONG_PRESS_MS)
    touch.current = t
    // Every event of this touch comes here, wherever the finger wanders; a native scroll still
    // takes over (with a pointercancel) when it moves before the hold is up.
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* the pointer is gone */
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const t = touch.current
    if (!t || t.id !== e.pointerId) return
    t.x = e.clientX
    t.y = e.clientY
    const moved = Math.hypot(t.x - t.x0, t.y - t.y0) >= SLOP
    if (!t.lifted) {
      // Moving before the hold is over is a scroll (or a swipe) – not ours.
      if (moved) clear()
      return
    }
    const s = liftStore.get()
    if (s.phase === 'lifted' && moved) {
      liftStore.set({ phase: 'dragging' })
      retargetScale()
    }
    if (liftStore.get().phase !== 'dragging') return
    follow(t)
    const target = dropTargetAt(t.x, t.y, tab.id)
    if (target !== s.target) {
      liftStore.set({ target })
      retargetScale()
      if (target && target !== 'loose') vibrate(4)
    }
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
    clear()
    if (!lifted) return
    const s = liftStore.get()
    if (s.phase === 'lifted' || cancelled) {
      // Put it straight back down; the menu comes up for a hold that was released in place.
      liftStore.set({ phase: 'dropping', target: null })
      if (s.origin) settleLift(s.origin)
      else cancelLift()
      if (s.phase === 'lifted' && !cancelled)
        menuTimer.current = setTimeout(openMenu, MENU_DELAY_MS)
      return
    }
    liftStore.set({ phase: 'dropping' })
    onDrop(tab, s.target)
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
