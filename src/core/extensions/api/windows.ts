/**
 * The `chrome.windows` data model: Chrome's `Window` shape and the `QueryOptions` filters of
 * `windows.getAll` / `windows.get`. Pure; hosts fill the records from their own windows.
 */
import type { WindowChrome } from '../../../shared/types'
import type { ChromeTab } from './tabs'

export type ChromeWindowType = 'normal' | 'popup' | 'panel' | 'app' | 'devtools'

/**
 * Chrome's type for a browser window by the chrome it draws: a tab strip makes a `normal`
 * window; the toolbar-only window a sized `window.open` makes (Secure Shell's connection
 * dialog) is a `popup`, as Chrome reports its own; a standalone web app's window is an `app`.
 */
export function windowTypeForChrome(chrome: WindowChrome): ChromeWindowType {
  switch (chrome) {
    case 'popup':
      return 'popup'
    case 'app':
      return 'app'
    default:
      return 'normal'
  }
}
export type ChromeWindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen'

export interface ChromeWindow {
  id: number
  focused: boolean
  top?: number
  left?: number
  width?: number
  height?: number
  incognito: boolean
  type: ChromeWindowType
  state: ChromeWindowState
  alwaysOnTop: boolean
  tabs?: ChromeTab[]
}

export interface WindowQueryOptions {
  populate?: boolean
  windowTypes?: ChromeWindowType[]
}

/** `windowTypes` defaults to every type Chrome lists (`normal`, `popup`, `panel`, `app`). */
export function windowMatchesQuery(
  win: ChromeWindow,
  options: WindowQueryOptions | undefined
): boolean {
  const types = options?.windowTypes
  if (!types || types.length === 0) return win.type !== 'devtools'
  return types.includes(win.type)
}

/** Chrome window state from the frame's flags (minimised wins over the rest). */
export function windowStateFrom(flags: {
  minimized: boolean
  fullscreen: boolean
  maximized: boolean
}): ChromeWindowState {
  if (flags.minimized) return 'minimized'
  if (flags.fullscreen) return 'fullscreen'
  if (flags.maximized) return 'maximized'
  return 'normal'
}
