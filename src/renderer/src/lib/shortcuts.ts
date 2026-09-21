import type { ShortcutAction, UIState } from '@shared/types'
import { shortcutHint, withShortcutHint } from '@shared/shortcuts'
import { run } from './api'
import { mediaHubFolded } from './mediaHub'
import { browserStore, menuAnchor } from './ui'

/** `Label (Ctrl+R)` from the active key table: tooltips never quote a chord the user rebound. */
export function hint(label: string, state: UIState, action: ShortcutAction): string {
  // A snapshot without a table (a partial state in a component test) shows the bare label.
  return withShortcutHint(label, state.shortcuts ?? [], action, state.platform)
}

/** `hint` for components without the state at hand; the bare label until the state arrives. */
export function useHint(label: string, action: ShortcutAction): string {
  const state = browserStore.use((s) => s.state)
  return state ? hint(label, state, action) : label
}

/** The chord of `action` as text (`Ctrl+S`), null while unbound or before the state arrives. */
export function useChord(action: ShortcutAction): string | null {
  const state = browserStore.use((s) => s.state)
  return state ? shortcutHint(state.shortcuts ?? [], action, state.platform) : null
}

/**
 * A shortcut asked for the "⋯" menu: the chrome's menu button (when one is on screen) claims
 * the event by cancelling it, focuses itself and opens the menu from its own edge.
 */
export const APP_MENU_EVENT = 'zen-app-menu'

/**
 * Open the application menu from its button – hanging off the button's bottom edge like
 * Chrome's and Firefox's do – or at the pointer when the button is not on screen. From the
 * keyboard the first item starts selected, so the arrow keys and Enter work at once. The request
 * says whether the media hub's toolbar button has folded (design language v2 §9.29): the core
 * builds the menu without the toolbar's width, and the "Now Playing…" row is the folded state's.
 */
export function openAppMenu(button: HTMLElement | null, keyboard = false): void {
  const rect = button?.getBoundingClientRect()
  const anchor =
    rect && rect.width > 0
      ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      : undefined
  // The tablet's popover menu hangs from the button's box, not from the point the core echoes.
  menuAnchor.element = anchor ? button : null
  run('app.menu', { anchor, keyboard, mediaHubFolded: mediaHubFolded() })
}
