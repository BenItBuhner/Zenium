import type { CSSProperties, JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { Globe, Search, VenetianMask } from 'lucide-react'
import { internalPageOf } from '@shared/internalPages'
import { securityIndicator } from '@shared/siteInfo'
import type { PhoneBarPosition, Space, Tab, UIState } from '@shared/types'
import { displayHost } from '@shared/url'
import { useBarHideBinding } from '@renderer/hooks/useBarHideBinding'
import { useOmniboxFocusBinding } from '@renderer/hooks/useOmniboxFocusBinding'
import { chromeGutter } from '@renderer/hooks/useTheme'
import { run } from '@renderer/lib/api'
import { setBarHideContext, showBar } from '@renderer/lib/barHide'
import { useConnectivityMessages } from '@renderer/lib/connectivityMessages'
import { extensionPageChrome } from '@renderer/lib/extensions/pages'
import {
  fakeboxAway,
  fakeboxHoldsChrome,
  fakeboxMorphStore,
  tapFakebox
} from '@renderer/lib/fakeboxMorph'
import {
  contentShift,
  cssPx,
  dismissDock,
  dockStore,
  phoneBandHeight
} from '@renderer/lib/gestures/dock'
import { closeOverview, overviewIsOpen, stageStore } from '@renderer/lib/gestures/stage'
import type { TabSwitchState } from '@renderer/lib/gestures/stage'
import { closeSpacesDrawer } from '@renderer/lib/gestures/drawer'
import { mediaSession } from '@renderer/lib/media'
import { barFade } from '@renderer/lib/motion/recede'
import { focusHoldsChrome, focusOmnibox, omniboxFocusStore } from '@renderer/lib/omniboxFocus'
import { useRecedeSurface } from '@renderer/hooks/useRecedeSurface'
import { isPdfViewerTab } from '@renderer/lib/pdfViewer'
import { openSettings } from '@renderer/lib/pages'
import { phoneAddressLabel } from '@renderer/lib/pillLabel'
import { privateLockStore, privateTabLocked, unlockPrivateTabs } from '@renderer/lib/privateLock'
import { usePrivateSurface } from '@renderer/lib/privateSurface'
import { isPrivateTab } from '@renderer/lib/privateTabs'
import { activeSpace, activeTab } from '@renderer/lib/selectors'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import {
  closeBarEditor,
  closeTabsMenu,
  contentAreaStore,
  dismissBanner,
  openBarEditor,
  openMediaSheet,
  openTabsMenu,
  overlayCoversContent,
  showBanner,
  uiStore,
  type UiState
} from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { ContentArea } from '../content/ContentArea'
import { MessageLayer } from '../messages/MessageLayer'
import { FakeboxMorphLayer } from '../newtab/FakeboxMorphLayer'
import { Onboarding } from '../overlays/Onboarding'
import { BlockedPopupsChip } from '../security/BlockedPopupsPanel'
import { Favicon } from '../sidebar/Favicon'
import { TabDialogs } from '../TabDialogs'
import { PillChip } from '../urlbar/PillChip'
import { Urlbar } from '../urlbar/Urlbar'
import { BarButton } from './BarButton'
import { barContext, barLayout } from './barItems'
import { GroupStrip } from './GroupStrip'
import { ChipRun, phonePillChips, pillChipsDrawn, pillChipsSpoken } from './pillChips'
import { PhoneStage } from './PhoneStage'
import { SpacesDrawer } from './SpacesDrawer'
import { TabPreview } from './TabPreview'
import { TabsQuickMenu } from './TabsQuickMenu'
import { useBarHold, type BarHoldHandlers } from './useBarHold'
import { useFullscreenReturn } from './useFullscreenReturn'
import { useGestureHint } from './useGestureHint'
import { useGroupStrip, type GroupStripPresence } from './useGroupStrip'
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
  // The window surfaces are on the private theme (blending to it): a private tab is in view, or
  // the overview shows the private pane (§9.29; MOT-14).
  const privateSurface = usePrivateSurface(state)

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

  // The device offline: "No internet connection" in the banner stack; back: a "Back online" toast (ERR-07).
  useConnectivityMessages(state.network.online)

  // A hold on the Tabs button: its quick menu, anchored to the button; on Home, the homepage
  // setting (TB-15: Chrome's long-press on its Home button); any other hold, the editor.
  const hold = useBarHold({
    onHold: (item, rect) => {
      if (item === 'tabs') void openTabsMenu(rect, activeTabId)
      else if (item === 'home') openSettings('look')
      else void openBarEditor(activeTabId)
    }
  })

  const pill = usePillGestures({
    edge,
    onTap: (e) => {
      const icon = (e.target as HTMLElement).closest('[data-site-info]')
      const media = (e.target as HTMLElement).closest('[data-media]')
      const session = media ? mediaSession(state) : null
      if (overviewIsOpen()) closeOverview()
      else if (tab && privateTabLocked(state)) {
        // The pill over a locked private tab says nothing of the page and opens nothing of it
        // (the omnibox would show its address): a tap asks for the screen lock, as the cover's
        // Unlock does (INC-05).
        void unlockPrivateTabs()
      }
      // The new tab page's field is the address control while the pill's slot is its well
      // (NTP-02): a tap on the well is a tap on the field, which morphs into the omnibox. The
      // well's chips are inert (main.css `.zen-pill-away > *`), so none is under the finger here.
      else if (fakeboxAway()) tapFakebox()
      else if (session) {
        // The Now playing chip opens the in-app player for the tab the OS controls show (MW-16),
        // over a picture of the tab on screen.
        void openMediaSheet(session.tabId, activeTabId)
      } else if (tab && icon) {
        // The site icon at the start of the pill and the lock after the host open the site
        // information instead – where the translate offer and the blocking shield are (OMN-02).
        const r = icon.getBoundingClientRect()
        void openSiteInfo(tab, { x: r.left, y: r.top, width: r.width, height: r.height })
      } else {
        // The pill grows into the omnibox's field as the bar's buttons are pushed off (MOT-07,
        // lib/omniboxFocus.ts): the bar opens under the field on its way.
        focusOmnibox(tab?.id ?? null)
      }
    }
  })

  const barHidden = ui.urlbar.open
  // The new tab page's field on its way to or from the omnibox (NTP-02, lib/fakeboxMorph.ts):
  // the bar stays mounted under the arriving sheet, fading on the morph's value (main.css), so
  // the field is seen to leave it and to come back to it; the pill's slot is the field's well
  // while the field is the page's. The pill growing into the field (MOT-07,
  // lib/omniboxFocus.ts) holds it the same way, its buttons pushed off and back on the value.
  const morph = fakeboxMorphStore.use()
  const focus = omniboxFocusStore.use()
  const barUp = !barHidden || fakeboxHoldsChrome(morph) || focusHoldsChrome(focus)
  // The tab group strip (TAB-14): present while the active tab is grouped, and on its way out for
  // a moment after it leaves; its share of the bar band is published by the hook.
  const strip = useGroupStrip(state)
  // The bar hides on scroll (lib/barHide.ts) only while this shell shows it: the machine hears
  // where it is docked and how far it has to go – the band minus the gutter the page keeps. The
  // band is the row and the group strip together (`phoneBandHeight`, #202's `--zen-phone-band`),
  // read again at each end of the strip's stay, once the hook has written the strip's share to
  // the root (its layout effect runs before this one): a bar off its edge keeps its ratio across
  // the change, so a hidden bar takes the strip off with it and a shown one gains the strip. The
  // gutter is the theme's rule (`chromeGutter`), not the root's `--zen-padding`: the theme writes
  // that from the app's effect, which runs after this one on the first mount, and the stylesheet's
  // default it leaves until then is the desktop's – a travel read off it would be 2 px short of
  // the distance the stylesheet and the content column move the bar and the page by.
  const stripUp = strip !== null
  const borderless = state.settings.borderless || state.window.fullscreen
  useEffect(() => {
    setBarHideContext({
      edge,
      present: !htmlFullscreen && !onboarding,
      band: phoneBandHeight(),
      gutter: chromeGutter('phone', borderless)
    })
  }, [edge, htmlFullscreen, onboarding, stripUp, borderless])
  useEffect(() => () => setBarHideContext({ present: false }), [])
  // Back from a page's fullscreen (MED-01) the chrome – bar, pill and frame – fades in over
  // 120 ms, opacity alone, once the page's view has landed (`lib/fullscreenLanding.ts`).
  const windowRef = useRef<HTMLDivElement | null>(null)
  useFullscreenReturn(windowRef, state.window.htmlFullscreenTabId)
  // The message layer sits on the frame's edges and recedes with it (main.css reads
  // `--zen-recede` on it).
  const messageFrameRef = useRef<HTMLDivElement>(null)
  useRecedeSurface(messageFrameRef)
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
  // The bar has hidden on scroll and rests off its edge: the content column takes the band. In
  // between the host moves the page's edge frame by frame (`--zen-bar-hide`); the column changes
  // only at the two rests, so the page is laid out twice per hide, never per frame.
  const barAway = ui.barHidden && !barHidden
  // `overflow: clip`, not `hidden`: a hidden bar is translated past the window's edge and would
  // make a hidden-overflow window scrollable by script, so accessibility focus landing on the
  // pill (TalkBack, or the demo's focus action) would scroll the whole chrome to reach it and
  // drag the page's reported frame along. A clipped window cannot scroll; the bar comes back
  // through `showBar` instead.
  return (
    <div
      ref={windowRef}
      className="zen-window relative flex h-full w-full flex-col overflow-clip"
      data-dark={isDark}
      data-private={privateSurface || undefined}
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
        className="zen-content-column relative flex min-h-0 flex-1 flex-col"
        style={{
          // The bar's edge reserves the bar band (the URL bar's field takes it over while the bar
          // is hidden); the other edge keeps the content gutter above the inset. Laid out, never
          // transitioned (under reduced motion main.css removes every transition rather than
          // shortening one): the content frame is measured the moment the edge changes
          // (`useLayoutReporter`).
          paddingTop: edgePadding('top', edge, barAway),
          paddingBottom: edgePadding('bottom', edge, barAway),
          paddingLeft: 'var(--zen-padding)',
          paddingRight: 'var(--zen-padding)'
        }}
      >
        <div className="relative min-h-0 flex-1">
          <ContentArea state={state} ui={ui} />
        </div>
        {!barHidden && tab && (
          <BlockedPopupsChip
            state={state}
            tabId={tab.id}
            className={edge === 'top' ? 'order-first' : ''}
          />
        )}
      </main>
      {/* Messages sit on the content frame's box, over the bar and the stage but under sheets.
          Its box is the stylesheet's, by the bar's edge (`data-edge`) and the root's
          `data-bar-away` (lib/barHide.ts): the content column's edge at either rest, the page's
          tall box for the whole of a hide gesture, with the cards on the bar's edge riding the
          bar by transform – so a toast showing mid-gesture moves with the bar instead of jumping
          the band at the rest, and nothing in the frame is laid out per frame (main.css). */}
      <div
        ref={messageFrameRef}
        data-shell-chrome
        data-edge={edge}
        className="zen-message-frame pointer-events-none absolute z-[36]"
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
      {barUp && (
        <PhoneBar
          state={state}
          edge={edge}
          pill={pill}
          hold={hold}
          strip={strip}
          overviewOpen={overviewOpen}
          pillLook={dock.phase === 'idle' ? 'docked' : 'well'}
          pillAway={morph.away}
          style={fromHere ? { opacity: barFade(edge, 1 - p) } : undefined}
        />
      )}
      {!barHidden && fromHere && (
        // The slot the pill is heading for, revealed as the page slides out of its way.
        <PhoneBar
          state={state}
          edge={dock.from === 'bottom' ? 'top' : 'bottom'}
          pill={pill}
          strip={strip}
          overviewOpen={overviewOpen}
          pillLook={p >= 0.5 ? 'well-target' : 'well'}
          inert
          style={{ opacity: barFade(dock.from === 'bottom' ? 'top' : 'bottom', p) }}
        />
      )}
      {barHidden && <Urlbar state={state} urlbar={ui.urlbar} area={null} phoneEdge={edge} />}
      <FakeboxMorphLayer />
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

/**
 * What the content column leaves free at `side`: the bar band on the bar's edge – the bar and,
 * while the active tab is grouped, the group strip (`--zen-phone-band`) – a gutter elsewhere,
 * and a gutter on the bar's edge too while the bar rests hidden off it (`barAway`). The two
 * values are the two rests of the hide (lib/barHide.ts); nothing here follows the bar per
 * frame – the page's edge does that on the host, the message frame's cards by transform.
 */
function edgePadding(side: PhoneBarPosition, barEdge: PhoneBarPosition, barAway = false): string {
  const inset = `var(--zen-inset-${side})`
  return side === barEdge && !barAway
    ? `calc(${inset} + var(--zen-phone-band))`
    : `calc(${inset} + var(--zen-padding))`
}

type PillLook = 'docked' | 'well' | 'well-target'

/**
 * The bar docked at `edge`: the controls of `settings.phoneBar` either side of the address pill
 * (by default back · pill · new tab · tabs · menu). The pill is the gesture anchor: swipe it
 * sideways to move to the previous / next tab (the neighbour's card follows the finger), pull it
 * towards the middle of the screen for the tab overview, tap it for the URL bar, hold it to
 * carry the whole bar to the other edge. A hold anywhere else on the bar's row opens the editor
 * that rearranges it (on the Tabs button, its quick menu). Window chrome (v2 §9.29): the bar and
 * the pill carry `data-surface="window"`, so their chips draw in the window family.
 *
 * The bar is a band of up to two rows: the row of controls at the edge and, while the active tab
 * is in a group, the group strip (TAB-14) on the row's inner side – above a bottom-docked row,
 * below a top-docked one. The strip is the row's sibling, so a touch on its chips never reaches
 * the pill's recogniser or the row's hold; whatever translates the bar (a carry's fade today, a
 * hide-on-scroll offset on `.zen-phone-bar` tomorrow) moves the strip with it.
 */
export function PhoneBar({
  state,
  edge,
  pill,
  hold,
  strip,
  overviewOpen,
  pillLook,
  pillAway,
  inert,
  style
}: {
  state: UIState
  edge: PhoneBarPosition
  pill: PillGestureHandlers
  hold?: BarHoldHandlers
  /** The group strip's presence (`useGroupStrip`): the strip is drawn while there is one. */
  strip?: GroupStripPresence | null
  overviewOpen: boolean
  /** The pill in place, or the empty slot it left (highlighted when it is about to land here). */
  pillLook: PillLook
  /**
   * The new tab page's field is the address control (NTP-02, lib/fakeboxMorph.ts): the pill's
   * slot is the well the field left, its own look and words filling in by `--zen-ntp-pill` as the
   * page's scroll carries the field into it. The slot still takes the pill's gestures.
   */
  pillAway?: boolean
  /** A preview of the bar at the other edge: drawn, never pressed. */
  inert?: boolean
  style?: CSSProperties
}): JSX.Element {
  const tab = activeTab(state)
  const space = activeSpace(state)
  const ctx = barContext(state, overviewOpen)
  const layout = barLayout(state)
  const inset = `var(--zen-inset-${edge})`
  // Docked at the bottom edge the bar fades on the page's recede (main.css reads `--zen-recede`
  // on it, §11.1); the top-docked bar registers too and its rule ignores the value.
  const barRef = useRef<HTMLElement>(null)
  useRecedeSurface(barRef)
  const groupStrip = strip ? (
    <GroupStrip presence={strip} edge={edge} overviewOpen={overviewOpen} inert={inert} />
  ) : null
  // The bar that hides on scroll writes its progress on this element per frame (lib/barHide.ts);
  // the preview of the bar at the other edge, drawn during a carry, does not hide.
  const bindHide = useBarHideBinding(!inert)
  // The pill's focus motion writes its value here per frame too (lib/omniboxFocus.ts): the
  // buttons and the pill under this element read it, so the frame recalculates the bar alone.
  const bindFocus = useOmniboxFocusBinding()
  // One ref for the three: the recede's registration reads the element off `barRef` in its
  // layout effect, the two bindings take the element as it mounts and unmounts.
  const setBar = useCallback(
    (el: HTMLElement | null) => {
      barRef.current = el
      bindHide(el)
      bindFocus(el)
    },
    [bindHide, bindFocus]
  )

  return (
    // The clip box (main.css `zen-phone-bar-clip`): from the inset line to the window's far
    // edge, clipping its overflow and never moving, so a bar slid off its edge by the hide is cut
    // at the inset line and the bar's frame is its transform alone. The bar hangs its inset
    // padding past the box's edge to sit where it always did.
    <div className="zen-phone-bar-clip" data-edge={edge}>
      <nav
        ref={setBar}
        className={cn(
          'zen-phone-bar absolute z-30 flex flex-col px-2',
          // While the pill is being carried the other buttons are on their way out too.
          pillLook !== 'docked' && 'zen-phone-bar-lifted',
          inert && 'pointer-events-none'
        )}
        // Window chrome: the bar, the pill and their chips draw in the window family (v2 §9.29).
        data-surface="window"
        // The edge it is docked at: main.css fades the bottom-docked bar with a sheet (§11.1) and
        // slides it off by `--zen-bar-hide` as the page scrolls (lib/barHide.ts).
        data-edge={edge}
        aria-hidden={inert || undefined}
        data-shell-chrome
        // A hidden bar stays in the accessibility tree: TalkBack focus landing on it (the pill,
        // a button) brings it back, as does keyboard focus.
        onFocus={inert ? undefined : showBar}
        style={{
          ...style,
          left: 'var(--zen-inset-left)',
          right: 'var(--zen-inset-right)',
          ...(edge === 'bottom'
            ? { bottom: `calc(-1 * ${inset})` }
            : { top: `calc(-1 * ${inset})` }),
          paddingTop: edge === 'top' ? `calc(${inset} + 6px)` : 6,
          paddingBottom: edge === 'bottom' ? `calc(${inset} + 6px)` : 6
        }}
      >
        {edge === 'bottom' && groupStrip}
        <div className="zen-phone-bar-row flex items-center gap-1" {...(inert ? {} : hold)}>
          {layout.left.map((id) => (
            <BarButton key={id} id={id} ctx={ctx} inert={inert} />
          ))}
          {/*
          The pill is a gesture surface, not a button: its site icon, address and lock are real
          buttons inside it, so TalkBack gets a node for each (a button's descendants would all
          collapse into one). Taps are told apart in onTap by what was under the finger. The
          surface itself carries no role and no name: a named container that takes clicks is a
          TalkBack stop of its own ("Address") before the field inside it says the same and more
          (#108's follow-up, A11Y-01), and nothing in it but its buttons may speak (the space
          label is hidden from the tree, the address button says the space instead).
        */}
          <div
            className={cn(
              'zen-phone-pill flex h-11 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-full px-3.5 text-left',
              // The resting pill's fill and pressed fill are the window family's (§9.29; main.css);
              // while the field is the page's, the pill is the well the field left (lib/fakeboxMorph.ts).
              pillLook === 'docked' && !pillAway && 'zen-phone-pill-docked',
              (pillLook !== 'docked' || pillAway) && 'zen-pill-well',
              pillLook === 'docked' && pillAway && 'zen-pill-away',
              pillLook === 'well-target' && 'zen-pill-well-target'
            )}
            data-surface="window"
            {...(inert ? {} : pill)}
          >
            {pillLook === 'docked' && (
              <PillContent
                state={state}
                tab={tab}
                space={space}
                interactive={!inert && !pillAway}
              />
            )}
          </div>
          {layout.right.map((id) => (
            <BarButton key={id} id={id} ctx={ctx} inert={inert} />
          ))}
        </div>
        {edge === 'top' && groupStrip}
      </nav>
    </div>
  )
}

/**
 * The pill label's slide with the tab track: up to 16 px either way, towards the nearest card,
 * in whole pixels. The empty string at rest, so the element carries no transform then.
 */
function pillLabelShift(tabs: TabSwitchState): string {
  if (tabs.phase === 'idle') return ''
  const shift = Math.round((Math.round(tabs.position) - tabs.position) * 16)
  return shift ? `translateX(${shift}px)` : ''
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
  // The label's slide with the cards is written to the element as the track moves, not
  // rendered: a swipe would otherwise render the whole pill at every pixel of the slide
  // (PERF-5's profile); the render gives a freshly mounted label its first offset.
  const label = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const apply = (): void => {
      if (label.current) label.current.style.transform = pillLabelShift(stageStore.get().tabs)
    }
    apply()
    return stageStore.subscribe(apply)
  }, [])
  const siteInfoOpen = uiStore.use((s) => s.siteInfoOpen)
  const shown = (underFinger && state.tabs[underFinger]) || tab
  // A page of an extension: the extension's name stands where the host would (as "Settings"
  // does for the internal page), its icon in the favicon slot, and no lock, shield or
  // translation chip – it is neither a secure site nor an insecure one, whatever origin the
  // Android runtime serves it from (§10.1 applied to extension pages, `extensionPageChrome`).
  const extension = shown ? extensionPageChrome(shown.url, state.extensions) : null
  // A private tab under the lock (INC-05): the pill says nothing of its page – no address, no
  // lock, no shield, no translation glyph – only that it is a private tab, behind the mask; the
  // whole pill asks for the screen lock when tapped (the shell's onTap).
  const locked = privateLockStore.use((s) => s.locked) && shown !== null && isPrivateTab(shown)
  // The site alone, as Chrome's omnibox shows it at rest: the path would only push it off the
  // pill. The PDF viewer page reads as its document (the file's name, then the title the
  // document names), the way Chrome's tab does; there is no site to show.
  const url =
    shown && !locked
      ? extension
        ? extension.name
        : isPdfViewerTab(state, shown.id) && shown.title
          ? shown.title
          : displayHost(shown.url)
      : ''
  // An internal page (Settings): its glyph in the favicon slot and the page's name, no lock and
  // no site-information chip – there is no site (v2 §10.1); the registry says which glyph.
  const page = shown ? internalPageOf(shown.url) !== null : false
  // The private marker: the mask glyph in the pill's leading slot on every private tab, page or
  // none, at the phone's 20 (v2 §9.19; Chrome's incognito toolbar glyph).
  const privateMark = shown ? isPrivateTab(shown) : false
  const mediaSheetOpen = uiStore.use((s) => s.mediaSheet !== null)
  // The chips after the address as data (`phonePillChips`): the lock, the blocking shield with
  // its count, a translate offer, the Now playing chip (MW-16). At rest the pill draws the
  // favicon, the host and the lock alone – v2 §9.29 as amended on Bennett's ruling (OMN-02):
  // the shield and the translate offer are the site-information sheet's rows, always, and a
  // transient state chip (media) takes the lock's slot while its state is live, the lock
  // returning when it ends (`lib/pillChips.ts`). The favicon ahead of the host and the lock
  // both open the sheet the others went into; the favicon alone while a state has the slot.
  const chips = phonePillChips(state, shown, {
    siteInfoOpen,
    mediaSheetOpen,
    activeTabId: tab?.id ?? null,
    locked
  })
  const drawn = pillChipsDrawn(chips)
  // What TalkBack hears at the address, the pill's one stop (`phoneAddressLabel`): the host,
  // the connection's state as the core derives it (`securityIndicator`; spoken here even while
  // the pill draws no lock, A11Y-01), then the states of the chips the sheet carries, in the
  // pill's order ("Address, github.com, Connection is secure, 5 requests blocked, Translation
  // offered") – the states themselves rather than a count, so the stop tells what the sheet
  // would show; a quiet page (nothing blocked yet, no offer) adds nothing – then the space,
  // when there is more than one.
  const indicator = shown
    ? securityIndicator(shown.url, shown.errorCode ?? null, shown.certificateError ?? null)
    : null
  const spaceName = state.spaces.length > 1 ? space.name : null
  const addressLabel = phoneAddressLabel(url, indicator, spaceName, pillChipsSpoken(chips))
  const Control = interactive ? 'button' : 'span'
  const controlProps = interactive ? { type: 'button' as const } : {}
  // The leading glyph, drawn ahead of the address with `order-first`. The chips are §9.3's
  // 44 × 44 boxes over the glyph positions the pill has always had, the negative margins
  // carrying the difference (#237), so only the targets grew.
  const anchor =
    shown && page ? (
      <span
        className="order-first -ml-1.5 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <Favicon tab={shown} size={16} />
      </span>
    ) : shown && locked ? (
      // Under the lock the slot is the mask alone – no site-information control announced for
      // a page nothing may be read of; the pill's tap asks for the screen lock (INC-05).
      <span
        className="order-first -ml-1.5 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center"
        data-private-mark=""
        aria-hidden="true"
      >
        <VenetianMask className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
      </span>
    ) : shown ? (
      <PillChip
        inert={!interactive}
        label="Site information"
        popup="dialog"
        expanded={siteInfoOpen}
        data-site-info
        data-private-mark={privateMark || undefined}
        className="order-first -ml-3 -mr-3.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
      >
        {privateMark ? (
          // Identity, like the favicon it stands in for: the full window ink (§9.19, §9.29), not
          // a deemphasised state.
          <VenetianMask className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
        ) : (
          <Favicon tab={shown} size={16} />
        )}
      </PillChip>
    ) : (
      <Search className="order-first h-4 w-4 shrink-0 opacity-60" />
    )
  return (
    <span
      key={shown?.id ?? 'empty'}
      ref={label}
      className="zen-animate-fade flex h-full min-w-0 flex-1 items-center gap-2"
      style={{ transform: pillLabelShift(stageStore.get().tabs) || undefined }}
    >
      <Control
        {...controlProps}
        className="flex h-full min-w-0 flex-1 items-center text-left"
        aria-label={
          interactive ? (locked ? 'Private tab locked, unlock' : addressLabel) : undefined
        }
        data-testid="pill-address"
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[14px]',
            !url && !locked && 'text-[var(--zen-muted)]'
          )}
          data-private-locked={locked || undefined}
          data-testid="pill-host"
        >
          {locked ? 'Private tab' : url || 'Search or enter address'}
        </span>
      </Control>
      {anchor}
      {/*
        The private marker (v2 §9.19): on a private tab the mask glyph takes the pill's leading
        slot in place of the favicon, page or none, the way Chrome's incognito toolbar carries its
        glyph; the slot stays the site-information chip, so site information opens from the mask
        as it does from a favicon. The pill carries no "Private" badge – the private theme on the
        whole window, the mask here, in the overview header and on the tab card say it, and a
        badge would cost the host its room on a phone; badges are for lists that mix private and
        normal items.
      */}
      {/*
        Nothing after the chips (§9.29, Bennett's rule: the favicon or mask, the host and one
        glyph): the space is told by the window's own colour and said by the address for TalkBack
        (`spaceName`); the 11 px label that used to trail here was off §4's scale and a fourth
        thing in the pill.
      */}
      <ChipRun chips={drawn} interactive={interactive} />
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
  // The page slides by the band it leaves free at the bar's edge: the row plus the group strip.
  const bar = phoneBandHeight()
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
