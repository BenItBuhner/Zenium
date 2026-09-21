import type { JSX } from 'react'
import { PanelLeft, PanelLeftClose, PanelRight, PanelRightClose } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { hint } from '@renderer/lib/shortcuts'
import { NavRow } from '../sidebar/SidebarTop'
import { useOverviewHandle } from '../phone/usePillGestures'
import { TOOLBAR_STROKE } from '../v2/controls'
import { TABLET_TOOLBAR_HEIGHT } from './tabletChrome'

interface Props {
  state: UIState
  tab: Tab | null
  /** The sidebar is collapsed to its icon rail (or, in a narrow window, its drawer is closed). */
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}

/**
 * The tablet's toolbar row (TABLET-06; v2 §9.36), a row of the desktop's `NavRow` at the top of
 * the window: the sidebar toggle, Back, Forward, Reload / Stop, the address pill with its
 * site-information glyph and its bookmark star (TB-16: a stateful glyph on `bookmark.star`), the
 * extension actions and the menu – Chrome's tablet toolbar, with Zen's pill. No Home button by
 * default: Zen, Firefox's tablet bar and the phone bar have none, New Tab is the way to the new
 * tab page, and a button only the tablet carries would be a Zenium inconsistency rather than a
 * tablet affordance (it may return as a customisation when the bar takes one). Window chrome
 * (v2 §9.29): the row draws in the window family and carries `data-surface="window"`. Its
 * buttons are §9.3's 40 × 40 / 20 in flow at a 4 px gap, the toggle's box 8 → 48 on the rail's
 * axis (the stylesheet's tablet block).
 *
 * The sidebar toggle stands where Chrome's tab switcher does: the sidebar IS the tablet's tab
 * switcher (expanded, or as the rail), so the toggle is the switcher entry; the overview with
 * the tabs as cards is the pull-down on this row (GN-27), as the phone pulls it in from its
 * pill. The row never hides on scroll (the phone's bar does): a tablet has the room.
 */
export function TabletToolbar({
  state,
  tab,
  sidebarCollapsed,
  onToggleSidebar
}: Props): JSX.Element {
  const { style: handleStyle, ...handle } = useOverviewHandle({ edge: 'top', from: 'anywhere' })
  const side = state.settings.sidebarSide
  const ToggleGlyph =
    side === 'right'
      ? sidebarCollapsed
        ? PanelRight
        : PanelRightClose
      : sidebarCollapsed
        ? PanelLeft
        : PanelLeftClose
  return (
    <header
      className="zen-tablet-toolbar relative z-30 flex shrink-0 items-center px-2"
      data-surface="window"
      data-shell-chrome
      style={{
        ...handleStyle,
        height: `calc(var(--zen-inset-top) + ${TABLET_TOOLBAR_HEIGHT}px)`,
        paddingTop: 'var(--zen-inset-top)'
      }}
      {...handle}
    >
      <NavRow
        state={state}
        tab={tab}
        compact={false}
        className="min-w-0 flex-1"
        leading={
          <button
            type="button"
            className="zen-toolbar-button"
            title={hint(
              sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar',
              state,
              'sidebar.toggle'
            )}
            aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            aria-pressed={!sidebarCollapsed}
            data-tablet-sidebar-toggle
            onClick={onToggleSidebar}
          >
            <ToggleGlyph className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
          </button>
        }
      />
    </header>
  )
}
