/**
 * Web notifications: what the page preload and the host agree on.
 *
 * Chromium asks the host a yes-or-no question for `Notification.permission`, so an undecided
 * site would read `denied` and never ask. The page preload therefore answers the page itself,
 * from the browser's three-state resolution of the site's permission, over these channels.
 */

/** Web `Notification.permission`. */
export type NotificationPermissionStatus = 'granted' | 'denied' | 'default'

export function isNotificationPermissionStatus(
  value: unknown
): value is NotificationPermissionStatus {
  return value === 'granted' || value === 'denied' || value === 'default'
}

/**
 * Renderer → main (synchronous, answered with the status of the sender's document) and
 * main → renderer (the status changed while the document is open).
 */
export const NOTIFICATION_PERMISSION_CHANNEL = 'zen:notification-permission'

/**
 * DOM events joining the page's main world (where the shim redefines `Notification`) with the
 * preload's isolated world (which has the browser's ear). Both worlds share the document, and a
 * `CustomEvent.detail` string crosses worlds as a copy.
 */
export interface NotificationShimEvents {
  /** Main world asks; the isolated world answers with `update` before the dispatch returns. */
  query: string
  /** Isolated world → main world: `detail` is the status. */
  update: string
  /** Main world → isolated world: the page called `window.focus()` while it had a gesture. */
  focus: string
}

export const NOTIFICATION_SHIM_EVENTS: NotificationShimEvents = {
  query: 'zenium:notification-permission-query',
  update: 'zenium:notification-permission',
  focus: 'zenium:focus'
}
