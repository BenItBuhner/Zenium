import type { Rect, WindowChrome } from '../shared/types'
import type { WindowOpenDisposition } from './platform'
import { isNavigableUrl } from '../shared/url'

/** Default outer size for a toolbar-only window when the page did not ask for one. */
export const DEFAULT_POPUP_WIDTH = 720
export const DEFAULT_POPUP_HEIGHT = 640

export interface WindowOpenFeatures {
  width: number | null
  height: number | null
  left: number | null
  top: number | null
  popup: boolean
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
  width: null,
  height: null,
  left: null,
  top: null,
  popup: false
}

/**
 * Chromium's `window.open` features string (`width=500,height=400,popup=yes`) plus the same
 * tokens Electron forwards from `setWindowOpenHandler`.
 */
export function parseWindowOpenFeatures(features: string): WindowOpenFeatures {
  const out: WindowOpenFeatures = { ...EMPTY_FEATURES }
  if (!features) return out
  for (const part of features.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim().toLowerCase()
    const raw = eq === -1 ? 'yes' : trimmed.slice(eq + 1).trim()
    const flag = raw === '' || raw === 'yes' || raw === 'true' || raw === '1'
    const n = Number(raw)
    if (key === 'popup') out.popup = flag
    else if (key === 'width' && Number.isFinite(n) && n > 0) out.width = Math.round(n)
    else if (key === 'height' && Number.isFinite(n) && n > 0) out.height = Math.round(n)
    else if (key === 'left' && Number.isFinite(n)) out.left = Math.round(n)
    else if (key === 'top' && Number.isFinite(n)) out.top = Math.round(n)
  }
  return out
}

/** Width, height or an explicit `popup` token → toolbar-only chrome at that size. */
export function isSizedPopup(features: WindowOpenFeatures): boolean {
  return features.popup || features.width !== null || features.height !== null
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
 * How a page's `window.open` / Shift+click / `target=_blank` should be honoured. The host always
 * denies Chromium's own window: a `window` plan is a real Zenium window, a `tab` plan is a tab
 * in the opener's window.
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
    const popup = isSizedPopup(parsed)
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
