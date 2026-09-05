import type { JSX } from 'react'
import type { Tab, UIState } from '@shared/types'
import { cn } from '@renderer/lib/utils'
import { NavRow } from './sidebar/SidebarTop'
import { WindowControls } from './WindowControls'

/** Top toolbar used by the "Multiple toolbars" layout (navigation + address bar above the content). */
export function Toolbar({
  state,
  tab,
  floating
}: {
  state: UIState
  tab: Tab | null
  floating?: boolean
}): JSX.Element {
  const isMac = state.platform === 'darwin'
  const controlsHere = !isMac && !state.window.fullscreen && state.settings.sidebarSide === 'right'
  return (
    <div
      className={cn(
        'zen-drag flex h-10 items-center gap-1 px-1',
        floating && 'zen-panel zen-animate-in'
      )}
    >
      <NavRow state={state} tab={tab} compact={false} className="flex-1" />
      {controlsHere && <WindowControls />}
    </div>
  )
}
