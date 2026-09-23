import {
  MAX_NOTIFICATION_TEXT,
  notificationStatusOf,
  type NotificationHostMessage,
  type NotificationPageRequest,
  type NotificationPermissionStatus
} from '../shared/notifications'
import type { PermissionPrompt } from '../shared/types'
import { newId } from '../shared/ids'
import { displayOrigin, permissionSite } from './permissions'
import type { WebNotificationRequest } from './platform'
import type { Browser } from './browser'

/** A notification a page showed, as long as it may still be tapped or swiped. */
interface LiveNotification {
  tabId: string
  /** The page's own id, what its polyfill knows the notification as. */
  pageId: string
  origin: string
  /** The page the notification came from, opened again when its tab is gone at the tap. */
  url: string
}

/** How many a site may keep up at once; the oldest goes when one more arrives (Chrome caps too). */
export const MAX_LIVE_PER_ORIGIN = 20

/**
 * Whether a site's request asks quietly (Chrome's quiet notification permission UI, NOT-03):
 * one made without a user gesture, or one from a site whose prompt the user dismissed before in
 * this session. A quiet request is not a sheet over the page; it is the bell-off glyph in the
 * pill's slot, and the sheet opens from the bell. `gesture` undefined (an engine that cannot
 * say, an older page script) counts as gestured: nothing is quieted on a guess.
 */
export function asksQuietly(gesture: boolean | undefined, dismissedBefore: boolean): boolean {
  return gesture === false || dismissedBefore
}

/**
 * The quiet prompt's words: Chrome's ("Notifications blocked" over "You usually block
 * notifications. To let example.com notify you, tap Allow."), Allow and Keep blocking; no
 * Allow once – a notification permission is a site's standing right or nothing.
 */
export function quietNotificationPrompt(
  tabId: string,
  origin: string,
  requestedAt: number
): PermissionPrompt {
  const site = displayOrigin(origin)
  return {
    id: newId('perm'),
    tabId,
    origin,
    permission: 'notifications',
    message: 'Notifications blocked',
    detail: `You usually block notifications. To let ${site} notify you, tap Allow.`,
    allowLabel: 'Allow',
    blockLabel: 'Keep blocking',
    allowOnce: false,
    requestedAt,
    quiet: true
  }
}

/**
 * Web Notifications on a host whose engine hides `Notification` from pages (the Android
 * WebView): the page script's polyfill posts what a page asks, the core answers from the
 * shared permission model – the `notifications` content setting, prompted through the same
 * `PermissionService` / `PermissionPromptHost` as every other permission, so Settings › Site
 * settings › Notifications lists the sites – and hands the allowed ones to the host, which
 * posts them under the site's own notification channel. A tap brings the tab to the front (or
 * opens the page again when the tab is gone) and reaches the page as `click`; a swipe as
 * `close`. Private tabs get no notifications: Chrome's incognito refuses the permission, and
 * so does this – `Notification.permission` reads `denied` there and a request settles at once.
 */
export class WebNotificationService {
  private readonly live = new Map<string, LiveNotification>()
  /**
   * The sites whose notification prompt the user dismissed this session – "not now" – which
   * ask quietly from then on (Chrome's rule); a site answered Allow or Block leaves the set,
   * its question closed either way. Session memory, as the core's own dismissal count is.
   */
  private readonly dismissedSites = new Set<string>()
  /** The quiet prompt up for a tab, by tab: a second quiet request while one is up joins it. */
  private readonly quietPending = new Map<string, Promise<boolean>>()

  constructor(private readonly browser: Browser) {
    // A site's permission withdrawn (Settings, the site sheet, a reset): its notifications and
    // its channel go, and the pages of the site learn their new status.
    browser.permissions.subscribe((change) => {
      if (change.permission !== 'notifications') return
      if (change.origin !== null) {
        const decision = browser.permissions.resolve('notifications', change.origin)
        if (decision !== 'allow') this.forgetOrigin(change.origin)
      }
      this.pushStatuses(change.origin)
    })
    // The prompts' answers, for the quiet rule: a dismissed notification prompt marks its site;
    // Allow or Block clears the mark. A withdrawn prompt (null) says nothing of the user.
    browser.permissionPrompts.onAnswered((prompt, answer) => {
      if (prompt.permission !== 'notifications' || prompt.quiet) return
      if (answer === 'dismiss') this.dismissedSites.add(prompt.origin)
      else if (answer === 'allow' || answer === 'block') this.dismissedSites.delete(prompt.origin)
    })
  }

  /** Whether the site of `url` asks quietly now: its prompt was dismissed before this session. */
  dismissedBefore(url: string): boolean {
    const origin = permissionSite(url)
    return origin !== null && this.dismissedSites.has(origin)
  }

  /** What `Notification.permission` reads in the page of `tabId` at `url`. */
  status(tabId: string, url: string): NotificationPermissionStatus {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !url) return 'denied'
    if (this.browser.tabs.isPrivate(tab)) return 'denied'
    if (!permissionSite(url)) return 'denied'
    return notificationStatusOf(this.browser.permissions.resolve('notifications', url, { tabId }))
  }

  /** The page's polyfill asked (`notification` page message). */
  handle(tabId: string, request: NotificationPageRequest): void {
    if (!request || typeof request !== 'object' || typeof request.notification !== 'string') return
    const view = this.browser.tabs.view(tabId)
    if (!view || view.isDestroyed()) return
    const url = view.getURL()
    switch (request.notification) {
      case 'query':
        this.post(tabId, {
          type: 'notification',
          action: 'status',
          status: this.status(tabId, url)
        })
        return
      case 'request':
        void this.request(
          tabId,
          url,
          typeof request.id === 'string' ? request.id : null,
          typeof request.gesture === 'boolean' ? request.gesture : undefined
        )
        return
      case 'show':
        void this.show(tabId, url, request)
        return
      case 'close': {
        if (typeof request.id !== 'string') return
        const id = this.idFor(tabId, request.id)
        if (!this.live.delete(id)) return
        this.browser.platform.webNotifications?.close(id)
        return
      }
    }
  }

  private async request(
    tabId: string,
    url: string,
    requestId: string | null,
    gesture: boolean | undefined
  ): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    const origin = permissionSite(url)
    let status: NotificationPermissionStatus
    if (!tab || this.browser.tabs.isPrivate(tab) || !origin) {
      status = 'denied'
    } else {
      const standing = this.browser.permissions.resolve('notifications', url, { tabId })
      // A question still open asks quietly (NOT-03) when the request has no gesture behind it
      // or the site was dismissed before: the bell in the pill's slot, not a sheet. A site with
      // an answer, or a loud request, goes through the permission service as every request does.
      const allowed =
        standing === 'ask' && asksQuietly(gesture, this.dismissedSites.has(origin))
          ? await this.requestQuietly(tabId, url, origin)
          : await this.browser.permissions.decide('notifications', url, { tabId })
      // The site was allowed: the app's own posting right (Android 13+) is asked for now, so the
      // page's first notification is not the one to trip over the system prompt.
      if (allowed) await this.browser.platform.webNotifications?.ensureAllowed()
      status = this.status(tabId, url)
    }
    const message: NotificationHostMessage = { type: 'notification', action: 'result', status }
    if (requestId) message.id = requestId
    this.post(tabId, message)
  }

  /**
   * The quiet ask: a `quiet` prompt in the chrome's queue – the pill shows it as the bell-off
   * glyph and opens its sheet from there – answered Allow (remembered for the site) or Keep
   * blocking (remembered as a block), or withdrawn when the page navigates away; a sheet closed
   * without a word leaves the bell up, so nothing here counts as a dismissal. One per tab at a
   * time: requests while it is up share its answer.
   */
  private requestQuietly(tabId: string, url: string, origin: string): Promise<boolean> {
    const pending = this.quietPending.get(tabId)
    if (pending) return pending
    const prompt = quietNotificationPrompt(tabId, origin, Date.now())
    const asked = this.browser.permissionPrompts
      .show(prompt)
      .then((answer) => {
        if (answer === 'allow') {
          this.dismissedSites.delete(origin)
          this.browser.permissions.remember('notifications', url, 'allow', { tabId })
          return true
        }
        if (answer === 'block') {
          this.dismissedSites.delete(origin)
          this.browser.permissions.remember('notifications', url, 'deny', { tabId })
        }
        return false
      })
      .finally(() => {
        this.quietPending.delete(tabId)
      })
    this.quietPending.set(tabId, asked)
    return asked
  }

  private async show(tabId: string, url: string, request: NotificationPageRequest): Promise<void> {
    if (typeof request.id !== 'string' || request.id === '') return
    const host = this.browser.platform.webNotifications
    const origin = permissionSite(url)
    const id = this.idFor(tabId, request.id)
    const error = (): void =>
      this.post(tabId, { type: 'notification', action: 'error', id: request.id })
    if (!host || !origin || this.status(tabId, url) !== 'granted') {
      error()
      return
    }
    // Each display counts as a use of the permission (what the site-settings row reports).
    void this.browser.permissions.decide('notifications', url, { tabId })
    this.live.set(id, { tabId, pageId: request.id, origin, url })
    this.capPerOrigin(origin, host)
    const text = (value: unknown): string =>
      (typeof value === 'string' ? value : '').slice(0, MAX_NOTIFICATION_TEXT)
    const shown = await host.show({
      id,
      origin,
      tabId,
      url,
      title: text(request.title),
      body: text(request.body),
      icon: typeof request.icon === 'string' && /^https?:/i.test(request.icon) ? request.icon : '',
      tag: text(request.tag),
      silent: request.silent === true,
      requireInteraction: request.requireInteraction === true,
      renotify: request.renotify === true,
      timestamp:
        typeof request.timestamp === 'number' && Number.isFinite(request.timestamp)
          ? request.timestamp
          : Date.now()
    })
    if (!this.live.has(id)) return
    if (!shown) {
      this.live.delete(id)
      error()
      return
    }
    this.post(tabId, { type: 'notification', action: 'shown', id: request.id })
  }

  /**
   * The host's word on a notification: the shade's tap (`click`) or swipe (`close`), or the
   * quiet `replaced` of one a later notification with the same tag took over. A tap on a
   * notification this core never showed – it outlived the process – opens its page (`url`).
   */
  onHostEvent(id: string, event: 'click' | 'close' | 'replaced', url?: string): void {
    const entry = this.live.get(id)
    if (!entry) {
      if (event === 'click' && url && /^https?:/i.test(url))
        this.browser.tabs.createTab({ url, active: true }, this.browser.focusedWindow())
      return
    }
    this.live.delete(id)
    if (event === 'replaced') return
    if (event === 'click') this.reveal(entry)
    const view = this.browser.tabs.view(entry.tabId)
    if (view && !view.isDestroyed())
      view.postToPage?.({ type: 'notification', action: event, id: entry.pageId })
  }

  /** A tap: the notification's tab comes to the front; a tab that is gone gets its page opened again. */
  private reveal(entry: LiveNotification): void {
    const tab = this.browser.tabs.tab(entry.tabId)
    if (tab && this.browser.tabs.view(entry.tabId)) {
      this.browser.revealTab(entry.tabId)
      return
    }
    this.browser.tabs.createTab({ url: entry.url, active: true }, this.browser.focusedWindow())
  }

  /** Withdraw everything of a site: its notifications on the shade and its channel. */
  forgetOrigin(origin: string): void {
    const site = permissionSite(origin) ?? origin
    for (const [id, entry] of [...this.live]) if (entry.origin === site) this.live.delete(id)
    this.browser.platform.webNotifications?.forgetOrigin(site)
  }

  /** Tell every open page of `origin` (or of every site) what its `Notification.permission` reads now. */
  private pushStatuses(origin: string | null): void {
    for (const [tabId, view] of this.browser.tabs.allViews()) {
      if (view.isDestroyed()) continue
      const url = view.getURL()
      const site = permissionSite(url)
      if (!site) continue
      if (origin !== null && site !== permissionSite(origin)) continue
      this.post(tabId, { type: 'notification', action: 'status', status: this.status(tabId, url) })
    }
  }

  private capPerOrigin(origin: string, host: { close(id: string): void }): void {
    const ids = [...this.live].filter(([, e]) => e.origin === origin).map(([id]) => id)
    while (ids.length > MAX_LIVE_PER_ORIGIN) {
      const oldest = ids.shift()!
      this.live.delete(oldest)
      host.close(oldest)
    }
  }

  private post(tabId: string, message: NotificationHostMessage): void {
    const view = this.browser.tabs.view(tabId)
    if (!view || view.isDestroyed()) return
    view.postToPage?.(message)
  }

  /** Browser-wide id of a page's notification: the tab's and the page's own, kept apart from any other tab's. */
  private idFor(tabId: string, pageId: string): string {
    return `${tabId}/${pageId}`
  }

  /** How many notifications are up right now (tests). */
  get liveCount(): number {
    return this.live.size
  }
}

export type { WebNotificationRequest }
