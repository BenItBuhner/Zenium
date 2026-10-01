import { useEffect } from 'react'
import { isChromePageUrl } from '@shared/internalPages'
import type { Platform, Tab } from '@shared/types'
import { captureThumbnail } from './thumbnails'

/**
 * The picture of a page the chrome draws itself (Settings, `render: 'chrome'`): a page tab has
 * no view whose hide takes its card picture, so the chrome asks for one itself when the page's
 * route has changed and settled – a section opened from the landing, a drill-in page over its
 * section, the way back out – while the page is on screen. The host copies its window where the
 * page is (`chrome.snapshot`, `WindowHost.snapshotChrome`), keeps the card picture on disk under
 * the tab's address and the core raises it to the chrome as `thumbnail.captured`, so the card
 * of a Settings tab shows the section or page the tab is on – in the overview, whose own capture
 * before it opens sees the same route (`stage.ts`), and after a relaunch, from the disk.
 */

/**
 * How long after a route change the capture waits: the drill-in pane's entrance (240 ms,
 * `.zen-settings-drill-in`) and a frame or two for the page's rows to be laid out – a copy
 * mid-entrance would show the pane half way in.
 */
export const CHROME_PAGE_CAPTURE_SETTLE_MS = 400

/**
 * Whether the host pictures its chrome (`WindowHost.snapshotChrome`): the Android chassis, whose
 * host copies its window for a page's cover and does the same for a page the chrome draws. The
 * desktop hosts take no picture of their chrome and keep the card's drawing of the route.
 */
export function hostPicturesChromePages(platform: Platform): boolean {
  return platform === 'android'
}

/** Per tab, the address its last scheduled capture was of – not asked twice for one route. */
const pictured = new Map<string, string>()

/**
 * Ask for the picture of `tabId` at `url` once the route has settled. Returns the cancel: the
 * route changed again, or the page left the screen, before the capture ran. A capture that
 * yields nothing (the page was hidden by the time it ran) leaves the route to be asked again the
 * next time the page shows.
 */
export function scheduleChromePageCapture(
  tabId: string,
  url: string,
  capture: (tabId: string) => Promise<string | null> = captureThumbnail
): () => void {
  pictured.set(tabId, url)
  const forget = (): void => {
    if (pictured.get(tabId) === url) pictured.delete(tabId)
  }
  let fired = false
  const timer = setTimeout(() => {
    fired = true
    void capture(tabId).then(
      (picture) => {
        if (!picture) forget()
      },
      () => forget()
    )
  }, CHROME_PAGE_CAPTURE_SETTLE_MS)
  // The cancel after the capture ran changes nothing: the route is pictured, hidden or not.
  return () => {
    if (fired) return
    clearTimeout(timer)
    forget()
  }
}

/** Whether a capture of `tabId` at `url` is due: none scheduled or taken for that route yet. */
export function chromePageCaptureDue(tabId: string, url: string): boolean {
  return pictured.get(tabId) !== url
}

/** Forget every route asked for (tests). */
export function resetChromePageCaptures(): void {
  pictured.clear()
}

/**
 * The content area's trigger: while `shown` (the page on screen, nothing of the chrome over it),
 * a chrome page tab whose route is not pictured yet is captured once it has settled – on a host
 * that pictures its chrome, and never for a document page (its view's hide takes its picture).
 */
export function useChromePageCapture(tab: Tab, shown: boolean, platform: Platform): void {
  const { id, url } = tab
  useEffect(() => {
    if (!shown || !hostPicturesChromePages(platform) || !isChromePageUrl(url)) return
    if (!chromePageCaptureDue(id, url)) return
    return scheduleChromePageCapture(id, url)
  }, [id, url, shown, platform])
}
