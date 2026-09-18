import type { JSX } from 'react'
import type { UIState } from '@shared/types'
import { tabTitle } from '@renderer/lib/selectors'
import type { DragState } from '@renderer/lib/ui'
import { Favicon } from './sidebar/Favicon'

/** Follows the pointer while a tab is being dragged. */
export function DragGhost({
  state,
  drag
}: {
  state: UIState
  drag: DragState
}): JSX.Element | null {
  const tab = state.tabs[drag.tabId]
  if (!tab) return null
  return (
    <div
      className="zen-panel pointer-events-none fixed z-[100] flex h-8 max-w-[240px] items-center gap-2 px-2.5 text-[13px]"
      style={{ left: drag.x + 12, top: drag.y + 10 }}
    >
      <Favicon tab={tab} />
      <span className="truncate">{tabTitle(tab)}</span>
    </div>
  )
}
