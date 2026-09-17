/**
 * `chrome.notifications`, the host-neutral part: Chrome's `NotificationOptions` validation for
 * `create` and `update` (`notifications_api.cc`), and the mapping of a validated option set onto
 * the flat title / body / icon / buttons shape every native notification API offers. Hosts show it
 * (Electron's `Notification` on desktop) and turn the native events back into `onClicked`,
 * `onButtonClicked` and `onClosed`.
 */

export type NotificationTemplateType = 'basic' | 'image' | 'list' | 'progress'

export interface NotificationButton {
  title: string
  iconUrl?: string
}

export interface NotificationItem {
  title: string
  message: string
}

/** A validated `NotificationOptions`; every field optional so it doubles as an update patch. */
export interface NotificationOptions {
  type?: NotificationTemplateType
  iconUrl?: string
  appIconMaskUrl?: string
  title?: string
  message?: string
  contextMessage?: string
  priority?: number
  eventTime?: number
  buttons?: NotificationButton[]
  imageUrl?: string
  items?: NotificationItem[]
  progress?: number
  isClickable?: boolean
  requireInteraction?: boolean
  silent?: boolean
}

export class NotificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotificationError'
  }
}

// Chrome's messages (chrome/browser/extensions/api/notifications/notifications_api.cc).
export const ERROR_MISSING_REQUIRED =
  'Some of the required properties are missing: type, iconUrl, title and message.'
export const ERROR_UNEXPECTED_PROGRESS =
  'The progress value should not be specified for non-progress type notification.'
export const ERROR_INVALID_PROGRESS = 'The progress value should range from 0 to 100.'
export const ERROR_EXTRA_LIST_ITEMS = 'List items provided for notification type != list'
export const ERROR_EXTRA_IMAGE = 'Image resource provided for notification type != image'
export const ERROR_ID_TOO_LONG = "The notification's ID should be 500 characters or less"
export const ERROR_NOT_FOUND = 'Notification not found.'

export const NOTIFICATION_ID_LENGTH_LIMIT = 500
export const MAX_BUTTONS = 2

const TYPES: readonly NotificationTemplateType[] = ['basic', 'image', 'list', 'progress']

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new NotificationError(`Invalid value for '${key}'.`)
  return value
}

function readBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new NotificationError(`Invalid value for '${key}'.`)
  return value
}

function readNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new NotificationError(`Invalid value for '${key}'.`)
  }
  return value
}

/**
 * Validate `NotificationOptions`. With `forCreate` the four required fields must be present
 * (Chrome's rule since it dropped the `type`-less form); for `update` everything is optional but
 * the same type-specific checks apply against the merged result.
 */
export function normalizeNotificationOptions(
  raw: unknown,
  forCreate: boolean
): NotificationOptions {
  if (!isRecord(raw)) throw new NotificationError('Invalid options.')
  const out: NotificationOptions = {}
  if (raw.type !== undefined) {
    if (!TYPES.includes(raw.type as NotificationTemplateType)) {
      throw new NotificationError("Invalid value for 'type'.")
    }
    out.type = raw.type as NotificationTemplateType
  }
  for (const key of [
    'iconUrl',
    'appIconMaskUrl',
    'title',
    'message',
    'contextMessage',
    'imageUrl'
  ] as const) {
    const value = readString(raw, key)
    if (value !== undefined) out[key] = value
  }
  const priority = readNumber(raw, 'priority')
  if (priority !== undefined) {
    if (!Number.isInteger(priority) || priority < -2 || priority > 2) {
      throw new NotificationError("Invalid value for 'priority'.")
    }
    out.priority = priority
  }
  const eventTime = readNumber(raw, 'eventTime')
  if (eventTime !== undefined) out.eventTime = eventTime
  if (raw.buttons !== undefined) {
    if (!Array.isArray(raw.buttons)) throw new NotificationError("Invalid value for 'buttons'.")
    const buttons: NotificationButton[] = []
    for (const entry of raw.buttons) {
      if (!isRecord(entry) || typeof entry.title !== 'string') {
        throw new NotificationError("Invalid value for 'buttons'.")
      }
      const button: NotificationButton = { title: entry.title }
      if (typeof entry.iconUrl === 'string') button.iconUrl = entry.iconUrl
      buttons.push(button)
    }
    out.buttons = buttons.slice(0, MAX_BUTTONS)
  }
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items)) throw new NotificationError("Invalid value for 'items'.")
    const items: NotificationItem[] = []
    for (const entry of raw.items) {
      if (
        !isRecord(entry) ||
        typeof entry.title !== 'string' ||
        typeof entry.message !== 'string'
      ) {
        throw new NotificationError("Invalid value for 'items'.")
      }
      items.push({ title: entry.title, message: entry.message })
    }
    out.items = items
  }
  const progress = readNumber(raw, 'progress')
  if (progress !== undefined) out.progress = progress
  for (const key of ['isClickable', 'requireInteraction', 'silent'] as const) {
    const value = readBoolean(raw, key)
    if (value !== undefined) out[key] = value
  }
  if (forCreate) {
    if (
      out.type === undefined ||
      out.iconUrl === undefined ||
      out.title === undefined ||
      out.message === undefined
    ) {
      throw new NotificationError(ERROR_MISSING_REQUIRED)
    }
    checkTypeSpecific(out)
  }
  return out
}

/** The type-specific rules Chrome applies to the effective option set. */
export function checkTypeSpecific(options: NotificationOptions): void {
  const type = options.type ?? 'basic'
  if (options.progress !== undefined) {
    if (type !== 'progress') throw new NotificationError(ERROR_UNEXPECTED_PROGRESS)
    if (options.progress < 0 || options.progress > 100)
      throw new NotificationError(ERROR_INVALID_PROGRESS)
  }
  if (options.items !== undefined && type !== 'list')
    throw new NotificationError(ERROR_EXTRA_LIST_ITEMS)
  if (options.imageUrl !== undefined && type !== 'image')
    throw new NotificationError(ERROR_EXTRA_IMAGE)
}

/** Merge an `update` patch into the current options (Chrome updates fields in place). */
export function mergeNotificationOptions(
  current: NotificationOptions,
  patch: NotificationOptions
): NotificationOptions {
  const merged: NotificationOptions = { ...current, ...patch }
  checkTypeSpecific(merged)
  return merged
}

export function checkNotificationId(id: string): void {
  if (id.length > NOTIFICATION_ID_LENGTH_LIMIT) throw new NotificationError(ERROR_ID_TOO_LONG)
}

/** The rendering every native notification API can show. */
export interface NativeNotificationSpec {
  title: string
  body: string
  /** `contextMessage`, for platforms with a subtitle line (macOS). */
  subtitle: string
  /** The icon URL as given (resolved against the extension by the host). */
  iconUrl: string | null
  silent: boolean
  /** Chrome's `requireInteraction`: the notification stays until dismissed. */
  requireInteraction: boolean
  urgency: 'low' | 'normal' | 'critical'
  buttons: string[]
}

/**
 * Flatten Chrome's templates onto title / body / buttons: `list` items become body lines,
 * `progress` appends the percentage, `image` keeps only the icon (no native API shows a hero
 * image portably), `contextMessage` is the subtitle where one exists and a trailing body line
 * elsewhere.
 */
export function toNativeNotification(
  options: NotificationOptions,
  hasSubtitle: boolean
): NativeNotificationSpec {
  const lines: string[] = []
  if (options.message) lines.push(options.message)
  if (options.type === 'list' && options.items) {
    for (const item of options.items) {
      lines.push(item.message ? `${item.title}: ${item.message}` : item.title)
    }
  }
  if (options.type === 'progress' && options.progress !== undefined) {
    lines.push(`${Math.round(options.progress)}%`)
  }
  if (options.contextMessage && !hasSubtitle) lines.push(options.contextMessage)
  const priority = options.priority ?? 0
  return {
    title: options.title ?? '',
    body: lines.join('\n'),
    subtitle: hasSubtitle ? (options.contextMessage ?? '') : '',
    iconUrl: options.iconUrl ?? null,
    silent: options.silent ?? false,
    requireInteraction: options.requireInteraction ?? priority >= 2,
    urgency: priority >= 2 ? 'critical' : priority <= -1 ? 'low' : 'normal',
    buttons: (options.buttons ?? []).map((b) => b.title)
  }
}
