import type { MediaState, Tab, UIState } from '@shared/types'
import { displayHost } from '@shared/url'
import { run } from '@renderer/lib/api'
import { createStore } from '@renderer/lib/store'

/**
 * What the desktop's media hub (MW-16: Chrome's global media controls, a toolbar button with a
 * popover of one player per tab) reads from `UIState.media` beyond what both in-app players
 * share – the position carried forward, the times, the detail line and the track handlers are
 * `lib/media.ts`'s, the seek row's state `useMediaSeek`'s, as the phone's media sheet reads
 * them – and the hub's own open state.
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
  const entries = (state.media ?? []).filter((m) => state.tabs[m.tabId])
  const rank = (m: MediaState): number => (m.session ? 0 : m.playing ? 1 : 2)
  return [...entries].sort((a, b) => rank(a) - rank(b))
}

/** The toolbar button shows while there is anything to control. */
export function mediaHubVisible(state: UIState): boolean {
  return mediaHubEntries(state).length > 0
}

/** The button's name: what is playing, or that the players are there. */
export function mediaHubLabel(entries: MediaState[]): string {
  const playing = entries.filter((m) => m.playing).length
  if (playing === 0) return 'Media controls'
  return playing === 1 ? 'Media controls, 1 playing' : `Media controls, ${playing} playing`
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
