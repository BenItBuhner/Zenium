import type { JSX } from 'react'
import { useId } from 'react'
import type { Rect, SplitLayout } from '@shared/types'
import { splitCells } from '@renderer/lib/layout'
import { cn } from '@renderer/lib/utils'

interface Props {
  layout: SplitLayout
  /** Panes in the split (2–4). */
  count: number
  /** The pane this glyph stands for: its cell is filled, the others are outlined. */
  index: number
  /** The drawn size; the glyph is designed on a 16 box. */
  size?: number
  className?: string
}

const BOX = 16
const STROKE = 1.25
/** The frame's stroke centre sits 1.125 in: its outer edge at 0.5, its inner edge at 1.75. */
const FRAME_INSET = 1.125
const FRAME_RADIUS = 3
/** Inside the frame's stroke: where the cells are laid out. */
const INNER: Rect = {
  x: FRAME_INSET + STROKE / 2,
  y: FRAME_INSET + STROKE / 2,
  width: BOX - 2 * (FRAME_INSET + STROKE / 2),
  height: BOX - 2 * (FRAME_INSET + STROKE / 2)
}
const INNER_RADIUS = FRAME_RADIUS - STROKE / 2

/**
 * The split view's layout in a 16 px box (split-05): one rounded frame divided into the split's
 * panes – columns, rows or the 2-column grid, the same cells `splitPaneRects` gives the panes,
 * with equal shares – and the pane the glyph stands for filled solid. Drawn in `currentColor`,
 * so it takes the ink of the row or the chip it sits in (§9.29); an `aria-hidden` picture, its
 * host names it.
 */
export function SplitGlyph({ layout, count, index, size = BOX, className }: Props): JSX.Element {
  const n = Math.max(2, Math.min(4, Math.round(count)))
  const own = Math.max(0, Math.min(n - 1, index))
  const cells = splitCells(
    INNER,
    layout,
    Array.from({ length: n }, () => 1 / n),
    0
  )
  // The fill is clipped to the frame's inner round rect so its corners follow the frame's.
  const clipId = `zen-split-glyph-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const dividers: string[] = []
  cells.forEach((c, i) => {
    if (i === 0) return
    if (c.x > INNER.x + 0.01) dividers.push(`M${c.x} ${c.y}v${c.height}`)
    if (c.y > INNER.y + 0.01) dividers.push(`M${c.x} ${c.y}h${c.width}`)
  })
  const fill = cells[own]
  return (
    <svg
      viewBox={`0 0 ${BOX} ${BOX}`}
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      aria-hidden
      focusable="false"
      data-split-glyph={layout}
      data-split-panes={n}
      data-split-pane={own}
    >
      <defs>
        <clipPath id={clipId}>
          <rect
            x={INNER.x}
            y={INNER.y}
            width={INNER.width}
            height={INNER.height}
            rx={INNER_RADIUS}
          />
        </clipPath>
      </defs>
      <rect
        x={fill.x}
        y={fill.y}
        width={fill.width}
        height={fill.height}
        fill="currentColor"
        clipPath={`url(#${clipId})`}
      />
      <path
        d={dividers.join('')}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="butt"
      />
      <rect
        x={FRAME_INSET}
        y={FRAME_INSET}
        width={BOX - 2 * FRAME_INSET}
        height={BOX - 2 * FRAME_INSET}
        rx={FRAME_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
      />
    </svg>
  )
}
