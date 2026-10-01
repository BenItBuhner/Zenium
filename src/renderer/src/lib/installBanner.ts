import { Smartphone } from 'lucide-react'
import type { WebAppBanner } from '@shared/types'
import { run } from '@renderer/lib/api'
import { dismissPosted, postBanner, postedShown, postedUp } from '@renderer/lib/band/post'
import { BAND_CLOCK_MS } from '@renderer/lib/motion/tokens'
import {
  bannerSurfaceMounted,
  type BannerDismissReason,
  type BannerOptions
} from '@renderer/lib/ui'

/**
 * The ambient "Add <app> to Home screen" prompt (PWA-03) behind one seam. The core raises and
 * lowers it (`webapp.banner`, `webapp.bannerHide`) and only cares how it went; the card is the
 * shared top banner (v2 §9.33) – on the touch hosts the page-edge band in its offer form
 * (motion spec §4; `lib/band/post.ts` is the door): the phone glyph on the title, the app's
 * origin as the detail, one "Add" that opens the install sheet through the core like the menu
 * item, the card's own swipe and close, and the one offer clock (`BAND_CLOCK_MS`, 10 s – the
 * Design Lead's ruling: one offer, one clock; the core runs none and hears it ran out as
 * `timeout`, which starts no cooldown). One banner at a time under the `install` key.
 * The card drawn is the core's word to start the app's cooldown (`webapp.bannerShown`): it
 * goes the moment the card is posted with a surface mounted that draws banners (the phone's
 * and the tablet's `MessageLayer`, under which the band is the door), so the phone's timing is
 * the store's own. The band may hold the card back at its post (§3.2: under a cover – a sheet,
 * the keyboard, the open tab overview – a prompt arriving waits): then the word goes with
 * `visible: false` – the card is accepted, the core's grace is spent, nothing is stamped – and
 * the plain word follows at the card's first drawn frame (`BandExtras.onShown`), where the
 * cooldown starts: it counts from a shown offer, not a posted one (seed #43, the Lead's S3).
 * Where no surface draws banners (the desktop's sidebar, #740) no word goes and the core,
 * hearing none inside its grace, counts the prompt as undrawn and takes it back.
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
    duration: BAND_CLOCK_MS,
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
    'offer',
    {
      // The band put away unanswered (the Back gesture, a swipe up; spec §9 item 6): the core
      // hears its banner is gone as for the clock – its bookkeeping clears, no cooldown starts.
      onAway: () => {
        if (shown.get(banner.tabId) === id) shown.delete(banner.tabId)
        run('webapp.dismissBanner', { tabId: banner.tabId, reason: 'timeout' })
      },
      // The band held the card back at its post and draws it now: the offer is seen from this
      // frame, so the cooldown starts here (the core takes a second word for one card as none).
      onShown: () => run('webapp.bannerShown', { tabId: banner.tabId })
    }
  )
  shown.set(banner.tabId, id)
  if (!bannerSurfaceMounted()) return
  // Today's word for a card on screen as it is posted; `visible: false` for one the band holds
  // back under a cover – accepted, not seen – whose stamp waits for `onShown`'s word.
  if (postedShown(id)) run('webapp.bannerShown', { tabId: banner.tabId })
  else run('webapp.bannerShown', { tabId: banner.tabId, visible: false })
}

/**
 * What the core hears: the user sent the card away (a swipe or its close – the app's cooldown
 * starts; on the band only the × says so, `onAway` above) or its clock ran out. "Add" needs no
 * report (the core opens the sheet and takes the banner down itself); a replacement or the
 * core's own take-down was not the user's doing.
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
