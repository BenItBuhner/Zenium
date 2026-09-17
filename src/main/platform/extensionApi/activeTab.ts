import type { Tab } from '../../../shared/types'
import { matchesAnyPattern } from '../../../core/extensions/api/matchPattern'
import type { ApiHost } from './types'

interface Grant {
  /** The match pattern the grant covers (`https://example.com/*`). */
  origin: string
  zenTabId: string
}

/**
 * Chrome's `activeTab`: a user gesture on the extension (toolbar click, its command, one of its
 * context-menu items) grants it the active tab's origin as a host permission until the tab
 * navigates to another origin or closes. The grant widens what the browser layer reveals
 * (`tabs.*` URLs, `cookies`, `webNavigation` details); the engine's own content-script and
 * `scripting` checks stay with the manifest's host permissions, which Electron does not let the
 * host extend at run time.
 */
export class ActiveTabGrants {
  /** Grants per extension, by Chrome tab id. */
  private readonly grants = new Map<string, Map<number, Grant>>()

  constructor(private readonly host: ApiHost) {}

  /** The extension was invoked on `tab` by the user. */
  grant(extensionId: string, tab: Tab): void {
    if (!this.host.grants(extensionId).permissions.includes('activeTab')) return
    const origin = originPattern(tab.url)
    if (!origin) return
    const tabId = this.host.model.chromeTabId(tab)
    const perTab = this.grants.get(extensionId) ?? new Map<number, Grant>()
    perTab.set(tabId, { origin, zenTabId: tab.id })
    this.grants.set(extensionId, perTab)
  }

  /** Whether an `activeTab` grant covers `url` (any tab the extension was invoked on). */
  allowsUrl(extensionId: string, url: string): boolean {
    const perTab = this.grants.get(extensionId)
    if (!perTab || !url) return false
    for (const grant of perTab.values()) {
      if (matchesAnyPattern(url, [grant.origin])) return true
    }
    return false
  }

  /** Whether the extension currently holds an `activeTab` grant on this tab. */
  hasGrantForTab(extensionId: string, tabId: number): boolean {
    return this.grants.get(extensionId)?.has(tabId) ?? false
  }

  /** A tab committed a navigation: grants for another origin end. */
  navigated(tabId: number, url: string): void {
    for (const perTab of this.grants.values()) {
      const grant = perTab.get(tabId)
      if (grant && !matchesAnyPattern(url, [grant.origin])) perTab.delete(tabId)
    }
  }

  tabRemoved(tabId: number): void {
    for (const perTab of this.grants.values()) perTab.delete(tabId)
  }

  forget(extensionId: string): void {
    this.grants.delete(extensionId)
  }
}

/** The `<scheme>://<host>/*` pattern of a URL, for the schemes `activeTab` applies to. */
export function originPattern(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol === 'file:') return 'file:///*'
  if (!['http:', 'https:', 'ftp:', 'ws:', 'wss:'].includes(parsed.protocol)) return null
  return `${parsed.protocol}//${parsed.host}/*`
}
