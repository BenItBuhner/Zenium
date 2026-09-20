import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Rect, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { usePrivateSurface } from '@renderer/lib/privateSurface'
import { activeTab } from '@renderer/lib/selectors'
import { type UiState } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { ContentArea } from '../content/ContentArea'
import { ChromeDropLayer, DragLayer } from '../DragLayer'
import { MessageLayer } from '../messages/MessageLayer'
import { ModStyles } from '../ModStyles'
import { Onboarding } from '../overlays/Onboarding'
import { PhoneStage } from '../phone/PhoneStage'
import { useFullscreenReturn } from '../phone/useFullscreenReturn'
import { Sidebar } from '../sidebar/Sidebar'
import { TabDialogs } from '../TabDialogs'
import { Urlbar } from '../urlbar/Urlbar'
import {
  closeTabletDrawer,
  openTabletDrawer,
  TABLET_TOOLBAR_HEIGHT,
  tabletDrawerLayout,
  tabletStore
} from './tabletChrome'
import { TabletToolbar } from './TabletToolbar'
import { useSidebarSwipe } from './useSidebarSwipe'

interface Props {
  state: UIState
  ui: UiState
  isDark: boolean
}

/**
 * The tablet layout (TABLET-01): Zen's vertical sidebar as the tab surface, sized for touch
 * (TABLET-02), beside the content card, under a toolbar row of the desktop's controls
 * (TABLET-06). A finger drives it, so it takes the phone's chassis where the desktop's hover
 * has no equivalent – menus on the bottom sheet, the tab overview pulled down from the toolbar
 * (GN-27), the private theme on the window – and the desktop's popovers where a surface is
 * anchored and fits (the star bubble, site information, tab search, the extension popups). The
 * toolbar never hides on scroll: the tablet has the room, and the phone's bar hide is the
 * phone's. Every component inside is the one the desktop layout uses.
 *
 * Width: with room for both, the sidebar is docked beside the page, expanded or as the icon rail
 * (the `sidebarExpanded` setting, Zen's toggle); in a narrow window (a split-screen half,
 * `TABLET_DRAWER_BELOW`) the rail stays docked and the expanded sidebar floats over the page as
 * a drawer. The toolbar's leading button, or a sideways swipe on the sidebar, flips either.
 *
 * Continuity (TABLET-08): what this shell keeps is in stores – the gesture stage, the drawer,
 * the URL bar, the dialogs – so a window resized into the phone chrome and back swaps shells
 * with the page, its scroll and the open chrome where they were.
 */
export function TabletShell({ state, ui, isDark }: Props): JSX.Element {
  const tab = activeTab(state)
  const viewport = useViewport()
  const side = state.settings.sidebarSide
  const drawerLayout = tabletDrawerLayout(viewport.width)
  const drawerOpen = tabletStore.use((s) => s.drawerOpen)
  const expanded = state.settings.sidebarExpanded
  // The docked sidebar: the rail in a narrow window, else what the setting says.
  const rail = drawerLayout || !expanded
  const sidebarCollapsed = drawerLayout ? !drawerOpen : !expanded
  const toggleSidebar = (): void => {
    if (drawerLayout) {
      if (drawerOpen) closeTabletDrawer()
      else openTabletDrawer()
    } else run('sidebar.toggleExpanded', undefined)
  }
  const onboarding = !state.settings.onboardingDone && state.window.kind === 'synced'
  const htmlFullscreen = state.window.htmlFullscreenTabId !== null
  const activeTabId = tab?.id ?? null
  // The window surfaces are on the private theme (blending to it): a private tab is in view, or
  // the overview shows the private pane (§9.29; MOT-14).
  const privateSurface = usePrivateSurface(state)

  // Picking a tab in the drawer closes it (the phone's drawer rule); so does the room for a
  // docked sidebar coming back.
  const lastActive = useRef(activeTabId)
  useEffect(() => {
    if (lastActive.current !== activeTabId && drawerOpen) closeTabletDrawer()
    lastActive.current = activeTabId
  }, [activeTabId, drawerOpen])
  useEffect(() => {
    if (!drawerLayout) closeTabletDrawer()
  }, [drawerLayout])

  // Back from a page's fullscreen (MED-01) the chrome fades in over 120 ms once the page's view
  // has landed (`lib/fullscreenLanding.ts`), as the phone's does.
  const windowRef = useRef<HTMLDivElement | null>(null)
  useFullscreenReturn(windowRef, state.window.htmlFullscreenTabId)

  // The URL bar's popup hangs from the toolbar's address pill, as wide as it (TB-21): the pill
  // is measured as the bar opens and again when the window or the sidebar changes under it.
  const anchor = useFieldAnchor(windowRef, ui.urlbar.open, [
    viewport.width,
    viewport.height,
    rail,
    drawerLayout
  ])
  const shellBox: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height }

  // A sideways swipe on the docked sidebar: towards the window's edge collapses it to the rail,
  // away from the edge expands it (or opens the drawer where the rail is all the window fits).
  const swipe = useSidebarSwipe({
    side,
    collapsed: sidebarCollapsed,
    onCollapse: () => {
      if (drawerLayout) closeTabletDrawer()
      else if (expanded) run('sidebar.toggleExpanded', undefined)
    },
    onExpand: () => {
      if (drawerLayout) openTabletDrawer()
      else if (!expanded) run('sidebar.toggleExpanded', undefined)
    }
  })

  if (htmlFullscreen) return <div className="h-full w-full bg-black" />

  return (
    <div
      ref={windowRef}
      className="zen-window zen-tablet relative flex h-full w-full flex-col overflow-clip"
      data-dark={isDark}
      data-private={privateSurface || undefined}
      data-window-kind={state.window.kind}
      data-window-chrome={state.window.chrome}
      data-testid="chrome-root"
      style={{
        // The toolbar takes the top inset itself; the sides and the bottom (the system bars, the
        // keyboard) are the window's.
        paddingTop: 0,
        paddingBottom: 'var(--zen-inset-bottom)',
        paddingLeft: 'var(--zen-inset-left)',
        paddingRight: 'var(--zen-inset-right)',
        // The band the overview keeps clear at the top (`TabOverview`): the toolbar row.
        ['--zen-phone-band' as string]: `${TABLET_TOOLBAR_HEIGHT}px`
      }}
    >
      <ModStyles mods={state.mods} />
      <div className="zen-texture" />
      <TabletToolbar
        state={state}
        tab={tab}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
      />
      {/* The chrome under the sheets – the sidebar, the content column, the messages, the
          stage – carries `data-shell-chrome`: it goes inert while a sheet or a frame dialog is
          up (§9.22, `holdChromeInert` in lib/portals.tsx). */}
      <div
        data-shell-chrome
        className={cn('relative flex min-h-0 flex-1', side === 'right' && 'flex-row-reverse')}
      >
        <div className="relative flex h-full shrink-0" {...swipe}>
          <Sidebar state={state} isDark={isDark} compact={rail} navRow={false} />
        </div>
        <main
          className="relative flex min-w-0 flex-1 flex-col"
          style={{
            paddingTop: 0,
            paddingBottom: 'var(--zen-padding)',
            paddingLeft: side === 'right' ? 'var(--zen-padding)' : 0,
            paddingRight: side === 'left' ? 'var(--zen-padding)' : 0
          }}
        >
          <div className="relative min-h-0 flex-1">
            <ContentArea state={state} ui={ui} hostsUrlbar={false} />
            {/* Messages on the content frame's box (v2 §9.33): banners from its top edge, the
                toast at its bottom, over the page and under the dialogs. */}
            <div className="zen-message-frame pointer-events-none absolute inset-0 z-[36]">
              <MessageLayer />
            </div>
            {/*
             * Modal dialogs render in the content frame through FrameDialogHost (its scrim dims
             * this box only); popovers such as the star bubble render through ChromePortal, over
             * the window (lib/portals.tsx).
             */}
            <TabDialogs state={state} />
          </div>
        </main>
      </div>
      <PhoneStage state={state} edge="top" />
      {ui.urlbar.open && (
        <Urlbar
          key={`${ui.urlbar.mode}-${ui.urlbar.tabId ?? 'new'}`}
          state={state}
          urlbar={ui.urlbar}
          area={shellBox}
          anchor={anchor}
        />
      )}
      {drawerLayout && drawerOpen && (
        <TabletDrawer state={state} isDark={isDark} side={side} onClose={closeTabletDrawer} />
      )}
      {ui.drag && <DragLayer state={state} drag={ui.drag} />}
      <ChromeDropLayer />
      {onboarding && <Onboarding state={state} />}
    </div>
  )
}

/**
 * The expanded sidebar as a drawer over the page, in a window too narrow to dock it beside one:
 * a scrim over the page (the drawer's rest of the window), the sidebar as a panel at the rail's
 * side. A tap on the scrim, or picking a tab, closes it (`TabletShell`).
 */
function TabletDrawer({
  state,
  isDark,
  side,
  onClose
}: {
  state: UIState
  isDark: boolean
  side: 'left' | 'right'
  onClose: () => void
}): JSX.Element {
  return (
    <div
      className="zen-tablet-drawer absolute inset-0 z-40 flex"
      data-side={side}
      style={{ top: `calc(var(--zen-inset-top) + ${TABLET_TOOLBAR_HEIGHT}px)` }}
    >
      <div
        className={cn('zen-tablet-drawer-panel h-full', side === 'right' && 'order-last')}
        role="dialog"
        aria-label="Sidebar"
      >
        <Sidebar state={state} isDark={isDark} compact={false} navRow={false} floating />
      </div>
      <div
        className="zen-tablet-drawer-scrim min-w-0 flex-1"
        aria-label="Close sidebar"
        onClick={onClose}
      />
    </div>
  )
}

/**
 * The toolbar's address pill, in the shell's coordinates, while `active`: what the URL bar's
 * popup hangs from. Measured on open and whenever `deps` say the row may have moved; the pill
 * itself never moves while the bar is up (the bar is a layer over the page, not in the row).
 */
function useFieldAnchor(
  root: React.RefObject<HTMLElement | null>,
  active: boolean,
  deps: unknown[]
): Rect | null {
  const [anchor, setAnchor] = useState<Rect | null>(null)
  useLayoutEffect(() => {
    if (!active) {
      setAnchor(null)
      return
    }
    const pill = root.current?.querySelector<HTMLElement>(
      '.zen-tablet-toolbar [data-address-pill]'
    )
    const origin = root.current?.getBoundingClientRect()
    if (!pill || !origin) {
      setAnchor(null)
      return
    }
    const r = pill.getBoundingClientRect()
    setAnchor({ x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, root, ...deps])
  return anchor
}
