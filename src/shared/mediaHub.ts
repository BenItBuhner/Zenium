import type { MediaState } from './types'

/**
 * The players' order, on whichever surface lists them: the desktop hub's per-tab cards
 * (`renderer/lib/mediaHub.ts`) and the app menu's "Now Playing…" row the core builds where the
 * hub's toolbar button has folded by the sidebar's width tier (design language v2 §9.29) – the
 * row's icon is the hub's first card's artwork, so the two must agree on which card is first.
 * The session – the one tab whose media the OS controls show – first, then the ones playing,
 * then the rest in the core's order (a tab that paused stays until its media goes, as Chrome's
 * cards do). Pure: returns a sorted copy; the caller has already dropped the entries whose tab
 * is gone.
 */
export function orderMediaEntries(entries: readonly MediaState[]): MediaState[] {
  const rank = (m: MediaState): number => (m.session ? 0 : m.playing ? 1 : 2)
  return [...entries].sort((a, b) => rank(a) - rank(b))
}
