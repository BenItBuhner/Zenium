import { describe, expect, it } from 'vitest'
import {
  NO_SELECTION,
  orderedSelection,
  pruneSelection,
  selectAll,
  startSelection,
  toggleSelected
} from '../multiSelect'

describe('multiSelect', () => {
  it('a long press enters selection mode with that row picked', () => {
    const s = startSelection('a')
    expect(s.active).toBe(true)
    expect([...s.ids]).toEqual(['a'])
  })

  it('taps toggle rows and unpicking the last one leaves the mode', () => {
    let s = startSelection('a')
    s = toggleSelected(s, 'b')
    expect([...s.ids].sort()).toEqual(['a', 'b'])
    s = toggleSelected(s, 'a')
    expect([...s.ids]).toEqual(['b'])
    expect(s.active).toBe(true)
    s = toggleSelected(s, 'b')
    expect(s.ids.size).toBe(0)
    expect(s.active).toBe(false)
  })

  it('does not mutate the previous selection', () => {
    const first = startSelection('a')
    const second = toggleSelected(first, 'b')
    expect(first.ids.size).toBe(1)
    expect(second.ids.size).toBe(2)
  })

  it('select all picks every row', () => {
    const s = selectAll(['a', 'b', 'c'])
    expect(s.active).toBe(true)
    expect(s.ids.size).toBe(3)
  })

  it('pruning drops rows that vanished and ends the mode when none remain', () => {
    const s = selectAll(['a', 'b'])
    const pruned = pruneSelection(s, ['b', 'c'])
    expect([...pruned.ids]).toEqual(['b'])
    expect(pruned.active).toBe(true)
    const emptied = pruneSelection(pruned, ['c'])
    expect(emptied.active).toBe(false)
    expect(emptied.ids.size).toBe(0)
  })

  it('pruning returns the same object when nothing changed', () => {
    const s = selectAll(['a'])
    expect(pruneSelection(s, ['a', 'b'])).toBe(s)
    expect(pruneSelection(NO_SELECTION, [])).toBe(NO_SELECTION)
  })

  it('orders the picked rows the way the list shows them', () => {
    const s = selectAll(['c', 'a'])
    expect(orderedSelection(s, ['a', 'b', 'c', 'd'])).toEqual(['a', 'c'])
  })
})
