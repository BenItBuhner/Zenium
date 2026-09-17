import type { Browser } from './browser'

/**
 * Links that leave the browser for another application (`mailto:`, `tel:`, `zoommtg:`) on hosts
 * whose engine does not gate these itself. Electron asks through its `openExternal` permission
 * without saying whether a gesture was behind the navigation, so the core's own activation
 * tracking decides: without one the launch is listed in the tab's blocked pop-ups so the user can
 * still trigger it deliberately; with one the shared external-app prompt (remembered per site
 * and scheme) decides, and only then does the host hand the URL to the system. The Android
 * WebView reports gestures itself and goes through `ExternalProtocolService` instead.
 */
export class ExternalLaunches {
  constructor(
    private readonly browser: Browser,
    private readonly now: () => number = Date.now
  ) {}

  /** Whether the page in `tabId` may hand `url` to another app now. */
  async request(tabId: string, url: string): Promise<boolean> {
    if (!this.browser.popups.activation(tabId).isActive(this.now())) {
      this.browser.popups.record(tabId, url, 'external')
      return false
    }
    return this.launch(tabId, url, false)
  }

  /**
   * Ask (unless the site is remembered) and, when `openIfAllowed`, hand the URL to the system.
   * Resolves with the user's answer either way.
   */
  async launch(tabId: string, url: string, openIfAllowed: boolean): Promise<boolean> {
    const tab = this.browser.tabs.tab(tabId)
    const pageUrl = tab?.url ?? ''
    const allowed = await this.browser.permissions.decide('openExternal', pageUrl, {
      externalUrl: url
    })
    if (allowed && openIfAllowed) this.browser.platform.shell.openExternal(url)
    return allowed
  }
}
