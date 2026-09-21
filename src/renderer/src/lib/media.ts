import type { MediaState, UIState } from '@shared/types'
import { extrapolatePosition as extrapolateReport } from '@shared/mediaSession'

/**
 * What the in-app players (MW-16: the pill's Now playing chip and the media sheet on the phone,
 * the toolbar button and the media hub on the desktop) read from `UIState.media`: the session –
 * the one tab whose media the OS controls show, as the core picked it – and the numbers a player
 * draws from a report that is a moment old. The desktop hub's own pieces (the players' order,
 * the button's label, the open state) are `lib/mediaHub.ts`'s. The detail line is the shared
 * module's (`shared/mediaHub.ts`), which the core's app-menu row reads too (§9.29).
 */

export { mediaDetail } from '@shared/mediaHub'

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
 * it is paused, never past the duration (a stream without one reports 0 and is not clamped) –
 * the shared Media Session module's rule, the one the core's OS controls move by, so the in-app
 * players and the OS agree; 0 without a position, the report as it stands without its time.
 */
export function extrapolatePosition(media: MediaState, now: number): number {
  const position = media.position
  if (!position) return 0
  if (media.positionAt === undefined) return Math.max(0, position.position)
  return extrapolateReport(position, media.playing, media.positionAt, now)
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

/** Whether the page handles `action` itself (registered a Media Session handler for it). */
export function handlesAction(media: MediaState, action: 'previoustrack' | 'nexttrack'): boolean {
  return media.actions?.includes(action) ?? false
}
