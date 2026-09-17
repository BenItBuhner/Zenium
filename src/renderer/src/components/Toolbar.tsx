import type { JSX, ReactNode } from 'react'
import type { Tab, UIState } from '@shared/types'
import { cn } from '@renderer/lib/utils'
import { NavRow } from './sidebar/SidebarTop'

/** Top toolbar used by the "Multiple toolbars" layout (navigation + address bar above the content). */
export function Toolbar({
  state,
  tab,
  floating,
  children,
  trailingInset = 0
}: {
  state: UIState
  tab: Tab | null
  floating?: boolean
  /** Rows under the navigation row (the bookmarks bar, when the toolbar floats over the page). */
  children?: ReactNode
  /** Room (px) kept clear at the trailing end for native caption buttons drawn over the row. */
  trailingInset?: number
}): JSX.Element {
  return (
    <div className={cn(floating && 'zen-panel zen-animate-in')}>
      <div
        className="zen-drag flex h-10 items-center gap-1 px-1"
        style={trailingInset > 0 ? { paddingRight: trailingInset + 4 } : undefined}
      >
        <NavRow state={state} tab={tab} compact={false} className="flex-1" />
      </div>
      {children}
    </div>
  )
}
