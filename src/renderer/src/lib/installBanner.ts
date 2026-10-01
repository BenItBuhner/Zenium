import { Smartphone } from 'lucide-react'
import type { WebAppBanner } from '@shared/types'
import { BANNER_TIMEOUT_MS } from '@shared/webApp'
import { run } from '@renderer/lib/api'
import { dismissPosted, postBanner, postedUp } from '@renderer/lib/band/post'
import type { BannerDismissReason, BannerOptions } from '@renderer/lib/ui'

/**
 * The ambient "Add <app> to Home screen" prompt (PWA-03) behind one seam. The core raises and
 * lowers it (`webapp.banner`, `webapp.bannerHide`) and only cares how it went; the card is the
 * shared top banner (v2 §9.33) – on the touch hosts the page-edge band in its offer form
 * (motion spec §4; `lib/band/post.ts` is the door): the phone glyph on the title, the app's
 * origin as the detail, one "Add" that opens the install sheet through the core like the menu
 * item, the card's own swipe, close and clock. One banner at a time under the `install` key.
 */

/** The banner card up for each tab, by the id the door gave it. */
const shown = new Map<string, number>()

/** The card's words and ends for a tab's prompt: what either door shows. */
export function installBannerOptions(
  banner: WebAppBanner,
  onDismiss: (reason: BannerDismissReason) => void
): BannerOptions {
  return {
    title: `Add ${banner.name} to Home screen`,
    detail: banner.origin,
    icon: Smartphone,
    action: { label: 'Add', onPick: () => run('webapp.openInstall', { tabId: banner.tabId }) },
    key: 'install',
    duration: BANNER_TIMEOUT_MS,
    onDismiss
  }
}

/** The core raised the prompt for a tab; one already up (for any tab) is replaced. */
export function presentInstallBanner(banner: WebAppBanner): void {
  const id = postBanner(
    installBannerOptions(banner, (reason) => {
      if (shown.get(banner.tabId) === id) shown.delete(banner.tabId)
      const why = coreReason(reason)
      if (why) run('webapp.dismissBanner', { tabId: banner.tabId, reason: why })
    }),
    'offer'
  )
  shown.set(banner.tabId, id)
}

/**
 * What the core hears: the user sent the card away (a swipe or its close – the app's cooldown
 * starts) or its clock ran out. "Add" needs no report (the core opens the sheet and takes the
 * banner down itself); a replacement or the core's own take-down was not the user's doing.
 */
function coreReason(reason: BannerDismissReason): 'swipe' | 'timeout' | null {
  switch (reason) {
    case 'swipe':
    case 'close':
      return 'swipe'
    case 'timeout':
      return 'timeout'
    default:
      return null
  }
}

/**
 * The core took the prompt down: its timer ran out, the page left the app, another tab came to
 * the front, or the install sheet opened for the tab. Not the user's doing, so no report back.
 */
export function retireInstallBanner(tabId: string): void {
  const id = shown.get(tabId)
  if (id === undefined) return
  shown.delete(tabId)
  dismissPosted(id)
}

/** Whether the prompt's card is up for `tabId` (the preview host waits on it). */
export function installBannerShown(tabId: string): boolean {
  const id = shown.get(tabId)
  return id !== undefined && postedUp(id)
}
