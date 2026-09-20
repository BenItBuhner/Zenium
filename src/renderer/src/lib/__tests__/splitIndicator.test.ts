import { describe, expect, it } from 'vitest'
import type { SplitGroup, Tab, UIState } from '@shared/types'
import { splitCells } from '../layout'
import { splitCardEdges, splitChipLabel, splitMarkOf } from '../selectors'

/*
 * The split indicator in the strip and the pill (split-05, BUG-041): which rows draw which part
 * of the split card's frame, what the glyph stands for, and the cells it draws – the same cells
 * the panes get.
 */

const group = (
  id: string,
  tabIds: string[],
  layout: SplitGroup['layout'] = 'vertical'
): SplitGroup => ({
  id,
  spaceId: 's1',
  tabIds,
  layout,
  sizes: tabIds.map(() => 1 / tabIds.length)
})

const tab = (id: string, splitGroupId: string | null = null): Tab =>
  ({ id, spaceId: 's1', url: `https://${id}.example/`, splitGroupId }) as Tab

const state = (groups: SplitGroup[]): UIState =>
  ({ splitGroups: Object.fromEntries(groups.map((g) => [g.id, g])) }) as unknown as UIState

describe('splitMarkOf', () => {
  it('names the layout, the pane count and the tab’s own pane', () => {
    const g = group('g', ['a', 'b', 'c'], 'grid')
    expect(splitMarkOf(g, 'a')).toEqual({ layout: 'grid', count: 3, index: 0 })
    expect(splitMarkOf(g, 'c')).toEqual({ layout: 'grid', count: 3, index: 2 })
  })

  it('is nothing for a tab out of the split, out of any split, or in a split with no other pane', () => {
    expect(splitMarkOf(group('g', ['a', 'b']), 'x')).toBeNull()
    expect(splitMarkOf(null, 'a')).toBeNull()
    expect(splitMarkOf(undefined, 'a')).toBeNull()
    expect(splitMarkOf(group('g', ['a']), 'a')).toBeNull()
  })
})

describe('splitChipLabel', () => {
  it('reads "In a split view – n panes"', () => {
    expect(splitChipLabel(2)).toBe('In a split view – 2 panes')
    expect(splitChipLabel(4)).toBe('In a split view – 4 panes')
  })
})

describe('splitCardEdges', () => {
  it('frames a run of neighbouring rows of one split as one card: first, middle, last', () => {
    const s = state([group('g', ['a', 'b', 'c'])])
    const edges = splitCardEdges(s, [
      tab('x'),
      tab('a', 'g'),
      tab('b', 'g'),
      tab('c', 'g'),
      tab('y')
    ])
    expect([...edges.entries()]).toEqual([
      ['a', 'first'],
      ['b', 'middle'],
      ['c', 'last']
    ])
  })

  it('frames a row standing alone as a card of its own, so a split whose rows lie apart keeps one frame per run', () => {
    const s = state([group('g', ['a', 'b', 'c'])])
    const edges = splitCardEdges(s, [tab('a', 'g'), tab('x'), tab('b', 'g'), tab('c', 'g')])
    expect(edges.get('a')).toBe('only')
    expect(edges.get('b')).toBe('first')
    expect(edges.get('c')).toBe('last')
    expect(edges.has('x')).toBe(false)
  })

  it('keeps two splits side by side apart, and frames no row of a split the snapshot no longer has or that has one pane left', () => {
    const s = state([group('g', ['a', 'b']), group('h', ['c', 'd']), group('lone', ['e'])])
    const edges = splitCardEdges(s, [
      tab('a', 'g'),
      tab('b', 'g'),
      tab('c', 'h'),
      tab('d', 'h'),
      tab('e', 'lone'),
      tab('f', 'gone')
    ])
    expect([...edges.entries()]).toEqual([
      ['a', 'first'],
      ['b', 'last'],
      ['c', 'first'],
      ['d', 'last']
    ])
  })
})

describe('splitCells for the glyph', () => {
  const box = { x: 0, y: 0, width: 12, height: 12 }
  const equal = (n: number): number[] => Array.from({ length: n }, () => 1 / n)

  it('draws columns for a vertical split and rows for a horizontal one', () => {
    expect(splitCells(box, 'vertical', equal(3), 0)).toEqual([
      { x: 0, y: 0, width: 4, height: 12 },
      { x: 4, y: 0, width: 4, height: 12 },
      { x: 8, y: 0, width: 4, height: 12 }
    ])
    expect(splitCells(box, 'horizontal', equal(2), 0)).toEqual([
      { x: 0, y: 0, width: 12, height: 6 },
      { x: 0, y: 6, width: 12, height: 6 }
    ])
  })

  it('draws the 2-column grid, the odd last pane across the bottom, as the panes are laid out', () => {
    expect(splitCells(box, 'grid', equal(3), 0)).toEqual([
      { x: 0, y: 0, width: 6, height: 6 },
      { x: 6, y: 0, width: 6, height: 6 },
      { x: 0, y: 6, width: 12, height: 6 }
    ])
    expect(splitCells(box, 'grid', equal(4), 0)).toEqual([
      { x: 0, y: 0, width: 6, height: 6 },
      { x: 6, y: 0, width: 6, height: 6 },
      { x: 0, y: 6, width: 6, height: 6 },
      { x: 6, y: 6, width: 6, height: 6 }
    ])
  })
})
