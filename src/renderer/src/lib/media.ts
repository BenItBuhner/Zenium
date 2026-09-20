import type { MediaState, UIState } from '@shared/types'
import { displayHost } from '@shared/url'

/**
 * What the in-app player (the pill's Now playing chip and the media sheet, MW-16) reads from
 * `UIState.media`: the session – the one tab whose media the OS controls show, as the core
 * picked it – and the numbers the sheet draws from a report that is a moment old.
 */

/** The tab whose media the OS controls show, or null while nothing plays or played. */
export function mediaSession(state: UIState): MediaState | null {
  // Every host sends the list; states built by hand in tests may leave it out.
  return (state.media ?? []).find((m) => m.session && state.tabs[m.tabId]) ?? null
}

/** The media entry of `tabId`, while the tab and its media are there. */
export function mediaOf(state: UIState, tabId: string): MediaState | null {
  return (state.media ?? []).find((m) => m.tabId === tabId && state.tabs[m.tabId]) ?? null
}

/**
 * Where playback stands at `now` (epoch ms): the reported position carried forward at the
 * playback rate for the time since the report while the media plays, held where it was while
 * it is paused, never past the duration (a stream without one reports 0 and is not clamped).
 */
export function extrapolatePosition(media: MediaState, now: number): number {
  const position = media.position
  if (!position) return 0
  if (!media.playing || media.positionAt === undefined) return Math.max(0, position.position)
  const elapsed = Math.max(0, (now - media.positionAt) / 1000) * (position.playbackRate || 1)
  const at = position.position + elapsed
  return position.duration > 0 ? Math.min(position.duration, Math.max(0, at)) : Math.max(0, at)
}

/** `m:ss`, or `h:mm:ss` from an hour on, as the media notification and Chrome's controls write times. */
export function formatMediaTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/**
 * The line under the title: the artist (the page's metadata, else the site the core filled in)
 * and the site, once each – a page without metadata already has its site for an artist.
 */
export function mediaDetail(media: MediaState, tab: UIState['tabs'][string] | undefined): string {
  const parts: string[] = []
  const artist = media.artist?.trim() ?? ''
  const host = tab ? displayHost(tab.url) : ''
  if (artist) parts.push(artist)
  if (host && host !== artist) parts.push(host)
  return parts.join(' · ')
}

/** Whether the page handles `action` itself (registered a Media Session handler for it). */
export function handlesAction(media: MediaState, action: 'previoustrack' | 'nexttrack'): boolean {
  return media.actions?.includes(action) ?? false
}
