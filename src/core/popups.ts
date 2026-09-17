import type { BlockedPopup } from '../shared/types'
import type { Browser } from './browser'
import { safeOrigin } from './permissions'

/** How long a trusted input event keeps a page activated (Chromium's transient activation). */
export const ACTIVATION_LIFESPAN_MS = 5000

/** Blocked pop-ups remembered per tab; older ones fall off the list. */
const MAX_BLOCKED = 20

/**
 * Chromium's user-activation model for one page: trusted input (a click, a key, a tap) activates
 * the page for a few seconds, opening a window uses that activation up, and a new document starts
 * from scratch. Hosts feed it from their input pipeline (Electron's `input-event`, the WebView's
 * touch and key dispatch) and the page script reports `navigator.userActivation` on top.
 */
export class UserActivation {
  private lastAt = -Infinity
  private ever = false

  activate(now: number): void {
    this.lastAt = now
    this.ever = true
  }

  /** `navigator.userActivation.isActive`: a gesture happened within the last few seconds. */
  isActive(now: number): boolean {
    return now >= this.lastAt && now - this.lastAt < ACTIVATION_LIFESPAN_MS
  }

  /** `navigator.userActivation.hasBeenActive`: the page saw a gesture at some point. */
  hasBeenActive(): boolean {
    return this.ever
  }

  /** One pop-up per gesture: allowing a window spends the transient activation. */
  consume(): void {
    this.lastAt = -Infinity
  }

  reset(): void {
    this.lastAt = -Infinity
    this.ever = false
  }
}

/**
 * The pop-up blocker. A page may open a window when the user just interacted with it or when the
 * user allowed pop-ups on its site for good; anything else is kept in a per-tab list that the URL
 * bar shows, so the user can open the pages anyway or allow the site.
 */
export class PopupBlocker {
  private readonly activations = new Map<string, UserActivation>()
  private readonly blocked = new Map<string, BlockedPopup[]>()

  constructor(
    private readonly browser: Browser,
    private readonly now: () => number = Date.now
  ) {}

  activation(tabId: string): UserActivation {
    let a = this.activations.get(tabId)
    if (!a) {
      a = new UserActivation()
      this.activations.set(tabId, a)
    }
    return a
  }

  /** A trusted input event reached the page. */
  activate(tabId: string): void {
    this.activation(tabId).activate(this.now())
  }

  /** A new document: activation and the blocked list start over (Chrome forgets them as well). */
  onNavigated(tabId: string, inPage: boolean): void {
    if (inPage) return
    this.activation(tabId).reset()
    if (this.blocked.delete(tabId)) this.browser.state.commitVolatile()
  }

  onTabGone(tabId: string): void {
    this.activations.delete(tabId)
    if (this.blocked.delete(tabId)) this.browser.state.commitVolatile()
  }

  /**
   * Whether the page in `tabId` may open `url` now. `hostGesture` is the host's own verdict where
   * it has one (Android's `isUserGesture`) and null where it does not (Electron).
   */
  decide(
    tabId: string,
    openerUrl: string,
    url: string,
    hostGesture: boolean | null
  ): 'allow' | 'blocked' {
    const stored = this.browser.permissions.stored('popups', openerUrl)
    if (stored === 'allow') return 'allow'
    const activation = this.activation(tabId)
    const active = hostGesture === true || activation.isActive(this.now())
    if (active && stored !== 'deny') {
      activation.consume()
      return 'allow'
    }
    this.record(tabId, url)
    return 'blocked'
  }

  /** A host or the page script saw a pop-up (or an app launch) get blocked: list it for the user. */
  record(tabId: string, url: string, kind: BlockedPopup['kind'] = 'popup'): void {
    if (!this.browser.tabs.tab(tabId)) return
    const list = this.blocked.get(tabId) ?? []
    if (!list.some((p) => p.url === url)) {
      list.push({ url, at: this.now(), kind })
      while (list.length > MAX_BLOCKED) list.shift()
    }
    this.blocked.set(tabId, list)
    this.browser.state.commitVolatile()
  }

  blockedFor(tabId: string): BlockedPopup[] {
    return this.blocked.get(tabId) ?? []
  }

  all(): Record<string, BlockedPopup[]> {
    const out: Record<string, BlockedPopup[]> = {}
    for (const [tabId, list] of this.blocked) if (list.length) out[tabId] = list
    return out
  }

  /**
   * "Open anyway": a blocked page becomes a tab next to its opener (without `window.opener`); a
   * blocked app launch goes through the external-app prompt, this time with the user's gesture.
   */
  open(tabId: string, url: string): void {
    const list = this.blocked.get(tabId)
    const entry = list?.find((p) => p.url === url)
    if (!list || !entry) return
    const remaining = list.filter((p) => p.url !== url)
    if (remaining.length) this.blocked.set(tabId, remaining)
    else this.blocked.delete(tabId)
    if (entry.kind === 'external') void this.browser.external.launch(tabId, url, true)
    else this.openAsTab(tabId, url)
    this.browser.state.commitVolatile()
  }

  dismiss(tabId: string): void {
    if (this.blocked.delete(tabId)) this.browser.state.commitVolatile()
  }

  /** Whether the site of `url` may open pop-ups without a gesture. */
  siteAllowed(url: string): boolean {
    return this.browser.permissions.stored('popups', url) === 'allow'
  }

  /**
   * "Always allow pop-ups on this site" for the tab's current site. Allowing also opens what was
   * blocked so far, like Chrome does; hosts that gate pop-ups themselves are told about the site.
   */
  setSiteAllowed(tabId: string, allow: boolean): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return
    const origin = safeOrigin(tab.url)
    if (!origin || origin === 'null') return
    if (allow) this.browser.permissions.remember('popups', tab.url, 'allow')
    else this.browser.permissions.forget('popups', tab.url)
    this.browser.tabs.syncPopupPolicy(origin)
    if (allow) {
      const list = this.blocked.get(tabId) ?? []
      const external = list.filter((p) => p.kind === 'external')
      if (external.length) this.blocked.set(tabId, external)
      else this.blocked.delete(tabId)
      for (const p of list) if (p.kind === 'popup') this.openAsTab(tabId, p.url)
    }
    this.browser.state.commitVolatile()
  }

  private openAsTab(tabId: string, url: string): void {
    const parent = this.browser.tabs.tab(tabId)
    this.browser.tabs.createTab(
      {
        url,
        spaceId: parent?.spaceId ?? undefined,
        containerId: parent?.containerId,
        active: true,
        afterTabId: parent && !parent.essential ? parent.id : undefined
      },
      this.browser.tabs.windowFor(tabId)
    )
  }
}
