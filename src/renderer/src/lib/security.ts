import type { BlockedPopup, SecurityPrompt, Tab, UIState } from '@shared/types'
import { activeTab } from '@renderer/lib/selectors'
import { uiStore } from '@renderer/lib/ui'

export function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/** `https://example.com` reads as `example.com`; anything else keeps its scheme. */
export function siteLabel(origin: string): string {
  return origin.replace(/^https:\/\//, '')
}

export function popupsAllowedFor(state: UIState, tab: Tab | null | undefined): boolean {
  const origin = tab ? originOf(tab.url) : null
  return Boolean(
    origin &&
    state.permissionRules.some(
      (r) => r.permission === 'popups' && r.origin === origin && r.decision === 'allow'
    )
  )
}

export function blockedPopupsOf(state: UIState, tabId: string | null | undefined): BlockedPopup[] {
  return (tabId && state.blockedPopups[tabId]) || []
}

/** Show the list for a tab; `anchor` is where the address pill's indicator is (window px). */
export function openBlockedPopups(tabId: string, anchor: DOMRect | null): void {
  uiStore.set({
    blockedPopupsPanel: {
      tabId,
      anchor: anchor
        ? { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }
        : null
    }
  })
}

/** The prompt this window should show now: its active tab's, or one that belongs to no page. */
export function currentSecurityPrompt(state: UIState): SecurityPrompt | null {
  const tabId = activeTab(state)?.id ?? null
  return state.securityPrompts.find((p) => p.tabId === null || p.tabId === tabId) ?? null
}
