import { describe, expect, it } from 'vitest'
import type { SplitGroup } from '@shared/types'
import {
  SPLIT_GAP,
  SPLIT_HEADER,
  captionBandInMain,
  glanceRect,
  gutterRects,
  overviewColumns,
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

describe('phone overview grid', () => {
  it('gets more columns as the window widens, like Chrome', () => {
    expect(overviewColumns(360)).toBe(2)
    expect(overviewColumns(412)).toBe(2)
    expect(overviewColumns(599)).toBe(2)
    expect(overviewColumns(600)).toBe(3)
    expect(overviewColumns(799)).toBe(3)
    expect(overviewColumns(800)).toBe(4)
    expect(overviewColumns(915)).toBe(4)
  })
})

describe('caption overlay band', () => {
  it('is never needed without an overlay', () => {
    expect(captionBandInMain({ overlayWidth: 0, sidebarSide: 'left', sidebarWidth: 240 })).toBe(
      false
    )
    expect(captionBandInMain({ overlayWidth: 0, sidebarSide: 'right', sidebarWidth: null })).toBe(
      false
    )
  })

  it('keeps the band above the page when the buttons land on the content column', () => {
    expect(captionBandInMain({ overlayWidth: 138, sidebarSide: 'left', sidebarWidth: 240 })).toBe(
      true
    )
    expect(captionBandInMain({ overlayWidth: 138, sidebarSide: 'right', sidebarWidth: null })).toBe(
      true
    )
    expect(captionBandInMain({ overlayWidth: 138, sidebarSide: 'right', sidebarWidth: 56 })).toBe(
      true
    )
  })

  it('lets a right sidebar wider than the buttons host them in its title row', () => {
    expect(captionBandInMain({ overlayWidth: 138, sidebarSide: 'right', sidebarWidth: 240 })).toBe(
      false
    )
  })
})
