import type { Tab } from '@shared/types'
import { matchesAnyPattern } from '@core/extensions/api/matchPattern'

/**
 * Chrome's `activeTab` on Android: a user gesture on the extension (its toolbar button, one of
 * its long-press menu items, its command) grants it the tab's origin until the tab leaves that
 * origin or closes. What the grant unlocks here is what Chrome unlocks and the engine cannot
 * check on its own: `tabs.captureVisibleTab` of the tab, and cookie and navigation details of
 * pages the manifest's host permissions do not name. Content scripts and `scripting` keep to the
 * manifest, as on the desktop host.
 */
export class ActiveTabGrants {
  /** extension id → core tab id → the origin pattern the grant covers. */
  private readonly grants = new Map<string, Map<string, string>>()

  constructor(private readonly hasPermission: (extensionId: string) => boolean) {}

  /**
   * The user invoked the extension on `tab`, whose page reads as `url` to extensions (the tab's
   * own address unless the host presents another, as for the PDF viewer's tab).
   */
  grant(extensionId: string, tab: Tab, url: string = tab.url): void {
    if (!this.hasPermission(extensionId)) return
    const origin = originPattern(url)
    if (!origin) return
    let perTab = this.grants.get(extensionId)
    if (!perTab) {
      perTab = new Map()
      this.grants.set(extensionId, perTab)
    }
    perTab.set(tab.id, origin)
  }

  /** Whether the extension holds a grant on the tab (its page is still the granted origin). */
  has(extensionId: string, tabId: string): boolean {
    return this.grants.get(extensionId)?.has(tabId) ?? false
  }

  /** Whether some grant of the extension covers `url`. */
  allowsUrl(extensionId: string, url: string): boolean {
    const perTab = this.grants.get(extensionId)
    if (!perTab || !url) return false
    for (const origin of perTab.values()) if (matchesAnyPattern(url, [origin])) return true
    return false
  }

  /** A tab committed a navigation: grants for another origin end. */
  navigated(tabId: string, url: string): void {
    for (const perTab of this.grants.values()) {
      const origin = perTab.get(tabId)
      if (origin && !matchesAnyPattern(url, [origin])) perTab.delete(tabId)
    }
  }

  tabRemoved(tabId: string): void {
    for (const perTab of this.grants.values()) perTab.delete(tabId)
  }

  forget(extensionId: string): void {
    this.grants.delete(extensionId)
  }
}

/** `https://example.com/*` for a page URL; null for URLs no host permission could name. */
export function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:')
      return null
    if (parsed.protocol === 'file:') return 'file:///*'
    return `${parsed.protocol}//${parsed.host}/*`
  } catch {
    return null
  }
}
