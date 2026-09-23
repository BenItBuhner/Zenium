import type { TabCapture } from '@shared/captureState'
import { FILE_SITE } from '@shared/contentSettings'
import type { Tab, UIState } from '@shared/types'
import { originOf } from './security'

/**
 * What the URL pill says of a site's permissions (omnibox-38, Chrome's location bar): the
 * in-use chip while the page holds the camera, the microphone or the screen, and a crossed-out
 * icon at rest for each permission the user blocked on the site. The words and the readings
 * live here, apart from the chips that draw them, so they are tested without a DOM.
 */

/**
 * The permissions whose block the pill shows, in the pill's order (Chrome shows these four as
 * crossed-out icons; the rest – MIDI, clipboard, pop-ups – have no icon of their own or, for
 * pop-ups, the blocked pop-ups chip). The names are the engine's rows (`camera` and
 * `microphone` apart, as `permissions.ts` stores them).
 */
export const BLOCKED_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications'] as const

export type BlockedPermission = (typeof BLOCKED_PERMISSIONS)[number]

/**
 * The site the engine keys a page's permissions by (`permissionSite` in `core/permissions.ts`):
 * the URL's origin, and one shared site for local files (#139).
 */
export function permissionSiteOf(url: string): string | null {
  if (url.startsWith('file:')) return FILE_SITE
  return originOf(url)
}

/**
 * The permissions the user blocked on the tab's site, in the pill's order: a stored `deny` of
 * the site's own (`UIState.permissionRules`, live from the engine), not a default the page ran
 * into – the engine keeps no word of a request it refused by default, and Chrome's icon marks
 * a decision for the site. Read-only against the engine's rules.
 */
export function blockedPermissionsOf(
  state: UIState,
  tab: Tab | null | undefined
): BlockedPermission[] {
  const site = tab ? permissionSiteOf(tab.url) : null
  if (!site) return []
  const denied = new Set<string>()
  for (const rule of state.permissionRules) {
    if (rule.origin === site && rule.decision === 'deny') denied.add(rule.permission)
  }
  return BLOCKED_PERMISSIONS.filter((p) => denied.has(p))
}

/** The blocked icon's name, Chrome's word for it in a sentence of ours (§9.1). */
export function blockedPermissionLabel(permission: BlockedPermission): string {
  switch (permission) {
    case 'camera':
      return 'Camera blocked'
    case 'microphone':
      return 'Microphone blocked'
    case 'geolocation':
      return 'Location blocked'
    case 'notifications':
      return 'Notifications blocked'
  }
}

/** The glyph the in-use chip draws: Chrome's camera when the camera is on (with or without the microphone), the microphone alone, or the sharing glyph. */
export type CaptureGlyph = 'camera' | 'microphone' | 'display'

export function captureGlyph(capture: TabCapture): CaptureGlyph {
  if (capture.camera) return 'camera'
  if (capture.microphone) return 'microphone'
  return 'display'
}

/**
 * The in-use chip's name and tooltip: what the page holds, every kind named (Chrome: "This
 * page is accessing your camera and microphone"), the screen share after the devices.
 */
export function captureLabel(capture: TabCapture): string {
  const devices = [capture.camera && 'camera', capture.microphone && 'microphone']
    .filter((d): d is string => Boolean(d))
    .join(' and ')
  if (devices && capture.display)
    return `This page is using your ${devices} and sharing your screen`
  if (devices) return `This page is using your ${devices}`
  return 'This page is sharing your screen'
}
