import { getDomain } from '../shared/url'

/**
 * Which hidden pages a memory-pressure signal puts to sleep, and in what order (OS-37; Chrome's
 * `PageDiscardingHelper::CanDiscard` rules and its Android `BindingManager.onTrimMemory`
 * ratios). Pure: `Tabs.unloadForMemoryPressure` reads the tabs into [SleepCandidate]s, takes the
 * plan and discards it in batches (`DISCARD_BATCH` per `DISCARD_BATCH_INTERVAL_MS`, ruling 5: a
 * `WebView.destroy` is main-thread work and thirty in one task would be a long frame).
 *
 * The levels are the host's grading of the platform's signal (`MemoryPressure.kt`): `moderate`
 * sleeps the quarter of the eligible pages that were shown longest ago, `low` the half,
 * `critical` all of them – Chrome's 25 % / 50 % / all of the background renderers it
 * un-protects at RUNNING_MODERATE / RUNNING_LOW / anything higher. A signal that repeats while
 * the device stays short (the host polls after a signal) sleeps the next share of what is left.
 *
 * Never slept, at any level: a page on screen, a page playing audio or that played within
 * `RECENTLY_AUDIBLE_MS` (Chrome's `kTabAudioProtectionTime`), a page holding a live capture
 * (camera, microphone, display), a page whose form the user has typed into, a page still
 * loading, one open in DevTools or driven by an agent, and a page shown within
 * `RECENTLY_SHOWN_MS` – the tab the user just left is the one they come back to. The
 * never-sleep list holds at `moderate` and `low`; at `critical` the process is about to be
 * killed and would lose those pages too, so they sleep like the rest and come back on focus.
 */
export type MemoryPressureLevel = 'moderate' | 'low' | 'critical'

/** What the plan needs to know of one loaded page. */
export interface SleepCandidate {
  id: string
  url: string
  /** When the tab was last shown or left (`Tab.lastActiveAt`). */
  lastActiveAt: number
  visible: boolean
  audible: boolean
  /** When the page last went quiet, or null if it never played this session. */
  quietAt: number | null
  /** A live camera, microphone or display capture (`Tab.capture`). */
  capturing: boolean
  /** The user typed into a form field of the current document (`Tab.formEdited`). */
  formEdited: boolean
  loading: boolean
  devtools: boolean
  /** An agent is driving the page. */
  driven: boolean
}

/** Why a page is not slept under pressure (the tests read it; the plan drops the page). */
export type SleepExemption =
  | 'visible'
  | 'audible'
  | 'recently-audible'
  | 'capturing'
  | 'form'
  | 'loading'
  | 'devtools'
  | 'driven'
  | 'recently-shown'
  | 'listed'

/** A page shown within this is not slept: the user is likely on the way back to it. */
export const RECENTLY_SHOWN_MS = 60_000
/** A page that played audio within this is not slept (Chrome's `kTabAudioProtectionTime`). */
export const RECENTLY_AUDIBLE_MS = 60_000
/** Pages destroyed per batch, and the gap between batches. */
export const DISCARD_BATCH = 2
export const DISCARD_BATCH_INTERVAL_MS = 100

/** The share of the eligible pages a signal at `level` sleeps: the oldest quarter, half or all. */
export function discardShare(level: MemoryPressureLevel, eligible: number): number {
  if (eligible <= 0) return 0
  switch (level) {
    case 'moderate':
      return Math.ceil(eligible / 4)
    case 'low':
      return Math.ceil(eligible / 2)
    case 'critical':
      return eligible
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Whether the never-sleep list (`settings.unloadExcludedDomains`, lower-cased) names the page
 * at `url`: by its host with `www.` aside, or by its registrable domain – the two forms the
 * list's writers use (the phone's Add sheet writes a host; the desktop's Add current site and
 * the pill's Never unload this site write `getDomain`, `google.com` for a page of
 * `mail.google.com`, so every page of the site stays loaded).
 */
export function neverUnloaded(url: string, excluded: readonly string[]): boolean {
  if (excluded.length === 0) return false
  const host = domainOf(url)
  if (!host) return false
  const site = getDomain(url)
  return excluded.some((d) => d === host || (site !== '' && d === site))
}

/**
 * The reason no policy, timer or pressure, may sleep `tab` right now, or null: the rules Chrome's
 * `PageDiscardingHelper::CanDiscard` applies to proactive and urgent discards alike.
 */
export function protectedReason(tab: SleepCandidate, now: number): SleepExemption | null {
  if (tab.visible) return 'visible'
  if (tab.audible) return 'audible'
  if (tab.quietAt !== null && now - tab.quietAt < RECENTLY_AUDIBLE_MS) return 'recently-audible'
  if (tab.capturing) return 'capturing'
  if (tab.formEdited) return 'form'
  if (tab.loading) return 'loading'
  if (tab.devtools) return 'devtools'
  if (tab.driven) return 'driven'
  return null
}

/**
 * The reason `tab` is kept awake by a pressure signal at `level`, or null when it may sleep:
 * the shared protections, then the recency guard, then the never-sleep list below `critical`.
 */
export function sleepExemption(
  tab: SleepCandidate,
  level: MemoryPressureLevel,
  excluded: readonly string[],
  now: number
): SleepExemption | null {
  const kept = protectedReason(tab, now)
  if (kept !== null) return kept
  if (now - tab.lastActiveAt < RECENTLY_SHOWN_MS) return 'recently-shown'
  if (level !== 'critical' && neverUnloaded(tab.url, excluded)) return 'listed'
  return null
}

/**
 * The ids to put to sleep for a signal at `level`, least recently shown first: the exempt pages
 * dropped, then the level's share of what is left.
 */
export function planMemoryPressureDiscard(
  tabs: readonly SleepCandidate[],
  level: MemoryPressureLevel,
  excluded: readonly string[],
  now: number
): string[] {
  const lowered = excluded.map((d) => d.toLowerCase())
  const eligible = tabs
    .filter((t) => sleepExemption(t, level, lowered, now) === null)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
  return eligible.slice(0, discardShare(level, eligible.length)).map((t) => t.id)
}
