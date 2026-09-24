import {
  MAX_NOTIFICATION_TEXT,
  type NotificationHostMessage,
  type NotificationPageRequest,
  type NotificationPermissionStatus
} from './notifications'
import type { PageScriptMessage } from './pageScript'

/**
 * `Notification` for pages on a host whose engine has none (the Android WebView hides the API):
 * the static `permission` and `requestPermission()`, and instances that post their title, body
 * and icon to the browser – which shows them on the system shade under the site's own channel –
 * and get the shade's tap and swipe back as `click` / `close` events. Chrome's shape as far as a
 * page-context notification goes: `actions` stay empty (`maxActions` 0), `showTrigger` is absent
 * and there is no `ServiceWorkerRegistration.showNotification`.
 *
 * The status is what the browser last told the script (`status` / `result`), asked for at
 * install; a page reading `Notification.permission` before the answer sees `default`, which is
 * also what it gets when the browser never answers.
 */
export interface NotificationTransport {
  send(message: PageScriptMessage): void
  onNotification(listener: (message: NotificationHostMessage) => void): void
}

type PermissionCallback = (status: NotificationPermissionStatus) => void

interface PageWithNotification {
  Notification?: unknown
}

const STATUSES: readonly NotificationPermissionStatus[] = ['default', 'granted', 'denied']

export function installNotificationPolyfill(transport: NotificationTransport): void {
  const w = window as unknown as PageWithNotification
  if (w.Notification !== undefined) return

  let status: NotificationPermissionStatus = 'default'
  let seq = 0
  const pendingRequests = new Map<string, PermissionCallback>()
  const live = new Map<string, NotificationImpl>()

  const post = (notification: NotificationPageRequest): void =>
    transport.send({ type: 'notification', notification })

  const text = (value: unknown): string => String(value ?? '').slice(0, MAX_NOTIFICATION_TEXT)

  const resolveUrl = (value: unknown): string => {
    if (value === undefined || value === null || value === '') return ''
    try {
      return new URL(String(value), document.baseURI).href
    } catch {
      return ''
    }
  }

  const fire = (target: EventTarget, type: string): void => {
    target.dispatchEvent(new Event(type))
  }

  // Whether the page is inside a user activation right now (a tap, a key): Chrome asks quietly
  // for a request made without one (NOT-03). An engine without `userActivation` cannot say, and
  // the request is taken as a gestured one rather than quieted on a guess.
  const gestured = (): boolean => {
    try {
      const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation
      return activation ? activation.isActive === true : true
    } catch {
      return true
    }
  }

  class NotificationImpl extends EventTarget {
    readonly title: string
    readonly body: string
    readonly icon: string
    readonly image: string
    readonly badge: string
    readonly tag: string
    readonly dir: 'auto' | 'ltr' | 'rtl'
    readonly lang: string
    readonly data: unknown
    readonly silent: boolean | null
    readonly requireInteraction: boolean
    readonly renotify: boolean
    readonly timestamp: number
    readonly vibrate: ReadonlyArray<number>
    readonly actions: ReadonlyArray<never> = Object.freeze([])
    onclick: ((this: Notification, ev: Event) => unknown) | null = null
    onshow: ((this: Notification, ev: Event) => unknown) | null = null
    onerror: ((this: Notification, ev: Event) => unknown) | null = null
    onclose: ((this: Notification, ev: Event) => unknown) | null = null
    /** @internal */
    readonly __zenId: string
    private closed = false

    constructor(title: unknown, options?: NotificationOptions) {
      super()
      if (arguments.length === 0)
        throw new TypeError(
          "Failed to construct 'Notification': 1 argument required, but only 0 present."
        )
      if (options !== undefined && (typeof options !== 'object' || options === null))
        throw new TypeError("Failed to construct 'Notification': parameter 2 is not an object.")
      const o = (options ?? {}) as NotificationOptions & {
        renotify?: boolean
        timestamp?: number
        vibrate?: number | number[]
        image?: string
      }
      this.title = text(title)
      this.body = text(o.body)
      this.icon = resolveUrl(o.icon)
      this.image = resolveUrl(o.image)
      this.badge = resolveUrl(o.badge)
      this.tag = String(o.tag ?? '')
      this.dir = o.dir === 'ltr' || o.dir === 'rtl' ? o.dir : 'auto'
      this.lang = String(o.lang ?? '')
      this.data = o.data === undefined ? null : o.data
      this.silent = typeof o.silent === 'boolean' ? o.silent : null
      this.requireInteraction = Boolean(o.requireInteraction)
      this.renotify = Boolean(o.renotify)
      if (this.renotify && this.tag === '')
        throw new TypeError(
          "Failed to construct 'Notification': Notifications which set the renotify flag must specify a non-empty tag."
        )
      this.timestamp =
        typeof o.timestamp === 'number' && Number.isFinite(o.timestamp) ? o.timestamp : Date.now()
      this.vibrate = Object.freeze(
        Array.isArray(o.vibrate)
          ? o.vibrate.map(Number)
          : typeof o.vibrate === 'number'
            ? [o.vibrate]
            : []
      )
      this.__zenId = `n${++seq}`
      for (const type of ['click', 'show', 'error', 'close'] as const) {
        this.addEventListener(type, (event) => {
          const handler = this[`on${type}`]
          if (typeof handler === 'function') handler.call(this as unknown as Notification, event)
        })
      }
      if (status !== 'granted') {
        // Chrome: a notification constructed without the permission never shows; it errors.
        setTimeout(() => fire(this, 'error'), 0)
        return
      }
      live.set(this.__zenId, this)
      const request: NotificationPageRequest = {
        notification: 'show',
        id: this.__zenId,
        title: this.title,
        body: this.body,
        icon: this.icon,
        tag: this.tag,
        silent: this.silent === true,
        requireInteraction: this.requireInteraction,
        renotify: this.renotify,
        timestamp: this.timestamp
      }
      post(request)
    }

    close(): void {
      if (this.closed) return
      this.closed = true
      if (!live.delete(this.__zenId)) return
      post({ notification: 'close', id: this.__zenId })
      fire(this, 'close')
    }

    static get permission(): NotificationPermissionStatus {
      return status
    }

    static get maxActions(): number {
      return 0
    }

    static requestPermission(callback?: PermissionCallback): Promise<NotificationPermissionStatus> {
      if (callback !== undefined && typeof callback !== 'function')
        return Promise.reject(
          new TypeError(
            "Failed to execute 'requestPermission' on 'Notification': The callback provided as parameter 1 is not a function."
          )
        )
      return new Promise((resolve) => {
        const id = `r${++seq}`
        pendingRequests.set(id, (result) => {
          try {
            callback?.(result)
          } catch {
            /* the page's callback failed; the promise still settles */
          }
          resolve(result)
        })
        post({ notification: 'request', id, gesture: gestured() })
      })
    }
  }

  transport.onNotification((message) => {
    switch (message.action) {
      case 'status':
        if (message.status !== undefined && STATUSES.includes(message.status))
          status = message.status
        return
      case 'result': {
        if (message.status !== undefined && STATUSES.includes(message.status))
          status = message.status
        const pending = message.id !== undefined ? pendingRequests.get(message.id) : undefined
        if (pending && message.id !== undefined) {
          pendingRequests.delete(message.id)
          pending(status)
        }
        return
      }
      case 'shown': {
        const n = message.id !== undefined ? live.get(message.id) : undefined
        if (n) fire(n, 'show')
        return
      }
      case 'click': {
        const n = message.id !== undefined ? live.get(message.id) : undefined
        if (!n) return
        fire(n, 'click')
        // The shade takes a tapped card down (Android's autoCancel): the notification is closed.
        live.delete(n.__zenId)
        ;(n as unknown as { closed: boolean }).closed = true
        fire(n, 'close')
        return
      }
      case 'close': {
        const n = message.id !== undefined ? live.get(message.id) : undefined
        if (!n) return
        live.delete(n.__zenId)
        ;(n as unknown as { closed: boolean }).closed = true
        fire(n, 'close')
        return
      }
      case 'error': {
        const n = message.id !== undefined ? live.get(message.id) : undefined
        if (!n) return
        live.delete(n.__zenId)
        fire(n, 'error')
        return
      }
    }
  })

  try {
    Object.defineProperty(w, 'Notification', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: NotificationImpl
    })
  } catch {
    return
  }
  Object.defineProperty(NotificationImpl, 'name', { value: 'Notification' })
  post({ notification: 'query' })
}
