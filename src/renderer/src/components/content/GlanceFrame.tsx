import type { JSX } from 'react'
import { Columns2, Maximize2, X } from 'lucide-react'
import type { GlanceState, Rect, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { glanceRect } from '@renderer/lib/layout'
import { tabTitle } from '@renderer/lib/selectors'
import { Favicon } from '../sidebar/Favicon'

interface Props {
  state: UIState
  glance: GlanceState
  /** Viewport-relative area. */
  area: Rect
  ready: boolean
}

/**
 * Chrome around a Glance card: dimmed backdrop (click to close) and the controls Zen shows at the
 * top-left – Close, Expand (into a tab) and Split.
 */
export function GlanceFrame({ state, glance, area, ready }: Props): JSX.Element {
  const rect = glanceRect(area)
  const tab = state.tabs[glance.tabId]
  const originX = `${glance.originX * 100}%`
  const originY = `${glance.originY * 100}%`
  return (
    <div className="absolute inset-0 z-20" onMouseDown={() => run('glance.close', undefined)}>
      <div
        className="zen-animate-pop absolute overflow-hidden rounded-xl bg-[var(--zen-bg-solid)] shadow-[0_30px_80px_rgba(0,0,0,0.45)] ring-1 ring-black/10"
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          transformOrigin: `${originX} ${originY}`
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {!ready && (
          <div className="flex h-full items-center justify-center text-[var(--zen-muted)]">
            <span className="zen-spin h-5 w-5 rounded-full border-2 border-current border-t-transparent" />
          </div>
        )}
      </div>
      <div
        className="zen-panel zen-animate-in absolute flex h-8 items-center gap-1 px-1.5"
        style={{ left: rect.x, top: Math.max(4, rect.y - 36) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="zen-toolbar-button h-6 w-6"
          title="Close (Esc)"
          onClick={() => run('glance.close', undefined)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="zen-toolbar-button h-6 w-6"
          title="Expand into a tab (Ctrl+O)"
          onClick={() => run('glance.expand', undefined)}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="zen-toolbar-button h-6 w-6"
          title="Open as split view"
          onClick={() => run('glance.split', undefined)}
        >
          <Columns2 className="h-3.5 w-3.5" />
        </button>
        {tab && (
          <span className="ml-1 flex max-w-[320px] items-center gap-1.5 pr-1.5 text-[12px] text-[var(--zen-muted)]">
            <Favicon tab={tab} size={12} />
            <span className="truncate">{tabTitle(tab)}</span>
          </span>
        )}
      </div>
    </div>
  )
}
