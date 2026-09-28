import { useEffect, useRef, useState } from 'react'
import type { PhoneBarPosition, UIState } from '@shared/types'
import { onBarScrollStart, touchExplorationOn } from '@renderer/lib/barHide'
import {
  armIph,
  dismissHintBubble,
  forgetHintBubble,
  hintBubbleStore,
  markTabSwitcherHintShown,
  showHintBubble,
  spendIphSession,
  stampTabSwitcherHint,
  TAB_SWITCHER_HINT_ACCESSIBILITY_TEXT,
  TAB_SWITCHER_HINT_TEXT,
  tabSwitcherHintDue
} from '@renderer/lib/iph'
import { isPrivateTab } from '@renderer/lib/privateTabs'
import { activeTab } from '@renderer/lib/selectors'
import { uiStore, type Insets } from '@renderer/lib/ui'

/** The Tabs button of the live bar (never the inert preview a carry draws): the bubble's anchor. */
export const TAB_SWITCHER_ANCHOR =
  'nav.zen-phone-bar:not([aria-hidden="true"]) [data-bar-item="tabs"]'

/**
 * The tab switcher's in-product help (TB-19): Chrome 152's one toolbar bubble that is on by
 * default – "Open tabs to visit different pages at the same time" on the tab switcher button,
 * `IPH_TabSwitcherButton` (`ToggleTabStackButtonCoordinator.handlePageLoadFinished`, l.361–418),
 * under the feature engagement rules `lib/iph.ts` restates on one device-local record.
 *
 * When: after a page has loaded, the chrome calm (the shell's term – no sheet, dialog, menu or
 * omnibox, no overview, no drag, no prompt; a page in view; the bar in place), the bubble
 * available 14 days, the session's one education unspent, the bar showing a Tabs button (Chrome
 * returns early when the button is not shown, l.363), never in a private tab. The arm: one
 * deferred flag after the first paint (`armIph`, ≥ 2 s and an idle moment), and the record's
 * first stamp – the one write at arm time – both P0's; nothing here runs at boot.
 *
 * How it goes down: Chrome's bubble dismisses on the first touch anywhere and the touch goes on
 * to whatever is under it (`AnchoredPopupWindow.onTouch`, l.1100–1126, over a popup that is not
 * focusable and so not touch-modal; a tap on the Tabs button opens the switcher and takes the
 * bubble down in one), on a change of the screen's size (`dismissOnScreenSizeChange`), and with
 * its anchor. Here: a `pointerdown` anywhere on the chrome, heard in the capture phase and not
 * swallowed; the host's word of a finger landing on the page (`onBarScrollStart`); the moment
 * changing – the chrome no longer calm, another tab, a navigation starting, the bar's edge or
 * the insets changing (rotation, the keyboard), the bar hiding, a message card arriving on the
 * edge; and the shell leaving. No clock (Chrome's `NO_TIMEOUT`).
 */
export function useTabSwitcherHint(state: UIState, edge: PhoneBarPosition, calm: boolean): void {
  const [armed, setArmed] = useState(false)
  useEffect(() => armIph(() => setArmed(true)), [])

  const tab = activeTab(state)
  const tabId = tab?.id ?? null
  const loading = tab?.loading ?? true
  const privateTab = tab ? isPrivateTab(tab) : false
  const { onboardingDone } = state.settings
  const { availableAt, shown } = state.settings.iph.tabSwitcher

  const cardsUp = uiStore.use(
    (s) => s.toasts.length > 0 || s.banners.length > 0 || s.screenshotCards.length > 0
  )
  const insets = uiStore.use((s) => s.insets)
  const barHidden = uiStore.use((s) => s.barHidden)

  // The record's first stamp, once the arm has run: the availability clock starts with the
  // phone chrome's first calm-enough moment, whether or not the first run is over yet.
  const stamped = useRef(false)
  useEffect(() => {
    if (!armed || stamped.current || availableAt !== null || shown) return
    const settings = { iph: { tabSwitcher: { availableAt, shown } } }
    stamped.current = stampTabSwitcherHint(settings, Date.now())
  }, [armed, availableAt, shown])

  // Due → up. The moment between the write and the core's echo of `shown` is covered by the
  // session, spent as the bubble goes up: `tabSwitcherHintDue` reads it (so the preview host,
  // which re-arms the bubble for a still, resets both the record and the session).
  const moment = useRef<{ tabId: string | null; edge: PhoneBarPosition; insets: Insets } | null>(
    null
  )
  useEffect(() => {
    if (hintBubbleStore.get().bubble || cardsUp || barHidden) return
    const settings = { onboardingDone, iph: { tabSwitcher: { availableAt, shown } } }
    const due = tabSwitcherHintDue({
      settings,
      now: Date.now(),
      armed,
      calm,
      pageLoaded: !loading,
      privateTab
    })
    if (!due) return
    const anchor = document.querySelector<HTMLElement>(TAB_SWITCHER_ANCHOR)
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    moment.current = { tabId, edge, insets }
    spendIphSession()
    showHintBubble({
      id: 'tabSwitcher',
      anchorItem: 'tabs',
      anchor: { x: r.left, y: r.top, width: r.width, height: r.height },
      edge,
      // Under touch exploration the status text is Chrome's accessibility variant
      // (`IDS_IPH_TAB_SWITCHER_ACCESSIBILITY_TEXT`, `android_chrome_strings.grd` l.6189–6191).
      text: touchExplorationOn() ? TAB_SWITCHER_HINT_ACCESSIBILITY_TEXT : TAB_SWITCHER_HINT_TEXT
    })
    markTabSwitcherHintShown(settings)
  }, [
    armed,
    calm,
    tabId,
    loading,
    privateTab,
    onboardingDone,
    availableAt,
    shown,
    edge,
    cardsUp,
    barHidden,
    insets
  ])

  // The moment changing under a bubble that is up takes it down.
  const up = hintBubbleStore.use((s) => s.bubble !== null && !s.leaving)
  useEffect(() => {
    if (!up) return
    const at = moment.current
    const moved = at !== null && (at.tabId !== tabId || at.edge !== edge || at.insets !== insets)
    if (!calm || loading || cardsUp || barHidden || moved) dismissHintBubble()
  }, [up, calm, loading, tabId, edge, insets, cardsUp, barHidden])

  // A touch anywhere: on the chrome, or on the page – the host reports a finger's down on the
  // page whatever the hide-on-scroll setting (`BarHideGesture.reports`), as Chrome's bubble takes
  // the `ACTION_OUTSIDE` a page touch delivers to it.
  useEffect(() => {
    if (!up) return
    const down = (): void => dismissHintBubble()
    document.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('resize', down)
    const offScroll = onBarScrollStart(down)
    return () => {
      document.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('resize', down)
      offScroll()
    }
  }, [up])

  // The shell leaving (rotation into the tablet layout, DeX) takes the bubble with it.
  useEffect(() => () => forgetHintBubble(), [])
}
