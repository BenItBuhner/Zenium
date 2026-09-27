import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Folder, Rect, Tab } from '@shared/types'
import { clearDepartures, departStore, type Departure } from '../departureStore'
import { exitProgressAt } from '../exitSpring'
import {
  QUICK_DELETE_SWEEP_MS,
  closesTabs,
  holdQuickDeleteWipe,
  setQuickDeleteWipe,
  wipeSchedule
} from '../quickDelete'

const invoke = vi.fn<(channel: string, args: unknown) => Promise<unknown>>(async () => undefined)
vi.stubGlobal('window', { zen: { invoke } })

afterEach(() => {
  clearDepartures()
  setQuickDeleteWipe(null)
  invoke.mockReset()
})

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

describe('exitProgressAt', () => {
  it('is the exit spring’s closed form: whole before the run, further along as time passes, at rest well inside a second', () => {
    expect(exitProgressAt(-50)).toBe(0)
    expect(exitProgressAt(0)).toBe(0)
    const at = [16, 60, 120, 250, 500].map(exitProgressAt)
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1] ?? 0)
    expect(at[0]).toBeGreaterThan(0)
    expect(exitProgressAt(500)).toBeGreaterThan(0.99)
    expect(exitProgressAt(5000)).toBeLessThanOrEqual(1)
  })
})

describe('holdQuickDeleteWipe (the preview host’s still)', () => {
  it('reads the range as the runner does and holds each exit at the frame the schedule would have it on – the grid’s bottom furthest gone, nothing released', async () => {
    invoke.mockImplementation(async (channel) =>
      channel === 'privacy.tabsInRange' ? ['top', 'bottom', 'out'] : null
    )
    const built = vi.fn((ids: readonly string[]) => ({
      exits: [card('top', 100), card('bottom', 550)].filter((e) => ids.includes(e.key)),
      grid: GRID
    }))
    setQuickDeleteWipe(built)
    expect(await holdQuickDeleteWipe('15min', 120)).toBe(true)
    expect(invoke).toHaveBeenCalledWith('privacy.tabsInRange', { range: '15min' })
    expect(built).toHaveBeenCalledWith(['top', 'bottom', 'out'])
    const s = departStore.get()
    const frozen = new Map(
      s.items.map((i) => [i.key, i.kind === 'new-tab' ? undefined : i.frozen] as const)
    )
    // The bottom card is 120 ms into its run; the top one sets off 450 × 250 / 600 ≈ 188 ms later
    // (the sweep's share of its distance from the grid's bottom), so it stands whole.
    expect(frozen.get('bottom')).toBeCloseTo(exitProgressAt(120), 10)
    expect(frozen.get('top')).toBe(0)
    expect(s.released.size).toBe(0)
    expect(s.hidden).toEqual(new Set(['top', 'bottom']))
  })

  it('holds nothing when the overview has no card for the range', async () => {
    invoke.mockImplementation(async () => [])
    setQuickDeleteWipe(() => ({ exits: [], grid: GRID }))
    expect(await holdQuickDeleteWipe('15min', 120)).toBe(false)
    expect(departStore.get().items).toEqual([])
    setQuickDeleteWipe(null)
    expect(await holdQuickDeleteWipe('15min', 120)).toBe(false)
  })
})
