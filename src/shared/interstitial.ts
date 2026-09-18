/**
 * How the interstitials (`zen://error?kind=safebrowsing`, `zen://error?kind=https-only`) talk
 * to the browser: a button posts a `message` on its own window, the page script relays it (only
 * from documents of Zenium's scheme) and the core checks it against the block it is holding for
 * the tab. Kept apart from `zenPages` so the page script bundle does not carry the page HTML.
 */

export type InterstitialAction = 'back' | 'proceed' | 'continue' | 'continue-always'

export const INTERSTITIAL_ACTIONS: readonly InterstitialAction[] = [
  'back',
  'proceed',
  'continue',
  'continue-always'
]

export interface InterstitialMessage {
  action: InterstitialAction
  /** The page the interstitial stands in for. */
  url: string
}

/** The key of the window message an interstitial posts. */
export const INTERSTITIAL_MESSAGE_KEY = 'zeniumInterstitial'
