import { describe, expect, it } from 'vitest'
import type { Folder, Rect, Tab } from '@shared/types'
import type { Departure } from '../departureStore'
import { QUICK_DELETE_SWEEP_MS, closesTabs, wipeSchedule } from '../quickDelete'

/*
 * Quick Delete's wipe schedule (matrix MOT-24; Chrome 152's `QuickDeleteAnimationGradientDrawable`
 * sweeping the switcher bottom-up): the one constant `QUICK_DELETE_SWEEP_MS` spreads the held
 * exits' starts over the visible grid's height by card BOTTOM – the card at the grid's bottom
 * edge first, the one at its top last, a row together – and the motion runs only for a clear
 * whose `types` carry `'tabs'`.
 */

const tab = (id: string): Tab => ({ id, title: id, url: `https://${id}.example/` }) as Tab
const rect = (y: number, height: number): Rect => ({ x: 0, y, width: 100, height })
const card = (id: string, y: number, height = 150, held = true): Departure =>
  held
    ? { key: id, kind: 'tab', tab: tab(id), rect: rect(y, height), held: true }
    : { key: id, kind: 'tab', tab: tab(id), rect: rect(y, height) }
const GRID = rect(100, 600)

describe('wipeSchedule', () => {
  it('sets the cards off bottom-up by card bottom, in proportion to the distance from the grid’s bottom edge', () => {
    // Bottoms at 250 (top row), 450 (middle row) and 700 (the grid's bottom edge, 100 + 600).
    const exits = [card('top', 100), card('middle', 300), card('bottom', 550)]
    expect(wipeSchedule(exits, GRID, 600)).toEqual([
      { key: 'top', delay: 450 },
      { key: 'middle', delay: 250 },
      { key: 'bottom', delay: 0 }
    ])
  })

  it('a row’s cards set off together: the same bottom, the same delay', () => {
    const [left, right] = wipeSchedule([card('l', 300), card('r', 300)], GRID, 600)
    expect(left?.delay).toBe(right?.delay)
  })

  it('a card below the visible grid goes at once, one above it at the sweep’s end', () => {
    const exits = [card('below', 900), card('above', -300)]
    expect(wipeSchedule(exits, GRID, 250)).toEqual([
      { key: 'below', delay: 0 },
      { key: 'above', delay: 250 }
    ])
  })

  it('with the sweep at 0, or no grid to measure, every card goes at once (gate (a)’s other answer is that one line)', () => {
    const exits = [card('top', 100), card('bottom', 550)]
    expect(wipeSchedule(exits, GRID, 0).map((s) => s.delay)).toEqual([0, 0])
    expect(wipeSchedule(exits, null, 250).map((s) => s.delay)).toEqual([0, 0])
  })

  it('schedules the held exits alone: the New Tab card leaving with the close is the commit’s, not the sweep’s', () => {
    const folder: Folder = {
      id: 'g',
      spaceId: 's',
      name: 'Group',
      icon: '',
      collapsed: false,
      color: 'blue'
    }
    const exits: Departure[] = [
      card('a', 100),
      { key: 'new-tab', kind: 'new-tab', isPrivate: false, rect: rect(550, 150), with: ['a'] },
      {
        key: 'group:g',
        kind: 'group',
        folder,
        tabs: [tab('m')],
        rect: rect(300, 150),
        columns: 2,
        held: true
      },
      card('loose', 300, 150, false)
    ]
    expect(wipeSchedule(exits, GRID, 250).map((s) => s.key)).toEqual(['a', 'group:g'])
  })

  it('the sweep is one constant, near Chrome’s crossing of the visible grid', () => {
    // Chrome's gradient crosses the visible grid in about 380 ms of its 1200 ms curve; the house
    // sweep stands in for it as one number (gate question (a) folds it to 0 or another in one line).
    expect(QUICK_DELETE_SWEEP_MS).toBe(250)
  })
})

describe('closesTabs', () => {
  it('runs the motion only for a clear with the Tabs row on', () => {
    expect(closesTabs(['history', 'cookies', 'cache', 'tabs'])).toBe(true)
    expect(closesTabs(['history', 'cookies', 'cache'])).toBe(false)
    expect(closesTabs([])).toBe(false)
  })
})
