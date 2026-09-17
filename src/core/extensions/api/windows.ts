/**
 * The `chrome.windows` data model: Chrome's `Window` shape and the `QueryOptions` filters of
 * `windows.getAll` / `windows.get`. Pure; hosts fill the records from their own windows.
 */
import type { ChromeTab } from './tabs'

export type ChromeWindowType = 'normal' | 'popup' | 'panel' | 'app' | 'devtools'
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
