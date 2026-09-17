import { useEffect } from 'react'
import { classifyViewport, type ViewportMetrics } from '@shared/formFactor'
import type { FormFactor } from '@shared/types'
import { run } from './api'
import { createStore } from './store'

export type { FormFactor }

/**
 * How the chrome should lay itself out. Derived from the window and its pointer, not from the
 * platform (see `classifyViewport`): a Samsung DeX session gets the desktop layout, a narrow
 * window on a laptop gets the phone one, and a phone stays a phone whichever way it is held.
 *
 *  - `phone`   – bottom bar, sidebar in a drawer, sheets instead of popovers.
 *  - `tablet`  – a touch screen with room for the desktop layout, with touch-sized controls.
 *  - `desktop` – everything else.
 */
export interface ViewportInfo extends ViewportMetrics {
  formFactor: FormFactor
}

function compute(): ViewportInfo {
  const width = window.innerWidth
  const height = window.innerHeight
  const hover = window.matchMedia('(hover: hover)').matches
  // Android's WebView reports `pointer: fine` on plain touch screens; a touch digitiser without
  // hover is a finger. A mouse (DeX, tablet trackpad) brings hover back and gets desktop sizing.
  const coarse =
    window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !hover)
  const metrics = { width, height, coarse, hover }
  return { formFactor: classifyViewport(metrics), ...metrics }
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

/**
 * Tell the core which layout the chrome shows: it builds the app menu and the command list for
 * it. Sent once the chrome is up (the API exists by then) and again whenever the class changes.
 */
export function useFormFactorReport(formFactor: FormFactor): void {
  useEffect(() => {
    run('window.formFactor', { formFactor })
  }, [formFactor])
}

export function isPhone(): boolean {
  return viewportStore.get().formFactor === 'phone'
}
