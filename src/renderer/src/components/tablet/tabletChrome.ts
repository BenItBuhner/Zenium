import { pushBackSurface } from '@renderer/lib/back'
import { SPRING_GENTLE, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { createStore } from '@renderer/lib/store'

/**
 * The tablet chrome's numbers and its transient state (TABLET-01, TABLET-08).
 *
 * The toolbar row's height: the §9.3 tablet icon button (40) in a row padded 8 above and below,
 * so the row is as tall as the phone's bar band (`--zen-phone-bar`, 56) and the overview keeps
 * the same band clear at the top whichever touch shell draws it.
 */
export const TABLET_TOOLBAR_HEIGHT = 56

/**
 * Below this window width the expanded sidebar has no room beside a page: the rail (56) stays
 * docked and the expanded sidebar floats over the page as a drawer (the phone's Spaces drawer
 * is the same idea). A 10-inch tablet's portrait (800) keeps the docked sidebar; a split-screen
 * half of it (600) gets the rail and the drawer.
 */
export const TABLET_DRAWER_BELOW = 720

/** Whether the expanded sidebar floats as a drawer at this window width. */
export function tabletDrawerLayout(width: number): boolean {
  return width < TABLET_DRAWER_BELOW
}

// ---------------------------------------------------------------------------
// The drawer: the expanded sidebar over the page in a narrow window
// ---------------------------------------------------------------------------

export type TabletDrawerPhase = 'closed' | 'dragging' | 'settling' | 'open'

export interface TabletDrawerState {
  phase: TabletDrawerPhase
  /** 0 = off screen … 1 = fully in. */
  progress: number
}

const CLOSED: TabletDrawerState = { phase: 'closed', progress: 0 }

/**
 * What the tablet shell keeps outside its components, so a re-render or a shell swap never
 * loses it: how far in the drawer is, on a 0 (off screen) … 1 (open) track that a spring or the
 * system's predictive back gesture drives. The docked sidebar's expanded / rail state is the
 * `sidebarExpanded` setting, the core's.
 */
export const tabletDrawerStore = createStore<TabletDrawerState>(CLOSED, 'tablet-drawer')

/** How far the drawer travels, in px – its width. Set by the drawer once it has measured itself. */
let travel = 240

export function setTabletDrawerTravel(px: number): void {
  if (px > 0) travel = px
}

const spring = new SpringAnimation(
  SPRING_GENTLE,
  (x) => {
    if (tabletDrawerStore.get().phase !== 'settling') return
    tabletDrawerStore.set({ progress: x / travel })
  },
  (x) => {
    if (tabletDrawerStore.get().phase !== 'settling') return
    if (Math.round(x / travel) >= 1) tabletDrawerStore.set({ phase: 'open', progress: 1 })
    else tabletDrawerStore.set(CLOSED)
  }
)

function settle(target: 0 | 1): void {
  const { progress } = tabletDrawerStore.get()
  tabletDrawerStore.set({ phase: 'settling' })
  // In on the gentle spring; out faster, as a sheet leaves.
  spring.start(progress * travel, 0, target * travel, target ? SPRING_GENTLE : SPRING_SNAPPY)
}

/** Slide the expanded sidebar in over the page (the toolbar's toggle, a swipe on the rail). */
export function openTabletDrawer(): void {
  const { phase } = tabletDrawerStore.get()
  if (phase === 'open') return
  if (phase === 'settling') spring.stop()
  settle(1)
}

/** Slide the drawer out (a tap on the scrim, a tab picked, a swipe towards the edge, back). */
export function closeTabletDrawer(): void {
  const { phase } = tabletDrawerStore.get()
  if (phase === 'closed') return
  if (phase === 'settling') spring.stop()
  settle(0)
}

/** Drop the drawer without motion (the layout changed under it: room for a docked sidebar). */
export function dismissTabletDrawer(): void {
  if (tabletDrawerStore.get().phase === 'closed') return
  spring.stop()
  tabletDrawerStore.set(CLOSED)
}

export function tabletDrawerOpen(): boolean {
  return tabletDrawerStore.get().phase !== 'closed'
}

/**
 * The system back gesture, through the back-surface registry (`lib/back.ts`): the drawer
 * slides out as the gesture advances, commit finishes the dismissal on the spring, cancel
 * springs it back in. A plain back press arrives as a bare commit.
 */
const backHandle = {
  progress(backProgress: number): void {
    const { phase } = tabletDrawerStore.get()
    if (phase === 'closed') return
    if (phase === 'settling') spring.stop()
    tabletDrawerStore.set({
      phase: 'dragging',
      progress: 1 - Math.min(1, Math.max(0, backProgress))
    })
  },
  commit(): void {
    if (tabletDrawerStore.get().phase === 'closed') return
    if (tabletDrawerStore.get().phase === 'settling') spring.stop()
    settle(0)
  },
  cancel(): void {
    if (tabletDrawerStore.get().phase === 'closed') return
    if (tabletDrawerStore.get().phase === 'settling') spring.stop()
    settle(1)
  }
}

const flags = globalThis as unknown as { __zenTabletDrawerWired?: boolean }
if (!flags.__zenTabletDrawerWired) {
  flags.__zenTabletDrawerWired = true
  // The drawer is a back surface for as long as it is up: registered as it opens, taken off
  // once it has gone.
  let popBackSurface: (() => void) | null = null
  tabletDrawerStore.subscribe(() => {
    const open = tabletDrawerStore.get().phase !== 'closed'
    if (open && !popBackSurface) {
      popBackSurface = pushBackSurface({
        name: 'tablet-drawer',
        onProgress: backHandle.progress,
        onCommit: backHandle.commit,
        onCancel: backHandle.cancel
      })
    } else if (!open && popBackSurface) {
      popBackSurface()
      popBackSurface = null
    }
  })
}
