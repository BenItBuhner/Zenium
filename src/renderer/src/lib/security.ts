import type { BlockedPopup, PermissionRule, SecurityPrompt, Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from '@renderer/lib/ui'

/** How long a security dialog waits for the page's picture before it shows over a blank one. */
const SNAPSHOT_WAIT_MS = 250

/** What a remembered per-site answer lets the site do, phrased after "may" / "may not". */
const RULE_LABELS: Record<string, string> = {
  popups: 'open pop-up windows',
  media: 'use the camera and microphone',
  camera: 'use the camera',
  microphone: 'use the microphone',
  geolocation: 'know your location',
  notifications: 'send notifications',
  midi: 'access MIDI devices',
  'clipboard-read': 'read the clipboard',
  mediaKeySystem: 'play protected (DRM) content',
  'window-management': 'manage windows on all displays',
  'idle-detection': 'know when you are active',
  'top-level-storage-access': 'let embedded sites use their cookies',
  fileSystem: 'write to files and folders you picked',
  'storage-access': 'use its cookies while embedded'
}

/** One sentence for a stored rule: "may open links in Zoom", "may not use the camera". */
export function describePermissionRule(rule: PermissionRule): string {
  const [permission, qualifier] = splitQualifier(rule.permission)
  const verb = rule.decision === 'allow' ? 'may' : 'may not'
  if (permission === 'openExternal') {
    return qualifier
      ? `${verb} hand ${qualifier}: links to another app`
      : `${verb} hand links to other apps`
  }
  if (permission === 'storage-access' && qualifier) {
    return `${verb} use its cookies inside ${siteLabel(qualifier)}`
  }
  const label = RULE_LABELS[permission] ?? permission.replace(/[-_]/g, ' ')
  return `${verb} ${label}`
}

function splitQualifier(permission: string): [string, string | null] {
  const colon = permission.indexOf(':')
  return colon === -1
    ? [permission, null]
    : [permission.slice(0, colon), permission.slice(colon + 1)]
}

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

/**
 * A security dialog is about to show over `tabId` (null for a proxy challenge with no page). The
 * page is waiting on the answer and may not have painted yet, so the dialog does not wait long
 * for its picture: the host hides the page either way.
 */
export async function openSecurityPrompt(tabId: string | null): Promise<void> {
  await Promise.race([
    captureActiveTab(tabId),
    new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
  ])
  run('focus.chrome', undefined)
  uiStore.set({ securityPromptOpen: true })
}

export function closeSecurityPrompt(): void {
  if (uiStore.get().securityPromptOpen) uiStore.set({ securityPromptOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

/** The prompt this window should show now: its active tab's, or one that belongs to no page. */
export function currentSecurityPrompt(state: UIState): SecurityPrompt | null {
  const tabId = activeTab(state)?.id ?? null
  return state.securityPrompts.find((p) => p.tabId === null || p.tabId === tabId) ?? null
}
