import { describe, expect, it } from 'vitest'
import {
  OOM_ADJ_FROZEN,
  OOM_ADJ_HIDDEN,
  OOM_ADJ_VISIBLE,
  OomPriority,
  oomAdjustments
} from '../resources/oomPriority'

/*
 * Under a memory limit Linux kills the process with the highest oom_score; the browser makes
 * that a hidden page's renderer (which the tab manager treats as a sleeping tab) rather than
 * itself.
 */

describe('oomAdjustments', () => {
  it('ranks frozen above hidden above visible', () => {
    const adj = oomAdjustments([
      { pids: [1], visible: true, frozen: false },
      { pids: [2], visible: false, frozen: false },
      { pids: [3], visible: false, frozen: true }
    ])
    expect(adj.get(1)).toBe(OOM_ADJ_VISIBLE)
    expect(adj.get(2)).toBe(OOM_ADJ_HIDDEN)
    expect(adj.get(3)).toBe(OOM_ADJ_FROZEN)
  })

  it('protects a shared renderer as its most visible page', () => {
    const adj = oomAdjustments([
      { pids: [5, 6], visible: false, frozen: true },
      { pids: [5], visible: true, frozen: false }
    ])
    expect(adj.get(5)).toBe(OOM_ADJ_VISIBLE)
    expect(adj.get(6)).toBe(OOM_ADJ_FROZEN)
  })
})

describe('OomPriority', () => {
  it('writes only changes, and nothing off Linux', () => {
    const writes: Array<[number, number]> = []
    const oom = new OomPriority('linux', (pid, v) => void writes.push([pid, v]))
    oom.apply([{ pids: [1], visible: false, frozen: false }])
    oom.apply([{ pids: [1], visible: false, frozen: false }])
    oom.apply([{ pids: [1], visible: true, frozen: false }])
    expect(writes).toEqual([
      [1, OOM_ADJ_HIDDEN],
      [1, OOM_ADJ_VISIBLE]
    ])
    const none: number[] = []
    new OomPriority('win32', (pid) => void none.push(pid)).apply([
      { pids: [1], visible: false, frozen: false }
    ])
    expect(none).toEqual([])
  })

  it('survives a refused write', () => {
    const oom = new OomPriority('linux', () => {
      throw new Error('EACCES')
    })
    expect(() => oom.apply([{ pids: [9], visible: false, frozen: true }])).not.toThrow()
  })
})
