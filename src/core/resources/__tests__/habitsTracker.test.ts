import { describe, expect, it } from 'vitest'
import { HabitsTracker } from '../habitsTracker'
import { confidence, returnChance, emptyHabits } from '../habits'

const MIN = 60_000

describe('HabitsTracker', () => {
  it('records a return when a hidden tab is shown again', () => {
    const t = new HabitsTracker(null, 0)
    t.update([{ id: 'a', site: 'a.test', visible: false, lastActiveAt: 0 }], 0)
    t.update([{ id: 'a', site: 'a.test', visible: true, lastActiveAt: 0 }], 4 * MIN)
    expect(t.dirty).toBe(true)
    expect(t.habits.sites['a.test'].returned.reduce((x, y) => x + y)).toBe(1)
  })

  it('reports time hidden as it grows, so tabs never shown again still teach', () => {
    const t = new HabitsTracker(null, 0)
    for (let m = 0; m <= 600; m += 1)
      t.update([{ id: 'p', site: 'p.test', visible: false, lastActiveAt: 0 }], m * MIN)
    expect(confidence(t.habits)).toBeGreaterThan(0)
    expect(returnChance(t.habits, 'p.test', 200 * MIN, 60 * MIN)).toBeLessThan(
      returnChance(emptyHabits(), 'p.test', 200 * MIN, 60 * MIN)
    )
  })

  it('starts from what was stored, and from nothing when it is unreadable', () => {
    const t = new HabitsTracker({ junk: true }, 0)
    expect(t.habits).toEqual(emptyHabits(0))
  })
})
