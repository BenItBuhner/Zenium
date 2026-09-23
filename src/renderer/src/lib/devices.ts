import type {
  DeviceChooser,
  DeviceGrant,
  DeviceKind,
  DevicePairingPrompt,
  UIState
} from '@shared/types'
import { run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { hostOf } from '@renderer/lib/siteSettings'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from '@renderer/lib/ui'

/**
 * The words and the state reads of the device chooser (MW-32..35: Web Bluetooth, WebUSB, Web
 * Serial, WebHID – `components/devices/DeviceChooserDialog`), its pairing prompt and the device
 * rows of the site-information surfaces and Settings › Site settings, kept apart from the
 * rendering so they can be read and tested on their own.
 */

/**
 * How long the chooser waits for the page's picture before it shows over a blank one: the page
 * keeps painting behind a `requestDevice()` call, so the capture is quick; a page that will not
 * answer does not hold the chooser.
 */
const SNAPSHOT_WAIT_MS = 250

/** The kinds in the catalogue's order (`shared/contentSettings.ts`): usb, serial, hid, bluetooth. */
export const DEVICE_KIND_ORDER: readonly DeviceKind[] = ['usb', 'serial', 'hid', 'bluetooth']

/** What one kind is called: the chooser's noun, Settings' and the site-information rows' label. */
export const DEVICE_KIND_WORDS: Record<DeviceKind, { noun: string; label: string }> = {
  usb: { noun: 'USB device', label: 'USB devices' },
  serial: { noun: 'serial port', label: 'Serial ports' },
  hid: { noun: 'HID device', label: 'HID devices' },
  bluetooth: { noun: 'Bluetooth device', label: 'Bluetooth devices' }
}

/** The chooser this window shows now: the request of its active tab (tab-modal, like Chrome's). */
export function currentDeviceChooser(state: UIState): DeviceChooser | null {
  const tabId = activeTab(state)?.id ?? null
  if (!tabId) return null
  return (
    state.deviceChoosers.find((c) => c.tabId === tabId) ??
    // A request the host could not place under a tab is shown where it came up: here.
    state.deviceChoosers.find((c) => c.tabId === null) ??
    null
  )
}

/** The pairing prompt over this window's active tab, if the OS is asking for one. */
export function currentDevicePairing(state: UIState): DevicePairingPrompt | null {
  const tabId = activeTab(state)?.id ?? null
  if (!tabId) return null
  return (
    state.devicePairings.find((p) => p.tabId === tabId) ??
    state.devicePairings.find((p) => p.tabId === null) ??
    null
  )
}

/**
 * Chrome's title line, in parts: who is asking – the requesting frame's site, as its host – and
 * "wants to connect to a <kind>". The host is kept apart from the words: an identity the user is
 * asked to trust is never elided (§9.23), so the dialog renders it with its break opportunities.
 */
export function chooserTitle(chooser: Pick<DeviceChooser, 'origin' | 'kind'>): {
  host: string
  asks: string
} {
  return {
    host: hostOf(chooser.origin),
    asks: `wants to connect to a ${DEVICE_KIND_WORDS[chooser.kind].noun}`
  }
}

/** The spinner line under a Bluetooth list still growing (§9.30). */
export const CHOOSER_SCANNING = 'Looking for devices…'
/** The empty state (§9.17). */
export const CHOOSER_EMPTY = 'No compatible devices found'
/** The notice under the empty state on Linux, as Chrome's chooser says it (`hint: 'linux-udev'`). */
export const CHOOSER_UDEV_HINT = 'On Linux, a udev rule may be needed for this device'

/**
 * The row the keyboard reaches by Tab in the chooser's radio list (§9.13, one roving stop): the
 * picked candidate while it is still listed, else the first; null on an empty list.
 */
export function chooserTabStop(
  candidates: ReadonlyArray<{ id: string }>,
  picked: string | null
): string | null {
  if (picked && candidates.some((c) => c.id === picked)) return picked
  return candidates[0]?.id ?? null
}

/**
 * Where the arrow keys take the pick in the list of `count` rows: Down and Up step, Home and
 * End go to the ends; null for any other key or a step off the list.
 */
export function listMove(key: string, index: number, count: number): number | null {
  let next: number
  switch (key) {
    case 'ArrowDown':
      next = index + 1
      break
    case 'ArrowUp':
      next = index - 1
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = count - 1
      break
    default:
      return null
  }
  return next >= 0 && next < count && next !== index ? next : null
}

/** A Bluetooth PIN as the pairing prompt accepts it: six digits, nothing else. */
export const PIN_LENGTH = 6
export function isCompletePin(pin: string): boolean {
  return pin.length === PIN_LENGTH && /^\d+$/.test(pin)
}
/** What a keystroke may leave in the PIN field: digits only, no more than six. */
export function sanitizePin(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, PIN_LENGTH)
}

/** "Pair with <device>", the pairing prompt's title (the identity never elided, §9.23). */
export function pairingTitle(prompt: Pick<DevicePairingPrompt, 'deviceName'>): string {
  return `Pair with ${prompt.deviceName}`
}

/** The pairing prompt's description, by what the OS wants. */
export function pairingDescription(prompt: DevicePairingPrompt): string {
  switch (prompt.kind) {
    case 'confirm':
      return `${prompt.deviceName} wants to pair with this computer.`
    case 'confirmPin':
      return `Check that this PIN matches the one shown on ${prompt.deviceName}.`
    case 'providePin':
      return `Enter the six-digit PIN shown on ${prompt.deviceName}.`
  }
}

/** A site's device grants of one kind, oldest first; [] for a kind it has none of. */
export function grantsOf(
  grants: readonly DeviceGrant[],
  origin: string,
  kind: DeviceKind
): DeviceGrant[] {
  return grants
    .filter((g) => g.origin === origin && g.kind === kind)
    .sort((a, b) => a.grantedAt - b.grantedAt)
}

/**
 * A site's grants by kind, in the catalogue's order, kinds with none left out: the
 * site-information rows ("USB devices — 2") and the Settings exception's device list.
 */
export function grantsByKind(
  grants: readonly DeviceGrant[],
  origin: string
): Array<{ kind: DeviceKind; grants: DeviceGrant[] }> {
  return DEVICE_KIND_ORDER.map((kind) => ({ kind, grants: grantsOf(grants, origin, kind) })).filter(
    (group) => group.grants.length > 0
  )
}

/** The sites holding grants of one kind, hosts alphabetically, each with its count. */
export function sitesWithGrants(
  grants: readonly DeviceGrant[],
  kind: DeviceKind
): Array<{ origin: string; count: number }> {
  const counts = new Map<string, number>()
  for (const g of grants) {
    if (g.kind !== kind) continue
    counts.set(g.origin, (counts.get(g.origin) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => hostOf(a).localeCompare(hostOf(b)))
    .map(([origin, count]) => ({ origin, count }))
}

/**
 * A grant's second line: the vendor and product ids as four hex digits each (`0403:6001`, the
 * way `lsusb` and Chrome's chooser print them), else the serial number, else nothing.
 */
export function grantDetail(grant: DeviceGrant): string {
  if (grant.vendorId !== null && grant.productId !== null)
    return `${hex4(grant.vendorId)}:${hex4(grant.productId)}`
  return grant.serialNumber ?? ''
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0')
}

/** "<Kind label> — N", the site-information row's label for a kind the site has grants of. */
export function grantsRowLabel(kind: DeviceKind, count: number): string {
  return `${DEVICE_KIND_WORDS[kind].label} — ${count}`
}

/** The chooser is about to show over `tabId`: the page gives way to its picture, the chrome takes the keyboard. */
export async function openDeviceChooser(tabId: string | null): Promise<void> {
  if (tabId) {
    await Promise.race([
      captureActiveTab(tabId),
      new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
    ])
  }
  run('focus.chrome', undefined)
  uiStore.set({ deviceChooserOpen: true })
}

export function closeDeviceChooser(): void {
  if (uiStore.get().deviceChooserOpen) uiStore.set({ deviceChooserOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}
