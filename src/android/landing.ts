import type { Tab } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import type { Browser } from '@core/browser'
import type { ZenWindow } from '@core/window'
import { browserStore } from '@renderer/lib/browserStore'
import { startQrScan } from '@renderer/lib/qrScan'
import { openNewTabPageUrlbar } from '@renderer/lib/ui'
import { startVoiceSearch } from '@renderer/lib/voiceSearch'
import { openShortcutPrivateTab } from './privateShortcut'

/**
 * The states the search widget and the launcher's shortcuts ask the app to open in (WID-07). The
 * words are `Landing.kt`'s: one intent extra (`app.zen.chromium.extra.LANDING`), read by
 * `MainActivity.handleIntent` and handed to `window.__zenHost.land` through the chrome's ready
 * queue, as the private shortcut's action always was.
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
}

const surfaces: LandingSurfaces = {
  // What `newtab.opened` does for a new tab on a touch layout (`useMainEvents`): new-tab mode
  // bound to the tab, attached to the bar, so what is typed navigates this tab.
  omnibox: (tabId) => openNewTabPageUrlbar(tabId, undefined, true),
  voice: (tabId) => void startVoiceSearch({ tabId }),
  scan: (tabId) => void startQrScan({ tabId })
}

/**
 * Run `fn` once the chrome holds the core's state – at once when it does. On a cold start the
 * landing is delivered by the host global's flush, in the same synchronous run as
 * `browser.start()` and before the chrome has mounted (`main.tsx` renders once `bootAndroid`
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
 * (`private` is the shortcut's private tab; the rest a blank tab, the phone's new tab page). The
 * tab that was active never takes a frame, because the chrome's first frame – cold, the React
 * mount; warm, the next – already shows the new one. The surface (omnibox, voice, scan) is the
 * chrome's own entry point, called as the chrome is ready (`whenChromeHasState`).
 *
 * The tab is `fromIntent`, as the private shortcut's is (INC-01): back at its root returns to the
 * launcher and closes the tab on the way out (#117's `rootBackAction` -> `caller`) – the widget's
 * tab is one the launcher sent, and Chrome's search widget behaves the same.
 *
 * Returns the tab it opened (null: an unknown word, or the private tab declined by a WebView
 * without profiles, which `openShortcutPrivateTab` has already explained in a toast).
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
  if (state === 'private') return openShortcutPrivateTab(browser, win)
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
