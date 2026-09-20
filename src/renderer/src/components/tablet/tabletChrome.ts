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
 * docked and the expanded sidebar floats over the page as a drawer (the phone's spaces drawer
 * is the same idea). A 10-inch tablet's portrait (800) keeps the docked sidebar; a split-screen
 * half of it (600) gets the rail and the drawer.
 */
export const TABLET_DRAWER_BELOW = 720

/**
 * What the tablet shell keeps outside its components, so a shell swap (a window resized across
 * the phone boundary and back, TABLET-08) or a re-render never loses it. `drawerOpen` is the
 * expanded sidebar floating over the page in a narrow window; the docked sidebar's expanded /
 * rail state is the `sidebarExpanded` setting, the core's.
 */
export const tabletStore = createStore<{ drawerOpen: boolean }>({ drawerOpen: false }, 'tablet')

export function openTabletDrawer(): void {
  if (!tabletStore.get().drawerOpen) tabletStore.set({ drawerOpen: true })
}

export function closeTabletDrawer(): void {
  if (tabletStore.get().drawerOpen) tabletStore.set({ drawerOpen: false })
}

/** Whether the expanded sidebar floats as a drawer at this window width. */
export function tabletDrawerLayout(width: number): boolean {
  return width < TABLET_DRAWER_BELOW
}
