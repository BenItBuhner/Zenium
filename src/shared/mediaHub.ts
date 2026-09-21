import type { MediaState, Tab } from './types'
import { displayHost } from './url'

/**
 * What every player row says about a media entry, on whichever surface draws it: the desktop
 * hub's per-tab cards (`renderer/lib/mediaHub.ts`), the phone's media sheet, and the app menu's
 * "Now Playing" row the core builds where the hub's toolbar button has folded by the sidebar's
 * width tier (design language v2 §9.29). One module, so the menu row mirrors the hub's first
 * card word for word: the players' order, the line a player leads with and the detail under it.
 */

/** The tab a row needs of its `Tab`: the title it falls back to and the URL its site is read from. */
export type MediaRowTab = Pick<Tab, 'title' | 'url'>

/**
 * The players' order: the session – the one tab whose media the OS controls show – first, then
 * the ones playing, then the rest in the core's order (a tab that paused stays until its media
 * goes, as Chrome's cards do). Pure: returns a sorted copy; the caller has already dropped the
 * entries whose tab is gone.
 */
export function orderMediaEntries(entries: readonly MediaState[]): MediaState[] {
  const rank = (m: MediaState): number => (m.session ? 0 : m.playing ? 1 : 2)
  return [...entries].sort((a, b) => rank(a) - rank(b))
}

/**
 * The line the player leads with: the page's metadata, else the tab's title, else the site
 * (the detail line under it, `mediaDetail`, then never says the site again).
 */
export function mediaTitle(media: MediaState, tab: MediaRowTab | undefined): string {
  return media.title?.trim() || tab?.title?.trim() || (tab ? displayHost(tab.url) : '') || 'Media'
}

/**
 * The line under the title: the artist (the page's metadata, else the site the core filled in)
 * and the site, once each – a page without metadata already has its site for an artist – and
 * never the site when `title`, the line shown above, is the site already (a page without a
 * title of its own reads as its host): the title over the site, as Chrome's notification, and
 * the site never twice. An artist the page set stays even when it matches the title.
 */
export function mediaDetail(media: MediaState, tab: MediaRowTab | undefined, title = ''): string {
  const parts: string[] = []
  const shown = title.trim()
  const artist = media.artist?.trim() ?? ''
  const host = tab ? displayHost(tab.url) : ''
  const artistIsSite = artist === host
  if (artist && !(artistIsSite && artist === shown)) parts.push(artist)
  if (host && host !== artist && host !== shown) parts.push(host)
  return parts.join(' · ')
}
