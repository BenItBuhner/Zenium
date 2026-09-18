import type { Rect } from '../../shared/types'

/** What placement needs to know about a display. */
export interface DisplayArea {
  id: number
  /** The area windows may occupy (the screen minus panels and docks). */
  workArea: Rect
}

export interface PlacementInput {
  /** The window's last normal bounds, if it has any. */
  saved: Rect | null
  /** The display `saved` was on, when known. */
  displayId: number | null
  minWidth: number
  minHeight: number
  /** The size a window without saved bounds gets, within the display. */
  defaultSize: { width: number; height: number }
}

/** Fraction of a rectangle's area that lies within another. */
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  return (w * h) / Math.max(1, a.width * a.height)
}

/** The display `rect` mostly lies on, or null when it lies on none. */
export function displayMatching(rect: Rect, displays: DisplayArea[]): DisplayArea | null {
  let best: DisplayArea | null = null
  let bestOverlap = 0
  for (const d of displays) {
    const o = overlap(rect, d.workArea)
    if (o > bestOverlap) {
      best = d
      bestOverlap = o
    }
  }
  return best
}

/** `size` centred in `area` (and no larger than it). */
export function centredIn(
  area: Rect,
  size: { width: number; height: number },
  minWidth: number,
  minHeight: number
): Rect {
  const width = Math.max(minWidth, Math.min(size.width, area.width))
  const height = Math.max(minHeight, Math.min(size.height, area.height))
  return {
    width,
    height,
    x: area.x + Math.max(0, Math.round((area.width - width) / 2)),
    y: area.y + Math.max(0, Math.round((area.height - height) / 2))
  }
}

/**
 * Where a window goes when it is created: its saved bounds, on the display they were saved on
 * when that display is still there, otherwise on the display they mostly lie on, otherwise on
 * the primary – fitted into that display's work area (no larger than it, fully inside it), so a
 * window never comes back off-screen after a monitor was unplugged or rearranged. Without saved
 * bounds, the default size centred on the primary display. `displays[0]` is the primary.
 */
export function placeWindow(input: PlacementInput, displays: DisplayArea[]): Rect {
  const primary = displays[0]
  if (!primary) {
    return { x: 0, y: 0, width: input.defaultSize.width, height: input.defaultSize.height }
  }
  const { saved, minWidth, minHeight } = input
  if (!saved) {
    const area = primary.workArea
    return centredIn(
      area,
      {
        width: Math.min(input.defaultSize.width, area.width - 40),
        height: Math.min(input.defaultSize.height, area.height - 40)
      },
      minWidth,
      minHeight
    )
  }
  const remembered =
    input.displayId !== null ? displays.find((d) => d.id === input.displayId) : undefined
  const target = remembered ?? displayMatching(saved, displays) ?? primary
  const area = target.workArea
  const width = Math.max(minWidth, Math.min(saved.width, area.width))
  const height = Math.max(minHeight, Math.min(saved.height, area.height))
  // A window that lay on none of the displays (its screen is gone) is centred on the one it
  // gets; one that lay on its display is only nudged back in where it hangs over the edge.
  if (!remembered && overlap(saved, area) === 0)
    return centredIn(area, { width, height }, minWidth, minHeight)
  return {
    width,
    height,
    x: Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(saved.y, area.y), area.y + area.height - height)
  }
}
