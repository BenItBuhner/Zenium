import {
  NOTIFICATION_SHIM_EVENTS,
  isNotificationPermissionStatus,
  type NotificationPermissionStatus,
  type NotificationShimEvents
} from '../shared/notifications'

/**
 * Web notifications in a tab page: the two halves of the preload.
 *
 *  - `installNotificationShim` runs in the page's main world and gives the page Chrome's
 *    `Notification.permission` (`default` for an undecided site, which Chromium's yes-or-no host
 *    check cannot say) and Chrome's `requestPermission()` result (a dismissed prompt leaves the
 *    site undecided, not denied). It also reports a `window.focus()` the page calls while it
 *    holds a gesture – the click handler of a notification does that to come forward.
 *  - `installNotificationBridge` runs in the isolated world, answers the shim's questions from
 *    the browser and forwards the focus request.
 *
 * The status is fetched lazily, on the page's first read, and then kept current by the browser:
 * most pages never touch `Notification`, and the ones that read it on every render pay one
 * synchronous round trip, not one per read.
 */

/** Consecutive focus requests closer than this are dropped. */
const FOCUS_REPORT_INTERVAL_MS = 250

/**
 * Runs in the page's main world through `contextBridge.executeInMainWorld`: the function is
 * serialised, so it is one self-contained function taking everything it needs as arguments.
 */
export function installNotificationShim(events: NotificationShimEvents): void {
  type Status = 'granted' | 'denied' | 'default'
  const isStatus = (value: unknown): value is Status =>
    value === 'granted' || value === 'denied' || value === 'default'
  const win = globalThis as Window & typeof globalThis
  const doc = win.document
  const define = (target: object, name: string, descriptor: PropertyDescriptor): void => {
    try {
      Object.defineProperty(target, name, { configurable: true, enumerable: true, ...descriptor })
    } catch {
      /* a frozen object keeps the engine's own */
    }
  }

  const nativeFocus = win.focus
  if (typeof nativeFocus === 'function') {
    define(win, 'focus', {
      writable: true,
      value: function focus(this: Window | undefined): void {
        nativeFocus.call(this ?? win)
        const activation = (win.navigator as Navigator & { userActivation?: { isActive: boolean } })
          .userActivation
        if (activation?.isActive) doc.dispatchEvent(new Event(events.focus))
      }
    })
  }

  const N = win.Notification
  if (typeof N !== 'function') return
  const nativePermission = Object.getOwnPropertyDescriptor(N, 'permission')?.get
  const nativeRequest = N.requestPermission
  let state: Status | null = null
  doc.addEventListener(events.update, (e) => {
    const next = (e as CustomEvent<unknown>).detail
    if (isStatus(next)) state = next
  })
  // The isolated world answers the query synchronously; without it the engine's own answer stands.
  const current = (): Status => {
    if (state === null) doc.dispatchEvent(new Event(events.query))
    if (state !== null) return state
    const native = nativePermission?.call(N)
    return isStatus(native) ? native : 'denied'
  }
  define(N, 'permission', { get: current })
  define(N, 'requestPermission', {
    writable: true,
    value: function requestPermission(
      callback?: (status: NotificationPermission) => void
    ): Promise<NotificationPermission> {
      return Promise.resolve()
        .then(() => nativeRequest.call(N))
        .then(() => {
          // Chromium reports granted or denied; the browser knows whether the prompt was
          // dismissed (the site stays at `default`) or the site refused.
          state = null
          const status = current()
          if (typeof callback === 'function') callback(status)
          return status
        })
    }
  })
}

/** How the isolated world reaches the browser. */
export interface NotificationBridgeTransport {
  /** The status of this document, synchronously. */
  status(): unknown
  /** The browser pushes a new status while the document is open. */
  onStatus(listener: (status: unknown) => void): void
  /** The page asked to come forward with a gesture in hand. */
  focus(): void
  /** Run `installNotificationShim` in the main world. */
  installShim(events: NotificationShimEvents): void
}

export function installNotificationBridge(
  transport: NotificationBridgeTransport,
  events: NotificationShimEvents = NOTIFICATION_SHIM_EVENTS
): void {
  const push = (status: unknown): void => {
    if (!isNotificationPermissionStatus(status)) return
    document.dispatchEvent(
      new CustomEvent<NotificationPermissionStatus>(events.update, { detail: status })
    )
  }
  document.addEventListener(events.query, () => push(transport.status()))
  transport.onStatus(push)
  let lastFocus = -Infinity
  document.addEventListener(events.focus, () => {
    // The page's own claim is checked: activation is a property of the frame, seen from here too.
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
      .userActivation
    if (!activation?.isActive) return
    const now = Date.now()
    if (now - lastFocus < FOCUS_REPORT_INTERVAL_MS) return
    lastFocus = now
    transport.focus()
  })
  transport.installShim(events)
}
