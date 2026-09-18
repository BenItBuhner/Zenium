import type { JSX } from 'react'
import { Globe } from 'lucide-react'
import type { UIState } from '@shared/types'
import { dropStore, registerCaret, registerGhost } from '@renderer/lib/drag'
import { tabTitle } from '@renderer/lib/selectors'
import type { DragState } from '@renderer/lib/ui'
import { Favicon } from './sidebar/Favicon'

/**
 * What a tab drag draws over the window: the ghost in the hand – the lifted row, thinned out
 * over a drop-into target, or the tear-off card past the sidebar – and the insertion caret in
 * the gap the rows opened. Both are positioned by lib/drag.ts through the registered elements,
 * so the pointer never waits for a render. The caret marks a window surface's list and the
 * ghost is a row lifted off one, so both draw in the window family (design-language-v2-draft
 * §9.29); the tear-off card depicts a window and is a card, page family.
 */
export function DragLayer({ state, drag }: { state: UIState; drag: DragState }): JSX.Element {
  const ghost = dropStore.use((s) => s.ghost)
  const tab = state.tabs[drag.tabId]
  const title = tab ? tabTitle(tab) : drag.title
  const icon = tab ? (
    <Favicon tab={tab} />
  ) : drag.favicon ? (
    <img src={drag.favicon} width={16} height={16} alt="" className="shrink-0 rounded-[4px]" />
  ) : (
    <Globe className="h-4 w-4 shrink-0 opacity-60" />
  )
  return (
    <>
      <div ref={registerCaret} className="zen-tab-caret" data-surface="window" aria-hidden />
      <div
        ref={registerGhost}
        className="zen-tab-ghost"
        data-surface="window"
        data-into={ghost === 'into' || undefined}
        aria-hidden
      >
        {ghost === 'tearoff' ? (
          <div
            className="zen-tab-tearoff"
            data-surface="page"
            style={{ width: Math.max(200, drag.width) }}
          >
            <div className="zen-tab-tearoff-bar">
              {icon}
              <span className="min-w-0 flex-1 truncate">{title}</span>
            </div>
            <div className="zen-tab-tearoff-page">New window</div>
          </div>
        ) : drag.tile ? (
          <div
            className="zen-essential zen-tab-ghost-row"
            style={{ width: drag.width, height: drag.height }}
          >
            {tab ? <Favicon tab={tab} size={20} /> : icon}
          </div>
        ) : (
          <div
            className="zen-tab zen-tab-ghost-row"
            style={{ width: drag.width, height: drag.height }}
          >
            {icon}
            <span className="zen-tab-title min-w-0 flex-1 truncate">{title}</span>
          </div>
        )}
      </div>
    </>
  )
}
