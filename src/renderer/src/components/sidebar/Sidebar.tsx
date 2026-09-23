import { useViewport } from '@renderer/lib/formFactor'
import type { CSSProperties, JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderInput, VenetianMask } from 'lucide-react'
import type { UIState } from '@shared/types'
import { forcesRail, hasTopToolbar } from '@shared/toolbarLayout'
import { cmd, run } from '@renderer/lib/api'
import { privateInTabs, sidebarPose, tabsOnPane } from '@renderer/lib/privateTabs'
import {
  activeSpace,
  activeTab,
  essentialsFor,
  isLocalWindow,
  isPrivateWindow
} from '@renderer/lib/selectors'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { PaneSlot, PaneStills, type PaneStill } from '../phone/PaneSlot'
import { SpaceGlyph } from '../SpaceGlyph'
import { V2_TRAILING_GLYPH } from '../v2/controls'
import { Essentials } from './Essentials'
import { PrivatePanel } from './PrivatePanel'
import { SidebarBottom } from './SidebarBottom'
import { SidebarTop } from './SidebarTop'
import { SpacePanel } from './SpacePanel'
import { RailFlyoutContext, useRailFlyout } from './useRailFlyout'

interface Props {
  state: UIState
  isDark: boolean
  /** Floating over the content (compact mode hover reveal). */
  floating?: boolean
  onPointerLeave?: () => void
  /**
   * Collapsed to the icon rail, or expanded: by default the `sidebarExpanded` setting, unless
   * the layout fixes the rail – the Collapsed sidebar layout, and the horizontal layout's rail
   * beside the frame (`forcesRail`, §9.37). The tablet shell decides for itself (a narrow window
   * keeps the rail docked and floats the expanded sidebar over the page).
   */
  compact?: boolean
  /**
   * Whether the navigation row (Back, Forward, Reload, the pill) is drawn at the top of the
   * sidebar: by default the single-toolbar layout's. The tablet shell has a toolbar row of its
   * own and passes false.
   */
  navRow?: boolean
  /**
   * The horizontal layout's rail (design language v2 §9.37): the 56 column beside the frame from
   * the toolbar row down – Essentials as 44 tiles, the spaces' 32 glyphs with the current on
   * `--v2-window-fill`, + and palette, the compact player – with no navigation row and no tab
   * rows, which the strip along the caption band carries. It starts level with the frame at 82
   * and ends level with the frame's bottom, its last box 8 above.
   */
  rail?: boolean
}

export const COLLAPSED_WIDTH = 56

export function Sidebar({
  state,
  isDark,
  floating,
  onPointerLeave,
  rail = false,
  compact = rail || forcesRail(state.settings.toolbarLayout) || !state.settings.sidebarExpanded,
  navRow
}: Props): JSX.Element {
  const space = activeSpace(state)
  const tab = activeTab(state)
  const local = isLocalWindow(state)
  const width = compact ? COLLAPSED_WIDTH : 'var(--zen-sidebar-width)'
  const activeIndex = Math.max(
    0,
    state.spaces.findIndex((s) => s.id === state.activeSpaceId)
  )
  // The Essentials are the regular pose's, and regular tabs alone on a host that keeps private
  // browsing in tabs (the overview's rule).
  const essentials = local
    ? []
    : privateInTabs(state)
      ? tabsOnPane(essentialsFor(state, space), 'tabs')
      : essentialsFor(state, space)
  const showToolbar = navRow ?? !hasTopToolbar(state.settings.toolbarLayout)
  const side = state.settings.sidebarSide
  // Touch screens have no hover target for the resize handle; the width is a setting there.
  const { coarse } = useViewport()

  // The sidebar's POSE (lib/privateTabs.ts, W4-11): REGULAR – the Essentials and the space's
  // panels, regular tabs alone – or PRIVATE, the private session's rows under the mask
  // (`PrivatePanel`), while a private tab is in view on a host that keeps private browsing in
  // tabs. The pose follows the tab in view as the window's theme does (§11.6's 240 ms blend);
  // its own switch is a pane switch (v2 §11.4): the pose leaving stays in view as a still of
  // itself fading out over the slot while the next fades in – `PaneSlot` takes the still as the
  // pose goes, `PaneStills` draws it until its 120 ms are up, as the overview's panes do. The
  // hooks come before the rail's return below: the rail is the desktop's (§9.37), where private
  // browsing is a window and the pose is always regular, but a hook's order is the component's.
  const pose = sidebarPose(state)
  const asideRef = useRef<HTMLElement>(null)
  const [stills, setStills] = useState<PaneStill[]>([])
  const leavePose = useCallback((still: PaneStill) => setStills((s) => [...s, still]), [])
  const stillDone = useCallback(
    (key: number) => setStills((s) => s.filter((still) => still.key !== key)),
    []
  )

  // The rail's FLYOUT (tabs-03, `useRailFlyout`; v2 §9.20's sidebar anchor and cascade): under
  // the Collapsed sidebar layout with "Expand on hover" on, a pointer resting on the docked rail
  // flies a second surface out BESIDE the rail to the expanded sidebar's width over the page –
  // the rail and the frame staying put. The `<aside>` keeps the rail's 56 in the window's row
  // throughout; what it holds sits in a box of its own (`flyoutRef`) that the spring widens from
  // the rail's 56 to the rail plus the panel, its surface drawn from the rail's edge (main.css:
  // the frame's shadow rule, its edge in the rail's last column – the cascade's 1 px overlap –
  // its own ring clipped off that edge so the shared pixel keeps the frame's one hairline),
  // so the flyout's rows are the rail's rows – the same elements, the same y, each running across
  // the seam with its glyph in the rail's tile and its title in the panel. A touch screen has no
  // pointer to rest and no flyout; the compact-mode reveal (`floating`) is its own surface.
  const flyoutRef = useRef<HTMLDivElement>(null)
  const flyoutOffered =
    !rail &&
    !floating &&
    compact &&
    !coarse &&
    state.settings.toolbarLayout === 'collapsed' &&
    state.settings.sidebarExpandOnHover
  const flyoutOut = useRailFlyout(asideRef, flyoutRef, {
    enabled: flyoutOffered,
    rest: COLLAPSED_WIDTH,
    extent: state.settings.sidebarWidth,
    activeTabId: tab?.id ?? null
  })
  // The tab rows, the folders and the New Tab row take their expanded form while the flyout is
  // out. The rail's head and foot keep the rail's – the navigation column and the Essentials
  // tiles as one column, the spaces' glyphs below, boxed at the rail's width against the rail's
  // edge – because the rail is the cascade's parent and stays as it is beside the flyout, and
  // because a head laid out for the expanded sidebar (one toolbar row with the pill, the tiles
  // in a grid) stands a different height, and every row beneath it would move under the pointer
  // that opened it.
  const rowsCompact = compact && !flyoutOut
  const railBox: CSSProperties | undefined =
    rowsCompact !== compact
      ? { width, alignSelf: side === 'right' ? 'flex-end' : 'flex-start' }
      : undefined
  // The box keeps the flyout's positioning until a fold has rested: the offer withdrawn while
  // out (the setting off, the layout changed) folds it first.
  const flyoutBox = flyoutOffered || flyoutOut

  if (rail) {
    // Docked, the rail is a stretched item of the columns row with the window's 8 gutter above
    // and below it: it starts level with the frame at 82 and ends level with the frame's bottom,
    // its last box 8 above that (SidebarBottom's padding). Floating, it fills its p-2 box.
    return (
      <aside
        className={cn(
          'relative flex shrink-0 flex-col',
          floating && 'zen-panel zen-animate-in h-full'
        )}
        style={{
          width: COLLAPSED_WIDTH,
          marginTop: floating ? 0 : 'var(--zen-padding)',
          marginBottom: floating ? 0 : 'var(--zen-padding)'
        }}
        onPointerLeave={onPointerLeave}
        data-side={side}
        data-surface="window"
        data-pane="tabs"
        data-rail
        aria-label="Sidebar"
      >
        {/* The Essentials tiles as their own navigation landmark (a11y-02): the tab rows are the
            strip's, the window's Tabs navigation, in this layout. */}
        <nav aria-label="Essentials" className="flex min-h-0 flex-1 flex-col">
          {local ? (
            <LocalWindowHeader state={state} compact />
          ) : (
            <Essentials essentials={essentials} activeTabId={space.activeTabId} compact />
          )}
        </nav>
        <SidebarBottom state={state} compact isDark={isDark} />
      </aside>
    )
  }

  return (
    // A window surface (design language v2 §9.29): the tab strip's chips draw in the window family.
    <aside
      ref={asideRef}
      className={cn(
        'relative flex h-full shrink-0 flex-col',
        floating && 'zen-panel zen-animate-in'
      )}
      style={{ width }}
      onPointerLeave={onPointerLeave}
      data-side={side}
      data-surface="window"
      // The tab strip pane of the F6 rotation (lib/panes.ts); the navigation row inside it, in
      // the single-toolbar layout, is the toolbar pane.
      data-pane="tabs"
      data-pose={pose}
      data-flyout-offered={flyoutOffered || undefined}
      aria-label="Sidebar"
    >
      {/* The flyout's box (`useRailFlyout`): the aside's whole box at rest, and – out – the rail
          plus the panel beside it over the frame, the panel's surface drawn from the rail's edge
          (`--zen-rail-rest`) on the window's own background (fixed, so the gradient is the
          window's under it) with the frame's shadow rule at both its edges. `data-flyout-rows`
          keys main.css's flyout rules – the surface, the rows across the seam – and is set in
          the commit that lays the rows out in their expanded form, so the rules and the rows'
          form switch together: never a compact row under the flyout's glyph lead. */}
      <div
        ref={flyoutRef}
        className={cn(
          'zen-rail-flyout flex h-full flex-col',
          flyoutBox && 'absolute inset-y-0 w-full',
          flyoutBox && (side === 'left' ? 'left-0' : 'right-0')
        )}
        style={
          flyoutBox ? ({ '--zen-rail-rest': `${COLLAPSED_WIDTH}px` } as CSSProperties) : undefined
        }
        data-rail-flyout={flyoutBox || undefined}
        data-flyout-rows={flyoutOut || undefined}
        data-side={side}
      >
        {flyoutBox && <div className="zen-texture" aria-hidden />}
        <div className="shrink-0" style={railBox} data-rail-box>
          <SidebarTop state={state} tab={tab} compact={compact} showToolbar={showToolbar} />
        </div>
        <PaneSlot
          pane={pose}
          root={asideRef}
          onLeave={leavePose}
          switching={stills.length > 0}
          className="zen-sidebar-pose relative flex min-h-0 flex-1 flex-col"
        >
          <RailFlyoutContext.Provider value={flyoutOut}>
            {/* The tab strip is the window's navigation landmark (a11y-02): the Essentials
                tablist and the spaces' tablists – or, in the private pose, the private tabs' –
                one region a reader jumps to by landmark, whichever pose the sidebar is in. */}
            <nav aria-label="Tabs" className="flex min-h-0 flex-1 flex-col">
              {pose === 'private' ? (
                <PrivatePanel state={state} compact={rowsCompact} />
              ) : (
                <>
                  {local ? (
                    <div className="shrink-0" style={railBox} data-rail-box>
                      <LocalWindowHeader state={state} compact={compact} />
                    </div>
                  ) : (
                    <div className="shrink-0" style={railBox} data-rail-box>
                      <Essentials
                        essentials={essentials}
                        activeTabId={space.activeTabId}
                        compact={compact}
                      />
                    </div>
                  )}
                  <div className="relative min-h-0 flex-1 overflow-hidden">
                    <div
                      className="zen-space-strip h-full"
                      style={{
                        transform: `translateX(-${activeIndex * 100}%)`,
                        width: `${state.spaces.length * 100}%`
                      }}
                    >
                      {state.spaces.map((s) => (
                        <div
                          key={s.id}
                          className="h-full"
                          style={{ width: `${100 / state.spaces.length}%` }}
                        >
                          <SpacePanel
                            state={state}
                            space={s}
                            isActive={s.id === state.activeSpaceId}
                            compact={rowsCompact}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </nav>
            <div className="shrink-0" style={railBox} data-rail-box>
              <SidebarBottom state={state} compact={compact} isDark={isDark} pose={pose} />
            </div>
          </RailFlyoutContext.Provider>
        </PaneSlot>
        <PaneStills stills={stills} onDone={stillDone} />
      </div>
      {!compact && !floating && !coarse && <Resizer state={state} />}
    </aside>
  )
}

/**
 * Blank / private windows have no Essentials or spaces; Zen shows what the window is and a
 * "Move to…" helper to bring the tabs back into a real space.
 */
function LocalWindowHeader({ state, compact }: { state: UIState; compact: boolean }): JSX.Element {
  const isPrivate = isPrivateWindow(state)
  const space = activeSpace(state)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const canMove = space.tabIds.length > 0
  return (
    <div
      className={cn(
        'relative mx-2 mb-1 flex items-center gap-2 px-2 py-1.5 text-[12px] text-[var(--zen-muted)]',
        compact && 'justify-center px-0'
      )}
    >
      {isPrivate ? (
        <VenetianMask className="h-4 w-4 shrink-0" />
      ) : (
        <span className="text-sm leading-none">◫</span>
      )}
      {!compact && (
        <span className="min-w-0 flex-1 truncate font-medium">
          {isPrivate ? 'Private Browsing' : 'Blank window'}
        </span>
      )}
      {!compact && (
        <button
          type="button"
          className="zen-toolbar-button h-6 w-6"
          title="Move these tabs to a space…"
          disabled={!canMove}
          onClick={() => setOpen(!open)}
        >
          <FolderInput className={V2_TRAILING_GLYPH} />
        </button>
      )}
      {open && (
        <div
          ref={menuRef}
          className="zen-panel zen-animate-in absolute right-0 top-full z-30 mt-1 w-56 p-1"
        >
          <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-[var(--zen-muted)]">
            Move tabs to
          </div>
          <MoveTargets
            onPick={(spaceId) => {
              setOpen(false)
              run('window.moveTabsToSpace', { spaceId })
            }}
          />
        </div>
      )}
    </div>
  )
}

/** Blank windows only see their own space in the snapshot; the real spaces are fetched on demand. */
function MoveTargets({ onPick }: { onPick: (spaceId: string) => void }): JSX.Element {
  const [spaces, setSpaces] = useState<Array<{ id: string; name: string; icon: string }>>([])
  useEffect(() => {
    let cancelled = false
    void cmd('app.listSpaces', undefined).then((list) => {
      if (!cancelled) setSpaces(list)
    })
    return () => {
      cancelled = true
    }
  }, [])
  if (!spaces.length)
    return <div className="px-2 py-2 text-[12px] text-[var(--zen-muted)]">No spaces</div>
  return (
    <>
      {spaces.map((s) => (
        <button
          key={s.id}
          type="button"
          className="zen-squircle flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-[var(--zen-element-bg)]"
          onClick={() => onPick(s.id)}
        >
          <SpaceGlyph icon={s.icon} size={14} />
          <span className="min-w-0 flex-1 truncate">{s.name}</span>
        </button>
      ))}
    </>
  )
}

/** Drag handle on the sidebar's inner edge. */
function Resizer({ state }: { state: UIState }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const side = state.settings.sidebarSide
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let startX = 0
    let startWidth = 0
    const onMove = (e: PointerEvent): void => {
      const delta = side === 'left' ? e.clientX - startX : startX - e.clientX
      const width = Math.max(160, Math.min(520, startWidth + delta))
      document.documentElement.style.setProperty('--zen-sidebar-width', `${width}px`)
      el.dataset.width = String(width)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const width = Number(el.dataset.width)
      if (width) run('sidebar.setWidth', { width })
      uiStore.set({ statusText: '' })
    }
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      e.preventDefault()
      startX = e.clientX
      startWidth =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--zen-sidebar-width')
        ) || 240
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }
    el.addEventListener('pointerdown', onDown)
    return () => el.removeEventListener('pointerdown', onDown)
  }, [side])
  return (
    <div
      ref={ref}
      className={cn(
        'zen-resizer zen-no-drag absolute top-0 h-full w-1.5 hover:bg-[var(--zen-accent)]/30',
        side === 'left' ? '-right-0.5' : '-left-0.5'
      )}
      title="Drag to resize · double-click to collapse"
      onDoubleClick={() => run('sidebar.toggleExpanded', undefined)}
    />
  )
}
