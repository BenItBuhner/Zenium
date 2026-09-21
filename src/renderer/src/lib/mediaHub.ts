import type { MediaState, UIState } from '@shared/types'
import { orderMediaEntries } from '@shared/mediaHub'
import { run } from '@renderer/lib/api'
import { APP_MENU_BUTTON } from '@renderer/lib/shortcuts'
import { createStore } from '@renderer/lib/store'

/**
 * What the desktop's media hub (MW-16: Chrome's global media controls, a toolbar button with a
 * popover of one player per tab) reads from `UIState.media` beyond what both in-app players
 * share – the position carried forward, the times, the detail line and the track handlers are
 * `lib/media.ts`'s, the seek row's state `useMediaSeek`'s, as the phone's media sheet reads
 * them – and the hub's own open state. The players' order and the line a player leads with are
 * `shared/mediaHub.ts`'s, so the app menu's "Now Playing" row the core builds where the toolbar
 * button has folded (design language v2 §9.29) mirrors the hub's first card.
 */

export { mediaTitle } from '@shared/mediaHub'

export interface MediaHubUi {
  /** The popover is up. */
  open: boolean
  /** It was opened with the keyboard on the button: the page had no focus to get back (§9.22). */
  fromKeyboard: boolean
}

export const mediaHubUi = createStore<MediaHubUi>(
  { open: false, fromKeyboard: false },
  'media-hub-ui'
)

/**
 * The tabs the hub shows, one player each: every media entry whose tab is still there, the
 * session – the one the OS controls show – first, then the ones playing, then the rest in the
 * core's order (a tab that paused stays until its media goes, as Chrome's cards do).
 */
export function mediaHubEntries(state: UIState): MediaState[] {
  return orderMediaEntries((state.media ?? []).filter((m) => state.tabs[m.tabId]))
}

/** The toolbar button shows while there is anything to control. */
export function mediaHubVisible(state: UIState): boolean {
  return mediaHubEntries(state).length > 0
}

/**
 * Something plays: the accent dot on the hub's toolbar button, and the same dot on the "⋯" menu
 * button, whose menu carries the "Now Playing" row while the button has folded (§9.29 –
 * Firefox's badge on its menu button).
 */
export function mediaPlaying(state: UIState): boolean {
  return mediaHubEntries(state).some((m) => m.playing)
}

/**
 * The one name of the hub: the toolbar button's, and the popover's accessible name. The
 * popover carries no title block of its own (§9.7: a list of items that name themselves opens
 * on its cards, like a menu, and its name lives on the control that opens it).
 */
export const MEDIA_HUB_NAME = 'Media controls'

/** The toolbar button the hub's popover hangs from and returns the keyboard to (§9.22). */
export const MEDIA_HUB_BUTTON = '[data-zen-media-hub-button]'

/**
 * The control the hub's popover hangs from and gives the keyboard back to: its toolbar button
 * while that is in the row and laid out, else the "⋯" menu button – the hub folds into the app
 * menu's "Now Playing" row at the 240 sidebar (design language v2 §9.29), and the row's pick
 * opens the hub from there. Looked up on each use: the row remounts its buttons with the tab and
 * the width. The fold is the toolbar's tier's to make, by unmounting the button or by hiding it
 * from a stylesheet; either way a button without a box is no anchor (`checkVisibility`).
 */
export function mediaHubAnchor(): HTMLElement | null {
  const button = document.querySelector<HTMLElement>(MEDIA_HUB_BUTTON)
  if (button?.checkVisibility()) return button
  return document.querySelector<HTMLElement>(APP_MENU_BUTTON)
}

/** The button's name: what is playing, or that the players are there. */
export function mediaHubLabel(entries: MediaState[]): string {
  const playing = entries.filter((m) => m.playing).length
  if (playing === 0) return MEDIA_HUB_NAME
  return `${MEDIA_HUB_NAME}, ${playing} playing`
}

/** Open the hub from its button; the popover captures the page itself (`useFloatingChrome`). */
export function openMediaHub({ fromKeyboard = false }: { fromKeyboard?: boolean } = {}): void {
  if (fromKeyboard) run('focus.chrome', undefined)
  mediaHubUi.set({ open: true, fromKeyboard })
}

export function closeMediaHub(): void {
  if (mediaHubUi.get().open) mediaHubUi.set({ open: false })
}

/** The button's press: close an open hub (the keyboard stays on the button), else open it. */
export function toggleMediaHub({ fromKeyboard = false }: { fromKeyboard?: boolean } = {}): void {
  if (mediaHubUi.get().open) closeMediaHub()
  else openMediaHub({ fromKeyboard })
}
