import { describe, expect, it } from 'vitest'
import {
  launchHandshakeNote,
  overRenderBudget,
  renderBudgetError,
  renderSignal,
  renderTimeForBudget
} from './render-timing.mjs'

describe('render-timing: the reading the budget is judged on', () => {
  it('prefers the renderer first paint over the composite', () => {
    const timings = { firstPaintMs: 1102, chromeRenderedMs: 10154 }
    expect(renderTimeForBudget(timings)).toBe(1102)
    expect(renderSignal(timings)).toBe('first-paint')
  })

  it('falls back to the composite when the renderer reported no paint', () => {
    const timings = { firstPaintMs: null, chromeRenderedMs: 1263 }
    expect(renderTimeForBudget(timings)).toBe(1263)
    expect(renderSignal(timings)).toBe('composite')
  })

  it('treats a missing or non-finite first paint as no paint', () => {
    expect(renderSignal({ chromeRenderedMs: 900 })).toBe('composite')
    expect(renderSignal({ firstPaintMs: NaN, chromeRenderedMs: 900 })).toBe('composite')
    expect(renderSignal({ firstPaintMs: -1, chromeRenderedMs: 900 })).toBe('composite')
    expect(renderTimeForBudget({ chromeRenderedMs: 900 })).toBe(900)
  })

  it('is NaN when there is nothing to judge', () => {
    expect(Number.isNaN(renderTimeForBudget({}))).toBe(true)
    expect(Number.isNaN(renderTimeForBudget(undefined))).toBe(true)
  })
})

describe('render-timing: the budget verdict', () => {
  it('does not fail when the paint is under budget though the composite is over', () => {
    // The W8-H2 failures: a fully painted chrome behind a launch handshake that waited ~10 s.
    const timings = { firstPaintMs: 1102, chromeRenderedMs: 10154 }
    expect(overRenderBudget(timings, 10000)).toBe(false)
    expect(renderBudgetError(timings, 10000)).toBeNull()
  })

  it('fails when the renderer itself painted late, on every launch', () => {
    const timings = { firstPaintMs: 12000, chromeRenderedMs: 12050 }
    expect(overRenderBudget(timings, 10000)).toBe(true)
    expect(renderBudgetError(timings, 10000)).toBe(
      'chrome first paint after 12000 ms (budget 10000 ms); launch handshake 12050 ms'
    )
  })

  it('fails on the composite when the renderer reported no paint', () => {
    const timings = { firstPaintMs: null, chromeRenderedMs: 10500 }
    expect(overRenderBudget(timings, 10000)).toBe(true)
    expect(renderBudgetError(timings, 10000)).toBe(
      'chrome rendered after 10500 ms (budget 10000 ms)'
    )
  })

  it('carries the first-launch note', () => {
    const timings = { firstPaintMs: 21000, chromeRenderedMs: 21050 }
    expect(renderBudgetError(timings, 20000, { firstLaunch: true })).toBe(
      'chrome first paint after 21000 ms (budget 20000 ms for the first launch of the run); launch handshake 21050 ms'
    )
  })

  it('a reading that is not a number is never over budget', () => {
    expect(overRenderBudget({}, 10000)).toBe(false)
    expect(renderBudgetError({}, 10000)).toBeNull()
  })
})

describe('render-timing: the handshake note', () => {
  it('names a handshake over budget behind a paint within it, with every timed phase', () => {
    const timings = {
      firstPaintMs: 1102,
      chromeRenderedMs: 10154,
      launchResolveMs: 10020,
      hookMs: 32,
      pidMs: 4,
      chromePageMs: 60,
      rootAttachMs: 38,
      processStartMs: 41,
      nodeStartMs: 120,
      chromeNavStartMs: 610
    }
    expect(launchHandshakeNote(timings, 10000)).toBe(
      'launch handshake 10154 ms over the render budget (10000 ms) while the chrome painted at 1102 ms; ' +
        'electron.launch 10020 ms, hook 32 ms, pid 4 ms, page 60 ms, root 38 ms, process at 41 ms, ' +
        'node at 120 ms, chrome document at 610 ms'
    )
  })

  it('lists only the phases that were timed', () => {
    const timings = { firstPaintMs: 900, chromeRenderedMs: 10100, hookMs: 9500 }
    expect(launchHandshakeNote(timings, 10000)).toBe(
      'launch handshake 10100 ms over the render budget (10000 ms) while the chrome painted at 900 ms; hook 9500 ms'
    )
  })

  it('is silent for a handshake within budget', () => {
    expect(launchHandshakeNote({ firstPaintMs: 900, chromeRenderedMs: 1200 }, 10000)).toBeNull()
    expect(launchHandshakeNote({ firstPaintMs: 900, chromeRenderedMs: 10000 }, 10000)).toBeNull()
  })

  it('is silent when the composite was the verdict (no paint reading) or there is nothing to read', () => {
    expect(launchHandshakeNote({ firstPaintMs: null, chromeRenderedMs: 10500 }, 10000)).toBeNull()
    expect(launchHandshakeNote(undefined, 10000)).toBeNull()
  })
})
