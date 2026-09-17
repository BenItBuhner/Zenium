import type { JSX } from 'react'
import type { Tab, UIState } from '@shared/types'
import { cn } from '@renderer/lib/utils'
import { NavRow } from './sidebar/SidebarTop'

/** Top toolbar used by the "Multiple toolbars" layout (navigation + address bar above the content). */
export function Toolbar({
  state,
  tab,
  floating,
  trailingInset = 0
}: {
  state: UIState
  tab: Tab | null
  floating?: boolean
  /** Room (px) kept clear at the trailing end for native caption buttons drawn over the row. */
  trailingInset?: number
}): JSX.Element {
  return (
    <div
      className={cn(
        'zen-drag flex h-10 items-center gap-1 px-1',
        floating && 'zen-panel zen-animate-in'
      )}
      style={trailingInset > 0 ? { paddingRight: trailingInset + 4 } : undefined}
    >
      <NavRow state={state} tab={tab} compact={false} className="flex-1" />
    </div>
  )
}
