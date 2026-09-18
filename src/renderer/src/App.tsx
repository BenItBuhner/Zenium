import type { JSX } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import { Minimize } from 'lucide-react'
import type { Events, UIState } from '@shared/types'
import type { ResolvedTheme } from '@shared/theme'
import { bookmarksBarVisible } from '@shared/bookmarkViews'
import { formatBinding } from '@shared/shortcuts'
import { run } from '@renderer/lib/api'
import { useFormFactorReport, useViewport } from '@renderer/lib/formFactor'
import { activeTab } from '@renderer/lib/selectors'
import {
  captureActiveTab,
  clearTabSelection,
  closeFindBar,
  closeOverlay,
  closeUrlbar,
  invalidateSnapshot,
  lastPointer,
  uiStore,
  useBrowser
} from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useCaptionOverlay } from '@renderer/hooks/useCaptionOverlay'
import { useMainEvents } from '@renderer/hooks/useMainEvents'
import { useTheme } from '@renderer/hooks/useTheme'
import { BookmarksBar } from './components/bookmarks/BookmarksBar'
import { captionBandInMain } from '@renderer/lib/layout'
import { ContentArea } from './components/content/ContentArea'
import { FindBar } from './components/content/FindBar'
import { DragLayer } from './components/DragLayer'
import { ModStyles } from './components/ModStyles'
import { Onboarding } from './components/overlays/Onboarding'
import { PhoneShell } from './components/phone/PhoneShell'
import { COLLAPSED_WIDTH, Sidebar } from './components/sidebar/Sidebar'
import { TabDialogs } from './components/TabDialogs'
import { Toolbar } from './components/Toolbar'

/** Width of the compact-mode hover zone along the window edge (px). */
const REVEAL_ZONE = 14

export function App(): JSX.Element {
  const state = useBrowser()
  const viewport = useViewport()
  const theme = useTheme(state, viewport.formFactor)
  useFormFactorReport(viewport.formFactor)
  useMainEvents()
  useGlobalKeys(state)
  useNewTabEvent()
  usePointerTracking()
  const ui = uiStore.use()

  if (viewport.formFactor === 'phone') {
    return <PhoneShell state={state} ui={ui} isDark={theme.isDark} />
  }
  return <DesktopShell state={state} theme={theme} />
}

/** Desktop, tablet and DeX: Zen's vertical sidebar next to the content card. */
function DesktopShell({ state, theme }: { state: UIState; theme: ResolvedTheme }): JSX.Element {
  const ui = uiStore.use()
  const tab = activeTab(state)
  const settings = state.settings
  const compact = settings.compactMode
  const sidebarSide = settings.sidebarSide
  const popupChrome = state.window.chrome === 'popup'
  // Blank / private windows never show onboarding (it belongs to the main profile window).
  const onboarding = !settings.onboardingDone && state.window.kind === 'synced' && !popupChrome
  const htmlFullscreen = state.window.htmlFullscreenTabId !== null
  // The window's fullscreen (F11): the page runs edge to edge and the chrome hides as it does in
  // compact mode with both switches on, coming out at its edge under the cursor.
  const fullscreen = !popupChrome && state.window.fullscreen

  const sidebarHidden =
    popupChrome ||
    fullscreen ||
    (compact.enabled && compact.hideSidebar && !compact.sidebarPersistent)
  const toolbarHidden =
    !popupChrome &&
    (fullscreen || (compact.enabled && compact.hideToolbar)) &&
    settings.toolbarLayout !== 'single'
  const showToolbar = popupChrome || (settings.toolbarLayout === 'multiple' && !toolbarHidden)
  const sidebarRevealed = !popupChrome && sidebarHidden && ui.compactHover
  // The bookmarks bar sits under the toolbar and hides with it in compact mode; popups never show it.
  const barWanted = !popupChrome && bookmarksBarVisible(settings.bookmarksBar, tab?.url ?? null)
  const showBar = barWanted && !fullscreen && !(compact.enabled && compact.hideToolbar)
  // Windows draws the caption buttons over the top trailing corner: whatever sits there keeps
  // clear of them, and the content column starts below them when they land on it.
  const overlay = useCaptionOverlay()
  const captionBand = captionBandInMain({
    overlayWidth: overlay.width,
    sidebarSide,
    sidebarWidth: sidebarHidden
      ? null
      : settings.sidebarExpanded
        ? settings.sidebarWidth
        : COLLAPSED_WIDTH
  })
  const captionInset = captionBand ? overlay.width : 0
  const macPopupInset = popupChrome && state.platform === 'darwin' ? 72 : 0

  // Compact mode: hovering the window edge reveals the sidebar on top of a frozen page snapshot.
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealing = useRef(false)
  const reveal = useCallback(() => {
    if (revealTimer.current) clearTimeout(revealTimer.current)
    if (uiStore.get().compactHover || revealing.current) return
    revealing.current = true
    void captureActiveTab(tab?.id ?? null).then(() => {
      revealing.current = false
      uiStore.set({ compactHover: true })
      run('compact.setRevealed', { revealed: true })
    })
  }, [tab?.id])
  const unreveal = useCallback(() => {
    if (revealTimer.current) clearTimeout(revealTimer.current)
    revealTimer.current = setTimeout(() => {
      if (uiStore.get().overlay !== 'none' || uiStore.get().urlbar.open) return
      uiStore.set({ compactHover: false })
      run('compact.setRevealed', { revealed: false })
      invalidateSnapshot()
    }, 260)
  }, [])
  useEffect(() => {
    if (!sidebarHidden && ui.compactHover) uiStore.set({ compactHover: false })
  }, [sidebarHidden, ui.compactHover])
  // Any click in the chrome dismisses an open extension popup (it lives outside the DOM).
  useEffect(() => {
    if (!state.extensions.some((e) => e.enabled)) return
    const onDown = (): void => run('extension.closePopup', undefined)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [state.extensions])
  // Main tracks the real cursor (works over the page view and the frameless resize border).
  useEffect(() => {
    const onReveal = (e: Event): void => {
      const { revealed, edge } = (e as CustomEvent<ChromeReveal>).detail
      if (edge !== 'sidebar' || popupChrome || !sidebarHidden) return
      if (revealed) reveal()
      else unreveal()
    }
    window.addEventListener('zen-compact-reveal', onReveal)
    return () => window.removeEventListener('zen-compact-reveal', onReveal)
  }, [popupChrome, sidebarHidden, reveal, unreveal])

  if (htmlFullscreen) {
    // The fullscreen view covers everything; keep the tree alive but paint nothing. Only the
    // find bar shares the window with it, docked at the bottom on a strip the view leaves free.
    const findTabId = ui.findOpen ? ui.findTabId : null
    return (
      <div className="flex h-full w-full flex-col bg-black">
        <div className="flex-1" />
        {findTabId && findTabId === state.window.htmlFullscreenTabId && state.tabs[findTabId] && (
          <FindBar state={state} tabId={findTabId} ui={ui} docked="fullscreen" />
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'zen-window relative flex h-full w-full overflow-hidden',
        sidebarSide === 'right' && 'flex-row-reverse'
      )}
      data-dark={theme.isDark}
      data-window-kind={state.window.kind}
      data-window-chrome={state.window.chrome}
      data-caption-overlay={overlay.width > 0 ? 'true' : 'false'}
    >
      <ModStyles mods={state.mods} />
      <div className="zen-texture" />
      {!sidebarHidden && <Sidebar state={state} isDark={theme.isDark} />}
      <main
        className="relative flex min-w-0 flex-1 flex-col"
        style={{
          // Longhands only: mixing the `padding` shorthand with `paddingLeft` breaks React's
          // style diffing when the sidebar toggles.
          paddingTop: popupChrome || captionBand ? 0 : 'var(--zen-padding)',
          paddingBottom: 'var(--zen-padding)',
          // The hidden-sidebar side keeps a wider gutter: it is the compact-mode reveal zone and
          // must stay hoverable beyond a frameless window's resize border. Toolbar-only windows
          // have no sidebar to reveal; a fullscreen page runs to the edge (main tracks the cursor).
          paddingLeft:
            popupChrome || sidebarSide === 'right'
              ? 'var(--zen-padding)'
              : sidebarHidden && !fullscreen
                ? REVEAL_ZONE
                : 0,
          paddingRight:
            popupChrome || sidebarSide === 'left'
              ? 'var(--zen-padding)'
              : sidebarHidden && !fullscreen
                ? REVEAL_ZONE
                : 0
        }}
      >
        {captionBand && !showToolbar && (
          <div
            className="zen-drag shrink-0"
            style={{ height: overlay.height, minHeight: 'env(titlebar-area-height, 0px)' }}
          />
        )}
        {showToolbar && (
          <Toolbar
            state={state}
            tab={tab}
            trailingInset={captionInset}
            leadingInset={macPopupInset}
            showWindowControls={popupChrome}
          />
        )}
        {showBar && <BookmarksBar state={state} tab={tab} />}
        <div className="relative min-h-0 flex-1">
          <ContentArea state={state} ui={ui} />
          {/*
           * Modal dialogs render in the content frame through FrameDialogHost (its scrim dims
           * this box only); popovers such as the star bubble render through ChromePortal, over
           * the window (lib/portals.tsx).
           */}
          <TabDialogs state={state} />
        </div>
      </main>

      {sidebarHidden && !popupChrome && (
        <>
          <div
            className={cn(
              'absolute top-0 z-40 h-full',
              sidebarSide === 'left' ? 'left-0' : 'right-0'
            )}
            style={{ width: REVEAL_ZONE }}
            onPointerEnter={reveal}
            onPointerMove={reveal}
            onClick={reveal}
            aria-label="Show sidebar"
          />
          {sidebarRevealed && (
            <div
              className={cn(
                'absolute top-0 z-40 h-full p-2',
                sidebarSide === 'left' ? 'left-0' : 'right-0'
              )}
              onPointerEnter={() => revealTimer.current && clearTimeout(revealTimer.current)}
            >
              <Sidebar state={state} isDark={theme.isDark} floating onPointerLeave={unreveal} />
            </div>
          )}
        </>
      )}
      {toolbarHidden && !showToolbar && settings.toolbarLayout === 'multiple' && (
        <CompactToolbar
          state={state}
          showBar={barWanted}
          trailingInset={captionInset}
          fullscreen={fullscreen}
        />
      )}

      {ui.drag && <DragLayer state={state} drag={ui.drag} />}
      {onboarding && <Onboarding state={state} />}
    </div>
  )
}

/** What main's cursor tracking reports (the `compact.reveal` event, as `zen-compact-reveal`). */
type ChromeReveal = Events['compact.reveal']

/**
 * The top toolbar while hidden – compact mode with the toolbar switch on, or the window's
 * fullscreen: the cursor on the top edge brings it (and the bookmarks bar) out over a picture
 * of the page, as the sidebar comes out at its side, and it goes 300 ms after the cursor leaves.
 * Main reports the edge (the page view takes the pointer there); the strip below catches the
 * cursor where the chrome still has a gutter.
 */
function CompactToolbar({
  state,
  showBar,
  trailingInset,
  fullscreen
}: {
  state: UIState
  showBar: boolean
  trailingInset: number
  fullscreen: boolean
}): JSX.Element {
  const tab = activeTab(state)
  const open = uiStore.use((s) => s.toolbarHover)
  const urlbarOpen = uiStore.use((s) => s.urlbar.open)
  const overlay = uiStore.use((s) => s.overlay)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealing = useRef(false)
  const hovering = useRef(false)
  const show = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (uiStore.get().toolbarHover || revealing.current) return
    revealing.current = true
    void captureActiveTab(tab?.id ?? null).then(() => {
      revealing.current = false
      uiStore.set({ toolbarHover: true })
    })
  }, [tab?.id])
  const hide = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      // The toolbar stays while something it opened is up (the URL bar, an overlay).
      const ui = uiStore.get()
      if (ui.overlay !== 'none' || ui.urlbar.open || ui.menu || ui.zoomBubble) return
      uiStore.set({ toolbarHover: false })
      invalidateSnapshot()
    }, 300)
  }, [])
  useEffect(() => {
    const onReveal = (e: Event): void => {
      const { revealed, edge } = (e as CustomEvent<ChromeReveal>).detail
      if (edge !== 'toolbar') return
      if (revealed) show()
      else hide()
    }
    window.addEventListener('zen-compact-reveal', onReveal)
    return () => window.removeEventListener('zen-compact-reveal', onReveal)
  }, [show, hide])
  // What the toolbar opened closed (a URL was entered, an overlay dismissed): with the cursor
  // gone elsewhere the toolbar goes too, instead of standing over a picture of the old page.
  useEffect(() => {
    if (!urlbarOpen && overlay === 'none' && uiStore.get().toolbarHover && !hovering.current) hide()
  }, [urlbarOpen, overlay, hide])
  // The toolbar coming back (or the window leaving fullscreen) puts the live page back.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (uiStore.get().toolbarHover) {
        uiStore.set({ toolbarHover: false })
        invalidateSnapshot()
      }
    },
    []
  )
  return (
    <div
      className="absolute left-0 top-0 z-40"
      // The reveal zone stops short of the native caption buttons: the band under them stays a
      // drag region, and moving towards them does not pop the toolbar.
      style={{ right: trailingInset }}
      onPointerEnter={() => {
        hovering.current = true
        show()
      }}
      onPointerLeave={() => {
        hovering.current = false
        hide()
      }}
    >
      <div className="h-1.5" />
      {open && (
        <div className="px-2">
          <Toolbar
            state={state}
            tab={tab}
            floating
            trailing={
              fullscreen && (
                <button
                  type="button"
                  className="zen-toolbar-button"
                  title={`Exit full screen (${fullscreenBinding(state)})`}
                  aria-label="Exit full screen"
                  onClick={() => run('window.toggleFullscreen', undefined)}
                >
                  <Minimize className="h-4 w-4" />
                </button>
              )
            }
          >
            {showBar && <BookmarksBar state={state} tab={tab} className="px-1" />}
          </Toolbar>
        </div>
      )}
    </div>
  )
}

/** The key that leaves fullscreen, as bound ("F11"; the platform's chord on macOS). */
function fullscreenBinding(state: UIState): string {
  const shortcut = state.shortcuts.find((s) => s.action === 'page.fullscreen')
  return formatBinding(shortcut?.binding ?? shortcut?.extraBindings[0] ?? null, state.platform)
}

/** Keys the renderer handles itself (main handles the shortcut table). */
function useGlobalKeys(state: UIState): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // A popover that closed itself on this Escape (a Settings menulist, a Radix layer) has
      // claimed the key: it returns focus to its anchor and the overlay under it stays open.
      if (e.defaultPrevented) return
      const ui = uiStore.get()
      if (ui.urlbar.open) return // handled by the URL bar input
      if (ui.menu) return // handled by the menu layer
      // Dialogs, choosers and overflow menus take Escape first (capture traps).
      if (ui.bookmarkEdit || ui.starDialog || ui.bookmarkAllTabs || ui.barMenuOpen) return
      if (ui.zoomBubble) return
      if (ui.overlay !== 'none') {
        e.preventDefault()
        closeOverlay()
        return
      }
      if (state.glance) {
        e.preventDefault()
        run('glance.close', undefined)
        return
      }
      if (ui.selectedTabIds.length) {
        e.preventDefault()
        clearTabSelection()
        return
      }
      if (ui.findOpen && ui.findTabId) closeFindBar('afterKey')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.glance])

  // A multi-selection belongs to one space; drop it when the space changes.
  useEffect(() => {
    clearTabSelection()
  }, [state.activeSpaceId])

  // Sidebar collapse toggle (Zen's "Toggle Sidebar" action).
  useEffect(() => {
    const onToggle = (): void => run('sidebar.toggleExpanded', undefined)
    window.addEventListener('zen-sidebar-toggle', onToggle)
    return () => window.removeEventListener('zen-sidebar-toggle', onToggle)
  }, [])
}

/**
 * The "New Tab" button and empty state ask the core for a new tab: Zen's floating URL bar in
 * new-tab mode (it comes back as `urlbar.toggle`), or the page an extension overrides new tabs
 * with. Closing the bar first keeps the toggle from swallowing the request while it is open.
 */
function useNewTabEvent(): void {
  useEffect(() => {
    const onNewTab = (): void => {
      closeUrlbar()
      run('tab.new', undefined)
    }
    window.addEventListener('zen-new-tab', onNewTab)
    return () => window.removeEventListener('zen-new-tab', onNewTab)
  }, [])
}

/** Remember where the pointer went down so renderer-hosted menus can anchor there. */
function usePointerTracking(): void {
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      lastPointer.x = e.clientX
      lastPointer.y = e.clientY
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])
}
