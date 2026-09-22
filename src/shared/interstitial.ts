/**
 * How the interstitials (`zen://error?kind=safebrowsing`, `zen://error?kind=https-only`) talk
 * to the browser: a button posts a `message` on its own window, the page script relays it (only
 * from documents of Zenium's scheme) and the core checks it against the block it is holding for
 * the tab. Kept apart from `zenPages` so the page script bundle does not carry the page HTML.
 */

/**
 * `show-tabs` is the crash page's (ERR-15): a page that crashed twice within the minute offers
 * the tab switcher so other tabs can be closed; the core opens the phone's overview for it.
 */
export type InterstitialAction = 'back' | 'proceed' | 'continue' | 'continue-always' | 'show-tabs'

export const INTERSTITIAL_ACTIONS: readonly InterstitialAction[] = [
  'back',
  'proceed',
  'continue',
  'continue-always',
  'show-tabs'
]

export interface InterstitialMessage {
  action: InterstitialAction
  /** The page the interstitial stands in for. */
  url: string
}

/** The key of the window message an interstitial posts. */
export const INTERSTITIAL_MESSAGE_KEY = 'zeniumInterstitial'
