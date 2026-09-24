import type { Tab } from '@shared/types'

/**
 * What the host hears of a tab's capture (`capture.update`, `CaptureNotifications.kt`, NOT-13):
 * the camera and the microphone the page holds – the WebView's two kinds; a screen share it
 * cannot make – the page's address for the card's site, and whether the tab is private (the
 * card then names no site, as Chrome's Incognito card does). All false ends the tab's card.
 */
export interface CaptureUpdate {
  tabId: string
  url: string
  camera: boolean
  microphone: boolean
  private: boolean
}

/** A capture as the host last heard it, by tab: the kinds, the privacy and the site. */
export type CapturesHeld = Map<string, string>

function siteOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * The updates the host needs to follow the tabs' capture from `held` (what it heard last,
 * brought up to date in place) to `tabs` as the core's state has them: one per tab whose kinds,
 * privacy or site changed, and an all-clear for a tab the host heard of that holds nothing now
 * or is gone. Same-site address changes (a route, a fragment) say nothing: the card names the
 * site. Pure, so the relay's edge cases have a table (`captureRelay.test.ts`).
 */
export function captureUpdates(
  held: CapturesHeld,
  tabs: Iterable<Tab>,
  isPrivate: (tab: Tab) => boolean
): CaptureUpdate[] {
  const updates: CaptureUpdate[] = []
  const live = new Set<string>()
  for (const tab of tabs) {
    const camera = tab.capture?.camera === true
    const microphone = tab.capture?.microphone === true
    if (!camera && !microphone) continue
    live.add(tab.id)
    const priv = isPrivate(tab)
    const key = `${camera ? 'c' : '-'}${microphone ? 'm' : '-'}${priv ? 'p' : '-'}|${siteOf(tab.url)}`
    if (held.get(tab.id) === key) continue
    held.set(tab.id, key)
    updates.push({ tabId: tab.id, url: tab.url, camera, microphone, private: priv })
  }
  for (const tabId of [...held.keys()]) {
    if (live.has(tabId)) continue
    held.delete(tabId)
    updates.push({ tabId, url: '', camera: false, microphone: false, private: false })
  }
  return updates
}
