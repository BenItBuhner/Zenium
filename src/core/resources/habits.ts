/**
 * Tab habits: how long this person leaves a site's tabs in the background before coming back to
 * them, learned on the device from their own switching (Auto memory mode, `auto.ts`).
 *
 * The model is a survival curve over "time hidden", per site and over all sites, in buckets of
 * `GAP_BUCKETS_MIN`. For each bucket it counts the tabs that came back during it (`returned`) and
 * the tabs that went through it still hidden (`stayed`) – so a tab left open and never looked at
 * again teaches as much as one that comes back, without waiting for it to be closed. The chance
 * of coming back during a bucket is returned / (returned + stayed); `returnChance` chains them:
 * having been hidden this long already, how likely is the tab to be shown again within the next
 * while? Older evidence fades (`HABITS_HALF_LIFE_DAYS`).
 *
 * It starts from a generous prior (tabs come back, often within the hour), so on a new profile
 * Auto keeps tabs live; the person's own evidence outweighs the prior within a few hundred
 * observations – about a day of use. A site with little evidence of its own leans on the
 * person's overall habits (shrinkage, `SITE_PRIOR_WEIGHT`).
 *
 * Plain data, small (at most `MAX_SITES` sites), kept per device. Nothing here leaves the
 * machine; the shape is ready to be merged with another device's (`mergeHabits`) when profiles
 * sync, each device keeping its own and borrowing only a little from the others.
 */

/** Upper bounds of the buckets of time hidden, in minutes. */
export const GAP_BUCKETS_MIN: readonly number[] = [1, 3, 10, 30, 60, 180, 480, 1440, 4320]
const B = GAP_BUCKETS_MIN.length

/** Evidence older than this counts half. */
export const HABITS_HALF_LIFE_DAYS = 14
/** Sites remembered at most (the least used are forgotten first). */
export const MAX_SITES = 400
/** How many observations' worth of the person's overall habits a site starts from. */
export const SITE_PRIOR_WEIGHT = 6
/** The starting prior's weight, in observations per bucket. */
export const PRIOR_WEIGHT = 12

/**
 * The generous starting belief: the chance a tab still hidden at the start of each bucket comes
 * back during it.
 */
export const GENEROUS_PRIOR_HAZARD: readonly number[] = [
  0.25, 0.25, 0.3, 0.35, 0.35, 0.4, 0.4, 0.5, 0.5
]

export interface GapCounts {
  /** Decayed counts per bucket: tabs that came back during it. */
  returned: number[]
  /** Decayed counts per bucket: tabs that went through it still hidden. */
  stayed: number[]
  /** When the counts were last decayed (epoch ms). */
  at: number
}

export interface TabHabits {
  version: 2
  all: GapCounts
  sites: Record<string, GapCounts>
}

export function emptyHabits(now = 0): TabHabits {
  return { version: 2, all: emptyCounts(now), sites: {} }
}

function emptyCounts(at: number): GapCounts {
  return { returned: new Array<number>(B).fill(0), stayed: new Array<number>(B).fill(0), at }
}

function bucketOf(ms: number): number {
  const min = ms / 60_000
  const i = GAP_BUCKETS_MIN.findIndex((b) => min <= b)
  return i === -1 ? B : i
}

function decay(c: GapCounts, now: number): void {
  if (now <= c.at) return
  const f = Math.pow(0.5, (now - c.at) / 86_400_000 / HABITS_HALF_LIFE_DAYS)
  for (let i = 0; i < B; i++) {
    c.returned[i] *= f
    c.stayed[i] *= f
  }
  c.at = now
}

function weight(c: GapCounts): number {
  let t = 0
  for (let i = 0; i < B; i++) t += c.returned[i] + c.stayed[i]
  return t
}

/**
 * A hidden tab of `site` went from `fromMs` to `toMs` hidden: every bucket it went through still
 * hidden counts as "stayed", and with `returned` the bucket of `toMs` counts its return. Call it
 * as a tab's time hidden grows (any step size) and once more when it is shown; a tab closed
 * while hidden simply stops being reported. Returns under a few seconds are tab-strip flicking
 * and are not recorded.
 */
export function observeHidden(
  habits: TabHabits,
  site: string,
  fromMs: number,
  toMs: number,
  returned: boolean,
  now: number
): void {
  if (returned && toMs < 5_000) return
  const targets = [habits.all]
  let added = false
  if (site) {
    let c = habits.sites[site]
    if (!c) {
      c = emptyCounts(now)
      habits.sites[site] = c
      added = true
    }
    targets.push(c)
  }
  const from = bucketOf(Math.max(0, fromMs))
  const to = bucketOf(toMs)
  for (const c of targets) {
    decay(c, now)
    // The buckets that ended between the two reports.
    for (let i = from; i < Math.min(to, B); i++) c.stayed[i] += 1
    if (returned && to < B) c.returned[to] += 1
  }
  // A new site joins after its first evidence, so it is not the first to be forgotten.
  if (added) pruneSites(habits)
}

function pruneSites(habits: TabHabits): void {
  const names = Object.keys(habits.sites)
  if (names.length <= MAX_SITES) return
  names
    .sort((a, b) => weight(habits.sites[a]) - weight(habits.sites[b]))
    .slice(0, names.length - MAX_SITES)
    .forEach((n) => delete habits.sites[n])
}

/** Per bucket, the chance a tab of `site` still hidden at its start comes back during it. */
export function hazards(habits: TabHabits, site: string): number[] {
  const all = habits.all
  const own = site ? habits.sites[site] : undefined
  const out: number[] = []
  for (let i = 0; i < B; i++) {
    const pr = GENEROUS_PRIOR_HAZARD[i] * PRIOR_WEIGHT
    const ret = all.returned[i] + pr
    const n = all.returned[i] + all.stayed[i] + PRIOR_WEIGHT
    const overall = ret / n
    if (!own) {
      out.push(overall)
      continue
    }
    out.push(
      (own.returned[i] + overall * SITE_PRIOR_WEIGHT) /
        (own.returned[i] + own.stayed[i] + SITE_PRIOR_WEIGHT)
    )
  }
  return out
}

/** How much evidence the habits rest on (0 = only the prior, 1 = plenty). */
export function confidence(habits: TabHabits): number {
  return Math.min(1, weight(habits.all) / 400)
}

/** The chance of still being hidden at `tMs` (log time within a bucket). */
function survival(h: readonly number[], tMs: number): number {
  const t = Math.max(tMs / 60_000, 0)
  let s = 1
  let lower = 0
  for (let i = 0; i < B; i++) {
    const upper = GAP_BUCKETS_MIN[i]
    if (t >= upper) s *= 1 - h[i]
    else {
      if (t > lower) {
        const lo = Math.log(Math.max(lower, 0.25))
        const frac = Math.min(1, Math.max(0, (Math.log(t) - lo) / (Math.log(upper) - lo)))
        s *= Math.pow(1 - h[i], frac)
      }
      return s
    }
    lower = upper
  }
  // Past the last bucket: the last bucket's rate per its length, kept going.
  const last = GAP_BUCKETS_MIN[B - 1]
  return s * Math.pow(1 - h[B - 1], Math.log(t / last) / Math.log(last / GAP_BUCKETS_MIN[B - 2]))
}

/**
 * The chance a tab with these hazards, hidden for `hiddenMs` so far, is shown again within the
 * next `withinMs`.
 */
export function conditionalReturn(
  h: readonly number[],
  hiddenMs: number,
  withinMs: number
): number {
  const now = survival(h, hiddenMs)
  if (now <= 1e-9) return 0
  return Math.max(0, Math.min(1, 1 - survival(h, hiddenMs + withinMs) / now))
}

export function returnChance(
  habits: TabHabits,
  site: string,
  hiddenMs: number,
  withinMs: number
): number {
  return conditionalReturn(hazards(habits, site), hiddenMs, withinMs)
}

/**
 * Another device's habits folded in lightly: its evidence counts `share` (0–1) of this
 * device's, so each device keeps its own patterns and borrows a little from the others.
 */
export function mergeHabits(
  mine: TabHabits,
  other: TabHabits,
  share: number,
  now: number
): TabHabits {
  const w = Math.max(0, Math.min(1, share))
  const out = sanitizeHabits(JSON.parse(JSON.stringify(mine)), now)
  const theirs = sanitizeHabits(JSON.parse(JSON.stringify(other)), now)
  const add = (a: GapCounts, b: GapCounts): void => {
    decay(a, now)
    decay(b, now)
    for (let i = 0; i < B; i++) {
      a.returned[i] += w * b.returned[i]
      a.stayed[i] += w * b.stayed[i]
    }
  }
  add(out.all, theirs.all)
  for (const [site, c] of Object.entries(theirs.sites)) {
    const own = out.sites[site] ?? emptyCounts(now)
    add(own, c)
    out.sites[site] = own
  }
  pruneSites(out)
  return out
}

/** A stored value read back: anything malformed becomes empty habits. */
export function sanitizeHabits(raw: unknown, now: number): TabHabits {
  const okArr = (a: unknown): a is number[] =>
    Array.isArray(a) &&
    a.length === B &&
    a.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
  const okCounts = (c: unknown): c is GapCounts =>
    typeof c === 'object' &&
    c !== null &&
    okArr((c as GapCounts).returned) &&
    okArr((c as GapCounts).stayed) &&
    typeof (c as GapCounts).at === 'number'
  const r = raw as Partial<TabHabits> | null
  if (!r || r.version !== 2 || !okCounts(r.all)) return emptyHabits(now)
  const sites: Record<string, GapCounts> = {}
  for (const [k, v] of Object.entries(r.sites ?? {})) if (okCounts(v)) sites[k] = v
  const out: TabHabits = { version: 2, all: r.all, sites }
  pruneSites(out)
  return out
}
