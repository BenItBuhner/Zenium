import type { JSX } from 'react'
import { useRef } from 'react'
import { Columns2, Grid2x2, Minus, Rows2 } from 'lucide-react'
import type { Rect, SplitGroup, SplitLayout, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { gutterRects, splitPaneRects, SPLIT_GAP, SPLIT_GAP_TOUCH } from '@renderer/lib/layout'
import { tabTitle } from '@renderer/lib/selectors'
import { cn } from '@renderer/lib/utils'
import { Favicon } from '../sidebar/Favicon'

interface Props {
  state: UIState
  group: SplitGroup
  /** Viewport-relative area. */
  area: Rect
  activeTabId: string | null
}

const LAYOUT_ICONS: Record<SplitLayout, typeof Columns2> = {
  vertical: Columns2,
  horizontal: Rows2,
  grid: Grid2x2
}
const NEXT_LAYOUT: Record<SplitLayout, SplitLayout> = {
  vertical: 'horizontal',
  horizontal: 'grid',
  grid: 'vertical'
}

/** Header strips and resize gutters for a split view (drawn in the gaps between the tab views). */
export function SplitChrome({ state, group, area, activeTabId }: Props): JSX.Element | null {
  const { coarse } = useViewport()
  const gap = coarse ? SPLIT_GAP_TOUCH : SPLIT_GAP
  const panes = splitPaneRects(area, group, gap)
  const gutters = gutterRects(area, group, gap)
  const Icon = LAYOUT_ICONS[group.layout]
  return (
    <>
      {panes.map((pane) => {
        const tab = state.tabs[pane.tabId]
        if (!tab) return null
        const active = pane.tabId === activeTabId
        return (
          <div
            key={pane.tabId}
            className={cn(
              'absolute flex items-center gap-1.5 px-2 text-[11.5px]',
              active ? 'text-[var(--zen-fg)]' : 'text-[var(--zen-muted)]'
            )}
            style={{
              left: pane.header.x,
              top: pane.header.y,
              width: pane.header.width,
              height: pane.header.height
            }}
            onMouseDown={() => !active && run('tab.activate', { tabId: pane.tabId })}
          >
            <span
              className={cn(
                'absolute inset-x-0 bottom-0 h-0.5 rounded-full',
                active ? 'bg-[var(--zen-accent)]' : 'bg-transparent'
              )}
            />
            <Favicon tab={tab} size={12} />
            <span className="min-w-0 flex-1 truncate">{tabTitle(tab)}</span>
            {active && (
              <button
                type="button"
                className="zen-toolbar-button h-5 w-5"
                title={`Layout: ${group.layout} (click to change)`}
                onClick={() =>
                  run('split.setLayout', { groupId: group.id, layout: NEXT_LAYOUT[group.layout] })
                }
              >
                <Icon className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              className="zen-toolbar-button h-5 w-5"
              title="Un-split this tab (Shift: keep focus in the split)"
              onClick={(e) => run('split.removeTab', { tabId: pane.tabId, focus: !e.shiftKey })}
            >
              <Minus className="h-3 w-3" />
            </button>
          </div>
        )
      })}
      {gutters.map((g) => (
        <Gutter key={g.index} gutter={g} group={group} area={area} />
      ))}
    </>
  )
}

function Gutter({
  gutter,
  group,
  area
}: {
  gutter: { index: number; rect: Rect; axis: 'x' | 'y' }
  group: SplitGroup
  area: Rect
}): JSX.Element {
  const sizesRef = useRef<number[]>(group.sizes)
  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    const start = gutter.axis === 'x' ? e.clientX : e.clientY
    const total = gutter.axis === 'x' ? area.width : area.height
    const initial = [...group.sizes]
    let last = 0
    const onMove = (ev: PointerEvent): void => {
      const pos = gutter.axis === 'x' ? ev.clientX : ev.clientY
      const delta = (pos - start) / total
      const next = [...initial]
      const a = initial[gutter.index] + delta
      const b = initial[gutter.index + 1] - delta
      if (a < 0.12 || b < 0.12) return
      next[gutter.index] = a
      next[gutter.index + 1] = b
      sizesRef.current = next
      const now = performance.now()
      if (now - last > 30) {
        last = now
        run('split.resize', { groupId: group.id, sizes: next })
      }
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      run('split.resize', { groupId: group.id, sizes: sizesRef.current })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div
      className={cn(
        'absolute z-10 rounded-full transition-colors hover:bg-[var(--zen-accent)]/50',
        gutter.axis === 'x' ? 'cursor-col-resize' : 'cursor-row-resize'
      )}
      style={{
        left: gutter.rect.x,
        top: gutter.rect.y,
        width: gutter.rect.width,
        height: gutter.rect.height
      }}
      onPointerDown={onPointerDown}
    />
  )
}
