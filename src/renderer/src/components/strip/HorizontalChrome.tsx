import type { JSX, ReactNode } from 'react'
import type { Tab, UIState } from '@shared/types'
import { STRIP_TOOLBAR_HEIGHT } from '@renderer/lib/tabStripLayout'
import { cn } from '@renderer/lib/utils'
import { BookmarksBar } from '../bookmarks/BookmarksBar'
import { NavRow } from '../sidebar/SidebarTop'
import { TabStrip } from './TabStrip'

interface Props {
  state: UIState
  tab: Tab | null
  /** The bookmarks bar under the toolbar row. */
  showBar: boolean
  /** Floating over the page (the hidden chrome's reveal): a panel, as the hidden toolbar is. */
  floating?: boolean
  /** Controls at the strip's trailing end, ahead of the window controls. */
  trailing?: ReactNode
}

/**
 * The horizontal layout's top chrome (design language v2 §9.37): the tab strip in the 38
 * caption band, a 4 gap, then the toolbar row – 32 tall, inset 8, Back / Forward / Reload, the
 * pill flex-1 with every §9.29 chip up at this width, the hub, downloads, the extension actions
 * and ⋯ (the sidebar's navigation row, `NavRow`, which is the toolbar pane of the F6 rotation)
 * – and the bookmarks bar when it is on. Both bands span the window over the rail; the frame
 * follows at 82 with the window's 8 of padding.
 */
export function HorizontalChrome({ state, tab, showBar, floating, trailing }: Props): JSX.Element {
  return (
    <div
      className={cn('flex shrink-0 flex-col gap-1', floating && 'zen-panel')}
      data-surface="window"
      data-horizontal-chrome
      data-testid="horizontal-chrome"
    >
      <TabStrip state={state} trailing={trailing} />
      <div
        className="flex items-center px-2"
        style={{ height: STRIP_TOOLBAR_HEIGHT }}
        data-zen-nav-bar
        data-testid="strip-toolbar-row"
      >
        <NavRow state={state} tab={tab} compact={false} className="flex-1" />
      </div>
      {showBar && <BookmarksBar state={state} tab={tab} />}
    </div>
  )
}
