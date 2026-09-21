/**
 * The `send-tab` record (ID-27, Chrome's "Send to your devices"): a page one device sends to
 * another, as one document in the folder addressed to the target –
 * `<targetId>.inbox.<sendId>.zenpage`, the payload under the folder's key. The target opens it
 * as a tab ONCE (a tab and a toast on desktop; a notification on Android that opens the tab on
 * its tap), then marks it consumed: the file is removed, and the send's id is remembered for a
 * while (`SENDS_REMEMBERED`) so a copy a cloud drive brings back does not open it twice. A send
 * nobody has consumed after `SEND_TTL_MS` is removed by whichever device sees it (the target is
 * gone or never syncs again).
 *
 * Wire shape (`SendTabDocument`): `{ v: 1, id, url, title, at, from: { id, name } }`. Only
 * `http(s)` pages can be sent, as in Chrome.
 */
export interface SendTabDocument {
  v: 1
  /** The send's own id (the file name carries it too). */
  id: string
  url: string
  title: string
  /** When it was sent (epoch ms, the sender's clock). */
  at: number
  from: { id: string; name: string }
}

/** Consumed sends a device remembers (their ids) so a resurrected file is not opened again. */
export const SENDS_REMEMBERED = 200
/** A send left in the folder this long is discarded by anyone who sees it. */
export const SEND_TTL_MS = 30 * 86_400_000
/** Titles and URLs are clipped to what a tab can carry anyway. */
const MAX_TITLE = 500
const MAX_URL = 8_000

/** Whether a page can be sent at all: a web page, not the browser's own or a data URL. */
export function isSendableUrl(url: string): boolean {
  return typeof url === 'string' && url.length <= MAX_URL && /^https?:\/\/\S+$/i.test(url)
}

/** Read a document addressed to this device; null for garbage or a page that cannot be opened. */
export function readSendTab(data: unknown): SendTabDocument | null {
  if (!data || typeof data !== 'object') return null
  const r = data as Partial<SendTabDocument>
  if (r.v !== 1 || typeof r.id !== 'string' || !r.id || !isSendableUrl(r.url ?? '')) return null
  const from =
    r.from && typeof r.from === 'object' && typeof r.from.id === 'string'
      ? { id: r.from.id, name: typeof r.from.name === 'string' ? r.from.name : r.from.id }
      : { id: '', name: 'another device' }
  return {
    v: 1,
    id: r.id,
    url: r.url as string,
    title: typeof r.title === 'string' ? r.title.slice(0, MAX_TITLE) : '',
    at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
    from
  }
}

/** The toast on the device that received the page (desktop) and the notification's title (Android). */
export function sendTabArrivedText(doc: SendTabDocument): string {
  return `Tab from ${doc.from.name}`
}
