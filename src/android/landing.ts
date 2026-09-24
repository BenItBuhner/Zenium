import type { Tab } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import type { Browser } from '@core/browser'
import type { ZenWindow } from '@core/window'
import { browserStore } from '@renderer/lib/browserStore'
import { startQrScan } from '@renderer/lib/qrScan'
import { openNewTabPageUrlbar, pushToast } from '@renderer/lib/ui'
import { startVoiceSearch } from '@renderer/lib/voiceSearch'
import { openShortcutPrivateTab, PRIVATE_TABS_UNAVAILABLE } from './privateShortcut'

/**
 * The states the search widget and the launcher's shortcuts ask the app to open in (WID-07). The
 * words are `Landing.kt`'s: one intent extra (`app.zen.chromium.extra.LANDING`), read by
 * `MainActivity.handleIntent` and handed to `ChromeWebView.land`. Cold, the chrome stashes it
 * and the boot answer carries it (`BootInfo.landing`), applied by `bootAndroid` right after
 * `browser.start()`; warm (`onNewIntent`), it reaches `window.__zenHost.land` at once.
 */
export const LANDING_STATES = ['search', 'voice', 'private', 'scan', 'newTab'] as const
export type LandingState = (typeof LANDING_STATES)[number]

/** The word as the host sent it, or null for anything that is not one of the states. */
export function parseLanding(value: unknown): LandingState | null {
  if (typeof value !== 'string') return null
  const word = value.trim()
  return LANDING_STATES.find((state) => state.toLowerCase() === word.toLowerCase()) ?? null
}

/** The surface a landing puts over its tab once the chrome is up; injected so the plan is testable. */
export interface LandingSurfaces {
  /** The omnibox open over the new tab page, bound to the tab, the keyboard following its field. */
  omnibox(tabId: string): void
  /** The voice search sheet, listening, its result loading in the tab (W2-7's path). */
  voice(tabId: string): void
  /** The QR scan sheet over the tab. */
  scan(tabId: string): void
  /** The word for a landing the core declines (the private tab on a WebView without profiles). */
  unavailable(message: string): void
}

const surfaces: LandingSurfaces = {
  // What `newtab.opened` does for a new tab on a touch layout (`useMainEvents`): new-tab mode
  // bound to the tab, attached to the bar, so what is typed navigates this tab.
  omnibox: (tabId) => openNewTabPageUrlbar(tabId, undefined, true),
  voice: (tabId) => void startVoiceSearch({ tabId }),
  scan: (tabId) => void startQrScan({ tabId }),
  // The chrome's own toast store, where the window's `toast` event ends (`useMainEvents`) – but
  // said here directly, so a word given inside the boot's run is in the first frame: the event
  // has no subscriber until after the first render and is not replayed to a late one.
  unavailable: (message) => void pushToast(message, 'error')
}

/**
 * Run `fn` once the chrome holds the core's state – at once when it does. On a cold start the
 * landing is applied by `bootAndroid` itself, from the boot answer, in the same synchronous run
 * as `browser.start()` and before the chrome has mounted (`main.tsx` renders once `bootAndroid`
 * resolves): the tab is in place for the chrome's first frame, and the surface over it is asked
 * for as soon as the chrome can answer (`startBrowserSync` fills the store in the microtasks
 * before the first render), never a frame late. Warm (`onNewIntent`) the store is filled and the
 * surface goes up in the intent's own turn.
 */
function whenChromeHasState(fn: () => void): void {
  if (browserStore.get().state !== null) {
    fn()
    return
  }
  const stop = browserStore.subscribe(() => {
    if (browserStore.get().state === null) return
    stop()
    fn()
  })
}

/**
 * Land the app in `state` (WID-07): a widget face or a launcher shortcut was tapped and the app
 * must open straight in what was asked for – the omnibox focused, the mic listening, a new
 * private tab, the QR scanner – without the previous tab ever painting.
 *
 * The rule that gives the "no flash": every landing is a NEW tab, created active in this turn
 * (`private` is the shortcut's private tab; the rest a blank tab, the phone's new tab page). Cold,
 * this runs inside `bootAndroid`, right after `browser.start()` and before React mounts, so the
 * chrome's first frame already shows the new tab and the restored one never takes a frame. Warm,
 * the next frame shows it. The surface (omnibox, voice, scan) is the chrome's own entry point,
 * called as the chrome is ready (`whenChromeHasState`).
 *
 * The tab is `fromIntent`, as the private shortcut's is (INC-01): back at its root returns to the
 * launcher and closes the tab on the way out (#117's `rootBackAction` -> `caller`) – the widget's
 * tab is one the launcher sent, and Chrome's search widget behaves the same.
 *
 * Returns the tab it opened (null: an unknown word, or the private tab declined by a WebView
 * without profiles – the shortcut's word for that, `PRIVATE_TABS_UNAVAILABLE`, is said through
 * the chrome's own surface as the chrome is ready, the way the other surfaces go up: the
 * shortcut's `browser.toast` is the window's `toast` event, and inside the boot's run that event
 * has no subscriber yet, so a cold private landing on such a WebView used to land in silence).
 */
export function landFromIntent(
  word: string,
  browser: Browser,
  win: ZenWindow,
  over: LandingSurfaces = surfaces,
  ready: (fn: () => void) => void = whenChromeHasState
): Tab | null {
  const state = parseLanding(word)
  if (state === null) {
    console.warn(`[zen] landing: not a state: ${JSON.stringify(word)}`)
    return null
  }
  if (state === 'private') {
    if (browser.state.capabilities.privateTabs) return openShortcutPrivateTab(browser, win)
    ready(() => over.unavailable(PRIVATE_TABS_UNAVAILABLE))
    return null
  }
  const tab = browser.tabs.createTab({ url: BLANK_URL, active: true, fromIntent: true }, win)
  const surface = surfaceOf(state)
  if (surface) ready(() => over[surface](tab.id))
  return tab
}

/** The surface a state puts over its tab; `newTab` and `private` have none. */
export function surfaceOf(state: LandingState): keyof LandingSurfaces | null {
  switch (state) {
    case 'search':
      return 'omnibox'
    case 'voice':
      return 'voice'
    case 'scan':
      return 'scan'
    default:
      return null
  }
}
