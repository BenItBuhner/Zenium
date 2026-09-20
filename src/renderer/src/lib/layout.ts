import type { ContentCover, Rect, SplitGroup, SplitLayout, ViewPlacement } from '@shared/types'

export const SPLIT_GAP = 6
/** Wider gap on touch screens: the gutter between panes is the only place a finger can grab. */
export const SPLIT_GAP_TOUCH = 12
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
  group: SplitGroup,
  gap = SPLIT_GAP
): Array<{ tabId: string; rect: Rect; header: Rect }> {
  const n = group.tabIds.length
  const cells = splitCells(area, group.layout, normalise(group.sizes, n), gap)
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

/**
 * The cells of a split's layout inside `area`, one per share (the shares sum to 1), `gap`
 * between them: the panes' geometry, and the strip glyph's (`SplitGlyph`), which draws the
 * same layout in a 16 px box with equal shares and no gap.
 */
export function splitCells(area: Rect, layout: SplitLayout, shares: number[], gap: number): Rect[] {
  const n = shares.length
  const cells: Rect[] = []
  if (layout === 'vertical') {
    let x = area.x
    const usable = area.width - gap * (n - 1)
    shares.forEach((s) => {
      const w = usable * s
      cells.push({ x, y: area.y, width: w, height: area.height })
      x += w + gap
    })
  } else if (layout === 'horizontal') {
    let y = area.y
    const usable = area.height - gap * (n - 1)
    shares.forEach((s) => {
      const h = usable * s
      cells.push({ x: area.x, y, width: area.width, height: h })
      y += h + gap
    })
  } else {
    cells.push(...gridCells(area, n, gap))
  }
  return cells
}

function gridCells(area: Rect, n: number, gap: number): Rect[] {
  if (n <= 1) return [area]
  const cols = 2
  const rows = Math.ceil(n / cols)
  const cellW = (area.width - gap * (cols - 1)) / cols
  const cellH = (area.height - gap * (rows - 1)) / rows
  const cells: Rect[] = []
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const lastRowSingle = row === rows - 1 && n % cols === 1
    cells.push({
      x: area.x + col * (cellW + gap),
      y: area.y + row * (cellH + gap),
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
  radius: number,
  gap = SPLIT_GAP
): ViewPlacement[] {
  if (group && tabIds.length > 1) {
    return splitPaneRects(area, group, gap).map((p) => ({ tabId: p.tabId, rect: p.rect, radius }))
  }
  return tabIds.slice(0, 1).map((tabId) => ({ tabId, rect: area, radius }))
}

/**
 * How much of the content area's message strips (`cover`, from the area's top and bottom edges)
 * falls on a view at `rect`: a split pane in the lower half is clear of the banner strip, one in
 * the upper half clear of the toast strip. Undefined when neither strip touches the view.
 */
export function viewCover(area: Rect, rect: Rect, cover: ContentCover): ContentCover | undefined {
  const clamp = (v: number): number => Math.min(rect.height, Math.max(0, v))
  const top = clamp(area.y + cover.top - rect.y)
  const bottom = clamp(rect.y + rect.height - (area.y + area.height - cover.bottom))
  return top > 0 || bottom > 0 ? { top, bottom } : undefined
}

/** The desktop URL bar's field row is this tall (`.zen-omnibox-input-row`). */
export const URLBAR_FIELD_HEIGHT = 62

/**
 * Where the desktop URL bar's field goes in `area` – the content frame, or the empty split pane
 * the bar is the field of (split-04): floating, centred, at most 907 wide with 16 to the area's
 * sides, its top at 16% of the area's height (24 at the least); attached, 8 inside the area's
 * top and sides. The empty pane draws its resting field on the same box (`EmptyPane`), so
 * opening the bar changes nothing but the field's state.
 */
export function urlbarFieldBox(area: Rect, floating: boolean): Rect {
  const width = floating ? Math.min(907, area.width - 32) : area.width - 16
  return {
    x: area.x + (floating ? (area.width - width) / 2 : 8),
    y: area.y + (floating ? Math.max(24, area.height * 0.16) : 8),
    width,
    height: URLBAR_FIELD_HEIGHT
  }
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
  group: SplitGroup,
  gap = SPLIT_GAP
): Array<{ index: number; rect: Rect; axis: 'x' | 'y' }> {
  if (group.layout === 'grid') return []
  const panes = splitPaneRects(area, group, gap)
  const gutters: Array<{ index: number; rect: Rect; axis: 'x' | 'y' }> = []
  for (let i = 0; i < panes.length - 1; i++) {
    const a = panes[i].header
    const bRect = panes[i + 1].header
    if (group.layout === 'vertical') {
      gutters.push({
        index: i,
        axis: 'x',
        rect: { x: a.x + a.width, y: area.y, width: gap, height: area.height }
      })
    } else {
      gutters.push({
        index: i,
        axis: 'y',
        rect: { x: area.x, y: bRect.y - gap, width: area.width, height: gap }
      })
    }
  }
  return gutters
}

/**
 * Columns of the phone tab overview for a window this wide: Chrome's span counts (two under
 * 600 dp, three under 800, four beyond), so a phone on its side gets a row of smaller cards
 * rather than two cards taller than the screen.
 */
export function overviewColumns(width: number): number {
  if (width < 600) return 2
  if (width < 800) return 3
  return 4
}

export function layoutLabel(layout: SplitLayout): string {
  return layout === 'grid' ? 'Grid' : layout === 'vertical' ? 'Side by side' : 'Stacked'
}

/**
 * Whether the native caption buttons (drawn over the window's top trailing corner, `overlay`
 * wide) land on the content column, which then keeps a header band clear above the page. The
 * sidebar's own title row already gives them room when it sits on the right and is wider than
 * they are.
 */
export function captionBandInMain(opts: {
  overlayWidth: number
  sidebarSide: 'left' | 'right'
  /** Width of the visible sidebar; null when compact mode hides it. */
  sidebarWidth: number | null
}): boolean {
  if (opts.overlayWidth <= 0) return false
  if (opts.sidebarWidth === null || opts.sidebarSide === 'left') return true
  return opts.sidebarWidth < opts.overlayWidth
}
