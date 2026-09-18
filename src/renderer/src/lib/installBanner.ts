import type { WebAppBanner } from '@shared/types'
import { run } from '@renderer/lib/api'
import { uiStore } from '@renderer/lib/ui'

/**
 * The ambient "Add <app> to Home screen" prompt (PWA-03) behind one seam. Today it is the
 * chrome's own `InstallBanner` panel laid out above the content card (`uiStore.installBanner`,
 * mounted by `PhoneShell`). PR #72 owns the shared top-message surface (`showBanner` in
 * `lib/ui.ts`); once it lands, `presentInstallBanner` and `retireInstallBanner` route there –
 * title "Add <app> to Home screen", the origin as detail, key "install", one primary "Add" that
 * calls `acceptInstallBanner`, a swipe reported through `dismissInstallBanner` – and nothing
 * else moves: the core's events, the card and the preview state all come through this module.
 */

/** The core raised the prompt for a tab; one already up for that tab is replaced. */
export function presentInstallBanner(banner: WebAppBanner): void {
  uiStore.set({ installBanner: banner })
}

/**
 * The core took the prompt down: its timer ran out, the page left the app, another tab came to
 * the front, or the install sheet opened for the tab. Not the user's doing, so no cooldown.
 */
export function retireInstallBanner(tabId: string): void {
  uiStore.set((s) => (s.installBanner?.tabId === tabId ? { installBanner: null } : {}))
}

/** Whether the prompt is up for `tabId` (the preview host waits on it). */
export function installBannerShown(tabId: string): boolean {
  return uiStore.get().installBanner?.tabId === tabId
}

/** "Add": the install sheet opens for the banner's tab, through the core like the menu item. */
export function acceptInstallBanner(banner: WebAppBanner): void {
  run('webapp.openInstall', { tabId: banner.tabId })
}

/** The user swiped the prompt away: the core starts the app's cooldown. */
export function dismissInstallBanner(banner: WebAppBanner): void {
  run('webapp.dismissBanner', { tabId: banner.tabId, reason: 'swipe' })
}
