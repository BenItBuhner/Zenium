/**
 * The `display-mode` media feature for pages whose engine cannot tell one window from another
 * (Electron reports `browser` everywhere; Chrome's app windows answer `standalone` and any
 * fullscreen window `fullscreen`, MW-23). The mode is the browser's to know: `displayModeFor`
 * derives it from the window a page lives in, the preload asks for it synchronously at document
 * start and `installDisplayModeShim` runs in the page's own world, wrapping `matchMedia` so the
 * `(display-mode: …)` features of a query answer with Zenium's mode while the engine keeps
 * evaluating everything else in it. Later changes (the window going fullscreen, the page moving
 * to another window) arrive over a DOM event and fire `change` on the lists a page listens to.
 *
 * CSS `@media (display-mode: …)` rules stay with the engine's answer: only script sees the mode.
 */

import type { WindowChrome } from './types'

/** The modes Zenium reports (Chrome's `minimal-ui` and `window-controls-overlay` never apply). */
export type DisplayMode = 'browser' | 'standalone' | 'fullscreen'

/** Synchronous ask of the main process at document start: the page's current mode. */
export const DISPLAY_MODE_CHANNEL = 'zen:display-mode'

/** DOM event the isolated world dispatches on `document` with the new mode in `detail`. */
export const DISPLAY_MODE_EVENT = 'zen-display-mode'

/**
 * Chrome's answer for a page: `fullscreen` while its window is fullscreen (the window's own F11
 * fullscreen or the page's element fullscreen, which takes the window along), `standalone` in
 * an app window, `browser` in a browser window or popup.
 */
export function displayModeFor(
  win: { chrome: WindowChrome; fullscreen: boolean; htmlFullscreenTabId: string | null },
  tabId: string
): DisplayMode {
  if (win.fullscreen || win.htmlFullscreenTabId === tabId) return 'fullscreen'
  return win.chrome === 'app' ? 'standalone' : 'browser'
}

/** A `(display-mode: X)` feature; case-insensitive like the engine's own parsing. */
const DISPLAY_MODE_FEATURE = /\(\s*display-mode\s*:\s*([a-z-]+)\s*\)/gi
/** Stands in for a matching feature: true in every viewport. */
export const FEATURE_MATCHES = '(min-width: 0px)'
/** Stands in for a non-matching feature: a viewport is one orientation, never both. */
export const FEATURE_MISMATCHES = '((orientation: landscape) and (orientation: portrait))'

/**
 * Rewrite a media query so the engine can evaluate it: each `display-mode` feature becomes an
 * always-true or always-false feature according to `mode`. Queries without one are unchanged.
 */
export function rewriteDisplayModeQuery(query: string, mode: string): string {
  return query.replace(DISPLAY_MODE_FEATURE, (_feature, value: string) =>
    value.toLowerCase() === mode ? FEATURE_MATCHES : FEATURE_MISMATCHES
  )
}

/**
 * Runs in the page's main world (the function is serialised, so it is self-contained and takes
 * everything it needs as arguments; nothing here may throw into the page). `initial` is the
 * mode at document start, `eventName` the DOM event later modes arrive on.
 */
export function installDisplayModeShim(initial: string, eventName: string): void {
  const win = window
  const doc = document
  const native = win.matchMedia
  if (typeof native !== 'function') return
  const feature = /\(\s*display-mode\s*:\s*([a-z-]+)\s*\)/gi
  const matchesAlways = '(min-width: 0px)'
  const matchesNever = '((orientation: landscape) and (orientation: portrait))'
  let mode = initial
  const rewrite = (query: string): string =>
    query.replace(feature, (_feature, value: string) =>
      value.toLowerCase() === mode ? matchesAlways : matchesNever
    )
  /** Lists somebody listens to: told when the mode changes (the rest re-evaluate on read). */
  const listened = new Set<ZenMediaQueryList>()

  // Constructor-assigned members only: the function is serialised into the page's world, where
  // no compiler helper for class fields exists.
  class ZenMediaQueryList extends EventTarget {
    readonly media: string
    private inner: MediaQueryList
    private innerMode: string
    private last: boolean
    private handler: ((event: MediaQueryListEvent) => unknown) | null

    constructor(query: string) {
      super()
      this.media = query
      this.innerMode = mode
      this.inner = native.call(win, rewrite(query))
      this.last = this.inner.matches
      this.handler = null
      this.inner.addEventListener('change', () => this.refresh())
    }

    get matches(): boolean {
      if (this.innerMode !== mode) {
        this.innerMode = mode
        this.inner = native.call(win, rewrite(this.media))
        this.inner.addEventListener('change', () => this.refresh())
      }
      return this.inner.matches
    }

    get onchange(): ((event: MediaQueryListEvent) => unknown) | null {
      return this.handler
    }

    set onchange(value: ((event: MediaQueryListEvent) => unknown) | null) {
      this.handler = typeof value === 'function' ? value : null
      if (this.handler) listened.add(this)
    }

    /** The engine's list changed (a viewport feature) or Zenium's mode did: tell the listeners. */
    refresh(): void {
      const now = this.matches
      if (now === this.last) return
      this.last = now
      const event = new MediaQueryListEvent('change', { matches: now, media: this.media })
      this.dispatchEvent(event)
      if (this.handler) {
        try {
          this.handler.call(this, event)
        } catch {
          /* a listener's error is its own */
        }
      }
    }

    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ): void {
      super.addEventListener(type, listener, options)
      if (type === 'change' && listener) listened.add(this)
    }

    /** The legacy pair pages still use (`addListener` / `removeListener`). */
    addListener(listener: ((event: MediaQueryListEvent) => unknown) | null): void {
      if (listener) this.addEventListener('change', listener as EventListener)
    }

    removeListener(listener: ((event: MediaQueryListEvent) => unknown) | null): void {
      if (listener) this.removeEventListener('change', listener as EventListener)
    }
  }

  const matchMedia = function (this: unknown, query: string): MediaQueryList {
    const text = String(query)
    feature.lastIndex = 0
    if (!feature.test(text)) return native.call(win, text)
    return new ZenMediaQueryList(text) as unknown as MediaQueryList
  }
  try {
    Object.defineProperty(win, 'matchMedia', {
      configurable: true,
      writable: true,
      value: matchMedia
    })
  } catch {
    return
  }

  doc.addEventListener(eventName, (e) => {
    try {
      const next = String((e as CustomEvent<unknown>).detail ?? '')
      if (!next || next === mode) return
      mode = next
      for (const list of listened) list.refresh()
    } catch {
      /* never let the shim throw into the page */
    }
  })
}
