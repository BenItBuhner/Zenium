/**
 * QR / barcode scanning (OMN-22, NTP-03): the model behind the camera buttons on the new tab
 * page's field and in the phone's omnibox. The host (Android's camera2 behind `QrScan.kt`)
 * runs the camera, shows the preview natively over the sheet's slot and decodes with ZXing; it
 * reports through `qr.event`. This module owns what is pure about the feature – the scan sheet's
 * state machine and what becomes of a decoded payload – so the chrome can be tested without a
 * camera.
 */
import type { HostCapabilities } from './types'
import { inputToUrl } from './url'

/** What `qr.start` answers once the camera has been asked for. */
export type QrStartOutcome =
  /** The camera is opening (or open): `qr.event`s follow, `ready` first. */
  | 'scanning'
  /** The camera was refused this once; asking again brings the system prompt back. */
  | 'denied'
  /** Refused for good (twice, or "Don't ask again"): only the app's settings screen turns it on. */
  | 'denied-permanently'
  /** No back camera on the device, or the feature is off. */
  | 'unavailable'

/** Why the camera stopped short of a decode (`QrScan.kt` names them). */
export type QrError =
  /** The camera would not open or its session failed (a hardware or driver error). */
  | 'camera'
  /** Another app holds the camera. */
  | 'busy'
  /** The camera went away while scanning (unplugged, disabled by policy). */
  | 'disconnected'

/** What the host reports while a scan runs (`qr.event`). */
export type QrEvent =
  /** The camera is streaming into the preview; whether it has a torch to toggle. */
  | { kind: 'ready'; torch: boolean }
  /** A code decoded: its payload as text. One per session; the host stops scanning after it. */
  | { kind: 'decoded'; text: string }
  /**
   * A still of the preview as a data URL, for the slot to show while the native preview is
   * hidden (the sheet in motion) – the last frame stands where the live picture was.
   */
  | { kind: 'still'; dataUrl: string }
  /** The torch changed state (a toggle answered, or the device turned it off). */
  | { kind: 'torch'; on: boolean }
  | { kind: 'error'; error: QrError }
  /** The host ended the session without a result (the app went to the background): nothing to say. */
  | { kind: 'aborted' }

/**
 * The scan sheet's phases. `starting` is the wait for the camera (the permission prompt may be
 * up, then the camera opens); `scanning` is the live state with the preview streaming; `done`,
 * `failed` and `cancelled` are terminal – the surface submits, toasts the error and goes, or
 * just goes.
 */
export type QrPhase = 'starting' | 'scanning' | 'done' | 'failed' | 'cancelled'

export interface QrSession {
  phase: QrPhase
  /** The camera has a torch the sheet can offer (known once `ready`). */
  torch: boolean
  torchOn: boolean
  /** The preview's last still, for the slot while the native preview is hidden; null before one came. */
  still: string | null
  /** The decoded payload once `done`. */
  text: string
  /** Why the session `failed`; null otherwise. */
  error: QrError | null
}

export function newQrSession(): QrSession {
  return { phase: 'starting', torch: false, torchOn: false, still: null, text: '', error: null }
}

const TERMINAL: ReadonlySet<QrPhase> = new Set(['done', 'failed', 'cancelled'])

/** A session that has reached its end: the surface acts on it and nothing changes it further. */
export function qrSessionOver(session: QrSession): boolean {
  return TERMINAL.has(session.phase)
}

/**
 * The sheet's state machine: one host event applied to the session. Events after the session is
 * over are ignored (a late still after the decode, an error after a cancel). A decode with no
 * text is nothing found: the session keeps scanning.
 */
export function reduceQr(session: QrSession, event: QrEvent): QrSession {
  if (qrSessionOver(session)) return session
  switch (event.kind) {
    case 'ready':
      return { ...session, phase: 'scanning', torch: event.torch }
    case 'still':
      return event.dataUrl ? { ...session, still: event.dataUrl } : session
    case 'torch':
      return session.torchOn === event.on ? session : { ...session, torchOn: event.on }
    case 'decoded': {
      const text = qrText(event.text)
      if (!text) return session
      return { ...session, phase: 'done', text, torchOn: false }
    }
    case 'error':
      return { ...session, phase: 'failed', error: event.error, torchOn: false }
    case 'aborted':
      return { ...session, phase: 'cancelled', torchOn: false }
  }
}

/** A payload as the address bar would take it: trimmed, its line breaks kept for the parsers below. */
export function qrText(payload: string): string {
  return payload.replace(/\r\n?/g, '\n').trim()
}

/**
 * What a payload is. `url` is anything `inputToUrl` reads as an address (a scheme it knows, a
 * host, an IP); `wifi` and `contact` are the two structured payloads QR codes commonly carry
 * (`WIFI:T:WPA;S:…;P:…;;`, MECARD and vCard); everything else is `text`, which includes the
 * `mailto:`, `tel:`, `sms:` and `geo:` URIs – `inputToUrl` treats their schemes as searches when
 * typed, and a scan follows the typing rule.
 */
export type QrPayloadKind = 'url' | 'wifi' | 'contact' | 'text'

export function qrPayloadKind(payload: string): QrPayloadKind {
  const text = qrText(payload)
  if (/^WIFI:/i.test(text)) return 'wifi'
  if (/^MECARD:/i.test(text) || /^BEGIN:VCARD\b/i.test(text)) return 'contact'
  if (inputToUrl(text)) return 'url'
  return 'text'
}

export type QrDestination = { kind: 'navigate'; url: string } | { kind: 'search'; query: string }

/**
 * Where a decoded payload goes – the same decision `urlbar.submit` makes for typed text
 * (`inputToUrl`): an address is navigated to, everything else is a search through the default
 * engine. A Wi-Fi payload is searched by its network name alone – the password in it never
 * reaches a search engine – and a contact by the name it carries; both fall back to the payload's
 * text without its line breaks when the field is missing. Null for a payload with no text.
 */
export function qrDestination(payload: string): QrDestination | null {
  const text = qrText(payload)
  if (!text) return null
  switch (qrPayloadKind(text)) {
    case 'url':
      return { kind: 'navigate', url: inputToUrl(text)! }
    case 'wifi':
      return { kind: 'search', query: wifiNetworkName(text) ?? 'Wi-Fi network' }
    case 'contact':
      return { kind: 'search', query: contactName(text) ?? oneLine(text) }
    case 'text':
      return { kind: 'search', query: oneLine(text) }
  }
}

/**
 * What is submitted to `urlbar.submit` for a payload: the address as scanned (the core resolves
 * it as it would typed text, keyword rules included), or the search words. Null when there is
 * nothing to submit.
 */
export function qrSubmitInput(payload: string): string | null {
  const destination = qrDestination(payload)
  if (!destination) return null
  return destination.kind === 'navigate' ? qrText(payload) : destination.query
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The `S:` field of a `WIFI:` payload (`WIFI:T:WPA;S:Cafe;P:secret;H:false;;`), its `\;` `\:`
 * `\,` `\\` escapes undone; a quoted hex SSID (`S:"48656c6c6f"`) is left as written.
 */
export function wifiNetworkName(payload: string): string | null {
  const body = qrText(payload).replace(/^WIFI:/i, '')
  const ssid = fieldOf(body, 'S')
  return ssid && ssid.trim() ? ssid.trim() : null
}

/**
 * The name in a contact payload: MECARD's `N:` (surname,given), a vCard's `FN:` or, failing
 * that, its `N:` (surname;given;…) read as given then surname.
 */
export function contactName(payload: string): string | null {
  const text = qrText(payload)
  if (/^MECARD:/i.test(text)) {
    const name = fieldOf(text.slice('MECARD:'.length), 'N')
    if (!name) return null
    const parts = name.split(',').map((p) => p.trim())
    return parts.reverse().filter(Boolean).join(' ') || null
  }
  const lines = text.split('\n').map((line) => line.trim())
  const line = (key: string): string | null => {
    const found = lines.find((l) => new RegExp(`^${key}(;[^:]*)?:`, 'i').test(l))
    return found ? found.slice(found.indexOf(':') + 1).trim() : null
  }
  const fn = line('FN')
  if (fn) return fn
  const n = line('N')
  if (!n) return null
  const [surname = '', given = '', middle = ''] = n.split(';')
  return (
    [given, middle, surname]
      .map((p) => p.trim())
      .filter(Boolean)
      .join(' ') || null
  )
}

/** A `KEY:value;` field of a MECARD-style body, the value's backslash escapes undone. */
function fieldOf(body: string, key: string): string | null {
  const re = new RegExp(`(?:^|;)${key}:`, 'i')
  const match = re.exec(body)
  if (!match) return null
  let i = match.index + match[0].length
  let value = ''
  while (i < body.length) {
    const c = body[i]!
    if (c === '\\' && i + 1 < body.length) {
      value += body[i + 1]
      i += 2
      continue
    }
    if (c === ';') break
    value += c
    i++
  }
  return value
}

/** The camera buttons show only where the host has a back camera to scan with (`QrScan.kt`). */
export function qrScanAvailable(capabilities: Pick<HostCapabilities, 'qrScan'>): boolean {
  return capabilities.qrScan
}

/** The message a refused or failed start leaves (§9.33 toast); null when the sheet says it. */
export function qrStartMessage(outcome: QrStartOutcome): string | null {
  switch (outcome) {
    case 'scanning':
      return null
    case 'denied':
      return 'Camera access is needed to scan a code'
    case 'denied-permanently':
      return 'Camera access is turned off for Zenium'
    case 'unavailable':
      return 'Scanning is not available on this device'
  }
}

/** The toast for an error that ends the scan. */
export function qrErrorMessage(error: QrError): string {
  switch (error) {
    case 'busy':
      return 'The camera is in use by another app'
    case 'disconnected':
      return 'The camera stopped. Try again'
    case 'camera':
      return 'The camera could not be started'
  }
}
