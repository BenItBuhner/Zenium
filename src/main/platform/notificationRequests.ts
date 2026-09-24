import { permissionSite, type PermissionRequestDetails } from '../../core/permissions'
import type { WebNotificationService } from '../../core/webNotifications'

/**
 * The gesture behind a page's `Notification.requestPermission()`, for the core's quiet rule
 * (NOT-03, `webNotifications.asksQuietly`) on the desktop.
 *
 * The engine raises the request itself and Electron's permission request handler hears no
 * gesture from it (the request details carry the frame and its URL alone – Electron 44.4.5's
 * `PermissionRequest`), so the page preload relays it: the shim in the page's main world tells
 * the isolated world of the call before the engine's own request leaves, the isolated world
 * reads `navigator.userActivation.isActive` – the frame's, which the page cannot spoof from its
 * own world – and sends it over `NOTIFICATION_REQUEST_CHANNEL`; the handler then matches the
 * relay to the request it receives.
 *
 * The match: the same page (the webContents), the same site (`permissionSite` of the relaying
 * document's URL against the request's `requestingUrl`) and the same kind of frame (top or
 * embedded), oldest first – the relays and the requests of one page leave it in one order, and
 * each relay answers one request. A relay stands for {@link RELAY_WINDOW_MS}: the relay and
 * the engine's request are one JS task apart in the page, so a record older than that belongs
 * to a call whose request never came (a page that fires the shim's event without asking) and is
 * dropped, never claimed by a later request. The two messages ride different Mojo pipes
 * (Electron's IPC is a channel-associated interface; Blink's `PermissionService` is not), so
 * their order at the browser is not guaranteed: a request that finds no relay waits
 * {@link RELAY_WAIT_MS} for one to land, and past that the gesture is unknown – `undefined`,
 * which the rule reads as gestured ("nothing is quieted on a guess"): the loud prompt, which is
 * what every desktop request got before the relay. A request the shim never saw – a
 * `PushManager.subscribe()` asking for the permission itself, a page whose frames carry no
 * shim – pays that wait once and gets the prompt it always got.
 */

/** How long a relayed gesture stands for the engine's request to claim it. */
export const RELAY_WINDOW_MS = 3000

/** How long a request that found no relay waits for one before the gesture counts as unknown. */
export const RELAY_WAIT_MS = 250

/** Relays kept per page at most: a page dispatching the shim's event without ever asking. */
export const MAX_RELAYS = 8

export interface RelayedRequest {
  /** `navigator.userActivation.isActive` at the call; undefined where the engine could not say. */
  gesture: boolean | undefined
  /** The site of the document that called (`permissionSite`), matched against the request's URL. */
  site: string | null
  /** Whether that document is the page's top frame (the request's `isMainFrame`). */
  isMainFrame: boolean
}

interface RelayRecord extends RelayedRequest {
  at: number
}

interface Waiter {
  site: string | null
  isMainFrame: boolean
  resolve: (gesture: boolean | undefined) => void
  timer: ReturnType<typeof setTimeout>
}

const sameDocument = (
  a: { site: string | null; isMainFrame: boolean },
  b: { site: string | null; isMainFrame: boolean }
): boolean => a.site === b.site && a.isMainFrame === b.isMainFrame

export class NotificationRequestRelay {
  private readonly records = new Map<number, RelayRecord[]>()
  private readonly waiters = new Map<number, Waiter[]>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly waitMs: number = RELAY_WAIT_MS,
    private readonly windowMs: number = RELAY_WINDOW_MS
  ) {}

  /** The page bridge's word: a `requestPermission()` call is leaving the page of `webContentsId`. */
  note(webContentsId: number, relay: RelayedRequest): void {
    // A request already waiting for this relay takes it straight away.
    const waiting = this.waiters.get(webContentsId)
    if (waiting) {
      const i = waiting.findIndex((w) => sameDocument(w, relay))
      if (i >= 0) {
        const [waiter] = waiting.splice(i, 1)
        if (waiting.length === 0) this.waiters.delete(webContentsId)
        clearTimeout(waiter!.timer)
        waiter!.resolve(relay.gesture)
        return
      }
    }
    const list = this.records.get(webContentsId) ?? []
    list.push({ ...relay, at: this.now() })
    while (list.length > MAX_RELAYS) list.shift()
    this.records.set(webContentsId, list)
  }

  /**
   * The engine's request from the page of `webContentsId`, by the document's site and frame
   * kind: the oldest fresh relay of that document, or a bounded wait for one; undefined past it.
   */
  take(
    webContentsId: number,
    site: string | null,
    isMainFrame: boolean
  ): Promise<boolean | undefined> {
    const now = this.now()
    const fresh = (this.records.get(webContentsId) ?? []).filter((r) => now - r.at <= this.windowMs)
    const document = { site, isMainFrame }
    const i = fresh.findIndex((r) => sameDocument(r, document))
    const found = i >= 0 ? fresh.splice(i, 1)[0] : undefined
    if (fresh.length > 0) this.records.set(webContentsId, fresh)
    else this.records.delete(webContentsId)
    if (found) return Promise.resolve(found.gesture)
    return new Promise((resolve) => {
      const waiter: Waiter = {
        site,
        isMainFrame,
        resolve,
        timer: setTimeout(() => {
          const list = this.waiters.get(webContentsId)
          if (list) {
            const at = list.indexOf(waiter)
            if (at >= 0) list.splice(at, 1)
            if (list.length === 0) this.waiters.delete(webContentsId)
          }
          resolve(undefined)
        }, this.waitMs)
      }
      const list = this.waiters.get(webContentsId) ?? []
      list.push(waiter)
      this.waiters.set(webContentsId, list)
    })
  }

  /** The page is gone: nothing of it stands, and a request still waiting learns nothing. */
  forget(webContentsId: number): void {
    this.records.delete(webContentsId)
    const waiting = this.waiters.get(webContentsId)
    this.waiters.delete(webContentsId)
    for (const waiter of waiting ?? []) {
      clearTimeout(waiter.timer)
      waiter.resolve(undefined)
    }
  }

  /** How many relays stand unclaimed for the page (tests). */
  pending(webContentsId: number): number {
    return this.records.get(webContentsId)?.length ?? 0
  }
}

/**
 * The permission request handler's answer to a tab page's `notifications` request: the relayed
 * gesture (or none) and the core's one rule – `webNotifications.decide`, the same the page
 * script's `request` message reaches on the Android host. Resolves once the question is
 * answered or withdrawn, for the engine's callback.
 */
export async function decideNotificationRequest(
  webNotifications: Pick<WebNotificationService, 'decide'>,
  relay: NotificationRequestRelay,
  webContentsId: number,
  tabId: string,
  url: string,
  isMainFrame: boolean,
  request: PermissionRequestDetails
): Promise<boolean> {
  const gesture = await relay.take(webContentsId, permissionSite(url), isMainFrame)
  return webNotifications.decide(tabId, url, gesture, request)
}

/**
 * What the relay records of the frame that sent it: its document's site and whether it is the
 * page's top frame. A frame gone by the time the message is read (Electron's `senderFrame` is
 * null then, and a disposed frame's `parent` throws) is taken for the top frame at the page's
 * URL – the common case, and the wrong guess costs nothing but a loud prompt.
 */
export function relayedFrom(
  frame: { url: string; parent: unknown } | null,
  pageUrl: string
): Pick<RelayedRequest, 'site' | 'isMainFrame'> {
  try {
    if (frame) return { site: permissionSite(frame.url), isMainFrame: frame.parent === null }
  } catch {
    // The frame was disposed between the send and the read.
  }
  return { site: permissionSite(pageUrl), isMainFrame: true }
}
