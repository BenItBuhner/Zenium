/**
 * Inactive tabs (TAB-20): Chrome for Android's tab archive. A tab the user has not looked at
 * for `Settings.inactiveTabsArchiveDays` days (7, 14 or 21; 0 is Never) leaves the grid for the
 * Inactive tabs list the switcher reaches from its segment row's entry – its document gone as a
 * sleeping tab's is, its entry kept whole (title, URL, favicon, last use, back/forward stack) so
 * a tap brings it back to the start of the grid with the page intact. An archived tab the user
 * never comes back for is closed after {@link INACTIVE_TAB_AUTO_CLOSE_DAYS} days in the archive
 * when `Settings.inactiveTabsAutoClose` is on (Chrome 152: `TabArchiveSettings`'
 * `DEFAULT_ARCHIVE_TIME_DELTA_HOURS` = 21 days, `DEFAULT_AUTODELETE_TIME_HOURS` = 90 days,
 * `DEFAULT_MAX_SIMULTANEOUS_ARCHIVES` = 150, `DEFAULT_DECLUTTER_INTERVAL_TIME_HOURS` = 7 days).
 *
 * The archive is a persisted state of the core (`BrowserState.archivedTabs`, next to the
 * recently closed list it is made of): an entry is what `TabManager.archiveTab` gives – the
 * close's "Recently closed" entry, stamped with when it was archived – and it keeps the tab's
 * navigation document the way a recently closed entry does. Restoring goes through the session
 * service's restore path, so the stack is replayed once the page loads.
 *
 * The passes (archive, then the auto-close sweep) never run on the chrome's boot path: the first
 * one is armed through the background queue's startup arm (after the other startup sweeps'
 * delays, held back by the demo harness like them) and the next ones follow Chrome's weekly
 * cadence; a settings change re-runs them at once (or rescues every archived tab when the
 * threshold becomes Never, as Chrome's `rescueArchivedTabs` does). Their clock is the `now`
 * they are given – the `inactiveTabs.runPasses` command's argument is the drivers' and the
 * tests' hook; nothing here waits for real days.
 */
import type {
  ArchivedTabEntry,
  ArchivedTabSummary,
  ClosedTabEntry,
  InactiveTabsArchiveDays,
  Tab
} from '../shared/types'
import { INACTIVE_TAB_AUTO_CLOSE_DAYS, INACTIVE_TABS_ARCHIVE_DAYS } from '../shared/defaults'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import { closedTabIds } from './navigationState'
import { summarizeArchived } from './session'

export const DAY_MS = 24 * 60 * 60 * 1000
/** Tabs one archive pass moves at most (Chrome: 150). */
export const INACTIVE_TABS_MAX_PER_PASS = 150
/**
 * The first pass of a run, from `start`: after the blocking (20 s) and Safe Browsing (35 s)
 * startup sweeps, so nothing new joins the first minute's work.
 */
export const INACTIVE_TABS_FIRST_PASS_DELAY_MS = 45_000
/** The passes' cadence within a run (Chrome's declutter interval). */
export const INACTIVE_TABS_PASS_INTERVAL_MS = 7 * DAY_MS

/** The setting as persisted or patched, brought back to one of the four values. */
export function sanitizeArchiveDays(value: unknown): InactiveTabsArchiveDays {
  return INACTIVE_TABS_ARCHIVE_DAYS.find((days) => days === value) ?? 21
}

/** The archive entry as the closed-tab entry it was made from (the archive's stamp left behind). */
function closedEntryOf(entry: ArchivedTabEntry): ClosedTabEntry {
  const { archivedAt: _archivedAt, ...closed } = entry
  void _archivedAt
  return closed
}

export interface InactiveTabsPassResult {
  /** Tabs the archive pass moved into the archive. */
  archived: number
  /** Archived tabs the sweep closed for good. */
  closed: number
}

export class InactiveTabsService {
  private cancelStartupPass: (() => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** The startup pass ran: a settings change re-runs the passes itself from here on. */
  private startupPassDone = false

  constructor(private readonly browser: Browser) {}

  /**
   * Hosts with the archive (`capabilities.inactiveTabs`: Android); elsewhere nothing runs. The
   * flag is read as exactly `true`: a host whose capabilities leave it out (an older platform
   * table, a test's stub) has no archive rather than a truthy accident.
   */
  enabled(): boolean {
    return this.browser.state.capabilities.inactiveTabs === true
  }

  start(): void {
    if (!this.enabled()) return
    const run = (): void => {
      this.startupPassDone = true
      this.runPasses()
    }
    this.cancelStartupPass = this.browser.background.armStartup(
      INACTIVE_TABS_FIRST_PASS_DELAY_MS,
      run
    )
    this.timer = setInterval(run, INACTIVE_TABS_PASS_INTERVAL_MS)
  }

  stop(): void {
    this.cancelStartupPass?.()
    this.cancelStartupPass = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  entries(): ArchivedTabEntry[] {
    return this.browser.state.archivedTabs
  }

  /** The list as the Inactive tabs surface shows it: the newest archived first. */
  list(): ArchivedTabSummary[] {
    return this.entries().map(summarizeArchived)
  }

  /**
   * The archive pass and the sweep, at `now`. Nothing happens on a host without the archive; a
   * pass that changed nothing tells no one.
   */
  runPasses(now = Date.now()): InactiveTabsPassResult {
    if (!this.enabled()) return { archived: 0, closed: 0 }
    const archived = this.archivePass(now)
    const closed = this.sweep(now)
    if (archived > 0 || closed > 0) this.changed()
    return { archived, closed }
  }

  /**
   * `inactiveTabsArchiveDays` or `inactiveTabsAutoClose` changed: Never brings every archived
   * tab back into the grid (Chrome's rescue); any other value applies at once – once the
   * startup pass has run, so a change synced in during boot waits for it.
   */
  onSettingsChanged(): void {
    if (!this.enabled()) return
    if (this.browser.state.settings.inactiveTabsArchiveDays === 0) this.rescueAll()
    else if (this.startupPassDone) this.runPasses()
  }

  /**
   * Bring an archived tab back to the start of the grid and to the front (Chrome opens the
   * restored tab), its last use now: the next pass leaves it alone.
   */
  restore(id: string, win: ZenWindow = this.browser.focusedWindow()): Tab | null {
    const entry = this.take(id)
    if (!entry) return null
    const tab = this.browser.session.restoreEntry(this.atStart(entry, Date.now()), win)
    this.changed()
    return tab
  }

  /** Every archived tab back to the start of the grid, in the list's order, none to the front. */
  restoreAll(win: ZenWindow = this.browser.focusedWindow()): void {
    const entries = this.entries()
    if (entries.length === 0) return
    const now = Date.now()
    this.browser.state.archivedTabs = []
    // Restored one by one at index 0: the last one in ends up first, so the list's first goes last.
    for (const entry of [...entries].reverse())
      this.browser.session.restoreEntry(this.atStart(entry, now), win, true)
    this.changed()
  }

  /**
   * Close one archived tab: it joins "Recently closed" (its stack with it), where one tab's
   * undo belongs.
   */
  close(id: string): void {
    const entry = this.take(id)
    if (!entry) return
    this.browser.session.pushTab({ ...closedEntryOf(entry), closedAt: Date.now() })
    this.changed()
  }

  /**
   * Close every archived tab. They are gone from the archive, not moved into "Recently closed"
   * (a list of 25 that a "Close all" would flush); the pages stay in History, as the
   * confirmation says.
   */
  closeAll(): void {
    if (this.entries().length === 0) return
    this.drop(this.entries())
    this.browser.state.archivedTabs = []
    this.changed()
  }

  /**
   * The threshold became Never: every archived tab back into its space where it was, its last
   * use as it stands (with the archive off nothing looks at it), none to the front.
   */
  private rescueAll(): void {
    const entries = this.entries()
    if (entries.length === 0) return
    const win = this.browser.focusedWindow()
    this.browser.state.archivedTabs = []
    for (const entry of [...entries].reverse()) this.browser.session.restoreEntry(entry, win, true)
    this.changed()
  }

  /**
   * Every eligible tab whose last use is `days` or more ago leaves the grid for the archive,
   * the longest unused first, at most {@link INACTIVE_TABS_MAX_PER_PASS} of them. Eligible: a
   * regular tab – not pinned, not an Essential, not private, not in a group or a split view,
   * not heard – that no window shows and no space has selected.
   */
  private archivePass(now: number): number {
    const days = this.browser.state.settings.inactiveTabsArchiveDays
    if (days === 0) return 0
    const state = this.browser.state
    const threshold = days * DAY_MS
    const candidates = this.candidates(threshold, now)
    if (candidates.length === 0) return 0
    let archived = 0
    const filed: ArchivedTabEntry[] = []
    for (const tab of candidates) {
      const entry = this.browser.tabs.archiveTab(tab.id)
      if (!entry) continue
      filed.push({ ...entry, closedAt: now, archivedAt: now })
      archived++
    }
    if (archived === 0) return 0
    // The pass's own, the most recently used first, ahead of the earlier passes' entries.
    filed.reverse()
    state.archivedTabs = [...filed, ...state.archivedTabs]
    return archived
  }

  private candidates(threshold: number, now: number): Tab[] {
    const { state, tabs } = this.browser
    const m = state.model
    const shown = new Set<string>()
    for (const space of m.spaces) if (space.activeTabId) shown.add(space.activeTabId)
    for (const win of this.browser.allWindows()) {
      const spaces = win.localSpace ? [win.localSpace] : m.spaces
      for (const space of spaces) {
        const selected = win.selectedTabIn(space)
        if (selected) shown.add(selected)
      }
    }
    const out: Tab[] = []
    for (const tab of Object.values(m.tabs)) {
      if (shown.has(tab.id)) continue
      if (tab.pinned || tab.essential || tab.folderId || tab.splitGroupId) continue
      if (tab.audible || tabs.isPrivate(tab)) continue
      if (now - tab.lastActiveAt < threshold) continue
      out.push(tab)
    }
    out.sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    return out.slice(0, INACTIVE_TABS_MAX_PER_PASS)
  }

  /**
   * Archived tabs {@link INACTIVE_TAB_AUTO_CLOSE_DAYS} days in the archive are closed for good
   * when the switch is on: the clock is the archiving, not the last use (Chrome's
   * `doAutodeletePass`).
   */
  private sweep(now: number): number {
    const state = this.browser.state
    if (!state.settings.inactiveTabsAutoClose) return 0
    const limit = INACTIVE_TAB_AUTO_CLOSE_DAYS * DAY_MS
    const gone = state.archivedTabs.filter((entry) => now - entry.archivedAt >= limit)
    if (gone.length === 0) return 0
    this.drop(gone)
    state.archivedTabs = state.archivedTabs.filter((entry) => !gone.includes(entry))
    return gone.length
  }

  /** The entry, out of the archive. */
  private take(id: string): ArchivedTabEntry | null {
    const state = this.browser.state
    const entry = state.archivedTabs.find((e) => e.id === id)
    if (!entry) return null
    state.archivedTabs = state.archivedTabs.filter((e) => e !== entry)
    return entry
  }

  /** Entries leaving the archive for nowhere: their navigation documents go with them. */
  private drop(entries: ArchivedTabEntry[]): void {
    for (const id of closedTabIds(entries)) this.browser.state.navigationState.touch(id)
  }

  /** The entry as a restore to the start of the grid reads it, the tab's last use `now`. */
  private atStart(entry: ArchivedTabEntry, now: number): ClosedTabEntry {
    const closed = closedEntryOf(entry)
    return { ...closed, index: 0, folderId: null, tab: { ...closed.tab, lastActiveAt: now } }
  }

  private changed(): void {
    this.browser.state.commit()
    for (const w of this.browser.allWindows()) w.send('inactiveTabs.changed', undefined)
  }
}
