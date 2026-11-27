import { emptyHabits, observeHidden, sanitizeHabits, type TabHabits } from './habits'

/** How often a hidden tab's growing time hidden is fed to the habits. */
export const HABITS_REPORT_MS = 60_000

export interface HabitsTab {
  id: string
  site: string
  visible: boolean
  /** When the tab was last shown (epoch ms). */
  lastActiveAt: number
}

/**
 * Feeds the governor's samples into the person's tab habits (`habits.ts`): a tab shown again
 * after being hidden is a return; a tab still hidden is reported as its time hidden grows. The
 * governor calls `update` with every sample and saves `habits` when `dirty`.
 */
export class HabitsTracker {
  habits: TabHabits
  dirty = false
  /** Per hidden tab: when it was hidden, and how much of that is already reported. */
  private readonly hidden = new Map<string, { since: number; reported: number; site: string }>()

  constructor(stored: unknown, now: number) {
    this.habits =
      stored === null || stored === undefined ? emptyHabits(now) : sanitizeHabits(stored, now)
  }

  update(tabs: readonly HabitsTab[], now: number): void {
    const seen = new Set<string>()
    for (const tab of tabs) {
      seen.add(tab.id)
      const h = this.hidden.get(tab.id)
      if (tab.visible) {
        if (h) {
          observeHidden(this.habits, h.site, h.reported, now - h.since, true, now)
          this.hidden.delete(tab.id)
          this.dirty = true
        }
        continue
      }
      if (!h) {
        this.hidden.set(tab.id, {
          since: Math.min(now, tab.lastActiveAt || now),
          reported: 0,
          site: tab.site
        })
        continue
      }
      const hiddenFor = now - h.since
      if (hiddenFor - h.reported >= HABITS_REPORT_MS) {
        observeHidden(this.habits, h.site, h.reported, hiddenFor, false, now)
        h.reported = hiddenFor
        this.dirty = true
      }
    }
    // Closed tabs: their evidence so far stays; they are no longer followed.
    for (const id of [...this.hidden.keys()]) if (!seen.has(id)) this.hidden.delete(id)
  }
}
