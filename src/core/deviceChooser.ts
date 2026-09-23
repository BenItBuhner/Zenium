import type { Browser } from './browser'
import { permissionSite } from './permissions'
import { newId } from '../shared/ids'
import type {
  DeviceCandidate,
  DeviceChooser,
  DeviceKind,
  DevicePairingPrompt,
  DevicePairingResponse
} from '../shared/types'

/** What the host says about the page that asks. */
export interface DeviceChooserRequest {
  /** The requesting frame's URL or origin; the chooser is kept under its site. */
  origin: string
  tabId: string | null
  /** Bluetooth: the adapter keeps scanning while the chooser is open. */
  scanning?: boolean
  hint?: DeviceChooser['hint']
}

/** The host's handle on a chooser: keep its list live, learn the answer, take it down. */
export interface DeviceChooserHandle {
  /** Null when the request was refused without a chooser (the site's setting is block). */
  readonly id: string | null
  /**
   * The picked candidate's id; null for Cancel, a tab that left, a refused site or a request the
   * engine withdrew.
   */
  readonly result: Promise<string | null>
  /** The engine's list changed while the chooser is open (a device plugged in or pulled, a scan). */
  update(candidates: DeviceCandidate[], scanning?: boolean): void
  /** The engine withdrew the request (the page navigated away, a scan gave up): no answer. */
  close(): void
}

interface Pending {
  chooser: DeviceChooser
  resolve: (deviceId: string | null) => void
}

interface PendingPairing {
  prompt: DevicePairingPrompt
  resolve: (response: DevicePairingResponse | null) => void
}

/**
 * The device choosers of Web Bluetooth, WebUSB, Web Serial and WebHID (Chrome's chooser
 * bubbles): a page's `requestDevice()` opens one modal list over its tab, live while the engine
 * enumerates, and the pick is what the site gets – recorded by the host as a `DeviceGrant`, the
 * setting's data. The service holds the open choosers for the chrome (they ride in the state as
 * `deviceChoosers`) and answers the host; the site's setting is applied here as well, so a kind
 * the engine has no permission hook for (Bluetooth) is still refused when the site is blocked.
 */
export class DeviceChooserService {
  private readonly pending: Pending[] = []
  private readonly pairings: PendingPairing[] = []

  constructor(
    private readonly browser: Browser,
    private readonly now: () => number = Date.now
  ) {}

  list(): DeviceChooser[] {
    return this.pending.map((p) => p.chooser)
  }

  listPairings(): DevicePairingPrompt[] {
    return this.pairings.map((p) => p.prompt)
  }

  /**
   * A page asks for a device of `kind`. A site the setting refuses – or a page without a site –
   * gets no chooser and a null at once; every other request opens one, empty list included (the
   * empty state says what the OS may stand in the way of).
   */
  open(
    kind: DeviceKind,
    candidates: DeviceCandidate[],
    request: DeviceChooserRequest
  ): DeviceChooserHandle {
    const origin = permissionSite(request.origin)
    if (!origin || this.browser.permissions.resolve(kind, origin) === 'deny') {
      return {
        id: null,
        result: Promise.resolve(null),
        update: () => undefined,
        close: () => undefined
      }
    }
    const chooser: DeviceChooser = {
      id: newId('device'),
      tabId: request.tabId,
      origin,
      kind,
      candidates: dedupe(candidates),
      scanning: request.scanning ?? false,
      hint: request.hint ?? 'none',
      requestedAt: this.now()
    }
    const result = new Promise<string | null>((resolve) => {
      this.pending.push({ chooser, resolve })
      this.browser.state.commitVolatile()
    })
    return {
      id: chooser.id,
      result,
      update: (list, scanning) => this.update(chooser.id, list, scanning),
      close: () => this.respond(chooser.id, null)
    }
  }

  /** The host's list changed: the chooser shows it (a picked id that vanished can no longer be picked). */
  update(id: string, candidates: DeviceCandidate[], scanning?: boolean): void {
    const entry = this.pending.find((p) => p.chooser.id === id)
    if (!entry) return
    entry.chooser = {
      ...entry.chooser,
      candidates: dedupe(candidates),
      scanning: scanning ?? entry.chooser.scanning
    }
    this.browser.state.commitVolatile()
  }

  /**
   * The chrome answered: Connect with a candidate of the list, or Cancel with null. A pick that
   * is not in the list (the device went while the user clicked) is ignored; the chooser stays.
   */
  respond(id: string, deviceId: string | null): void {
    const i = this.pending.findIndex((p) => p.chooser.id === id)
    if (i < 0) return
    const entry = this.pending[i]
    if (deviceId !== null && !entry.chooser.candidates.some((c) => c.id === deviceId)) return
    this.pending.splice(i, 1)
    this.browser.state.commitVolatile()
    entry.resolve(deviceId)
  }

  /** The tab committed a new document or closed: its choosers and pairings are moot. */
  cancelForTab(tabId: string): void {
    for (const p of this.pending.filter((p) => p.chooser.tabId === tabId))
      this.respond(p.chooser.id, null)
    for (const p of this.pairings.filter((p) => p.prompt.tabId === tabId))
      this.respondPairing(p.prompt.id, null)
  }

  /** The OS wants the user to confirm a Bluetooth pairing, compare a PIN or type one. */
  pair(details: {
    deviceId: string
    tabId: string | null
    kind: DevicePairingPrompt['kind']
    pin?: string
  }): Promise<DevicePairingResponse | null> {
    const prompt: DevicePairingPrompt = {
      id: newId('pairing'),
      tabId: details.tabId,
      deviceId: details.deviceId,
      deviceName: this.deviceName(details.deviceId) ?? details.deviceId,
      kind: details.kind,
      pin: details.pin ?? ''
    }
    return new Promise((resolve) => {
      this.pairings.push({ prompt, resolve })
      this.browser.state.commitVolatile()
    })
  }

  respondPairing(id: string, response: DevicePairingResponse | null): void {
    const i = this.pairings.findIndex((p) => p.prompt.id === id)
    if (i < 0) return
    const [entry] = this.pairings.splice(i, 1)
    this.browser.state.commitVolatile()
    entry.resolve(response)
  }

  /** What a chooser called the device, or a grant did; the pairing prompt names it that way. */
  private deviceName(deviceId: string): string | null {
    for (const p of this.pending)
      for (const c of p.chooser.candidates) if (c.id === deviceId) return c.name
    const grant = this.browser.permissions
      .deviceGrants()
      .find((g) => g.kind === 'bluetooth' && g.deviceId === deviceId)
    return grant?.name ?? null
  }
}

/** One row per id: an engine that reports a device twice (a rescan) does not list it twice. */
function dedupe(candidates: DeviceCandidate[]): DeviceCandidate[] {
  const seen = new Set<string>()
  const out: DeviceCandidate[] = []
  for (const c of candidates) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    out.push({ id: c.id, name: c.name, detail: c.detail })
  }
  return out
}
