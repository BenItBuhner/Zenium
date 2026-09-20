import type { MediaState, Tab, UIState } from '@shared/types'
import { extrapolatePosition } from '@shared/mediaSession'
import { displayHost } from '@shared/url'
import { run } from '@renderer/lib/api'
import { createStore } from '@renderer/lib/store'

/**
 * What the desktop's media hub (MW-16: Chrome's global media controls, a toolbar button with a
 * popover of one player per tab) reads from `UIState.media`, and the hub's own open state. The
 * phone's in-app player (`lib/media.ts` of the Android media UI) reads the same entries; the two
 * keep separate helpers until one of them lands and the other folds the shared piece in (named
 * in both PR bodies).
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

/** The line the player leads with: the page's metadata, else the tab's title, else the site. */
export function mediaTitle(media: MediaState, tab: Tab | undefined): string {
  return media.title?.trim() || tab?.title?.trim() || (tab ? displayHost(tab.url) : '') || 'Media'
}

/**
 * The line under the title: the artist (the page's metadata) and the site, once each – a page
 * without metadata already has its site for a title.
 */
export function mediaDetail(media: MediaState, tab: Tab | undefined): string {
  const parts: string[] = []
  const artist = media.artist?.trim() ?? ''
  const host = tab ? displayHost(tab.url) : ''
  if (artist) parts.push(artist)
  if (host && host !== artist && host !== mediaTitle(media, tab)) parts.push(host)
  return parts.join(' · ')
}

/**
 * Where playback stands at `now` (epoch ms): the reported position carried forward at the
 * playback rate since the report while the media plays (`extrapolatePosition` of the shared
 * Media Session module), held where it was while paused; 0 with no position at all.
 */
export function livePosition(media: MediaState, now: number): number {
  const position = media.position
  if (!position) return 0
  if (media.positionAt === undefined) return Math.max(0, position.position)
  return extrapolatePosition(position, media.playing, media.positionAt, now)
}

/** `m:ss`, or `h:mm:ss` from an hour on, as Chrome's controls write times. */
export function formatMediaTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** Whether the page handles `action` itself (registered a Media Session handler for it). */
export function handlesAction(media: MediaState, action: 'previoustrack' | 'nexttrack'): boolean {
  return media.actions?.includes(action) ?? false
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
