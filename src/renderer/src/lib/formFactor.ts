import { createStore } from './store'

/**
 * How the chrome should lay itself out. Derived from the window, not from the platform: a phone
 * held sideways or a Samsung DeX session gets the desktop layout, a narrow window on a laptop
 * gets the phone one.
 *
 *  - `phone`   – width < 600 CSS px: bottom bar, sidebar in a drawer, sheets instead of popovers.
 *  - `tablet`  – ≥ 600 px with a coarse pointer: desktop layout with touch-sized controls.
 *  - `desktop` – everything else.
 */
export type FormFactor = 'phone' | 'tablet' | 'desktop'

export interface ViewportInfo {
  formFactor: FormFactor
  width: number
  height: number
  /** Primary pointer is a finger (`pointer: coarse`). */
  coarse: boolean
  /** The primary pointer can hover (mouse / trackpad). */
  hover: boolean
}

const PHONE_MAX_WIDTH = 600

function compute(): ViewportInfo {
  const width = window.innerWidth
  const height = window.innerHeight
  const coarse = window.matchMedia('(pointer: coarse)').matches
  const hover = window.matchMedia('(hover: hover)').matches
  const formFactor: FormFactor = width < PHONE_MAX_WIDTH ? 'phone' : coarse ? 'tablet' : 'desktop'
  return { formFactor, width, height, coarse, hover }
}

export const viewportStore = createStore<ViewportInfo>(compute(), 'viewport')

function refresh(): void {
  const next = compute()
  const prev = viewportStore.get()
  if (
    prev.formFactor !== next.formFactor ||
    prev.width !== next.width ||
    prev.height !== next.height ||
    prev.coarse !== next.coarse ||
    prev.hover !== next.hover
  ) {
    viewportStore.set(next)
  }
  const root = document.documentElement
  root.dataset.formFactor = next.formFactor
  root.dataset.pointer = next.coarse ? 'coarse' : 'fine'
  root.dataset.hover = next.hover ? 'hover' : 'none'
}

const flags = globalThis as unknown as { __zenViewportWatched?: boolean }
if (!flags.__zenViewportWatched) {
  flags.__zenViewportWatched = true
  refresh()
  window.addEventListener('resize', refresh)
  for (const query of ['(pointer: coarse)', '(hover: hover)']) {
    window.matchMedia(query).addEventListener('change', refresh)
  }
}

export function useViewport(): ViewportInfo {
  return viewportStore.use()
}

export function isPhone(): boolean {
  return viewportStore.get().formFactor === 'phone'
}
