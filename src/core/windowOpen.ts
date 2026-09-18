import type { Rect, WindowChrome, WindowKind } from '../shared/types'
import type { WindowOpenDisposition } from './platform'
import { isNavigableUrl } from '../shared/url'

/** Default outer size for a toolbar-only window when the page did not ask for one. */
export const DEFAULT_POPUP_WIDTH = 720
export const DEFAULT_POPUP_HEIGHT = 640

/**
 * The tokens of a `window.open` features string the browser acts on: the size and position the
 * page asked for, plus the flags the HTML specification consults to decide whether the page
 * wants a popup (a bare window with a single toolbar row) rather than a tab.
 */
export interface WindowOpenFeatures {
  /** True for any non-empty features string – the specification treats it as a request. */
  requested: boolean
  width: number | null
  height: number | null
  left: number | null
  top: number | null
  /** Explicit `popup=…` token, when present. */
  popup: boolean | null
  location: boolean | null
  toolbar: boolean | null
  menubar: boolean | null
  resizable: boolean | null
  scrollbars: boolean | null
  status: boolean | null
}

export type WindowOpenAction = 'deny' | 'tab' | 'window'

export interface WindowOpenPlan {
  action: WindowOpenAction
  /** Meaningful when `action` is `window`. */
  chrome: WindowChrome
  /** Outer bounds when `action` is `window` and the page sized the popup; otherwise null. */
  bounds: Rect | null
  /** Meaningful when `action` is `tab`. */
  active: boolean
}

const EMPTY_FEATURES: WindowOpenFeatures = {
  requested: false,
  width: null,
  height: null,
  left: null,
  top: null,
  popup: null,
  location: null,
  toolbar: null,
  menubar: null,
  resizable: null,
  scrollbars: null,
  status: null
}

/** The specification's boolean feature parsing: empty, `yes`, `true` and non-zero numbers are on. */
function featureFlag(raw: string): boolean {
  const value = raw.trim().toLowerCase()
  if (value === '' || value === 'yes' || value === 'true') return true
  if (value === 'no' || value === 'false') return false
  const n = Number(value)
  return Number.isFinite(n) && n !== 0
}

/** Blink's separators: whitespace, `=` between a name and its value, `,` between features. */
function isFeatureSeparator(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '=' || c === ','
}

/** Blink's tokenizer: `name`, `name=value`, `name = value`; a `,` ends a feature without a value. */
function tokenizeFeatures(features: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  const n = features.length
  let i = 0
  while (i < n) {
    while (i < n && isFeatureSeparator(features[i])) i++
    const keyStart = i
    while (i < n && !isFeatureSeparator(features[i])) i++
    const key = features.slice(keyStart, i).toLowerCase()
    while (i < n && features[i] !== ',' && isFeatureSeparator(features[i])) i++
    let value = ''
    if (i < n && features[i] !== ',') {
      const valueStart = i
      while (i < n && !isFeatureSeparator(features[i])) i++
      value = features.slice(valueStart, i)
    }
    if (key) pairs.push([key, value])
  }
  return pairs
}

/**
 * Chromium's `window.open` features string (`width=500,height=400,popup=yes`), which Electron
 * forwards untouched from `setWindowOpenHandler`, read the way Blink reads it.
 */
export function parseWindowOpenFeatures(features: string): WindowOpenFeatures {
  const out: WindowOpenFeatures = { ...EMPTY_FEATURES }
  if (!features.trim()) return out
  out.requested = true
  for (const [key, raw] of tokenizeFeatures(features)) {
    const n = Number(raw)
    switch (key) {
      case 'width':
      case 'innerwidth':
        if (Number.isFinite(n) && n > 0) out.width = Math.round(n)
        break
      case 'height':
      case 'innerheight':
        if (Number.isFinite(n) && n > 0) out.height = Math.round(n)
        break
      case 'left':
      case 'screenx':
        if (Number.isFinite(n)) out.left = Math.round(n)
        break
      case 'top':
      case 'screeny':
        if (Number.isFinite(n)) out.top = Math.round(n)
        break
      case 'popup':
        out.popup = featureFlag(raw)
        break
      case 'location':
      case 'toolbar':
      case 'menubar':
      case 'resizable':
      case 'scrollbars':
      case 'status':
        out[key] = featureFlag(raw)
        break
    }
  }
  return out
}

/**
 * HTML's "check if a popup window is requested": no features means a tab; an explicit `popup`
 * decides; otherwise a window missing the location or toolbar, the menu bar, resizing,
 * scrollbars or the status bar is a popup. Chromium opens exactly these as `NEW_POPUP`.
 */
export function isPopupRequested(features: WindowOpenFeatures): boolean {
  if (!features.requested) return false
  if (features.popup !== null) return features.popup
  if (!features.location && !features.toolbar) return true
  if (!features.menubar) return true
  if (features.resizable === false) return true
  if (!features.scrollbars) return true
  return !features.status
}

function popupBounds(features: WindowOpenFeatures): Rect {
  return {
    x: features.left ?? 80,
    y: features.top ?? 80,
    width: features.width ?? DEFAULT_POPUP_WIDTH,
    height: features.height ?? DEFAULT_POPUP_HEIGHT
  }
}

/**
 * URLs a page may open in a new tab or window: what a tab can show, plus `mailto:` links, whose
 * navigation the host then hands to the mail client through the external-app prompt.
 */
export function isOpenableUrl(url: string): boolean {
  return isNavigableUrl(url) || url.startsWith('mailto:')
}

/**
 * How a page's `window.open` / Shift+click / `target=_blank` should be honoured. The host never
 * shows Chromium's own bare window: a `window` plan is a real Zenium window (toolbar-only chrome
 * for a popup, the full chrome for Shift+click's unsized new window), a `tab` plan is a tab in
 * the opener's window. Electron reports both `NEW_WINDOW` and `NEW_POPUP` as `new-window`, so
 * the features string tells the two apart.
 */
export function planWindowOpen(
  url: string,
  disposition: WindowOpenDisposition,
  features = ''
): WindowOpenPlan {
  if (!isOpenableUrl(url)) {
    return { action: 'deny', chrome: 'full', bounds: null, active: false }
  }
  if (disposition === 'new-window') {
    const parsed = parseWindowOpenFeatures(features)
    const popup = isPopupRequested(parsed)
    return {
      action: 'window',
      chrome: popup ? 'popup' : 'full',
      bounds: popup ? popupBounds(parsed) : null,
      active: true
    }
  }
  return {
    action: 'tab',
    chrome: 'full',
    bounds: null,
    active: disposition !== 'background-tab'
  }
}

/**
 * Which kind of Zenium window receives a page's new window: private openers stay private, a
 * popup and anything opened from a blank window are temporary (unsynced) windows, and
 * Shift+click from a normal window opens another synced window.
 */
export function openedWindowKind(owner: WindowKind, chrome: WindowChrome): WindowKind {
  if (owner === 'private') return 'private'
  if (chrome === 'popup' || owner === 'unsynced') return 'unsynced'
  return 'synced'
}
