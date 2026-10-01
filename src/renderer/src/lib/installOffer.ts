import type { WebAppBanner } from '@shared/types'
import { run } from './api'
import {
  bannerSurfaceMounted,
  captureActiveTab,
  invalidateSnapshot,
  overlayCoversContent,
  returnFocusToPage,
  uiStore
} from './ui'

/**
 * The desktop's ambient install offer, in Chrome's form (PWA-03; the Design Lead's ruling on
 * W8-M3's item 3): the pill's Install chip stands while the page's app can be installed, and
 * the popover that hangs from it (`install/InstallPopover.tsx`) opens of its own accord when
 * the core says the offer is due – `webapp.banner`, timed by the engagement the core keeps for
 * the app (`shared/webApp.ts`: the visits, the day after a prompt, the fortnight after a
 * refusal). The popover is the desktop's card for the core's banner, as the top banner is the
 * phone's (`lib/installBanner.ts`), and it answers the core the same way: the word that the
 * card is drawn goes at once (`webapp.bannerShown`, which stamps the app's cooldown; a surface
 * mounted to draw it, `bannerSurfaceMounted`, is the condition there as here), its Cancel is
 * the card's swipe (`webapp.dismissBanner` 'swipe': the refusal's longer interval), and a
 * light dismiss, Escape, the tab leaving or the popover's own clock – the band's offer clock,
 * `BAND_CLOCK_MS`, kept in the popover: it waits under the pointer and the keyboard (motion
 * spec §10) – running out is the card's clock running out ('timeout': the stamp stands, no
 * refusal). Install runs the install path of old (`webapp.pin`). The memory is
 * the core's, none of this surface's own: an offer that cannot open – something stands over the
 * page already – sends no word, so the core's grace counts the prompt as undrawn and the site
 * keeps its turn. A popover that opened this way takes no focus (§9.22's notice rule: the user
 * is reading the page) and the chip stays, for the user to open it again – through
 * `webapp.openInstall`, the user's path, whose prompt is `uiStore.install`'s.
 */

/** The banner whose capture is still out, by tab: the popover opens once the page's picture is in. */
const opening = new Map<string, WebAppBanner>()

/** Whether the offer stands for `tabId`: its popover up, or on its way. */
function offerUpFor(tabId: string): boolean {
  const offer = uiStore.get().installOffer
  return opening.has(tabId) || (offer !== null && !offer.retired && offer.banner.tabId === tabId)
}

/** The core's offer for a tab: the popover opens of its own accord, and the core hears it drawn. */
export function autoOpenInstall(banner: WebAppBanner): void {
  // Raised again for a tab whose popover is up: the popover stands as it is, and the word goes
  // again for the new banner's grace, as the phone's replaced card answers again.
  if (offerUpFor(banner.tabId)) {
    run('webapp.bannerShown', { tabId: banner.tabId })
    return
  }
  // Something stands over the page already – the URL bar, a menu, a popover, a dialog – or no
  // surface is mounted to draw the popover: the offer does not push in, no word goes, and the
  // core, hearing none inside its grace, keeps the site's turn.
  if (overlayCoversContent(uiStore.get()) || !bannerSurfaceMounted()) return
  run('webapp.bannerShown', { tabId: banner.tabId })
  void open(banner)
}

/** The popover stands over the page's picture like the prompt (`openInstallSheet`): the capture first. */
async function open(banner: WebAppBanner): Promise<void> {
  opening.set(banner.tabId, banner)
  await captureActiveTab(banner.tabId)
  // Retired while the capture was out: nothing to open, and the picture it waited on is no
  // one's – let go of, lest the next surface over the page find it stale.
  if (opening.get(banner.tabId) !== banner) {
    invalidateSnapshot()
    return
  }
  opening.delete(banner.tabId)
  run('focus.chrome', undefined)
  uiStore.set({ installOffer: { banner, retired: false }, drawerOpen: false })
}

/**
 * The core took the banner back (`webapp.bannerHide`): its clock ran out, the page left the
 * app, the install opened through the menu, or the app was installed. Not the user's doing, so
 * no report back: the popover leaves on its own, and an offer still on its way is let go.
 */
export function retireInstallOffer(tabId: string): void {
  opening.delete(tabId)
  const offer = uiStore.get().installOffer
  if (!offer || offer.banner.tabId !== tabId || offer.retired) return
  uiStore.set({ installOffer: { ...offer, retired: true } })
}

/** The popover for `tabId` has left: the page comes back, and the keyboard goes to it. */
export function closeInstallOffer(tabId: string): void {
  if (uiStore.get().installOffer?.banner.tabId !== tabId) return
  uiStore.set({ installOffer: null })
  invalidateSnapshot()
  returnFocusToPage()
}

/** For tests: forget an offer on its way or up. */
export function resetInstallOffers(): void {
  opening.clear()
  uiStore.set({ installOffer: null })
}
