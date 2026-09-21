import { useEffect } from 'react'
import { classifyViewport, touchLayout, type ViewportMetrics } from '@shared/formFactor'
import type { FormFactor, WindowChrome } from '@shared/types'
import { run } from './api'
import { browserStore } from './browserStore'
import { createStore } from './store'

export type { FormFactor }

/**
 * How the chrome should lay itself out. Derived from the window and its pointer, not from the
 * platform (see `classifyViewport`): a Samsung DeX session gets the desktop layout, a narrow
 * window on a laptop gets the phone one, and a phone stays a phone whichever way it is held.
 *
 *  - `phone`   – bottom bar, sidebar in a drawer, sheets instead of popovers.
 *  - `tablet`  – a touch screen 600 px or more on its short side: the vertical sidebar as the tab
 *                surface, sized for a finger, under a toolbar row of its own (`TabletShell`).
 *  - `desktop` – everything else.
 *
 * Toolbar-only popup windows (`window.open` with a size) are the exception: a page-sized popup
 * on a laptop is not a phone, so they keep the desktop layout at any width.
 */
export interface ViewportInfo extends ViewportMetrics {
  formFactor: FormFactor
}

/**
 * `classifyViewport`, except that a popup or app window never becomes a phone however small it
 * is, and neither does the autofill picker's document (`index.html?surface=autofill`, a small
 * view floated over the page by the desktop host): it draws desktop rows whatever its size.
 */
export function formFactorFor(
  metrics: ViewportMetrics,
  chrome: WindowChrome | null,
  surface: string | null = chromeSurface()
): FormFactor {
  if (chrome === 'popup' || chrome === 'app' || surface === 'autofill')
    return metrics.coarse ? 'tablet' : 'desktop'
  return classifyViewport(metrics)
}

/**
 * Loaded without a viewport (a pure-logic test importing a module that imports this one, with
 * no window or a stub of one without media queries): a desktop, unwatched.
 */
const NO_WINDOW: ViewportInfo = {
  formFactor: 'desktop',
  width: 0,
  height: 0,
  coarse: false,
  hover: true
}

function hasViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    typeof document !== 'undefined'
  )
}

/**
 * Which chrome document this is: null for a window's chrome, `autofill` for the picker's popup
 * surface (`?surface=autofill`, see `AutofillSurface`).
 */
export function chromeSurface(): string | null {
  if (typeof location === 'undefined') return null
  return new URLSearchParams(location.search).get('surface')
}

const FORM_FACTORS: readonly FormFactor[] = ['phone', 'tablet', 'desktop']

/**
 * A layout forced through the chrome document's URL (`index.html?formFactor=tablet`): the
 * preview host and the screenshot scripts show a layout at any window size and with any pointer,
 * so a tablet's chrome can be looked at in a desktop browser. A real host never passes it.
 */
export function forcedFormFactor(search: string | null = chromeSearch()): FormFactor | null {
  if (!search) return null
  const value = new URLSearchParams(search).get('formFactor')
  return (FORM_FACTORS as readonly string[]).includes(value ?? '') ? (value as FormFactor) : null
}

function chromeSearch(): string | null {
  return typeof location === 'undefined' ? null : location.search
}

function compute(): ViewportInfo {
  if (!hasViewport()) return NO_WINDOW
  const width = window.innerWidth
  const height = window.innerHeight
  const forced = forcedFormFactor()
  if (forced) {
    // The pointer follows the forced layout: a phone or tablet is a finger, a desktop a mouse.
    const touch = forced !== 'desktop'
    return { formFactor: forced, width, height, coarse: touch, hover: !touch }
  }
  const hover = window.matchMedia('(hover: hover)').matches
  // Android's WebView reports `pointer: fine` on plain touch screens; a touch digitiser without
  // hover is a finger. A mouse (DeX, tablet trackpad) brings hover back and gets desktop sizing.
  const coarse =
    window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !hover)
  const metrics = { width, height, coarse, hover }
  const chrome = browserStore.get().state?.window?.chrome ?? null
  return { formFactor: formFactorFor(metrics, chrome), ...metrics }
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
if (!flags.__zenViewportWatched && hasViewport()) {
  flags.__zenViewportWatched = true
  refresh()
  window.addEventListener('resize', refresh)
  for (const query of ['(pointer: coarse)', '(hover: hover)']) {
    window.matchMedia(query).addEventListener('change', refresh)
  }
  // Subscribed at import, ahead of any React subscription: the first snapshot re-derives the
  // layout before the shell renders, so a popup window never flashes the phone chrome.
  browserStore.subscribe(refresh)
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

/**
 * The layouts a finger drives – the phone's and the tablet's (`touchLayout`): they share the
 * chrome the desktop has no use for (the overview, the docked read-aloud player, the private
 * theme on the window while a private tab is in view), while each keeps its own composition.
 */
export function isTouchLayout(formFactor: FormFactor = viewportStore.get().formFactor): boolean {
  return touchLayout(formFactor)
}
