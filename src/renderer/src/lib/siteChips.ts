import type { TabCapture } from '@shared/captureState'
import { FILE_SITE } from '@shared/contentSettings'
import type { IndicatorState } from '@shared/siteInfo'
import type { Tab, UIState } from '@shared/types'
import { originOf } from './security'

/**
 * What the URL pill's site-information slot says of a site's permissions (omnibox-38, design
 * language v2 §9.29): the slot's glyph is the site's state, one at a time – a certificate
 * error's danger glyph, else the camera / microphone / screen the page is using right now, else
 * the crossed-out glyph of the first permission the user blocked on the site, else the Memory
 * Saver leaf of a tab just woken from sleep (omnibox-40), else the connection's own glyph –
 * never a second chip for a state the slot can carry (at the 240 sidebar an added 28 px chip
 * takes the address under its floor). The words and the readings live here, apart from the chip
 * that draws them, so they are tested without a DOM.
 */

/**
 * The permissions whose block the slot shows, in the pill's order (Chrome shows these four as
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

/** A blocked permission's name in the slot's sentence: Chrome's word for it (§9.1). */
function blockedPermissionName(permission: BlockedPermission): string {
  switch (permission) {
    case 'camera':
      return 'camera'
    case 'microphone':
      return 'microphone'
    case 'geolocation':
      return 'location'
    case 'notifications':
      return 'notifications'
  }
}

/** One blocked permission's name, Chrome's word for it in a sentence of ours (§9.1). */
export function blockedPermissionLabel(permission: BlockedPermission): string {
  return blockedPermissionsLabel([permission])
}

/**
 * The slot's name while the site has blocks: every blocked permission listed, in the pill's
 * order – "Camera and microphone blocked", "Camera, location and notifications blocked" – since
 * the slot draws the first one's glyph alone (§9.29).
 */
export function blockedPermissionsLabel(permissions: readonly BlockedPermission[]): string {
  const names = permissions.map(blockedPermissionName)
  const list =
    names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} blocked`
}

/** The glyph for a live capture: Chrome's camera when the camera is on (with or without the microphone), the microphone alone, or the sharing glyph. */
export type CaptureGlyph = 'camera' | 'microphone' | 'display'

export function captureGlyph(capture: TabCapture): CaptureGlyph {
  if (capture.camera) return 'camera'
  if (capture.microphone) return 'microphone'
  return 'display'
}

/**
 * The live capture's name and tooltip: what the page holds, every kind named (Chrome: "This
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

/** The glyph a blocked permission puts in the slot: the permission's, crossed out. */
export type BlockedGlyph = `${BlockedPermission}-off`

/**
 * How long the Memory Saver leaf stands in the slot after a tab wakes from sleep (omnibox-40):
 * Chrome's chip collapses after about ten seconds; ours leaves the slot then, unless its bubble
 * is open (`held`), when it stays for as long as the bubble does (§9.20: the anchor of an open
 * popover keeps its place).
 */
export const MEMORY_SAVER_LEAF_MS = 10_000

/** The leaf's name: Chrome's sentence, the number the discard recorded. */
export function memorySaverLabel(savedMb: number): string {
  return `Memory Saver freed up ${savedMb} MB`
}

/**
 * The state the site-information slot carries in place of the connection's glyph: a live
 * capture, the site's standing blocks, or the leaf of a tab just woken from sleep. `label` is
 * the state's name – the chip's tooltip, and what the chip's name appends to "Site
 * information" (`siteChipName`).
 */
export type SiteSlotState =
  | { kind: 'capture'; glyph: CaptureGlyph; label: string }
  | {
      kind: 'blocked'
      glyph: BlockedGlyph
      /** Every permission blocked on the site, in the pill's order; the glyph is the first's. */
      permissions: BlockedPermission[]
      label: string
    }
  | {
      /** The tab woke from sleep a moment ago (`Tab.memorySaver`): the leaf, its bubble on a click. */
      kind: 'memory-saver'
      glyph: 'leaf'
      savedMb: number
      label: string
    }

/**
 * What the slot's decision reads beyond the state: the clock, for the leaf's ten seconds, and
 * whether the leaf's bubble is up, which holds the leaf past them.
 */
export interface SiteSlotOptions {
  /** The moment the slot is read at; the wall clock when left out. */
  now?: number
  /** The Memory Saver bubble is open on this tab: its leaf stays for as long as it is. */
  leafHeld?: boolean
}

/**
 * The Memory Saver leaf for the tab, while it stands (omnibox-40): the tab woke from sleep
 * within `MEMORY_SAVER_LEAF_MS` of `now`, or its bubble is open. Null otherwise – a record older
 * than the window says nothing, however long it lingers on the tab (the core clears it at the
 * next sleep).
 */
export function memorySaverLeaf(
  tab: Tab | null | undefined,
  options: SiteSlotOptions = {}
): Extract<SiteSlotState, { kind: 'memory-saver' }> | null {
  const saver = tab?.memorySaver ?? null
  if (!saver) return null
  const now = options.now ?? Date.now()
  if (!options.leafHeld && now - saver.wokeAt >= MEMORY_SAVER_LEAF_MS) return null
  return {
    kind: 'memory-saver',
    glyph: 'leaf',
    savedMb: saver.savedMb,
    label: memorySaverLabel(saver.savedMb)
  }
}

/**
 * Which state the slot shows for the tab, by §9.29's precedence: a certificate error's danger
 * glyph beats everything (the identity is in question, so the connection's glyph stays and this
 * returns null); a live capture (`Tab.capture`, folded from the frames' reports) beats a
 * standing block; a stored site-level block beats the leaf of a tab just woken from sleep (a
 * decision of the user's over a passing notice); the leaf beats the connection's own glyph;
 * null where the connection's glyph is all there is. A masked private tab is no page to the
 * pill (the caller passes no tab).
 */
export function siteSlotState(
  state: UIState,
  tab: Tab | null | undefined,
  indicator: IndicatorState,
  options: SiteSlotOptions = {}
): SiteSlotState | null {
  if (!tab || indicator === 'certificate-error') return null
  const capture = tab.capture ?? null
  if (capture)
    return { kind: 'capture', glyph: captureGlyph(capture), label: captureLabel(capture) }
  const permissions = blockedPermissionsOf(state, tab)
  const first = permissions[0]
  if (first) {
    return {
      kind: 'blocked',
      glyph: `${first}-off`,
      permissions,
      label: blockedPermissionsLabel(permissions)
    }
  }
  return memorySaverLeaf(tab, options)
}

/**
 * The slot's accessible name (§9.1): "Site information" alone while the glyph is the
 * connection's, "Site information · <state>" while it carries a state – the state's name after
 * the middle dot, as an aside on the heading's line is written.
 */
export function siteChipName(slot: SiteSlotState | null): string {
  return slot ? `Site information · ${slot.label}` : 'Site information'
}
