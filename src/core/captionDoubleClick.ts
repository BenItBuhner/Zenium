import type { Platform } from '../shared/types'
import type { TitleBarDoubleClickAction } from './platform'

/** What a double-click on the caption does to the window. */
export type CaptionDoubleClickEffect = 'toggleMaximize' | 'minimize' | 'none'

/**
 * A double-click on the chrome's empty caption room – the tab strip's blank band, the sidebar's
 * empty space (tabs-47, shortcuts-menus-94) – does what the OS does to a double-clicked title
 * bar. Windows and Linux toggle maximise (restore when maximised); macOS follows System
 * Settings › Desktop & Dock › "Double-click a window's title bar to" – zoom, minimise or nothing
 * – which the host reads (`AppHost.titleBarDoubleClickAction`; zoom when it cannot). A host
 * without a window frame of its own (Android) does nothing.
 *
 * Zoom is a toggle too: a zoomed window double-clicked zooms back, so both desktop shapes come
 * out as `toggleMaximize` (the macOS host's `maximize` is the zoom).
 */
export function captionDoubleClickEffect(
  os: Platform,
  macAction: TitleBarDoubleClickAction | null
): CaptionDoubleClickEffect {
  if (os === 'android') return 'none'
  if (os !== 'darwin') return 'toggleMaximize'
  switch (macAction ?? 'zoom') {
    case 'minimize':
      return 'minimize'
    case 'none':
      return 'none'
    default:
      return 'toggleMaximize'
  }
}

/**
 * The macOS `AppleActionOnDoubleClick` user default as the setting's three choices: `Maximize`
 * (zoom; and `Fill`, macOS 15's fill-the-screen variant of it), `Minimize`, `None`. Unset – the
 * fresh-Mac state – means zoom, as do values the setting does not have.
 */
export function macTitleBarDoubleClickAction(
  userDefault: string | null | undefined
): TitleBarDoubleClickAction {
  switch (userDefault) {
    case 'Minimize':
      return 'minimize'
    case 'None':
      return 'none'
    default:
      return 'zoom'
  }
}
