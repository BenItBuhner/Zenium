import { run } from '@renderer/lib/api'
import { abortPull, dispatchPullEvent, PULL_THRESHOLD, pullTravelFor } from '@renderer/lib/pull'
import { Download, Smartphone, Star } from 'lucide-react'
import { activeTab } from '@renderer/lib/selectors'
import {
  browserStore,
  closeMenu,
  closeOverlay,
  dismissBanner,
  dismissToast,
  forgetBanner,
  forgetToast,
  openOverlay,
  openZoom,
  pushToast,
  showBanner,
  uiStore
} from '@renderer/lib/ui'
import type { HostGlobal } from './boot'
import { parsePreviewSpec } from './previewSpec'

/**
 * Chrome states selectable from outside the preview host (`npm run dev:android`), so screenshots
 * and quick checks need no tapping through the menus. A state is a query string (see
 * `parsePreviewSpec`): `idle`, `overlay=<kind>` (history, bookmarks, downloads, settings, addons, …;
 * `section=<id>` picks a Settings section, `show=<text>` scrolls the row with that text into
 * view), `menu=app` (the app menu sheet; `show=<text>` scrolls an item into view), `find=<text>`
 * (the find bar with that text typed), `pull=<n>` (the page held pulled down at n percent of the
 * refresh threshold; `pull=refresh` lets go past it), `zoom=<factor>` (the page zoom sheet at
 * that factor), `error=<code>` (the active tab's load failed with that Chromium `net::` code,
 * `url=<target>` naming the URL that failed: the zen://error page is up) or the message surfaces
 * and the load bar: `toast=<text>&action=<label>`, `banners=<n>`, `progress=<0…1>`. It comes in
 * as the URL hash,
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
    uiStore.set({ findOpen: false, findTabId: null, zoomTabId: null })
    abortPull()
    clearMessages(tab?.loading ? tab.id : null)

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
      run('app.menu', {})
    } else if (target.kind === 'zoom' && tab) {
      if (target.factor !== null) run('tab.setZoomFactor', { tabId: tab.id, factor: target.factor })
      openZoom(tab.id)
      requestAnimationFrame(() => done(spec))
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
    } else if (target.kind === 'error' && tab) {
      failLoad(tab.id, target.code, target.url ?? tab.url)
      requestAnimationFrame(() => done(spec))
    } else if (target.kind === 'messages') {
      showMessages(target, tab?.id ?? null)
      done(spec)
    } else {
      done(spec)
    }
  })
}

/**
 * The load of `url` in the tab failed with `code`, as the host would report it (`failLoad` in
 * `views.ts`): the core answers with the zen://error page for that code, in the tab's frame.
 */
function failLoad(tabId: string, code: number, url: string): void {
  const host = (window as unknown as { __zenHost: HostGlobal }).__zenHost
  host.viewEvent(tabId, 'failLoad', JSON.stringify({ code, description: '', url }))
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

const SAMPLE_BANNERS = [
  {
    title: 'Add Zenium to your home screen',
    detail: 'Open pages in a window of their own, without the address bar.',
    icon: Smartphone,
    action: 'Install'
  },
  {
    title: 'Make Zenium your default browser',
    detail: 'Links from other apps will open here.',
    icon: Star,
    action: 'Make default'
  },
  { title: 'Download finished', detail: 'zenium-0.3.7.apk · 84 MB', icon: Download, action: 'Open' }
]

/** Put up the requested messages (all at once: the springs run, the driver waits for them). */
function showMessages(
  target: Extract<ReturnType<typeof parsePreviewSpec>, { kind: 'messages' }>,
  tabId: string | null
): void {
  for (let i = 0; i < target.banners; i++) {
    const sample = SAMPLE_BANNERS[i % SAMPLE_BANNERS.length]
    showBanner({
      title: sample.title,
      detail: sample.detail,
      icon: sample.icon,
      action: { label: sample.action, onPick: () => undefined },
      key: `preview-${i}`
    })
  }
  if (target.toast) {
    pushToast(target.toast.message, target.toast.error ? 'error' : 'info', {
      action: target.toast.action
        ? { label: target.toast.action, onPick: () => undefined }
        : undefined,
      // A screenshot state stays put; the real clock is the unit tests' business.
      duration: 600_000
    })
  }
  if (target.progress !== null && tabId) {
    // Mid-load: the bar shows the tab loading and springs to the reported fraction; no page
    // finishes underneath because the preview host raises no `stopLoading` on its own.
    hostGlobal().viewEvent(tabId, 'startLoading', '')
    hostGlobal().viewEvent(tabId, 'progress', JSON.stringify({ progress: target.progress }))
  }
}

/**
 * Every message off at once, and the load a previous `progress` state left running on
 * `loadingTabId` finished, so the next state starts clean.
 */
function clearMessages(loadingTabId: string | null): void {
  const ui = uiStore.get()
  for (const t of ui.toasts) {
    dismissToast(t.id)
    forgetToast(t.id)
  }
  for (const b of ui.banners) {
    dismissBanner(b.id)
    forgetBanner(b.id)
  }
  if (loadingTabId) hostGlobal().viewEvent(loadingTabId, 'stopLoading', '{}')
}

function hostGlobal(): { viewEvent(tabId: string, name: string, json: string): void } {
  return (window as unknown as { __zenHost: ReturnType<typeof hostGlobal> }).__zenHost
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
