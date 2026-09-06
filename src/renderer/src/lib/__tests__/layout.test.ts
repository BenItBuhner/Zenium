import { describe, expect, it } from 'vitest'
import type { SplitGroup } from '@shared/types'
import {
  SPLIT_GAP,
  SPLIT_HEADER,
  glanceRect,
  gutterRects,
  placementsFor,
  splitPaneRects
} from '../layout'

const area = { x: 100, y: 50, width: 1000, height: 600 }
const group = (layout: SplitGroup['layout'], n: number): SplitGroup => ({
  id: 'g',
  spaceId: 's',
  tabIds: Array.from({ length: n }, (_, i) => `t${i}`),
  layout,
  sizes: Array.from({ length: n }, () => 1 / n)
})

describe('split layout', () => {
  it('vertical = side by side columns with a gap and header strips', () => {
    const panes = splitPaneRects(area, group('vertical', 2))
    expect(panes[0].rect.x).toBe(100)
    expect(panes[0].rect.width).toBeCloseTo((1000 - SPLIT_GAP) / 2)
    expect(panes[1].rect.x).toBeCloseTo(100 + (1000 - SPLIT_GAP) / 2 + SPLIT_GAP)
    expect(panes[0].rect.y).toBe(50 + SPLIT_HEADER)
    expect(panes[0].header.height).toBe(SPLIT_HEADER)
  })

  it('horizontal = stacked rows honouring custom sizes', () => {
    const g = group('horizontal', 2)
    g.sizes = [0.25, 0.75]
    const panes = splitPaneRects(area, g)
    const usable = 600 - SPLIT_GAP
    expect(panes[0].header.height + panes[0].rect.height).toBeCloseTo(usable * 0.25)
    expect(panes[1].header.y).toBeCloseTo(50 + usable * 0.25 + SPLIT_GAP)
  })

  it('grid puts 3 tabs in 2 columns with a full-width last row', () => {
    const panes = splitPaneRects(area, group('grid', 3))
    expect(panes[0].header.y).toBe(50)
    expect(panes[1].header.x).toBeGreaterThan(panes[0].header.x)
    expect(panes[2].header.width).toBe(1000)
  })

  it('creates one resize gutter between adjacent panes (none for grid)', () => {
    expect(gutterRects(area, group('vertical', 3))).toHaveLength(2)
    expect(gutterRects(area, group('horizontal', 2))[0].axis).toBe('y')
    expect(gutterRects(area, group('grid', 4))).toHaveLength(0)
  })

  it('places a single tab over the whole area and glance centred at 85%', () => {
    expect(placementsFor(area, ['a'], null, 10)).toEqual([{ tabId: 'a', rect: area, radius: 10 }])
    const g = glanceRect(area)
    expect(g.width).toBeCloseTo(850)
    expect(g.x).toBeCloseTo(100 + 75)
    expect(g.y).toBeCloseTo(50 + 45)
  })
})
