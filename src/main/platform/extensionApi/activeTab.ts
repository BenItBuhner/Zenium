import type { Tab } from '../../../shared/types'
import { matchesAnyPattern } from '../../../core/extensions/api/matchPattern'
import { TAB_CAPTURE_PERMISSION } from '../../../core/extensions/api/tabCapture'
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
 *
 * The same gesture grants an extension holding `tabCapture` the right to capture that tab
 * (Chrome's `tabCaptureForTab`, granted by the same `ActiveTabPermissionGranter`), whatever the
 * tab's scheme: `tabCapture.capture` / `getMediaStreamId` refuse a tab the extension was not
 * invoked on. Ends with the same navigation or close.
 */
export class ActiveTabGrants {
  /** Grants per extension, by Chrome tab id. */
  private readonly grants = new Map<string, Map<number, Grant>>()
  /** Capture grants per extension, by Chrome tab id, with the origin they were made on. */
  private readonly captureGrants = new Map<string, Map<number, string | null>>()

  constructor(private readonly host: ApiHost) {}

  /** The extension was invoked on `tab` by the user. */
  grant(extensionId: string, tab: Tab): void {
    const permissions = this.host.grants(extensionId).permissions
    const origin = originPattern(tab.url)
    const tabId = this.host.model.chromeTabId(tab)
    if (permissions.includes('activeTab') && origin) {
      const perTab = this.grants.get(extensionId) ?? new Map<number, Grant>()
      perTab.set(tabId, { origin, zenTabId: tab.id })
      this.grants.set(extensionId, perTab)
    }
    if (permissions.includes(TAB_CAPTURE_PERMISSION)) {
      const perTab = this.captureGrants.get(extensionId) ?? new Map<number, string | null>()
      perTab.set(tabId, origin)
      this.captureGrants.set(extensionId, perTab)
    }
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

  /** Whether the user invoked the extension on this tab since it last changed origin (`tabCapture`). */
  allowsCapture(extensionId: string, tabId: number): boolean {
    return this.captureGrants.get(extensionId)?.has(tabId) ?? false
  }

  /** A tab committed a navigation: grants for another origin end. */
  navigated(tabId: number, url: string): void {
    for (const perTab of this.grants.values()) {
      const grant = perTab.get(tabId)
      if (grant && !matchesAnyPattern(url, [grant.origin])) perTab.delete(tabId)
    }
    for (const perTab of this.captureGrants.values()) {
      if (!perTab.has(tabId)) continue
      const origin = perTab.get(tabId)
      if (origin === null || origin === undefined || !matchesAnyPattern(url, [origin]))
        perTab.delete(tabId)
    }
  }

  tabRemoved(tabId: number): void {
    for (const perTab of this.grants.values()) perTab.delete(tabId)
    for (const perTab of this.captureGrants.values()) perTab.delete(tabId)
  }

  forget(extensionId: string): void {
    this.grants.delete(extensionId)
    this.captureGrants.delete(extensionId)
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
