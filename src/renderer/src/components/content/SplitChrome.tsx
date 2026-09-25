import type { JSX } from 'react'
import { useRef } from 'react'
import { Columns2, Grid2x2, Minus, MoreHorizontal, Rows2 } from 'lucide-react'
import type { Rect, SplitGroup, SplitLayout, UIState } from '@shared/types'
import { displayHost } from '@shared/url'
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

/**
 * Header strips, the active pane's outline and resize gutters for a split view (drawn in the
 * gaps between the tab views).
 *
 * The active pane is marked in the content as Zen marks it (design language v2 §9.35): a 2 px
 * `--zen-accent` outline inside its frame's radius, which with the §9.35 group row in the
 * sidebar is the whole indicator – no underline under the pane's header, no layout glyph on
 * the rows, no chip in the pill. The page is a native view the chrome cannot paint over, so
 * the outline is drawn on the pane's frame in the band every view keeps inside it
 * (`SPLIT_OUTLINE`, lib/layout.ts).
 *
 * Each header names its pane (split-18: Chrome's inactive view shows its hostname, Edge's pane
 * header its site): the favicon, the title in full ink and the site (`displayHost`) at 69% after
 * the row's 6 px gap; the site does not shrink (a badge's rule, §9.19) so the title truncates
 * first, and a site past 45% of the header truncates itself. A site that reads as the title
 * (a page without a title shows its host as the title) is not said twice. The inks are the same
 * on both panes – the outline is the active pane's whole indicator (§9.35), so the inactive
 * header is not dimmed to say it again. The ⋯ opens the pane's menu (Swap Panes, the link rule,
 * Un-split Tab; `split.paneMenu`) under the button.
 */
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
        const host = displayHost(tab.url)
        const title = tabTitle(tab)
        // The header stands in the gap between the views and goes with the page when the page is
        // hidden (ContentArea mounts this chrome only while the content shows): its controls'
        // tooltips never put the page under its picture (`data-tooltip-no-cover`, lib/tooltip.ts
        // `TOOLTIP_NO_COVER_ATTR`) – a top pane's show above the header, beside the page; a lower
        // pane's, with a view on either side, stay hidden rather than take the header out from
        // under the pointer.
        return (
          <div
            key={pane.tabId}
            className="absolute flex items-center gap-1.5 px-2 text-[11.5px] text-[var(--zen-fg)]"
            style={{
              left: pane.header.x,
              top: pane.header.y,
              width: pane.header.width,
              height: pane.header.height
            }}
            data-split-pane-header={pane.tabId}
            data-tooltip-no-cover
            onMouseDown={() => !active && run('tab.activate', { tabId: pane.tabId })}
          >
            <Favicon tab={tab} size={12} />
            <span className="min-w-0 truncate" data-split-pane-title>
              {title}
            </span>
            {host && host !== title && (
              <span className="max-w-[45%] shrink-0 truncate opacity-[.69]" data-split-pane-host>
                {host}
              </span>
            )}
            <span className="min-w-0 flex-1" />
            {active && (
              <button
                type="button"
                className="zen-toolbar-button h-5 w-5"
                aria-label={`Layout: ${group.layout} (click to change)`}
                data-tooltip={`Layout: ${group.layout} (click to change)`}
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
              aria-label="Pane options"
              aria-haspopup="menu"
              data-tooltip="Pane options"
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect()
                run('split.paneMenu', {
                  tabId: pane.tabId,
                  x: Math.round(box.left),
                  y: Math.round(box.bottom),
                  keyboard: e.detail === 0
                })
              }}
            >
              <MoreHorizontal className="h-3 w-3" />
            </button>
            <button
              type="button"
              className="zen-toolbar-button h-5 w-5"
              aria-label="Un-split this tab (Shift: keep focus in the split)"
              data-tooltip="Un-split this tab (Shift: keep focus in the split)"
              onClick={(e) => run('split.removeTab', { tabId: pane.tabId, focus: !e.shiftKey })}
            >
              <Minus className="h-3 w-3" />
            </button>
          </div>
        )
      })}
      {panes.map((pane) =>
        pane.tabId === activeTabId && state.tabs[pane.tabId] ? (
          <div
            key={`outline:${pane.tabId}`}
            className="zen-split-pane-outline"
            data-split-pane-outline={pane.tabId}
            style={{
              left: pane.frame.x,
              top: pane.frame.y,
              width: pane.frame.width,
              height: pane.frame.height
            }}
            aria-hidden
          />
        ) : null
      )}
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
