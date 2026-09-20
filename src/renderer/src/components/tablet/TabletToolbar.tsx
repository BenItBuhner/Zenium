import type { JSX } from 'react'
import { Home, PanelLeft, PanelLeftClose, PanelRight, PanelRightClose } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
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
 * The tablet's toolbar row (TABLET-06), a row of the desktop's `NavRow` at the top of the
 * window: the sidebar toggle, Back, Forward, Reload / Stop, Home, the address pill with its
 * site-information glyph and its bookmark star (TB-16: a stateful glyph on `bookmark.star`), the
 * extension actions and the menu – Chrome's tablet toolbar, with Zen's pill. Window chrome (v2
 * §9.29): the row draws in the window family and carries `data-surface="window"`.
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
            title={hint(sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar', state, 'sidebar.toggle')}
            aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            aria-pressed={!sidebarCollapsed}
            data-tablet-sidebar-toggle
            onClick={onToggleSidebar}
          >
            <ToggleGlyph className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
          </button>
        }
        afterNavigation={
          // Chrome's tablet toolbar has Home: the new tab page, or the configured home – here the
          // core's `nav.home`, which takes the active tab home and opens the address field over
          // an empty page, as the desktop's shortcut does.
          <button
            type="button"
            className="zen-toolbar-button"
            title={hint('Home', state, 'nav.home')}
            aria-label="Home"
            disabled={!tab}
            data-tablet-home
            onClick={() => run('urlbar.runCommand', { action: 'nav.home' })}
          >
            <Home className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
          </button>
        }
      />
    </header>
  )
}
