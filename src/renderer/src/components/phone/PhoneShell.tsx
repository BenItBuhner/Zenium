import type { CSSProperties, JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Globe, Languages, Lock, Search, VenetianMask } from 'lucide-react'
import { internalPageOf } from '@shared/internalPages'
import type { PhoneBarPosition, Space, Tab, UIState } from '@shared/types'
import { displayHost, isWebPageUrl } from '@shared/url'
import { chromeGutter } from '@renderer/hooks/useTheme'
import { run } from '@renderer/lib/api'
import { setBarHideContext, showBar } from '@renderer/lib/barHide'
import { extensionPageChrome } from '@renderer/lib/extensions/pages'
import {
  contentShift,
  cssPx,
  dismissDock,
  dockStore,
  phoneBandHeight
} from '@renderer/lib/gestures/dock'
import { closeOverview, overviewIsOpen, stageStore } from '@renderer/lib/gestures/stage'
import { closeSpacesDrawer } from '@renderer/lib/gestures/drawer'
import { barFade } from '@renderer/lib/motion/recede'
import { usePrivateSurface } from '@renderer/lib/privateSurface'
import { isPrivateTab } from '@renderer/lib/privateTabs'
import { activeSpace, activeTab } from '@renderer/lib/selectors'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import { barStateOf, isTranslating, translateStateOf } from '@renderer/lib/translate'
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
import { BlockedPopupsChip } from '../security/BlockedPopupsPanel'
import { Favicon } from '../sidebar/Favicon'
import { TabDialogs } from '../TabDialogs'
import { BlockedChip } from '../urlbar/BlockedChip'
import { PillChip } from '../urlbar/PillChip'
import { Urlbar } from '../urlbar/Urlbar'
import { BarButton } from './BarButton'
import { barContext, barLayout } from './barItems'
import { GroupStrip } from './GroupStrip'
import { PhoneStage } from './PhoneStage'
import { SpacesDrawer } from './SpacesDrawer'
import { TabPreview } from './TabPreview'
import { TabsQuickMenu } from './TabsQuickMenu'
import { useBarHold, type BarHoldHandlers } from './useBarHold'
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
      const translate = (e.target as HTMLElement).closest('[data-translate]')
      if (overviewIsOpen()) closeOverview()
      else if (tab && translate) {
        // The translation glyph at the end of the pill raises the bar, or puts it away.
        if (barStateOf(state, tab.id)) run('translate.dismiss', { tabId: tab.id })
        else run('translate.offer', { tabId: tab.id })
      } else if (tab && icon) {
        // The site icon at the start of the pill opens the site information instead.
        const r = icon.getBoundingClientRect()
        void openSiteInfo(tab, { x: r.left, y: r.top, width: r.width, height: r.height })
      } else void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, { attached: true })
    }
  })

  const barHidden = ui.urlbar.open
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
        className="relative flex min-h-0 flex-1 flex-col"
        style={{
          // The bar's edge reserves the bar band (the URL bar's field takes it over while the bar
          // is hidden); the other edge keeps the content gutter above the inset.
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
          On the bar's edge the box rides the bar as it hides (`--zen-bar-hide-shift`, per frame,
          like the bar itself), so a toast showing mid-gesture moves with the bar instead of
          jumping the band at the rest; at either rest it is the content column's edge. */}
      <div
        data-shell-chrome
        className="zen-message-frame pointer-events-none absolute z-[36]"
        style={{
          top: edgePadding('top', edge, barAway, true),
          bottom: edgePadding('bottom', edge, barAway, true),
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
          strip={strip}
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
          strip={strip}
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

/**
 * What the content column leaves free at `side`: the bar band on the bar's edge – the bar and,
 * while the active tab is grouped, the group strip (`--zen-phone-band`) – a gutter elsewhere,
 * and a gutter on the bar's edge too while the bar rests hidden off it (`barAway`). With
 * `perFrame` the bar's edge follows the bar's hide as it happens (`--zen-bar-hide-shift`,
 * lib/barHide.ts): the band less the shift, which is the band at the shown rest and the gutter
 * at the hidden one, the same two values, with every frame between – for a box that should
 * move with the bar rather than be laid out twice per hide, as the content column is.
 */
function edgePadding(
  side: PhoneBarPosition,
  barEdge: PhoneBarPosition,
  barAway = false,
  perFrame = false
): string {
  const inset = `var(--zen-inset-${side})`
  if (side === barEdge && perFrame)
    return `calc(${inset} + var(--zen-phone-band) - var(--zen-bar-hide-shift, 0px))`
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
  /** A preview of the bar at the other edge: drawn, never pressed. */
  inert?: boolean
  style?: CSSProperties
}): JSX.Element {
  const tab = activeTab(state)
  const space = activeSpace(state)
  const ctx = barContext(state, overviewOpen)
  const layout = barLayout(state)
  const inset = `var(--zen-inset-${edge})`
  const groupStrip = strip ? (
    <GroupStrip presence={strip} edge={edge} overviewOpen={overviewOpen} inert={inert} />
  ) : null

  return (
    <nav
      className={cn(
        'zen-phone-bar absolute z-30 flex flex-col px-2',
        edge === 'bottom' ? 'bottom-0' : 'top-0',
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
      </div>
      {edge === 'top' && groupStrip}
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
  // A page of an extension: the extension's name stands where the host would (as "Settings"
  // does for the internal page), its icon in the favicon slot, and no lock, shield or
  // translation chip – it is neither a secure site nor an insecure one, whatever origin the
  // Android runtime serves it from (§10.1 applied to extension pages, `extensionPageChrome`).
  const extension = shown ? extensionPageChrome(shown.url, state.extensions) : null
  // The site alone, as Chrome's omnibox shows it at rest: the path would only push it off the pill.
  const url = shown ? (extension ? extension.name : displayHost(shown.url)) : ''
  // No lock over a certificate that failed verification (the interstitial, or the page the user
  // proceeded to): the connection is not secure, as site information says.
  const secure = shown?.url.startsWith('https://') && !shown.certificateError && !extension
  // An internal page (Settings): its glyph in the favicon slot and the page's name, no lock and
  // no site-information chip – there is no site (v2 §10.1); the registry says which glyph.
  const page = shown ? internalPageOf(shown.url) !== null : false
  // Translation: the glyph is there once the page has been offered or translated (in the accent
  // while the translation shows), as on the desktop pill at rest; other pages keep the pill clear.
  const translation = shown && isWebPageUrl(shown.url) ? translateStateOf(state, shown.id) : null
  const translateBarUp = shown ? barStateOf(state, shown.id) !== null : false
  // The private marker: the mask glyph in the pill's leading slot on every private tab, page or
  // none, at the phone's 20 (v2 §9.19; Chrome's incognito toolbar glyph).
  const privateMark = shown ? isPrivateTab(shown) : false
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
          data-private-mark={privateMark || undefined}
          className="order-first -ml-1.5 -mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        >
          {privateMark ? (
            <VenetianMask className="h-5 w-5 shrink-0 opacity-60" strokeWidth={1.75} aria-hidden />
          ) : (
            <Favicon tab={shown} size={16} />
          )}
        </PillChip>
      ) : (
        <Search className="order-first h-4 w-4 shrink-0 opacity-60" />
      )}
      {/*
        The private marker (v2 §9.19): on a private tab the mask glyph takes the pill's leading
        slot in place of the favicon, page or none, the way Chrome's incognito toolbar carries its
        glyph; the slot stays the site-information chip, so site information opens from the mask
        as it does from a favicon. The pill carries no "Private" badge – the private theme on the
        whole window, the mask here, in the overview header and on the tab card say it, and a
        badge would cost the host its room on a phone; badges are for lists that mix private and
        normal items.
      */}
      {shown && !page && !extension && state.capabilities.requestBlocking && (
        <BlockedChip tab={shown} state={state} variant="phone" interactive={interactive} />
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
      {translation && (
        <Control
          {...controlProps}
          aria-label={
            interactive
              ? translateBarUp
                ? 'Hide the translation bar'
                : 'Translate this page'
              : undefined
          }
          data-translate
          className={cn(
            '-mx-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            isTranslating(translation) ? 'text-[var(--zen-accent)]' : 'opacity-50'
          )}
        >
          <Languages className="h-3.5 w-3.5" />
        </Control>
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
