import type { MediaState, Tab, UIState } from '@shared/types'
import { orderMediaEntries } from '@shared/mediaHub'
import { displayHost } from '@shared/url'
import { run } from '@renderer/lib/api'
import { TOOLBAR_BUTTON, TOOLBAR_GAP } from '@renderer/lib/extensions/toolbar'
import { createStore } from '@renderer/lib/store'
import { PILL_PADDING, PILL_TOOLS_TIER } from '@renderer/components/urlbar/pillChipTiers'

/**
 * What the desktop's media hub (MW-16: Chrome's global media controls, a toolbar button with a
 * popover of one player per tab) reads from `UIState.media` beyond what both in-app players
 * share – the position carried forward, the times, the detail line and the track handlers are
 * `lib/media.ts`'s, the seek row's state `useMediaSeek`'s, as the phone's media sheet reads
 * them – and the hub's own open state. The players' order is `shared/mediaHub.ts`'s, so the app
 * menu's "Now Playing…" row the core builds where the toolbar button has folded (design
 * language v2 §9.29) leads with the same card this hub does.
 */

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
 * The pill the hub's toolbar button must leave standing (design language v2 §9.29): the button
 * is tiered by the row's width exactly as the pill's chips are, never by the active tab – at
 * the 240 sidebar it folds into the app menu's "Now Playing…" row with the accent dot on ⋯ –
 * and a folding button returns where the pill, with the button's own slot back in the row,
 * still holds the box the star and the tools return at: the tier's `PILL_TOOLS_TIER` content
 * box (110, the stylesheet's `@container (width < 110px)`; §9.29's "130 px pill"), 126 in the
 * row's `PILL_PADDING`. Never where the pill first reaches that box without the button: a
 * button returning there took the pill straight back under the tier it had just met (270 gave
 * 125 → 94, and the address gave way to the title) and flipped its reading.
 */
export const MEDIA_HUB_PILL = PILL_PADDING + PILL_TOOLS_TIER

/** A toolbar button's pitch in the row: its box and the gap before it (§5, 28 + 4). */
const TOOLBAR_SLOT = TOOLBAR_BUTTON + TOOLBAR_GAP

/**
 * The row width at which the hub's button returns, given the count of the row's other buttons:
 * the pill's tier box, the other buttons' slots and the hub's own. With the four always-there
 * buttons (back, forward, reload, ⋯) that is 286 – the 302 sidebar, its 8 px gutters aside –
 * where the pill with the button is 126 and the star is up with it; at 301 it would be 125.
 */
export function mediaHubReturnRow(otherButtons: number): number {
  return MEDIA_HUB_PILL + (otherButtons + 1) * TOOLBAR_SLOT
}

/**
 * Whether the row is wide enough for the hub's button: the pill the row would give its other
 * buttons – back, forward, reload, ⋯, the puzzle piece and the downloads button while they are
 * up; not the pinned actions, which fold by the pill's own floor – and the hub's own slot still
 * holds `MEDIA_HUB_PILL`. The hub's slot is in the sum, so the pill reads the same on either
 * side of the return: at 302 the button arrives over a 126 pill, the star up; at 270, where the
 * star returned over the same 126, the button leaves it so. An unmeasured row (0) shows the
 * button, as the pinned actions show before the row has a width. Pure, for the unit tests; the
 * row measures itself and asks.
 */
export function mediaHubButtonFits(rowWidth: number, otherButtons: number): boolean {
  if (rowWidth <= 0) return true
  return rowWidth >= mediaHubReturnRow(otherButtons)
}

/**
 * Something plays: the accent dot on the hub's toolbar button, and – while that button has
 * folded (`mediaHubFolded`) – the same dot on the "⋯" menu button, whose menu then carries the
 * "Now Playing…" row (§9.29 – Firefox's badge on its menu button).
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
 * The sidebar's "⋯" menu button: the hub's other anchor and, while the toolbar button has
 * folded, the bearer of its dot (§9.29).
 */
export const APP_MENU_BUTTON = '[data-zen-app-menu-button]'

/**
 * Whether the hub has folded into the app menu, for the row that decides it (the ⋯ button's dot
 * and name): there is media to control and the row has not put the button up. The fold is the
 * toolbar's width tier's to make – at the 240 sidebar the hub "folds into the app menu as a Now
 * playing row with an accent dot on ⋯", and returns as a button where the pill, with the
 * button's slot back, still holds the star's box (§9.29; the 302 sidebar with the always-there
 * buttons) – and the row makes it from its own measured width (`useElementWidth` on the row:
 * the ResizeObserver that follows a sidebar drag) with `mediaHubButtonFits`, in the render that
 * mounts or unmounts the
 * button. Read from the same render, the dot moves button ↔ ⋯ in the commit that moves the
 * button: no frame shows both or neither, at no width, by construction – where a read of the
 * DOM after the commit (`mediaHubFolded`) is a commit behind, and a `ResizeObserver` on the
 * button fires for a node the row's own observer pass has already detached (Chromium's
 * "ResizeObserver loop completed with undelivered notifications", the shell pass (a) drive's
 * finding). Pure, for the unit tests.
 */
export function mediaHubFoldedAt(state: UIState, hubButtonUp: boolean): boolean {
  return mediaHubVisible(state) && !hubButtonUp
}

/**
 * Whether the hub's toolbar button has folded, read from the document: it is not in the row, or
 * nothing lays its box out (`checkVisibility`). For the moments between renders – the menu
 * request the core builds the "Now Playing…" row for, the anchor the popover hangs from – where
 * the row has committed what it decided (`mediaHubFoldedAt`); the row itself renders from its
 * width, never from this, so the dot, the row and the anchor cannot disagree.
 */
export function mediaHubFolded(): boolean {
  return !document.querySelector<HTMLElement>(MEDIA_HUB_BUTTON)?.checkVisibility()
}

/**
 * The control the hub's popover hangs from and gives the keyboard back to: its toolbar button
 * while that is in the row and laid out, else the "⋯" menu button – the hub folds into the app
 * menu's "Now Playing…" row at the 240 sidebar (design language v2 §9.29), and the row's pick
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

/**
 * The line the player leads with: the page's metadata, else the tab's title, else the site
 * (the detail line under it, `mediaDetail`, then never says the site again).
 */
export function mediaTitle(media: MediaState, tab: Tab | undefined): string {
  return media.title?.trim() || tab?.title?.trim() || (tab ? displayHost(tab.url) : '') || 'Media'
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
