import type { CSSProperties, JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Globe, Lock, Search } from 'lucide-react'
import { internalPageOf } from '@shared/internalPages'
import type { PhoneBarPosition, Space, Tab, UIState } from '@shared/types'
import { displayHost } from '@shared/url'
import { run } from '@renderer/lib/api'
import {
  contentShift,
  cssPx,
  dismissDock,
  dockStore,
  phoneBarHeight
} from '@renderer/lib/gestures/dock'
import { closeOverview, overviewIsOpen, stageStore } from '@renderer/lib/gestures/stage'
import { closeSpacesDrawer } from '@renderer/lib/gestures/drawer'
import { barFade } from '@renderer/lib/motion/recede'
import { activeSpace, activeTab } from '@renderer/lib/selectors'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import {
  closeBarEditor,
  closeTabsMenu,
  contentAreaStore,
  dismissBanner,
  openBarEditor,
  openTabsMenu,
  openUrlbar,
  overlayCoversContent,
  showBanner,
  uiStore,
  type UiState
} from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { ContentArea } from '../content/ContentArea'
import { MessageLayer } from '../messages/MessageLayer'
import { Onboarding } from '../overlays/Onboarding'
import { Favicon } from '../sidebar/Favicon'
import { TabDialogs } from '../TabDialogs'
import { PillChip } from '../urlbar/PillChip'
import { Urlbar } from '../urlbar/Urlbar'
import { BarButton } from './BarButton'
import { barContext, barLayout } from './barItems'
import { PhoneStage } from './PhoneStage'
import { SpacesDrawer } from './SpacesDrawer'
import { TabPreview } from './TabPreview'
import { TabsQuickMenu } from './TabsQuickMenu'
import { useBarHold, type BarHoldHandlers } from './useBarHold'
import { useGestureHint } from './useGestureHint'
import { usePillGestures, type PillGestureHandlers } from './usePillGestures'
import './phonePanels.css'

interface Props {
  state: UIState
  ui: UiState
  isDark: boolean
}

/**
 * Phone layout: the content card fills the screen next to a bar docked at the top or bottom edge
 * (Settings, or long-press the address pill and carry it over); tabs live in the overview pulled
 * in from the address pill, and the spaces (with the Essentials) in a drawer that slides over it
 * from the sidebar's side. Every component inside is the same one the desktop layout uses.
 *
 * The shell hands the safe-area insets to whatever touches each edge – the bar on its side, the
 * content gutter on the other – rather than padding the window as a whole, so the keyboard inset
 * is honoured exactly once whichever edge the bar is on.
 */
export function PhoneShell({ state, ui, isDark }: Props): JSX.Element {
  const tab = activeTab(state)
  const edge = state.settings.phoneBarPosition
  const onboarding = !state.settings.onboardingDone
  const htmlFullscreen = state.window.htmlFullscreenTabId !== null
  const activeTabId = tab?.id ?? null
  const dock = dockStore.use()
  const overviewOpen = stageStore.use((s) => s.overview.phase !== 'closed')

  // Picking a tab (or opening chrome UI) in the drawer closes it.
  const lastActive = useRef(activeTabId)
  useEffect(() => {
    if (lastActive.current !== activeTabId && ui.drawerOpen) closeSpacesDrawer()
    lastActive.current = activeTabId
  }, [activeTabId, ui.drawerOpen])

  // Leaving the phone layout (rotation, DeX) drops a half-carried bar, the bar's editor and menu.
  useEffect(
    () => () => {
      dismissDock()
      closeBarEditor()
      closeTabsMenu()
    },
    []
  )

  // The lighter default-browser reminder (DEF-02) is one of the top banners (v2 §9.33), up for
  // as long as the core says a banner is due. Swiping or closing it is the campaign's one
  // dismissal; the action hands over to the system, which ends the campaign either way; and
  // when the core takes the prompt down itself – after the request, or once Zenium holds the
  // role – the card leaves as `'program'`, which counts for nothing. A third banner pushing it
  // off (`'replaced'`) is not the user's answer either.
  const bannerDue = state.defaultBrowser.prompt === 'banner' && !onboarding
  useEffect(() => {
    if (!bannerDue) return
    const id = showBanner({
      title: 'Open links in Zenium',
      detail: 'Make it your default browser',
      icon: Globe,
      action: {
        label: 'Set as default',
        onPick: () => run('defaultBrowser.request', { source: 'banner' })
      },
      key: 'default-browser',
      duration: null,
      onDismiss: (reason) => {
        if (reason === 'swipe' || reason === 'close')
          run('defaultBrowser.dismiss', { prompt: 'banner' })
      }
    })
    return () => dismissBanner(id)
  }, [bannerDue])

  // A hold on the Tabs button: its quick menu, anchored to the button; any other hold, the editor.
  const hold = useBarHold({
    onHold: (item, rect) => {
      if (item === 'tabs') void openTabsMenu(rect, activeTabId)
      else void openBarEditor(activeTabId)
    }
  })

  const pill = usePillGestures({
    edge,
    onTap: (e) => {
      const icon = (e.target as HTMLElement).closest('[data-site-info]')
      if (overviewIsOpen()) closeOverview()
      else if (tab && icon) {
        // The site icon at the start of the pill opens the site information instead.
        const r = icon.getBoundingClientRect()
        void openSiteInfo(tab, { x: r.left, y: r.top, width: r.width, height: r.height })
      } else void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, { attached: true })
    }
  })

  const barHidden = ui.urlbar.open
  // The one-time gesture hint (FRE-07) is a toast on the message cards, owed once the chrome is
  // calm: a page in view under nothing, the bar and its pill in place, no drag, overview or prompt.
  useGestureHint(
    state,
    edge,
    !onboarding &&
      !htmlFullscreen &&
      !barHidden &&
      tab !== null &&
      !overlayCoversContent(ui) &&
      !overviewOpen &&
      dock.phase === 'idle' &&
      state.defaultBrowser.prompt !== 'sheet'
  )

  if (htmlFullscreen) return <div className="h-full w-full bg-black" />

  // The pill is off its slot and Settings still name the edge it left: the bar there fades out
  // as a preview of the bar at the other edge fades in. Once the new edge is committed the bar
  // simply renders there, under the ghost that is setting down on it.
  const fromHere = dock.phase !== 'idle' && dock.from === edge
  const p = Math.min(1, Math.max(0, dock.progress))
  return (
    <div
      className="zen-window relative flex h-full w-full flex-col overflow-hidden"
      data-dark={isDark}
      style={{
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 'var(--zen-inset-left)',
        paddingRight: 'var(--zen-inset-right)'
      }}
    >
      <div className="zen-texture" />
      {/* The chrome under the sheets – the content column, the messages, the stage, the bar, the
          drawer and the tabs menu – carries `data-shell-chrome`: it goes inert while a sheet or
          a frame dialog is up (§9.22, `holdChromeInert` in lib/portals.tsx). */}
      <main
        data-shell-chrome
        className="relative flex min-h-0 flex-1 flex-col"
        style={{
          // The bar's edge reserves the bar band (the URL bar's field takes it over while the bar
          // is hidden); the other edge keeps the content gutter above the inset.
          paddingTop: edgePadding('top', edge),
          paddingBottom: edgePadding('bottom', edge),
          paddingLeft: 'var(--zen-padding)',
          paddingRight: 'var(--zen-padding)'
        }}
      >
        <div className="relative min-h-0 flex-1">
          <ContentArea state={state} ui={ui} />
        </div>
      </main>
      {/* Messages sit on the content frame's box, over the bar and the stage but under sheets. */}
      <div
        data-shell-chrome
        className="zen-message-frame pointer-events-none absolute z-[36]"
        style={{
          top: edgePadding('top', edge),
          bottom: edgePadding('bottom', edge),
          left: 'var(--zen-padding)',
          right: 'var(--zen-padding)'
        }}
      >
        <MessageLayer />
      </div>
      <PhoneStage state={state} />
      {/* The bar's opacity is the chassis rule in main.css: docked at the bottom edge, where a
          sheet arrives, it fades by `1 − recede`, the sheet's progress (v2 draft §11.1); docked
          at the top it is not in the sheet's path and stays, inert under the scrim (ruled
          23:50). At rest nothing is written over it; while the pill is carried the carry's own
          fade goes through `barFade`, which composes the recede into it at the bottom edge
          only, so a sheet coming up mid-carry fades the bar there all the same. */}
      {!barHidden && (
        <PhoneBar
          state={state}
          edge={edge}
          pill={pill}
          hold={hold}
          overviewOpen={overviewOpen}
          pillLook={dock.phase === 'idle' ? 'docked' : 'well'}
          style={fromHere ? { opacity: barFade(edge, 1 - p) } : undefined}
        />
      )}
      {!barHidden && fromHere && (
        // The slot the pill is heading for, revealed as the page slides out of its way.
        <PhoneBar
          state={state}
          edge={dock.from === 'bottom' ? 'top' : 'bottom'}
          pill={pill}
          overviewOpen={overviewOpen}
          pillLook={p >= 0.5 ? 'well-target' : 'well'}
          inert
          style={{ opacity: barFade(dock.from === 'bottom' ? 'top' : 'bottom', p) }}
        />
      )}
      {barHidden && <Urlbar state={state} urlbar={ui.urlbar} area={null} phoneEdge={edge} />}
      {dock.phase !== 'idle' && <BarDockLayer state={state} pill={pill} />}
      {ui.drawerOpen && <SpacesDrawer state={state} isDark={isDark} />}
      {ui.tabsMenu && !barHidden && (
        <TabsQuickMenu state={state} anchor={ui.tabsMenu} edge={edge} onClose={closeTabsMenu} />
      )}
      {/* The frame's dialog host (the shell's box on a phone): the bookmark editor is one of its sheets. */}
      <TabDialogs state={state} />
      {onboarding && <Onboarding state={state} />}
    </div>
  )
}

/** What the content column leaves free at `side`: the bar band on the bar's edge, a gutter elsewhere. */
function edgePadding(side: PhoneBarPosition, barEdge: PhoneBarPosition): string {
  const inset = `var(--zen-inset-${side})`
  return side === barEdge
    ? `calc(${inset} + var(--zen-phone-bar))`
    : `calc(${inset} + var(--zen-padding))`
}

type PillLook = 'docked' | 'well' | 'well-target'

/**
 * The bar docked at `edge`: the controls of `settings.phoneBar` either side of the address pill
 * (by default back · pill · new tab · tabs · menu). The pill is the gesture anchor: swipe it
 * sideways to move to the previous / next tab (the neighbour's card follows the finger), pull it
 * towards the middle of the screen for the tab overview, tap it for the URL bar, hold it to
 * carry the whole bar to the other edge. A hold anywhere else on the bar opens the editor that
 * rearranges it (on the Tabs button, its quick menu). Window chrome (v2 §9.29): the bar and the
 * pill carry `data-surface="window"`, so their chips draw in the window family.
 */
export function PhoneBar({
  state,
  edge,
  pill,
  hold,
  overviewOpen,
  pillLook,
  inert,
  style
}: {
  state: UIState
  edge: PhoneBarPosition
  pill: PillGestureHandlers
  hold?: BarHoldHandlers
  overviewOpen: boolean
  /** The pill in place, or the empty slot it left (highlighted when it is about to land here). */
  pillLook: PillLook
  /** A preview of the bar at the other edge: drawn, never pressed. */
  inert?: boolean
  style?: CSSProperties
}): JSX.Element {
  const tab = activeTab(state)
  const space = activeSpace(state)
  const ctx = barContext(state, overviewOpen)
  const layout = barLayout(state)
  const inset = `var(--zen-inset-${edge})`

  return (
    <nav
      className={cn(
        'zen-phone-bar absolute z-30 flex items-center gap-1 px-2',
        edge === 'bottom' ? 'bottom-0' : 'top-0',
        // While the pill is being carried the other buttons are on their way out too.
        pillLook !== 'docked' && 'zen-phone-bar-lifted',
        inert && 'pointer-events-none'
      )}
      // Window chrome: the bar, the pill and their chips draw in the window family (v2 §9.29).
      data-surface="window"
      // The edge it is docked at: main.css fades the bottom-docked bar with a sheet (§11.1).
      data-edge={edge}
      aria-hidden={inert || undefined}
      data-shell-chrome
      style={{
        ...style,
        left: 'var(--zen-inset-left)',
        right: 'var(--zen-inset-right)',
        paddingTop: edge === 'top' ? `calc(${inset} + 6px)` : 6,
        paddingBottom: edge === 'bottom' ? `calc(${inset} + 6px)` : 6
      }}
      {...(inert ? {} : hold)}
    >
      {layout.left.map((id) => (
        <BarButton key={id} id={id} ctx={ctx} inert={inert} />
      ))}
      {/*
        The pill is a gesture surface, not a button: its site icon, address and lock are real
        buttons inside it, so TalkBack gets a node for each (a button's descendants would all
        collapse into one). Taps are told apart in onTap by what was under the finger.
      */}
      <div
        role="group"
        aria-label={inert ? undefined : 'Address'}
        className={cn(
          'zen-phone-pill flex h-11 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-full px-3.5 text-left',
          pillLook === 'docked' &&
            'bg-[var(--zen-element-bg)] active:bg-[var(--zen-element-bg-hover)]',
          pillLook !== 'docked' && 'zen-pill-well',
          pillLook === 'well-target' && 'zen-pill-well-target'
        )}
        data-surface="window"
        {...(inert ? {} : pill)}
      >
        {pillLook === 'docked' && (
          <PillContent state={state} tab={tab} space={space} interactive={!inert} />
        )}
      </div>
      {layout.right.map((id) => (
        <BarButton key={id} id={id} ctx={ctx} inert={inert} />
      ))}
    </nav>
  )
}

/**
 * What the pill says. While a swipe moves the tab track the pill follows the tab under the
 * finger – its label slides a little with the cards and swaps as the nearest card changes.
 * `interactive` renders the address as a button and the site icon and the lock as chips of
 * their own (tapping either opens the site information, see the pill's onTap); the ghost
 * carried across the screen draws the same content inert. The address comes first in the DOM
 * so the tab order and TalkBack reach the field before its chips (design language v2 §9.22);
 * the site icon is drawn ahead of it with `order-first`.
 */
export function PillContent({
  state,
  tab,
  space,
  interactive
}: {
  state: UIState
  tab: Tab | null
  space: Space
  interactive: boolean
}): JSX.Element {
  const underFinger = stageStore.use((s) => {
    if (s.tabs.phase === 'idle') return null
    return s.tabs.order[Math.round(s.tabs.position)] ?? null
  })
  const shift = stageStore.use((s) => {
    if (s.tabs.phase === 'idle') return 0
    return Math.round((Math.round(s.tabs.position) - s.tabs.position) * 16)
  })
  const siteInfoOpen = uiStore.use((s) => s.siteInfoOpen)
  const shown = (underFinger && state.tabs[underFinger]) || tab
  // The site alone, as Chrome's omnibox shows it at rest: the path would only push it off the pill.
  const url = shown ? displayHost(shown.url) : ''
  // No lock over a certificate that failed verification (the interstitial, or the page the user
  // proceeded to): the connection is not secure, as site information says.
  const secure = shown?.url.startsWith('https://') && !shown.certificateError
  // An internal page (Settings): its glyph in the favicon slot and the page's name, no lock and
  // no site-information chip – there is no site (v2 §10.1); the registry says which glyph.
  const page = shown ? internalPageOf(shown.url) !== null : false
  const Control = interactive ? 'button' : 'span'
  const controlProps = interactive ? { type: 'button' as const } : {}
  return (
    <span
      key={shown?.id ?? 'empty'}
      className="zen-animate-fade flex min-w-0 flex-1 items-center gap-2"
      style={{ transform: shift ? `translateX(${shift}px)` : undefined }}
    >
      <Control
        {...controlProps}
        className="flex h-full min-w-0 flex-1 items-center text-left"
        aria-label={interactive ? (url ? `Address, ${url}` : 'Search or enter address') : undefined}
      >
        <span
          className={cn('min-w-0 flex-1 truncate text-[14px]', !url && 'text-[var(--zen-muted)]')}
        >
          {url || 'Search or enter address'}
        </span>
      </Control>
      {shown && page ? (
        <span
          className="order-first -ml-1.5 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <Favicon tab={shown} size={16} />
        </span>
      ) : shown ? (
        <PillChip
          inert={!interactive}
          label="Site information"
          popup="dialog"
          expanded={siteInfoOpen}
          data-site-info
          className="order-first -ml-1.5 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        >
          <Favicon tab={shown} size={16} />
        </PillChip>
      ) : (
        <Search className="order-first h-4 w-4 shrink-0 opacity-60" />
      )}
      {url && secure && !page && (
        <PillChip
          inert={!interactive}
          label="Connection is secure"
          popup="dialog"
          expanded={siteInfoOpen}
          data-site-info
          className="-mx-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        >
          <Lock className="h-3.5 w-3.5 opacity-50" />
        </PillChip>
      )}
      {state.spaces.length > 1 && (
        <span className="max-w-[64px] shrink-0 truncate text-[11px] text-[var(--zen-muted)]">
          {space.icon || space.name}
        </span>
      )}
    </span>
  )
}

/**
 * The bar being carried: the page rides along as a card that slides out of the pill's way, and
 * the pill itself – lifted, following the finger – floats above everything. The card is drawn
 * over both bars (their buttons pass underneath it, revealed at one edge and covered at the
 * other), the ghost over the card; a touch on the ghost catches it mid-flight.
 */
function BarDockLayer({
  state,
  pill
}: {
  state: UIState
  pill: PillGestureHandlers
}): JSX.Element | null {
  const dock = dockStore.use()
  const area = contentAreaStore.use((s) => s.area)
  const hero = dock.heroTabId ? (state.tabs[dock.heroTabId] ?? null) : null
  const space = activeSpace(state)
  const bar = phoneBarHeight()
  const gutter = cssPx('--zen-padding', 8)
  const dir = dock.from === 'bottom' ? -1 : 1
  const { slot } = dock
  // Per frame only transforms move: the card slides, the ghost translates and scales in place.
  const dy = dock.progress * dock.travel * dir
  const scale = 1 + 0.04 * dock.lift
  const { style: pillStyle, ...pillHandlers } = pill
  return (
    <div className="pointer-events-none absolute inset-0 z-[35]" data-shell-chrome>
      {hero && area && (
        <div
          className="zen-stage-card absolute"
          style={{
            left: area.x,
            top: area.y,
            width: area.width,
            height: area.height,
            transform: `translate3d(0, ${contentShift(dock.from, dock.progress, bar, gutter)}px, 0)`
          }}
        >
          <TabPreview tab={hero} cover />
        </div>
      )}
      <div
        className="zen-phone-pill zen-pill-ghost pointer-events-auto absolute flex items-center gap-2 overflow-hidden rounded-full px-3.5 text-left"
        aria-hidden
        data-surface="window"
        data-lifted={dock.phase === 'lifted' || dock.phase === 'settling'}
        style={{
          ...pillStyle,
          left: slot.x,
          top: slot.y,
          width: slot.width,
          height: slot.height,
          transform: `translate3d(${dock.drift}px, ${dy}px, 0) scale(${scale})`
        }}
        {...pillHandlers}
      >
        <PillContent
          state={state}
          tab={hero ?? activeTab(state)}
          space={space}
          interactive={false}
        />
      </div>
    </div>
  )
}
