import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginLanding,
  hasLanded,
  landingLost,
  landingReported,
  landingStore,
  markPlacementsSettled,
  noteInsetsSettling,
  notePlacements,
  noteViewSized
} from '../fullscreenLanding'

/*
 * MED-01 / v2 §11.5: the chrome's return fade runs once the page's view has landed, not over
 * the platform's shrink (lib/fullscreenLanding.ts). The host says whether the system bars are
 * on their way back (`settling` on each `insets`) and the size it has drawn each view at
 * (`view.sized`); the chrome notes the placements it reported and on which insets. A view has
 * landed once nothing is settling, its placement was laid out on settled insets, and the host
 * has drawn that size.
 */

const inline = { x: 6, y: 48, width: 399, height: 756 }
const drawn = { width: 399, height: 756 }

function reset(): void {
  landingStore.set({ settling: undefined, placed: new Map(), sized: new Map(), reports: 0 })
}

/** A frame clock in hand: `requestAnimationFrame` runs its callbacks on `tick()`. */
function fakeFrames(): { tick: () => void } {
  let queued: Array<() => void> = []
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    queued.push(cb)
    return queued.length
  })
  return {
    tick: () => {
      const run = queued
      queued = []
      for (const cb of run) cb()
    }
  }
}

beforeEach(reset)
afterEach(() => {
  vi.unstubAllGlobals()
  reset()
})

describe('a host without the word', () => {
  it('reports no landings, and the chrome fades at once on its return', () => {
    expect(landingReported(landingStore.get())).toBe(false)
    noteInsetsSettling(undefined)
    expect(landingReported(landingStore.get())).toBe(false)
    noteInsetsSettling(false)
    expect(landingReported(landingStore.get())).toBe(true)
  })
})

describe('the landing', () => {
  it('needs the bars at rest, a placement laid out on them, and the host drawn at its size', () => {
    noteInsetsSettling(true)
    notePlacements([{ tabId: 't1', rect: inline }], true)
    noteViewSized('t1', drawn.width, drawn.height)
    // Settling: the placement was laid out on the bars' way.
    expect(hasLanded(landingStore.get(), 't1')).toBe(false)
    // The bars at rest; the layout moved for it, so the chrome reports its placement anew.
    landingStore.set({ settling: false })
    expect(hasLanded(landingStore.get(), 't1')).toBe(false)
    notePlacements([{ tabId: 't1', rect: { ...inline, height: 708 } }], false)
    // Reported, but the host has not drawn the new size yet.
    expect(hasLanded(landingStore.get(), 't1')).toBe(false)
    noteViewSized('t1', 399, 708)
    expect(hasLanded(landingStore.get(), 't1')).toBe(true)
    // Another tab has no placement to land on.
    expect(hasLanded(landingStore.get(), 't2')).toBe(false)
  })

  it('allows the host a CSS pixel of rounding on the frame', () => {
    noteInsetsSettling(false)
    notePlacements([{ tabId: 't1', rect: { ...inline, width: 399.43, height: 755.71 } }], false)
    noteViewSized('t1', 400, 756)
    expect(hasLanded(landingStore.get(), 't1')).toBe(true)
    noteViewSized('t1', 402, 756)
    expect(hasLanded(landingStore.get(), 't1')).toBe(false)
  })

  it('is not the placement from before the fullscreen', () => {
    // Before the fullscreen the view stood inline, landed; the return must not take that word.
    noteInsetsSettling(false)
    notePlacements([{ tabId: 't1', rect: inline }], false)
    noteViewSized('t1', drawn.width, drawn.height)
    expect(hasLanded(landingStore.get(), 't1')).toBe(true)
    beginLanding('t1')
    expect(hasLanded(landingStore.get(), 't1')).toBe(false)
    // The host's word on the drawn size stands: the chrome's next report at that size lands.
    expect(landingStore.get().sized.get('t1')).toEqual(drawn)
    notePlacements([{ tabId: 't1', rect: inline }], false)
    expect(hasLanded(landingStore.get(), 't1')).toBe(true)
  })

  it('forgets the size drawn for a view no longer placed', () => {
    noteViewSized('t1', 1, 1)
    noteViewSized('t2', 2, 2)
    notePlacements([{ tabId: 't1', rect: inline }], false)
    expect([...landingStore.get().sized.keys()]).toEqual(['t1'])
  })

  it('is lost once a report since it began leaves the tab out – and not before', () => {
    // The tab is gone at the exit (window.close() in fullscreen, a close from the host): the
    // chrome's next placements name whoever has the screen, or nothing, and never the tab.
    noteInsetsSettling(false)
    notePlacements([{ tabId: 't1', rect: inline }], false)
    const since = beginLanding('t1')
    // Nothing reported since: the tab's absence is the landing's own emptiness, not a loss.
    expect(landingLost(landingStore.get(), 't1', since)).toBe(false)
    // The bars on their way, or not: a report without the tab is the loss either way.
    notePlacements([{ tabId: 't2', rect: inline }], true)
    expect(landingLost(landingStore.get(), 't1', since)).toBe(true)
    expect(hasLanded(landingStore.get(), 't1')).toBe(false)
    // A report that names the tab is not a loss: the landing is on its way as before.
    const again = beginLanding('t1')
    notePlacements([{ tabId: 't1', rect: inline }], true)
    expect(landingLost(landingStore.get(), 't1', again)).toBe(false)
    // An empty report counts: the last tab gone, the chrome asking for no view at all.
    notePlacements([], true)
    expect(landingLost(landingStore.get(), 't1', again)).toBe(true)
  })

  it('counts placement reports alone, not the host’s sizes or the bars settling', () => {
    const frames = fakeFrames()
    const since = beginLanding('t1')
    noteViewSized('t1', drawn.width, drawn.height)
    noteInsetsSettling(true)
    noteInsetsSettling(false)
    frames.tick()
    frames.tick()
    markPlacementsSettled()
    expect(landingStore.get().reports).toBe(since)
    expect(landingLost(landingStore.get(), 't1', since)).toBe(false)
  })
})

describe('the bars settling', () => {
  it('marks a layout that did not move for the settle as laid out on it, two frames on', () => {
    const frames = fakeFrames()
    const area: object = { a: 1 }
    noteInsetsSettling(true, () => area)
    notePlacements([{ tabId: 't1', rect: inline }], true)
    noteViewSized('t1', drawn.width, drawn.height)
    noteInsetsSettling(false, () => area)
    expect(hasLanded(landingStore.get(), 't1')).toBe(false)
    frames.tick()
    expect(hasLanded(landingStore.get(), 't1')).toBe(false)
    frames.tick()
    expect(hasLanded(landingStore.get(), 't1')).toBe(true)
  })

  it('leaves a layout that moved for the settle to its own report', () => {
    const frames = fakeFrames()
    let area: object = { a: 1 }
    noteInsetsSettling(true, () => area)
    notePlacements([{ tabId: 't1', rect: inline }], true)
    noteViewSized('t1', drawn.width, drawn.height)
    noteInsetsSettling(false, () => area)
    // The settled insets moved the content area: a report of the new placement is on its way.
    area = { a: 2 }
    frames.tick()
    frames.tick()
    expect(hasLanded(landingStore.get(), 't1')).toBe(false)
    notePlacements([{ tabId: 't1', rect: { ...inline, height: 708 } }], false)
    noteViewSized('t1', 399, 708)
    expect(hasLanded(landingStore.get(), 't1')).toBe(true)
  })

  it('marks nothing while the bars are on their way again', () => {
    const frames = fakeFrames()
    noteInsetsSettling(true)
    notePlacements([{ tabId: 't1', rect: inline }], true)
    noteInsetsSettling(false)
    noteInsetsSettling(true)
    frames.tick()
    frames.tick()
    expect(landingStore.get().placed.get('t1')?.settled).toBe(false)
    markPlacementsSettled()
    expect(landingStore.get().placed.get('t1')?.settled).toBe(false)
  })

  it('schedules the settle once per settle, not on every insets at rest', () => {
    const frames = fakeFrames()
    const mark = vi.fn(() => null)
    noteInsetsSettling(false, mark)
    noteInsetsSettling(false, mark)
    frames.tick()
    frames.tick()
    // The first word at rest reads the layout's mark now and two frames on; the second, with the
    // bars at rest already, has nothing to follow.
    expect(mark).toHaveBeenCalledTimes(2)
  })
})
