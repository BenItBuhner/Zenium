import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Minimize } from 'lucide-react'
import type { Events, Rect, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import type { ResolvedTheme } from '@shared/theme'
import { bookmarksBarVisible } from '@shared/bookmarkViews'
import { formatBinding } from '@shared/shortcuts'
import { hasTopToolbar, isHorizontalTabs } from '@shared/toolbarLayout'
import { run } from '@renderer/lib/api'
import { closeExtensionPopup } from '@renderer/lib/extensions/popup'
import { isPhone, useFormFactorReport, useViewport } from '@renderer/lib/formFactor'
import { openNewTabPage } from '@renderer/lib/newtab'
import { onboardingCovers } from '@renderer/lib/onboarding'
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
import { useStageContinuity } from '@renderer/hooks/useStageContinuity'
import { useTheme } from '@renderer/hooks/useTheme'
import { Announcer } from './components/Announcer'
import { AppTitleBar } from './components/app/AppTitleBar'
import { BookmarksBar } from './components/bookmarks/BookmarksBar'
import { captionBandInMain } from '@renderer/lib/layout'
import { ContentArea } from './components/content/ContentArea'
import { FindBar } from './components/content/FindBar'
import { ChromeDropLayer, DragLayer } from './components/DragLayer'
import { PopupFrame } from './components/extensions/PopupFrame'
import { ModStyles } from './components/ModStyles'
import { Onboarding } from './components/overlays/Onboarding'
import { PhoneShell } from './components/phone/PhoneShell'
import { COLLAPSED_WIDTH, Sidebar } from './components/sidebar/Sidebar'
import { HorizontalChrome } from './components/strip/HorizontalChrome'
import { TabDialogs } from './components/TabDialogs'
import { TabHoverCard } from './components/TabHoverCard'
import { TabletShell } from './components/tablet/TabletShell'
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
  useStageContinuity(viewport.formFactor)
  const ui = uiStore.use()
  // A page's sized popup and a web app's window keep the one-row desktop chrome at any size and
  // with any pointer (`formFactorFor`): the tablet shell is for a window with tabs to show.
  const popupChrome = state.window.chrome === 'popup' || state.window.chrome === 'app'

  return (
    <>
      {viewport.formFactor === 'phone' ? (
        <PhoneShell state={state} ui={ui} isDark={theme.isDark} />
      ) : viewport.formFactor === 'tablet' && !popupChrome ? (
        <TabletShell state={state} ui={ui} isDark={theme.isDark} />
      ) : (
        <DesktopShell state={state} theme={theme} />
      )}
      {/* The extension popup's frame is a popover: it renders through the chrome layer. */}
      <PopupFrame />
      {/* The one status region a screen reader hears tab switches, downloads, find and zoom from. */}
      <Announcer />
    </>
  )
}

/**
 * Desktop and DeX: Zen's vertical sidebar next to the content card. Also the one-row windows (a
 * page's popup, a web app) at every form factor, the tablet's included.
 */
function DesktopShell({ state, theme }: { state: UIState; theme: ResolvedTheme }): JSX.Element {
  const ui = uiStore.use()
  const tab = activeTab(state)
  const settings = state.settings
  const compact = settings.compactMode
  const sidebarSide = settings.sidebarSide
  // One-row windows: a page's sized popup with its read-only toolbar, and a web app's
  // standalone window with its title bar (`AppTitleBar`); neither has a sidebar or a bookmarks
  // bar, and neither hides its row.
  const appWindow = state.window.chrome === 'app' ? state.window.app : null
  const popupChrome = state.window.chrome === 'popup' || state.window.chrome === 'app'
  // Blank / private windows never show onboarding (it belongs to the main profile window); the
  // chrome that waits for the tour to end (the URL bar) reads the same terms (`onboardingUp`).
  const onboarding = onboardingCovers(state)
  const htmlFullscreen = state.window.htmlFullscreenTabId !== null
  // The window's fullscreen (F11): the page runs edge to edge and the chrome hides as it does in
  // compact mode with both switches on, coming out at its edge under the cursor.
  const fullscreen = !popupChrome && state.window.fullscreen

  // The horizontal layout (design language v2 §9.37): the tab strip along the caption band, the
  // toolbar row under it, the 56 rail beside the frame. A one-row window keeps its one row.
  const horizontal = !popupChrome && isHorizontalTabs(settings.toolbarLayout)

  const sidebarHidden =
    popupChrome ||
    fullscreen ||
    (compact.enabled && compact.hideSidebar && !compact.sidebarPersistent)
  const toolbarHidden =
    !popupChrome &&
    (fullscreen || (compact.enabled && compact.hideToolbar)) &&
    settings.toolbarLayout !== 'single'
  const showToolbar = popupChrome || (settings.toolbarLayout === 'multiple' && !toolbarHidden)
  // The strip and the toolbar row are the horizontal layout's top chrome: hidden together in
  // compact mode and fullscreen, and revealed together at the top edge (`CompactToolbar`).
  const topChrome = horizontal && !toolbarHidden
  const sidebarRevealed = !popupChrome && sidebarHidden && ui.compactHover
  // The bookmarks bar sits under the toolbar and hides with it in compact mode; popups never show it.
  const barWanted = !popupChrome && bookmarksBarVisible(settings.bookmarksBar, tab?.url ?? null)
  const showBar = barWanted && !fullscreen && !(compact.enabled && compact.hideToolbar)
  // Windows draws the caption buttons over the top trailing corner: whatever sits there keeps
  // clear of them, and the content column starts below them when they land on it. The strip
  // holds the band while it is up, keeping their footprint clear at its trailing end itself.
  const overlay = useCaptionOverlay()
  const captionBand =
    !topChrome &&
    captionBandInMain({
      overlayWidth: overlay.width,
      sidebarSide,
      sidebarWidth: sidebarHidden
        ? null
        : settings.sidebarExpanded && !horizontal
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

  // The sidebar column and the content column: the window's row, or the row under the
  // horizontal layout's top chrome.
  const columns = (
    <>
      {!sidebarHidden && <Sidebar state={state} isDark={theme.isDark} rail={horizontal} />}
      {/* The column beside the sidebar: the toolbar (a banner in the multiple-toolbar layout),
          the bookmarks bar and the page box, which is the window's `main` landmark (a11y-02). */}
      <div
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
        {showToolbar && appWindow ? (
          <AppTitleBar
            state={state}
            tab={tab}
            app={appWindow}
            trailingInset={captionInset}
            leadingInset={macPopupInset}
          />
        ) : (
          showToolbar && (
            <Toolbar
              state={state}
              tab={tab}
              trailingInset={captionInset}
              leadingInset={macPopupInset}
              showWindowControls={popupChrome}
            />
          )
        )}
        {showBar && !topChrome && <BookmarksBar state={state} tab={tab} />}
        <main className="relative min-h-0 flex-1">
          <ContentArea state={state} ui={ui} />
          {/*
           * Modal dialogs render in the content frame through FrameDialogHost (its scrim dims
           * this box only); popovers such as the star bubble render through ChromePortal, over
           * the window (lib/portals.tsx).
           */}
          <TabDialogs state={state} />
        </main>
      </div>
    </>
  )

  return (
    <div
      className={cn(
        'zen-window relative flex h-full w-full overflow-hidden',
        horizontal ? 'flex-col' : sidebarSide === 'right' && 'flex-row-reverse'
      )}
      data-dark={theme.isDark}
      data-window-kind={state.window.kind}
      data-window-chrome={state.window.chrome}
      data-caption-overlay={overlay.width > 0 ? 'true' : 'false'}
      data-layout={settings.toolbarLayout}
      data-testid="chrome-root"
    >
      <ModStyles mods={state.mods} />
      <div className="zen-texture" />
      {topChrome && <HorizontalChrome state={state} tab={tab} showBar={showBar} />}
      {horizontal ? (
        <div className={cn('flex min-h-0 flex-1', sidebarSide === 'right' && 'flex-row-reverse')}>
          {columns}
        </div>
      ) : (
        columns
      )}

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
              <Sidebar
                state={state}
                isDark={theme.isDark}
                floating
                rail={horizontal}
                onPointerLeave={unreveal}
              />
            </div>
          )}
        </>
      )}
      {toolbarHidden && !showToolbar && hasTopToolbar(settings.toolbarLayout) && (
        <CompactToolbar
          state={state}
          showBar={barWanted}
          trailingInset={captionInset}
          fullscreen={fullscreen}
          horizontal={horizontal}
        />
      )}

      {ui.drag && <DragLayer state={state} drag={ui.drag} />}
      <ChromeDropLayer />
      <TabHoverCard state={state} />
      {onboarding && <Onboarding state={state} />}
    </div>
  )
}

/** What main's cursor tracking reports (the `compact.reveal` event, as `zen-compact-reveal`). */
type ChromeReveal = Events['compact.reveal']

/** The hidden toolbar's slide, in and out (Edge's reveal is about this long); `.zen-toolbar-reveal`. */
const TOOLBAR_SLIDE_MS = 200

/**
 * The top toolbar while hidden – compact mode with the toolbar switch on, or the window's
 * fullscreen: the cursor on the top edge slides it (and the bookmarks bar) down over a picture
 * of the page, as the sidebar comes out at its side, and it slides back 300 ms after the cursor
 * leaves. The picture stays under it until the slide out is done, so the toolbar never crosses
 * the live page view. Main reports the edge (the page view takes the pointer there); the strip
 * below catches the cursor where the chrome still has a gutter.
 */
function CompactToolbar({
  state,
  showBar,
  trailingInset,
  fullscreen,
  horizontal
}: {
  state: UIState
  showBar: boolean
  trailingInset: number
  fullscreen: boolean
  /** The horizontal layout's top chrome – the strip and the toolbar row – comes out as one. */
  horizontal: boolean
}): JSX.Element {
  const tab = activeTab(state)
  const open = uiStore.use((s) => s.toolbarHover)
  const urlbarOpen = uiStore.use((s) => s.urlbar.open)
  const overlay = uiStore.use((s) => s.overlay)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const slideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealing = useRef(false)
  const hovering = useRef(false)
  // The toolbar is sliding away (the pose is off while it still stands, until it unmounts).
  const [closing, setClosing] = useState(false)
  const show = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    // A slide out under way turns around where it is.
    if (slideTimer.current) clearTimeout(slideTimer.current)
    slideTimer.current = null
    setClosing(false)
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
      if (!ui.toolbarHover || slideTimer.current) return
      // Slide out over the page's picture; the live page comes back once the toolbar is gone.
      setClosing(true)
      slideTimer.current = setTimeout(() => {
        slideTimer.current = null
        setClosing(false)
        uiStore.set({ toolbarHover: false })
        invalidateSnapshot()
      }, TOOLBAR_SLIDE_MS)
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
  // Main's cursor tracking hears whether the toolbar is out: one it saw put away here (the hover
  // left it while the cursor stayed near the top) it brings back on the next touch of the edge.
  useEffect(() => {
    run('compact.setRevealed', { revealed: open, edge: 'toolbar' })
  }, [open])
  // The toolbar coming back (or the window leaving fullscreen) puts the live page back.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (slideTimer.current) clearTimeout(slideTimer.current)
      if (uiStore.get().toolbarHover) {
        uiStore.set({ toolbarHover: false })
        invalidateSnapshot()
      }
      run('compact.setRevealed', { revealed: false, edge: 'toolbar' })
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
        <SlideDown closing={closing}>
          {horizontal ? (
            <HorizontalChrome
              state={state}
              tab={tab}
              showBar={showBar}
              floating
              trailing={fullscreen && <ExitFullscreenButton state={state} />}
            />
          ) : (
            <Toolbar
              state={state}
              tab={tab}
              floating
              trailing={fullscreen && <ExitFullscreenButton state={state} />}
            >
              {showBar && <BookmarksBar state={state} tab={tab} className="px-1" />}
            </Toolbar>
          )}
        </SlideDown>
      )}
    </div>
  )
}

/** The hidden chrome's way out of the window's fullscreen, at its trailing end. */
function ExitFullscreenButton({ state }: { state: UIState }): JSX.Element {
  return (
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

/**
 * The hidden toolbar's slide (`.zen-toolbar-reveal`): mounted in its hidden pose, open a frame
 * later so the transition has a start, and off again while `closing` – it unmounts once the
 * slide out is done, which is also what resets it for the next reveal.
 */
function SlideDown({ closing, children }: { closing: boolean; children: ReactNode }): JSX.Element {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    // Two frames: the hidden pose must be the computed style once before the open one.
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [])
  return (
    <div
      className="zen-toolbar-reveal px-2"
      data-open={entered && !closing ? 'true' : undefined}
      data-testid="toolbar-reveal"
    >
      {children}
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
      if (ui.extensionPrompts.length) return // the prompt dialog answers Escape itself
      if (ui.extensionPopup) {
        e.preventDefault()
        closeExtensionPopup()
        return
      }
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

  // A multi-selection belongs to one space; drop it when the space changes. So does the tab
  // strip's roving tab stop: the new space's active row is the stop (lib/tabStrip.ts).
  useEffect(() => {
    clearTabSelection()
    if (uiStore.get().stripFocus !== null) uiStore.set({ stripFocus: null })
  }, [state.activeSpaceId])

  // Sidebar collapse toggle (Zen's "Toggle Sidebar" action).
  useEffect(() => {
    const onToggle = (): void => run('sidebar.toggleExpanded', undefined)
    window.addEventListener('zen-sidebar-toggle', onToggle)
    return () => window.removeEventListener('zen-sidebar-toggle', onToggle)
  }, [])
}

/**
 * The "New Tab" button and empty state ask the core for a new tab: the `zen://newtab` page (it
 * comes back as `newtab.opened` with the URL bar over it), Zen's floating URL bar in new-tab mode
 * when the page is off (`urlbar.toggle`), or the page an extension overrides new tabs with.
 * Closing the bar first keeps the toggle from swallowing the request while it is open.
 * The phone opens its own new tab page instead (the WebView has no `zen://newtab` yet) – grown
 * out of the control that asked for it when the event says where that was (`detail.origin`,
 * window coordinates), and a private one when the event names the private container
 * (`detail.containerId`; the tabs quick menu and the overview's private pane).
 */
function useNewTabEvent(): void {
  useEffect(() => {
    const onNewTab = (e: Event): void => {
      const detail = (e as CustomEvent<{ origin?: Rect; containerId?: string } | undefined>).detail
      if (isPhone()) {
        void openNewTabPage(detail?.origin ?? null, { containerId: detail?.containerId })
        return
      }
      closeUrlbar()
      if (detail?.containerId === PRIVATE_CONTAINER_ID) run('tab.newPrivate', {})
      else run('tab.new', undefined)
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
