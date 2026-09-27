import type { IphBubbleState, IphState } from './types'

/**
 * In-product help on the phone (TB-19): the one-shot hint bubbles Chrome Android anchors to its
 * toolbar. At Chrome 152 one of them is on by default with a client-side config,
 * `IPH_TabSwitcherButton` (`components/feature_engagement/public/feature_constants.cc`
 * l.621–623; `feature_configurations.cc` l.1635–1652): "Show after 14 days of Chrome being
 * installed, once every 90 days, unless the user has used the tab switcher button in the last
 * year" – one bubble per session (`session_rate < 1`). The adaptive-button bubbles are off by
 * default there and have no config; this module knows the one bubble Chrome shows.
 *
 * Each bubble's record is this device's own (`DEVICE_LOCAL_SETTINGS`): Chrome's feature
 * engagement tracker keeps its events in the profile's own LevelDB
 * (`components/feature_engagement/internal/persistent_event_store.cc` l.25–26: a
 * `leveldb_proto::ProtoDatabase<Event>`; l.43 `WriteEvent`) with no sync layer, so a phone that
 * has seen a bubble says nothing about the phone beside it. The renderer's trigger
 * model (`lib/iph.ts`) reads these; the core only sanitises them (`applyPersisted`,
 * `updateSettings`).
 */

/**
 * Chrome's `availability >= 14` for the tab switcher bubble (`feature_configurations.cc`
 * l.1637): the days the bubble has to have been available on the device before it may show.
 */
export const IPH_TAB_SWITCHER_AVAILABILITY_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_IPH_BUBBLE_STATE: IphBubbleState = { availableAt: null, shown: false }

export const DEFAULT_IPH_STATE: IphState = {
  tabSwitcher: { ...DEFAULT_IPH_BUBBLE_STATE }
}

/** Persisted state from disk can be anything: coerce it into a valid record. */
export function sanitizeIphState(raw: unknown): IphState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { tabSwitcher: sanitizeBubble(r.tabSwitcher) }
}

function sanitizeBubble(raw: unknown): IphBubbleState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const at = r.availableAt
  return {
    availableAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.floor(at) : null,
    shown: r.shown === true
  }
}

/**
 * Whether the bubble's availability has run: it became available on this device at
 * `availableAt`, `days` ago or more by the clock `now`. A record without the stamp is not yet
 * available – the first deferred arm stamps it (`lib/iph.ts`), which starts the clock at the
 * first run of a build that has the bubble, as Chrome's availability model starts it the day
 * the feature is first seen enabled. A clock set back reads as not yet available, never as due.
 */
export function iphAvailable(
  bubble: IphBubbleState,
  now: number,
  days = IPH_TAB_SWITCHER_AVAILABILITY_DAYS
): boolean {
  return bubble.availableAt !== null && now - bubble.availableAt >= days * DAY_MS
}
