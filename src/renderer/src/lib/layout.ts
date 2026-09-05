import type { Rect, SplitGroup, SplitLayout, ViewPlacement } from '@shared/types'

export const SPLIT_GAP = 6
export const SPLIT_HEADER = 24

/**
 * Compute where each tab of a split group goes inside `area`. Every pane reserves a header
 * strip for the split controls (Zen draws them as an overlay on top of the active pane).
 *
 * Layout semantics follow Zen: `vertical` = vertical separator (tabs side by side),
 * `horizontal` = horizontal separator (tabs stacked), `grid` = 2 columns, wrapping.
 */
export function splitPaneRects(
  area: Rect,
  group: SplitGroup
): Array<{ tabId: string; rect: Rect; header: Rect }> {
  const n = group.tabIds.length
  const sizes = normalise(group.sizes, n)
  const cells: Rect[] = []
  if (group.layout === 'vertical') {
    let x = area.x
    const usable = area.width - SPLIT_GAP * (n - 1)
    sizes.forEach((s) => {
      const w = usable * s
      cells.push({ x, y: area.y, width: w, height: area.height })
      x += w + SPLIT_GAP
    })
  } else if (group.layout === 'horizontal') {
    let y = area.y
    const usable = area.height - SPLIT_GAP * (n - 1)
    sizes.forEach((s) => {
      const h = usable * s
      cells.push({ x: area.x, y, width: area.width, height: h })
      y += h + SPLIT_GAP
    })
  } else {
    cells.push(...gridCells(area, n))
  }
  return group.tabIds.map((tabId, i) => {
    const cell = cells[i]
    return {
      tabId,
      header: { x: cell.x, y: cell.y, width: cell.width, height: SPLIT_HEADER },
      rect: {
        x: cell.x,
        y: cell.y + SPLIT_HEADER,
        width: cell.width,
        height: Math.max(0, cell.height - SPLIT_HEADER)
      }
    }
  })
}

function gridCells(area: Rect, n: number): Rect[] {
  if (n <= 1) return [area]
  const cols = 2
  const rows = Math.ceil(n / cols)
  const cellW = (area.width - SPLIT_GAP * (cols - 1)) / cols
  const cellH = (area.height - SPLIT_GAP * (rows - 1)) / rows
  const cells: Rect[] = []
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const lastRowSingle = row === rows - 1 && n % cols === 1
    cells.push({
      x: area.x + col * (cellW + SPLIT_GAP),
      y: area.y + row * (cellH + SPLIT_GAP),
      width: lastRowSingle ? area.width : cellW,
      height: cellH
    })
  }
  return cells
}

function normalise(sizes: number[], n: number): number[] {
  if (sizes.length !== n) return Array.from({ length: n }, () => 1 / n)
  const total = sizes.reduce((a, b) => a + b, 0) || 1
  return sizes.map((s) => s / total)
}

export function placementsFor(
  area: Rect,
  tabIds: string[],
  group: SplitGroup | null,
  radius: number
): ViewPlacement[] {
  if (group && tabIds.length > 1) {
    return splitPaneRects(area, group).map((p) => ({ tabId: p.tabId, rect: p.rect, radius }))
  }
  return tabIds.slice(0, 1).map((tabId) => ({ tabId, rect: area, radius }))
}

/** Rect of the glance card inside the content area. */
export function glanceRect(area: Rect): Rect {
  const width = Math.min(area.width * 0.85, 1280)
  const height = Math.min(area.height * 0.85, 900)
  return {
    x: area.x + (area.width - width) / 2,
    y: area.y + (area.height - height) / 2,
    width,
    height
  }
}

export function gutterRects(
  area: Rect,
  group: SplitGroup
): Array<{ index: number; rect: Rect; axis: 'x' | 'y' }> {
  if (group.layout === 'grid') return []
  const panes = splitPaneRects(area, group)
  const gutters: Array<{ index: number; rect: Rect; axis: 'x' | 'y' }> = []
  for (let i = 0; i < panes.length - 1; i++) {
    const a = panes[i].header
    const bRect = panes[i + 1].header
    if (group.layout === 'vertical') {
      gutters.push({
        index: i,
        axis: 'x',
        rect: { x: a.x + a.width, y: area.y, width: SPLIT_GAP, height: area.height }
      })
    } else {
      gutters.push({
        index: i,
        axis: 'y',
        rect: { x: area.x, y: bRect.y - SPLIT_GAP, width: area.width, height: SPLIT_GAP }
      })
    }
  }
  return gutters
}

export function layoutLabel(layout: SplitLayout): string {
  return layout === 'grid' ? 'Grid' : layout === 'vertical' ? 'Side by side' : 'Stacked'
}
