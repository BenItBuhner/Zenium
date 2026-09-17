import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Notification, nativeImage, type NativeImage } from 'electron'
import {
  NotificationError,
  checkNotificationId,
  mergeNotificationOptions,
  normalizeNotificationOptions,
  toNativeNotification,
  type NotificationOptions
} from '../../../core/extensions/api/notifications'
import {
  ApiError,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

interface ShownNotification {
  options: NotificationOptions
  native: Notification | null
  /** Set while `update` / `clear` closes the native one so its `close` event stays silent. */
  silentClose: boolean
}

/**
 * `chrome.notifications` over Electron's `Notification`: Chrome's templates flatten onto title,
 * body, icon, urgency and (where the platform has them) action buttons; `update` re-shows a
 * merged notification because no desktop API edits one in place; `onPermissionLevelChanged` and
 * `onShowSettings` never fire (the level is always `granted`, there is no settings page).
 */
export class NotificationsApi {
  private readonly shown = new Map<string, Map<string, ShownNotification>>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    create: (ctx, first, second) => this.create(ctx, first, second),
    update: (ctx, id, options) => this.update(ctx, id, options),
    clear: (ctx, id) => this.clear(ctx, id),
    getAll: (ctx) => this.getAll(ctx),
    getPermissionLevel: () => 'granted'
  }

  forget(extensionId: string): void {
    const list = this.shown.get(extensionId)
    if (!list) return
    for (const entry of list.values()) this.closeNative(entry)
    this.shown.delete(extensionId)
  }

  private listFor(extensionId: string): Map<string, ShownNotification> {
    let list = this.shown.get(extensionId)
    if (!list) {
      list = new Map()
      this.shown.set(extensionId, list)
    }
    return list
  }

  // ---------------------------------------------------------------------------
  // Routed calls
  // ---------------------------------------------------------------------------

  /** `create(notificationId?, options)`: the shim drops the callback, the id stays optional. */
  private create(ctx: ApiContext, first: unknown, second: unknown): string {
    const explicit = typeof first === 'string' ? first : null
    const raw = explicit === null ? first : second
    const id = explicit || newNotificationId()
    try {
      checkNotificationId(id)
      const options = normalizeNotificationOptions(raw, true)
      const list = this.listFor(ctx.extensionId)
      const existing = list.get(id)
      if (existing) this.closeNative(existing)
      const entry: ShownNotification = { options, native: null, silentClose: false }
      list.set(id, entry)
      this.show(ctx.extension, id, entry)
      return id
    } catch (error) {
      throw toApiError(error)
    }
  }

  private update(ctx: ApiContext, id: unknown, raw: unknown): boolean {
    if (typeof id !== 'string') throw new ApiError('Invalid notificationId')
    const list = this.shown.get(ctx.extensionId)
    const entry = list?.get(id)
    if (!entry) return false
    try {
      const patch = normalizeNotificationOptions(raw, false)
      entry.options = mergeNotificationOptions(entry.options, patch)
      this.closeNative(entry)
      this.show(ctx.extension, id, entry)
      return true
    } catch (error) {
      throw toApiError(error)
    }
  }

  private clear(ctx: ApiContext, id: unknown): boolean {
    if (typeof id !== 'string') throw new ApiError('Invalid notificationId')
    const list = this.shown.get(ctx.extensionId)
    const entry = list?.get(id)
    if (!list || !entry) return false
    this.closeNative(entry)
    list.delete(id)
    this.host.dispatch(ctx.extensionId, 'notifications', 'onClosed', [id, false], { wake: true })
    return true
  }

  private getAll(ctx: ApiContext): Record<string, true> {
    const out: Record<string, true> = {}
    for (const id of this.shown.get(ctx.extensionId)?.keys() ?? []) out[id] = true
    return out
  }

  // ---------------------------------------------------------------------------
  // Native notifications
  // ---------------------------------------------------------------------------

  private show(ext: LoadedExtension, id: string, entry: ShownNotification): void {
    if (!Notification.isSupported()) return
    const spec = toNativeNotification(entry.options, process.platform === 'darwin')
    const icon = spec.iconUrl ? resolveIcon(ext, spec.iconUrl) : undefined
    const native = new Notification({
      title: spec.title,
      body: spec.body,
      subtitle: spec.subtitle || undefined,
      icon,
      silent: spec.silent,
      urgency: spec.urgency,
      timeoutType: spec.requireInteraction ? 'never' : 'default',
      actions: spec.buttons.map((title) => ({ type: 'button', text: title }))
    })
    entry.native = native
    entry.silentClose = false
    const dispatch = (event: string, args: unknown[]): void =>
      this.host.dispatch(ext.id, 'notifications', event, args, { wake: true })
    native.on('click', () => dispatch('onClicked', [id]))
    native.on('action', (_event, index) => dispatch('onButtonClicked', [id, index]))
    native.on('close', () => {
      if (entry.native !== native) return
      entry.native = null
      if (entry.silentClose) return
      this.shown.get(ext.id)?.delete(id)
      dispatch('onClosed', [id, true])
    })
    native.on('failed', (_event, error) => {
      console.warn(`[zen] notifications: ${ext.id} could not show "${id}": ${error}`)
      if (entry.native === native) entry.native = null
    })
    native.show()
  }

  private closeNative(entry: ShownNotification): void {
    const native = entry.native
    if (!native) return
    entry.silentClose = true
    entry.native = null
    try {
      native.close()
    } catch {
      /* already gone */
    }
  }
}

function newNotificationId(): string {
  return randomBytes(16).toString('base64url')
}

/** An `iconUrl`: a data URL, or a path inside the extension (as Chrome resolves them). */
function resolveIcon(ext: LoadedExtension, iconUrl: string): NativeImage | undefined {
  try {
    if (iconUrl.startsWith('data:')) {
      const image = nativeImage.createFromDataURL(iconUrl)
      return image.isEmpty() ? undefined : image
    }
    const own = `chrome-extension://${ext.id}/`
    const relative = iconUrl.startsWith(own) ? iconUrl.slice(own.length) : iconUrl
    if (/^[a-z][a-z0-9+.-]*:/i.test(relative)) return undefined
    const image = nativeImage.createFromPath(join(ext.path, relative.replace(/^\/+/, '')))
    return image.isEmpty() ? undefined : image
  } catch {
    return undefined
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof NotificationError || error instanceof ApiError)
    return new ApiError(error.message)
  return new ApiError(error instanceof Error ? error.message : String(error))
}
