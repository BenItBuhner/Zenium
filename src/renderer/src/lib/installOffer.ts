import type { WebAppBanner } from '@shared/types'
import { run } from './api'
import { overlayCoversContent, uiStore } from './ui'

/**
 * The desktop's ambient install offer, in Chrome's form (PWA-03; the Design Lead's ruling on
 * W8-M3's item 3): the pill's Install chip stands while the page's app can be installed, and
 * the popover that hangs from it (`install/InstallPopover.tsx`) opens of its own accord once
 * per site when the core says the offer is due – `webapp.banner`, timed by the engagement the
 * core keeps for the app (`shared/webApp.ts`) – through the tab's `webapp.openInstall`, the
 * path a press on the chip takes, so the core holds the install open as it does for any other.
 * A popover that opened this way takes no focus (§9.22's notice rule: the user is reading the
 * page) and the chip stays, for the user to open it again. The phone's offer is the banner card
 * (`lib/installBanner.ts`); the desktop has no card to show one on.
 *
 * The memory here is the session's and per site, no more: the ruling asks for the one opening
 * per site and no cooldown of this surface's own.
 */

/** The sites whose offer has opened this session, by origin: once per site. */
const opened = new Set<string>()
/** The tab whose install prompt, when the core sends it, is the offer's and takes no focus. */
let offering: string | null = null

/** The core's offer for a tab: open the chip's popover, unless this site has had its one. */
export function autoOpenInstall(banner: WebAppBanner): void {
  if (opened.has(banner.origin)) return
  // Something stands over the page already – the URL bar, a menu, a popover, a dialog: the
  // offer does not push in under it, and the chip stays for the user.
  if (overlayCoversContent(uiStore.get())) return
  opened.add(banner.origin)
  offering = banner.tabId
  // TODO(services seed #42): the core moves the offer's cooldown from the event's emission to a
  // `webapp.bannerShown` report from the chrome, so the cooldown runs from an offer the user
  // saw. Report the opening here – `run('webapp.bannerShown', { tabId: banner.tabId })` – once
  // the command exists; no cooldown is kept on this side meanwhile.
  run('webapp.openInstall', { tabId: banner.tabId })
}

/**
 * Whether the install prompt arriving for `tabId` is the offer's own – asked once, by the
 * surface as it mounts, and answered once: the next prompt for the tab is the user's.
 */
export function takeOfferedInstall(tabId: string): boolean {
  const offered = offering === tabId
  offering = null
  return offered
}

/** For tests: forget the session's offers. */
export function resetInstallOffers(): void {
  opened.clear()
  offering = null
}
