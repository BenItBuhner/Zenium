import type { OverlayKind } from '@shared/types'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore, closeOverlay, openOverlay, uiStore } from '@renderer/lib/ui'

const OVERLAYS: readonly OverlayKind[] = [
  'settings',
  'history',
  'bookmarks',
  'downloads',
  'theme',
  'onboarding',
  'shortcuts',
  'space-editor',
  'boosts',
  'addons',
  'live-folder',
  'sync'
]

/**
 * Chrome states selectable from outside the preview host (`npm run dev:android`), so screenshots
 * and quick checks need no tapping through the menus. A state is a query string: `idle`,
 * `overlay=<kind>` (history, bookmarks, downloads, settings, addons, …) or `find=<text>` (the find
 * bar with that text typed). It comes in as the URL hash, `http://localhost:41734/#overlay=history`,
 * or as `window.postMessage({ zenPreview: 'find=coffee' }, '*')`, which also re-applies an unchanged
 * state. Once applied it is echoed in `<html data-preview-state>` so a driver can wait for it;
 * `.github/scripts/android-preview-shots.mjs` is one.
 */
export function installPreviewStates(): void {
  window.addEventListener('hashchange', () => apply(location.hash.slice(1)))
  window.addEventListener('message', (e: MessageEvent<unknown>) => {
    const data = e.data
    if (data && typeof data === 'object' && 'zenPreview' in data) {
      const spec = (data as { zenPreview: unknown }).zenPreview
      if (typeof spec === 'string') apply(spec)
    }
  })
  if (location.hash.length > 1) apply(location.hash.slice(1))
}

function apply(spec: string): void {
  whenReady(() => {
    const state = browserStore.get().state
    const tab = state ? activeTab(state) : null
    const params = new URLSearchParams(spec)
    const overlay = params.get('overlay')
    const find = params.get('find')

    // Every spec starts from idle so states do not stack.
    closeOverlay()
    uiStore.set({ findOpen: false, findTabId: null })

    if (overlay && (OVERLAYS as readonly string[]).includes(overlay)) {
      void openOverlay(overlay as OverlayKind, tab?.id ?? null).then(() => done(spec))
    } else if (find !== null && tab) {
      uiStore.set({ findOpen: true, findTabId: tab.id })
      // The bar mounts on the next render; type into it the way a keyboard would.
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('input[aria-label="Find in page"]')
        if (input && find) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setter?.call(input, find)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        done(spec)
      })
    } else {
      done(spec)
    }
  })
}

function done(spec: string): void {
  document.documentElement.dataset.previewState = spec
}

/** Runs `fn` once the browser state has arrived and the chrome has had a frame to render it. */
function whenReady(fn: () => void): void {
  if (browserStore.get().state) {
    requestAnimationFrame(fn)
    return
  }
  const unsubscribe = browserStore.subscribe(() => {
    if (!browserStore.get().state) return
    unsubscribe()
    requestAnimationFrame(fn)
  })
}
