import type { EncryptedEnvelope } from './crypto'
import { isEnvelope } from './crypto'
import type { SyncTransport } from './transport'

/**
 * The folder's second kind of file (W4-3): documents a device owns beside its record set – the
 * pages of its history stream, its open tabs, and the tabs another device sent it. They share
 * one outer shape with the device file (identity in the clear, the payload under the shared
 * key) and their own extension, so a build that knows only `.zensync` files never reads them,
 * and `removeAll` takes them along with everything else.
 *
 * Names (the id reduced like `deviceFileName` does):
 *   `<deviceId>.history.<seq>.zenpage`   one page of the device's history stream (`history.ts`)
 *   `<deviceId>.tabs.zenpage`             the device's open tabs, rewritten as they change (`openTabs.ts`)
 *   `<targetId>.inbox.<sendId>.zenpage`   a tab sent TO `targetId`; the target opens it and removes the file
 */
export const DOCUMENT_EXT = '.zenpage'

export type SyncDocumentKind = 'history' | 'open-tabs' | 'send-tab'

export interface SyncDocument {
  kind: SyncDocumentKind
  /** The device that wrote the document (the stream's owner; a sent tab's sender). */
  deviceId: string
  deviceName: string
  updatedAt: number
  envelope: EncryptedEnvelope
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function historyPageName(deviceId: string, seq: number): string {
  return `${safeId(deviceId)}.history.${seq}${DOCUMENT_EXT}`
}

export function openTabsName(deviceId: string): string {
  return `${safeId(deviceId)}.tabs${DOCUMENT_EXT}`
}

export function inboxName(targetId: string, sendId: string): string {
  return `${safeId(targetId)}.inbox.${safeId(sendId)}${DOCUMENT_EXT}`
}

/** `<deviceId>.history.<seq>.zenpage` → the (reduced) device id and the page's sequence number. */
export function parseHistoryPageName(name: string): { deviceId: string; seq: number } | null {
  const m = /^([a-zA-Z0-9_-]+)\.history\.(\d+)\.zenpage$/.exec(name)
  if (!m) return null
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) ? { deviceId: m[1], seq } : null
}

/** `<deviceId>.tabs.zenpage` → the (reduced) device id. */
export function parseOpenTabsName(name: string): string | null {
  const m = /^([a-zA-Z0-9_-]+)\.tabs\.zenpage$/.exec(name)
  return m ? m[1] : null
}

/** `<targetId>.inbox.<sendId>.zenpage` → the (reduced) target id and send id. */
export function parseInboxName(name: string): { targetId: string; sendId: string } | null {
  const m = /^([a-zA-Z0-9_-]+)\.inbox\.([a-zA-Z0-9_-]+)\.zenpage$/.exec(name)
  return m ? { targetId: m[1], sendId: m[2] } : null
}

/** Whether a document name belongs to `deviceId` (whose id is reduced the way names are). */
export function ownsName(deviceId: string, reduced: string): boolean {
  return safeId(deviceId) === reduced
}

export function serializeDocument(doc: SyncDocument): string {
  return JSON.stringify(doc)
}

/** Parse a document's text; null for a partially synced or corrupt file (its owner rewrites it). */
export function parseDocument(text: string): SyncDocument | null {
  let raw: Partial<SyncDocument>
  try {
    raw = JSON.parse(text) as Partial<SyncDocument>
  } catch {
    return null
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw.kind !== 'history' && raw.kind !== 'open-tabs' && raw.kind !== 'send-tab') ||
    typeof raw.deviceId !== 'string' ||
    typeof raw.updatedAt !== 'number' ||
    !isEnvelope(raw.envelope)
  )
    return null
  return {
    kind: raw.kind,
    deviceId: raw.deviceId,
    deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : raw.deviceId,
    updatedAt: raw.updatedAt,
    envelope: raw.envelope
  }
}

/** Read and parse one document; null when it is missing or unreadable. */
export async function readDocument(
  transport: SyncTransport,
  name: string
): Promise<SyncDocument | null> {
  const text = await transport.read(name)
  return text === null ? null : parseDocument(text)
}
