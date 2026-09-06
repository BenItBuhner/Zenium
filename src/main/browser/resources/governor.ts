import { app, powerMonitor, type WebContents } from 'electron'
import { availableParallelism, totalmem } from 'node:os'
import type {
  GovernorAction,
  GovernorActionKind,
  ResourceSettings,
  ResourceSnapshot,
  Tab,
  TabResourceUsage
} from '../../../shared/types'
import { emptyResourceSnapshot } from '../../../shared/defaults'
import { getDomain } from '../../../shared/url'
import type { Browser } from '../browser'
import { TabLifecycle } from './lifecycle'
import { LoadScheduler } from './scheduler'
import {
  MAX_RECENT_ACTIONS,
  emptyPlannerMemory,
  plan,
  protectionReason,
  victimScore,
  type PlannedAction,
  type PlannerInput,
  type PlannerMemory,
  type ProcessKind,
  type ProcessSample,
  type TabSample
} from './planner'
import { appliedStartupProfile } from './startup'
import { deriveStartupProfile, profilesDiffer } from './switches'

const BASE_INTERVAL_MS = 5_000
const PRESSURE_INTERVAL_MS = 2_000
const IDLE_INTERVAL_MS = 15_000
const PRESSURE_TOAST_COOLDOWN_MS = 60_000
/** `ZEN_GOVERNOR_LOG=1` prints one line per sample plus every action to the console. */
const DIAGNOSTICS = process.env['ZEN_GOVERNOR_LOG'] === '1'
const PAUSE_MEDIA_SCRIPT = `(() => {
  let paused = 0
  for (const m of document.querySelectorAll('video,audio')) {
    if (!m.paused) { m.pause(); paused++ }
  }
  return paused
})()`

/**
 * Keeps the whole browser under the user's memory, CPU and GPU budgets.
 *
 * Every few seconds it samples all Chromium processes, attributes them to tabs, asks the pure
 * planner what to do and carries the plan out: purge, throttle, freeze, discard or – in extreme
 * mode – reload pages. It also owns the background load queue, reacts to power events (battery,
 * suspend, lock screen, idle) and window state, and publishes a `ResourceSnapshot` for the UI.
 */
export class ResourceGovernor {
  readonly lifecycle = new TabLifecycle()
  readonly scheduler: LoadScheduler
  snapshot: ResourceSnapshot = emptyResourceSnapshot()

  private memory: PlannerMemory = emptyPlannerMemory()
  private timer: NodeJS.Timeout | null = null
  private sampling = false
  private stopped = false
  private readonly usage = new Map<string, TabResourceUsage>()
  private readonly lastPurgedAt = new Map<string, number>()
  private readonly lastThrottledAt = new Map<string, number>()
  /** Last sample in which a tab was on screen (split panes are not covered by `lastActiveAt`). */
  private readonly lastVisibleAt = new Map<string, number>()
  private readonly mediaPlaying = new Set<string>()
  private readonly actions: GovernorAction[] = []
  private lastExecuted: PlannedAction[] = []
  private lastPressureToastAt = 0
  private readonly startupProfile = appliedStartupProfile()
  private readonly cleanups: Array<() => void> = []

  constructor(private readonly browser: Browser) {
    this.scheduler = new LoadScheduler({
      load: (tabId) => Boolean(this.browser.tabs.load(tabId)),
      tabExists: (tabId) => Boolean(this.browser.tabs.tab(tabId)),
      liveCount: () => this.browser.tabs.loadedCount(),
      maxConcurrent: () => this.settings.maxConcurrentLoads,
      maxLive: () => (this.settings.enabled ? this.settings.maxLoadedTabs : 0),
      makeRoom: () => this.evictOne('over the live pages cap'),
      onDeferred: (tabId) => this.record('defer', tabId, 'waiting for a free load slot'),
      onChange: () => this.publishCounts()
    })
  }

  private get settings(): ResourceSettings {
    return this.browser.state.settings.resources
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    // `powerMonitor` only types each event name as its own overload; go through the emitter base.
    const emitter: NodeJS.EventEmitter = powerMonitor
    const listen = (event: string, fn: () => void): void => {
      emitter.on(event, fn)
      this.cleanups.push(() => emitter.removeListener(event, fn))
    }
    listen('suspend', () => void this.sleepAll('system suspended'))
    listen('lock-screen', () => void this.sleepAll('screen locked'))
    listen('resume', () => this.wakeVisible())
    listen('unlock-screen', () => this.wakeVisible())
    listen('on-battery', () => this.sampleSoon())
    listen('on-ac', () => this.sampleSoon())
    const win = this.browser.window.win
    const onMinimize = (): void => this.sampleSoon()
    const onRestore = (): void => {
      this.wakeVisible()
      this.sampleSoon()
    }
    win.on('minimize', onMinimize)
    win.on('restore', onRestore)
    win.on('focus', onRestore)
    this.cleanups.push(() => {
      if (win.isDestroyed()) return
      win.removeListener('minimize', onMinimize)
      win.removeListener('restore', onRestore)
      win.removeListener('focus', onRestore)
    })
    this.schedule(1_000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  /** Re-sample shortly (settings changed, power source changed, window state changed …). */
  sampleSoon(): void {
    this.schedule(250)
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.sample(), ms)
  }

  /** Take a sample, execute the resulting plan and publish the snapshot. */
  async sample(force = false): Promise<ResourceSnapshot> {
    if (this.sampling || this.stopped) return this.snapshot
    this.sampling = true
    try {
      const input = this.collect(force)
      const result = plan(input)
      this.memory = result.memory
      const changedModel = await this.execute(result.actions)
      this.publish(result, input, changedModel)
    } catch (error) {
      console.error('[zen] resource governor sample failed:', error)
    } finally {
      this.sampling = false
      const quiet = this.snapshot.system.idle || this.windowMinimized()
      this.schedule(
        this.snapshot.pressure.length
          ? PRESSURE_INTERVAL_MS
          : quiet
            ? IDLE_INTERVAL_MS
            : BASE_INTERVAL_MS
      )
    }
    return this.snapshot
  }

  // ---------------------------------------------------------------------------
  // Hooks from the TabManager
  // ---------------------------------------------------------------------------

  onViewCreated(_tabId: string, wc: WebContents): void {
    void this.applyConcurrency(wc)
  }

  onViewDestroyed(tabId: string, wc: WebContents): void {
    this.lifecycle.forget(wc)
    this.scheduler.finished(tabId)
    this.mediaPlaying.delete(tabId)
    this.lastPurgedAt.delete(tabId)
    this.lastThrottledAt.delete(tabId)
    this.usage.delete(tabId)
  }

  onTabRemoved(tabId: string): void {
    this.lastVisibleAt.delete(tabId)
  }

  onLoadFinished(tabId: string): void {
    this.scheduler.finished(tabId)
  }

  onMedia(tabId: string, playing: boolean): void {
    if (playing) this.mediaPlaying.add(tabId)
    else this.mediaPlaying.delete(tabId)
  }

  /** Visible pages must be awake and unthrottled – applied right away, not at the next sample. */
  wakeVisible(): void {
    const { tabs } = this.browser
    const now = Date.now()
    for (const id of this.visibleIds()) {
      this.lastVisibleAt.set(id, now)
      const tab = tabs.tab(id)
      const wc = tabs.webContents(id)
      if (!tab || !wc) continue
      if (tab.frozen) void this.thawTab(tab, wc).then(() => this.browser.state.commit())
      if (tab.cpuThrottle > 1) {
        void this.lifecycle.setCpuThrottle(wc, 1).then((ok) => {
          if (!ok) return
          tab.cpuThrottle = 1
          this.browser.state.commit()
        })
      }
    }
  }

  onSettingsChanged(): void {
    const { tabs } = this.browser
    for (const [id] of tabs.allViews()) {
      const wc = tabs.webContents(id)
      if (wc) void this.applyConcurrency(wc)
    }
    this.scheduler.pump()
    this.sampleSoon()
  }

  /** Make room for one more live page when the cap is reached (visible loads must never wait). */
  makeRoomFor(tabId: string): void {
    const s = this.settings
    if (!s.enabled || s.maxLoadedTabs <= 0) return
    if (this.browser.tabs.loadedCount() < s.maxLoadedTabs) return
    if (this.browser.tabs.view(tabId)) return
    this.evictOne('over the live pages cap')
  }

  /** Something outside the planner acted on a tab (e.g. a renderer died of OOM). */
  record(kind: GovernorActionKind, tabId: string | null, reason: string, title?: string): void {
    const tab = tabId ? this.browser.tabs.tab(tabId) : undefined
    this.actions.unshift({
      at: Date.now(),
      kind,
      tabId,
      title: title ?? tab?.customTitle ?? tab?.title ?? '',
      reason
    })
    if (this.actions.length > MAX_RECENT_ACTIONS) this.actions.length = MAX_RECENT_ACTIONS
  }

  // ---------------------------------------------------------------------------
  // Manual operations (context menu, Command Bar, settings)
  // ---------------------------------------------------------------------------

  async freezeTab(tabId: string): Promise<void> {
    const { tabs } = this.browser
    const tab = tabs.tab(tabId)
    const wc = tabs.webContents(tabId)
    if (!tab || !wc) return
    if (this.visibleIds().has(tabId)) {
      this.browser.toast('Visible tabs cannot be frozen – switch to another tab first.')
      return
    }
    if (await this.lifecycle.freeze(wc)) {
      tab.frozen = true
      this.record('freeze', tabId, 'frozen by you')
      this.browser.state.commit()
    }
  }

  async wakeTab(tabId: string): Promise<void> {
    const { tabs } = this.browser
    const tab = tabs.tab(tabId)
    const wc = tabs.webContents(tabId)
    if (!tab || !wc) return
    if (tab.frozen) await this.thawTab(tab, wc)
    if (tab.cpuThrottle > 1 && (await this.lifecycle.setCpuThrottle(wc, 1))) tab.cpuThrottle = 1
    this.record('thaw', tabId, 'woken by you')
    this.browser.state.commit()
  }

  async freezeOthers(): Promise<void> {
    const { tabs } = this.browser
    const visible = this.visibleIds()
    let count = 0
    for (const [id] of [...tabs.allViews()]) {
      const tab = tabs.tab(id)
      const wc = tabs.webContents(id)
      if (!tab || !wc || visible.has(id) || tab.frozen) continue
      if (protectionReason(this.sampleTab(tab, wc, visible), this.settings)) continue
      if (await this.lifecycle.freeze(wc)) {
        tab.frozen = true
        count += 1
      }
    }
    this.record('freeze', null, `froze ${count} tab${count === 1 ? '' : 's'}`, 'Other tabs')
    this.browser.toast(`Froze ${count} tab${count === 1 ? '' : 's'}.`)
    this.browser.state.commit()
  }

  async wakeAll(): Promise<void> {
    const { tabs } = this.browser
    for (const [id] of [...tabs.allViews()]) {
      const tab = tabs.tab(id)
      const wc = tabs.webContents(id)
      if (!tab || !wc) continue
      if (tab.frozen) await this.thawTab(tab, wc)
      if (tab.cpuThrottle > 1 && (await this.lifecycle.setCpuThrottle(wc, 1))) tab.cpuThrottle = 1
    }
    this.record('thaw', null, 'woke every tab', 'All tabs')
    this.browser.state.commit()
  }

  /** "Free up memory now": run the ladders as if every budget were exceeded. */
  async trim(): Promise<void> {
    const before = this.snapshot.memory.used
    await this.sample(true)
    const discarded = this.lastExecuted.filter((a) => a.kind === 'discard').length
    const frozen = this.lastExecuted.filter((a) => a.kind === 'freeze').length
    const purged = this.lastExecuted.filter((a) => a.kind === 'purge').length
    const after = (await this.sample()).memory.used
    const freed = Math.max(0, before - after)
    this.browser.toast(
      `Unloaded ${discarded}, froze ${frozen} and purged ${purged} tab${purged === 1 ? '' : 's'}` +
        (freed > 0 ? ` – ${Math.round(freed)} MB freed.` : '.')
    )
  }

  relaunch(): void {
    this.browser.shutdown()
    app.relaunch()
    app.quit()
  }

  // ---------------------------------------------------------------------------
  // Sampling
  // ---------------------------------------------------------------------------

  private collect(force: boolean): PlannerInput {
    const { tabs, state } = this.browser
    const now = Date.now()
    const processes: ProcessSample[] = app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type as ProcessKind,
      memoryMb: m.memory.workingSetSize / 1024,
      cpuPercent: m.cpu.percentCPUUsage
    }))
    const visible = this.visibleIds()
    const samples: TabSample[] = []
    for (const tab of Object.values(state.model.tabs)) {
      if (visible.has(tab.id)) this.lastVisibleAt.set(tab.id, now)
      samples.push(this.sampleTab(tab, tabs.webContents(tab.id), visible))
    }
    return {
      now,
      settings: this.settings,
      unload: {
        enabled: state.settings.unloadEnabled,
        timeoutMinutes: state.settings.unloadTimeoutMinutes
      },
      system: {
        totalMemoryMb: totalmem() / 1_048_576,
        cpuCount: cpuCount(),
        onBattery: safe(() => powerMonitor.isOnBatteryPower(), false),
        idleSeconds: safe(() => powerMonitor.getSystemIdleTime(), 0),
        windowMinimized: this.windowMinimized()
      },
      processes,
      tabs: samples,
      memory: this.memory,
      force
    }
  }

  private sampleTab(tab: Tab, wc: WebContents | undefined, visible: Set<string>): TabSample {
    const { state } = this.browser
    const activeId = this.browser.tabs.activeSpace.activeTabId
    return {
      id: tab.id,
      title: tab.customTitle ?? tab.title,
      pids: wc ? pidsOf(wc) : [],
      loaded: Boolean(wc),
      visible: visible.has(tab.id),
      active: tab.id === activeId,
      audible: tab.audible,
      mediaPlaying: this.mediaPlaying.has(tab.id),
      loading: tab.loading,
      pinned: tab.pinned,
      essential: tab.essential,
      excluded: isExcluded(tab.url, state.settings.unloadExcludedDomains),
      devtoolsOpen: state.devtoolsOpenFor.has(tab.id),
      frozen: tab.frozen,
      cpuThrottle: tab.cpuThrottle,
      lastActiveAt: Math.max(tab.lastActiveAt, this.lastVisibleAt.get(tab.id) ?? 0),
      lastPurgedAt: this.lastPurgedAt.get(tab.id) ?? 0,
      lastThrottledAt: this.lastThrottledAt.get(tab.id) ?? 0
    }
  }

  private visibleIds(): Set<string> {
    const { tabs, state } = this.browser
    const visible = new Set(tabs.visibleTabIds())
    if (state.glance) visible.add(state.glance.tabId).add(state.glance.parentTabId)
    return visible
  }

  private windowMinimized(): boolean {
    const win = this.browser.window.win
    return Boolean(win && !win.isDestroyed() && win.isMinimized())
  }

  // ---------------------------------------------------------------------------
  // Executing plans
  // ---------------------------------------------------------------------------

  /** Returns true when tab records changed (frozen / throttle / discarded). */
  private async execute(actions: PlannedAction[]): Promise<boolean> {
    let changed = false
    let pressureDiscards = 0
    const executed: PlannedAction[] = []
    // One browser-wide pressure notification per cycle is enough; it is not per page.
    const purging = actions.find((a) => a.kind === 'purge')
    if (purging) {
      const wc = this.browser.tabs.webContents(purging.tabId)
      const critical = this.memory.overStreak.memory >= 2 || this.memory.overStreak.gpu >= 2
      if (wc) await this.lifecycle.notifyMemoryPressure(wc, critical ? 'critical' : 'moderate')
    }
    for (const action of actions) {
      const tab = this.browser.tabs.tab(action.tabId)
      if (!tab) continue
      let applied = false
      try {
        applied = await this.apply(action, tab)
      } catch (error) {
        console.warn(`[zen] resource governor could not ${action.kind} "${tab.title}":`, error)
      }
      if (!applied) continue
      executed.push(action)
      if (action.kind !== 'purge' && action.kind !== 'pause-media') changed = true
      if (action.kind === 'discard' && !action.reason.startsWith('hidden for'))
        pressureDiscards += 1
      this.record(action.kind, action.tabId, action.reason, action.title)
    }
    this.lastExecuted = executed
    if (
      pressureDiscards > 0 &&
      Date.now() - this.lastPressureToastAt > PRESSURE_TOAST_COOLDOWN_MS
    ) {
      this.lastPressureToastAt = Date.now()
      this.browser.toast(
        `Unloaded ${pressureDiscards} tab${pressureDiscards === 1 ? '' : 's'} to stay within your resource budget.`
      )
    }
    return changed
  }

  private async apply(action: PlannedAction, tab: Tab): Promise<boolean> {
    const { tabs } = this.browser
    const wc = tabs.webContents(tab.id)
    switch (action.kind) {
      case 'discard':
        if (!wc) return false
        tabs.discard(tab.id)
        return true
      case 'reload':
        if (!wc) return false
        tabs.discard(tab.id)
        tabs.ensureLoaded(tab.id)
        this.browser.toast(`"${tab.customTitle ?? tab.title}" was reloaded: ${action.reason}.`)
        return true
      case 'freeze':
        if (!wc || !(await this.lifecycle.freeze(wc))) return false
        tab.frozen = true
        return true
      case 'thaw':
        if (!wc) return false
        return this.thawTab(tab, wc)
      case 'throttle':
      case 'unthrottle': {
        const rate = action.rate ?? 1
        if (!wc || !(await this.lifecycle.setCpuThrottle(wc, rate))) return false
        tab.cpuThrottle = rate
        this.lastThrottledAt.set(tab.id, Date.now())
        return true
      }
      case 'purge':
        if (!wc) return false
        this.lastPurgedAt.set(tab.id, Date.now())
        return this.lifecycle.purge(wc)
      case 'pause-media': {
        if (!wc) return false
        const paused = await wc.executeJavaScript(PAUSE_MEDIA_SCRIPT, true).catch(() => 0)
        this.mediaPlaying.delete(tab.id)
        return Number(paused) > 0
      }
      case 'defer':
        return false
    }
  }

  private async thawTab(tab: Tab, wc: WebContents): Promise<boolean> {
    if (!(await this.lifecycle.thaw(wc))) return false
    tab.frozen = false
    // Freezing marks the page hidden; a visible page needs its visibility re-asserted to paint.
    if (this.visibleIds().has(tab.id)) this.browser.tabs.refreshVisibility(tab.id)
    return true
  }

  /** Discard the best hidden victim right now (live-page cap). */
  private evictOne(reason: string): boolean {
    const { tabs } = this.browser
    const visible = this.visibleIds()
    const now = Date.now()
    let best: { tab: Tab; score: number } | null = null
    for (const [id] of tabs.allViews()) {
      const tab = tabs.tab(id)
      const wc = tabs.webContents(id)
      if (!tab || !wc || visible.has(id)) continue
      const sample = this.sampleTab(tab, wc, visible)
      if (protectionReason(sample, this.settings)) continue
      const score = victimScore(sample, this.usage.get(id), 'memory', now)
      if (!best || score > best.score) best = { tab, score }
    }
    if (!best) return false
    tabs.discard(best.tab.id)
    this.record('discard', best.tab.id, reason, best.tab.customTitle ?? best.tab.title)
    return true
  }

  /** Suspend / lock screen: put every page that is not playing audio to sleep. */
  private async sleepAll(reason: string): Promise<void> {
    const { tabs } = this.browser
    let count = 0
    for (const [id] of [...tabs.allViews()]) {
      const tab = tabs.tab(id)
      const wc = tabs.webContents(id)
      if (!tab || !wc || tab.frozen || tab.audible || tab.loading) continue
      if (await this.lifecycle.freeze(wc)) {
        tab.frozen = true
        count += 1
      }
    }
    if (count) {
      this.record('freeze', null, reason, `${count} tab${count === 1 ? '' : 's'}`)
      this.browser.state.commit()
    }
  }

  private concurrencyOverride(): number | null {
    const s = this.settings
    if (!s.enabled || s.cpuPercent >= 100) return null
    const cores = cpuCount()
    return Math.max(1, Math.min(cores, Math.round((cores * s.cpuPercent) / 100)))
  }

  private async applyConcurrency(wc: WebContents): Promise<void> {
    await this.lifecycle.setHardwareConcurrency(wc, this.concurrencyOverride())
  }

  // ---------------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------------

  private publish(
    result: ReturnType<typeof plan>,
    input: PlannerInput,
    changedModel: boolean
  ): void {
    const { tabs, state } = this.browser
    this.usage.clear()
    for (const u of result.attribution.usage) this.usage.set(u.tabId, u)
    let loaded = 0
    let frozen = 0
    let throttled = 0
    for (const [id] of tabs.allViews()) {
      const tab = tabs.tab(id)
      loaded += 1
      if (tab?.frozen) frozen += 1
      if (tab && tab.cpuThrottle > 1) throttled += 1
    }
    this.snapshot = {
      sampledAt: input.now,
      memory: result.gauges.memory,
      cpu: result.gauges.cpu,
      gpu: result.gauges.gpu,
      system: {
        totalMemoryMb: Math.round(input.system.totalMemoryMb),
        cpuCount: input.system.cpuCount,
        onBattery: input.system.onBattery,
        idle: result.idle
      },
      tabs: result.attribution.usage
        .filter((u) => u.processes > 0)
        .sort((a, b) => b.memoryMb - a.memoryMb),
      overheadMb: result.attribution.overheadMb,
      loadedTabs: loaded,
      frozenTabs: frozen,
      throttledTabs: throttled,
      queuedLoads: this.scheduler.queued,
      pressure: result.pressure,
      recentActions: [...this.actions],
      restartRequired: this.restartRequired()
    }
    state.resources = this.snapshot
    if (changedModel) state.commit()
    else state.commitVolatile()
    if (DIAGNOSTICS) {
      const g = this.snapshot
      const fmt = (x: { used: number; budget: number }, unit: string): string =>
        `${Math.round(x.used)}${x.budget ? `/${x.budget}` : ''}${unit}`
      console.log(
        `[zen governor] mem ${fmt(g.memory, 'MB')} cpu ${fmt(g.cpu, '%')} gpu ${fmt(g.gpu, 'MB')} · ` +
          `${g.loadedTabs} live, ${g.frozenTabs} frozen, ${g.throttledTabs} throttled, ${g.queuedLoads} queued` +
          (g.pressure.length ? ` · pressure: ${g.pressure.join(', ')}` : '') +
          (this.lastExecuted.length
            ? ` · ${this.lastExecuted.map((a) => `${a.kind} "${a.title}" (${a.reason})`).join('; ')}`
            : '')
      )
    }
  }

  private publishCounts(): void {
    this.snapshot = {
      ...this.snapshot,
      loadedTabs: this.browser.tabs.loadedCount(),
      queuedLoads: this.scheduler.queued,
      recentActions: [...this.actions]
    }
    this.browser.state.resources = this.snapshot
    this.browser.state.commitVolatile()
  }

  restartRequired(): boolean {
    const wanted = deriveStartupProfile(this.settings)
    return profilesDiffer(wanted, this.startupProfile ?? wanted)
  }
}

function pidsOf(wc: WebContents): number[] {
  const pids = new Set<number>()
  try {
    const pid = wc.getOSProcessId()
    if (pid > 0) pids.add(pid)
  } catch {
    // No live renderer yet.
  }
  try {
    for (const frame of wc.mainFrame.framesInSubtree) {
      const pid = frame.osProcessId
      if (pid > 0) pids.add(pid)
    }
  } catch {
    // Frames are being torn down.
  }
  return [...pids]
}

/** "Never unload these domains": matches the host itself, any subdomain, or the registrable domain. */
export function isExcluded(url: string, domains: string[]): boolean {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!host) return false
  const registrable = getDomain(url)
  return domains.some((raw) => {
    const d = raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
    return d.length > 0 && (host === d || host.endsWith(`.${d}`) || registrable === d)
  })
}

function cpuCount(): number {
  return Math.max(1, availableParallelism())
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
