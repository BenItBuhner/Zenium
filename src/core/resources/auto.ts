import { conditionalReturn, confidence, hazards, type TabHabits } from './habits'

/**
 * Auto memory mode: when a hidden tab sleeps, decided from how much memory the machine has free
 * right now and from how this person comes back to tabs (`habits.ts`) – not from fixed timers or
 * a fixed cap.
 *
 * - With plenty free, tabs stay live: only a tab this person is very unlikely to come back to
 *   soon, hidden for a good while, is unloaded.
 * - As free memory runs short, the bar rises smoothly: tabs unlikely to be needed in the next hour
 *   go first, earlier.
 * - Below the reserve, tabs are unloaded at once, least likely to be needed first, until the
 *   machine is back above it (a game or another app took the memory).
 * - Early on, with little to go on, everything leans generous (`confidence`); it tightens as the
 *   person's own habits build up.
 *
 * Protected tabs (playing audio, kept awake, agent-driven, DevTools open, a keep-awake site) are
 * never touched here. Pure: the governor and the simulated users (`sim.ts`) call the same code.
 */

/** Free memory share at and above which there is no pressure at all. */
export const RELAXED_FREE = 0.25
/** Free memory share at and below which pressure is full. */
export const TIGHT_FREE = 0.07
/** What Auto keeps free for the rest of the machine: this share of RAM, at least `RESERVE_MIN_MB`. */
export const RESERVE_SHARE = 0.05
export const RESERVE_MIN_MB = 400

/** The return horizons Auto weighs: "soon" for freezing, "this hour" for unloading. */
export const SOON_MS = 10 * 60_000
export const HOUR_MS = 60 * 60_000

export interface AutoSystem {
  totalMemoryMb: number
  /** Memory the OS could hand out now (MemAvailable on Linux), all apps counted. */
  availableMemoryMb: number
  energySaver: boolean
}

export interface AutoTab {
  id: string
  /** The site (registrable domain) its habits are kept under. */
  site: string
  loaded: boolean
  frozen: boolean
  /** Shown in a window: never slept. */
  visible: boolean
  loading: boolean
  /** Never slept by Auto (audio, kept awake, agent, DevTools, keep-awake site …). */
  protected: boolean
  hiddenMs: number
  /** Its memory now, MB (an estimate is fine). */
  memoryMb: number
}

export interface AutoAction {
  kind: 'freeze' | 'discard'
  tabId: string
  reason: string
}

export interface AutoPlan {
  /** 0 = plenty free, 1 = the machine is short. */
  pressure: number
  actions: AutoAction[]
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** How short of memory the machine is, 0–1. */
export function memoryPressure(sys: AutoSystem): number {
  if (sys.totalMemoryMb <= 0) return 0
  const free = sys.availableMemoryMb / sys.totalMemoryMb
  const p = clamp01((RELAXED_FREE - free) / (RELAXED_FREE - TIGHT_FREE))
  return clamp01(p + (sys.energySaver ? 0.15 : 0))
}

export function reserveMb(sys: AutoSystem): number {
  return Math.max(RESERVE_MIN_MB, sys.totalMemoryMb * RESERVE_SHARE)
}

/** The thresholds at pressure `p` with habits as sure as `conf` (exported for the tests). */
export function autoThresholds(
  p: number,
  conf: number
): { discardBelow: number; discardAfterMs: number; freezeBelow: number; freezeAfterMs: number } {
  // Unsure → generous: a lower bar and a longer wait.
  const sure = 0.4 + 0.6 * conf
  return {
    discardBelow: lerp(0.12, 0.5, p) * sure,
    discardAfterMs: lerp(30, 3, p) * (2 - conf) * 60_000,
    freezeBelow: lerp(0.08, 0.5, p) * sure,
    freezeAfterMs: lerp(15, 1, p) * (2 - conf) * 60_000
  }
}

export function planAuto(tabs: readonly AutoTab[], sys: AutoSystem, habits: TabHabits): AutoPlan {
  const p = memoryPressure(sys)
  const conf = confidence(habits)
  const t = autoThresholds(p, conf)
  const actions: AutoAction[] = []
  const pct = Math.round(p * 100)

  const candidates = tabs
    .filter((tab) => tab.loaded && !tab.visible && !tab.protected && !tab.loading)
    .map((tab) => {
      const dist = hazards(habits, tab.site)
      return {
        tab,
        soon: conditionalReturn(dist, tab.hiddenMs, SOON_MS),
        hour: conditionalReturn(dist, tab.hiddenMs, HOUR_MS)
      }
    })

  // Below the reserve: free what is missing now, least likely to be needed first (and the
  // biggest first among equals), whatever the timers say.
  const short = reserveMb(sys) - sys.availableMemoryMb
  const taken = new Set<string>()
  if (short > 0) {
    let freed = 0
    const ranked = [...candidates].sort(
      (a, b) => a.hour - b.hour || b.tab.memoryMb - a.tab.memoryMb
    )
    for (const c of ranked) {
      if (freed >= short) break
      actions.push({ kind: 'discard', tabId: c.tab.id, reason: 'memory: the machine is low' })
      taken.add(c.tab.id)
      freed += c.tab.memoryMb
    }
  }

  for (const c of candidates) {
    if (taken.has(c.tab.id)) continue
    if (c.tab.hiddenMs >= t.discardAfterMs && c.hour < t.discardBelow) {
      actions.push({
        kind: 'discard',
        tabId: c.tab.id,
        reason: `auto: unlikely to be needed soon (${Math.round(c.hour * 100)} %, pressure ${pct} %)`
      })
    } else if (!c.tab.frozen && c.tab.hiddenMs >= t.freezeAfterMs && c.soon < t.freezeBelow) {
      actions.push({
        kind: 'freeze',
        tabId: c.tab.id,
        reason: `auto: not needed in the next minutes (${Math.round(c.soon * 100)} %)`
      })
    }
  }
  return { pressure: p, actions }
}
