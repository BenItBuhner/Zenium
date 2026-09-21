import { useCallback, useSyncExternalStore } from 'react'
import type { MediaState, Tab, UIState } from '@shared/types'
import { orderMediaEntries } from '@shared/mediaHub'
import { displayHost } from '@shared/url'
import { run } from '@renderer/lib/api'
import { createStore } from '@renderer/lib/store'

/**
 * What the desktop's media hub (MW-16: Chrome's global media controls, a toolbar button with a
 * popover of one player per tab) reads from `UIState.media` beyond what both in-app players
 * share – the position carried forward, the times, the detail line and the track handlers are
 * `lib/media.ts`'s, the seek row's state `useMediaSeek`'s, as the phone's media sheet reads
 * them – and the hub's own open state. The players' order is `shared/mediaHub.ts`'s, so the app
 * menu's "Now playing…" row the core builds where the toolbar button has folded (design
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
 * Something plays: the accent dot on the hub's toolbar button, and – while that button has
 * folded (`mediaHubFolded`) – the same dot on the "⋯" menu button, whose menu then carries the
 * "Now playing…" row (§9.29 – Firefox's badge on its menu button).
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
 * Whether the hub's toolbar button has folded: it is not in the row, or the row's stylesheet has
 * taken its box (`checkVisibility`). The fold is the toolbar's width tier's to make – at the 240
 * sidebar the hub "folds into the app menu as a Now playing row with an accent dot on ⋯", and
 * "returns as a button at 270" (§9.29) – by unmounting the button or by hiding it from a
 * stylesheet; this only reads the result, as `mediaHubAnchor()` does, so the dot, the row and the
 * anchor never disagree, and no width draws the dot twice. Until the tier lands the button is
 * always up while there is media, and the row and the ⋯ dot stay away.
 */
export function mediaHubFolded(): boolean {
  return !document.querySelector<HTMLElement>(MEDIA_HUB_BUTTON)?.checkVisibility()
}

/**
 * `mediaHubFolded()` as a value the toolbar row renders from (the ⋯ button's dot and name).
 * The DOM is the store: the snapshot is re-read after every commit of the row (the snapshot
 * function is new each render, so React checks it once the row's own changes – the button
 * mounting or unmounting with the media, or with the width once the tier is in – are in the
 * document) and whenever the button's box changes under a stylesheet (the tier's fold by CSS,
 * a `ResizeObserver` on the button, re-attached as the button comes and goes with the media)
 * or the window resizes.
 */
export function useMediaHubFolded(state: UIState): boolean {
  const present = mediaHubVisible(state)
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      window.addEventListener('resize', onChange)
      const button = present ? document.querySelector(MEDIA_HUB_BUTTON) : null
      const observer =
        button && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onChange) : null
      if (button) observer?.observe(button)
      return () => {
        window.removeEventListener('resize', onChange)
        observer?.disconnect()
      }
    },
    [present]
  )
  return useSyncExternalStore(subscribe, () => mediaHubFolded())
}

/**
 * The control the hub's popover hangs from and gives the keyboard back to: its toolbar button
 * while that is in the row and laid out, else the "⋯" menu button – the hub folds into the app
 * menu's "Now playing…" row at the 240 sidebar (design language v2 §9.29), and the row's pick
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
