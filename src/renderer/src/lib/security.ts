import type {
  BlockedPopup,
  HttpAuthPrompt,
  PermissionPrompt,
  PermissionPromptAnswer,
  PermissionRule,
  SecurityPrompt,
  Tab,
  UIState
} from '@shared/types'
import { run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { dismissSiteInfo } from '@renderer/lib/siteInfo'
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

/**
 * One line for a stored rule, in sentence case for the description slot under the site's name:
 * "May hand zoommtg: links to another app", "May not use the camera".
 */
export function describePermissionRule(rule: PermissionRule): string {
  const [permission, qualifier] = splitQualifier(rule.permission)
  const verb = rule.decision === 'allow' ? 'May' : 'May not'
  if (permission === 'openExternal') {
    return qualifier
      ? `${verb} hand ${qualifier}: links to another app`
      : `${verb} hand links to other apps`
  }
  if (permission === 'storage-access' && qualifier) {
    return `${verb} use its cookies inside ${siteLabel(qualifier)}`
  }
  if (permission === 'fileSystem' && qualifier === 'read') {
    return `${verb} view the folders you picked`
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
 * Show the list for a tab; `anchor` is where the address pill's indicator is (window px). Hosts
 * hide page views under chrome overlays, so the page is captured first and its snapshot stands in
 * behind the panel. One popover at a time (§9.20): the site information, if up, goes first.
 */
export async function openBlockedPopups(tabId: string, anchor: DOMRect | null): Promise<void> {
  dismissSiteInfo()
  await captureActiveTab(tabId)
  run('focus.chrome', undefined)
  uiStore.set({
    blockedPopupsPanel: {
      tabId,
      anchor: anchor
        ? { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }
        : null
    }
  })
}

/**
 * The panel has left the screen: show the live page again. The page gets the keyboard back
 * unless the chrome keeps it (`focusPage` false: Escape returned focus to the indicator, §9.22).
 */
export function closeBlockedPopups(focusPage = true): void {
  if (uiStore.get().blockedPopupsPanel) uiStore.set({ blockedPopupsPanel: null })
  invalidateSnapshot()
  if (focusPage) returnFocusToPage()
}

/**
 * Which open of the security dialog is current: an open that finishes after a close (or after a
 * newer open) must not bring the page back under a dialog that is up, or hide it under none.
 */
let securityPromptGeneration = 0

/**
 * A security dialog is about to show over `tabId` (null for a proxy challenge with no page). The
 * page is waiting on the answer and may not have painted yet, so the dialog does not wait long
 * for its picture: the host hides the page either way. Resolves once the page is hidden, or at
 * once when a close or a newer open overtook this one.
 */
export async function openSecurityPrompt(tabId: string | null): Promise<void> {
  const generation = ++securityPromptGeneration
  await Promise.race([
    captureActiveTab(tabId),
    new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
  ])
  if (generation !== securityPromptGeneration) return
  run('focus.chrome', undefined)
  uiStore.set({ securityPromptOpen: true })
}

export function closeSecurityPrompt(): void {
  securityPromptGeneration++
  if (uiStore.get().securityPromptOpen) uiStore.set({ securityPromptOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

/** The prompt this window should show now: its active tab's, or one that belongs to no page. */
export function currentSecurityPrompt(state: UIState): SecurityPrompt | null {
  const tabId = activeTab(state)?.id ?? null
  return state.securityPrompts.find((p) => p.tabId === null || p.tabId === tabId) ?? null
}

/**
 * How long an answered sign-in form stays up, busy (§9.30), for the server to refuse the
 * credentials: a refusal challenges the same protection space again within a round trip, and
 * comes back as a new prompt with `failedBefore`; hearing nothing for this long means they were
 * accepted, and the form closes. A page that finishes loading behind the form ends the wait
 * early. A refusal that arrives later still shows – as a fresh dialog with the validation line.
 */
export const SIGN_IN_WAIT_MS = 1500

/**
 * The protection space an HTTP challenge belongs to (RFC 7235: the origin and the realm, a proxy's
 * apart from a server's), per tab: two prompts with the same space are one question asked twice
 * – the second is the answer to the first coming back refused – so the dialog stays the same
 * dialog across them.
 */
export function httpAuthSpace(prompt: HttpAuthPrompt): string {
  const proxy = prompt.isProxy ? 'proxy' : 'server'
  return `${prompt.tabId ?? ''}|${proxy}|${prompt.host}|${prompt.port}|${prompt.realm}`
}

/**
 * The permission prompt this window should show now: the oldest one of its active tab (or one
 * the host could not tie to a tab). Prompts of other tabs wait until their tab is active, and
 * a security prompt on the same tab goes first: its request is what the page is stuck on.
 */
export function currentPermissionPrompt(
  state: UIState,
  options: {
    /**
     * The phone's rule for a quiet prompt (NOT-03): it waits in the pill's bell and shows as a
     * sheet only once the bell was tapped for it (`quietPromptId`); a loud prompt behind it in
     * the queue is not held up. Left out (the desktop), every prompt shows in turn.
     */
    quietOpenId?: string | null
  } = {}
): PermissionPrompt | null {
  if (currentSecurityPrompt(state)) return null
  const tabId = activeTab(state)?.id ?? null
  const quietOpenId = options.quietOpenId
  return (
    state.permissionPrompts.find(
      (p) =>
        (p.tabId === null || p.tabId === tabId) &&
        (quietOpenId === undefined || p.quiet !== true || p.id === quietOpenId)
    ) ?? null
  )
}

/** The quiet notification prompt pending for `tabId` (NOT-03): what the pill's bell stands for. */
export function quietPermissionPrompt(state: UIState, tabId: string): PermissionPrompt | null {
  // Every host sends the list; states built by hand in tests may leave it out (as `mediaSession`).
  return (state.permissionPrompts ?? []).find((p) => p.tabId === tabId && p.quiet === true) ?? null
}

/** The pill's bell was tapped: the quiet prompt's sheet comes up. */
export function openQuietPrompt(id: string): void {
  uiStore.set({ quietPromptId: id })
}

/**
 * The quiet prompt's sheet closed without a word (pulled down, the scrim, the system back): the
 * bell stays up for it, and the core hears nothing – a quiet prompt is never dismissed, only
 * answered or withdrawn by the page leaving.
 */
export function closeQuietPrompt(): void {
  if (uiStore.get().quietPromptId !== null) uiStore.set({ quietPromptId: null })
}

/** A permission prompt is about to show over `tabId`: same page-snapshot dance as the security ones. */
export async function openPermissionPrompt(tabId: string | null): Promise<void> {
  await Promise.race([
    captureActiveTab(tabId),
    new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
  ])
  run('focus.chrome', undefined)
  uiStore.set({ permissionPromptOpen: true })
}

export function closePermissionPrompt(): void {
  if (uiStore.get().permissionPromptOpen) uiStore.set({ permissionPromptOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

/** Answer a permission prompt; the core remembers what needs remembering and resumes the page. */
export function answerPermissionPrompt(id: string, answer: PermissionPromptAnswer): void {
  run('permissions.respond', { id, answer })
}
