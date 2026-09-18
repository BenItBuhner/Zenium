import { run } from '@renderer/lib/api'
import { dispatchBackEvent, topBackSurface } from '@renderer/lib/back'
import { dismissOverview, openOverview } from '@renderer/lib/gestures/stage'
import { abortPull, dispatchPullEvent, PULL_THRESHOLD, pullTravelFor } from '@renderer/lib/pull'
import { Download, Smartphone, Star } from 'lucide-react'
import { installBannerShown, presentInstallBanner } from '@renderer/lib/installBanner'
import { isInternalPageUrl } from '@shared/internalPages'
import { activeTab } from '@renderer/lib/selectors'
import {
  browserStore,
  closeMenu,
  closeOverlay,
  closeUrlbar,
  dismissBanner,
  dismissToast,
  forgetBanner,
  forgetToast,
  openOverlay,
  openUrlbar,
  openZoom,
  pushToast,
  showBanner,
  uiStore
} from '@renderer/lib/ui'
import type { HostGlobal } from './boot'
import { PREVIEW_WEB_APP, postPreviewManifest } from './preview'
import { parsePreviewSpec, type PreviewStep, type PreviewWebAppSurface } from './previewSpec'

/** A pause between steps for a sheet to mount, slide in and settle before the next tap. */
const STEP_SETTLE_MS = 450

/** The back surfaces a page's sheets register (`settings-options:<row>`, `settings-confirm:<row>`, …). */
const SHEET_SURFACE = /^settings-(options|field|confirm|form|item):/
/** How long a dismissed sheet may take to leave (its motion) before the reset gives up on it. */
const SHEET_LEAVE_MS = 1500

/**
 * Chrome states selectable from outside the preview host (`npm run dev:android`), so screenshots
 * and quick checks need no tapping through the menus. A state is a query string (see
 * `parsePreviewSpec`): `idle`, `page=settings` (the Settings tab; `section=<id>` opens a section
 * over the landing, `search=<text>` types into the landing's search, `show=<text>` scrolls a row
 * into view, `then=tap:<text>;back;overview;urlbar` takes steps on the open page in order: a tap
 * on a row opens its sheet and a second tap stacks one, `back` closes the top sheet, `overview`
 * opens the tab overview, `urlbar` the pill for editing), `overlay=<kind>` (history, bookmarks,
 * downloads, addons, …: the chrome overlays a phone still has – Settings is not one, it is
 * `page=settings`; `show=<text>` scrolls the row with that text into view), `menu=app` (the app
 * menu sheet; `show=<text>` scrolls an item into
 * view), `find=<text>` (the find bar with that text typed), `pull=<n>` (the page held pulled down
 * at n percent of the refresh threshold; `pull=refresh` lets go past it), `zoom=<factor>` (the
 * page zoom sheet at that factor), `error=<code>` (the active tab's load failed with that
 * Chromium `net::` code, `url=<target>` naming the URL that failed: the zen://error page is up)
 * or the message surfaces and the load bar: `toast=<text>&action=<label>`, `banners=<n>`,
 * `progress=<0…1>`, or `webapp=<surface>` (an "Add to Home screen" surface on the active tab). It
 * comes in as the URL hash,
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
    // Every spec starts from idle so states do not stack: a pull in flight is put back at once
    // (a `cancel` would spring home, and the next pull would catch that spring part-way); the
    // pill's editor, the overview and the page's sheets a previous state's steps opened go too.
    closeOverlay()
    closeMenu()
    closeUrlbar()
    dismissOverview()
    uiStore.set({ findOpen: false, findTabId: null, zoomTabId: null, install: null, installBanner: null })
    abortPull()
    const state = browserStore.get().state
    const tab = state ? activeTab(state) : null
    clearMessages(tab?.loading ? tab.id : null)
    closeSheets(() => reach(spec))
  })
}

/**
 * Dismiss the page's open sheets, top first, the way a back would (a sheet leaves with its
 * motion and its surface goes with it), then `then`. Bounded: a sheet that will not leave is
 * not waited on for ever.
 */
function closeSheets(then: () => void, deadline = performance.now() + SHEET_LEAVE_MS): void {
  const top = topBackSurface()
  if (!top || !SHEET_SURFACE.test(top.name) || performance.now() > deadline) {
    then()
    return
  }
  dispatchBackEvent('commit')
  const gone = (): void => {
    if (topBackSurface() === top && performance.now() <= deadline) {
      setTimeout(gone, 50)
      return
    }
    closeSheets(then, deadline)
  }
  setTimeout(gone, 50)
}

/** Take the chrome, now idle, to the state `spec` names. */
function reach(spec: string): void {
  const state = browserStore.get().state
  const tab = state ? activeTab(state) : null
  const target = parsePreviewSpec(spec)

  if (target.kind === 'page') {
    // The page tab is the state: reached once the active tab is a page tab and the page has its
    // rows (its chunk loads on the first open), then a moment for its drill-in's slide to settle
    // before the search is typed, a row shown or a step taken.
    whenActiveTabIs(isInternalPageUrl, () => {
      whenPageRendered(() => {
        setTimeout(() => {
          // The landing keeps its query between states unless it is retyped: an empty one clears it.
          type('input[aria-label="Find in Settings"]', target.search ?? '')
          requestAnimationFrame(() => {
            // The page keeps where a previous state scrolled it; every state starts at the top.
            for (const el of document.querySelectorAll<HTMLElement>('[data-page] *')) {
              if (el.scrollTop > 0) el.scrollTop = 0
            }
            show(target.show)
            steps(target.then ?? [], () => done(spec))
          })
        }, 300)
      })
    })
    run('page.open', { id: target.page, section: target.section ?? null })
  } else if (target.kind === 'overlay') {
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
      if (target.text) type('input[aria-label="Find in page"]', target.text)
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
  } else if (target.kind === 'webapp' && tab) {
    applyWebApp(target.surface, tab.id, spec)
  } else {
    done(spec)
  }
}

/**
 * The load of `url` in the tab failed with `code`, as the host would report it (`failLoad` in
 * `views.ts`): the core answers with the zen://error page for that code, in the tab's frame.
 */
function failLoad(tabId: string, code: number, url: string): void {
  const host = (window as unknown as { __zenHost: HostGlobal }).__zenHost
  host.viewEvent(tabId, 'failLoad', JSON.stringify({ code, description: '', url }))
}

/** Type `text` into the first element matching `selector` the way a keyboard would. */
function type(selector: string, text: string): void {
  const input = document.querySelector<HTMLInputElement>(selector)
  if (!input || input.value === text) return
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Take `list` in order, a settle between steps, then `then`. */
function steps(list: readonly PreviewStep[], then: () => void): void {
  const [step, ...rest] = list
  if (!step) {
    then()
    return
  }
  takeStep(step)
  setTimeout(() => steps(rest, then), STEP_SETTLE_MS)
}

function takeStep(step: PreviewStep): void {
  const state = browserStore.get().state
  switch (step.kind) {
    case 'tap':
      tap(step.text)
      return
    case 'back':
      // One system back, committed: the top sheet, or the section over the landing, goes.
      dispatchBackEvent('start', { edge: 'left' })
      dispatchBackEvent('commit')
      return
    case 'overview':
      if (state) openOverview(state)
      return
    case 'urlbar': {
      const tab = state ? activeTab(state) : null
      void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, { attached: true })
    }
  }
}

/**
 * Press the first button whose accessible label or own text reads `text` – a row (its label is
 * the first line of its text), a sheet's option, a footer button – the way a finger would.
 */
function tap(text: string): void {
  const wanted = text.trim()
  const pressable = (el: Element | null | undefined): el is HTMLElement =>
    el instanceof HTMLElement && !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true'
  for (const el of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (!pressable(el)) continue
    if (el.getAttribute('aria-label')?.trim() === wanted || el.textContent?.trim() === wanted) {
      el.click()
      return
    }
  }
  // A row draws its label in a child beside its description: the nearest button up from the
  // text node that reads the label.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() !== wanted) continue
    const button = node.parentElement?.closest('button, [role="button"]')
    if (pressable(button)) {
      button.click()
      return
    }
  }
}

/** How long the page's first render (its chunk) is waited for before the state goes ahead anyway. */
const PAGE_RENDER_MS = 4000

/**
 * Runs `fn` once the page in the frame has drawn a row (a section's or the landing's), or after
 * {@link PAGE_RENDER_MS}: the page's code loads on its first open, and a search typed, a row
 * shown or a step taken before the rows exist would find nothing.
 */
function whenPageRendered(fn: () => void, deadline = performance.now() + PAGE_RENDER_MS): void {
  if (document.querySelector('[data-page] button') || performance.now() > deadline) {
    fn()
    return
  }
  setTimeout(() => whenPageRendered(fn, deadline), 50)
}

/** Runs `fn` once the active tab satisfies `test` (at once when it already does). */
function whenActiveTabIs(test: (url: string) => boolean, fn: () => void): void {
  const check = (): boolean => {
    const state = browserStore.get().state
    const tab = state ? activeTab(state) : null
    return tab !== null && test(tab.url)
  }
  if (check()) {
    fn()
    return
  }
  const unsubscribe = browserStore.subscribe(() => {
    if (!check()) return
    unsubscribe()
    fn()
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

/** The surface is up once the core's event has landed in the UI store; give up after this long. */
const SURFACE_TIMEOUT_MS = 5000

/**
 * Raise an "Add to Home screen" surface the way the app would: the demo manifest is posted for
 * the tab (or withdrawn, for the plain page's name-edit sheet), then the core is asked to open
 * the sheet or to pin. The banner is presented the way the core's event would be – the core
 * itself raises one only once a day per app, after enough visits – and its "Add" opens the
 * install sheet through the core like the real one.
 */
function applyWebApp(surface: PreviewWebAppSurface, tabId: string, spec: string): void {
  postPreviewManifest(tabId, surface !== 'name')
  const { manifest } = PREVIEW_WEB_APP
  switch (surface) {
    case 'install':
    case 'name':
      void run('webapp.openInstall', { tabId })
      whenStore(() => uiStore.get().install?.tabId === tabId, spec)
      return
    case 'banner':
      presentInstallBanner({
        tabId,
        name: manifest.short_name,
        origin: new URL(manifest.start_url, PREVIEW_WEB_APP.manifestUrl).host,
        icon: manifest.icons[0].src,
        tint: manifest.theme_color
      })
      whenStore(() => installBannerShown(tabId), spec)
      return
    case 'pinned':
      void run('webapp.pin', { tabId, title: manifest.short_name })
      whenStore(() => uiStore.get().toasts.some((t) => t.message.includes('Home screen')), spec)
      return
  }
}

/** Echo `spec` once `ready` holds (or the wait runs out, so a driver sees the state it got). */
function whenStore(ready: () => boolean, spec: string): void {
  if (ready()) {
    done(spec)
    return
  }
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    unsubscribe()
    clearTimeout(timer)
    done(spec)
  }
  const unsubscribe = uiStore.subscribe(() => {
    if (ready()) finish()
  })
  const timer = setTimeout(finish, SURFACE_TIMEOUT_MS)
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
