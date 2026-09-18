import { run } from '@renderer/lib/api'
import { abortPull, dispatchPullEvent, PULL_THRESHOLD, pullTravelFor } from '@renderer/lib/pull'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore, closeMenu, closeOverlay, openOverlay, uiStore } from '@renderer/lib/ui'
import { parsePreviewSpec } from './previewSpec'

/**
 * Chrome states selectable from outside the preview host (`npm run dev:android`), so screenshots
 * and quick checks need no tapping through the menus. A state is a query string (see
 * `parsePreviewSpec`): `idle`, `overlay=<kind>` (history, bookmarks, downloads, settings, addons, …;
 * `section=<id>` picks a Settings section, `show=<text>` scrolls the row with that text into
 * view), `menu=app` (the app menu sheet; `show=<text>` scrolls an item into view), `find=<text>`
 * (the find bar with that text typed) or
 * `pull=<n>` (the page held pulled down at n percent of the refresh threshold; `pull=refresh` lets
 * go past it). It comes in as the URL hash,
 * `http://localhost:41734/#overlay=history`, or as `window.postMessage({ zenPreview: 'find=coffee' }, '*')`,
 * which also re-applies an unchanged state. Once applied it is echoed in `<html data-preview-state>`
 * so a driver can wait for it; `.github/scripts/android-preview-shots.mjs` is one.
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
    const target = parsePreviewSpec(spec)

    // Every spec starts from idle so states do not stack: a pull in flight is put back at once
    // (a `cancel` would spring home, and the next pull would catch that spring part-way).
    closeOverlay()
    closeMenu()
    uiStore.set({ findOpen: false, findTabId: null })
    abortPull()

    if (target.kind === 'overlay') {
      void openOverlay(target.overlay, tab?.id ?? null, null, null, target.section ?? null).then(
        () => {
          if (target.show) requestAnimationFrame(() => show(target.show))
          done(spec)
        }
      )
    } else if (target.kind === 'menu') {
      // The core answers with `menu.show`; the state is reached once the descriptor is in the store.
      const unsubscribe = uiStore.subscribe(() => {
        if (!uiStore.get().menu) return
        unsubscribe()
        // The sheet mounts on the next render; give it a frame before scrolling an item into view.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            show(target.show)
            done(spec)
          })
        )
      })
      run('app.menu', undefined)
    } else if (target.kind === 'find' && tab) {
      uiStore.set({ findOpen: true, findTabId: tab.id })
      // The bar mounts on the next render; type into it the way a keyboard would.
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('input[aria-label="Find in page"]')
        if (input && target.text) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setter?.call(input, target.text)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        done(spec)
      })
    } else if (target.kind === 'pull' && tab) {
      pull(tab.id, target.progress, target.released)
      requestAnimationFrame(() => done(spec))
    } else {
      done(spec)
    }
  })
}

/**
 * A finger's worth of pull events, as the host would send them (`lib/pull.ts`): down, one move
 * to the travel that puts the page at `progress` of the threshold, and – released – a lift there.
 */
function pull(tabId: string, progress: number, released: boolean): void {
  const time = performance.now()
  // The inverse mapping lands a hair under the threshold in floating point (71.999… for 1), which
  // reads as unarmed; at the threshold and past it, a hair of extra finger puts the page over it.
  const travel = pullTravelFor(progress * PULL_THRESHOLD) + (progress >= 1 ? 0.5 : 0)
  dispatchPullEvent(tabId, 'start', null)
  dispatchPullEvent(tabId, 'move', { travel, time })
  if (released) {
    dispatchPullEvent(tabId, 'move', { travel, time: time + 16 })
    dispatchPullEvent(tabId, 'release', { travel, time: time + 32 })
  }
}

/** Scroll the first element whose own text reads `text` to the middle of its scroller. */
function show(text: string | undefined): void {
  if (!text) return
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() === text && node.parentElement) {
      node.parentElement.scrollIntoView({ block: 'center' })
      return
    }
  }
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
