import {
  NotificationError,
  checkNotificationId,
  mergeNotificationOptions,
  normalizeNotificationOptions,
  toNativeNotification,
  type NotificationOptions
} from '@core/extensions/api/notifications'
import type { AttachedExtension } from './extensionApi'

/**
 * `chrome.notifications` on Android: Chrome's option rules from the shared module, the system
 * notification from Kotlin (`ext/ExtensionNotifications.kt`) on a channel per extension, named
 * after it so the user finds it under the app's notification settings. `update` re-posts the
 * merged notification under the same tag, which Android edits in place; a tap, a button or a
 * swipe comes back as `ext.notification` and is `onClicked`, `onButtonClicked`, `onClosed`.
 * A tap or a button dismisses the card (as it does in Chrome), so `onClosed(id, true)` follows.
 * `getPermissionLevel` is what the app's own notification permission says.
 */

/** One notification as Kotlin shows it: Chrome's templates flattened, plus what Android can render richer. */
export interface ShownNotification {
  notificationId: string
  /** The extension's name (its channel's name in the system settings). */
  extensionName: string
  title: string
  body: string
  /** `contextMessage`: the sub text line. */
  subText: string
  /** `iconUrl` as given: a `data:` URL or a path inside the extension (Kotlin resolves it). */
  iconUrl: string | null
  /** The hero picture of an `image` notification, resolved like the icon. */
  imageUrl: string | null
  /** 0 to 100 for a `progress` notification, else null. */
  progress: number | null
  buttons: string[]
  silent: boolean
  /** Chrome's `priority` -2..2 (Android maps it onto its pre-channel priorities). */
  priority: number
  /** `eventTime` in ms since the epoch, or null for now. */
  eventTime: number | null
}

export interface NotificationsHost {
  /** Show one notification (or replace the one under the same id in place). */
  show(extensionId: string, notification: ShownNotification): void
  /** Take one down without an `onClosed` (`clear`, a replacement, the extension going). */
  hide(extensionId: string, notificationId: string): void
  /** The extension is gone for good: its channel goes with its notifications. */
  forget(extensionId: string): void
  /** Whether the app may post notifications right now (`getPermissionLevel`). */
  allowed(): Promise<boolean>
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void
}

/** What Kotlin reports about a shown notification (`ext.notification`). */
export interface NotificationEvent {
  extensionId: string
  notificationId: string
  event: 'clicked' | 'button' | 'closed'
  /** The button's index for `button`. */
  index?: number
}

export class AndroidNotifications {
  /** Extension id → notification id → its effective options. */
  private readonly shown = new Map<string, Map<string, NotificationOptions>>()
  private seq = 0

  constructor(private readonly host: NotificationsHost) {}

  call(ext: AttachedExtension, method: string, args: unknown[]): unknown {
    switch (method) {
      case 'create':
        return this.create(ext, args[0], args[1])
      case 'update':
        return this.update(ext, args[0], args[1])
      case 'clear':
        return this.clear(ext, args[0])
      case 'getAll': {
        const out: Record<string, true> = {}
        for (const id of this.shown.get(ext.record.id)?.keys() ?? []) out[id] = true
        return out
      }
      case 'getPermissionLevel':
        return this.host.allowed().then((allowed) => (allowed ? 'granted' : 'denied'))
    }
    throw new Error(`chrome.notifications.${method} is not implemented on Zenium for Android`)
  }

  /** The extension is going away (uninstall): its notifications and channel with it. */
  forget(extensionId: string): void {
    this.shown.delete(extensionId)
    this.host.forget(extensionId)
  }

  /** A tap, a button or a swipe on a shown notification, from Kotlin. */
  onEvent(e: NotificationEvent): void {
    const { extensionId, notificationId } = e
    // A notification may outlive the process (it stays in the shade); the events still count.
    this.shown.get(extensionId)?.delete(notificationId)
    if (e.event === 'clicked') {
      this.host.emit(extensionId, 'notifications', 'onClicked', [notificationId])
    } else if (e.event === 'button') {
      this.host.emit(extensionId, 'notifications', 'onButtonClicked', [
        notificationId,
        typeof e.index === 'number' ? e.index : 0
      ])
    }
    // Android dismisses the card on a tap (autoCancel) and Kotlin cancels it after a button; a
    // swipe reports `closed` directly. Each ends with Chrome's `onClosed(id, byUser)`.
    this.host.emit(extensionId, 'notifications', 'onClosed', [notificationId, true])
  }

  /**
   * `create(notificationId?, options)`: the shim aligns the optional id to its slot (`undefined`
   * when omitted), but a bare `(options)` call is accepted as well. A second `create` under an
   * id in use replaces the notification, silently.
   */
  private create(ext: AttachedExtension, first: unknown, second: unknown): string {
    const explicit = typeof first === 'string' ? first : null
    const raw = explicit !== null || first === undefined || first === null ? second : first
    const id = explicit || this.newId()
    try {
      checkNotificationId(id)
      const options = normalizeNotificationOptions(raw, true)
      this.listFor(ext.record.id).set(id, options)
      this.host.show(ext.record.id, this.spec(ext, id, options))
      return id
    } catch (error) {
      throw toError(error)
    }
  }

  private update(ext: AttachedExtension, id: unknown, raw: unknown): boolean {
    if (typeof id !== 'string') throw new Error('Invalid notificationId')
    const list = this.shown.get(ext.record.id)
    const current = list?.get(id)
    if (!list || !current) return false
    try {
      const patch = normalizeNotificationOptions(raw, false)
      const merged = mergeNotificationOptions(current, patch)
      list.set(id, merged)
      this.host.show(ext.record.id, this.spec(ext, id, merged))
      return true
    } catch (error) {
      throw toError(error)
    }
  }

  private clear(ext: AttachedExtension, id: unknown): boolean {
    if (typeof id !== 'string') throw new Error('Invalid notificationId')
    const list = this.shown.get(ext.record.id)
    if (!list?.has(id)) return false
    list.delete(id)
    this.host.hide(ext.record.id, id)
    this.host.emit(ext.record.id, 'notifications', 'onClosed', [id, false])
    return true
  }

  private listFor(extensionId: string): Map<string, NotificationOptions> {
    let list = this.shown.get(extensionId)
    if (!list) {
      list = new Map()
      this.shown.set(extensionId, list)
    }
    return list
  }

  private spec(
    ext: AttachedExtension,
    id: string,
    options: NotificationOptions
  ): ShownNotification {
    // With the sub text line taking `contextMessage`, the body keeps the message, list items and
    // the progress percentage (the bar shows it too).
    const flat = toNativeNotification(options, true)
    return {
      notificationId: id,
      extensionName: ext.manifest.name,
      title: flat.title,
      body: flat.body,
      subText: flat.subtitle,
      iconUrl: flat.iconUrl,
      imageUrl: options.type === 'image' ? (options.imageUrl ?? null) : null,
      progress:
        options.type === 'progress' && options.progress !== undefined
          ? Math.round(Math.min(100, Math.max(0, options.progress)))
          : null,
      buttons: flat.buttons,
      silent: flat.silent,
      priority: options.priority ?? 0,
      eventTime: options.eventTime ?? null
    }
  }

  /** Chrome hands out a random token when the extension names no id. */
  private newId(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let out = ''
    for (let i = 0; i < 20; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
    this.seq += 1
    return `${out}${this.seq.toString(36)}`
  }
}

/** The event payload Kotlin posts, checked; null when it is not one. */
export function notificationEvent(raw: unknown): NotificationEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (typeof p.id !== 'string' || typeof p.notificationId !== 'string') return null
  if (p.event !== 'clicked' && p.event !== 'button' && p.event !== 'closed') return null
  const out: NotificationEvent = {
    extensionId: p.id,
    notificationId: p.notificationId,
    event: p.event
  }
  if (typeof p.index === 'number' && Number.isInteger(p.index) && p.index >= 0) out.index = p.index
  return out
}

function toError(error: unknown): Error {
  if (error instanceof NotificationError) return new Error(error.message)
  return error instanceof Error ? error : new Error(String(error))
}
