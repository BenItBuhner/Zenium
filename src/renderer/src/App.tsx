import type { JSX } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import type { UIState } from '@shared/types'
import type { ResolvedTheme } from '@shared/theme'
import { bookmarksBarVisible } from '@shared/bookmarkViews'
import { run } from '@renderer/lib/api'
import { isPhone, useFormFactorReport, useViewport } from '@renderer/lib/formFactor'
import { activeTab } from '@renderer/lib/selectors'
import {
  captureActiveTab,
  clearTabSelection,
  closeOverlay,
  closeUrlbar,
  invalidateSnapshot,
  lastPointer,
  openUrlbar,
  returnFocusToPage,
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
import { DragGhost } from './components/DragGhost'
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
  useNewTabEvent(state)
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

  const sidebarHidden =
    popupChrome || (compact.enabled && compact.hideSidebar && !compact.sidebarPersistent)
  const toolbarHidden =
    !popupChrome && compact.enabled && compact.hideToolbar && settings.toolbarLayout !== 'single'
  const showToolbar = popupChrome || (settings.toolbarLayout === 'multiple' && !toolbarHidden)
  const sidebarRevealed = !popupChrome && sidebarHidden && ui.compactHover
  // The bookmarks bar sits under the toolbar and hides with it in compact mode; popups never show it.
  const barWanted = !popupChrome && bookmarksBarVisible(settings.bookmarksBar, tab?.url ?? null)
  const showBar = barWanted && !(compact.enabled && compact.hideToolbar)
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
      if (popupChrome || !sidebarHidden) return
      if ((e as CustomEvent<boolean>).detail) reveal()
      else unreveal()
    }
    window.addEventListener('zen-compact-reveal', onReveal)
    return () => window.removeEventListener('zen-compact-reveal', onReveal)
  }, [popupChrome, sidebarHidden, reveal, unreveal])

  if (htmlFullscreen) {
    // The fullscreen view covers everything; keep the tree alive but paint nothing.
    return <div className="h-full w-full bg-black" />
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
          // have no sidebar to reveal.
          paddingLeft:
            popupChrome || sidebarSide === 'right'
              ? 'var(--zen-padding)'
              : sidebarHidden
                ? REVEAL_ZONE
                : 0,
          paddingRight:
            popupChrome || sidebarSide === 'left'
              ? 'var(--zen-padding)'
              : sidebarHidden
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
          {/* Bookmark dialogs dim only this frame; the star bubble portals to the window. */}
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
        <CompactToolbar state={state} showBar={barWanted} trailingInset={captionInset} />
      )}

      {ui.drag && <DragGhost state={state} drag={ui.drag} />}
      {onboarding && <Onboarding state={state} />}
    </div>
  )
}

/** Compact mode with the top toolbar hidden: hover the top edge to reveal it (and the bar). */
function CompactToolbar({
  state,
  showBar,
  trailingInset
}: {
  state: UIState
  showBar: boolean
  trailingInset: number
}): JSX.Element {
  const tab = activeTab(state)
  const ref = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = (): void => {
    if (timer.current) clearTimeout(timer.current)
    ref.current?.setAttribute('data-open', 'true')
  }
  const hide = (): void => {
    timer.current = setTimeout(() => ref.current?.removeAttribute('data-open'), 300)
  }
  return (
    <div
      ref={ref}
      className="group/ct absolute left-0 top-0 z-40"
      // The reveal zone stops short of the native caption buttons: the band under them stays a
      // drag region, and moving towards them does not pop the toolbar.
      style={{ right: trailingInset }}
      onPointerEnter={show}
      onPointerLeave={hide}
    >
      <div className="h-1.5" />
      <div className="px-2 opacity-0 transition-opacity group-data-[open=true]/ct:opacity-100 pointer-events-none group-data-[open=true]/ct:pointer-events-auto">
        <Toolbar state={state} tab={tab} floating>
          {showBar && <BookmarksBar state={state} tab={tab} className="px-1" />}
        </Toolbar>
      </div>
    </div>
  )
}

/** Keys the renderer handles itself (main handles the shortcut table). */
function useGlobalKeys(state: UIState): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const ui = uiStore.get()
      if (ui.urlbar.open) return // handled by the URL bar input
      if (ui.menu) return // handled by the menu layer
      // Dialogs, choosers and overflow menus take Escape first (capture traps).
      if (ui.bookmarkEdit || ui.starDialog || ui.bookmarkAllTabs || ui.barMenuOpen) return
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
      if (ui.findOpen && ui.findTabId) {
        run('find.stop', { tabId: ui.findTabId, keepSelection: true })
        uiStore.set({ findOpen: false, findTabId: null })
        returnFocusToPage()
      }
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

/** The "New Tab" button and empty state open Zen's floating URL bar instead of a new-tab page. */
function useNewTabEvent(state: UIState): void {
  useEffect(() => {
    const onNewTab = (): void => {
      closeUrlbar()
      void openUrlbar('new-tab', activeTab(state)?.id ?? null, {
        attached: isPhone() || state.settings.urlbarBehavior === 'normal'
      })
    }
    window.addEventListener('zen-new-tab', onNewTab)
    return () => window.removeEventListener('zen-new-tab', onNewTab)
  }, [state])
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
