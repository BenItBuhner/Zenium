import { isChromePageUrl } from '@shared/internalPages'
import type { UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import { isBandPageUrl, type BandFrame } from '@renderer/lib/band'
import { KEYBOARD_INSET_MIN } from '@renderer/lib/barHide'
import { isPhone, viewportStore } from '@renderer/lib/formFactor'
import { overviewIsOpen, stageStore } from '@renderer/lib/gestures/stage'
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
   * The page in front is a PAGE to the band (`isBandPageUrl`, §10 – the model's allow-list, one
   * rule on both hosts): an offer may stand on it. Never an offer on the new tab page, the blank
   * page or any `zen://`, `about:`, `chrome://` or `devtools://` page: the install and reader
   * offers do not arise there.
   */
  page: boolean
  /**
   * The page in front is a DOCUMENT in the tab's own view – one the pull channel moves: a web
   * page, or a served `zen://` document (the tablet's `zen://newtab`, `zen://error`, `zen://pdf`,
   * `zen://version`, `zen://game`, `zen://reader`). A state stands on it (§10). False on a page
   * the chrome draws itself – a `render: 'chrome'` page (Settings, History, …) and the phone's
   * new tab page over `zen://blank` – which has no view under it for the band to make room with:
   * there the band WAITS (the Design Lead's (B) on #735's question (8)); the state holds and
   * returns on the next document. `PageBandLayer` on Android is the follow-up that lifts this.
   */
  document: boolean
  /** The tab in front is private: its offers are withheld (§3.2); states still show. */
  privateTab: boolean
  /**
   * A sheet, dialog, menu or other overlay stands over the page, or the tab overview is open: a
   * prompt arriving WAITS for it to go; the one standing already stays (§3.2 – the model's
   * `covered`). The overview counts from its first dragging frame to its close (the Design
   * Lead's ruling on #731's still 09, a banner over the overview's header): `ui.stageActive`
   * joins only once the hero card's capture is in, and a band arriving in that gap would hold
   * the page under the overview and be standing when it closed.
   */
  covered: boolean
  /** The keyboard is up over the page's own field (the chrome's fields count as `covered`): a cover too. */
  keyboardUp: boolean
  /** A pull-to-refresh has the page: one source of the offset at a time (§3.4 Android). */
  pulling: boolean
}

/**
 * The signals for a given state of the chrome; `overviewOpen` is the stage's word on the tab
 * overview (`overviewIsOpen()` – any phase but closed); `phone` is the form factor's (the phone
 * draws its new tab page in the chrome over `zen://blank`; the tablet serves `zen://newtab`).
 */
export function readBandSignals(
  state: UIState | null,
  ui: UiState,
  pull: PullState,
  overviewOpen: boolean,
  phone: boolean
): BandSignals {
  const tab = state ? activeTab(state) : null
  const url = tab?.url ?? ''
  return {
    tabId: tab?.id ?? null,
    page: tab !== null && isBandPageUrl(url),
    document: tab !== null && url !== '' && !isChromePageUrl(url) && !(phone && url === BLANK_URL),
    privateTab: tab !== null && isPrivateTab(tab),
    covered:
      overlayCoversContent(ui) ||
      ui.frameDialogsOpen > 0 ||
      ui.frameDialogCover > 0 ||
      overviewOpen,
    keyboardUp: ui.insets.bottom >= KEYBOARD_INSET_MIN,
    pulling: pull.phase !== 'idle'
  }
}

/**
 * The host's word on the frame for the model (`setBandFrame`), from the signals: the tab in
 * front; `ok` – a band may stand on what is in front at all: a document in the tab's own view,
 * and not while a pull has it (one source of the page's offset at a time, §3.4 Android: the
 * band withheld waits and a state returns on its own entrance when the pull ends); `offers` –
 * not on a private tab and not on a chrome page (`page`, §10: a state stands there, an offer
 * never); `covered` – an overlay over the page, the open tab overview or the keyboard over its field,
 * under which a prompt arriving waits and the one standing stays. The scene is the tab's (the
 * model's default): the
 * touch hosts show one page in the frame and a page's fullscreen hides the chrome with the band.
 */
export function bandFrameOf(signals: BandSignals): BandFrame {
  return {
    front: signals.tabId,
    ok: signals.tabId !== null && signals.document && !signals.pulling,
    offers: !signals.privateTab && signals.page,
    covered: signals.covered || signals.keyboardUp
  }
}

/** The chrome's own signals right now. */
export function bandSignals(): BandSignals {
  return readBandSignals(
    browserStore.get().state,
    uiStore.get(),
    pullStore.get(),
    overviewIsOpen(),
    isPhone()
  )
}

/**
 * Hear every change of the signals (the browser, ui and pull stores publish at rest – no
 * per-frame work on them; the stage publishes every frame of the overview's drag and settle, so
 * it is read for the one flip that matters, open or closed; the viewport likewise for the
 * phone/tablet flip alone); `listener` runs once at once with the current reading. Returns the
 * unsubscribe.
 */
export function subscribeBandSignals(listener: (signals: BandSignals) => void): () => void {
  let last = bandSignals()
  listener(last)
  const check = (): void => {
    const next = bandSignals()
    if (
      next.tabId === last.tabId &&
      next.page === last.page &&
      next.document === last.document &&
      next.privateTab === last.privateTab &&
      next.covered === last.covered &&
      next.keyboardUp === last.keyboardUp &&
      next.pulling === last.pulling
    )
      return
    last = next
    listener(next)
  }
  let overviewOpen = overviewIsOpen()
  const stageCheck = (): void => {
    const open = overviewIsOpen()
    if (open === overviewOpen) return
    overviewOpen = open
    check()
  }
  let phone = isPhone()
  const viewportCheck = (): void => {
    const next = isPhone()
    if (next === phone) return
    phone = next
    check()
  }
  const offs = [
    browserStore.subscribe(check),
    uiStore.subscribe(check),
    pullStore.subscribe(check),
    stageStore.subscribe(stageCheck),
    viewportStore.subscribe(viewportCheck)
  ]
  return () => {
    for (const off of offs) off()
  }
}
