import { DEFAULT_IPH_BUBBLE_STATE, iphAvailable } from '@shared/iph'
import type {
  IphBubbleState,
  PhoneBarItemId,
  PhoneBarPosition,
  Rect,
  Settings
} from '@shared/types'
import { run } from './api'
import { createStore } from './store'

/**
 * The phone's in-product help (TB-19): the trigger model of Chrome Android's one-shot toolbar
 * hint bubbles, and the store of the bubble on screen (`components/messages/HintBubbleCard.tsx`
 * draws it in the message frame, `components/phone/useTabSwitcherHint.ts` runs it).
 *
 * Chrome 152 shows one such bubble by default: `IPH_TabSwitcherButton`, on the tab switcher
 * button after a page has loaded (`ToggleTabStackButtonCoordinator.java` l.361–418), under the
 * feature engagement rules of `feature_configurations.cc` l.1635–1652 – the bubble has to have
 * been available for 14 days, at most one in-product help shows per session (`session_rate < 1`),
 * and a user who has clicked the button (`tab_switcher_button_clicked`) is not told about it;
 * never in Incognito, and never in a session a startup promo took (l.401–411,
 * `mPromoShownOneshotSupplier`). The rules here are those, on one device-local record per
 * bubble (`settings.iph`, `shared/iph.ts`) instead of Chrome's event counters: a bubble shows
 * once and is spent; the button used before it was due spends it the same way (Chrome would
 * hold it 360 days, then offer it again – a counter this model does not keep).
 *
 * The cold-start rule (P0): nothing here runs at boot but the shell's one deferred arm
 * (`IPH_ARM_DELAY_MS` after the first paint, in an idle callback); the model is pure reads of
 * state the chrome holds already, and the one layout read – the anchor's box – happens as a
 * bubble goes up, weeks in.
 */

/**
 * The hold after the phone shell's first paint before the arm may run, and the arm itself waits
 * for an idle moment after it: the first two seconds are the page's.
 */
export const IPH_ARM_DELAY_MS = 2000

/**
 * The one deferred arm (P0's cold-start rule): `onArmed` runs at an idle moment after
 * `IPH_ARM_DELAY_MS`, never sooner; the returned function cancels an arm that has not run. No
 * I/O and no layout read here – the arm is a flag, the model reads state the chrome holds.
 */
export function armIph(onArmed: () => void, delayMs = IPH_ARM_DELAY_MS): () => void {
  let idle: number | ReturnType<typeof setTimeout> | null = null
  let idleIsCallback = false
  const timer = setTimeout(() => {
    if (typeof requestIdleCallback === 'function') {
      idleIsCallback = true
      idle = requestIdleCallback(() => onArmed(), { timeout: delayMs })
    } else {
      idle = setTimeout(onArmed, 0)
    }
  }, delayMs)
  return () => {
    clearTimeout(timer)
    if (idle === null) return
    if (idleIsCallback) cancelIdleCallback(idle as number)
    else clearTimeout(idle as ReturnType<typeof setTimeout>)
  }
}

/**
 * Chrome's words for the tab switcher bubble, verbatim
 * (`chrome/browser/ui/android/strings/android_chrome_strings.grd`): `IDS_IPH_TAB_SWITCHER_TEXT`
 * l.6186–6188, and what the bubble says under touch exploration instead,
 * `IDS_IPH_TAB_SWITCHER_ACCESSIBILITY_TEXT` l.6189–6191 (`TextBubble.java` l.443–446).
 */
export const TAB_SWITCHER_HINT_TEXT = 'Open tabs to visit different pages at the same time'
export const TAB_SWITCHER_HINT_ACCESSIBILITY_TEXT =
  'To open tabs and visit different pages at the same time, tap the open tabs button'

/**
 * The overview's drag-to-group teaching, Chrome's drag-and-drop IPH dialog folded into §9.33's
 * one sentence: `IDS_IPH_DRAG_AND_DROP_CONTENT` "To group tabs, touch & hold a tab. Then, drag
 * it onto another tab." under the title `IDS_IPH_DRAG_AND_DROP_TITLE` "Get organized"
 * (`components/browser_ui/strings/android/browser_ui_strings.grd` l.1432–1437;
 * `TabGridIphDialogCoordinator.java` l.40–46). The hold stays in the sentence: it is the part of
 * the gesture a finger does not find on its own – a drag without it scrolls the grid. Chrome has
 * no accessibility variant of these words (the dialog's are the same under TalkBack), so nor
 * does the bubble.
 */
export const TAB_GROUPS_DRAG_HINT_TEXT =
  'Touch and hold a tab, then drag it onto another to group them'

// ---------------------------------------------------------------------------
// One education per session
// ---------------------------------------------------------------------------

/**
 * Chrome's `session_rate < 1`: one in-product help per session, and a session that showed a
 * startup promo shows none. The gesture hint's toast (FRE-07, `useGestureHint.ts`) and the
 * default-browser prompts (DEF-01 / 02) spend the session the same way. Renderer memory, so a
 * session is the chrome's life – one app start – as Chrome's is.
 */
let sessionSpent = false

export function iphSessionSpent(): boolean {
  return sessionSpent
}

export function spendIphSession(): void {
  sessionSpent = true
}

/** Tests only: a new session. */
export function resetIphSession(): void {
  sessionSpent = false
}

// ---------------------------------------------------------------------------
// The tab switcher bubble's trigger
// ---------------------------------------------------------------------------

/**
 * What the tab switcher bubble's rules read of the settings: the first-run flag and its own
 * record – the other bubbles' records are none of its business, and a one-bubble patch is what
 * its writes send (`SettingsPatch`).
 */
export type TabSwitcherSettings = { iph: Pick<Settings['iph'], 'tabSwitcher'> }

export interface TabSwitcherHintInput {
  settings: Pick<Settings, 'onboardingDone'> & TabSwitcherSettings
  /** The clock (ms since the epoch) the availability is read by. */
  now: number
  /** The deferred arm has run: never inside the first seconds after the first paint. */
  armed: boolean
  /**
   * The chrome is calm: a page in view under nothing – no sheet, dialog, menu or omnibox, no
   * overview, drag or prompt, the bar and its Tabs button in place (the shell's term).
   */
  calm: boolean
  /** The active tab's page has finished loading (Chrome's `onPageLoadFinished`). */
  pageLoaded: boolean
  /** The active tab is a private one: Chrome shows no tab switcher help in Incognito. */
  privateTab: boolean
  /** The session's one education is spent (defaults to the module's flag). */
  sessionSpent?: boolean
}

/**
 * Whether the tab switcher bubble is due right now: owed (the first run over, the bubble not yet
 * shown or spent), available (14 days on the device), the session's education unspent, and the
 * moment right – armed, calm, a page loaded, not private.
 */
export function tabSwitcherHintDue(input: TabSwitcherHintInput): boolean {
  const { settings } = input
  if (!settings.onboardingDone) return false
  if (settings.iph.tabSwitcher.shown) return false
  if (input.sessionSpent ?? sessionSpent) return false
  if (!input.armed || !input.calm || !input.pageLoaded || input.privateTab) return false
  return iphAvailable(settings.iph.tabSwitcher, input.now)
}

// ---------------------------------------------------------------------------
// The record's writes
// ---------------------------------------------------------------------------

/**
 * The bubble's availability clock starts: Chrome's tracker stamps a feature's first day the
 * first time it is enabled (`feature_config_condition_validator.cc`, the `availability`
 * comparison against the day the feature was first seen); here the phone shell's first arm
 * stamps it, once. A record already stamped or spent is left alone.
 */
export function stampTabSwitcherHint(settings: TabSwitcherSettings, now: number): boolean {
  const record = settings.iph.tabSwitcher
  if (record.availableAt !== null || record.shown) return false
  run('settings.update', { iph: { tabSwitcher: { availableAt: now, shown: false } } })
  return true
}

/** The bubble went up: spent, once and for all (Chrome's `IPH_TabSwitcherButton` trigger event). */
export function markTabSwitcherHintShown(settings: TabSwitcherSettings): void {
  const record = settings.iph.tabSwitcher
  if (record.shown) return
  run('settings.update', { iph: { tabSwitcher: { ...record, shown: true } } })
}

/**
 * The Tabs button itself was tapped (Chrome's `tab_switcher_button_clicked`, the feature's
 * `used` event): a user who has found the button is not told about it – the record is spent as
 * if shown. The pill's pull opens the same overview and counts for nothing here, as Chrome's
 * swipe onto the switcher does not record the button's event.
 */
export function noteTabSwitcherButtonUsed(
  settings: Pick<Settings, 'onboardingDone'> & TabSwitcherSettings
): void {
  if (!settings.onboardingDone) return
  markTabSwitcherHintShown(settings)
}

// ---------------------------------------------------------------------------
// The overview's drag-to-group bubble
// ---------------------------------------------------------------------------

/**
 * Chrome 152's drag-to-group teaching in the tab switcher is `IPH_TabGroupsDragAndDrop`
 * (`feature_constants.cc` l.591–593, DISABLED by default; `feature_configurations.cc`
 * l.1554–1571: `availability ANY`, once per session, not after a drag has grouped tabs in 360
 * days – the `used` event `tab_drag_and_drop_to_group`), whose surface there is a message card
 * with a "Show me" that opens the IPH dialog (`IphMessageService.java`). Out of the box the
 * dialog is reached one way: the NTP's educational tip card's button
 * (`TabGroupPromoCoordinator.java` l.35 → `ChromeTabbedActivity.java` l.3500–3508 shows the Hub
 * and `TabGridIphDialogCoordinator.showIph()`, with no tracker check and no tab count). Zenium's
 * tips card (#695) opens the overview the same way, and the overview shows this bubble in place
 * of the dialog – on that path alone, once (`tabGroupsDragAndDrop.shown`, spent as the bubble
 * goes up). A drag that has grouped tabs does not spend it: Chrome's `used` event gates only the
 * message card, which is off, and its dialog opens on the tip's tap whatever the tracker holds –
 * the tip itself is shown only to a profile with no group (#695), which is the gate that matters.
 * It takes the session's one education as every education here does (the Tabs button's bubble
 * is not owed in the minutes after it), but is not held back by a spent session: the user asked
 * for it.
 */

/** What the overview bubble's rules read of the settings: its own record. */
export type TabGroupsDragSettings = { iph: Pick<Settings['iph'], 'tabGroupsDragAndDrop'> }

/**
 * The record off the settings. The core's settings always carry `iph` (`sanitizeIphState` fills
 * it); the overview is also mounted over states built without it – a test's fixture – and those
 * read as unseen rather than throw from a grid whose business the bubble is not.
 */
export function tabGroupsDragRecord(settings: TabGroupsDragSettings): IphBubbleState {
  return settings.iph?.tabGroupsDragAndDrop ?? DEFAULT_IPH_BUBBLE_STATE
}

/**
 * The tips card's "Try it now" is opening the overview to teach the drag (#695's CTA,
 * `MagicStack.tsx`): the overview takes the request as it comes to rest (`useOverviewGroupsHint`)
 * and shows the bubble once, if the record is unspent. An overview that never opens – a request
 * with no overview, or one closed on its way – drops it (`takeOverviewGroupsHintRequest` is
 * called either way).
 */
let overviewGroupsHintRequested = false

export function requestOverviewGroupsHint(): void {
  overviewGroupsHintRequested = true
}

/** Read and clear the request: true once per "Try it now". */
export function takeOverviewGroupsHintRequest(): boolean {
  const requested = overviewGroupsHintRequested
  overviewGroupsHintRequested = false
  return requested
}

export interface OverviewGroupsHintInput {
  settings: TabGroupsDragSettings
  /** The overview was opened by the tips card's "Try it now" (the request, taken). */
  fromTip: boolean
  /** The overview stands open: settled, its cards in their slots (not a settle, a drag or a close). */
  open: boolean
  /** A loose tab card stands in the grid to point at (Chrome's dialog needs none; the bubble does). */
  hasAnchor: boolean
}

/**
 * Whether the overview's drag-to-group bubble is due right now: asked for by the tip, the record
 * unspent, the overview at rest with a card to point at. No availability clock (Chrome's is ANY)
 * and no session gate (Chrome's tip path has none).
 */
export function overviewGroupsHintDue(input: OverviewGroupsHintInput): boolean {
  if (!input.fromTip) return false
  if (tabGroupsDragRecord(input.settings).shown) return false
  return input.open && input.hasAnchor
}

/**
 * The bubble went up: spent, once and for all. The stamp is the day it was spent – Chrome's
 * `availability` for this feature is ANY, so no clock runs ahead of it.
 */
export function markTabGroupsDragHintShown(
  settings: TabGroupsDragSettings,
  now: number = Date.now()
): void {
  const record = tabGroupsDragRecord(settings)
  if (record.shown) return
  run('settings.update', {
    iph: { tabGroupsDragAndDrop: { availableAt: record.availableAt ?? now, shown: true } }
  })
}

// ---------------------------------------------------------------------------
// The bubble on screen
// ---------------------------------------------------------------------------

/**
 * The bubble's element id: what the control it is about names in `aria-describedby` while the
 * bubble stands (the lead's (j) on #641 – the announcement is the card's `role="status"`, the
 * description the button's), one bubble at a time so one id serves.
 */
export const HINT_BUBBLE_ID = 'zen-hint-bubble'

interface HintBubbleBase {
  /** Which bubble (its record in `settings.iph`). */
  id: keyof Settings['iph']
  /** The anchor's box, window coordinates, as read when the bubble went up. */
  anchor: Rect
  /**
   * The words: Chrome's text, or its longer accessibility text while an accessibility service
   * explores by touch (`TextBubble.java` l.443–446 picks one or the other as the bubble is made).
   */
  text: string
}

/** A bubble on a bar control (#641's, the first kind): its literals carry no `at`. */
export interface BarHintBubble extends HintBubbleBase {
  at?: 'bar'
  /** The bar control it is about: the bar pulses it and describes it by the bubble. */
  anchorItem: PhoneBarItemId
  /**
   * The bar's edge: the bubble sits flush against the bar band's inner edge on that side, at gap
   * 0 (§9.20's pose; the same form mirrored under a top-docked bar, the lead's (k)).
   */
  edge: PhoneBarPosition
}

/**
 * A bubble on a tab card in the overview (the drag-to-group teaching): §9.20's anchored pose
 * against the card's box – flush under it at gap 0, start-aligned, flipping above when the room
 * below runs out (`HintBubbleCard` places it; `messages/stack.ts` has the rule). The card pulses
 * and carries the bubble as its description while it stands (`OverviewCard`).
 */
export interface OverviewHintBubble extends HintBubbleBase {
  at: 'overview'
  /** The tab whose card it is about. */
  tabId: string
}

export type HintBubble = BarHintBubble | OverviewHintBubble

/** The bar edge a bubble sits on: null for one that is not on the bar. */
export function hintBubbleEdge(bubble: HintBubble | null): PhoneBarPosition | null {
  return bubble && bubble.at !== 'overview' ? bubble.edge : null
}

/** The bar item a bubble is about: null for one that is not on the bar. */
export function hintBubbleBarItem(bubble: HintBubble | null): PhoneBarItemId | null {
  return bubble && bubble.at !== 'overview' ? bubble.anchorItem : null
}

/** The overview card a bubble is about: null for one that is not in the overview. */
export function hintBubbleTabId(bubble: HintBubble | null): string | null {
  return bubble && bubble.at === 'overview' ? bubble.tabId : null
}

export interface HintBubbleState {
  bubble: HintBubble | null
  /** The bubble is on its way out (Chrome's 200 ms `textbubble_out`); gone at the sweep. */
  leaving: boolean
}

export const hintBubbleStore = createStore<HintBubbleState>(
  { bubble: null, leaving: false },
  'hint-bubble'
)

/** Chrome's `textbubble_out.xml`: an alpha fade over `config_shortAnimTime`, 200 ms. */
export const HINT_BUBBLE_EXIT_MS = 200

let sweep: ReturnType<typeof setTimeout> | null = null

/** Put a bubble up (one at a time: a bubble already up is replaced outright). */
export function showHintBubble(bubble: HintBubble): void {
  if (sweep) clearTimeout(sweep)
  sweep = null
  hintBubbleStore.set({ bubble, leaving: false })
}

/** The bubble's showing is over: it fades and is forgotten at the end of the fade. */
export function dismissHintBubble(): void {
  const s = hintBubbleStore.get()
  if (!s.bubble || s.leaving) return
  hintBubbleStore.set({ leaving: true })
  sweep = setTimeout(() => {
    sweep = null
    hintBubbleStore.set({ bubble: null, leaving: false })
  }, HINT_BUBBLE_EXIT_MS)
}

/** Forget the bubble at once (the shell leaving, tests). */
export function forgetHintBubble(): void {
  if (sweep) clearTimeout(sweep)
  sweep = null
  hintBubbleStore.set({ bubble: null, leaving: false })
}

/** Whether a bubble is up (leaving counts: its box is still the page's cover until the sweep). */
export function hintBubbleUp(): boolean {
  return hintBubbleStore.get().bubble !== null
}
