import { run } from '../api'
import { pushBackSurface } from '../back'
import { SPRING_GENTLE, SpringAnimation } from '../motion/spring'
import { createStore } from '../store'
import { captureActiveTab, closeDrawer, uiStore } from '../ui'
import { dragPosition, settleTarget } from './swipe'

/**
 * Motion of the phone's Spaces drawer. `uiStore.drawerOpen` says whether the drawer exists (and
 * keeps the page hidden behind it); this store says how far in it is, on a 0 (off screen) … 1
 * (open) track that a spring, a finger on the drawer, or the system's predictive back gesture
 * can drive – the same catch / cancel / fling rules as the tab overview.
 */
export type DrawerPhase = 'closed' | 'dragging' | 'settling' | 'open'

export interface DrawerState {
  phase: DrawerPhase
  /** 0 = off screen … 1 = fully in; rubber-banded past the open end while dragging. */
  progress: number
}

const CLOSED: DrawerState = { phase: 'closed', progress: 0 }

export const drawerStore = createStore<DrawerState>(CLOSED, 'spaces-drawer')

/** How far the drawer travels, in px – its width. Set by the drawer once it has measured itself. */
let travel = 320
let dragStart = 0

export function setDrawerTravel(px: number): void {
  if (px > 0) travel = px
}

const spring = new SpringAnimation(
  SPRING_GENTLE,
  (x) => {
    const drawer = drawerStore.get()
    if (drawer.phase !== 'settling') return
    drawerStore.set({ progress: x / travel })
  },
  (x) => {
    const drawer = drawerStore.get()
    if (drawer.phase !== 'settling') return
    if (Math.round(x / travel) >= 1) drawerStore.set({ phase: 'open', progress: 1 })
    else finishClose()
  }
)

function settle(target: 0 | 1, velocity = 0): void {
  const { progress } = drawerStore.get()
  drawerStore.set({ phase: 'settling' })
  spring.start(progress * travel, velocity, target * travel)
}

function finishClose(): void {
  spring.stop()
  drawerStore.set(CLOSED)
  closeDrawer()
}

/** Slide the drawer in over the page (the overview's Spaces button). */
export async function openSpacesDrawer(activeTabId: string | null): Promise<void> {
  if (uiStore.get().drawerOpen) return
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ drawerOpen: true })
  drawerStore.set({ phase: 'dragging', progress: 0 })
  settle(1)
}

/** Slide the drawer out and drop it (tap on the scrim, a space picked, system back). */
export function closeSpacesDrawer(): void {
  const { phase } = drawerStore.get()
  if (phase === 'closed') {
    // Closed by something else (an overlay took over) – make sure the flag agrees.
    if (uiStore.get().drawerOpen) closeDrawer()
    return
  }
  if (phase === 'settling') spring.stop()
  settle(0)
}

/** Drop the drawer without animation (the layout changed under it). */
export function dismissSpacesDrawer(): void {
  if (drawerStore.get().phase === 'closed') return
  finishClose()
}

// ---------------------------------------------------------------------------
// Progress-driven dismissal: a finger on the drawer, or a predictive back gesture
// ---------------------------------------------------------------------------

/** A finger came down on the drawer: hold it where it is (catching a spring mid-flight). */
export function beginDrawerDrag(): boolean {
  const drawer = drawerStore.get()
  if (drawer.phase === 'closed') return false
  if (drawer.phase === 'settling') spring.stop()
  dragStart = drawer.progress
  drawerStore.set({ phase: 'dragging' })
  return true
}

/** The finger moved `delta` px towards the drawer's edge (positive = pushing it out). */
export function dragDrawer(delta: number): void {
  if (drawerStore.get().phase !== 'dragging') return
  const progress = dragPosition(dragStart, -delta, travel, 0, 1)
  if (progress !== drawerStore.get().progress) drawerStore.set({ progress })
}

/** The finger lifted, moving at `velocity` px/s towards the edge. */
export function releaseDrawer(velocity: number): void {
  const drawer = drawerStore.get()
  if (drawer.phase !== 'dragging') return
  const target = settleTarget({
    position: drawer.progress,
    origin: Math.round(dragStart),
    velocity: -velocity,
    extent: travel,
    min: 0,
    max: 1
  })
  settle(target >= 1 ? 1 : 0, -velocity)
}

/**
 * The system back gesture, through the back-surface registry (`back.ts`): `begin` holds the
 * drawer where it is, `progress` follows the finger (the drawer slides out as the gesture
 * advances), `commit` finishes the dismissal with the spring, `cancel` springs it back in. A
 * plain back press arrives as a bare `commit`.
 */
export const drawerBackHandle = {
  begin(): boolean {
    if (drawerStore.get().phase === 'closed') return false
    return beginDrawerDrag()
  },
  progress(backProgress: number): void {
    const drawer = drawerStore.get()
    if (drawer.phase === 'closed') return
    if (drawer.phase !== 'dragging' && !beginDrawerDrag()) return
    const progress = 1 - Math.min(1, Math.max(0, backProgress))
    drawerStore.set({ progress })
  },
  commit(): void {
    if (drawerStore.get().phase === 'closed') return
    if (drawerStore.get().phase === 'settling') spring.stop()
    settle(0)
  },
  cancel(): void {
    if (drawerStore.get().phase === 'closed') return
    if (drawerStore.get().phase === 'settling') spring.stop()
    settle(1)
  }
}

const flags = globalThis as unknown as { __zenDrawerWired?: boolean }
if (!flags.__zenDrawerWired) {
  flags.__zenDrawerWired = true
  // The drawer is a back surface for as long as it is up: registered when it opens (on top of
  // the overview it slides over), taken off once it has gone.
  let popBackSurface: (() => void) | null = null
  drawerStore.subscribe(() => {
    const open = drawerStore.get().phase !== 'closed'
    if (open && !popBackSurface) {
      popBackSurface = pushBackSurface({
        name: 'spaces-drawer',
        onStart: () => void drawerBackHandle.begin(),
        onProgress: drawerBackHandle.progress,
        onCommit: drawerBackHandle.commit,
        onCancel: drawerBackHandle.cancel
      })
    } else if (!open && popBackSurface) {
      popBackSurface()
      popBackSurface = null
    }
  })
  // Something else took the drawer down (an overlay or the URL bar opened over it).
  uiStore.subscribe(() => {
    if (!uiStore.get().drawerOpen && drawerStore.get().phase !== 'closed') {
      spring.stop()
      drawerStore.set(CLOSED)
    }
  })
}
