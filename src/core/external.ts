import type { Browser } from './browser'

/**
 * Links that leave the browser for another application (`mailto:`, `tel:`, `zoommtg:`, Android
 * `intent:`). Hosts whose engine does not gate these itself ask here: the launch needs a user
 * gesture, then the shared external-app prompt (remembered per site and scheme), and only then
 * the host hands the URL to the system. A launch attempted without a gesture is listed in the
 * tab's blocked pop-ups so the user can still trigger it deliberately.
 */
export class ExternalLaunches {
  constructor(
    private readonly browser: Browser,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Whether the page in `tabId` may hand `url` to another app now. `hostGesture` is the engine's
   * own verdict; a gesture the core saw itself moments ago counts as well, except for a server
   * redirect (`redirect`), which the engine attributes to the click that started the chain, so
   * one without a gesture never launches anything.
   */
  async request(
    tabId: string,
    url: string,
    hostGesture: boolean,
    targetApp?: string,
    redirect = false
  ): Promise<boolean> {
    const gesture =
      hostGesture || (!redirect && this.browser.popups.activation(tabId).isActive(this.now()))
    if (!gesture) {
      this.browser.popups.record(tabId, url, 'external')
      return false
    }
    return this.launch(tabId, url, false, targetApp)
  }

  /**
   * Ask (unless the site is remembered) and, when `openIfAllowed`, hand the URL to the system.
   * Resolves with the user's answer either way.
   */
  async launch(
    tabId: string,
    url: string,
    openIfAllowed: boolean,
    targetApp?: string
  ): Promise<boolean> {
    const tab = this.browser.tabs.tab(tabId)
    const pageUrl = tab?.url ?? ''
    const allowed = await this.browser.permissions.decide('openExternal', pageUrl, {
      externalUrl: url,
      targetApp
    })
    if (allowed && openIfAllowed) this.browser.platform.shell.openExternal(url)
    return allowed
  }
}
