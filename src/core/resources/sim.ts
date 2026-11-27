/**
 * Simulated users for the sleep policies: a day-by-day script of which tab each kind of person
 * looks at, when they are away, what plays music and what else takes the machine's memory (a
 * game, other apps), replayed against a policy that decides which hidden tabs to freeze and
 * unload. The score is what the person would feel: memory used, tabs they came back to that had
 * to load again, and time the machine spent short of memory.
 *
 * Deterministic (seeded): the same persona and seed give the same script every run, so a policy
 * change shows up as a change in numbers. `__tests__/autoSim.test.ts` holds the policies to it.
 */
import { emptyHabits, observeHidden, type TabHabits } from './habits'
import { planAuto, reserveMb, type AutoTab } from './auto'

// ---------------------------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------------------------

export type SimEvent =
  | { t: number; kind: 'show'; tab: string; site: string; mb: number; audible?: boolean }
  | { t: number; kind: 'close'; tab: string }
  | { t: number; kind: 'away'; until: number }

export interface Persona {
  name: string
  description: string
  days: number
  totalMemoryMb: number
  /** Memory the rest of the machine uses at time t (OS, other apps, a game). */
  otherMb: (t: number) => number
  script: (rng: () => number) => SimEvent[]
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const exp = (rng: () => number, mean: number): number => -Math.log(1 - rng()) * mean

function tabMb(rng: () => number, heavy = false): number {
  return Math.round(heavy ? 250 + rng() * 350 : 50 + Math.pow(rng(), 2) * 220)
}

interface TabDef {
  tab: string
  site: string
  mb: number
  audible?: boolean
}

function makeTabs(prefix: string, n: number, rng: () => number, sites = n): TabDef[] {
  return Array.from({ length: n }, (_, i) => ({
    tab: `${prefix}${i}`,
    site: `${prefix}site${i % sites}.test`,
    mb: tabMb(rng, rng() < 0.1)
  }))
}

/** Pick by Zipf weights (rank 1 most likely). */
function zipf<T>(items: readonly T[], rng: () => number, s = 1.1): T {
  let total = 0
  for (let i = 0; i < items.length; i++) total += 1 / Math.pow(i + 1, s)
  let r = rng() * total
  for (let i = 0; i < items.length; i++) {
    r -= 1 / Math.pow(i + 1, s)
    if (r <= 0) return items[i]
  }
  return items[items.length - 1]
}

const show = (t: number, d: TabDef): SimEvent => ({ t, kind: 'show', ...d })

/** Working hours each day: [start, end) in hours. */
function workdays(
  days: number,
  hours: Array<[number, number]>,
  step: (t: number, end: number, out: SimEvent[]) => number
): SimEvent[] {
  const out: SimEvent[] = []
  for (let d = 0; d < days; d++) {
    let last = d * DAY
    for (const [a, b] of hours) {
      const start = d * DAY + a * HOUR
      const end = d * DAY + b * HOUR
      if (start > last) out.push({ t: last, kind: 'away', until: start })
      let t = start
      while (t < end) t = step(t, end, out)
      last = end
    }
    out.push({ t: last, kind: 'away', until: (d + 1) * DAY })
  }
  return out.sort((x, y) => x.t - y.t)
}

const flat = (mb: number) => (): number => mb

export const PERSONAS: Persona[] = [
  {
    name: 'focused-worker',
    description:
      '4 tabs in constant use, 30 for reference, a dozen new ones a day mostly read once',
    days: 3,
    totalMemoryMb: 16_384,
    otherMb: flat(6_500),
    script: (rng) => {
      const hot = makeTabs('h', 4, rng)
      const warm = makeTabs('w', 30, rng)
      let n = 0
      return workdays(
        3,
        [
          [9, 12.5],
          [13.5, 18]
        ],
        (t, _end, out) => {
          const r = rng()
          if (r < 0.7) out.push(show(t, hot[Math.floor(rng() * hot.length)]))
          else if (r < 0.93) out.push(show(t, zipf(warm, rng)))
          else {
            const d = { tab: `n${n}`, site: `news${n % 40}.test`, mb: tabMb(rng) }
            n++
            out.push(show(t, d))
            if (rng() < 0.5)
              out.push({ t: t + 4 * HOUR + exp(rng, 4 * HOUR), kind: 'close', tab: d.tab })
          }
          return t + exp(rng, 3 * MIN)
        }
      )
    }
  },
  {
    name: 'tab-hoarder',
    description: '150 tabs kept open for weeks, a few dozen of them visited regularly',
    days: 3,
    totalMemoryMb: 16_384,
    otherMb: flat(5_000),
    script: (rng) => {
      const tabs = makeTabs('t', 150, rng, 90)
      return workdays(
        3,
        [
          [9, 13],
          [14, 22]
        ],
        (t, _e, out) => {
          out.push(show(t, zipf(tabs, rng, 1.05)))
          return t + exp(rng, 4 * MIN)
        }
      )
    }
  },
  {
    name: 'researcher',
    description: 'opens bursts of 10–15 search results, reads each once, rarely goes back',
    days: 2,
    totalMemoryMb: 16_384,
    otherMb: flat(6_000),
    script: (rng) => {
      const base = makeTabs('b', 6, rng)
      let n = 0
      let burst: TabDef[] = []
      return workdays(2, [[9, 18]], (t, _e, out) => {
        if (burst.length === 0 || rng() < 0.08) {
          burst = Array.from({ length: 10 + Math.floor(rng() * 6) }, () => ({
            tab: `r${n++}`,
            site: `paper${Math.floor(rng() * 200)}.test`,
            mb: tabMb(rng)
          }))
        }
        const r = rng()
        if (r < 0.35) out.push(show(t, base[Math.floor(rng() * base.length)]))
        else out.push(show(t, burst.shift() ?? base[0]))
        return t + exp(rng, 2.5 * MIN)
      })
    }
  },
  {
    name: 'music-while-working',
    description: 'a music tab playing in the background all day, plus 25 work tabs',
    days: 2,
    totalMemoryMb: 16_384,
    otherMb: flat(7_000),
    script: (rng) => {
      const music: TabDef = { tab: 'music', site: 'music.test', mb: 350, audible: true }
      const work = makeTabs('m', 25, rng)
      return workdays(2, [[9, 18]], (t, _e, out) => {
        if (rng() < 0.02) out.push(show(t, music))
        else out.push(show(t, zipf(work, rng, 0.9)))
        return t + exp(rng, 4 * MIN)
      })
    }
  },
  {
    name: 'gamer',
    description: 'light browsing by day; in the evening a game takes 11 GB of 16 for hours',
    days: 2,
    totalMemoryMb: 16_384,
    otherMb: (t) => {
      const h = (t % DAY) / HOUR
      return h >= 19 && h < 23 ? 14_500 : 5_000
    },
    script: (rng) => {
      const tabs = makeTabs('g', 25, rng)
      const chat: TabDef = { tab: 'chat', site: 'chat.test', mb: 300, audible: true }
      return workdays(2, [[12, 19]], (t, end, out) => {
        out.push(show(t, rng() < 0.1 ? chat : zipf(tabs, rng)))
        if (end - t < 10 * MIN) out.push(show(end - 5 * MIN, chat))
        return t + exp(rng, 5 * MIN)
      })
    }
  },
  {
    name: 'away-for-hours',
    description: 'works two hours, away six, comes back to the same three tabs',
    days: 3,
    totalMemoryMb: 16_384,
    otherMb: flat(6_000),
    script: (rng) => {
      const main = makeTabs('a', 3, rng)
      const rest = makeTabs('ar', 40, rng)
      return workdays(
        3,
        [
          [8, 10],
          [16, 18]
        ],
        (t, _e, out) => {
          out.push(show(t, rng() < 0.75 ? main[Math.floor(rng() * 3)] : zipf(rest, rng)))
          return t + exp(rng, 4 * MIN)
        }
      )
    }
  },
  {
    name: 'low-ram-laptop',
    description: '8 GB laptop, other apps using 4.5 GB, 30 tabs in moderate use',
    days: 2,
    totalMemoryMb: 8_192,
    otherMb: flat(4_500),
    script: (rng) => {
      const tabs = makeTabs('l', 30, rng)
      return workdays(2, [[9, 18]], (t, _e, out) => {
        out.push(show(t, zipf(tabs, rng)))
        return t + exp(rng, 3 * MIN)
      })
    }
  },
  {
    name: 'big-desktop',
    description: '64 GB desktop, 60 tabs used broadly through the day',
    days: 2,
    totalMemoryMb: 65_536,
    otherMb: flat(14_000),
    script: (rng) => {
      const tabs = makeTabs('d', 60, rng)
      return workdays(2, [[9, 20]], (t, _e, out) => {
        out.push(show(t, zipf(tabs, rng, 0.8)))
        return t + exp(rng, 2 * MIN)
      })
    }
  },
  {
    name: 'dozens-active',
    description: '30 tabs all in use, each visited every 15–40 minutes, on a 32 GB machine',
    days: 2,
    totalMemoryMb: 32_768,
    otherMb: flat(9_000),
    script: (rng) => {
      const tabs = makeTabs('x', 30, rng)
      return workdays(2, [[9, 19]], (t, _e, out) => {
        out.push(show(t, tabs[Math.floor(rng() * tabs.length)]))
        return t + exp(rng, 1 * MIN)
      })
    }
  },
  {
    name: 'dashboards',
    description: '8 dashboards checked every half hour or so, plus everyday browsing',
    days: 2,
    totalMemoryMb: 16_384,
    otherMb: flat(6_500),
    script: (rng) => {
      const dash = makeTabs('db', 8, rng)
      const misc = makeTabs('dm', 20, rng)
      let next = 0
      return workdays(2, [[8, 18]], (t, _e, out) => {
        if (t >= next) {
          for (const d of dash) out.push(show((t += 20_000), d))
          next = t + 25 * MIN + exp(rng, 10 * MIN)
        } else out.push(show(t, zipf(misc, rng)))
        return t + exp(rng, 3 * MIN)
      })
    }
  }
]

// ---------------------------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------------------------

export interface SimTab extends TabDef {
  loaded: boolean
  frozen: boolean
  visible: boolean
  hiddenAt: number
  /** Time hidden already reported to the policy's habits. */
  reportedMs: number
  keepAwake?: boolean
}

export interface SimContext {
  now: number
  totalMemoryMb: number
  availableMemoryMb: number
  browserMb: number
  idleMs: number
  tabs: SimTab[]
}

export interface SimPolicy {
  name: string
  /** A hidden tab's time hidden grew from `fromMs` to `toMs`; `returned`: it was shown again. */
  observe?: (site: string, fromMs: number, toMs: number, returned: boolean, now: number) => void
  decide: (ctx: SimContext) => Array<{ kind: 'freeze' | 'discard'; tab: string }>
}

const isProtected = (t: SimTab): boolean => Boolean(t.audible || t.keepAwake)

/** Never sleep anything. */
export const keepAll: SimPolicy = { name: 'never sleep', decide: () => [] }

/**
 * Zenium's fixed defaults before Auto: freeze after 5 min hidden, unload after 20, at most 24
 * live pages, a budget of 35 % of RAM, every hidden tab frozen after 10 min of system idle.
 */
export const fixedDefaults: SimPolicy = {
  name: 'fixed timers (old default)',
  decide: (ctx) => {
    const out: Array<{ kind: 'freeze' | 'discard'; tab: string }> = []
    const hidden = ctx.tabs.filter((t) => t.loaded && !t.visible && !isProtected(t))
    for (const t of hidden) {
      const h = ctx.now - t.hiddenAt
      if (h >= 20 * MIN) out.push({ kind: 'discard', tab: t.tab })
      else if (!t.frozen && (h >= 5 * MIN || ctx.idleMs >= 10 * MIN))
        out.push({ kind: 'freeze', tab: t.tab })
    }
    const gone = new Set(out.filter((a) => a.kind === 'discard').map((a) => a.tab))
    const live = ctx.tabs.filter((t) => t.loaded && !gone.has(t.tab))
    const oldest = hidden.filter((t) => !gone.has(t.tab)).sort((a, b) => a.hiddenAt - b.hiddenAt)
    let count = live.length
    let mb = ctx.browserMb
    const budget = ctx.totalMemoryMb * 0.35
    for (const t of oldest) {
      if (count <= 24 && mb <= budget) break
      out.push({ kind: 'discard', tab: t.tab })
      count--
      mb -= t.mb
    }
    return out
  }
}

/** Auto, with the person's habits learned as they go (or frozen at the prior). */
export function autoPolicy(learn: boolean): SimPolicy & { habits: TabHabits } {
  const habits = emptyHabits(0)
  return {
    name: learn ? 'auto' : 'auto, not learning',
    habits,
    observe: learn
      ? (site, from, to, returned, now) => observeHidden(habits, site, from, to, returned, now)
      : undefined,
    decide: (ctx) => {
      const tabs: AutoTab[] = ctx.tabs.map((t) => ({
        id: t.tab,
        site: t.site,
        loaded: t.loaded,
        frozen: t.frozen,
        visible: t.visible,
        loading: false,
        protected: isProtected(t),
        hiddenMs: t.visible ? 0 : ctx.now - t.hiddenAt,
        memoryMb: t.frozen ? t.mb * FROZEN_SHARE : t.mb
      }))
      const plan = planAuto(
        tabs,
        {
          totalMemoryMb: ctx.totalMemoryMb,
          availableMemoryMb: ctx.availableMemoryMb,
          energySaver: false
        },
        habits
      )
      const out = plan.actions.map((a) => ({ kind: a.kind, tab: a.tabId }))
      // The planner's idle rule stays: everything hidden freezes after 10 min of system idle.
      if (ctx.idleMs >= 10 * MIN)
        for (const t of ctx.tabs)
          if (t.loaded && !t.visible && !t.frozen && !isProtected(t))
            out.push({ kind: 'freeze', tab: t.tab })
      return out
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

/** A frozen page keeps most of its memory (after the purge before the freeze). */
export const FROZEN_SHARE = 0.85
/** The browser's own processes (main, GPU, network). */
export const BROWSER_BASE_MB = 350
const STEP = MIN

export interface SimResult {
  persona: string
  policy: string
  /** Mean memory of the browser while the person was there, MB. */
  avgMb: number
  peakMb: number
  /** Mean memory of the browser while the person was away, MB. */
  awayMb: number
  /** Switches to a tab that had been unloaded (it loads again). */
  reloads: number
  /** Of those, the tab had been hidden under an hour: the most annoying. */
  quickReloads: number
  /** Switches to a frozen tab (it wakes at once). */
  wakes: number
  /** Minutes the machine had less free memory than its reserve. */
  shortMinutes: number
  /** A tab playing audio was unloaded. */
  audioStopped: number
  switches: number
}

export function simulate(persona: Persona, policy: SimPolicy, seed = 1): SimResult {
  const events = persona.script(mulberry32(seed))
  const tabs = new Map<string, SimTab>()
  let visible: SimTab | null = null
  const r: SimResult = {
    persona: persona.name,
    policy: policy.name,
    avgMb: 0,
    peakMb: 0,
    awayMb: 0,
    reloads: 0,
    quickReloads: 0,
    wakes: 0,
    shortMinutes: 0,
    audioStopped: 0,
    switches: 0
  }
  let awayUntil = 0
  let lastInput = 0
  let sumMb = 0
  let samples = 0
  let awaySum = 0
  let awaySamples = 0
  const end = persona.days * DAY
  let i = 0
  const browserMb = (): number => {
    let mb = BROWSER_BASE_MB
    for (const t of tabs.values()) if (t.loaded) mb += t.frozen ? t.mb * FROZEN_SHARE : t.mb
    return mb
  }
  for (let now = 0; now < end; now += STEP) {
    while (i < events.length && events[i].t < now + STEP) {
      const e = events[i++]
      if (e.kind === 'away') {
        awayUntil = e.until
        continue
      }
      lastInput = e.t
      if (e.kind === 'close') {
        const t = tabs.get(e.tab)
        if (t && !t.visible) tabs.delete(e.tab)
        continue
      }
      let t = tabs.get(e.tab)
      if (t === visible) continue
      r.switches++
      if (!t) {
        t = { ...e, loaded: true, frozen: false, visible: false, hiddenAt: e.t, reportedMs: 0 }
        tabs.set(e.tab, t)
      } else {
        policy.observe?.(t.site, t.reportedMs, e.t - t.hiddenAt, true, e.t)
        if (!t.loaded) {
          r.reloads++
          if (e.t - t.hiddenAt < HOUR) r.quickReloads++
          t.loaded = true
        } else if (t.frozen) r.wakes++
        t.frozen = false
      }
      if (visible) {
        visible.visible = false
        visible.hiddenAt = e.t
        visible.reportedMs = 0
      }
      t.visible = true
      visible = t
    }
    // Time hidden grows: report it, every few minutes, as the governor does.
    if (policy.observe && now % (5 * MIN) === 0)
      for (const t of tabs.values())
        if (!t.visible) {
          const h = now - t.hiddenAt
          policy.observe(t.site, t.reportedMs, h, false, now)
          t.reportedMs = h
        }
    const mb = browserMb()
    const available = persona.totalMemoryMb - persona.otherMb(now) - mb
    const ctx: SimContext = {
      now,
      totalMemoryMb: persona.totalMemoryMb,
      availableMemoryMb: available,
      browserMb: mb,
      idleMs: now - lastInput,
      tabs: [...tabs.values()]
    }
    for (const a of policy.decide(ctx)) {
      const t = tabs.get(a.tab)
      if (!t || t.visible || !t.loaded) continue
      if (a.kind === 'discard') {
        if (t.audible) r.audioStopped++
        t.loaded = false
        t.frozen = false
      } else t.frozen = true
    }
    const after = browserMb()
    const free = persona.totalMemoryMb - persona.otherMb(now) - after
    if (
      free <
      reserveMb({
        totalMemoryMb: persona.totalMemoryMb,
        availableMemoryMb: free,
        energySaver: false
      })
    )
      r.shortMinutes += STEP / MIN
    if (now >= awayUntil) {
      sumMb += after
      samples++
    } else {
      awaySum += after
      awaySamples++
    }
    r.peakMb = Math.max(r.peakMb, after)
  }
  r.avgMb = Math.round(sumMb / Math.max(1, samples))
  r.peakMb = Math.round(r.peakMb)
  r.awayMb = Math.round(awaySum / Math.max(1, awaySamples))
  return r
}

export function policies(): SimPolicy[] {
  return [keepAll, fixedDefaults, autoPolicy(false), autoPolicy(true)]
}

/** Every persona under every policy, as a Markdown table. */
export function report(seed = 1): { results: SimResult[]; markdown: string } {
  const results: SimResult[] = []
  for (const p of PERSONAS) for (const pol of policies()) results.push(simulate(p, pol, seed))
  const rows = results.map(
    (x) =>
      `| ${x.persona} | ${x.policy} | ${x.avgMb.toLocaleString('en-US')} | ${x.awayMb.toLocaleString('en-US')} | ${x.peakMb.toLocaleString('en-US')} | ${x.reloads} (${x.quickReloads}) | ${x.wakes} | ${x.shortMinutes} | ${x.audioStopped} |`
  )
  return {
    results,
    markdown: [
      '| Person | Policy | MB in use | MB while away | Peak MB | Reloads (under 1 h) | Wakes | Minutes short | Audio stopped |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows
    ].join('\n')
  }
}
