import type { UIState } from '@shared/types'
import { isEmptyTabUrl, isInternalUrl } from '@shared/url'
import { KEYBOARD_INSET_MIN } from '@renderer/lib/barHide'
import { isPrivateTab } from '@renderer/lib/privateTabs'
import { pullStore, type PullState } from '@renderer/lib/pull'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore, overlayCoversContent, uiStore, type UiState } from '@renderer/lib/ui'

/**
 * What the Android host tells the band's model about the chrome around the page (motion spec
 * §3.2's never-on and waits rules, read on this side of the seam): the page in front, what kind
 * of page it is, and what stands between it and the user. Pure over the stores' states, so a
 * test hands it states and the chrome's instance reads the stores ({@link bandSignals}).
 */
export interface BandSignals {
  /** The tab in front, or null when none is (no band without a page). */
  tabId: string | null
  /**
   * The page in front is a web document. Never a band on the new tab page or a `zen://` page:
   * the install and reader offers do not arise there, and a state (offline) has the page's own
   * error to speak for it.
   */
  webPage: boolean
  /** The tab in front is private: its offers are withheld (§3.2); states still show. */
  privateTab: boolean
  /**
   * A sheet, dialog, menu or other overlay stands over the page: the band WAITS (its clock
   * paused, its show held back) until the page is in front again (§3.2).
   */
  covered: boolean
  /** The keyboard is up over the page's own field (the chrome's fields count as `covered`). */
  keyboardUp: boolean
  /** A pull-to-refresh has the page: one source of the offset at a time (§3.4 Android). */
  pulling: boolean
}

/** The signals for a given state of the chrome. */
export function readBandSignals(state: UIState | null, ui: UiState, pull: PullState): BandSignals {
  const tab = state ? activeTab(state) : null
  const url = tab?.url ?? ''
  return {
    tabId: tab?.id ?? null,
    webPage: tab !== null && !isEmptyTabUrl(url) && !isInternalUrl(url),
    privateTab: tab !== null && isPrivateTab(tab),
    covered: overlayCoversContent(ui) || ui.frameDialogsOpen > 0 || ui.frameDialogCover > 0,
    keyboardUp: ui.insets.bottom >= KEYBOARD_INSET_MIN,
    pulling: pull.phase !== 'idle'
  }
}

/**
 * The page is in front and free: a band may show (an offer's clock runs). Offers need a web page
 * that is not private; states need a page that is in front.
 */
export function bandMayShow(signals: BandSignals, form: 'offer' | 'state'): boolean {
  if (signals.tabId === null || !signals.webPage) return false
  if (signals.covered || signals.keyboardUp || signals.pulling) return false
  return form === 'state' || !signals.privateTab
}

/** The chrome's own signals right now. */
export function bandSignals(): BandSignals {
  return readBandSignals(browserStore.get().state, uiStore.get(), pullStore.get())
}

/**
 * Hear every change of the signals (the stores publish at rest – no per-frame work here);
 * `listener` runs once at once with the current reading. Returns the unsubscribe.
 */
export function subscribeBandSignals(listener: (signals: BandSignals) => void): () => void {
  let last = bandSignals()
  listener(last)
  const check = (): void => {
    const next = bandSignals()
    if (
      next.tabId === last.tabId &&
      next.webPage === last.webPage &&
      next.privateTab === last.privateTab &&
      next.covered === last.covered &&
      next.keyboardUp === last.keyboardUp &&
      next.pulling === last.pulling
    )
      return
    last = next
    listener(next)
  }
  const offs = [browserStore.subscribe(check), uiStore.subscribe(check), pullStore.subscribe(check)]
  return () => {
    for (const off of offs) off()
  }
}
