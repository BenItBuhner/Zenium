import { describe, expect, it } from 'vitest'
import {
  MAX_SITES,
  confidence,
  emptyHabits,
  mergeHabits,
  observeHidden,
  returnChance,
  sanitizeHabits
} from '../habits'

const MIN = 60_000
const HOUR = 60 * MIN

describe('tab habits', () => {
  it('starts generous: a tab hidden for a while is still likely to come back', () => {
    const h = emptyHabits()
    expect(returnChance(h, 'a.test', 30 * MIN, HOUR)).toBeGreaterThan(0.3)
    expect(confidence(h)).toBe(0)
  })

  it('learns that a site comes back quickly', () => {
    const h = emptyHabits()
    for (let i = 0; i < 50; i++) observeHidden(h, 'mail.test', 0, 4 * MIN, true, i * MIN)
    expect(returnChance(h, 'mail.test', MIN, 10 * MIN)).toBeGreaterThan(
      returnChance(emptyHabits(), 'mail.test', MIN, 10 * MIN)
    )
  })

  it('learns from tabs left hidden and never looked at again, without them being closed', () => {
    const h = emptyHabits()
    for (let i = 0; i < 100; i++) {
      // Reported as its time hidden grows, never shown again.
      let from = 0
      for (const to of [5 * MIN, 30 * MIN, 2 * HOUR, 10 * HOUR, 30 * HOUR]) {
        observeHidden(h, 'paper.test', from, to, false, i * MIN)
        from = to
      }
    }
    expect(returnChance(h, 'paper.test', 2 * HOUR, HOUR)).toBeLessThan(0.05)
    // Another site leans on the overall habits, which are now less generous too.
    expect(returnChance(h, 'other.test', 2 * HOUR, HOUR)).toBeLessThan(
      returnChance(emptyHabits(), 'other.test', 2 * HOUR, HOUR)
    )
  })

  it('ignores tab-strip flicking', () => {
    const h = emptyHabits()
    observeHidden(h, 'a.test', 0, 2_000, true, 0)
    expect(confidence(h)).toBe(0)
  })

  it('forgets the least used sites beyond the limit', () => {
    const h = emptyHabits()
    for (let i = 0; i < MAX_SITES + 20; i++) observeHidden(h, `s${i}.test`, 0, 5 * MIN, true, 0)
    expect(Object.keys(h.sites).length).toBeLessThanOrEqual(MAX_SITES)
  })

  it('borrows only a little from another device', () => {
    const mine = emptyHabits()
    const theirs = emptyHabits()
    for (let i = 0; i < 200; i++) {
      observeHidden(theirs, 'video.test', 0, 10 * HOUR, false, 0)
      observeHidden(mine, 'video.test', 0, 2 * MIN, true, 0)
    }
    const merged = mergeHabits(mine, theirs, 0.2, 0)
    const own = returnChance(mine, 'video.test', 30 * 1000, 10 * MIN)
    const m = returnChance(merged, 'video.test', 30 * 1000, 10 * MIN)
    expect(m).toBeLessThanOrEqual(own)
    expect(m).toBeGreaterThan(own * 0.7)
  })

  it('reads back what it stored and drops anything malformed', () => {
    const h = emptyHabits(5)
    observeHidden(h, 'a.test', 0, 5 * MIN, true, 5)
    expect(sanitizeHabits(JSON.parse(JSON.stringify(h)), 5)).toEqual(h)
    expect(sanitizeHabits({ version: 2, all: { returned: [1] } }, 5)).toEqual(emptyHabits(5))
    expect(sanitizeHabits(null, 5)).toEqual(emptyHabits(5))
  })
})
