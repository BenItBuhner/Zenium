/**
 * The resource governor's brain: pure functions that turn a sample of Chromium's processes and
 * the browser's tabs into a plan of actions that keeps the browser under the user's budgets.
 *
 * Nothing in here touches Electron, so every rule is unit tested. The `ResourceGovernor` service
 * feeds it `app.getAppMetrics()` and executes the plan.
 *
 * Escalation ladders (cheapest / least visible first):
 *   memory: purge (memory-pressure + GC)  →  discard hidden tabs by score  →  purge visible tabs
 *           →  reload the active tab when it alone busts the budget (extreme)
 *   cpu:    throttle hidden tabs 4× → 8× → 16×  →  freeze  →  discard frozen tabs still burning CPU
 *           →  throttle visible panes (strict) / the active tab (extreme)
 *   gpu:    pause muted background media  →  purge  →  discard one hidden tab per cycle
 * Time-based rules (freeze after N minutes hidden, unload after M minutes, idle freeze) and the
 * live-page cap run regardless of pressure.
 */
import type {
  GovernorActionKind,
  ResourceGauge,
  ResourceKind,
  ResourceSettings,
  TabResourceUsage
} from '../../../shared/types'

export type ProcessKind =
  | 'Browser'
  | 'Tab'
  | 'Utility'
  | 'Zygote'
  | 'Sandbox helper'
  | 'GPU'
  | 'Pepper Plugin'
  | 'Pepper Plugin Broker'
  | 'Unknown'

export interface ProcessSample {
  pid: number
  type: ProcessKind
  /** Working set in MB. */
  memoryMb: number
  /** Percent of one core since the previous sample (100 = a full core), as Chromium reports it. */
  cpuPercent: number
}

export interface TabSample {
  id: string
  title: string
  /** OS pids of the main-frame renderer and every out-of-process iframe. */
  pids: number[]
  /** Has a live WebContents. */
  loaded: boolean
  /** Shown in the content area: the active tab, its split panes, a Glance page and its parent. */
  visible: boolean
  /** The active tab of the active space. */
  active: boolean
  audible: boolean
  /** Media element playing (audible or not). */
  mediaPlaying: boolean
  loading: boolean
  pinned: boolean
  essential: boolean
  /** Domain listed under "never unload these domains". */
  excluded: boolean
  devtoolsOpen: boolean
  frozen: boolean
  cpuThrottle: number
  lastActiveAt: number
  /** Last governor purge of this tab (0 = never). */
  lastPurgedAt: number
  /** Last governor throttle change on this tab (0 = never). */
  lastThrottledAt: number
}

export interface SystemSample {
  totalMemoryMb: number
  cpuCount: number
  onBattery: boolean
  /** Seconds since the last user input anywhere on the system. */
  idleSeconds: number
  windowMinimized: boolean
}

/** Streak counters carried from one sample to the next (hysteresis). */
export interface PlannerMemory {
  overStreak: Record<ResourceKind, number>
  underStreak: Record<ResourceKind, number>
  /** Consecutive samples in which the active tab by itself exceeded the memory budget. */
  activeOverStreak: number
}

export interface PlannerInput {
  now: number
  settings: ResourceSettings
  /** Zen's "unload inactive tabs" timer – the discard-after rule. */
  unload: { enabled: boolean; timeoutMinutes: number }
  system: SystemSample
  processes: ProcessSample[]
  tabs: TabSample[]
  memory: PlannerMemory
  /** Plan as if every budget were exceeded ("free up memory now"). */
  force?: boolean
}

export interface PlannedAction {
  kind: GovernorActionKind
  tabId: string
  title: string
  reason: string
  /** New CPU throttling factor for `throttle` / `unthrottle`. */
  rate?: number
}

export interface Attribution {
  usage: TabResourceUsage[]
  /** Memory of processes not attributable to any tab (browser, GPU, network, utility …). */
  overheadMb: number
  totalMemoryMb: number
  /** Percent of the whole machine (all cores together = 100). */
  totalCpuPercent: number
  gpuMemoryMb: number
}

export interface Plan {
  gauges: Record<ResourceKind, ResourceGauge>
  attribution: Attribution
  pressure: ResourceKind[]
  actions: PlannedAction[]
  memory: PlannerMemory
  idle: boolean
}

export const THROTTLE_STEPS = [1, 4, 8, 16] as const
/** Do not purge the same tab more often than this. */
export const PURGE_COOLDOWN_MS = 60_000
/** Do not change a tab's throttle more often than this. */
export const THROTTLE_COOLDOWN_MS = 10_000
/** Discard until projected usage is this far under budget so the next sample is not over again. */
export const DISCARD_TARGET = 0.85
/** Usage below this fraction of the budget counts as "comfortably under" and relaxes throttles. */
export const RELAX_BELOW = 0.6
/** Tabs using less than this share of the machine are not worth throttling. */
const NEGLIGIBLE_CPU = 0.5
export const MIN_LOADED_TABS = 2
export const MAX_RECENT_ACTIONS = 40

export function emptyPlannerMemory(): PlannerMemory {
  return {
    overStreak: { memory: 0, cpu: 0, gpu: 0 },
    underStreak: { memory: 0, cpu: 0, gpu: 0 },
    activeOverStreak: 0
  }
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** Effective budgets (0 = unlimited) after battery tightening. */
export function deriveBudgets(
  settings: ResourceSettings,
  system: Pick<SystemSample, 'totalMemoryMb' | 'onBattery'>
): Record<ResourceKind, Omit<ResourceGauge, 'used'>> {
  const factor = system.onBattery ? clamp(settings.batteryFactor, 0.25, 1) : 1
  const memory =
    settings.memoryMb > 0
      ? Math.round(settings.memoryMb)
      : Math.round((system.totalMemoryMb * clamp(settings.memoryPercent, 5, 100)) / 100)
  const cpu = settings.cpuPercent >= 100 || settings.cpuPercent <= 0 ? 0 : settings.cpuPercent
  const gpu = settings.gpuMemoryMb > 0 ? Math.round(settings.gpuMemoryMb) : 0
  const tighten = (configured: number): Omit<ResourceGauge, 'used'> => ({
    configured,
    budget: configured > 0 ? Math.max(1, Math.round(configured * factor)) : 0
  })
  return { memory: tighten(memory), cpu: tighten(cpu), gpu: tighten(gpu) }
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * Split every process's memory and CPU across the tabs that own it. Chromium may put several
 * same-site tabs into one renderer, and a tab may span several processes (out-of-process
 * iframes), so ownership is many-to-many and shared processes are divided evenly.
 */
export function attribute(
  processes: ProcessSample[],
  tabs: TabSample[],
  cpuCount: number
): Attribution {
  const owners = new Map<number, string[]>()
  for (const tab of tabs) {
    if (!tab.loaded) continue
    for (const pid of new Set(tab.pids)) {
      const list = owners.get(pid)
      if (list) list.push(tab.id)
      else owners.set(pid, [tab.id])
    }
  }
  const perTab = new Map<string, TabResourceUsage>()
  for (const tab of tabs) {
    perTab.set(tab.id, { tabId: tab.id, memoryMb: 0, cpuPercent: 0, processes: 0 })
  }
  const cores = Math.max(1, cpuCount)
  let overheadMb = 0
  let totalMemoryMb = 0
  let totalCpuRaw = 0
  let gpuMemoryMb = 0
  for (const proc of processes) {
    totalMemoryMb += proc.memoryMb
    totalCpuRaw += proc.cpuPercent
    if (proc.type === 'GPU') gpuMemoryMb += proc.memoryMb
    const ids = owners.get(proc.pid)
    if (!ids || ids.length === 0) {
      overheadMb += proc.memoryMb
      continue
    }
    const share = 1 / ids.length
    for (const id of ids) {
      const usage = perTab.get(id)!
      usage.memoryMb += proc.memoryMb * share
      usage.cpuPercent += (proc.cpuPercent * share) / cores
      usage.processes += 1
    }
  }
  const usage = [...perTab.values()].map((u) => ({
    ...u,
    memoryMb: round1(u.memoryMb),
    cpuPercent: round1(u.cpuPercent)
  }))
  return {
    usage,
    overheadMb: round1(overheadMb),
    totalMemoryMb: round1(totalMemoryMb),
    totalCpuPercent: round1(totalCpuRaw / cores),
    gpuMemoryMb: round1(gpuMemoryMb)
  }
}

// ---------------------------------------------------------------------------
// Eligibility & ranking
// ---------------------------------------------------------------------------

/** Why a tab must be left alone, or null when the governor may act on it. */
export function protectionReason(tab: TabSample, settings: ResourceSettings): string | null {
  if (tab.excluded) return 'excluded domain'
  if (tab.devtoolsOpen) return 'devtools open'
  if (tab.audible && settings.protectAudible) return 'playing audio'
  if (tab.pinned && settings.protectPinned) return 'pinned'
  if (tab.essential && settings.protectEssentials) return 'essential'
  return null
}

/**
 * How good a victim a tab is for a given resource: the more it costs and the longer it has been
 * out of sight, the higher the score. Pinned / essential tabs score half so regular tabs go first.
 */
export function victimScore(
  tab: TabSample,
  usage: TabResourceUsage | undefined,
  kind: ResourceKind,
  now: number
): number {
  const cost = kind === 'cpu' ? (usage?.cpuPercent ?? 0) : (usage?.memoryMb ?? 0)
  const ageMinutes = Math.max(0, now - tab.lastActiveAt) / 60_000
  const ageFactor = 0.5 + Math.min(ageMinutes, 60) / 15
  const importance = tab.pinned || tab.essential ? 0.5 : 1
  return (cost + 1) * ageFactor * importance
}

export function nextThrottle(current: number): number {
  for (const step of THROTTLE_STEPS) if (step > current) return step
  return THROTTLE_STEPS[THROTTLE_STEPS.length - 1]
}

export function previousThrottle(current: number): number {
  let prev: number = THROTTLE_STEPS[0]
  for (const step of THROTTLE_STEPS) {
    if (step >= current) return prev
    prev = step
  }
  return prev
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export function plan(input: PlannerInput): Plan {
  const { now, settings, system, tabs } = input
  const budgets = deriveBudgets(settings, system)
  const attribution = attribute(input.processes, tabs, system.cpuCount)
  const gauges: Record<ResourceKind, ResourceGauge> = {
    memory: { ...budgets.memory, used: attribution.totalMemoryMb },
    cpu: { ...budgets.cpu, used: attribution.totalCpuPercent },
    gpu: { ...budgets.gpu, used: attribution.gpuMemoryMb }
  }
  const memory = advanceStreaks(input.memory, gauges)
  const usageById = new Map(attribution.usage.map((u) => [u.tabId, u]))
  const idle =
    settings.idleFreezeMinutes > 0 && system.idleSeconds >= settings.idleFreezeMinutes * 60
  const pressure: ResourceKind[] = []
  if (settings.enabled) {
    for (const kind of ['memory', 'cpu', 'gpu'] as ResourceKind[]) {
      const g = gauges[kind]
      if (input.force || (g.budget > 0 && g.used > g.budget)) pressure.push(kind)
    }
  }
  const plan: Plan = { gauges, attribution, pressure, actions: [], memory, idle }
  if (!settings.enabled) return plan

  const acted = new Set<string>()
  const act = (tab: TabSample, kind: GovernorActionKind, reason: string, rate?: number): void => {
    acted.add(tab.id)
    plan.actions.push({ kind, tabId: tab.id, title: tab.title, reason, rate })
  }
  const loaded = tabs.filter((t) => t.loaded)
  const hidden = loaded.filter((t) => !t.visible)
  const visible = loaded.filter((t) => t.visible)
  const visibleInactive = visible.filter((t) => !t.active)
  const activeTab = visible.find((t) => t.active)
  const extreme = settings.enforcement === 'extreme'
  const touchVisible = settings.enforcement !== 'balanced'
  // Extreme enforcement puts even the visible pages to sleep while nobody can see them.
  const freezeVisibleWhenIdle = extreme && (idle || system.windowMinimized)

  // --- visible tabs must be awake (unless nobody is looking and enforcement is extreme) -------
  for (const tab of visible) {
    if (tab.frozen && !freezeVisibleWhenIdle) act(tab, 'thaw', 'tab is visible')
  }

  // --- time-based rules ---------------------------------------------------------------------
  const unloadAfter = input.unload.enabled ? input.unload.timeoutMinutes * 60_000 : Infinity
  const freezeAfter = settings.freezeAfterMinutes * 60_000
  for (const tab of hidden) {
    if (acted.has(tab.id) || protectionReason(tab, settings)) continue
    const hiddenFor = now - tab.lastActiveAt
    if (hiddenFor >= unloadAfter && !tab.loading) {
      act(tab, 'discard', `hidden for ${formatMinutes(hiddenFor)}`)
    } else if (!tab.frozen && !tab.loading) {
      if (idle) act(tab, 'freeze', `system idle for ${formatMinutes(system.idleSeconds * 1000)}`)
      else if (system.windowMinimized && hiddenFor >= Math.min(freezeAfter, 60_000))
        act(tab, 'freeze', 'window minimised')
      else if (hiddenFor >= freezeAfter)
        act(tab, 'freeze', `hidden for ${formatMinutes(hiddenFor)}`)
    }
  }
  if (freezeVisibleWhenIdle) {
    for (const tab of visible) {
      if (acted.has(tab.id) || tab.frozen || tab.loading || protectionReason(tab, settings))
        continue
      act(
        tab,
        'freeze',
        idle ? `system idle for ${formatMinutes(system.idleSeconds * 1000)}` : 'window minimised'
      )
    }
  }

  // --- live page cap -------------------------------------------------------------------------
  const cap = settings.maxLoadedTabs > 0 ? Math.max(MIN_LOADED_TABS, settings.maxLoadedTabs) : 0
  if (cap > 0) {
    let live = loaded.length - plan.actions.filter((a) => a.kind === 'discard').length
    for (const tab of rankVictims(hidden, usageById, 'memory', now, settings, acted)) {
      if (live <= cap) break
      act(tab, 'discard', `over the ${cap} live pages cap`)
      live -= 1
    }
  }

  // --- memory ladder -------------------------------------------------------------------------
  const mem = gauges.memory
  if (pressure.includes('memory')) {
    const over = mem.used - mem.budget
    const sustained = input.force || memory.overStreak.memory >= 2 || over > mem.budget * 0.25
    const reason = input.force
      ? 'freeing up memory'
      : `memory ${fmtMb(mem.used)} over the ${fmtMb(mem.budget)} budget`
    let projected = mem.used
    if (sustained) {
      const target = input.force ? 0 : mem.budget * DISCARD_TARGET
      for (const tab of rankVictims(hidden, usageById, 'memory', now, settings, acted)) {
        if (projected <= target) break
        act(tab, 'discard', reason)
        projected -= usageById.get(tab.id)?.memoryMb ?? 0
      }
    }
    // A frozen page's main thread is paused, so a purge would only run once it thaws.
    for (const tab of hidden) {
      if (acted.has(tab.id) || tab.frozen) continue
      if (now - tab.lastPurgedAt >= PURGE_COOLDOWN_MS) act(tab, 'purge', reason)
    }
    if (projected > mem.budget && touchVisible) {
      for (const tab of visible) {
        if (acted.has(tab.id) || now - tab.lastPurgedAt < PURGE_COOLDOWN_MS) continue
        act(tab, 'purge', reason)
      }
    }
    const activeUsage = activeTab ? (usageById.get(activeTab.id)?.memoryMb ?? 0) : 0
    memory.activeOverStreak =
      activeTab && activeUsage > mem.budget ? memory.activeOverStreak + 1 : 0
    if (
      extreme &&
      activeTab &&
      !input.force &&
      memory.activeOverStreak >= 3 &&
      !protectionReason(activeTab, settings)
    ) {
      // Purging was tried on the previous samples; the page alone is bigger than the budget.
      plan.actions = plan.actions.filter((a) => a.tabId !== activeTab.id)
      acted.add(activeTab.id)
      plan.actions.push({
        kind: 'reload',
        tabId: activeTab.id,
        title: activeTab.title,
        reason: `this page alone uses ${fmtMb(activeUsage)}, over the ${fmtMb(mem.budget)} budget`
      })
      memory.activeOverStreak = 0
    }
  } else {
    memory.activeOverStreak = 0
  }

  // --- cpu ladder ----------------------------------------------------------------------------
  const cpu = gauges.cpu
  if (pressure.includes('cpu') && !input.force) {
    const sustained = memory.overStreak.cpu >= 2 || cpu.used > cpu.budget * 2
    const reason = `CPU ${cpu.used.toFixed(0)}% over the ${cpu.budget}% budget`
    const burning = hidden
      .filter((t) => !acted.has(t.id) && (usageById.get(t.id)?.cpuPercent ?? 0) >= NEGLIGIBLE_CPU)
      .sort(
        (a, b) => (usageById.get(b.id)?.cpuPercent ?? 0) - (usageById.get(a.id)?.cpuPercent ?? 0)
      )
    for (const tab of burning) {
      const share = usageById.get(tab.id)?.cpuPercent ?? 0
      if (protectionReason(tab, settings)) continue
      if (tab.frozen) {
        if (sustained)
          act(tab, 'discard', `${reason}; still using ${share.toFixed(0)}% while frozen`)
        continue
      }
      if (tab.cpuThrottle >= THROTTLE_STEPS[THROTTLE_STEPS.length - 1]) {
        if (!tab.loading) act(tab, 'freeze', `${reason}; throttling was not enough`)
        continue
      }
      if (now - tab.lastThrottledAt < THROTTLE_COOLDOWN_MS) continue
      if (sustained || share > cpu.budget * 0.5)
        act(tab, 'throttle', reason, nextThrottle(tab.cpuThrottle))
    }
    if (sustained && touchVisible) {
      for (const tab of visibleInactive) {
        const share = usageById.get(tab.id)?.cpuPercent ?? 0
        if (acted.has(tab.id) || share < NEGLIGIBLE_CPU || protectionReason(tab, settings)) continue
        if (now - tab.lastThrottledAt < THROTTLE_COOLDOWN_MS || tab.cpuThrottle >= 4) continue
        act(tab, 'throttle', reason, tab.cpuThrottle < 2 ? 2 : 4)
      }
    }
    if (sustained && extreme && activeTab && !acted.has(activeTab.id)) {
      const share = usageById.get(activeTab.id)?.cpuPercent ?? 0
      if (
        share > cpu.budget * 0.5 &&
        activeTab.cpuThrottle < 2 &&
        now - activeTab.lastThrottledAt >= THROTTLE_COOLDOWN_MS &&
        !protectionReason(activeTab, settings)
      )
        act(activeTab, 'throttle', reason, 2)
    }
  } else {
    // Relax: visible tabs immediately, hidden tabs one step at a time once comfortably under.
    for (const tab of visible) {
      if (!acted.has(tab.id) && tab.cpuThrottle > 1) act(tab, 'unthrottle', 'CPU within budget', 1)
    }
    if (cpu.budget === 0 || memory.underStreak.cpu >= 3) {
      for (const tab of hidden) {
        if (acted.has(tab.id) || tab.cpuThrottle <= 1) continue
        if (now - tab.lastThrottledAt < THROTTLE_COOLDOWN_MS) continue
        act(tab, 'unthrottle', 'CPU within budget', previousThrottle(tab.cpuThrottle))
      }
    }
  }

  // --- gpu ladder ----------------------------------------------------------------------------
  const gpu = gauges.gpu
  if (pressure.includes('gpu')) {
    const sustained = input.force || memory.overStreak.gpu >= 2 || gpu.used > gpu.budget * 1.25
    const reason = input.force
      ? 'freeing up GPU memory'
      : `GPU memory ${fmtMb(gpu.used)} over the ${fmtMb(gpu.budget)} budget`
    for (const tab of hidden) {
      if (acted.has(tab.id) || !tab.mediaPlaying || tab.audible) continue
      act(tab, 'pause-media', reason)
    }
    if (sustained) {
      const [victim] = rankVictims(hidden, usageById, 'gpu', now, settings, acted)
      if (victim) act(victim, 'discard', reason)
    }
    for (const tab of hidden) {
      if (acted.has(tab.id) || now - tab.lastPurgedAt < PURGE_COOLDOWN_MS) continue
      act(tab, 'purge', reason)
    }
    if (touchVisible) {
      for (const tab of visible) {
        if (acted.has(tab.id) || now - tab.lastPurgedAt < PURGE_COOLDOWN_MS) continue
        act(tab, 'purge', reason)
      }
    }
  }

  return plan
}

function rankVictims(
  candidates: TabSample[],
  usageById: Map<string, TabResourceUsage>,
  kind: ResourceKind,
  now: number,
  settings: ResourceSettings,
  acted: Set<string>
): TabSample[] {
  return candidates
    .filter((t) => !acted.has(t.id) && !protectionReason(t, settings))
    .map((t) => ({ t, score: victimScore(t, usageById.get(t.id), kind, now) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t)
}

function advanceStreaks(
  previous: PlannerMemory,
  gauges: Record<ResourceKind, ResourceGauge>
): PlannerMemory {
  const next: PlannerMemory = {
    overStreak: { ...previous.overStreak },
    underStreak: { ...previous.underStreak },
    activeOverStreak: previous.activeOverStreak
  }
  for (const kind of ['memory', 'cpu', 'gpu'] as ResourceKind[]) {
    const g = gauges[kind]
    if (g.budget > 0 && g.used > g.budget) {
      next.overStreak[kind] += 1
      next.underStreak[kind] = 0
    } else if (g.budget === 0 || g.used <= g.budget * RELAX_BELOW) {
      next.overStreak[kind] = 0
      next.underStreak[kind] += 1
    } else {
      next.overStreak[kind] = 0
    }
  }
  return next
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared with the governor's toasts)
// ---------------------------------------------------------------------------

export function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb).toLocaleString('en-US')} MB`
}

export function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo))
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
