// @vitest-environment happy-dom
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { Suggestion } from '@shared/types'
import {
  EXIT_SCALE,
  headingKey,
  headingLeavesWith,
  listOffsets,
  moverDeltas,
  runRowExit,
  withoutExit
} from '../rowExit'

/*
 * A suggestion row's exit from the phone card (OMN-17, v2 §11.4): the pure parts – which rows
 * stay, whether the heading goes too, the FLIP deltas – and the motion: one spring on transform
 * and opacity, the movers gliding from where they were to where they stand, the ghosts fading
 * and the row shrinking, a 120 ms fade in place under reduced motion.
 */

const row = (id: string, group?: string): Suggestion =>
  ({
    id,
    kind: 'history',
    title: id,
    subtitle: '',
    url: null,
    favicon: null,
    targetId: null,
    fill: id,
    ...(group ? { group } : {})
  }) as Suggestion

/** A list item standing `top` px down the list (happy-dom lays nothing out; the offsets are given). */
function item(list: HTMLElement, top: number): HTMLElement {
  const li = document.createElement('li')
  Object.defineProperty(li, 'offsetTop', { value: top, configurable: true, writable: true })
  list.appendChild(li)
  return li
}

let reduced = false
const matchMedia = window.matchMedia
window.matchMedia = ((query: string) => ({
  matches: reduced && query.includes('reduce'),
  media: query
})) as typeof window.matchMedia

afterEach(() => {
  reduced = false
})
afterAll(() => {
  window.matchMedia = matchMedia
})

describe('what leaves', () => {
  it('the heading goes with the row only when no other row shares its group', () => {
    const rows = [row('a'), row('b', 'Pages'), row('c', 'Pages'), row('d', 'Searches')]
    expect(headingLeavesWith(rows, rows[1])).toBe(false)
    expect(headingLeavesWith(rows, rows[3])).toBe(true)
    expect(headingLeavesWith(rows, rows[0])).toBe(false)
    expect(headingKey('Pages')).toBe('group-Pages')
  })

  it('withoutExit drops the leaving row and leaves the rest in order', () => {
    const rows = [row('a'), row('b', 'Pages'), row('c')]
    expect(withoutExit(rows, { id: 'b', heading: null, ghosts: {} }).map((r) => r.id)).toEqual([
      'a',
      'c'
    ])
    expect(withoutExit(rows, null).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('moverDeltas: how far each item that stayed has moved, the ghosts and the still ones left out', () => {
    const list = document.createElement('ul')
    const a = item(list, 0)
    const ghost = item(list, 44)
    const c = item(list, 88)
    const d = item(list, 132)
    const before = listOffsets(list)
    expect([...before.values()]).toEqual([0, 44, 88, 132])
    // The ghost left the flow: c and d moved up by its 44.
    Object.defineProperty(c, 'offsetTop', { value: 44 })
    Object.defineProperty(d, 'offsetTop', { value: 88 })
    const movers = moverDeltas(before, list, new Set([ghost]))
    expect(movers.get(a)).toBeUndefined()
    expect(movers.get(ghost)).toBeUndefined()
    expect(movers.get(c)).toBe(44)
    expect(movers.get(d)).toBe(44)
  })
})

describe('the motion', () => {
  it('paints the first frame at once – the movers where they were – then glides them home, fading the ghosts, and reports rest', async () => {
    const rowEl = document.createElement('li')
    const heading = document.createElement('li')
    const mover = document.createElement('li')
    const done = vi.fn()
    runRowExit({ row: rowEl, heading }, new Map([[mover, 44]]), done)
    expect(mover.style.transform).toBe('translate3d(0, 44.00px, 0)')
    expect(rowEl.style.opacity).toBe('1')
    expect(heading.style.opacity).toBe('1')
    expect(rowEl.style.transform).toBe('scale(1.0000)')
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 4000 })
    expect(mover.style.transform).toBe('')
    expect(rowEl.style.opacity).toBe('0')
    expect(heading.style.opacity).toBe('0')
    expect(rowEl.style.transform).toBe(`scale(${(1 - EXIT_SCALE).toFixed(4)})`)
  })

  it('can be stopped: nothing more is painted and rest is never reported', async () => {
    const rowEl = document.createElement('li')
    const mover = document.createElement('li')
    const done = vi.fn()
    const stop = runRowExit({ row: rowEl, heading: null }, new Map([[mover, 44]]), done)
    stop()
    await new Promise((r) => setTimeout(r, 200))
    expect(done).not.toHaveBeenCalled()
    expect(mover.style.transform).toBe('translate3d(0, 44.00px, 0)')
  })

  it('under reduced motion the ghosts fade in place over 120 ms and the movers cut to their slots', async () => {
    reduced = true
    const rowEl = document.createElement('li')
    const mover = document.createElement('li')
    const done = vi.fn()
    runRowExit({ row: rowEl, heading: null }, new Map([[mover, 44]]), done)
    expect(mover.style.transform).toBe('')
    expect(rowEl.style.transform).toBe('')
    expect(done).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 1000 })
  })
})
